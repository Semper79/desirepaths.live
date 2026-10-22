/**
 * Guardrails on the optimiser itself (section 2.2).
 *
 * An unconstrained optimiser is not an asset. Left alone it will find the variant
 * that maximises the metric it was given, and the metric is always a proxy: it will
 * ship a dark pattern that lifts sign-ups and craters trust, it will retire a good
 * variant on a lucky Tuesday, and it will let exploration decay to zero right before
 * the thing it learned stops being true.
 *
 * Everything in this file exists to make one of those failures impossible rather
 * than unlikely. None of these checks is optional, and none of them has a bypass
 * flag - a flag would be used at 2am during an incident by someone who did not read
 * this comment.
 */

import { probabilityWorseThan } from './beta';
import { boundedVariance, msprt, type MsprtResult } from './msprt';
import type { Rng } from './rng';
import { unitHash } from './rng';
import type { Arm } from './thompson';

// -----------------------------------------------------------------------------
// Holdout
// -----------------------------------------------------------------------------

/**
 * Is this visitor in the pinned baseline cohort?
 *
 * WHY A HOLDOUT AT ALL
 * Every individual A/B comparison the engine runs is measured against the current
 * champion, so the whole system can drift somewhere worse while every single
 * comparison it makes reports a win. The only defence is a cohort that never
 * adapts. The lift of the adaptive system as a whole against that cohort is the
 * number that proves the system is worth running - it is section 5.7 of the hourly
 * report, and if it ever goes negative the correct response is to turn the optimiser
 * off, not to tune it.
 *
 * The namespace prefix is load-bearing: deriving holdout membership from an
 * unprefixed hash of the same id used for sticky assignment would correlate the two,
 * and the holdout would systematically land on particular variant slots.
 */
export function isHoldout(anonId: string, fraction: number): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  return unitHash(`holdout:${anonId}`) < fraction;
}

// -----------------------------------------------------------------------------
// Exploration floor
// -----------------------------------------------------------------------------

/**
 * Should this decision be a forced exploration?
 *
 * Thompson sampling anneals towards exploitation as evidence accumulates, which is
 * correct under a stationary world. The world is not stationary: audiences change,
 * seasons change, a variant that was terrible in January is the obvious winner in
 * June. Without a floor, a surface that converged in week two never discovers that.
 *
 * The floor is small - 2% by default - because it is insurance, not a strategy.
 */
export function shouldForceExplore(rng: Rng, floor: number): boolean {
  if (floor <= 0) return false;
  return rng.next() < floor;
}

/** Uniform choice among eligible arms, used when exploration is forced. */
export function uniformChoice(arms: readonly Arm[], rng: Rng): Arm {
  if (arms.length === 0) throw new RangeError('Cannot choose from an empty arm set.');
  return arms[rng.nextInt(arms.length)] as Arm;
}

// -----------------------------------------------------------------------------
// Retirement
// -----------------------------------------------------------------------------

export interface RetirementConfig {
  readonly minImpressionsBeforeRetire: number;
  readonly msprtAlpha: number;
  readonly msprtTau: number;
  /** Posterior probability of being worse that must be reached, in addition to mSPRT. */
  readonly probabilityWorseThreshold: number;
}

export const DEFAULT_RETIREMENT_CONFIG: RetirementConfig = {
  minImpressionsBeforeRetire: 1_000,
  msprtAlpha: 0.05,
  msprtTau: 0.05,
  probabilityWorseThreshold: 0.95,
};

export interface RetirementVerdict {
  readonly retire: boolean;
  /** Machine-readable reason code, for the adaptation log. */
  readonly code:
    | 'retired'
    | 'is_baseline'
    | 'insufficient_samples'
    | 'not_conclusive'
    | 'not_worse'
    | 'is_leader';
  readonly probabilityWorse: number;
  readonly test: MsprtResult;
}

/**
 * Decide whether a candidate should be retired in favour of the leader.
 *
 * Two independent conditions must both hold, and that redundancy is intentional.
 * The mSPRT controls the false-positive rate under continuous looking; the posterior
 * probability threshold is a statement about effect size in the units the operator
 * actually cares about. A result can cross the sequential threshold on a difference
 * too small to matter, and a large posterior gap can appear on too little data. Each
 * check covers the other's blind spot.
 */
export function evaluateRetirement(
  candidate: Arm,
  leader: Arm,
  isBaseline: boolean,
  config: RetirementConfig = DEFAULT_RETIREMENT_CONFIG,
): RetirementVerdict {
  const test = msprt(
    {
      n: Math.max(1, leader.impressions),
      mean: leader.alpha / (leader.alpha + leader.beta),
      variance: boundedVariance(leader.alpha / (leader.alpha + leader.beta)),
    },
    {
      n: Math.max(1, candidate.impressions),
      mean: candidate.alpha / (candidate.alpha + candidate.beta),
      variance: boundedVariance(candidate.alpha / (candidate.alpha + candidate.beta)),
    },
    config.msprtTau,
    config.msprtAlpha,
  );

  const probabilityWorse = probabilityWorseThan(candidate, leader);

  // The baseline is never retired. It is what the holdout cohort sees and what every
  // surface falls back to when everything else is quarantined; retiring it would
  // leave 5% of traffic with nothing to render and destroy the lift measurement.
  if (isBaseline) return { retire: false, code: 'is_baseline', probabilityWorse, test };

  if (candidate.variantId === leader.variantId) {
    return { retire: false, code: 'is_leader', probabilityWorse, test };
  }

  if (candidate.impressions < config.minImpressionsBeforeRetire) {
    return { retire: false, code: 'insufficient_samples', probabilityWorse, test };
  }

  if (!test.crossed) return { retire: false, code: 'not_conclusive', probabilityWorse, test };

  if (probabilityWorse < config.probabilityWorseThreshold) {
    return { retire: false, code: 'not_worse', probabilityWorse, test };
  }

  return { retire: true, code: 'retired', probabilityWorse, test };
}

// -----------------------------------------------------------------------------
// Automatic rollback
// -----------------------------------------------------------------------------

export interface HealthSample {
  readonly variantId: string;
  readonly samples: number;
  readonly p75LcpMs: number;
  readonly p75Cls: number;
  readonly p75InpMs: number;
  readonly clientErrorRate: number;
  readonly bounceRate: number;
}

export interface RollbackThresholds {
  readonly maxLcpMs: number;
  readonly maxCls: number;
  readonly maxInpMs: number;
  readonly maxBounceRateDelta: number;
  readonly maxClientErrorRate: number;
  readonly minSamples: number;
}

export interface HealthVerdict {
  readonly quarantine: boolean;
  /** One human-readable line per breach, verbatim for the Telegram alert. */
  readonly breaches: readonly string[];
}

/**
 * Quarantine a variant that is measurably harming the experience.
 *
 * This runs on a different signal from the reward, and that separation is the point.
 * A variant that tanks Largest Contentful Paint may still convert well in the short
 * window before anyone notices - the reward would keep it, and users would leave.
 * Core Web Vitals, client errors and bounce rate are checked directly, against
 * absolute budgets and against the champion, and a breach quarantines immediately
 * rather than waiting for the statistics to agree.
 *
 * `minSamples` prevents twitchiness: three unlucky measurements on a slow phone must
 * not remove a good variant.
 */
export function evaluateHealth(
  sample: HealthSample,
  championBounceRate: number,
  thresholds: RollbackThresholds,
): HealthVerdict {
  if (sample.samples < thresholds.minSamples) return { quarantine: false, breaches: [] };

  const breaches: string[] = [];

  if (sample.p75LcpMs > thresholds.maxLcpMs) {
    breaches.push(
      `LCP p75 ${String(Math.round(sample.p75LcpMs))}ms exceeds the ${String(thresholds.maxLcpMs)}ms budget.`,
    );
  }
  if (sample.p75Cls > thresholds.maxCls) {
    breaches.push(
      `CLS p75 ${sample.p75Cls.toFixed(3)} exceeds the ${thresholds.maxCls.toFixed(3)} budget.`,
    );
  }
  if (sample.p75InpMs > thresholds.maxInpMs) {
    breaches.push(
      `INP p75 ${String(Math.round(sample.p75InpMs))}ms exceeds the ${String(thresholds.maxInpMs)}ms budget.`,
    );
  }
  if (sample.clientErrorRate > thresholds.maxClientErrorRate) {
    breaches.push(
      `Client error rate ${(sample.clientErrorRate * 100).toFixed(2)}% exceeds ${(thresholds.maxClientErrorRate * 100).toFixed(2)}%.`,
    );
  }
  if (sample.bounceRate - championBounceRate > thresholds.maxBounceRateDelta) {
    breaches.push(
      `Bounce rate is ${((sample.bounceRate - championBounceRate) * 100).toFixed(1)}pp worse than the champion.`,
    );
  }

  return { quarantine: breaches.length > 0, breaches };
}

// -----------------------------------------------------------------------------
// Holdout lift
// -----------------------------------------------------------------------------

export interface LiftResult {
  /** Relative lift of the adaptive cohort over the holdout, e.g. 0.18 = +18%. */
  readonly relative: number;
  /** Absolute difference in reward per impression. */
  readonly absolute: number;
  /** Always-valid p-value for "the adaptive system is not different from baseline". */
  readonly pValue: number;
  readonly conclusive: boolean;
  readonly adaptiveImpressions: number;
  readonly holdoutImpressions: number;
}

/**
 * Measured lift of the whole adaptive system against the pinned baseline cohort.
 *
 * Reported cumulatively and per hour (section 5.7). The same always-valid test is used
 * here as for individual variants, for the same reason: this number is looked at
 * every single hour, and a fixed-horizon p-value would be significant somewhere in
 * the first week no matter what.
 */
export function holdoutLift(
  adaptive: { readonly impressions: number; readonly rewardPerImpression: number },
  holdout: { readonly impressions: number; readonly rewardPerImpression: number },
  alpha = 0.05,
  tau = 0.02,
): LiftResult {
  const test = msprt(
    {
      n: Math.max(1, holdout.impressions),
      mean: holdout.rewardPerImpression,
      variance: boundedVariance(holdout.rewardPerImpression),
    },
    {
      n: Math.max(1, adaptive.impressions),
      mean: adaptive.rewardPerImpression,
      variance: boundedVariance(adaptive.rewardPerImpression),
    },
    tau,
    alpha,
  );

  const absolute = adaptive.rewardPerImpression - holdout.rewardPerImpression;
  // A zero-reward holdout makes relative lift undefined rather than infinite. Report
  // the absolute difference and let the operator read the absolute number.
  const relative = holdout.rewardPerImpression > 0 ? absolute / holdout.rewardPerImpression : 0;

  return {
    relative,
    absolute,
    pValue: test.pValue,
    conclusive: test.crossed,
    adaptiveImpressions: adaptive.impressions,
    holdoutImpressions: holdout.impressions,
  };
}
