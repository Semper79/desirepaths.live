/**
 * The adaptive loop's reads from ClickHouse.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE. These need a live ClickHouse with the aggregates
 * loaded. Each is a query and a shape conversion with no branch in it; everything derived
 * from what they return lives in `lib/adapt-derive.ts`, which is covered exhaustively.
 *
 * The two filters below are the load-bearing part and are stated here rather than left
 * implicit in the SQL:
 *
 *   `is_holdout = 0` — the holdout cohort is pinned to the baseline, so its rows would all
 *   land on one variant and make it look far better sampled than the traffic it actually
 *   competes for. It also exists to measure the system against itself, and feeding it back
 *   into the system it measures makes the comparison circular.
 *
 *   summing across `context_bucket` — Thompson sampling wants one posterior per variant.
 *   The un-bucketed covariate vector is LinUCB's input, and splitting the Beta posteriors
 *   by context as well divides the evidence into cells too thin to sample from.
 */

import { z } from 'zod';
import type { RewardRepository, VariantHealth, VariantReward } from '../ports.js';
import type { ClickHouseQuery } from './clickhouse-metrics.js';

const num = z.coerce.number();

const RewardRow = z.object({
  surface: z.string(),
  variant: z.string(),
  impressions: num,
  signups: num,
  engaged_sessions: num,
  scroll_norm_sum: num,
  returns: num,
  shares: num,
  bounces: num,
});

const HealthRow = z.object({
  surface: z.string(),
  variant: z.string(),
  samples: num,
  p75_lcp_ms: num,
  p75_cls: num,
  p75_inp_ms: num,
  client_error_rate: num,
  bounce_rate: num,
});

const REWARDS_SQL = `
  SELECT
    surface,
    variant,
    sum(impressions)      AS impressions,
    sum(signups)          AS signups,
    sum(engaged_sessions) AS engaged_sessions,
    sum(scroll_norm_sum)  AS scroll_norm_sum,
    sum(returns)          AS returns,
    sum(shares)           AS shares,
    sum(bounces)          AS bounces
  FROM surface_rewards_hourly
  WHERE hour_start = toDateTime({hour:UInt32})
    AND is_holdout = 0
  GROUP BY surface, variant
  FORMAT JSONEachRow
`;

/**
 * Vitals, errors and bounce rate per variant for one hour.
 *
 * Three sources, because that is how many the guardrail's question spans, and pretending
 * otherwise would mean inventing columns:
 *
 *   `vitals_hourly` is long format — one row per metric, holding quantile *states* — so
 *   the p75s are pivoted with `quantileTDigestMergeIf`. `samples` is counted on LCP
 *   specifically: it is the metric every browser reports, so it is the honest denominator
 *   for "did we see enough of this variant to judge it".
 *
 *   `client_errors_hourly` gives error sessions. Its denominator is sessions rather than
 *   events because one broken render emits a dozen exceptions and a rate above one is not
 *   a rate.
 *
 *   `surface_rewards_hourly` already carries impressions and bounces, so the bounce rate
 *   comes from the same rows the reward does and cannot disagree with them.
 *
 * A variant absent from all three simply does not appear, and `decideAdaptations` treats
 * an absent sample as "no health evidence" rather than as a clean bill of health.
 */
const HEALTH_SQL = `
  SELECT
    r.surface                                            AS surface,
    r.variant                                            AS variant,
    v.samples                                            AS samples,
    v.p75_lcp_ms                                         AS p75_lcp_ms,
    v.p75_cls                                            AS p75_cls,
    v.p75_inp_ms                                         AS p75_inp_ms,
    e.error_sessions / greatest(r.impressions, 1)        AS client_error_rate,
    r.bounces / greatest(r.impressions, 1)               AS bounce_rate
  FROM (
    SELECT surface, variant, sum(impressions) AS impressions, sum(bounces) AS bounces
    FROM surface_rewards_hourly
    WHERE hour_start = toDateTime({hour:UInt32}) AND is_holdout = 0
    GROUP BY surface, variant
  ) AS r
  LEFT JOIN (
    SELECT
      surface,
      variant,
      countMergeIf(samples, metric = 'lcp')                  AS samples,
      quantileTDigestMergeIf(0.75)(p75, metric = 'lcp')      AS p75_lcp_ms,
      quantileTDigestMergeIf(0.75)(p75, metric = 'cls')      AS p75_cls,
      quantileTDigestMergeIf(0.75)(p75, metric = 'inp')      AS p75_inp_ms
    FROM vitals_hourly
    WHERE hour_start = toDateTime({hour:UInt32})
    GROUP BY surface, variant
  ) AS v ON v.surface = r.surface AND v.variant = r.variant
  LEFT JOIN (
    SELECT surface, variant, uniqMerge(error_sessions) AS error_sessions
    FROM client_errors_hourly
    WHERE hour_start = toDateTime({hour:UInt32})
    GROUP BY surface, variant
  ) AS e ON e.surface = r.surface AND e.variant = r.variant
  FORMAT JSONEachRow
`;

export function clickhouseRewards(query: ClickHouseQuery): RewardRepository {
  return {
    async rewards(hourStart: number): Promise<readonly VariantReward[]> {
      const rows = await query(REWARDS_SQL, { hour: Math.floor(hourStart / 1000) }, RewardRow);

      return rows.map((row) => ({
        surfaceId: row.surface,
        variantId: row.variant,
        components: {
          impressions: row.impressions,
          signups: row.signups,
          engagedSessions: row.engaged_sessions,
          scrollNormSum: row.scroll_norm_sum,
          returns: row.returns,
          shares: row.shares,
          bounces: row.bounces,
        },
      }));
    },

    async health(hourStart: number): Promise<readonly VariantHealth[]> {
      const rows = await query(HEALTH_SQL, { hour: Math.floor(hourStart / 1000) }, HealthRow);

      return rows.map((row) => ({
        surfaceId: row.surface,
        variantId: row.variant,
        samples: row.samples,
        p75LcpMs: row.p75_lcp_ms,
        p75Cls: row.p75_cls,
        p75InpMs: row.p75_inp_ms,
        clientErrorRate: row.client_error_rate,
        bounceRate: row.bounce_rate,
      }));
    },
  };
}
