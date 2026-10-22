import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng';
import { leaderOf, sampleArm, summarise, type Arm } from '../src/thompson';

const arm = (variantId: string, alpha: number, beta: number, impressions = 0): Arm => ({
  variantId,
  alpha,
  beta,
  impressions,
});

describe('sampleArm', () => {
  it('refuses an empty arm set', () => {
    expect(() => sampleArm([], createRng(1))).toThrow(RangeError);
  });

  it('returns one of the supplied arms with its winning draw', () => {
    const arms = [arm('a', 2, 8), arm('b', 8, 2)];
    const draw = sampleArm(arms, createRng(5));
    expect(['a', 'b']).toContain(draw.variantId);
    expect(draw.sample).toBeGreaterThan(0);
    expect(draw.sample).toBeLessThan(1);
  });

  it('picks the better arm most of the time, but not always', () => {
    const rng = createRng('thompson');
    const arms = [arm('weak', 20, 180), arm('strong', 40, 160)];
    let strong = 0;
    const n = 4_000;
    for (let i = 0; i < n; i += 1) {
      if (sampleArm(arms, rng).variantId === 'strong') strong += 1;
    }
    // Posterior means 10% vs 20% with 200 observations each: the strong arm should
    // dominate, but exploration must not have collapsed entirely.
    expect(strong / n).toBeGreaterThan(0.9);
    expect(strong / n).toBeLessThan(1);
  });

  it('explores far more when the evidence is thin', () => {
    const rng = createRng('thompson-thin');
    const arms = [arm('a', 2, 8), arm('b', 4, 6)];
    let b = 0;
    const n = 4_000;
    for (let i = 0; i < n; i += 1) {
      if (sampleArm(arms, rng).variantId === 'b') b += 1;
    }
    expect(b / n).toBeGreaterThan(0.55);
    expect(b / n).toBeLessThan(0.9);
  });

  it('handles a single arm', () => {
    expect(sampleArm([arm('only', 1, 1)], createRng(2)).variantId).toBe('only');
  });
});

describe('leaderOf', () => {
  it('refuses an empty arm set', () => {
    expect(() => leaderOf([])).toThrow(RangeError);
  });

  it('returns the highest posterior mean', () => {
    expect(leaderOf([arm('a', 1, 9), arm('b', 5, 5), arm('c', 2, 8)]).variantId).toBe('b');
  });

  it('keeps the first arm when it already leads', () => {
    expect(leaderOf([arm('a', 9, 1), arm('b', 1, 9)]).variantId).toBe('a');
  });
});

describe('summarise', () => {
  it('returns nothing for an empty set', () => {
    expect(summarise([])).toEqual([]);
  });

  it('marks the leader with probability 1 and ranks the rest below it', () => {
    const stats = summarise([
      arm('weak', 20, 480, 500),
      arm('strong', 60, 440, 500),
      arm('mid', 40, 460, 500),
    ]);

    const byId = new Map(stats.map((s) => [s.variantId, s]));
    expect(byId.get('strong')?.probabilityBest).toBe(1);
    expect(byId.get('weak')?.probabilityBest).toBeLessThan(0.01);
    expect(byId.get('mid')?.probabilityBest).toBeLessThan(0.5);
    expect(byId.get('mid')?.probabilityBest).toBeGreaterThan(
      byId.get('weak')?.probabilityBest ?? 1,
    );
  });

  it('reports a credible interval that brackets the mean', () => {
    const [only] = summarise([arm('a', 30, 70, 100)]);
    expect(only?.mean).toBeCloseTo(0.3, 10);
    expect(only?.credibleInterval[0]).toBeLessThan(0.3);
    expect(only?.credibleInterval[1]).toBeGreaterThan(0.3);
    expect(only?.impressions).toBe(100);
  });
});
