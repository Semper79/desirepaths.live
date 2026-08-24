import { describe, expect, it } from 'vitest';
import {
  addComponents,
  decayPosterior,
  effectiveMemoryCycles,
  compositeReward,
  EMPTY_COMPONENTS,
  foldPosterior,
  noveltyWeight,
  NOVELTY_FLOOR,
  type RewardComponents,
  type RewardWeights,
} from '../src/reward.js';

const WEIGHTS: RewardWeights = {
  signup: 0.4,
  meaningful_engagement: 0.25,
  scroll_depth_norm: 0.2,
  return_visit: 0.1,
  share: 0.05,
};

const components = (over: Partial<RewardComponents>): RewardComponents => ({
  ...EMPTY_COMPONENTS,
  ...over,
});

describe('compositeReward', () => {
  it('returns a zero result with no impressions', () => {
    const r = compositeReward(EMPTY_COMPONENTS, WEIGHTS, 0.15);
    expect(r.total).toBe(0);
    expect(r.perImpression).toBe(0);
    expect(r.breakdown.signup).toBe(0);
    expect(r.breakdown.bounce_penalty).toBe(0);
  });

  it('reproduces the weights from the specification', () => {
    // Everything happened on every impression: reward is the sum of the weights = 1.
    const r = compositeReward(
      components({
        impressions: 100,
        signups: 100,
        engagedSessions: 100,
        scrollNormSum: 100,
        returns: 100,
        shares: 100,
      }),
      WEIGHTS,
      0.15,
    );
    expect(r.perImpression).toBeCloseTo(1, 12);
    expect(r.total).toBeCloseTo(100, 10);
  });

  it('weights each component correctly in isolation', () => {
    const onlySignups = compositeReward(
      components({ impressions: 200, signups: 100 }),
      WEIGHTS,
      0,
    );
    expect(onlySignups.perImpression).toBeCloseTo(0.4 * 0.5, 12);
    expect(onlySignups.breakdown.signup).toBeCloseTo(0.2, 12);
    expect(onlySignups.breakdown.share).toBe(0);
  });

  it('applies the bounce penalty', () => {
    const r = compositeReward(
      components({ impressions: 100, signups: 50, bounces: 20 }),
      WEIGHTS,
      0.15,
    );
    expect(r.breakdown.bounce_penalty).toBeCloseTo(-0.15 * 0.2, 12);
    expect(r.perImpression).toBeCloseTo(0.4 * 0.5 - 0.03, 12);
  });

  it('clamps a catastrophic bounce rate at zero rather than going negative', () => {
    const r = compositeReward(components({ impressions: 100, bounces: 100 }), WEIGHTS, 0.5);
    expect(r.perImpression).toBe(0);
    expect(r.total).toBe(0);
    // The breakdown still records the true, unclamped penalty - the clamp is a
    // modelling decision about the posterior, not a claim that nothing bad happened.
    expect(r.breakdown.bounce_penalty).toBeCloseTo(-0.5, 12);
  });
});

describe('addComponents', () => {
  it('sums every field', () => {
    const a = components({ impressions: 10, signups: 1, scrollNormSum: 4.5, bounces: 2 });
    const b = components({ impressions: 5, engagedSessions: 3, returns: 1, shares: 1 });
    const sum = addComponents(a, b);
    expect(sum).toEqual({
      impressions: 15,
      signups: 1,
      engagedSessions: 3,
      scrollNormSum: 4.5,
      returns: 1,
      shares: 1,
      bounces: 2,
    });
  });
});

describe('noveltyWeight', () => {
  it('is disabled when the window is zero', () => {
    expect(noveltyWeight(0, 0)).toBe(1);
    expect(noveltyWeight(100, 0)).toBe(1);
    expect(noveltyWeight(5, -1)).toBe(1);
  });

  it('is at the floor for a brand-new variant', () => {
    expect(noveltyWeight(0, 48)).toBe(NOVELTY_FLOOR);
    expect(noveltyWeight(-3, 48)).toBe(NOVELTY_FLOOR);
  });

  it('reaches full weight at the end of the window and stays there', () => {
    expect(noveltyWeight(48, 48)).toBe(1);
    expect(noveltyWeight(200, 48)).toBe(1);
  });

  it('ramps linearly in between', () => {
    expect(noveltyWeight(24, 48)).toBeCloseTo(NOVELTY_FLOOR + (1 - NOVELTY_FLOOR) * 0.5, 12);
    expect(noveltyWeight(12, 48)).toBeLessThan(noveltyWeight(36, 48));
  });
});

describe('foldPosterior', () => {
  const prior = { alpha: 1, beta: 1 };

  it('adds the observed reward mass to alpha and the rest to beta', () => {
    const post = foldPosterior(
      prior,
      components({ impressions: 1000, signups: 250 }),
      WEIGHTS,
      0,
    );
    // reward per impression = 0.4 * 0.25 = 0.1
    expect(post.alpha).toBeCloseTo(1 + 100, 6);
    expect(post.beta).toBeCloseTo(1 + 900, 6);
  });

  it('down-weights a novel variant', () => {
    const full = foldPosterior(prior, components({ impressions: 1000, signups: 250 }), WEIGHTS, 0, 1);
    const novel = foldPosterior(
      prior,
      components({ impressions: 1000, signups: 250 }),
      WEIGHTS,
      0,
      NOVELTY_FLOOR,
    );
    expect(novel.alpha - 1).toBeCloseTo((full.alpha - 1) * NOVELTY_FLOOR, 6);
    expect(novel.beta - 1).toBeCloseTo((full.beta - 1) * NOVELTY_FLOOR, 6);
  });

  it('defaults to full weight when novelty is not supplied', () => {
    const implicit = foldPosterior(prior, components({ impressions: 10, signups: 10 }), WEIGHTS, 0);
    const explicit = foldPosterior(
      prior,
      components({ impressions: 10, signups: 10 }),
      WEIGHTS,
      0,
      1,
    );
    expect(implicit).toEqual(explicit);
  });

  it('never produces a non-positive parameter', () => {
    const post = foldPosterior(
      { alpha: 1e-9, beta: 1e-9 },
      EMPTY_COMPONENTS,
      WEIGHTS,
      0,
    );
    expect(post.alpha).toBeGreaterThan(0);
    expect(post.beta).toBeGreaterThan(0);
  });
});

describe('decayPosterior', () => {
  const prior = { alpha: 1, beta: 1 };

  it('is a no-op at gamma = 1', () => {
    expect(decayPosterior({ alpha: 50, beta: 200 }, prior, 1)).toEqual({ alpha: 50, beta: 200 });
  });

  it('leaves a posterior that is still at its prior untouched', () => {
    expect(decayPosterior(prior, prior, 0.5)).toEqual(prior);
  });

  it('pulls accumulated evidence back towards the prior', () => {
    const decayed = decayPosterior({ alpha: 101, beta: 901 }, prior, 0.9);
    expect(decayed.alpha).toBeCloseTo(1 + 100 * 0.9, 10);
    expect(decayed.beta).toBeCloseTo(1 + 900 * 0.9, 10);
  });

  it('converges to a bounded effective sample size under repeated application', () => {
    // The property that matters: evidence cannot accumulate without limit, so a
    // change in the world is always eventually visible in the posterior.
    let posterior = prior;
    for (let cycle = 0; cycle < 500; cycle += 1) {
      posterior = decayPosterior(
        { alpha: posterior.alpha + 10, beta: posterior.beta + 90 },
        prior,
        0.9,
      );
    }
    const total = posterior.alpha + posterior.beta;
    // 100 observations per cycle at gamma = 0.9 caps the effective sample at ~1000.
    expect(total).toBeGreaterThan(900);
    expect(total).toBeLessThan(1_100);
  });

  it('uses the documented default', () => {
    expect(decayPosterior({ alpha: 101, beta: 1 }, prior).alpha).toBeCloseTo(1 + 100 * 0.98, 10);
  });

  it('rejects an invalid gamma', () => {
    expect(() => decayPosterior({ alpha: 2, beta: 2 }, prior, 0)).toThrow(RangeError);
    expect(() => decayPosterior({ alpha: 2, beta: 2 }, prior, 1.2)).toThrow(RangeError);
  });

  it('never produces a non-positive parameter', () => {
    const decayed = decayPosterior({ alpha: 1e-9, beta: 1e-9 }, { alpha: 0, beta: 0 }, 0.5);
    expect(decayed.alpha).toBeGreaterThan(0);
    expect(decayed.beta).toBeGreaterThan(0);
  });
});

describe('effectiveMemoryCycles', () => {
  it('reports the horizon an operator is actually choosing', () => {
    expect(effectiveMemoryCycles(0.98)).toBeCloseTo(50, 10);
    expect(effectiveMemoryCycles(0.9)).toBeCloseTo(10, 10);
    expect(effectiveMemoryCycles(0.999)).toBeCloseTo(1_000, 6);
  });

  it('is infinite when forgetting is disabled', () => {
    expect(effectiveMemoryCycles(1)).toBe(Number.POSITIVE_INFINITY);
  });
});
