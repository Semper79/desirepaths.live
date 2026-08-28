/**
 * In-memory implementations of the ports.
 *
 * These implement the *intent* of each port rather than the shape of a query builder,
 * which is the whole argument for the seam: a mocked drizzle would let a test pass while
 * the SQL was wrong, whereas a fake that genuinely stores documents and genuinely returns
 * the ones without an embedding cannot.
 *
 * They are deliberately strict — `setCluster` on an unknown id throws rather than being
 * ignored — because a fake that silently tolerates nonsense hides exactly the bugs the
 * real database would reject at 3am.
 */

import type {
  AudienceRepository,
  AudienceSnapshot,
  ContentDraft,
  ContentGenerator,
  ContentRepository,
  CrawlSource,
  DocumentRepository,
  EmbeddedDocument,
  GeneratedContent,
  GenerationBrief,
  Logger,
  SourceRepository,
  StoredCluster,
  EngagementRepository,
  PageEngagement,
  PublishedContent,
  StoredDocument,
  TrendRepository,
  TrendSignalRecord,
} from '../src/ports.js';

export class FakeLogger implements Logger {
  readonly entries: { level: string; event: string; fields: Record<string, unknown> }[] = [];

  info(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.entries.push({ level: 'info', event, fields: { ...fields } });
  }
  warn(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.entries.push({ level: 'warn', event, fields: { ...fields } });
  }
  error(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.entries.push({ level: 'error', event, fields: { ...fields } });
  }

  events(level?: string): string[] {
    return this.entries.filter((e) => level === undefined || e.level === level).map((e) => e.event);
  }

  find(event: string): Record<string, unknown> | undefined {
    return this.entries.find((e) => e.event === event)?.fields;
  }
}

export class FakeSources implements SourceRepository {
  readonly fetches: {
    sourceId: string;
    status: number | null;
    failed: boolean;
    etag?: string | null;
    lastModified?: string | null;
  }[] = [];
  readonly robots: { sourceId: string; allowed: boolean }[] = [];

  constructor(private sources: CrawlSource[] = []) {}

  add(source: Partial<CrawlSource> & Pick<CrawlSource, 'id' | 'url'>): CrawlSource {
    const full: CrawlSource = {
      kind: 'feed',
      host: hostOf(source.url),
      etag: null,
      lastModified: null,
      lastFetchedAt: null,
      ...source,
    };
    this.sources.push(full);
    return full;
  }

  due(_now: number, limit: number): Promise<readonly CrawlSource[]> {
    return Promise.resolve(this.sources.slice(0, limit));
  }

  recordFetch(
    sourceId: string,
    outcome: {
      at: number;
      status: number | null;
      etag?: string | null;
      lastModified?: string | null;
      failed: boolean;
    },
  ): Promise<void> {
    this.fetches.push({ sourceId, ...outcome });
    return Promise.resolve();
  }

  recordRobots(sourceId: string, allowed: boolean): Promise<void> {
    this.robots.push({ sourceId, allowed });
    return Promise.resolve();
  }
}

export class FakeDocuments implements DocumentRepository {
  readonly stored: StoredDocument[] = [];
  private sequence = 0;
  /** Per-cluster hourly counts a test can set, so momentum is controlled rather than guessed. */
  readonly counts = new Map<string, readonly number[]>();
  readonly sourceCounts = new Map<string, number>();

  seed(document: Partial<StoredDocument> & Pick<StoredDocument, 'title'>): StoredDocument {
    this.sequence += 1;
    const full: StoredDocument = {
      id: `doc-${String(this.sequence)}`,
      sourceId: 'source-1',
      url: `https://example.com/${String(this.sequence)}`,
      excerpt: '',
      simhash: String(this.sequence),
      lang: 'en',
      publishedAt: null,
      fetchedAt: 0,
      embedding: null,
      clusterId: null,
      ...document,
    };
    this.stored.push(full);
    return full;
  }

  recentFingerprints(since: number): Promise<readonly string[]> {
    return Promise.resolve(this.stored.filter((d) => d.fetchedAt >= since).map((d) => d.simhash));
  }

  upsert(document: Omit<StoredDocument, 'id'>): Promise<StoredDocument> {
    const existing = this.stored.find((d) => d.url === document.url);
    if (existing !== undefined) return Promise.resolve(existing);

    this.sequence += 1;
    const created: StoredDocument = { id: `doc-${String(this.sequence)}`, ...document };
    this.stored.push(created);
    return Promise.resolve(created);
  }

  withoutEmbedding(limit: number): Promise<readonly StoredDocument[]> {
    return Promise.resolve(this.stored.filter((d) => d.embedding === null).slice(0, limit));
  }

  setEmbedding(documentId: string, embedding: readonly number[]): Promise<void> {
    this.replace(documentId, (d) => ({ ...d, embedding }));
    return Promise.resolve();
  }

  unclustered(since: number, limit: number): Promise<readonly EmbeddedDocument[]> {
    const ready = this.stored.filter(
      (d): d is EmbeddedDocument =>
        d.embedding !== null && d.clusterId === null && d.fetchedAt >= since,
    );
    return Promise.resolve(ready.slice(0, limit));
  }

  setCluster(documentId: string, clusterId: string): Promise<void> {
    this.replace(documentId, (d) => ({ ...d, clusterId }));
    return Promise.resolve();
  }

  forCluster(clusterId: string, limit: number): Promise<readonly StoredDocument[]> {
    return Promise.resolve(this.stored.filter((d) => d.clusterId === clusterId).slice(0, limit));
  }

  hourlyCounts(clusterId: string): Promise<readonly number[]> {
    const configured = this.counts.get(clusterId);
    if (configured !== undefined) return Promise.resolve(configured);
    return Promise.resolve([this.stored.filter((d) => d.clusterId === clusterId).length]);
  }

  distinctSources(clusterId: string): Promise<number> {
    const configured = this.sourceCounts.get(clusterId);
    if (configured !== undefined) return Promise.resolve(configured);
    return Promise.resolve(
      new Set(this.stored.filter((d) => d.clusterId === clusterId).map((d) => d.sourceId)).size,
    );
  }

  deleteOlderThan(cutoff: number): Promise<number> {
    const before = this.stored.length;
    const survivors = this.stored.filter((d) => d.fetchedAt >= cutoff);
    this.stored.length = 0;
    this.stored.push(...survivors);
    return Promise.resolve(before - this.stored.length);
  }

  private replace(documentId: string, update: (d: StoredDocument) => StoredDocument): void {
    const index = this.stored.findIndex((d) => d.id === documentId);
    if (index < 0) throw new Error(`No such document: ${documentId}`);
    this.stored[index] = update(this.stored[index] as StoredDocument);
  }
}

export class FakeTrends implements TrendRepository {
  readonly signals = new Map<string, TrendSignalRecord>();
  readonly clusters = new Map<string, StoredCluster>();
  private sequence = 0;

  seedCluster(cluster: StoredCluster, signal?: Partial<TrendSignalRecord>): void {
    this.clusters.set(cluster.id, cluster);
    this.signals.set(cluster.id, {
      id: cluster.id,
      label: cluster.label,
      centroid: cluster.centroid,
      documentCount: cluster.memberIds.length,
      momentum: 0.5,
      audienceFit: 0.5,
      saturation: 0.5,
      durability: 0.5,
      safetyVerdict: 'allow',
      safetyReason: null,
      safetyCategories: [],
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.firstSeenAt,
      actedOnAt: null,
      ...signal,
    });
  }

  activeClusters(): Promise<readonly StoredCluster[]> {
    return Promise.resolve([...this.clusters.values()]);
  }

  nextClusterId(): string {
    this.sequence += 1;
    return `cluster-${String(this.sequence)}`;
  }

  save(record: TrendSignalRecord): Promise<void> {
    this.signals.set(record.id, record);
    this.clusters.set(record.id, {
      id: record.id,
      centroid: record.centroid,
      memberIds: this.clusters.get(record.id)?.memberIds ?? [],
      label: record.label,
      firstSeenAt: record.firstSeenAt,
    });
    return Promise.resolve();
  }

  byId(id: string): Promise<TrendSignalRecord | null> {
    return Promise.resolve(this.signals.get(id) ?? null);
  }

  awaitingContent(limit: number): Promise<readonly TrendSignalRecord[]> {
    return Promise.resolve(
      [...this.signals.values()].filter((s) => s.actedOnAt === null).slice(0, limit),
    );
  }

  markActedOn(signalId: string, at: number): Promise<void> {
    const signal = this.signals.get(signalId);
    if (signal === undefined) throw new Error(`No such signal: ${signalId}`);
    this.signals.set(signalId, { ...signal, actedOnAt: at });
    return Promise.resolve();
  }
}

export class FakeContent implements ContentRepository {
  readonly drafts: ContentDraft[] = [];
  readonly live: PublishedContent[] = [];

  publish(item: Partial<PublishedContent> & Pick<PublishedContent, 'slug'>): PublishedContent {
    const full: PublishedContent = {
      id: `content-${item.slug}`,
      title: `Title for ${item.slug}`,
      summary: `Summary for ${item.slug}`,
      trendSignalId: null,
      ...item,
    };
    this.live.push(full);
    return full;
  }

  published(): Promise<readonly PublishedContent[]> {
    return Promise.resolve(this.live);
  }

  slugExists(slug: string): Promise<boolean> {
    return Promise.resolve(this.drafts.some((d) => d.slug === slug));
  }

  createDraft(draft: ContentDraft): Promise<{ id: string }> {
    this.drafts.push(draft);
    return Promise.resolve({ id: `content-${String(this.drafts.length)}` });
  }
}

export class FakeGenerator implements ContentGenerator {
  readonly briefs: GenerationBrief[] = [];

  constructor(
    private readonly respond: (brief: GenerationBrief) => Partial<GeneratedContent> = () => ({}),
  ) {}

  draft(brief: GenerationBrief): Promise<GeneratedContent> {
    this.briefs.push(brief);
    const override = this.respond(brief);

    return Promise.resolve({
      title: `On ${brief.label}`,
      summary:
        'A summary long enough to clear the minimum length the generate job enforces before it will queue anything for review.',
      body: { blocks: [] },
      citedUrls: brief.sources.map((s) => s.url),
      model: 'fake-model',
      prompt: 'fake-prompt',
      ...override,
    });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

export class FakeEngagement implements EngagementRepository {
  readonly windows: number[] = [];

  constructor(private readonly pages: PageEngagement[] = []) {}

  add(page: Partial<PageEngagement> & Pick<PageEngagement, 'path'>): PageEngagement {
    const full: PageEngagement = {
      impressions: 100,
      signups: 0,
      engagedSessions: 0,
      scrollNormSum: 0,
      returns: 0,
      shares: 0,
      bounces: 0,
      ...page,
    };
    this.pages.push(full);
    return full;
  }

  byPage(windowDays: number): Promise<readonly PageEngagement[]> {
    this.windows.push(windowDays);
    return Promise.resolve(this.pages);
  }
}

export class FakeAudience implements AudienceRepository {
  readonly saved: AudienceSnapshot[] = [];

  current(): Promise<AudienceSnapshot | null> {
    return Promise.resolve(this.saved.at(-1) ?? null);
  }

  save(snapshot: AudienceSnapshot): Promise<void> {
    this.saved.push(snapshot);
    return Promise.resolve();
  }
}
