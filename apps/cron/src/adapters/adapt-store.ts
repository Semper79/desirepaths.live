/**
 * `AdaptRepository`, over D1.
 *
 * The transactional half of the cycle: which variants may be served, what the posteriors
 * were last time, and the immutable record of every decision. None of it is hot — a cycle
 * runs once an hour and reads tens of rows — which is why D1 is the right store for it and
 * why the counters are not here (D31's table of volumes).
 *
 * ON `applyDecisions` AND WHY IT USES `batch`
 * The port's comment says "status change plus its log entry, in one transaction or not at
 * all", and it means it: a variant marked retired with no log entry is a decision nobody
 * can explain, and a log entry with no status change is a claim the site contradicts.
 * `db.batch` is D1's transaction primitive — the statements run in order, atomically, in one
 * round trip.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import { adaptationLog, engineConfig, posteriorSnapshot, variant } from '@morph/core/db/sqlite';
import type {
  ActiveVariant,
  AdaptRepository,
  AdaptationRecord,
  PosteriorState,
  StoredPosterior,
} from '@morph/cycle';

/**
 * The context bucket these posteriors apply to.
 *
 * `posterior_snapshot` is keyed by bucket because it was designed to hold per-context rows
 * one day. The Beta layer aggregates across context on purpose — D29 — so what is written
 * here is the across-all-contexts posterior, and it needs a bucket value that cannot
 * collide with a real one. `*` is not a device, a referrer class or a day-part, so it
 * cannot.
 */
const ALL_CONTEXTS = '*';

/** Retired and quarantined variants are excluded; pinned ones are not. */
// Not `as const`: `inArray` takes a mutable array, and a readonly tuple is rejected.
const SERVABLE: ('active' | 'pinned')[] = ['active', 'pinned'];

export function d1AdaptStore(binding: D1Database): AdaptRepository {
  const db = drizzle(binding);

  return {
    async activeVariants(): Promise<readonly ActiveVariant[]> {
      const rows = await db
        .select({
          surfaceId: variant.surfaceId,
          variantId: variant.id,
          origin: variant.origin,
          priorAlpha: variant.priorAlpha,
          priorBeta: variant.priorBeta,
        })
        .from(variant)
        .where(inArray(variant.status, SERVABLE));

      return rows.map((row) => ({
        surfaceId: row.surfaceId,
        variantId: row.variantId,
        isBaseline: row.origin === 'baseline',
        priorAlpha: row.priorAlpha,
        priorBeta: row.priorBeta,
      }));
    },

    /**
     * The most recent snapshot, and the hour it already includes.
     *
     * `throughHour` is the idempotency key for the whole cycle, so reading the *latest*
     * `takenAt` and nothing older is load-bearing: mixing two snapshots would produce
     * posteriors that include one hour twice.
     */
    async posteriorState(): Promise<PosteriorState> {
      const latest = await db
        .select({ takenAt: posteriorSnapshot.takenAt })
        .from(posteriorSnapshot)
        .orderBy(desc(posteriorSnapshot.takenAt))
        .limit(1);

      const takenAt = latest[0]?.takenAt;
      if (takenAt === undefined) return { throughHour: null, posteriors: [] };

      const rows = await db
        .select({
          surfaceId: posteriorSnapshot.surfaceId,
          variantId: posteriorSnapshot.variantId,
          alpha: posteriorSnapshot.alpha,
          beta: posteriorSnapshot.beta,
          impressions: posteriorSnapshot.impressions,
        })
        .from(posteriorSnapshot)
        .where(
          and(
            eq(posteriorSnapshot.takenAt, takenAt),
            eq(posteriorSnapshot.contextBucket, ALL_CONTEXTS),
            eq(posteriorSnapshot.isHoldout, false),
          ),
        );

      return { throughHour: takenAt.getTime(), posteriors: rows };
    },

    async rewardVersion(): Promise<number> {
      const rows = await db
        .select({ rewardVersion: engineConfig.rewardVersion })
        .from(engineConfig)
        .where(eq(engineConfig.id, 1))
        .limit(1);

      // 1 is the schema default and the version every seeded config starts at, so an absent
      // row means "nothing has changed the weights yet" rather than an error. Guessing a
      // higher number would make the cycle refuse to compare against its own history.
      return rows[0]?.rewardVersion ?? 1;
    },

    /**
     * The durable record, written every cycle whether or not anything changed.
     *
     * `rewardSum` is derived rather than stored separately: the posterior's alpha already
     * carries the accumulated reward, and a second column holding the same quantity is a
     * second thing that can disagree with it.
     */
    async writePosteriors(takenAt: number, posteriors: readonly StoredPosterior[]): Promise<void> {
      if (posteriors.length === 0) return;

      await db.insert(posteriorSnapshot).values(
        posteriors.map((p) => ({
          takenAt: new Date(takenAt),
          surfaceId: p.surfaceId,
          variantId: p.variantId,
          contextBucket: ALL_CONTEXTS,
          isHoldout: false,
          alpha: p.alpha,
          beta: p.beta,
          impressions: p.impressions,
          rewardSum: p.alpha - 1,
        })),
      );
    },

    async applyDecisions(
      records: readonly AdaptationRecord[],
      rewardVersion: number,
    ): Promise<void> {
      if (records.length === 0) return;

      const now = new Date();

      // Built as a list and handed to `batch` so the whole set is one transaction. Written
      // as a loop of awaits it would be a sequence of independent writes, and a failure
      // halfway would leave variants retired with nothing explaining why.
      const statements = records.flatMap((record) => [
        db
          .update(variant)
          .set(
            record.action === 'retire'
              ? { status: 'retired' as const, retiredAt: now }
              : {
                  status: 'quarantined' as const,
                  quarantinedAt: now,
                  quarantineReason: record.reason,
                },
          )
          .where(eq(variant.id, record.variantId)),

        db.insert(adaptationLog).values({
          occurredAt: now,
          action: record.action === 'retire' ? ('retired' as const) : ('quarantined' as const),
          surfaceId: record.surfaceId,
          variantId: record.variantId,
          reason: record.reason,
          stats: record.stats,
          rewardVersion,
          // Not `operator`: nothing here was asked for by a person. `guardrail` would be
          // wrong too for a retirement — that is the reward statistics settling, which is
          // the engine doing its ordinary job.
          actor: record.action === 'quarantine' ? 'guardrail' : 'engine',
        }),
      ]);

      // Drizzle's D1 driver exposes `batch` with the same semantics as the raw binding:
      // the statements run in order, atomically, in one round trip. The first element is
      // read out separately because `batch` wants a non-empty tuple and `records.length > 0`
      // is already established above — so this is narrowing a known fact, not asserting one.
      const [first, ...rest] = statements;
      if (first === undefined) return;
      await db.batch([first, ...rest]);
    },
  };
}

/** Exported for the retention cron, which deletes by date and never by id. */
export function pruneStatement(binding: D1Database, table: string, column: string, cutoff: number) {
  const db = drizzle(binding);
  // `table` and `column` come from `RETENTION_COLUMN` in `@morph/core`, which is a literal
  // map in source — never from a request. The retention test asserts every entry matches a
  // table the migration creates, so there is no path by which these are untrusted.
  return db.run(sql.raw(`DELETE FROM ${table} WHERE ${column} < ${String(Math.trunc(cutoff))}`));
}
