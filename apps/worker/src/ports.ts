/**
 * The seam.
 *
 * Every job in this app is written against these interfaces and nothing else — no
 * database client, no queue, no HTTP client, no clock. That is what makes "a source is
 * due, its robots.txt disallows the path, so it is recorded as skipped rather than
 * failed" a unit test instead of a docker-compose and a fixture database.
 *
 * The real implementations live in `src/adapters/`, are wired in `src/index.ts`, and are
 * deliberately thin: each one translates a port call into a query or a request and does
 * no thinking of its own. Everything worth testing is on this side of the seam.
 *
 * WHY PORTS AND NOT A MOCKED DATABASE
 * A mocked `drizzle` reproduces the shape of the query builder, not the meaning of the
 * query, so a test passes when the SQL is wrong. These interfaces are written in the
 * vocabulary of the pipeline — "documents that still need an embedding", "clusters seen
 * since" — so a fake implements the *intent*, and the adapter is small enough to read.
 */

// -----------------------------------------------------------------------------
// Shared value shapes
// -----------------------------------------------------------------------------

export type SourceKind = 'api' | 'feed' | 'sitemap' | 'html';

export interface CrawlSource {
  readonly id: string;
  readonly kind: SourceKind;
  readonly host: string;
  readonly url: string;
  /** Sent back on the next fetch, so an unchanged source costs a 304 and no body. */
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly lastFetchedAt: number | null;
}

export interface StoredDocument {
  readonly id: string;
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
  /** 64-bit SimHash as a decimal string, matching `crawl_document.simhash`. */
  readonly simhash: string;
  readonly lang: string | null;
  readonly publishedAt: number | null;
  readonly fetchedAt: number;
  readonly embedding: readonly number[] | null;
  readonly clusterId: string | null;
}

/** A document with its embedding present. The clustering stage cannot use any other kind. */
export interface EmbeddedDocument extends StoredDocument {
  readonly embedding: readonly number[];
}

/**
 * A cluster, which in this schema is the same row as its trend signal.
 *
 * `trend_signal` has no `cluster_id` and `crawl_document.cluster_id` has no foreign key,
 * because there is only one thing here: a cluster *is* a scored topic. Keeping them as
 * one row is what makes the cluster id stable across runs (D14) — a separate cluster
 * table would need its own identity and a join to say anything about momentum.
 */
export interface StoredCluster {
  readonly id: string;
  readonly centroid: readonly number[];
  readonly memberIds: readonly string[];
  readonly label: string;
  readonly firstSeenAt: number;
}

export interface TrendSignalRecord {
  readonly id: string;
  readonly label: string;
  readonly centroid: readonly number[];
  readonly documentCount: number;
  readonly momentum: number;
  readonly audienceFit: number;
  readonly saturation: number;
  readonly durability: number;
  readonly safetyVerdict: 'allow' | 'review' | 'block';
  readonly safetyReason: string | null;
  readonly safetyCategories: readonly string[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly actedOnAt: number | null;
}

export interface ContentSource {
  readonly url: string;
  readonly title: string;
  readonly publisher: string;
}

export interface ContentDraft {
  readonly slug: string;
  readonly kind: 'article' | 'explainer';
  readonly title: string;
  readonly summary: string;
  readonly body: unknown;
  readonly trendSignalId: string;
  /**
   * Never empty. §7.3 requires attribution on every generated page, and
   * `content_published_needs_sources` makes it a database invariant — this type makes it
   * hard to reach that constraint by accident.
   */
  readonly sources: readonly [ContentSource, ...ContentSource[]];
  readonly generatedBy: string;
  readonly generationPrompt: string;
}

// -----------------------------------------------------------------------------
// Repositories
// -----------------------------------------------------------------------------

export interface SourceRepository {
  /** Enabled sources whose turn has come, oldest first. */
  due(now: number, limit: number): Promise<readonly CrawlSource[]>;
  /** Record the outcome, including the validators to send next time. */
  recordFetch(
    sourceId: string,
    outcome: {
      readonly at: number;
      readonly status: number | null;
      readonly etag?: string | null;
      readonly lastModified?: string | null;
      readonly failed: boolean;
    },
  ): Promise<void>;
  /** The robots decision, for the audit trail `crawl_source.robots_allows` carries. */
  recordRobots(sourceId: string, allowed: boolean, at: number): Promise<void>;
}

export interface DocumentRepository {
  /**
   * Fingerprints of documents already stored within the window, so a story syndicated
   * yesterday is not re-ingested today. Returned as decimal strings to match storage.
   */
  recentFingerprints(since: number): Promise<readonly string[]>;
  /** Insert, or return the existing row when the URL is already known. */
  upsert(document: Omit<StoredDocument, 'id'>): Promise<StoredDocument>;
  withoutEmbedding(limit: number): Promise<readonly StoredDocument[]>;
  setEmbedding(documentId: string, embedding: readonly number[]): Promise<void>;
  /** Embedded documents not yet assigned to a cluster. */
  unclustered(since: number, limit: number): Promise<readonly EmbeddedDocument[]>;
  setCluster(documentId: string, clusterId: string): Promise<void>;
  /** A cluster's documents, most recent first — the sources a generated piece cites. */
  forCluster(clusterId: string, limit: number): Promise<readonly StoredDocument[]>;
  /** How many documents mentioned this cluster in each of the last `hours` hours. */
  hourlyCounts(clusterId: string, now: number, hours: number): Promise<readonly number[]>;
  distinctSources(clusterId: string): Promise<number>;
  deleteOlderThan(cutoff: number): Promise<number>;
}

/**
 * One repository, because clusters and trend signals are one table.
 *
 * `activeClusters` returns member ids and not just a count, because the running-mean
 * centroid update needs to know how many members a cluster already has, and the caller
 * needs the ids to write the membership back. At the retention window's scale — clusters
 * touched in the last few days, over a 30-day corpus — that is a bounded indexed read. If
 * the corpus ever outgrows it, the fix is a stored member count plus a members table, and
 * this signature is where it would change.
 */
export interface TrendRepository {
  activeClusters(since: number): Promise<readonly StoredCluster[]>;
  nextClusterId(): string;
  /** Create or update the row for this cluster, scores and all. */
  save(record: TrendSignalRecord): Promise<void>;
  byId(id: string): Promise<TrendSignalRecord | null>;
  /** Publishable, unacted-on signals, best first. */
  awaitingContent(limit: number): Promise<readonly TrendSignalRecord[]>;
  markActedOn(signalId: string, at: number): Promise<void>;
}

export interface PublishedContent {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** The topic this piece came from, when it came from one. Hand-written pieces have none. */
  readonly trendSignalId: string | null;
}

/** A draft waiting for a human, as the approval queue shows it. */
export interface PendingDraft {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly wordCount: number;
  readonly sources: readonly ContentSource[];
  readonly generatedBy: string | null;
  readonly createdAt: number;
}

export interface ContentRepository {
  slugExists(slug: string): Promise<boolean>;
  createDraft(draft: ContentDraft, at: number): Promise<{ readonly id: string }>;
  /** Everything currently readable on the site, for the audience computation. */
  published(): Promise<readonly PublishedContent[]>;
  /** Drafts awaiting review, oldest first — the operator's backlog in order. */
  pendingReview(limit: number): Promise<readonly PendingDraft[]>;
  byId(contentId: string): Promise<PendingDraft | null>;
  /**
   * Publish a reviewed draft.
   *
   * `reviewer` is not decoration: `content_generated_needs_review` refuses to let a
   * generated row reach `published` without a `reviewed_at`, so approving without naming
   * a human is a constraint violation rather than a silent shortcut.
   *
   * Returns `false` when the row was not in a reviewable state — already published,
   * already rejected, or gone. A second tap on an inline keyboard is the normal way that
   * happens, and it is not an error.
   */
  approve(contentId: string, reviewer: string, at: number): Promise<boolean>;
  reject(contentId: string, reviewer: string, at: number): Promise<boolean>;
}

/**
 * Per-page engagement, read from ClickHouse.
 *
 * The field names are `RewardComponents` from `@morph/adaptive`, and that is the point:
 * the audience job runs the *same* `compositeReward` with the *same* live weights over
 * these rows, so "a page readers engage with" means exactly what "a variant that
 * performs" means. Two definitions of good in one system is how an optimiser ends up
 * pulling against its own content pipeline.
 */
export interface PageEngagement {
  readonly path: string;
  /** Page-sessions. The denominator for everything else. */
  readonly impressions: number;
  readonly signups: number;
  readonly engagedSessions: number;
  readonly scrollNormSum: number;
  readonly returns: number;
  readonly shares: number;
  readonly bounces: number;
}

export interface EngagementRepository {
  byPage(windowDays: number): Promise<readonly PageEngagement[]>;
}

// -----------------------------------------------------------------------------
// The hourly report
// -----------------------------------------------------------------------------

export interface LabelledCount {
  readonly label: string;
  readonly value: number;
}

/**
 * One hour of behaviour, as ClickHouse holds it.
 *
 * Read twice per report — for the hour being reported and for the same hour last week —
 * so the comparison the report makes is the comparison the query supports. Anything
 * derived from these numbers is derived in `lib/report-derive.ts`, not here.
 */
export interface TrafficFacts {
  readonly sessions: number;
  readonly uniques: number;
  readonly pageviews: number;
  readonly newVisitors: number;
  readonly returningVisitors: number;
  readonly sources: readonly LabelledCount[];
  readonly countries: readonly LabelledCount[];
  readonly pages: readonly LabelledCount[];
}

/** Sessions reaching each funnel step, keyed by step name. */
export type FunnelFacts = Readonly<Record<string, number>>;

export interface ProviderFacts {
  readonly provider: string;
  readonly signups: number;
  readonly starts: number;
}

export interface RewardFacts {
  readonly adaptiveReward: number;
  readonly adaptiveImpressions: number;
  readonly holdoutReward: number;
  readonly holdoutImpressions: number;
}

/** The trailing hour-of-week baseline the anomaly alert compares against. */
export interface AnomalyFacts {
  readonly meanSessions: number;
  readonly sdSessions: number;
  readonly weeksObserved: number;
}

export interface MetricsRepository {
  traffic(hourStart: number): Promise<TrafficFacts>;
  funnel(hourStart: number): Promise<FunnelFacts>;
  providers(hourStart: number): Promise<readonly ProviderFacts[]>;
  reward(hourStart: number): Promise<RewardFacts>;
  /** Every hour since the holdout began, for the cumulative lift. */
  rewardSince(from: number): Promise<RewardFacts>;
  anomalyProfile(hourStart: number): Promise<AnomalyFacts>;
  /** Whether the store answers at all. The report's own health line depends on it. */
  ping(): Promise<boolean>;
}

export interface AdaptationFacts {
  readonly action: string;
  readonly surfaceId: string | null;
  readonly variantId: string | null;
  readonly reason: string;
  readonly impressions: number | null;
}

export interface ChampionFacts {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly variantLabel: string;
  readonly alpha: number;
  readonly beta: number;
  readonly impressions: number;
  readonly activeVariants: number;
}

/** What the report reads out of Postgres that no other job needs. */
export interface ReportRepository {
  adaptations(hourStart: number, hourEnd: number): Promise<readonly AdaptationFacts[]>;
  champions(): Promise<readonly ChampionFacts[]>;
  rewardVersion(): Promise<number>;
  /** Clusters first seen in the hour, best first. */
  newClusters(
    hourStart: number,
    hourEnd: number,
    limit: number,
  ): Promise<readonly TrendSignalRecord[]>;
  /** Topics the classifier refused in the hour. */
  rejectedTopics(
    hourStart: number,
    hourEnd: number,
    limit: number,
  ): Promise<readonly TrendSignalRecord[]>;
  publishedInHour(
    hourStart: number,
    hourEnd: number,
  ): Promise<readonly { readonly title: string; readonly slug: string }[]>;
  documentsFetched(
    hourStart: number,
    hourEnd: number,
  ): Promise<{ readonly documents: number; readonly hosts: number }>;
  /** Sources whose robots policy has aged out, so the crawler is refusing them. */
  staleRobotsCount(before: number): Promise<number>;
  draftsAwaitingReview(): Promise<number>;
  draftsOlderThan(cutoff: number): Promise<number>;
  documentsAwaitingEmbedding(): Promise<number>;
  clustersAwaitingContent(): Promise<number>;
  ping(): Promise<boolean>;
}

export interface ReportRun {
  readonly hourStart: number;
  readonly kind: 'full' | 'brief';
  readonly messageIds: readonly number[];
  readonly charCount: number;
  readonly inputs: unknown;
  readonly sentAt: number | null;
  readonly error: string | null;
}

export interface ReportRunRepository {
  /** Has this hour already been reported? `report_run_hour_unique` makes it answerable. */
  wasSent(hourStart: number): Promise<boolean>;
  record(run: ReportRun): Promise<void>;
}

export interface AudienceSnapshot {
  readonly computedAt: number;
  readonly vector: readonly number[];
  readonly sampleSize: number;
  readonly medianReward: number;
  readonly windowDays: number;
  readonly contributors: readonly { readonly path: string; readonly reward: number }[];
}

export interface AudienceRepository {
  /** The most recent vector, or `null` before the first computation. */
  current(): Promise<AudienceSnapshot | null>;
  save(snapshot: AudienceSnapshot): Promise<void>;
}

// -----------------------------------------------------------------------------
// Outside services
// -----------------------------------------------------------------------------

/**
 * Turns text into a 768-dimension vector.
 *
 * 768 because that is what `crawl_document.embedding` and `trend_signal.centroid` are
 * declared as, and a mismatch is a runtime error deep inside pgvector rather than at the
 * boundary — so `embedDocuments` checks the width before writing.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface GenerationBrief {
  readonly label: string;
  readonly summary: string;
  readonly sources: readonly ContentSource[];
  /** Why this topic was chosen, verbatim from the scorer. Goes into the prompt. */
  readonly rationale: string;
}

export interface GeneratedContent {
  readonly title: string;
  readonly summary: string;
  readonly body: unknown;
  /** The subset of the offered sources the model actually used. */
  readonly citedUrls: readonly string[];
  readonly model: string;
  readonly prompt: string;
}

export interface ContentGenerator {
  draft(brief: GenerationBrief): Promise<GeneratedContent>;
}

/** Structured, because the hourly report reads these rather than a log file. */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type Clock = () => number;
