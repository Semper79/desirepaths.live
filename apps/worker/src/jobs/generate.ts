/**
 * The generate job: a scored topic in, a draft in the review queue out.
 *
 * The only stage that produces something a reader could eventually see, which is why it
 * is the most defensive. Everything before it can be wrong and cost a bad row; this one
 * can be wrong and cost the site's credibility.
 *
 * FOUR THINGS IT REFUSES TO DO
 *
 * 1. **Publish.** Every draft is created with `status: 'draft'` and `generatedBy` set.
 *    The database will not let a generated row reach `published` without a `reviewed_at`
 *    (`content_generated_needs_review`), so this is belt and braces — but the belt is
 *    what stops a future caller passing a different status by accident.
 *
 * 2. **Write about a topic the classifier did not clear.** The stored verdict is checked
 *    again here rather than trusted from the query, and the generated text is re-checked
 *    afterwards: a topic can be safe while a specific article about it is not.
 *
 * 3. **Cite a source it was not given.** A model that returns a plausible URL nobody
 *    supplied has invented a citation, and an attribution system that passes those on is
 *    worse than one with no attributions — it launders a fabrication into a reference.
 *    Cited URLs are intersected with the offered set, and a draft left with none is
 *    discarded.
 *
 * 4. **Run away.** `maxDrafts` is small and the queue runs twice a day, because each
 *    draft costs an operator's attention and twenty unread drafts is the same as none.
 */

import { assessSafety, combine, PUBLISH_THRESHOLD } from '@morph/crawler';
import { slugify } from '../lib/label.js';
import type {
  Clock,
  ContentDraft,
  ContentGenerator,
  ContentRepository,
  ContentSource,
  DocumentRepository,
  Logger,
  StoredDocument,
  TrendRepository,
  TrendSignalRecord,
} from '../ports.js';
import type { GenerateJob } from '../queues.js';

export interface GenerateDeps {
  readonly trends: TrendRepository;
  readonly documents: DocumentRepository;
  readonly content: ContentRepository;
  readonly generator: ContentGenerator;
  readonly now: Clock;
  readonly log: Logger;
}

export interface GenerateOutcome {
  readonly considered: number;
  readonly drafted: number;
  readonly rejected: readonly { readonly signalId: string; readonly reason: string }[];
}

/** How many of a cluster's documents are offered to the generator as sources. */
export const MAX_SOURCES = 8;

/** Below this, a piece has too little to say for the review to be worth anyone's time. */
export const MIN_SUMMARY_LENGTH = 60;

export async function runGenerate(deps: GenerateDeps, job: GenerateJob): Promise<GenerateOutcome> {
  const now = deps.now();
  // Over-fetch, because most candidates are expected to fail one of the checks below and
  // a run that considers exactly `maxDrafts` topics usually produces fewer.
  const candidates = await deps.trends.awaitingContent(job.maxDrafts * 4);

  const rejected: { signalId: string; reason: string }[] = [];
  let drafted = 0;

  for (const signal of candidates) {
    if (drafted >= job.maxDrafts) break;

    const refusal = await attempt(deps, signal, now);

    if (refusal === null) {
      drafted += 1;
      continue;
    }

    rejected.push({ signalId: signal.id, reason: refusal });
    deps.log.info('generate.rejected', {
      signalId: signal.id,
      label: signal.label,
      reason: refusal,
    });
  }

  deps.log.info('generate.batch', {
    considered: candidates.length,
    drafted,
    rejected: rejected.length,
    durationMs: deps.now() - now,
  });

  return { considered: candidates.length, drafted, rejected };
}

/** Returns `null` on success, or the reason this topic did not become a draft. */
async function attempt(
  deps: GenerateDeps,
  signal: TrendSignalRecord,
  now: number,
): Promise<string | null> {
  if (signal.safetyVerdict !== 'allow') {
    return `safety verdict is ${signal.safetyVerdict}`;
  }

  if (signal.actedOnAt !== null) {
    return 'already acted on';
  }

  const total = combine({
    momentum: signal.momentum,
    audienceFit: signal.audienceFit,
    saturation: signal.saturation,
    durability: signal.durability,
  });

  if (total < PUBLISH_THRESHOLD) {
    return `score ${total.toFixed(3)} is below the publish threshold`;
  }

  const documents = await deps.documents.forCluster(signal.id, MAX_SOURCES);
  const sources = documents.map(toSource).filter((source) => source.url !== '');

  if (sources.length === 0) {
    // Not a failure of the generator: a cluster whose documents have no usable URL cannot
    // be attributed, and §7.3 makes attribution mandatory.
    return 'no attributable sources';
  }

  const generated = await deps.generator.draft({
    label: signal.label,
    summary: documents.map((d) => d.title).join('; '),
    sources,
    rationale: rationaleFrom(signal, total),
  });

  const offered = new Set(sources.map((source) => source.url));
  const cited = sources.filter((source) => generated.citedUrls.includes(source.url));
  const invented = generated.citedUrls.filter((url) => !offered.has(url));

  if (invented.length > 0) {
    // Loud, because this is the failure mode that matters most and the one least likely
    // to be noticed downstream: the draft would look perfectly well-sourced.
    deps.log.error('generate.invented-citation', {
      signalId: signal.id,
      urls: invented.slice(0, 5),
      model: generated.model,
    });
  }

  const [first, ...rest] = cited;
  if (first === undefined) {
    return 'the draft cited none of the sources it was given';
  }

  if (generated.title.trim() === '' || generated.summary.trim().length < MIN_SUMMARY_LENGTH) {
    return 'the draft has no usable title or summary';
  }

  const assessment = assessSafety({ title: generated.title, text: generated.summary });
  if (assessment.verdict !== 'allow') {
    // The topic cleared the classifier; this specific article did not. Rejected rather
    // than queued, because a piece that needs a safety discussion is not a piece whose
    // only problem is that nobody has read it yet.
    return `generated text was ${assessment.verdict}: ${assessment.summary}`;
  }

  const draft: ContentDraft = {
    slug: await uniqueSlug(deps, generated.title),
    kind: 'article',
    title: generated.title.slice(0, 200),
    summary: generated.summary,
    body: generated.body,
    trendSignalId: signal.id,
    sources: [first, ...rest],
    generatedBy: generated.model,
    generationPrompt: generated.prompt,
  };

  const { id } = await deps.content.createDraft(draft, now);
  // Marked only after the draft exists, so a crash between the two costs a retry rather
  // than a topic that is permanently marked done with nothing to show for it.
  await deps.trends.markActedOn(signal.id, now);

  deps.log.info('generate.drafted', {
    contentId: id,
    signalId: signal.id,
    slug: draft.slug,
    sources: draft.sources.length,
    model: generated.model,
  });

  return null;
}

function toSource(document: StoredDocument): ContentSource {
  return {
    url: document.url,
    title: document.title,
    publisher: publisherFrom(document.url),
  };
}

/**
 * The publisher, from the URL.
 *
 * A host is not a publisher's name, but it is verifiable and it is never wrong in the way
 * a guessed name would be. `www.` is dropped because "Www.Example.Com" reads as a bug.
 */
export function publisherFrom(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function rationaleFrom(signal: TrendSignalRecord, total: number): string {
  return [
    `Selected with a composite score of ${total.toFixed(2)}`,
    `momentum ${signal.momentum.toFixed(2)}`,
    `saturation ${signal.saturation.toFixed(2)}`,
    `durability ${signal.durability.toFixed(2)}`,
  ].join(', ');
}

/**
 * A slug that is free.
 *
 * The base is deterministic so re-running generation for the same topic collides rather
 * than quietly producing a second URL for the same article — which would split its search
 * authority. The numeric suffix exists for genuinely different pieces whose titles happen
 * to slugify identically.
 */
async function uniqueSlug(deps: GenerateDeps, title: string): Promise<string> {
  const base = slugify(title);

  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${String(suffix + 1)}`;
    if (!(await deps.content.slugExists(candidate))) return candidate;
  }

  throw new Error(`Could not find a free slug for "${title}" after 50 attempts.`);
}
