/**
 * The report's reads from Postgres, and the record that it was sent.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE, for the same reason as `postgres.ts`: these need a live
 * database with the schema loaded. Each one is a query and a shape conversion with no
 * branch in it; everything derived from what they return is in `lib/report-derive.ts`,
 * which is covered.
 */

import { and, asc, count, desc, eq, gte, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import {
  adaptationLog,
  content,
  crawlDocument,
  crawlSource,
  engineConfig,
  reportRun,
  trendSignal,
  variant,
} from '@morph/core/db';
import { fromStoredVerdict, toStoredVerdict } from '@morph/core';
import type {
  AdaptationFacts,
  ChampionFacts,
  ReportRepository,
  ReportRun,
  ReportRunRepository,
  TrendSignalRecord,
} from '../ports';
import type { Database } from './postgres';

const toDate = (ms: number): Date => new Date(ms);

function toSignal(row: typeof trendSignal.$inferSelect): TrendSignalRecord {
  return {
    id: row.id,
    label: row.label,
    centroid: row.centroid ?? [],
    documentCount: row.documentCount,
    momentum: row.momentum,
    audienceFit: row.audienceFit,
    saturation: row.saturation,
    durability: row.durability,
    safetyVerdict: fromStoredVerdict(row.safetyVerdict),
    safetyReason: row.safetyReason,
    safetyCategories: row.safetyCategories ?? [],
    firstSeenAt: row.firstSeenAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    actedOnAt: row.actedOnAt === null ? null : row.actedOnAt.getTime(),
  };
}

export function reportRepository(db: Database): ReportRepository {
  const scalar = async (query: Promise<{ value: number }[]>): Promise<number> =>
    (await query)[0]?.value ?? 0;

  return {
    async adaptations(hourStart, hourEnd) {
      const rows = await db
        .select()
        .from(adaptationLog)
        .where(
          and(
            gte(adaptationLog.occurredAt, toDate(hourStart)),
            lt(adaptationLog.occurredAt, toDate(hourEnd)),
          ),
        )
        .orderBy(asc(adaptationLog.occurredAt));

      return rows.map((row): AdaptationFacts => ({
        action: row.action,
        surfaceId: row.surfaceId,
        variantId: row.variantId,
        reason: row.reason,
        impressions: row.stats.impressions ?? null,
      }));
    },

    async champions() {
      const rows = await db
        .select()
        .from(variant)
        .where(inArray(variant.status, ['active', 'pinned']));

      // Grouped in code rather than by a window function: the variant pool is dozens of
      // rows, and the alternative is a query nobody will be able to read in a year.
      const bySurface = new Map<string, (typeof rows)[number][]>();
      for (const row of rows) {
        const list = bySurface.get(row.surfaceId);
        if (list === undefined) bySurface.set(row.surfaceId, [row]);
        else list.push(row);
      }

      const champions: ChampionFacts[] = [];

      for (const [surfaceId, group] of bySurface) {
        // The champion is the one with the highest posterior mean, computed from the
        // denormalised counters rather than from Redis: the report is allowed to be a few
        // minutes behind, and a report that cannot be produced without the hot path is a
        // report that stops during exactly the incident it is meant to describe.
        const best = [...group].sort(
          (a, b) =>
            (b.priorAlpha + b.conversions) / (b.priorAlpha + b.priorBeta + b.impressions) -
            (a.priorAlpha + a.conversions) / (a.priorAlpha + a.priorBeta + a.impressions),
        )[0];

        if (best === undefined) continue;

        champions.push({
          surfaceId,
          variantId: best.id,
          variantLabel: best.label,
          alpha: best.priorAlpha + best.conversions,
          beta: best.priorBeta + (best.impressions - best.conversions),
          impressions: best.impressions,
          activeVariants: group.length,
        });
      }

      return champions.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
    },

    async rewardVersion() {
      const [row] = await db
        .select({ value: engineConfig.rewardVersion })
        .from(engineConfig)
        .limit(1);
      return row?.value ?? 1;
    },

    async newClusters(hourStart, hourEnd, limit) {
      const rows = await db
        .select()
        .from(trendSignal)
        .where(
          and(
            gte(trendSignal.firstSeenAt, toDate(hourStart)),
            lt(trendSignal.firstSeenAt, toDate(hourEnd)),
          ),
        )
        .orderBy(desc(trendSignal.momentum))
        .limit(limit);

      return rows.map(toSignal);
    },

    async rejectedTopics(hourStart, hourEnd, limit) {
      const rows = await db
        .select()
        .from(trendSignal)
        .where(
          and(
            eq(trendSignal.safetyVerdict, toStoredVerdict('block')),
            gte(trendSignal.lastSeenAt, toDate(hourStart)),
            lt(trendSignal.lastSeenAt, toDate(hourEnd)),
          ),
        )
        .orderBy(desc(trendSignal.momentum))
        .limit(limit);

      return rows.map(toSignal);
    },

    async publishedInHour(hourStart, hourEnd) {
      const rows = await db
        .select({ title: content.title, slug: content.slug })
        .from(content)
        .where(
          and(
            eq(content.status, 'published'),
            gte(content.publishedAt, toDate(hourStart)),
            lt(content.publishedAt, toDate(hourEnd)),
          ),
        );

      return rows;
    },

    async documentsFetched(hourStart, hourEnd) {
      const [row] = await db
        .select({
          documents: count(),
          hosts: sql<number>`count(distinct ${crawlSource.host})::int`,
        })
        .from(crawlDocument)
        .innerJoin(crawlSource, eq(crawlDocument.sourceId, crawlSource.id))
        .where(
          and(
            gte(crawlDocument.fetchedAt, toDate(hourStart)),
            lt(crawlDocument.fetchedAt, toDate(hourEnd)),
          ),
        );

      return { documents: row?.documents ?? 0, hosts: row?.hosts ?? 0 };
    },

    staleRobotsCount(before) {
      // 24 hours is `ROBOTS_TTL_MS` in the crawler. A source past it is not fetched at all
      // until the policy is re-read — the compliance rule working, and worth reporting
      // because a persistent count means a host has become unreachable.
      const cutoff = toDate(before - 24 * 60 * 60 * 1000);

      return scalar(
        db
          .select({ value: count() })
          .from(crawlSource)
          .where(
            and(
              eq(crawlSource.enabled, true),
              sql`(${crawlSource.robotsCheckedAt} IS NULL OR ${crawlSource.robotsCheckedAt} < ${cutoff})`,
            ),
          ),
      );
    },

    draftsAwaitingReview() {
      return scalar(
        db
          .select({ value: count() })
          .from(content)
          .where(inArray(content.status, ['draft', 'pending_review'])),
      );
    },

    draftsOlderThan(cutoff) {
      return scalar(
        db
          .select({ value: count() })
          .from(content)
          .where(
            and(
              inArray(content.status, ['draft', 'pending_review']),
              lt(content.createdAt, toDate(cutoff)),
            ),
          ),
      );
    },

    documentsAwaitingEmbedding() {
      return scalar(
        db.select({ value: count() }).from(crawlDocument).where(isNull(crawlDocument.embedding)),
      );
    },

    clustersAwaitingContent() {
      return scalar(
        db
          .select({ value: count() })
          .from(trendSignal)
          .where(
            and(
              eq(trendSignal.safetyVerdict, toStoredVerdict('allow')),
              isNull(trendSignal.actedOnAt),
            ),
          ),
      );
    },

    async ping() {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        // Same reasoning as the ClickHouse ping: the report's health line is its own
        // statement about whether its numbers can be trusted, and a throw here would stop
        // the report that was about to say "postgres is down" from being sent.
        return false;
      }
    },
  };
}

/**
 * The record that an hour was reported.
 *
 * `report_run_hour_unique` is what makes the report idempotent: the job asks this before
 * composing, and a retry, a redeploy or a restart mid-hour finds the row and stops.
 */
export function reportRunRepository(db: Database): ReportRunRepository {
  return {
    async wasSent(hourStart) {
      const [row] = await db
        .select({ sentAt: reportRun.sentAt })
        .from(reportRun)
        .where(and(eq(reportRun.hourStart, toDate(hourStart)), isNotNull(reportRun.sentAt)))
        .limit(1);

      return row !== undefined;
    },

    async record(run: ReportRun) {
      await db
        .insert(reportRun)
        .values({
          hourStart: toDate(run.hourStart),
          kind: run.kind,
          messageIds: [...run.messageIds],
          charCount: run.charCount,
          inputs: run.inputs,
          composedByModel: run.composedByModel,
          sentAt: run.sentAt === null ? null : toDate(run.sentAt),
          error: run.error,
        })
        // An hour that failed to send and is retried updates its own row rather than
        // colliding on the unique key — so the last attempt's error is the one on record.
        .onConflictDoUpdate({
          target: reportRun.hourStart,
          set: {
            kind: run.kind,
            messageIds: [...run.messageIds],
            charCount: run.charCount,
            inputs: run.inputs,
            composedByModel: run.composedByModel,
            sentAt: run.sentAt === null ? null : toDate(run.sentAt),
            error: run.error,
          },
        });
    },
  };
}
