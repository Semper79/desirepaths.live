/**
 * Thompson sampling over Beta posteriors.
 *
 * WHY THOMPSON AND NOT EPSILON-GREEDY OR UCB
 * Epsilon-greedy explores uniformly, which means it keeps spending the same traffic
 * on a variant it has already established is terrible. UCB explores deterministically,
 * which on a site with real traffic means every visitor in a given context sees the
 * same "exploratory" variant at the same moment - a synchronised experiment that is
 * maximally visible and maximally weird.
 *
 * Thompson sampling explores in proportion to the probability that a variant is
 * actually the best. It is Bayesian-optimal in the regret sense, it self-anneals
 * (exploration shrinks as evidence accumulates, without a schedule to tune), and it
 * randomises per visitor, so the site never looks like it is having an episode.
 *
 * The one thing it does badly is stopping. It will happily keep sending 2% of traffic
 * to a variant forever. That is what `guardrails.ts` is for.
 */

import type { Rng } from './rng';
import { betaCredibleInterval, betaMean, probabilityGreater } from './beta';

export interface Arm {
  readonly variantId: string;
  readonly alpha: number;
  readonly beta: number;
  /** Real impressions, before novelty down-weighting. Used by the guardrails. */
  readonly impressions: number;
}

export interface ThompsonDraw {
  readonly variantId: string;
  /** The sampled value that won. Recorded so a surprising choice is explainable. */
  readonly sample: number;
}

/**
 * Draw one variant.
 *
 * Ties are broken by draw order, which is deterministic given the RNG seed. That is
 * deliberate: identical posteriors happen constantly at cold start, and a random
 * tiebreak would consume RNG state and desynchronise the sticky-assignment stream.
 */
export function sampleArm(arms: readonly Arm[], rng: Rng): ThompsonDraw {
  if (arms.length === 0) throw new RangeError('Cannot sample from an empty arm set.');

  let best = '';
  let bestSample = Number.NEGATIVE_INFINITY;

  for (const arm of arms) {
    const sample = rng.beta(arm.alpha, arm.beta);
    if (sample > bestSample) {
      bestSample = sample;
      best = arm.variantId;
    }
  }

  return { variantId: best, sample: bestSample };
}

export interface ArmSummaryStats {
  readonly variantId: string;
  readonly mean: number;
  readonly credibleInterval: readonly [number, number];
  readonly impressions: number;
  /** Probability this arm beats the current leader. The leader's own value is 1. */
  readonly probabilityBest: number;
}

/**
 * Summarise a surface's arms for the report and the admin console.
 *
 * `probabilityBest` is computed pairwise against the highest-mean arm rather than as
 * a true multi-arm probability. The exact multi-arm quantity needs a k-dimensional
 * integral or a Monte-Carlo estimate; the pairwise version is closed-form, stable
 * across report runs, and answers the question the operator is actually asking -
 * "should I be worried about the leader" - rather than a subtly different one.
 */
export function summarise(arms: readonly Arm[]): readonly ArmSummaryStats[] {
  if (arms.length === 0) return [];

  let leader = arms[0] as Arm;
  for (const arm of arms) {
    if (betaMean(arm.alpha, arm.beta) > betaMean(leader.alpha, leader.beta)) leader = arm;
  }

  return arms.map((arm) => ({
    variantId: arm.variantId,
    mean: betaMean(arm.alpha, arm.beta),
    credibleInterval: betaCredibleInterval(arm.alpha, arm.beta),
    impressions: arm.impressions,
    probabilityBest:
      arm.variantId === leader.variantId
        ? 1
        : probabilityGreater(arm.alpha, arm.beta, leader.alpha, leader.beta),
  }));
}

/** The arm with the highest posterior mean. Used for the champion and the holdout. */
export function leaderOf(arms: readonly Arm[]): Arm {
  if (arms.length === 0) throw new RangeError('Cannot pick a leader from an empty arm set.');
  let leader = arms[0] as Arm;
  for (const arm of arms) {
    if (betaMean(arm.alpha, arm.beta) > betaMean(leader.alpha, leader.beta)) leader = arm;
  }
  return leader;
}
