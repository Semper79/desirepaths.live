/**
 * D1 schema — the source of truth for everything that is not behaviour.
 * =============================================================================
 * The Cloudflare port (D31). This replaces `schema.ts`, which targeted Postgres; that
 * file stays until every adapter has moved, and then it goes. Two schemas that must be
 * kept in step is exactly the duplication `CLAUDE.md` forbids, so this is a transitional
 * state with an end, not an architecture.
 *
 * Behaviour does NOT live here. Raw events go to Analytics Engine and the counters the
 * engine reasons from live in Durable Objects (D33). D1 holds what must be transactional,
 * foreign-keyed or auditable: content, configuration, the variant pool, the consent and
 * data-subject record, and the immutable log of every decision.
 *
 * WHAT CHANGED COMING FROM POSTGRES, AND WHY EACH ONE IS SAFE
 *
 * `pgEnum` → `text({ enum })` plus a CHECK. SQLite has no enum type. Drizzle's `enum`
 * option is a TypeScript narrowing and nothing more, so on its own it would turn a
 * database invariant into a convention. The CHECK constraints below restore the
 * invariant: an invalid value is rejected by D1, not merely unrepresentable in TS.
 *
 * `timestamp` → `integer({ mode: 'timestamp_ms' })`. Drizzle still hands back a `Date`,
 * so no calling code changes. SQLite has no timezone-aware type; every value stored is
 * epoch milliseconds, which is UTC by construction and therefore cannot drift the way a
 * naive local timestamp does.
 *
 * `jsonb` → `text({ mode: 'json' })`. SQLite's JSON1 functions operate on text, so
 * `json_array_length` works on these columns exactly as `jsonb_array_length` did.
 *
 * `uuid().defaultRandom()` → `text().$defaultFn(crypto.randomUUID)`. Generated in the
 * Worker rather than by the database. `crypto.randomUUID` is a v4 UUID from a CSPRNG on
 * Workers, so this is a change of location and not of quality.
 *
 * `vector` → gone. pgvector has no D1 equivalent, and a 768-dimension cosine scan in SQL
 * is not something SQLite should be asked to do. Embeddings move to Vectorize, and
 * `crawl_document` will keep only the Vectorize id when that table is ported.
 *
 * PARTITIONING IS GONE, AND THAT IS FINE
 * `adaptation_log` was RANGE partitioned monthly so retention could DETACH a month
 * instead of issuing a DELETE that bloats the heap. SQLite has no partitioning and also
 * none of the problem: these tables take thousands of rows per month, and a
 * `DELETE WHERE occurred_at < ?` on an indexed column is a cheap statement at that size.
 * Retention becomes a Cron Trigger. The obligation moves from the schema to a job, which
 * is a real loss — a job can stop, a table definition cannot — so the retention cron
 * reports its row count into the hourly report rather than running silently.
 *
 * RETENTION / TTL
 * The policy is no longer a comment. It lives in `retention.ts` as data, the cron reads the
 * cutoffs from there, and `test/retention.test.ts` reads the generated migration off disk
 * and fails the build if a table exists with no decision. That is what replaces the
 * enforcement partitioning used to provide.
 *
 * The list this header used to carry omitted `posterior_snapshot`, which had no retention
 * rule in the Postgres original either. On Postgres that was a line on a disk bill; against
 * D1's 10 GB cap it is a wall, since thousands of rows an hour is about 2 GB a year at the
 * realistic end. The port did not cause that — it exposed it.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// -----------------------------------------------------------------------------
// Enumerated domains
// -----------------------------------------------------------------------------
// Declared once as const tuples so the `enum` option and the CHECK constraint are built
// from the same list. Writing the values twice is how the TypeScript type and the
// database constraint drift apart, and the drift stays invisible until a write fails in
// production or, worse, succeeds when it should not have.

export const VARIANT_STATUS = ['active', 'quarantined', 'retired', 'pinned'] as const;
export const VARIANT_ORIGIN = ['baseline', 'authored', 'generated'] as const;
export const ADAPTATION_ACTION = [
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
] as const;
export const CONTENT_STATUS = [
  'draft',
  'pending_review',
  'published',
  'rejected',
  'archived',
] as const;

/** Renders a tuple as a SQL value list, for embedding in a CHECK. */
function inList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

const uuidDefault = (): string => crypto.randomUUID();
const nowDefault = (): Date => new Date();

// -----------------------------------------------------------------------------
// Consent and data-subject rights
// -----------------------------------------------------------------------------

/**
 * Every consent state this site has been given, append-only.
 *
 * `user_id` carries no foreign key here, unlike the Postgres original: the identity
 * tables are Phase 4 and have not been ported, and a reference to a table that does not
 * exist is a migration that will not apply. It comes back with them.
 */
export const consentRecord = sqliteTable(
  'consent_record',
  {
    id: text('id').primaryKey().$defaultFn(uuidDefault),
    userId: text('user_id'),
    anonIdHash: text('anon_id_hash'),
    mask: integer('mask').notNull(),
    /** `banner`, `settings`, `api`, `withdrawal`. */
    source: text('source').notNull(),
    /** The exact consent-copy version shown, so the record is reproducible. */
    policyVersion: text('policy_version').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
  },
  (t) => ({
    userIdx: index('consent_user_idx').on(t.userId, t.recordedAt),
    anonIdx: index('consent_anon_idx').on(t.anonIdHash, t.recordedAt),
    subjectPresent: check(
      'consent_subject_present',
      sql`${t.userId} IS NOT NULL OR ${t.anonIdHash} IS NOT NULL`,
    ),
  }),
);

/**
 * Data-subject requests (GDPR Art. 15 and Art. 17).
 *
 * Retained permanently and deliberately: it records that a request was made and
 * fulfilled, with no personal data in it beyond an opaque id that no longer resolves to
 * anything once the erasure completes. Deleting the proof of deletion is how an operator
 * fails an audit while having done everything right.
 */
export const dataSubjectRequest = sqliteTable(
  'data_subject_request',
  {
    id: text('id').primaryKey().$defaultFn(uuidDefault),
    kind: text('kind', { enum: ['export', 'erasure'] }).notNull(),
    /** Retained after the subject is gone; resolves to nothing, which is the point. */
    subjectRef: text('subject_ref').notNull(),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    /** Rows removed per store, for the audit trail. */
    result: text('result', { mode: 'json' }).$type<Record<string, number>>(),
    error: text('error'),
  },
  (t) => ({
    pendingIdx: index('dsr_pending_idx').on(t.completedAt, t.requestedAt),
    kindValid: check('dsr_kind_valid', sql.raw(`kind IN ('export', 'erasure')`)),
  }),
);

// -----------------------------------------------------------------------------
// The adaptive engine
// -----------------------------------------------------------------------------

/**
 * The runtime variant pool.
 *
 * Hand-authored variants live in code (`packages/core/src/surfaces/registry.ts`) and are
 * seeded here at boot; generated variants exist only here. Both are validated by the same
 * gate. The registry is the schema; this table is the population.
 */
export const variant = sqliteTable(
  'variant',
  {
    id: text('id').primaryKey(),
    surfaceId: text('surface_id').notNull(),
    label: text('label').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    status: text('status', { enum: VARIANT_STATUS }).notNull().default('active'),
    origin: text('origin', { enum: VARIANT_ORIGIN }).notNull(),

    /** Optimistic prior for a freshly injected variant (§2.3). */
    priorAlpha: real('prior_alpha').notNull().default(1),
    priorBeta: real('prior_beta').notNull().default(1),

    /** Provenance for generated variants; null for authored ones. */
    generationId: text('generation_id'),
    parentIds: text('parent_ids', { mode: 'json' }).$type<string[]>(),
    trendSignalIds: text('trend_signal_ids', { mode: 'json' }).$type<string[]>(),
    model: text('model'),

    /**
     * Denormalised counters, for the admin console and `/surfaces`.
     *
     * Authoritative numbers now come from the surface's Durable Object rather than from
     * ClickHouse (D33). These stay a convenience copy and are still not what the engine
     * reasons from — a distinction that matters more here than it did, because a DO read
     * is cheap enough that "it was faster" would be a tempting and wrong reason to use
     * these instead.
     */
    impressions: integer('impressions').notNull().default(0),
    conversions: integer('conversions').notNull().default(0),

    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    quarantinedAt: integer('quarantined_at', { mode: 'timestamp_ms' }),
    quarantineReason: text('quarantine_reason'),
  },
  (t) => ({
    surfaceStatusIdx: index('variant_surface_status_idx').on(t.surfaceId, t.status),
    generationIdx: index('variant_generation_idx').on(t.generationId),
    statusValid: check('variant_status_valid', sql.raw(`status IN (${inList(VARIANT_STATUS)})`)),
    originValid: check('variant_origin_valid', sql.raw(`origin IN (${inList(VARIANT_ORIGIN)})`)),
    priorPositive: check('variant_prior_positive', sql`${t.priorAlpha} > 0 AND ${t.priorBeta} > 0`),
    countsSane: check('variant_counts_sane', sql`${t.conversions} <= ${t.impressions}`),
  }),
);

/**
 * The immutable record of every decision.
 *
 * §2.3: every generation, promotion, quarantine and rollback is written here with the
 * reasoning and the statistics that justified it. This log is the raw material for the
 * Telegram report, for `/changes`, and for `/proof`.
 *
 * ON IMMUTABILITY, WHICH IS WEAKER HERE THAN IT WAS
 * Under Postgres this was enforced by grants: `morph_worker` had INSERT and SELECT and
 * not UPDATE or DELETE. D1 has no role system — a binding can do anything to the database
 * it is bound to. The guarantee is therefore now a property of the code rather than of
 * the platform, and that is a downgrade worth naming rather than papering over with the
 * CHECK constraints below, which do not address it. What holds it up instead: no adapter
 * exposes an update path for this table, and the retention cron is the only writer
 * allowed to delete, by date, never by id.
 */
export const adaptationLog = sqliteTable(
  'adaptation_log',
  {
    id: text('id').primaryKey().$defaultFn(uuidDefault),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
    action: text('action', { enum: ADAPTATION_ACTION }).notNull(),
    surfaceId: text('surface_id'),
    variantId: text('variant_id'),
    contextBucket: text('context_bucket'),

    /**
     * Plain-English justification, written for the operator, e.g.
     * "Retired hero.headline#7 — 94% probability of being worse than the leader over
     * 3.1k impressions."
     * Composed from `stats` by the report writer and stored, so the report never has to
     * re-derive a number whose inputs have since aged out. `/changes` publishes this
     * verbatim; there is no friendlier version for the public.
     */
    reason: text('reason').notNull(),

    /** The statistics that justified the decision, verbatim. */
    stats: text('stats', { mode: 'json' })
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
    actor: text('actor').notNull(),
    /** Telegram user id when actor = operator. */
    actorRef: text('actor_ref'),
  },
  (t) => ({
    timeIdx: index('adaptation_log_time_idx').on(t.occurredAt),
    surfaceIdx: index('adaptation_log_surface_idx').on(t.surfaceId, t.occurredAt),
    actionIdx: index('adaptation_log_action_idx').on(t.action, t.occurredAt),
    actionValid: check(
      'adaptation_action_valid',
      sql.raw(`action IN (${inList(ADAPTATION_ACTION)})`),
    ),
  }),
);

/** Single-row table holding the live engine configuration. */
export const engineConfig = sqliteTable('engine_config', {
  id: integer('id').primaryKey().default(1),
  config: text('config', { mode: 'json' }).notNull(),
  rewardVersion: integer('reward_version').notNull().default(1),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
  updatedBy: text('updated_by').notNull().default('system'),
});

/**
 * Periodic snapshot of each posterior.
 *
 * The live counters are in Durable Objects, for latency and for exactness (D33). This
 * table is the durable record: it survives an object being reset, it lets the report show
 * a trajectory rather than a point, and it makes "why did it promote that variant on
 * Tuesday" answerable after the Analytics Engine window has closed.
 */
export const posteriorSnapshot = sqliteTable(
  'posterior_snapshot',
  {
    takenAt: integer('taken_at', { mode: 'timestamp_ms' }).notNull(),
    surfaceId: text('surface_id').notNull(),
    variantId: text('variant_id').notNull(),
    contextBucket: text('context_bucket').notNull(),
    isHoldout: integer('is_holdout', { mode: 'boolean' }).notNull().default(false),
    alpha: real('alpha').notNull(),
    beta: real('beta').notNull(),
    impressions: integer('impressions').notNull(),
    rewardSum: real('reward_sum').notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.takenAt, t.surfaceId, t.variantId, t.contextBucket, t.isHoldout],
    }),
    surfaceIdx: index('posterior_surface_idx').on(t.surfaceId, t.takenAt),
  }),
);

// -----------------------------------------------------------------------------
// Content
// -----------------------------------------------------------------------------

/**
 * The published content index — what `apps/web` actually renders.
 *
 * `trend_signal_id` carries no foreign key for the same reason `consent_record.user_id`
 * does not: `trend_signal` belongs to the crawl pipeline, which is a later increment of
 * the port. It returns with that table.
 */
export const content = sqliteTable(
  'content',
  {
    id: text('id').primaryKey().$defaultFn(uuidDefault),
    slug: text('slug').notNull(),
    kind: text('kind').notNull(), // article | module | poll | explainer
    title: text('title').notNull(),
    summary: text('summary'),
    body: text('body', { mode: 'json' }).notNull(),
    status: text('status', { enum: CONTENT_STATUS }).notNull().default('draft'),

    trendSignalId: text('trend_signal_id'),
    /**
     * Mandatory attribution (§3). A generated piece with no sources does not get
     * published; the check below makes that a database invariant rather than a hope.
     */
    sources: text('sources', { mode: 'json' })
      .$type<{ url: string; title: string; publisher: string }[]>()
      .notNull(),
    /** Provenance record: "generated, human-reviewable". */
    generatedBy: text('generated_by'),
    generationPrompt: text('generation_prompt'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),

    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowDefault),
  },
  (t) => ({
    slugUnique: uniqueIndex('content_slug_unique').on(t.slug),
    statusIdx: index('content_status_idx').on(t.status, t.publishedAt),
    trendIdx: index('content_trend_idx').on(t.trendSignalId),
    statusValid: check('content_status_valid', sql.raw(`status IN (${inList(CONTENT_STATUS)})`)),
    // `json_array_length` is SQLite's JSON1 equivalent of `jsonb_array_length`: same
    // invariant, same failure. A published row with an empty `sources` array is rejected.
    publishedNeedsSources: check(
      'content_published_needs_sources',
      sql`${t.status} <> 'published' OR json_array_length(${t.sources}) > 0`,
    ),
    generatedNeedsReview: check(
      'content_generated_needs_review',
      sql`${t.status} <> 'published' OR ${t.generatedBy} IS NULL OR ${t.reviewedAt} IS NOT NULL`,
    ),
  }),
);
