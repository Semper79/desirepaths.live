/**
 * `RewardRepository`, split across two stores because the two halves have different
 * honesty requirements.
 *
 * `rewards()` reads the Durable Object counters — exact, unsampled, and the only thing
 * allowed to reach a Beta posterior (D33, D35).
 *
 * `health()` reads Analytics Engine — sampled, and fine for that, because it feeds the
 * guardrail rather than the statistics. A p75 LCP a few percent off moves nothing: the
 * thresholds are spaced far wider than the sampling error.
 *
 * One interface, two guarantees. That asymmetry is the whole point of the split and is the
 * thing most likely to be undone by somebody tidying up, so it is stated at both ends.
 */

import { SURFACE_KEYS } from '@morph/core';
import type { RewardRepository, VariantHealth, VariantReward } from '@morph/cycle';
import type { RewardComponents } from '@morph/adaptive';
import { analyticsQuery, sqlNumber, type AnalyticsQueryConfig } from '../analytics.js';

/** The slice of `SurfaceCounters` this needs. Narrower than the namespace on purpose. */
export interface CounterReader {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    countersBetween(
      fromHour: number,
      throughHour: number,
    ): Promise<
      readonly {
        readonly variantId: string;
        readonly isHoldout: boolean;
        readonly impressions: number;
        readonly signups: number;
        readonly engagedSessions: number;
        readonly scrollNormSum: number;
        readonly returns: number;
        readonly shares: number;
        readonly bounces: number;
      }[]
    >;
  };
}

function zero(): RewardComponents {
  return {
    impressions: 0,
    signups: 0,
    engagedSessions: 0,
    scrollNormSum: 0,
    returns: 0,
    shares: 0,
    bounces: 0,
  };
}

/**
 * One hour's rewards, summed across context buckets and excluding the holdout.
 *
 * Both of those are the port's contract rather than choices made here. Thompson sampling
 * wants one posterior per variant — splitting by context as well would divide the evidence
 * into cells too thin to sample from, which is the note on `context_bucket` in
 * `002_aggregates.sql`. And the holdout is the control: folding it into the adaptive
 * cohort's evidence would mean measuring the adaptation against itself.
 */
async function rewardsFor(
  counters: CounterReader,
  hourStart: number,
): Promise<readonly VariantReward[]> {
  const perSurface = await Promise.all(
    SURFACE_KEYS.map(async (surfaceId) => {
      // `idFromName` + `get`: the one-call `getByName` is absent from some workerd builds,
      // including the test pool's, and both address the same object deterministically.
      const stub = counters.get(counters.idFromName(surfaceId));
      const rows = await stub.countersBetween(hourStart, hourStart);

      const byVariant = new Map<string, RewardComponents>();

      for (const row of rows) {
        if (row.isHoldout) continue;

        const current = byVariant.get(row.variantId) ?? zero();
        byVariant.set(row.variantId, {
          impressions: current.impressions + row.impressions,
          signups: current.signups + row.signups,
          engagedSessions: current.engagedSessions + row.engagedSessions,
          scrollNormSum: current.scrollNormSum + row.scrollNormSum,
          returns: current.returns + row.returns,
          shares: current.shares + row.shares,
          bounces: current.bounces + row.bounces,
        });
      }

      return [...byVariant].map(([variantId, components]): VariantReward => ({
        surfaceId,
        variantId,
        components,
      }));
    }),
  );

  return perSurface.flat();
}

/** One row of the vitals query. Analytics Engine returns everything as a string or number. */
interface HealthRow {
  readonly surface: string;
  readonly variant: string;
  readonly samples: number;
  readonly p75_lcp: number;
  readonly p75_cls: number;
  readonly p75_inp: number;
  readonly client_errors: number;
  readonly sessions: number;
  readonly bounces: number;
}

/**
 * Core Web Vitals and error rates for the hour, from the event stream.
 *
 * The row shape this reads is the contract `apps/api/src/lib/analytics-events.ts` writes:
 * blob1 type, blob2 anon id, blob3 session, blob4 path, blob5 device, blob6 country,
 * blob7 referrer class, blob8 hour of week, blob9 assignment hash, blob10 surfaces,
 * blob11 variants, blob14 props.metric; double1 value, double2 bot score.
 *
 * `splitByChar` on blob10 and blob11 unpacks the tab-joined parallel arrays, and `arrayZip`
 * pairs them — a session that saw eleven surfaces produces eleven rows from one event. That
 * is the cost of storing the assignment as two lists rather than eleven columns, and it is
 * paid here rather than at write time where it would have multiplied the data points.
 *
 * Bot traffic is excluded at `bot_score < 60`, matching `BOT_THRESHOLD` and every aggregate
 * the ClickHouse schema defined.
 */
async function healthFor(
  analytics: AnalyticsQueryConfig,
  dataset: string,
  hourStart: number,
): Promise<readonly VariantHealth[]> {
  const from = sqlNumber(Math.trunc(hourStart / 1000));
  const to = sqlNumber(Math.trunc((hourStart + 3_600_000) / 1000));

  const rows = await analyticsQuery<HealthRow>(
    analytics,
    `SELECT
       pair.1 AS surface,
       pair.2 AS variant,
       SUM(_sample_interval) AS samples,
       quantileExactWeighted(0.75)(if(blob14 = 'lcp', double1, NULL), _sample_interval) AS p75_lcp,
       quantileExactWeighted(0.75)(if(blob14 = 'cls', double1, NULL), _sample_interval) AS p75_cls,
       quantileExactWeighted(0.75)(if(blob14 = 'inp', double1, NULL), _sample_interval) AS p75_inp,
       SUMIf(_sample_interval, blob1 = 'client_error') AS client_errors,
       COUNT(DISTINCT blob3) AS sessions,
       SUMIf(_sample_interval, blob1 = 'bounce') AS bounces
     FROM ${dataset}
     ARRAY JOIN arrayZip(splitByChar('\t', blob10), splitByChar('\t', blob11)) AS pair
     WHERE timestamp >= toDateTime(${from})
       AND timestamp < toDateTime(${to})
       AND double2 < 60
     GROUP BY surface, variant`,
  );

  return rows.map((row): VariantHealth => {
    const sessions = Math.max(1, row.sessions);
    return {
      surfaceId: row.surface,
      variantId: row.variant,
      samples: row.samples,
      p75LcpMs: row.p75_lcp,
      p75Cls: row.p75_cls,
      p75InpMs: row.p75_inp,
      // Sessions as the denominator, not events: one broken render emits a dozen
      // exceptions, and a rate above one is not a rate. The same choice `client_errors_hourly`
      // made (D30).
      clientErrorRate: row.client_errors / sessions,
      bounceRate: row.bounces / sessions,
    };
  });
}

export function cloudflareRewards(
  counters: CounterReader,
  analytics: AnalyticsQueryConfig,
  dataset: string,
): RewardRepository {
  return {
    rewards: (hourStart) => rewardsFor(counters, hourStart),
    health: (hourStart) => healthFor(analytics, dataset, hourStart),
  };
}
