/**
 * The report's reads from ClickHouse.
 *
 * Every query here is issued twice per report — once for the hour being reported and once
 * for the same hour last week — because that is the only comparison the report makes
 * (§5, and the reasoning is in `lib/report-derive.ts`). Writing them as "one hour, by
 * timestamp" rather than "this hour vs last hour" is what makes that possible without a
 * second set of queries.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE. These need a live ClickHouse with the aggregates
 * loaded. What is testable — the parsing, and every number derived from these rows —
 * lives in `parseRows` and `lib/report-derive.ts`, which are covered. Each function here
 * is a query and a shape conversion with no branch in it, which is what makes that
 * acceptable rather than merely convenient.
 */

import { z } from 'zod';
import type {
  AnomalyFacts,
  FunnelFacts,
  LabelledCount,
  MetricsRepository,
  ProviderFacts,
  RewardFacts,
  TrafficFacts,
} from '../ports';

export interface ClickHouseQuery {
  /** Runs a query and returns the JSONEachRow body, unparsed. */
  <T>(
    sql: string,
    params: Readonly<Record<string, string | number>>,
    schema: z.ZodType<T>,
  ): Promise<readonly T[]>;
}

const num = z.coerce.number();

const TrafficRow = z.object({
  sessions: num,
  uniques: num,
  pageviews: num,
  new_visitors: num,
  returning_visitors: num,
});

const Labelled = z.object({ label: z.string(), value: num });
const StepRow = z.object({ step: z.string(), sessions: num });
const ProviderRow = z.object({ provider: z.string(), signups: num, starts: num });

const RewardRow = z.object({
  is_holdout: num,
  reward: num,
  impressions: num,
});

const AnomalyRow = z.object({
  mean_sessions: num,
  sd_sessions: num,
  weeks_observed: num,
});

/**
 * The hour's totals.
 *
 * `uniqMerge` rather than a count: `traffic_hourly` stores HyperLogLog states so that
 * "uniques this hour" and "uniques this week" come from the same rows without
 * double-counting a visitor who spanned two hours.
 */
const TRAFFIC_SQL = `
  SELECT
      uniqMerge(sessions)                                    AS sessions,
      uniqMerge(uniques)                                     AS uniques,
      sumMerge(pageviews)                                    AS pageviews,
      uniqMergeIf(sessions, is_returning = 0)                AS new_visitors,
      uniqMergeIf(sessions, is_returning = 1)                AS returning_visitors
  FROM traffic_hourly
  WHERE hour_start = toDateTime({hour:UInt32})
  FORMAT JSONEachRow
`;

const BREAKDOWN_SQL = (column: string): string => `
  SELECT
      ${column}                 AS label,
      uniqMerge(sessions)       AS value
  FROM traffic_hourly
  WHERE hour_start = toDateTime({hour:UInt32})
  GROUP BY label
  ORDER BY value DESC
  LIMIT 20
  FORMAT JSONEachRow
`;

const FUNNEL_SQL = `
  SELECT step, uniqMerge(sessions) AS sessions
  FROM funnel_hourly
  WHERE hour_start = toDateTime({hour:UInt32})
  GROUP BY step
  FORMAT JSONEachRow
`;

/**
 * Sign-ups by provider.
 *
 * The denominator is `signup_start` for the same provider, not all traffic: "of the people
 * who chose Google, how many finished" is a fact about the provider, whereas "of all
 * visitors, how many signed up with Google" is mostly a fact about where the button was —
 * and where the button is is the surface the bandit is already optimising.
 */
const PROVIDER_SQL = `
  SELECT
      provider,
      uniqMergeIf(sessions, step = 'signup_complete') AS signups,
      uniqMergeIf(sessions, step = 'signup_start')    AS starts
  FROM funnel_hourly
  WHERE hour_start = toDateTime({hour:UInt32}) AND provider != ''
  GROUP BY provider
  ORDER BY signups DESC
  FORMAT JSONEachRow
`;

const REWARD_SQL = `
  SELECT
      is_holdout,
      sum(signups + engaged_sessions + scroll_norm_sum + returns + shares) AS reward,
      sum(impressions)                                                     AS impressions
  FROM surface_rewards_hourly
  WHERE hour_start >= toDateTime({from:UInt32}) AND hour_start < toDateTime({to:UInt32})
  GROUP BY is_holdout
  FORMAT JSONEachRow
`;

const ANOMALY_SQL = `
  SELECT mean_pageviews AS mean_sessions, sd_pageviews AS sd_sessions, weeks_observed
  FROM anomaly_profile_v
  WHERE hour_of_week = {hourOfWeek:UInt8}
  FORMAT JSONEachRow
`;

const seconds = (ms: number): number => Math.floor(ms / 1000);

/** Matches `anomaly_profile_v`: `toHour(h) + 24 * toDayOfWeek(h)`, Monday = 1. */
function hourOfWeekFor(hourStart: number): number {
  const at = new Date(hourStart);
  const day = at.getUTCDay();
  return at.getUTCHours() + 24 * (day === 0 ? 7 : day);
}

export function clickhouseMetrics(query: ClickHouseQuery): MetricsRepository {
  const rewardBetween = async (from: number, to: number): Promise<RewardFacts> => {
    const rows = await query(REWARD_SQL, { from: seconds(from), to: seconds(to) }, RewardRow);

    const pick = (holdout: boolean) => rows.find((r) => (r.is_holdout === 1) === holdout);
    const adaptive = pick(false);
    const held = pick(true);

    return {
      adaptiveReward: adaptive?.reward ?? 0,
      adaptiveImpressions: adaptive?.impressions ?? 0,
      holdoutReward: held?.reward ?? 0,
      holdoutImpressions: held?.impressions ?? 0,
    };
  };

  return {
    async traffic(hourStart) {
      const hour = seconds(hourStart);

      const [totals, sources, countries, pages] = await Promise.all([
        query(TRAFFIC_SQL, { hour }, TrafficRow),
        query(BREAKDOWN_SQL('traffic_source'), { hour }, Labelled),
        query(BREAKDOWN_SQL('country'), { hour }, Labelled),
        query(BREAKDOWN_SQL('page_path'), { hour }, Labelled),
      ]);

      const row = totals[0];
      const asCounts = (rows: readonly z.infer<typeof Labelled>[]): readonly LabelledCount[] =>
        rows.map((r) => ({ label: r.label, value: r.value }));

      return {
        sessions: row?.sessions ?? 0,
        uniques: row?.uniques ?? 0,
        pageviews: row?.pageviews ?? 0,
        newVisitors: row?.new_visitors ?? 0,
        returningVisitors: row?.returning_visitors ?? 0,
        sources: asCounts(sources),
        countries: asCounts(countries),
        pages: asCounts(pages),
      } satisfies TrafficFacts;
    },

    async funnel(hourStart) {
      const rows = await query(FUNNEL_SQL, { hour: seconds(hourStart) }, StepRow);
      return Object.fromEntries(rows.map((r) => [r.step, r.sessions])) satisfies FunnelFacts;
    },

    async providers(hourStart) {
      const rows = await query(PROVIDER_SQL, { hour: seconds(hourStart) }, ProviderRow);
      return rows.map((r): ProviderFacts => ({
        provider: r.provider,
        signups: r.signups,
        starts: r.starts,
      }));
    },

    reward(hourStart) {
      return rewardBetween(hourStart, hourStart + 3_600_000);
    },

    rewardSince(from) {
      // Open-ended in practice: `to` is far enough ahead that no row is excluded, which is
      // simpler than a second query shape for the cumulative case.
      return rewardBetween(from, Date.now() + 3_600_000);
    },

    async anomalyProfile(hourStart) {
      const rows = await query(ANOMALY_SQL, { hourOfWeek: hourOfWeekFor(hourStart) }, AnomalyRow);
      const row = rows[0];

      return {
        meanSessions: row?.mean_sessions ?? 0,
        sdSessions: row?.sd_sessions ?? 0,
        weeksObserved: row?.weeks_observed ?? 0,
      } satisfies AnomalyFacts;
    },

    async ping() {
      try {
        await query('SELECT 1 AS one FORMAT JSONEachRow', {}, z.object({ one: num }));
        return true;
      } catch {
        // The health line is the report's own statement about whether its numbers are
        // trustworthy. A throw here would prevent the report that was about to say
        // "clickhouse is down" from being sent at all.
        return false;
      }
    },
  };
}
