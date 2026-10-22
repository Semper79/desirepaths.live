/**
 * The crawl job: sources in, documents out.
 *
 * Per source — fetch, parse (a feed or an article), deduplicate against what is already
 * stored, and record the outcome so the next run sends the right validators.
 *
 * ⚠ ONE CRAWL WORKER PER DEPLOYMENT.
 * `PolitenessScheduler` holds its per-host leases in process memory. One process running
 * this job at any concurrency is correct — the leases are shared. *Two* processes are
 * not: each believes it holds the only lease for a host, and "one concurrent request per
 * host", the first line of `docs/COMPLIANCE.md` §2, quietly stops being true. Scaling the
 * crawler horizontally means moving the lease to Redis first, and until that exists the
 * queue's concurrency is pinned to 1 and this comment is the reason.
 *
 * WHAT THIS JOB DOES NOT DO
 * It does not decide what is interesting. Every document that parses is stored; scoring
 * happens two stages later, on clusters rather than documents, because a single article
 * is not evidence of anything. Keeping the judgement out of the fetch stage is what makes
 * the fetch stage safe to retry.
 */

import {
  extract,
  parseFeed,
  simhash,
  toStorage,
  usableItems,
  type FeedItem,
  type PoliteFetcher,
} from '@morph/crawler';
import type {
  Clock,
  CrawlSource,
  DocumentRepository,
  Logger,
  SourceRepository,
  StoredDocument,
} from '../ports';
import type { CrawlJob } from '../queues';

export interface CrawlDeps {
  readonly fetcher: PoliteFetcher;
  readonly sources: SourceRepository;
  readonly documents: DocumentRepository;
  readonly now: Clock;
  readonly log: Logger;
}

export interface CrawlOutcome {
  readonly sourcesAttempted: number;
  readonly documentsStored: number;
  readonly duplicatesDropped: number;
  readonly unchanged: number;
  readonly disallowed: number;
  readonly deferred: number;
  readonly failed: number;
}

/** How far back the duplicate check looks. Beyond this, a re-run of a story is a new story. */
export const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A feed listing more than this in one run is either enormous or broken. */
export const MAX_ITEMS_PER_FEED = 50;

export async function runCrawl(deps: CrawlDeps, job: CrawlJob): Promise<CrawlOutcome> {
  const startedAt = deps.now();
  const due = await deps.sources.due(startedAt, job.batchSize);

  // Loaded once for the whole batch rather than per document: the set is small (a week of
  // fingerprints), and forty sources syndicating one story must be compared against the
  // same snapshot or the winner depends on which source happened to be fetched first.
  const seen = new Set(await deps.documents.recentFingerprints(startedAt - DEDUPE_WINDOW_MS));

  const tally = {
    sourcesAttempted: due.length,
    documentsStored: 0,
    duplicatesDropped: 0,
    unchanged: 0,
    disallowed: 0,
    deferred: 0,
    failed: 0,
  };

  for (const source of due) {
    const result = await crawlSource(deps, source, seen);

    tally.documentsStored += result.stored;
    tally.duplicatesDropped += result.duplicates;
    if (result.kind === 'unchanged') tally.unchanged += 1;
    if (result.kind === 'disallowed') tally.disallowed += 1;
    if (result.kind === 'deferred') tally.deferred += 1;
    if (result.kind === 'failed') tally.failed += 1;
  }

  deps.log.info('crawl.batch', { ...tally, durationMs: deps.now() - startedAt });
  return tally;
}

interface SourceResult {
  readonly kind: 'stored' | 'unchanged' | 'disallowed' | 'deferred' | 'failed';
  readonly stored: number;
  readonly duplicates: number;
}

async function crawlSource(
  deps: CrawlDeps,
  source: CrawlSource,
  seen: Set<string>,
): Promise<SourceResult> {
  const conditional = {
    ...(source.etag === null ? {} : { etag: source.etag }),
    ...(source.lastModified === null ? {} : { lastModified: source.lastModified }),
  };

  const response = await deps.fetcher.fetch(source.url, conditional);
  const at = deps.now();

  switch (response.kind) {
    case 'not-modified':
      // The conditional request paid off. Nothing to parse, and not a failure — this is
      // the steady state for most sources most of the time.
      await deps.sources.recordFetch(source.id, { at, status: 304, failed: false });
      return { kind: 'unchanged', stored: 0, duplicates: 0 };

    case 'disallowed':
    case 'host-blocked': {
      // Recorded rather than retried. A source we are not allowed to fetch is a source
      // that needs an operator, not a backoff.
      await deps.sources.recordRobots(source.id, false, at);
      await deps.sources.recordFetch(source.id, { at, status: null, failed: false });
      deps.log.warn('crawl.refused', { url: source.url, reason: response.kind });
      return { kind: 'disallowed', stored: 0, duplicates: 0 };
    }

    case 'deferred':
      // The host asked us to come back later, and the scheduler already knows when. Not
      // recorded as a failure: nothing is wrong, we simply did not ask.
      deps.log.info('crawl.deferred', { url: source.url, retryAfterMs: response.retryAfterMs });
      return { kind: 'deferred', stored: 0, duplicates: 0 };

    case 'error':
      await deps.sources.recordFetch(source.id, { at, status: response.status, failed: true });
      deps.log.warn('crawl.failed', { url: source.url, message: response.message });
      return { kind: 'failed', stored: 0, duplicates: 0 };

    case 'ok':
      break;
  }

  await deps.sources.recordRobots(source.id, true, at);
  await deps.sources.recordFetch(source.id, {
    at,
    status: response.status,
    etag: response.etag,
    lastModified: response.lastModified,
    failed: false,
  });

  const candidates =
    source.kind === 'feed' || looksLikeFeed(response.contentType)
      ? fromFeed(response.body, source, at)
      : fromArticle(response.body, source, at);

  if (candidates.length === 0) {
    deps.log.info('crawl.nothing-usable', { url: source.url, kind: source.kind });
    return { kind: 'stored', stored: 0, duplicates: 0 };
  }

  let stored = 0;
  let duplicates = 0;

  for (const candidate of candidates) {
    if (isDuplicate(candidate.simhash, seen)) {
      duplicates += 1;
      continue;
    }

    await deps.documents.upsert(candidate);
    // Added immediately, so two copies of one story arriving from different sources
    // inside the same batch do not both survive.
    seen.add(candidate.simhash);
    stored += 1;
  }

  return { kind: 'stored', stored, duplicates };
}

/**
 * Exact-match deduplication against the stored set.
 *
 * A note on what this is and is not: comparing the fingerprint for equality catches the
 * reformatted and byte-identical copies, which is the overwhelming majority. Catching
 * near-duplicates at a Hamming distance of 3 needs an index the crawler package documents
 * (banding by 16-bit chunks) and Postgres cannot do with a b-tree on `simhash`. Until the
 * corpus is large enough to need it, the clustering stage catches what slips through —
 * two copies of a story land in the same cluster and count once towards `distinctSources`.
 */
function isDuplicate(fingerprint: string, seen: ReadonlySet<string>): boolean {
  return seen.has(fingerprint);
}

function looksLikeFeed(contentType: string | null): boolean {
  if (contentType === null) return false;
  return /(rss|atom)\+xml|application\/xml|text\/xml/i.test(contentType);
}

type Candidate = Omit<StoredDocument, 'id'>;

function fromFeed(body: string, source: CrawlSource, at: number): readonly Candidate[] {
  const parsed = parseFeed(body);
  if (parsed.kind === 'error') return [];

  return usableItems(parsed.feed)
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((item) => candidateFromItem(item, source, at));
}

function candidateFromItem(item: FeedItem, source: CrawlSource, at: number): Candidate {
  // Title and summary rather than the full text: a feed rarely carries the article, and
  // fingerprinting a truncated body would make two different articles from the same feed
  // look alike. Title plus summary is what the publisher chose to distinguish them by.
  const text = `${item.title} ${item.summary}`;

  return {
    sourceId: source.id,
    url: item.link,
    title: item.title,
    excerpt: item.summary.slice(0, 600),
    simhash: toStorage(simhash(text)),
    lang: null,
    publishedAt: item.publishedAt,
    fetchedAt: at,
    embedding: null,
    clusterId: null,
  };
}

function fromArticle(body: string, source: CrawlSource, at: number): readonly Candidate[] {
  const result = extract(body, source.url);
  if (result.kind !== 'ok') return [];

  const document = result.document;

  return [
    {
      sourceId: source.id,
      // The canonical URL when the page names one: the same article reached through a
      // tracking parameter must not become a second document.
      url: document.canonicalUrl ?? source.url,
      title: document.title,
      excerpt: document.text.slice(0, 600),
      simhash: toStorage(simhash(document.text)),
      lang: document.language,
      publishedAt: document.publishedAt,
      fetchedAt: at,
      embedding: null,
      clusterId: null,
    },
  ];
}
