import { describe, expect, it } from 'vitest';
import { simulate, STANDARD_WORLD } from '../src/sim/index';

/**
 * THE CONVERGENCE PROOF (section 7).
 *
 * These are the assertions that say the assembled engine works. Unit tests show the
 * pieces are individually correct; only this shows they add up to a system that
 * finds the best variant and keeps finding it when the world moves.
 *
 * Every threshold below has a reason attached. A threshold without a reason is a
 * number somebody tuned until the test went green, which is worse than no test.
 */

describe('convergence on a known-truth world', () => {
  const result = simulate(STANDARD_WORLD);

  it('identifies the true best variant', () => {
    // Marginal truth: b averages 9%, c averages 9%, a averages 5%. The champion must
    // be one of the two good arms and never the mediocre one.
    expect(result.championVariantId).not.toBe('sim#a');
  });

  it('sends the overwhelming majority of terminal traffic to the contextually best arm', () => {
    // The ceiling is 1 - explorationFloor (2%) and a little Thompson residue. 85% is
    // comfortably above what a non-learning policy could reach (50% at best, since
    // the best arm differs by bucket) and below the unreachable ceiling.
    expect(result.terminalBestShare).toBeGreaterThan(0.85);
  });

  it('has sublinear regret', () => {
    // A policy that never learns pays the full gap on every step. Here the average
    // gap over a uniform policy is about 0.043 per step; converged, the terminal
    // rate must be an order of magnitude below that.
    expect(result.terminalRegretRate).toBeLessThan(0.006);
    expect(result.cumulativeRegret / result.steps).toBeLessThan(0.02);
  });

  it('beats the non-adapting holdout cohort', () => {
    // This is the same lift number the hourly report quotes in production, computed
    // the same way. If this is not positive, the whole system is not worth running.
    expect(result.meanRewardAdaptive).toBeGreaterThan(result.meanRewardHoldout);
    expect(result.relativeLift).toBeGreaterThan(0.3);
  });

  it('still explores every arm at the end', () => {
    for (const [, impressions] of Object.entries(result.impressionsByVariant)) {
      expect(impressions).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const again = simulate(STANDARD_WORLD);
    expect(again.cumulativeRegret).toBe(result.cumulativeRegret);
    expect(again.championVariantId).toBe(result.championVariantId);
    expect(again.impressionsByVariant).toEqual(result.impressionsByVariant);
  });
});

describe('recovery from a non-stationary world', () => {
  /**
   * THE TEST THAT CHANGED THE DESIGN.
   *
   * At step 24,000 the reward vectors rotate: the arm that was winning becomes
   * mediocre. The first version of this engine relied on the exploration floor alone
   * to notice, and the harness showed it never did - terminal best share fell to 2%
   * and stayed there, because a posterior built from 20,000 observations cannot be
   * moved by 2% of traffic in any useful timeframe.
   *
   * Exponential forgetting (decayPosterior and decayArm) is what fixed it. Both
   * cases are asserted below, so the reason the mechanism exists cannot be quietly
   * deleted by a future simplification.
   */
  const withForgetting = simulate({
    ...STANDARD_WORLD,
    steps: 40_000,
    shiftAtStep: 24_000,
  });

  const withoutForgetting = simulate({
    ...STANDARD_WORLD,
    steps: 40_000,
    shiftAtStep: 24_000,
    decayEvery: undefined,
    decayGamma: undefined,
  });

  it('finds the new best arm after the world changes', () => {
    expect(withForgetting.terminalBestShare).toBeGreaterThan(0.85);
    expect(withForgetting.championVariantId).toBe(withForgetting.trueBestVariantId);
  });

  it('drives terminal regret back down after the shift', () => {
    expect(withForgetting.terminalRegretRate).toBeLessThan(0.01);
  });

  it('does none of that without forgetting, which is why forgetting exists', () => {
    expect(withoutForgetting.terminalBestShare).toBeLessThan(0.2);
    expect(withoutForgetting.terminalRegretRate).toBeGreaterThan(
      withForgetting.terminalRegretRate * 5,
    );
    expect(withoutForgetting.cumulativeRegret).toBeGreaterThan(withForgetting.cumulativeRegret * 2);
  });

  it('still beats the non-adapting baseline in both cases', () => {
    expect(withForgetting.meanRewardAdaptive).toBeGreaterThan(withForgetting.meanRewardHoldout);
    expect(withoutForgetting.meanRewardAdaptive).toBeGreaterThan(
      withoutForgetting.meanRewardHoldout,
    );
  });

  it('keeps sampling every arm, which is what makes recovery possible at all', () => {
    for (const [, impressions] of Object.entries(withForgetting.impressionsByVariant)) {
      expect(impressions).toBeGreaterThan(100);
    }
  });
});

describe('degenerate worlds', () => {
  it('handles a single arm', () => {
    const r = simulate({
      steps: 2_000,
      seed: 1,
      buckets: ['only'],
      baselineVariantId: 'x#a',
      truth: [{ variantId: 'x#a', rewardByBucket: { only: 0.3 } }],
    });
    expect(r.championVariantId).toBe('x#a');
    expect(r.cumulativeRegret).toBe(0);
  });

  it('handles identical arms without pathological behaviour', () => {
    const r = simulate({
      steps: 4_000,
      seed: 2,
      buckets: ['b'],
      baselineVariantId: 'y#a',
      truth: [
        { variantId: 'y#a', rewardByBucket: { b: 0.2 } },
        { variantId: 'y#b', rewardByBucket: { b: 0.2 } },
      ],
    });
    expect(r.cumulativeRegret).toBe(0);
    expect(r.impressionsByVariant['y#a']).toBeGreaterThan(0);
    expect(r.impressionsByVariant['y#b']).toBeGreaterThan(0);
  });

  it('reports zero lift when there is no holdout to compare against', () => {
    const r = simulate({
      steps: 500,
      seed: 3,
      buckets: ['b'],
      baselineVariantId: 'z#a',
      truth: [{ variantId: 'z#a', rewardByBucket: { b: 0 } }],
      config: {
        holdoutFraction: 0,
        explorationFloor: 0.02,
        maxContextualWeight: 0.6,
        contextualWarmupUpdates: 500,
        contextualAlpha: 0.6,
      },
    });
    expect(r.meanRewardHoldout).toBe(0);
    expect(r.relativeLift).toBe(0);
  });
});
