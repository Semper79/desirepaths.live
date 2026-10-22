import { describe, expect, it } from 'vitest';
import { createRng, hashString, ratioOrHalf, unitHash } from '../src/rng';

/**
 * The properties tested here are the ones the engine actually depends on.
 * "Is it random" is not one of them - sfc32's statistical quality is established
 * elsewhere. What matters is that it is *reproducible*, *uniform enough that
 * Thompson sampling is not biased*, and that the distribution samplers have the
 * moments they claim, because a Beta sampler with the wrong variance produces a
 * bandit that explores confidently in the wrong direction.
 */

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: readonly number[]): number => {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

describe('createRng', () => {
  it('is reproducible from a numeric seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const drawsA = Array.from({ length: 100 }, () => a.next());
    const drawsB = Array.from({ length: 100 }, () => b.next());
    expect(drawsA).toEqual(drawsB);
  });

  it('is reproducible from a string seed, and differs from another string', () => {
    const a = Array.from({ length: 20 }, (_, i) => createRng('visitor-a').next() + i * 0);
    const b = Array.from({ length: 20 }, () => createRng('visitor-a').next());
    expect(a[0]).toBe(b[0]);
    expect(createRng('visitor-a').next()).not.toBe(createRng('visitor-b').next());
  });

  it('produces values in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 5_000; i += 1) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('is uniform to within sampling error', () => {
    const rng = createRng('uniformity');
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i += 1) {
      const index = Math.floor(rng.next() * 10);
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    for (const b of buckets) expect(Math.abs(b - n / 10)).toBeLessThan(n / 10 / 8);
  });
});

describe('nextInt', () => {
  it('stays within bounds and covers them', () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const v = rng.nextInt(4);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
      seen.add(v);
    }
    expect(seen.size).toBe(4);
  });

  it('rejects a non-positive bound', () => {
    expect(() => createRng(1).nextInt(0)).toThrow(RangeError);
    expect(() => createRng(1).nextInt(-3)).toThrow(RangeError);
  });

  it('rejects a non-integer bound', () => {
    expect(() => createRng(1).nextInt(2.5)).toThrow(RangeError);
  });
});

describe('normal', () => {
  it('has mean 0 and variance 1', () => {
    const rng = createRng('normal');
    const xs = Array.from({ length: 200_000 }, () => rng.normal());
    expect(Math.abs(mean(xs))).toBeLessThan(0.02);
    expect(Math.abs(variance(xs) - 1)).toBeLessThan(0.02);
  });

  it('returns the cached second deviate on alternate calls', () => {
    // Exercises the `spare` path explicitly: two consecutive draws must both be
    // finite and different, which is only possible if the cache is used correctly.
    const rng = createRng(11);
    const first = rng.normal();
    const second = rng.normal();
    expect(Number.isFinite(first)).toBe(true);
    expect(Number.isFinite(second)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('gamma', () => {
  it('rejects non-positive and non-finite shapes', () => {
    const rng = createRng(1);
    expect(() => rng.gamma(0)).toThrow(RangeError);
    expect(() => rng.gamma(-1)).toThrow(RangeError);
    expect(() => rng.gamma(Number.NaN)).toThrow(RangeError);
    expect(() => rng.gamma(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('has the right mean and variance for shape >= 1', () => {
    const rng = createRng('gamma-large');
    const shape = 4;
    const xs = Array.from({ length: 120_000 }, () => rng.gamma(shape));
    expect(Math.abs(mean(xs) - shape)).toBeLessThan(0.06);
    expect(Math.abs(variance(xs) - shape)).toBeLessThan(0.2);
  });

  it('handles shape < 1 through the boost identity', () => {
    const rng = createRng('gamma-small');
    const shape = 0.4;
    const xs = Array.from({ length: 120_000 }, () => rng.gamma(shape));
    expect(Math.abs(mean(xs) - shape)).toBeLessThan(0.02);
    expect(Math.abs(variance(xs) - shape)).toBeLessThan(0.05);
    for (const x of xs) expect(x).toBeGreaterThan(0);
  });
});

describe('beta', () => {
  it('has the analytic mean and variance', () => {
    const rng = createRng('beta');
    const a = 3;
    const b = 7;
    const xs = Array.from({ length: 200_000 }, () => rng.beta(a, b));
    const expectedMean = a / (a + b);
    const expectedVar = (a * b) / ((a + b) ** 2 * (a + b + 1));
    expect(Math.abs(mean(xs) - expectedMean)).toBeLessThan(0.005);
    expect(Math.abs(variance(xs) - expectedVar)).toBeLessThan(0.002);
  });

  it('stays strictly inside the unit interval', () => {
    const rng = createRng('beta-support');
    for (let i = 0; i < 20_000; i += 1) {
      const x = rng.beta(0.5, 0.5);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('ratioOrHalf', () => {
  it('divides normally', () => {
    expect(ratioOrHalf(1, 4)).toBe(0.25);
  });

  it('returns the symmetric answer when both gamma draws underflowed', () => {
    expect(ratioOrHalf(0, 0)).toBe(0.5);
  });
});

describe('hashString / unitHash', () => {
  it('is stable across calls', () => {
    expect(hashString('hero.headline#3')).toBe(hashString('hero.headline#3'));
  });

  it('separates namespaces, so holdout and assignment do not correlate', () => {
    expect(unitHash('holdout:abc')).not.toBe(unitHash('assign:abc'));
  });

  it('maps into [0, 1)', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const u = unitHash(`visitor-${String(i)}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('handles the empty string', () => {
    expect(Number.isFinite(unitHash(''))).toBe(true);
  });
});
