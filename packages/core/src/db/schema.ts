/**
 * PostgreSQL schema - the source of truth for everything that is not behaviour.
 * =============================================================================
 * Behaviour lives in ClickHouse (see infra/clickhouse/init/). Postgres holds the
 * things that must be transactional, foreign-keyed, or auditable: identity, content,
 * configuration, the variant pool, and the immutable record of every decision the
 * adaptive engine made.
 *
 * PARTITIONING
 * Two tables grow without bound and are read almost exclusively by recent time
 * range: `adaptation_log` and `outbound_post`. Both are RANGE partitioned BY MONTH.
 *
 *   Why monthly and not daily: these tables see thousands of rows per month, not
 *   millions per day. Daily partitions would reach 700+ children in two years and
 *   the planner pays for every child at plan time. Monthly keeps the count in the
 *   low dozens while still letting retention DETACH a whole month rather than issue
 *   a DELETE that bloats the heap and forces a VACUUM FULL nobody scheduled.
 *
 *   Drizzle has no vocabulary for declarative partitioning, so the PARTITION BY
 *   clause and the maintenance functions live in infra/postgres/init/001_bootstrap.sql
 *   and the partitions are created ahead of time by the worker's daily job. The
 *   tables below model the parent; queries and types are unaffected.
 *
 * RETENTION / TTL
 *   adaptation_log   25 months  - matches the ClickHouse aggregate window, so a
 *                                 decision can always be explained as long as the
 *                                 metrics behind it still exist.
 *   outbound_post    25 months  - same, plus it is the evidence trail for platform
 *                                 compliance questions.
 *   crawl_document   30 days    - raw fetched content is a cache, not an archive.
 *                                 The extracted signal outlives it.
 *   auth_session     rolling    - deleted on expiry by the session store.
 *   erasure_request  permanent  - proof that an erasure was honoured must outlive
 *                                 the data it erased. It stores no personal data.
 *
 * Postgres holds NO raw behavioural events, so the 90-day promise in docs/PRIVACY.md
 * is a ClickHouse concern. What Postgres does hold that is personal - a user row and
 * its linked social identities - is deleted synchronously on erasure, with the
 * ClickHouse rows following in the same job.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------
// Postgres enums over text+CHECK: they are compact on disk, sort meaningfully, and
// make an invalid value impossible rather than merely rejected. The cost is that
// adding a value needs a migration, which for these domains is the correct amount
// of friction.

export const variantStatusEnum = pgEnum('variant_status', [
  'active',
  'quarantined',
  'retired',
  'pinned',
]);

export const variantOriginEnum = pgEnum('variant_origin', ['baseline', 'authored', 'generated']);

export const adaptationActionEnum = pgEnum('adaptation_action', [
  'generated',
  'promoted',
  'retired',
  'quarantined',
  'released',
  'pinned',
  'unpinned',
  'rolled_back',
  'config_changed',
  'paused',
  'resumed',
]);

export const autonomyEnum = pgEnum('autonomy_level', ['manual', 'review', 'auto']);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'published',
  'failed',
  'expired',
]);

export const platformEnum = pgEnum('social_platform', [
  'x',
  'instagram',
  'tiktok',
  'discord',
  'reddit',
  'youtube',
  'threads',
]);

export const contentStatusEnum = pgEnum('content_status', [
  'draft',
  'pending_review',
  'published',
  'rejected',
  'archived',
]);

export const safetyVerdictEnum = pgEnum('safety_verdict', ['safe', 'rejected', 'needs_review']);

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------

export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Nullable by design. Section 4 requires "ask for nothing at sign-up beyond the OAuth
     * handshake", and several providers (Discord without the email scope, TikTok)
     * simply do not return one. A MORPH identity does not need an email to exist.
     */
    email: varchar('email', { length: 320 }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    displayName: varchar('display_name', { length: 64 }),
    avatarUrl: text('avatar_url'),
    locale: varchar('locale', { length: 8 }),

    /** Which provider produced the first identity. The single most useful acquisition fact. */
    firstProvider: varchar('first_provider', { length: 24 }).notNull(),
    /** Assignment the visitor was on when they converted, for post-hoc attribution. */
    signupAssignmentHash: numeric('signup_assignment_hash', { precision: 20, scale: 0 }),
    signupContextBucket: varchar('signup_context_bucket', { length: 64 }),

    /** Section 4 anti-abuse: shadow-banned users still see the site; nothing they do counts. */
    shadowBanned: boolean('shadow_banned').notNull().default(false),
    shadowBanReason: text('shadow_ban_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft-delete marker; the hard delete runs in the erasure job. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Partial unique: two users may both have NULL email, but a present email is unique.
    uniqueIndex('user_email_unique')
      .on(t.email)
      .where(sql`${t.email} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index('user_created_at_idx').on(t.createdAt),
    index('user_first_provider_idx').on(t.firstProvider),
  ],
);

/**
 * One MORPH identity, many social identities (section 4, account linking).
 *
 * Tokens: MORPH stores only what it needs to *identify* a visitor. It never requests
 * posting scope on a visitor's account and never posts as a visitor, so there is no
 * column here for a visitor's access token. The operator's own tokens - the only ones
 * MORPH acts with - live in `social_account`, encrypted.
 */
export const socialIdentity = pgTable(
  'social_identity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 24 }).notNull(),
    providerAccountId: varchar('provider_account_id', { length: 128 }).notNull(),
    /** Provider-verified email, used for merge-on-match. Never trusted unverified. */
    verifiedEmail: varchar('verified_email', { length: 320 }),
    handle: varchar('handle', { length: 64 }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the link was confirmed by an explicit user action, not by inference. */
    linkConfirmedAt: timestamp('link_confirmed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('social_identity_provider_account_unique').on(t.provider, t.providerAccountId),
    index('social_identity_user_idx').on(t.userId),
  ],
);

/** Passkeys (WebAuthn). The no-social, no-password path required by section 4. */
export const authenticator = pgTable(
  'authenticator',
  {
    credentialId: text('credential_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    transports: text('transports'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('authenticator_user_idx').on(t.userId)],
);

export const authSession = pgTable(
  'auth_session',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('auth_session_user_idx').on(t.userId),
    index('auth_session_expires_idx').on(t.expires),
  ],
);

export const verificationToken = pgTable(
  'verification_token',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// -----------------------------------------------------------------------------
// Privacy
// -----------------------------------------------------------------------------

/**
 * Consent decisions.
 *
 * Append-only: a change of mind is a new row, never an update. Under GDPR the
 * operator must be able to demonstrate what a person consented to *at the time* an
 * event was recorded, and an UPDATE destroys exactly that evidence.
 *
 * `anon_id_hash` lets a pre-authentication consent decision be honoured without
 * knowing who the visitor is. It is the same rotating daily hash used in ClickHouse,
 * which means a consent record older than the rotation cannot be tied back to a
 * person - which is the point.
 */
export const consentRecord = pgTable(
  'consent_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    anonIdHash: varchar('anon_id_hash', { length: 32 }),
    mask: smallint('mask').notNull(),
    /** `banner`, `settings`, `api`, `withdrawal`. */
    source: varchar('source', { length: 24 }).notNull(),
    /** The exact consent-copy version shown, so the record is reproducible. */
    policyVersion: varchar('policy_version', { length: 16 }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('consent_user_idx').on(t.userId, t.recordedAt),
    index('consent_anon_idx').on(t.anonIdHash, t.recordedAt),
    check('consent_subject_present', sql`${t.userId} IS NOT NULL OR ${t.anonIdHash} IS NOT NULL`),
  ],
);

/**
 * Data-subject requests (GDPR Art. 15 and Art. 17).
 *
 * Retained permanently and deliberately: it records that a request was made and
 * fulfilled, with no personal data in it beyond an opaque id that no longer resolves
 * to anything once the erasure completes. Deleting the proof of deletion is how an
 * operator fails an audit while having done everything right.
 */
export const dataSubjectRequest = pgTable(
  'data_subject_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: varchar('kind', { length: 12 }).notNull(), // export | erasure
    /** Retained after the user row is gone; resolves to nothing, which is the point. */
    subjectRef: uuid('subject_ref').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Rows removed per store, for the audit trail. */
    result: jsonb('result').$type<Record<string, number>>(),
    error: text('error'),
  },
  (t) => [index('dsr_pending_idx').on(t.completedAt, t.requestedAt)],
);

// -----------------------------------------------------------------------------
// The adaptive engine
// -----------------------------------------------------------------------------

/**
 * The runtime variant pool.
 *
 * Hand-authored variants live in code (packages/core/src/surfaces/registry.ts) and are
 * seeded here at boot; generated variants exist only here. Both are validated by the
 * same gate. The registry is the schema; this table is the population.
 */
export const variant = pgTable(
  'variant',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    surfaceId: varchar('surface_id', { length: 48 }).notNull(),
    label: varchar('label', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: variantStatusEnum('status').notNull().default('active'),
    origin: variantOriginEnum('origin').notNull(),

    /** Optimistic prior for a freshly injected variant (section 2.3). */
    priorAlpha: real('prior_alpha').notNull().default(1),
    priorBeta: real('prior_beta').notNull().default(1),

    /** Provenance for generated variants; null for authored ones. */
    generationId: uuid('generation_id'),
    parentIds: jsonb('parent_ids').$type<string[]>(),
    trendSignalIds: jsonb('trend_signal_ids').$type<string[]>(),
    model: varchar('model', { length: 48 }),

    /** Denormalised counters. Authoritative numbers come from ClickHouse; these exist
     * so the admin console and /surfaces can answer instantly without an OLAP query. */
    impressions: integer('impressions').notNull().default(0),
    conversions: integer('conversions').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
    quarantineReason: text('quarantine_reason'),
  },
  (t) => [
    index('variant_surface_status_idx').on(t.surfaceId, t.status),
    index('variant_generation_idx').on(t.generationId),
    check('variant_prior_positive', sql`${t.priorAlpha} > 0 AND ${t.priorBeta} > 0`),
    check('variant_counts_sane', sql`${t.conversions} <= ${t.impressions}`),
  ],
);

/**
 * The immutable record of every decision.
 *
 * Section 2.3: "Every generation, promotion, quarantine and rollback is written to an
 * immutable adaptation_log table with the reasoning and the statistics that justified
 * it. This log is the raw material for the Telegram report."
 *
 * Immutability is enforced by permissions, not by convention: `morph_worker` is
 * granted INSERT and SELECT on this table and not UPDATE or DELETE.
 *
 * PARTITIONED BY RANGE (occurred_at) MONTHLY - see the note at the top of this file.
 */
export const adaptationLog = pgTable(
  'adaptation_log',
  {
    id: uuid('id').notNull().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    action: adaptationActionEnum('action').notNull(),
    surfaceId: varchar('surface_id', { length: 48 }),
    variantId: varchar('variant_id', { length: 80 }),
    contextBucket: varchar('context_bucket', { length: 64 }),

    /**
     * Plain-English justification, written for the operator, e.g.
     * "Retired hero.headline#7 - 94% probability of being worse than the leader
     * over 3.1k impressions."
     * Composed from `stats` by the report writer, and stored so the report never has
     * to re-derive a number whose inputs have since aged out.
     */
    reason: text('reason').notNull(),

    /** The statistics that justified the decision, verbatim. */
    stats: jsonb('stats')
      .$type<{
        impressions?: number;
        conversions?: number;
        posteriorMean?: number;
        credibleInterval?: [number, number];
        probabilityWorseThanLeader?: number;
        msprtStatistic?: number;
        msprtCrossed?: boolean;
        lift?: number;
        noveltyWeight?: number;
        [k: string]: unknown;
      }>()
      .notNull(),

    /** Reward weight version in force, so incomparable epochs are never compared. */
    rewardVersion: integer('reward_version').notNull(),
    /** `engine` | `operator` | `guardrail`. Who caused this. */
    actor: varchar('actor', { length: 16 }).notNull(),
    /** Telegram user id when actor = operator. */
    actorRef: varchar('actor_ref', { length: 32 }),
  },
  (t) => [
    // Composite PK including the partition key, as Postgres requires for a
    // partitioned table's primary key.
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('adaptation_log_time_idx').on(t.occurredAt),
    index('adaptation_log_surface_idx').on(t.surfaceId, t.occurredAt),
    index('adaptation_log_action_idx').on(t.action, t.occurredAt),
  ],
);

/** Single-row table holding the live engine configuration. */
export const engineConfig = pgTable('engine_config', {
  id: smallint('id').primaryKey().default(1),
  config: jsonb('config').notNull(),
  rewardVersion: integer('reward_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 32 }).notNull().default('system'),
});

/**
 * Periodic snapshot of each posterior.
 *
 * The live posteriors are in Redis for latency. This table is the durable record: it
 * survives a Redis flush, it lets the report show a trajectory rather than a point,
 * and it makes "why did it promote that variant on Tuesday" answerable.
 */
export const posteriorSnapshot = pgTable(
  'posterior_snapshot',
  {
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    surfaceId: varchar('surface_id', { length: 48 }).notNull(),
    variantId: varchar('variant_id', { length: 80 }).notNull(),
    contextBucket: varchar('context_bucket', { length: 64 }).notNull(),
    isHoldout: boolean('is_holdout').notNull().default(false),
    alpha: real('alpha').notNull(),
    beta: real('beta').notNull(),
    impressions: integer('impressions').notNull(),
    rewardSum: real('reward_sum').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.takenAt, t.surfaceId, t.variantId, t.contextBucket, t.isHoldout] }),
    index('posterior_surface_idx').on(t.surfaceId, t.takenAt),
  ],
);

// -----------------------------------------------------------------------------
// Web intelligence (section 3)
// -----------------------------------------------------------------------------

/**
 * A source MORPH is allowed to read from.
 *
 * `robots_allows` and `tos_reviewed_at` are columns, not comments: the compliance
 * position in docs/COMPLIANCE.md has to be checkable by a query, and a source whose
 * robots policy has not been re-read within its TTL is simply not fetched.
 */
export const crawlSource = pgTable(
  'crawl_source',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: varchar('kind', { length: 16 }).notNull(), // api | feed | sitemap | html
    host: varchar('host', { length: 253 }).notNull(),
    url: text('url').notNull(),
    enabled: boolean('enabled').notNull().default(true),

    robotsAllows: boolean('robots_allows'),
    robotsCheckedAt: timestamp('robots_checked_at', { withTimezone: true }),
    crawlDelayMs: integer('crawl_delay_ms').notNull().default(1000),
    tosReviewedAt: timestamp('tos_reviewed_at', { withTimezone: true }),
    tosNote: text('tos_note'),

    etag: text('etag'),
    lastModified: text('last_modified'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastStatus: smallint('last_status'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crawl_source_url_unique').on(t.url),
    index('crawl_source_host_idx').on(t.host),
    index('crawl_source_due_idx').on(t.enabled, t.lastFetchedAt),
  ],
);

/** Fetched documents. A 30-day cache, not an archive - the signal outlives the text. */
export const crawlDocument = pgTable(
  'crawl_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => crawlSource.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    excerpt: text('excerpt'),
    /** 64-bit SimHash as a decimal string; near-duplicates are within a small Hamming distance. */
    simhash: numeric('simhash', { precision: 20, scale: 0 }).notNull(),
    lang: varchar('lang', { length: 8 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    /** 768-dim open embedding. HNSW index below; cosine distance. */
    embedding: vector('embedding', { dimensions: 768 }),
    clusterId: uuid('cluster_id'),
  },
  (t) => [
    uniqueIndex('crawl_document_url_unique').on(t.url),
    index('crawl_document_simhash_idx').on(t.simhash),
    index('crawl_document_cluster_idx').on(t.clusterId),
    index('crawl_document_fetched_idx').on(t.fetchedAt),
    // HNSW over cosine distance: build is slower than IVFFlat but recall stays high
    // without a retrain as the corpus turns over daily, which it does here.
    index('crawl_document_embedding_idx')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

/**
 * A scored topic cluster. This is what actually drives content and variant generation.
 */
export const trendSignal = pgTable(
  'trend_signal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: varchar('label', { length: 120 }).notNull(),
    centroid: vector('centroid', { dimensions: 768 }),
    documentCount: integer('document_count').notNull(),

    /** Velocity + acceleration of mentions, normalised to 0..1. */
    momentum: real('momentum').notNull(),
    /** Cosine similarity to the site's measured audience interest vector, 0..1. */
    audienceFit: real('audience_fit').notNull(),
    /** How crowded the topic already is; high saturation means low marginal value. */
    saturation: real('saturation').notNull(),
    /** Predicted half-life. A durable topic justifies an evergreen piece; a spike does not. */
    durability: real('durability').notNull(),

    safetyVerdict: safetyVerdictEnum('safety_verdict').notNull(),
    /** Which classifier rule fired, verbatim, for the report's rejection list. */
    safetyReason: text('safety_reason'),
    safetyCategories: jsonb('safety_categories').$type<string[]>(),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    actedOnAt: timestamp('acted_on_at', { withTimezone: true }),
  },
  (t) => [
    index('trend_signal_score_idx').on(t.safetyVerdict, t.momentum, t.audienceFit),
    index('trend_signal_recent_idx').on(t.lastSeenAt),
    check(
      'trend_scores_normalised',
      sql`${t.momentum} BETWEEN 0 AND 1 AND ${t.audienceFit} BETWEEN 0 AND 1`,
    ),
  ],
);

/**
 * The site's measured interest, one row per computation.
 *
 * The centroid of the pages readers engage with most, in the same embedding space as
 * `crawl_document.embedding` and `trend_signal.centroid` — which is what lets the trend
 * scorer's `audienceFit` term be a cosine similarity rather than a guess.
 *
 * History rather than a single mutable row, for two reasons. A drifting audience is a
 * fact the operator should be able to see rather than infer, and a vector that turns out
 * to have been computed from a bad window is recoverable by reading the previous one
 * instead of waiting for the next run.
 *
 * `sample_size` and `median_reward` are not decoration: a vector built from four pages
 * means something different from one built from four hundred, and the report says which.
 */
export const audienceVector = pgTable(
  'audience_vector',
  {
    computedAt: timestamp('computed_at', { withTimezone: true }).primaryKey().defaultNow(),
    vector: vector('vector', { dimensions: 768 }).notNull(),
    /** How many pages cleared the median and contributed. */
    sampleSize: integer('sample_size').notNull(),
    /** The median composite reward the split was taken at. */
    medianReward: real('median_reward').notNull(),
    /** Days of engagement the computation looked back over. */
    windowDays: integer('window_days').notNull(),
    /** Which pages contributed, and how much, for the report and for debugging. */
    contributors: jsonb('contributors').$type<{ path: string; reward: number }[]>().notNull(),
  },
  (t) => [
    index('audience_vector_recent_idx').on(t.computedAt),
    check('audience_sample_positive', sql`${t.sampleSize} > 0`),
  ],
);

// -----------------------------------------------------------------------------
// Content
// -----------------------------------------------------------------------------

export const content = pgTable(
  'content',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 128 }).notNull(),
    kind: varchar('kind', { length: 24 }).notNull(), // article | module | poll | explainer
    title: varchar('title', { length: 200 }).notNull(),
    summary: text('summary'),
    body: jsonb('body').notNull(),
    status: contentStatusEnum('status').notNull().default('draft'),

    trendSignalId: uuid('trend_signal_id').references(() => trendSignal.id),
    /**
     * Mandatory attribution (section 3). A generated piece with no sources does not get
     * published; the check below makes that a database invariant rather than a hope.
     */
    sources: jsonb('sources')
      .$type<{ url: string; title: string; publisher: string }[]>()
      .notNull(),
    /** Provenance record: "generated, human-reviewable". */
    generatedBy: varchar('generated_by', { length: 48 }),
    generationPrompt: text('generation_prompt'),
    reviewedBy: varchar('reviewed_by', { length: 32 }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('content_slug_unique').on(t.slug),
    index('content_status_idx').on(t.status, t.publishedAt),
    index('content_trend_idx').on(t.trendSignalId),
    check(
      'content_published_needs_sources',
      sql`${t.status} <> 'published' OR jsonb_array_length(${t.sources}) > 0`,
    ),
    check(
      'content_generated_needs_review',
      sql`${t.status} <> 'published' OR ${t.generatedBy} IS NULL OR ${t.reviewedAt} IS NOT NULL`,
    ),
  ],
);

// -----------------------------------------------------------------------------
// Social (section 6) - operator-owned accounts only
// -----------------------------------------------------------------------------

/**
 * The operator's own authenticated accounts. One row per platform per account.
 *
 * There is no password column and there never will be (section 0, rule 5). Refresh
 * tokens are AES-256-GCM encrypted with SOCIAL_TOKEN_ENCRYPTION_KEY; the ciphertext,
 * nonce and auth tag are stored together and the key never touches the database.
 */
export const socialAccount = pgTable(
  'social_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: platformEnum('platform').notNull(),
    /** The operator's handle, for display in the report. */
    handle: varchar('handle', { length: 64 }).notNull(),
    platformAccountId: varchar('platform_account_id', { length: 64 }).notNull(),

    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    accessTokenNonce: varchar('access_token_nonce', { length: 32 }).notNull(),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    refreshTokenNonce: varchar('refresh_token_nonce', { length: 32 }),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),

    /** Circuit breaker state, so a platform outage is visible rather than inferred. */
    circuitOpenUntil: timestamp('circuit_open_until', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Documented ceiling, and the self-imposed daily cap well below it. */
    dailyActionCap: integer('daily_action_cap').notNull().default(40),

    enabled: boolean('enabled').notNull().default(true),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('social_account_platform_unique').on(t.platform, t.platformAccountId)],
);

/**
 * The approval queue. Every outbound post passes through here (section 0).
 *
 * PARTITIONED BY RANGE (created_at) MONTHLY.
 *
 * The check constraint is the enforcement point for the autonomy rule: a row may only
 * reach `approved` without a human approver when it was produced under `auto`
 * autonomy AND passed the safety classifier AND matched an approved template. Putting
 * that in the database rather than in application code means no future code path can
 * skip it.
 */
export const outboundPost = pgTable(
  'outbound_post',
  {
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    platform: platformEnum('platform').notNull(),
    accountId: uuid('account_id').notNull(),
    contentId: uuid('content_id'),

    body: text('body').notNull(),
    mediaRefs: jsonb('media_refs').$type<string[]>(),
    /** Platform-native adaptation of one source idea, never an identical cross-post. */
    sourcePostId: uuid('source_post_id'),

    status: approvalStatusEnum('status').notNull().default('pending'),
    autonomyAtCreation: autonomyEnum('autonomy_at_creation').notNull(),
    safetyVerdict: safetyVerdictEnum('safety_verdict').notNull(),
    templateId: varchar('template_id', { length: 48 }),

    approvedBy: varchar('approved_by', { length: 32 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),

    /** Chosen by the timing optimiser from the platform's own analytics API. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    platformPostId: varchar('platform_post_id', { length: 64 }),

    /** Engagement, refreshed from the platform API for the hourly report. */
    metrics: jsonb('metrics').$type<Record<string, number>>(),
    metricsUpdatedAt: timestamp('metrics_updated_at', { withTimezone: true }),

    /** Format bandit arm this post was drawn from (section 6). */
    formatVariantId: varchar('format_variant_id', { length: 80 }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('outbound_status_idx').on(t.status, t.scheduledFor),
    index('outbound_platform_idx').on(t.platform, t.createdAt),
    check(
      'outbound_auto_requires_safe_template',
      sql`${t.status} <> 'approved'
           OR ${t.approvedBy} IS NOT NULL
           OR (${t.autonomyAtCreation} = 'auto' AND ${t.safetyVerdict} = 'safe' AND ${t.templateId} IS NOT NULL)`,
    ),
  ],
);

/** Peer invitation - the only follower-growth mechanism that compounds and cannot get you banned. */
export const referral = pgTable(
  'referral',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inviterUserId: uuid('inviter_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 16 }).notNull(),
    invitedUserId: uuid('invited_user_id').references(() => user.id, { onDelete: 'set null' }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    rewardGrantedAt: timestamp('reward_granted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('referral_code_unique').on(t.code),
    index('referral_inviter_idx').on(t.inviterUserId),
    check('referral_no_self_invite', sql`${t.inviterUserId} <> ${t.invitedUserId}`),
  ],
);

// -----------------------------------------------------------------------------
// Operations
// -----------------------------------------------------------------------------

/** One row per hourly report, so a missed report is visible and a resend is possible. */
export const reportRun = pgTable(
  'report_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
    /** `full` when something happened, `brief` for the one-line quiet-hour summary. */
    kind: varchar('kind', { length: 8 }).notNull(),
    messageIds: jsonb('message_ids').$type<number[]>(),
    charCount: integer('char_count'),
    composedByModel: varchar('composed_by_model', { length: 48 }),
    /** Inputs, so a report can be re-composed months later without the metrics. */
    inputs: jsonb('inputs').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [uniqueIndex('report_run_hour_unique').on(t.hourStart)],
);

export const schema = {
  user,
  socialIdentity,
  authenticator,
  authSession,
  verificationToken,
  consentRecord,
  dataSubjectRequest,
  variant,
  adaptationLog,
  engineConfig,
  posteriorSnapshot,
  crawlSource,
  crawlDocument,
  trendSignal,
  audienceVector,
  content,
  socialAccount,
  outboundPost,
  referral,
  reportRun,
};
