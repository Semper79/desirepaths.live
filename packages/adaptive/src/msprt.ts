/**
 * Always-valid sequential testing (mSPRT).
 *
 * THE PROBLEM THIS SOLVES
 * A fixed-horizon p-value is only valid if you look once, at a sample size chosen in
 * advance. An adaptive system looks continuously - that is the entire point of it -
 * and under continuous looking a 0.05 threshold fires on pure noise with probability
 * approaching 1. An optimiser built on peeked p-values does not learn; it
 * confidently promotes whichever variant got lucky first, then promotes its
 * replacement, forever.
 *
 * THE FIX
 * The mixture sequential probability ratio test (Robbins 1970; Johari, Pekelis &
 * Walsh 2015) produces a p-value that is valid at *every* sample size simultaneously.
 * It is a likelihood ratio against H0 with the alternative integrated out under a
 * prior on the effect size, and the ratio is a non-negative martingale under H0.
 * Ville's inequality then gives P(sup_n Λ_n >= 1/α) <= α: you may stop whenever you
 * like, including immediately after a favourable observation, and the type-I error
 * still holds.
 *
 * THE PRICE
 * Always-valid tests need more samples than fixed-horizon tests for the same power -
 * typically 30-50% more. That is the honest cost of being allowed to look whenever
 * you want, and it is far cheaper than the alternative, which is a system that
 * cannot tell a real 3% lift from noise.
 *
 * CHOOSING TAU
 * `tau` is the prior standard deviation of the effect size, and it is a real
 * modelling decision, not a knob to tune until something is significant. Set it to
 * the smallest lift that would actually change what the operator does. Too small and
 * the test never fires; too large and it fires on effects too small to matter.
 * Default 0.05 = "a 5 percentage-point change in the composite reward is the kind of
 * thing worth acting on".
 */

import { clamp01 } from './math';

export interface ArmSummary {
  /** Number of impressions. */
  readonly n: number;
  /** Mean reward per impression, in [0, 1]. */
  readonly mean: number;
  /**
   * Variance of the per-impression reward. For a bounded [0, 1] reward the Bernoulli
   * variance p(1-p) is an upper bound and a good enough estimate; the caller may
   * supply the empirical variance when it has one.
   */
  readonly variance: number;
}

export interface MsprtResult {
  /** The mixture likelihood ratio. Larger means more evidence against "no difference". */
  readonly lambda: number;
  /** Always-valid p-value at this sample size, in [0, 1]. */
  readonly pValue: number;
  /** True when the evidence has crossed the 1/alpha threshold. */
  readonly crossed: boolean;
  /** Observed difference treatment - control, in reward units. */
  readonly delta: number;
  /** Standard error of `delta`. */
  readonly standardError: number;
}

/** Bernoulli-bound variance for a reward known to live in [0, 1]. */
export function boundedVariance(mean: number): number {
  const m = clamp01(mean);
  return m * (1 - m);
}

const NOT_DECIDED: MsprtResult = {
  lambda: 1,
  pValue: 1,
  crossed: false,
  delta: 0,
  standardError: Number.POSITIVE_INFINITY,
};

/**
 * One evaluation of the mixture SPRT for a two-sample difference of means.
 *
 * Model: delta_hat ~ Normal(theta, V) with V = var_c/n_c + var_t/n_t, tested against
 * H0: theta = 0 with the alternative mixed over Normal(0, tau^2). The mixture ratio
 * has a closed form:
 *
 *     Lambda = sqrt(V / (V + tau^2)) * exp( tau^2 * delta^2 / (2 V (V + tau^2)) )
 *
 * The normal approximation to the sampling distribution of the mean is doing work
 * here. It is sound at the sample sizes where a decision is actually taken - the
 * minimum-sample guardrail (1,000 impressions by default) is well past where the CLT
 * has bitten - and it is the same approximation every commercial sequential-testing
 * implementation makes.
 */
export function msprt(
  control: ArmSummary,
  treatment: ArmSummary,
  tau = 0.05,
  alpha = 0.05,
): MsprtResult {
  if (control.n <= 0 || treatment.n <= 0) return NOT_DECIDED;
  if (!(tau > 0)) throw new RangeError(`tau must be positive, got ${String(tau)}`);
  if (!(alpha > 0 && alpha < 1))
    throw new RangeError(`alpha must be in (0, 1), got ${String(alpha)}`);

  const v = control.variance / control.n + treatment.variance / treatment.n;

  // Zero variance means both arms are pinned at the same constant reward - typically
  // both at exactly 0 conversions. There is no evidence of a difference to find, and
  // dividing by V would manufacture infinite confidence out of nothing.
  if (v <= 0) return NOT_DECIDED;

  const delta = treatment.mean - control.mean;
  const tau2 = tau * tau;

  const lambda =
    Math.sqrt(v / (v + tau2)) * Math.exp((tau2 * delta * delta) / (2 * v * (v + tau2)));

  const pValue = Math.min(1, 1 / lambda);

  return {
    lambda,
    pValue,
    crossed: lambda >= 1 / alpha,
    delta,
    standardError: Math.sqrt(v),
  };
}

/**
 * Running state for a sequential test.
 *
 * The always-valid p-value is the *running minimum* of the per-look p-values, not
 * the latest one. Reporting the latest would let a p-value that already crossed drift
 * back above the threshold and re-cross later, which is peeking through the back door.
 */
export interface SequentialState {
  readonly minPValue: number;
  readonly crossedAt: number | null;
  readonly looks: number;
}

export const INITIAL_SEQUENTIAL_STATE: SequentialState = {
  minPValue: 1,
  crossedAt: null,
  looks: 0,
};

export function updateSequential(
  state: SequentialState,
  result: MsprtResult,
  sampleSize: number,
  alpha = 0.05,
): SequentialState {
  const minPValue = Math.min(state.minPValue, result.pValue);
  const crossedAt = state.crossedAt ?? (minPValue <= alpha ? sampleSize : null);
  return { minPValue, crossedAt, looks: state.looks + 1 };
}

/**
 * Plain-English rendering of a sequential result, for the Telegram report.
 *
 * The report is read on a phone by one person who needs to decide whether to
 * intervene. "p = 0.031" tells them nothing they can act on; "94% probability of
 * being worse than the leader over 3.1k impressions" tells them everything.
 */
export function explainSequential(
  result: MsprtResult,
  probabilityWorse: number,
  impressions: number,
): string {
  const pct = Math.round(probabilityWorse * 100);
  const impressionsLabel =
    impressions >= 1000 ? `${(impressions / 1000).toFixed(1)}k` : String(impressions);

  if (!result.crossed) {
    return `${String(pct)}% probability of being worse than the leader over ${impressionsLabel} impressions - not yet conclusive.`;
  }
  const direction = result.delta < 0 ? 'worse' : 'better';
  return `${String(pct)}% probability of being worse than the leader over ${impressionsLabel} impressions; sequential test concluded ${direction} (always-valid p = ${result.pValue.toFixed(3)}).`;
}
