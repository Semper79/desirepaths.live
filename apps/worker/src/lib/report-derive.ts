/**
 * Turning facts into the numbers the report states.
 *
 * Every derived value in the hourly report is computed here, and nowhere else. That is not
 * tidiness: §5 of the brief says a number in the report always came from `ReportInput`,
 * and the corollary is that a number in `ReportInput` has to have come from somewhere
 * defensible. A rate computed inline in a query, a delta computed in a template, and a
 * threshold hard-coded in an alert would each be a place where the report could quietly
 * start saying something different from what the data says.
 *
 * THE RULE THAT SHAPES ALL OF IT
 * Comparisons are against the same hour last week, never against last hour. A site with
 * daily and weekly seasonality has a 03:00 that is always quiet and a Sunday that is not a
 * Tuesday; "down 60% on last hour" at 09:00 on a Monday is a statement about breakfast.
 *
 * WHAT IT REFUSES TO COMPUTE
 * A delta against a zero baseline. There is no honest percentage change from nothing, and
 * every plausible convention — 0, 1, Infinity — reads as a fact in a sentence that a human
 * will then repeat. `deltaOrNull` returns null and the composer omits the comparison.
 */

import type { Alert, AlertSeverity, FunnelStep, ServiceHealth, TrafficRow } from '@morph/telegram';

// -----------------------------------------------------------------------------
// Comparisons
// -----------------------------------------------------------------------------

/**
 * Relative change, or `null` when there is nothing to compare against.
 *
 * A new page, a new country, a source that appeared this week: all have a zero baseline,
 * and all of them are the interesting rows. Reporting "+∞%" or "+100%" for them would put
 * a number in front of the operator that means "this is new" while looking like a
 * measurement.
 */
export function deltaOrNull(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return (current - baseline) / baseline;
}

/** The same, flattened to 0 for the fields the report type declares non-nullable. */
export function delta(current: number, baseline: number): number {
  return deltaOrNull(current, baseline) ?? 0;
}

export interface Counted {
  readonly label: string;
  readonly value: number;
}

/**
 * The top rows, with each one's change against the same hour last week.
 *
 * Ties break on the label so two sources with equal traffic order the same way on every
 * run — otherwise an operator comparing two consecutive reports sees a reshuffle that
 * means nothing.
 */
export function topRows(
  current: readonly Counted[],
  lastWeek: readonly Counted[],
  limit: number,
): readonly TrafficRow[] {
  const baseline = new Map(lastWeek.map((row) => [row.label, row.value]));

  return [...current]
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((row) => ({
      label: row.label,
      value: row.value,
      deltaVsLastWeek: delta(row.value, baseline.get(row.label) ?? 0),
    }));
}

// -----------------------------------------------------------------------------
// The funnel
// -----------------------------------------------------------------------------

/** The steps, in the order a visitor passes through them. */
export const FUNNEL_STEPS = [
  'land',
  'signup_view',
  'signup_start',
  'signup_complete',
  'activated',
] as const;

/**
 * Step-to-step conversion, not conversion from the top.
 *
 * Both are useful and only one of them localises a problem: a funnel reported against its
 * first step says "conversion is down" and a funnel reported step by step says which step
 * it is down at. The first step's conversion is 1 by definition rather than by division.
 */
export function funnelFrom(
  current: Readonly<Record<string, number>>,
  lastWeek: Readonly<Record<string, number>>,
): readonly FunnelStep[] {
  return FUNNEL_STEPS.map((step, index): FunnelStep => {
    const previous = index === 0 ? null : (FUNNEL_STEPS[index - 1] ?? null);
    const sessions = current[step] ?? 0;

    const conversion = (counts: Readonly<Record<string, number>>): number => {
      if (previous === null) return 1;
      const upstream = counts[previous] ?? 0;
      return upstream === 0 ? 0 : (counts[step] ?? 0) / upstream;
    };

    const stepConversion = conversion(current);

    return {
      step,
      sessions,
      stepConversion,
      // A difference in percentage points, not a relative change of a rate. "Conversion
      // fell 3 points" is a sentence about the funnel; "conversion fell 12%" is a sentence
      // about a percentage, and the two get confused every time.
      deltaVsLastWeek: stepConversion - conversion(lastWeek),
    };
  });
}

export function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

// -----------------------------------------------------------------------------
// Alerts
// -----------------------------------------------------------------------------

/**
 * How far this hour is from its own hour-of-week baseline before it is worth saying.
 *
 * Three standard deviations, which on a normal-ish distribution is roughly one false
 * alarm per 370 hours — about one a fortnight. Tighter would page the operator for
 * weather; looser would miss a real outage for hours.
 */
export const TRAFFIC_Z_THRESHOLD = 3;

/** Below this, the hour-of-week profile has not seen enough weeks to have an opinion. */
export const MIN_WEEKS_FOR_ANOMALY = 3;

export interface AnomalyInput {
  readonly sessions: number;
  readonly meanSessions: number;
  readonly sdSessions: number;
  readonly weeksObserved: number;
}

export interface AlertInput {
  readonly services: readonly ServiceHealth[];
  readonly anomaly: AnomalyInput;
  /** Hosts whose circuit breaker is open right now. */
  readonly brokenHosts: readonly string[];
  /** Drafts that have been waiting longer than a day. */
  readonly staleDrafts: number;
  /** Sources whose robots policy is older than its TTL, so they are not being fetched. */
  readonly staleRobots: number;
}

/**
 * What is worth waking somebody for.
 *
 * Ordered by severity, because the report prints them in order and the first line is the
 * one that gets read on a phone screen.
 */
export function alertsFrom(input: AlertInput): readonly Alert[] {
  const alerts: Alert[] = [];

  for (const service of input.services) {
    if (service.status === 'up') continue;

    alerts.push({
      severity: service.status === 'down' ? 'critical' : 'warning',
      title: `${service.name} is ${service.status}`,
      detail: service.detail ?? 'No detail available.',
    });
  }

  const z = anomalyZ(input.anomaly);
  if (z !== null && Math.abs(z) >= TRAFFIC_Z_THRESHOLD) {
    alerts.push({
      severity: z < 0 ? 'critical' : 'info',
      title: z < 0 ? 'Traffic is far below normal for this hour' : 'Traffic is far above normal',
      detail: `${String(input.anomaly.sessions)} sessions against a typical ${input.anomaly.meanSessions.toFixed(0)} for this hour of the week (${z.toFixed(1)}σ).`,
    });
  }

  if (input.brokenHosts.length > 0) {
    alerts.push({
      severity: 'warning',
      title: `${String(input.brokenHosts.length)} host${input.brokenHosts.length === 1 ? '' : 's'} cut off after repeated failures`,
      detail: input.brokenHosts.slice(0, 5).join(', '),
    });
  }

  if (input.staleRobots > 0) {
    alerts.push({
      severity: 'warning',
      title: `${String(input.staleRobots)} sources are not being fetched`,
      detail:
        'Their robots policy is older than its TTL, so the crawler is refusing them until it can re-read it. That is the compliance rule working, but a persistent count means a host is unreachable.',
    });
  }

  if (input.staleDrafts > 0) {
    alerts.push({
      severity: 'info',
      title: `${String(input.staleDrafts)} drafts have been waiting over a day`,
      detail: 'Nothing publishes without a decision, so the queue only moves when you do.',
    });
  }

  const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * How unusual this hour is, in standard deviations.
 *
 * `null` when the profile cannot support the question: too few weeks, or a baseline with
 * no variance at all — which happens on a site so quiet that every week's 04:00 had
 * exactly zero sessions, and dividing by that would report the first visitor ever as an
 * infinite anomaly.
 */
export function anomalyZ(input: AnomalyInput): number | null {
  if (input.weeksObserved < MIN_WEEKS_FOR_ANOMALY) return null;
  if (input.sdSessions <= 0) return null;

  return (input.sessions - input.meanSessions) / input.sdSessions;
}

// -----------------------------------------------------------------------------
// The next hour
// -----------------------------------------------------------------------------

export interface IntentionInput {
  readonly documentsAwaitingEmbedding: number;
  readonly clustersAwaitingContent: number;
  readonly draftsAwaitingReview: number;
  readonly audienceVectorKnown: boolean;
  readonly staleDrafts: number;
  readonly brokenHosts: readonly string[];
}

/**
 * What the system intends to do, and what it cannot do without a person.
 *
 * The distinction is the point of the section. "Intentions" are things that will happen on
 * their own and need no reply; "needsOperator" is a list of things that will not happen
 * until somebody acts. Mixing them produces a report where every line looks like a request
 * and the operator stops reading any of them.
 */
export function intentionsFrom(input: IntentionInput): {
  readonly intentions: readonly string[];
  readonly needsOperator: readonly string[];
} {
  const intentions: string[] = [];
  const needsOperator: string[] = [];

  if (input.documentsAwaitingEmbedding > 0) {
    intentions.push(
      `Embed ${String(input.documentsAwaitingEmbedding)} documents fetched but not yet placed in the topic space.`,
    );
  }

  if (input.clustersAwaitingContent > 0) {
    intentions.push(
      `Consider ${String(input.clustersAwaitingContent)} scored topics for the next generation run.`,
    );
  }

  if (!input.audienceVectorKnown) {
    // Stated every hour until it stops being true: a scorer running on three of its four
    // signals is not broken, but it is not doing what the design says either, and that
    // should not become invisible through familiarity.
    intentions.push(
      'Score topics on three signals rather than four: there is not yet enough engagement to compute an audience vector.',
    );
  }

  if (input.draftsAwaitingReview > 0) {
    needsOperator.push(
      `${String(input.draftsAwaitingReview)} drafts are waiting in /queue. Nothing publishes without a decision.`,
    );
  }

  if (input.staleDrafts > 0) {
    needsOperator.push(
      `${String(input.staleDrafts)} of those have been waiting over a day and are going stale.`,
    );
  }

  if (input.brokenHosts.length > 0) {
    needsOperator.push(
      `${String(input.brokenHosts.length)} hosts are cut off. /resume once whatever was wrong with them is fixed.`,
    );
  }

  return { intentions, needsOperator };
}

// -----------------------------------------------------------------------------
// Holdout
// -----------------------------------------------------------------------------

export interface HoldoutInput {
  readonly adaptiveReward: number;
  readonly adaptiveImpressions: number;
  readonly holdoutReward: number;
  readonly holdoutImpressions: number;
  readonly cumulativeAdaptiveReward: number;
  readonly cumulativeAdaptiveImpressions: number;
  readonly cumulativeHoldoutReward: number;
  readonly cumulativeHoldoutImpressions: number;
  /** From the always-valid test in `@morph/adaptive`. */
  readonly pValue: number;
  readonly conclusive: boolean;
}

/**
 * The one number that answers "is any of this working".
 *
 * Reward per impression on the adapted cohort against the pinned baseline. The p-value
 * comes from the always-valid test rather than being computed here, because a
 * fixed-horizon p-value quoted in a report that is read every hour is exactly the mistake
 * §2 exists to avoid — see `msprt.ts`.
 */
export function holdoutFrom(input: HoldoutInput): {
  readonly hourLiftRelative: number;
  readonly cumulativeLiftRelative: number;
  readonly cumulativePValue: number;
  readonly conclusive: boolean;
  readonly adaptiveRewardPerImpression: number;
  readonly holdoutRewardPerImpression: number;
  readonly holdoutFraction: number;
} {
  const adaptive = rate(input.adaptiveReward, input.adaptiveImpressions);
  const holdout = rate(input.holdoutReward, input.holdoutImpressions);

  const cumulativeAdaptive = rate(
    input.cumulativeAdaptiveReward,
    input.cumulativeAdaptiveImpressions,
  );
  const cumulativeHoldout = rate(input.cumulativeHoldoutReward, input.cumulativeHoldoutImpressions);

  const total = input.adaptiveImpressions + input.holdoutImpressions;

  return {
    hourLiftRelative: delta(adaptive, holdout),
    cumulativeLiftRelative: delta(cumulativeAdaptive, cumulativeHoldout),
    cumulativePValue: input.pValue,
    conclusive: input.conclusive,
    adaptiveRewardPerImpression: adaptive,
    holdoutRewardPerImpression: holdout,
    holdoutFraction: rate(input.holdoutImpressions, total),
  };
}

// -----------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------

/** The hour a report covers: the one that has just finished, not the one in progress. */
export function hourStartFor(now: number): number {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start.getTime() - 3_600_000;
}

/** The same hour, one week earlier. The only baseline the report compares against. */
export function sameHourLastWeek(hourStart: number): number {
  return hourStart - 7 * 24 * 3_600_000;
}
