/**
 * The statistical simulation harness.
 *
 * Section 7 requires "a statistical simulation harness proving the bandit converges on a
 * known-truth synthetic dataset". This is it, and the emphasis belongs on
 * *known-truth*: unit tests can show that a Beta update produces the arithmetic you
 * expected, but they cannot show that the assembled system finds the best variant.
 * Only running it against a world whose answer you already know can do that.
 *
 * What the harness measures:
 *   - cumulative regret, which must grow sublinearly (a bandit that does not learn
 *     has linear regret; that is the definition);
 *   - the share of traffic the best variant receives in the final phase, which must
 *     approach 1 minus the exploration floor and the holdout;
 *   - whether the identified champion is the true best variant;
 *   - realised lift over the non-adapting baseline, which is the same number the
 *     hourly report quotes in production, computed the same way.
 *
 * It is deterministic. Given a seed, the numbers are the numbers, every run, on
 * every machine. A convergence proof that changes between runs proves nothing.
 */

import { decide, DEFAULT_ASSIGNMENT_CONFIG, type AssignmentConfig } from '../assign';
import { createArm, decayArm, updateArm, type LinUcbArmState } from '../linucb';
import { createRng } from '../rng';
import type { Arm } from '../thompson';
import { betaMean } from '../beta';
import { decayPosterior } from '../reward';

export interface VariantTruth {
  readonly variantId: string;
  /** True expected reward per impression, per context bucket. */
  readonly rewardByBucket: Readonly<Record<string, number>>;
}

export interface SimulationSpec {
  readonly steps: number;
  readonly truth: readonly VariantTruth[];
  readonly buckets: readonly string[];
  readonly baselineVariantId: string;
  readonly seed: number;
  readonly config?: AssignmentConfig | undefined;
  /**
   * When set, the true reward of every variant is permuted at this step. A bandit
   * that has fully exploited will not notice; one with a live exploration floor
   * will recover. This is how the harness tests the floor rather than asserting it.
   */
  readonly shiftAtStep?: number | undefined;
  /**
   * Steps between exponential-forgetting cycles. In production this is the hourly
   * aggregation job; here it is a step count so the harness stays free of clocks.
   * Omit to disable forgetting entirely - which is what demonstrates why it exists.
   */
  readonly decayEvery?: number | undefined;
  readonly decayGamma?: number | undefined;
}

export interface SimulationResult {
  readonly steps: number;
  readonly cumulativeRegret: number;
  /** Regret over the final 20% of steps, divided by those steps. Should approach 0. */
  readonly terminalRegretRate: number;
  /** Share of the final 20% of non-holdout traffic that saw the true best variant. */
  readonly terminalBestShare: number;
  readonly championVariantId: string;
  readonly trueBestVariantId: string;
  readonly impressionsByVariant: Readonly<Record<string, number>>;
  readonly meanRewardAdaptive: number;
  readonly meanRewardHoldout: number;
  readonly relativeLift: number;
  readonly posteriors: readonly Arm[];
}

/** One-hot bucket encoding plus an intercept. Small on purpose - this is a test world. */
function featuresFor(buckets: readonly string[], bucket: string): readonly number[] {
  return [1, ...buckets.map((b) => (b === bucket ? 1 : 0))];
}

/** Average true reward of a variant across buckets, weighted uniformly. */
function marginalTruth(variant: VariantTruth, buckets: readonly string[]): number {
  const total = buckets.reduce((sum, b) => sum + (variant.rewardByBucket[b] ?? 0), 0);
  return total / buckets.length;
}

export function simulate(spec: SimulationSpec): SimulationResult {
  const config = spec.config ?? DEFAULT_ASSIGNMENT_CONFIG;
  const dim = 1 + spec.buckets.length;
  const rng = createRng(spec.seed);

  // Live truth, so `shiftAtStep` can rotate it mid-run.
  let truth = spec.truth.map((t) => ({ ...t, rewardByBucket: { ...t.rewardByBucket } }));

  const posteriors = new Map<string, { alpha: number; beta: number; impressions: number }>();
  const contextual = new Map<string, LinUcbArmState>();
  for (const t of spec.truth) {
    posteriors.set(t.variantId, { alpha: 1, beta: 1, impressions: 0 });
    contextual.set(t.variantId, createArm(dim));
  }

  const impressionsByVariant: Record<string, number> = {};
  for (const t of spec.truth) impressionsByVariant[t.variantId] = 0;

  let cumulativeRegret = 0;
  let terminalRegret = 0;
  let terminalBestCount = 0;
  let terminalNonHoldout = 0;

  let adaptiveReward = 0;
  let adaptiveCount = 0;
  let holdoutReward = 0;
  let holdoutCount = 0;

  const terminalStart = Math.floor(spec.steps * 0.8);

  for (let step = 0; step < spec.steps; step += 1) {
    if (spec.shiftAtStep !== undefined && step === spec.shiftAtStep) {
      // Rotate the reward vectors between variants: the world changed, and the
      // previously best variant is now merely average.
      const rotated = truth.map((t, i) => ({
        variantId: t.variantId,
        rewardByBucket: (truth[(i + 1) % truth.length] as VariantTruth).rewardByBucket,
      }));
      truth = rotated;
    }

    // Exponential forgetting. Bounding the effective sample size is what lets the
    // learner act on a change rather than merely observe one.
    if (spec.decayEvery !== undefined && step > 0 && step % spec.decayEvery === 0) {
      const gamma = spec.decayGamma ?? 0.9;
      for (const t of spec.truth) {
        const p = posteriors.get(t.variantId) as {
          alpha: number;
          beta: number;
          impressions: number;
        };
        const decayed = decayPosterior(p, { alpha: 1, beta: 1 }, gamma);
        p.alpha = decayed.alpha;
        p.beta = decayed.beta;
        contextual.set(t.variantId, decayArm(contextual.get(t.variantId) as LinUcbArmState, gamma));
      }
    }

    const bucket = spec.buckets[rng.nextInt(spec.buckets.length)] as string;
    const features = featuresFor(spec.buckets, bucket);
    const anonId = `sim-${String(step)}`;

    const arms: Arm[] = truth.map((t) => {
      const p = posteriors.get(t.variantId) as { alpha: number; beta: number; impressions: number };
      return {
        variantId: t.variantId,
        alpha: p.alpha,
        beta: p.beta,
        impressions: p.impressions,
      };
    });

    const decision = decide({
      anonId,
      surfaceId: 'sim.surface',
      arms,
      baselineVariantId: spec.baselineVariantId,
      features,
      contextualArms: contextual,
      adaptationEnabled: true,
      consentGranted: true,
      config,
    });

    const chosen = truth.find((t) => t.variantId === decision.variantId) as VariantTruth;
    const chosenRate = chosen.rewardByBucket[bucket] ?? 0;
    const bestRate = Math.max(...truth.map((t) => t.rewardByBucket[bucket] ?? 0));

    // Bernoulli realisation of the composite reward. The real system observes a
    // continuous reward in [0, 1]; a Bernoulli draw is the harder case for the
    // learner (maximum variance for a given mean), so convergence here implies
    // convergence there.
    const reward = rng.next() < chosenRate ? 1 : 0;

    const p = posteriors.get(decision.variantId) as {
      alpha: number;
      beta: number;
      impressions: number;
    };
    p.alpha += reward;
    p.beta += 1 - reward;
    p.impressions += 1;
    impressionsByVariant[decision.variantId] = (impressionsByVariant[decision.variantId] ?? 0) + 1;

    const arm = contextual.get(decision.variantId) as LinUcbArmState;
    contextual.set(decision.variantId, updateArm(arm, features, reward));

    const regret = bestRate - chosenRate;
    cumulativeRegret += regret;

    if (decision.isHoldout) {
      holdoutReward += reward;
      holdoutCount += 1;
    } else {
      adaptiveReward += reward;
      adaptiveCount += 1;
    }

    if (step >= terminalStart) {
      terminalRegret += regret;
      if (!decision.isHoldout) {
        terminalNonHoldout += 1;
        const trueBestHere = truth.reduce((bestSoFar, t) =>
          (t.rewardByBucket[bucket] ?? 0) > (bestSoFar.rewardByBucket[bucket] ?? 0) ? t : bestSoFar,
        );
        if (decision.variantId === trueBestHere.variantId) terminalBestCount += 1;
      }
    }
  }

  const finalArms: Arm[] = truth.map((t) => {
    const p = posteriors.get(t.variantId) as { alpha: number; beta: number; impressions: number };
    return { variantId: t.variantId, alpha: p.alpha, beta: p.beta, impressions: p.impressions };
  });

  const champion = finalArms.reduce((best, arm) =>
    betaMean(arm.alpha, arm.beta) > betaMean(best.alpha, best.beta) ? arm : best,
  );

  const trueBest = truth.reduce((best, t) =>
    marginalTruth(t, spec.buckets) > marginalTruth(best, spec.buckets) ? t : best,
  );

  const meanRewardAdaptive = adaptiveCount > 0 ? adaptiveReward / adaptiveCount : 0;
  const meanRewardHoldout = holdoutCount > 0 ? holdoutReward / holdoutCount : 0;

  return {
    steps: spec.steps,
    cumulativeRegret,
    terminalRegretRate: terminalRegret / Math.max(1, spec.steps - terminalStart),
    terminalBestShare: terminalNonHoldout > 0 ? terminalBestCount / terminalNonHoldout : 0,
    championVariantId: champion.variantId,
    trueBestVariantId: trueBest.variantId,
    impressionsByVariant,
    meanRewardAdaptive,
    meanRewardHoldout,
    relativeLift:
      meanRewardHoldout > 0 ? (meanRewardAdaptive - meanRewardHoldout) / meanRewardHoldout : 0,
    posteriors: finalArms,
  };
}

/**
 * A standard three-arm world with a context effect: variant B is best on `phone`,
 * variant C is best on `desktop`, and variant A is mediocre everywhere. A
 * context-blind learner converges to whichever of B or C is better on average and
 * leaves the rest on the table; a contextual one takes both.
 */
export const STANDARD_WORLD: SimulationSpec = {
  steps: 20_000,
  seed: 20260824,
  decayEvery: 500,
  decayGamma: 0.9,
  buckets: ['phone', 'desktop'],
  baselineVariantId: 'sim#a',
  truth: [
    { variantId: 'sim#a', rewardByBucket: { phone: 0.05, desktop: 0.05 } },
    { variantId: 'sim#b', rewardByBucket: { phone: 0.12, desktop: 0.06 } },
    { variantId: 'sim#c', rewardByBucket: { phone: 0.04, desktop: 0.14 } },
  ],
};
