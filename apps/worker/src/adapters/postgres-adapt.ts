/**
 * The adaptive loop's reads and writes in Postgres.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE, for the same reason as `postgres.ts` and
 * `postgres-report.ts`: these need a live database with the schema loaded. Every decision
 * they carry out was made in `lib/adapt-derive.ts`, which is covered exhaustively; what is
 * left here is a query and a shape conversion.
 *
 * The one thing here that is not trivial is `applyDecisions`, and it is a transaction for
 * a reason worth stating: the status change and its log entry are the same fact recorded
 * twice, once for the renderer and once for the operator. A crash between them leaves a
 * variant that stopped being served with no record of why — which is the single question
 * the adaptation log exists to answer.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { adaptationLog, engineConfig, posteriorSnapshot, variant } from '@morph/core/db';
import { SURFACES, SURFACE_KEYS } from '@morph/core';
import type {
  ActiveVariant,
  AdaptRepository,
  AdaptationRecord,
  PosteriorState,
  StoredPosterior,
} from '../ports';
import type { Database } from './postgres';

/**
 * Which variant is the baseline for a surface, from the registry rather than from a
 * column.
 *
 * The registry is the schema and the table is the population — a `variant` row has no
 * "is baseline" flag because the answer belongs to the surface, not to the variant, and
 * two sources for it would eventually disagree about which one can never be retired.
 */
function baselineIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const key of SURFACE_KEYS) ids.add(`${key} ${SURFACES[key].baselineVariantId}`);
  return ids;
}

export function postgresAdapt(db: Database): AdaptRepository {
  return {
    async activeVariants(): Promise<readonly ActiveVariant[]> {
      const baseline = baselineIds();

      const rows = await db
        .select({
          surfaceId: variant.surfaceId,
          variantId: variant.id,
          priorAlpha: variant.priorAlpha,
          priorBeta: variant.priorBeta,
        })
        .from(variant)
        .where(eq(variant.status, 'active'));

      return rows.map((row) => ({
        surfaceId: row.surfaceId,
        variantId: row.variantId,
        isBaseline: baseline.has(`${row.surfaceId} ${row.variantId}`),
        priorAlpha: row.priorAlpha,
        priorBeta: row.priorBeta,
      }));
    },

    async posteriorState(): Promise<PosteriorState> {
      // The most recent cycle only. Older rows are the trajectory the report draws and
      // the answer to "why did it promote that on Tuesday"; they are not state.
      const [latest] = await db
        .select({ takenAt: posteriorSnapshot.takenAt })
        .from(posteriorSnapshot)
        .orderBy(desc(posteriorSnapshot.takenAt))
        .limit(1);

      if (latest === undefined) return { throughHour: null, posteriors: [] };

      const rows = await db
        .select({
          surfaceId: posteriorSnapshot.surfaceId,
          variantId: posteriorSnapshot.variantId,
          alpha: posteriorSnapshot.alpha,
          beta: posteriorSnapshot.beta,
          impressions: posteriorSnapshot.impressions,
        })
        .from(posteriorSnapshot)
        .where(eq(posteriorSnapshot.takenAt, latest.takenAt));

      return { throughHour: latest.takenAt.getTime(), posteriors: rows };
    },

    async rewardVersion(): Promise<number> {
      const [row] = await db
        .select({ version: engineConfig.rewardVersion })
        .from(engineConfig)
        .where(eq(engineConfig.id, 1))
        .limit(1);

      return row?.version ?? 1;
    },

    async writePosteriors(takenAt: number, posteriors: readonly StoredPosterior[]): Promise<void> {
      if (posteriors.length === 0) return;

      await db.insert(posteriorSnapshot).values(
        posteriors.map((p) => ({
          takenAt: new Date(takenAt),
          surfaceId: p.surfaceId,
          variantId: p.variantId,
          // The Beta layer aggregates across context; the column exists for a future
          // per-context posterior and is written with the sentinel rather than left to a
          // default, so a reader can tell "all contexts" from "context not recorded".
          contextBucket: '*',
          isHoldout: false,
          alpha: p.alpha,
          beta: p.beta,
          impressions: p.impressions,
          rewardSum: p.alpha,
        })),
      );
    },

    async applyDecisions(
      records: readonly AdaptationRecord[],
      rewardVersion: number,
    ): Promise<void> {
      if (records.length === 0) return;

      const retired = records.filter((r) => r.action === 'retire').map((r) => r.variantId);
      const quarantined = records.filter((r) => r.action === 'quarantine').map((r) => r.variantId);
      const occurredAt = new Date();

      await db.transaction(async (tx) => {
        if (retired.length > 0) {
          await tx
            .update(variant)
            .set({ status: 'retired', retiredAt: occurredAt })
            .where(and(inArray(variant.id, retired), eq(variant.status, 'active')));
        }

        if (quarantined.length > 0) {
          await tx
            .update(variant)
            .set({
              status: 'quarantined',
              quarantinedAt: occurredAt,
              quarantineReason: records.find((r) => r.action === 'quarantine')?.reason ?? null,
            })
            .where(and(inArray(variant.id, quarantined), eq(variant.status, 'active')));
        }

        await tx.insert(adaptationLog).values(
          records.map((r) => ({
            occurredAt,
            action: r.action === 'retire' ? ('retired' as const) : ('quarantined' as const),
            surfaceId: r.surfaceId,
            variantId: r.variantId,
            contextBucket: null,
            reason: r.reason,
            stats: r.stats,
            rewardVersion,
            // Not `engine`. These decisions come from the guardrails, and the report
            // separates the two: an operator reading "the engine retired this" asks a
            // different question from one reading "a guardrail removed this".
            actor: 'guardrail',
            actorRef: null,
          })),
        );
      });
    },
  };
}
