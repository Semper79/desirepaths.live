import { describe, expect, it } from 'vitest';
import {
  betaCdf,
  betaContinuedFraction,
  betaCredibleInterval,
  betaMean,
  betaPdf,
  betaQuantile,
  betaVariance,
  compareMeans,
  lnBeta,
  lnGamma,
  probabilityGreater,
  probabilityWorseThan,
  tinyGuard,
} from '../src/beta.js';

describe('lnGamma', () => {
  it('reproduces known values', () => {
    // Gamma(5) = 24, Gamma(0.5) = sqrt(pi), Gamma(1) = 1.
    expect(Math.exp(lnGamma(5))).toBeCloseTo(24, 8);
    expect(Math.exp(lnGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 10);
    expect(lnGamma(1)).toBeCloseTo(0, 12);
  });

  it('uses the reflection formula below 0.5', () => {
    // Gamma(0.25) * Gamma(0.75) = pi / sin(pi/4).
    const product = Math.exp(lnGamma(0.25) + lnGamma(0.75));
    expect(product).toBeCloseTo(Math.PI / Math.sin(Math.PI / 4), 8);
  });

  it('rejects non-positive and non-finite arguments', () => {
    expect(() => lnGamma(0)).toThrow(RangeError);
    expect(() => lnGamma(-2)).toThrow(RangeError);
    expect(() => lnGamma(Number.NaN)).toThrow(RangeError);
    expect(() => lnGamma(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('lnBeta', () => {
  it('matches the factorial identity B(3, 4) = 2!*3!/6! ', () => {
    expect(Math.exp(lnBeta(3, 4))).toBeCloseTo((2 * 6) / 720, 12);
  });
});

describe('tinyGuard', () => {
  it('passes ordinary values through', () => {
    expect(tinyGuard(0.5)).toBe(0.5);
    expect(tinyGuard(-3)).toBe(-3);
  });

  it('floors values that reached zero', () => {
    expect(tinyGuard(0)).toBeGreaterThan(0);
    expect(tinyGuard(1e-320)).toBeGreaterThan(0);
  });
});

describe('betaContinuedFraction', () => {
  it('converges well inside its iteration budget', () => {
    expect(Number.isFinite(betaContinuedFraction(0.3, 2, 5))).toBe(true);
  });

  it('fails loudly rather than returning a plausible number when it cannot converge', () => {
    // A corrupted posterior is the real-world cause; a one-iteration budget is how
    // the failure path is reached deliberately.
    expect(() => betaContinuedFraction(0.3, 2, 5, 1)).toThrow(/failed to converge/);
  });
});

describe('betaPdf', () => {
  it('is zero outside the open unit interval', () => {
    expect(betaPdf(0, 2, 3)).toBe(0);
    expect(betaPdf(-0.1, 2, 3)).toBe(0);
    expect(betaPdf(1, 2, 3)).toBe(0);
    expect(betaPdf(1.5, 2, 3)).toBe(0);
  });

  it('is flat for Beta(1, 1)', () => {
    expect(betaPdf(0.2, 1, 1)).toBeCloseTo(1, 10);
    expect(betaPdf(0.8, 1, 1)).toBeCloseTo(1, 10);
  });

  it('integrates to one', () => {
    const n = 20_000;
    let total = 0;
    for (let i = 1; i < n; i += 1) total += betaPdf(i / n, 3, 5) / n;
    expect(total).toBeCloseTo(1, 3);
  });
});

describe('betaCdf', () => {
  it('saturates outside the unit interval', () => {
    expect(betaCdf(-1, 2, 2)).toBe(0);
    expect(betaCdf(0, 2, 2)).toBe(0);
    expect(betaCdf(1, 2, 2)).toBe(1);
    expect(betaCdf(2, 2, 2)).toBe(1);
  });

  it('is the identity for Beta(1, 1)', () => {
    expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 10);
  });

  it('is symmetric for Beta(a, a)', () => {
    expect(betaCdf(0.5, 4, 4)).toBeCloseTo(0.5, 10);
  });

  it('agrees with the closed form for integer parameters', () => {
    // I_x(2, 3) = 1 - (1-x)^3 (1 + 3x)  [binomial identity]
    const x = 0.37;
    expect(betaCdf(x, 2, 3)).toBeCloseTo(1 - (1 - x) ** 3 * (1 + 3 * x), 10);
  });

  it('takes both continued-fraction branches', () => {
    // Below the mode for (2, 8) and above it: the symmetry relation must give the
    // same monotone curve either side.
    expect(betaCdf(0.05, 2, 8)).toBeLessThan(betaCdf(0.9, 2, 8));
    expect(betaCdf(0.9, 2, 8)).toBeCloseTo(1, 6);
  });
});

describe('quantiles', () => {
  it('inverts the CDF', () => {
    const q = betaQuantile(3, 5, 0.7);
    expect(betaCdf(q, 3, 5)).toBeCloseTo(0.7, 6);
  });

  it('saturates at the ends', () => {
    expect(betaQuantile(3, 5, 0)).toBe(0);
    expect(betaQuantile(3, 5, -1)).toBe(0);
    expect(betaQuantile(3, 5, 1)).toBe(1);
    expect(betaQuantile(3, 5, 2)).toBe(1);
  });

  it('produces a credible interval containing the mean', () => {
    const [lo, hi] = betaCredibleInterval(30, 70);
    expect(lo).toBeLessThan(0.3);
    expect(hi).toBeGreaterThan(0.3);
    expect(betaCdf(hi, 30, 70) - betaCdf(lo, 30, 70)).toBeCloseTo(0.95, 4);
  });

  it('honours a non-default credible mass', () => {
    const wide = betaCredibleInterval(30, 70, 0.99);
    const narrow = betaCredibleInterval(30, 70, 0.5);
    expect(wide[1] - wide[0]).toBeGreaterThan(narrow[1] - narrow[0]);
  });
});

describe('moments', () => {
  it('computes mean and variance', () => {
    expect(betaMean(2, 3)).toBeCloseTo(0.4, 12);
    expect(betaVariance(2, 3)).toBeCloseTo((2 * 3) / (25 * 6), 12);
  });
});

describe('compareMeans', () => {
  it('resolves the degenerate comparison three ways', () => {
    expect(compareMeans(0.6, 0.5)).toBe(1);
    expect(compareMeans(0.4, 0.5)).toBe(0);
    expect(compareMeans(0.5, 0.5)).toBe(0.5);
  });
});

describe('probabilityGreater', () => {
  it('is one half for identical posteriors', () => {
    expect(probabilityGreater(5, 5, 5, 5)).toBeCloseTo(0.5, 4);
  });

  it('is symmetric', () => {
    const p = probabilityGreater(8, 12, 5, 15);
    const q = probabilityGreater(5, 15, 8, 12);
    expect(p + q).toBeCloseTo(1, 4);
  });

  it('is near certainty for well-separated posteriors', () => {
    // 300/1000 vs 200/1000 - a difference no amount of luck explains.
    expect(probabilityGreater(300, 700, 200, 800)).toBeGreaterThan(0.999);
  });

  it('agrees with a Monte-Carlo estimate', () => {
    // Independent check against the definition, using a fixed-seed sampler so the
    // assertion is deterministic.
    let hits = 0;
    const n = 200_000;
    // Simple deterministic LCG - independent of the engine's own RNG on purpose.
    let s = 123456789;
    const u = (): number => {
      s = (1103515245 * s + 12345) % 2147483648;
      return s / 2147483648;
    };
    const sampleBeta = (a: number, b: number): number => {
      // Inverse-CDF sampling via the quantile function: slow but unimpeachable.
      return betaQuantile(a, b, u());
    };
    for (let i = 0; i < n / 100; i += 1) {
      if (sampleBeta(12, 30) > sampleBeta(9, 33)) hits += 1;
    }
    expect(hits / (n / 100)).toBeCloseTo(probabilityGreater(12, 30, 9, 33), 1);
  });

  it('falls back to a mean comparison when both posteriors are point masses', () => {
    // Standard deviations here are ~1e-15, far below the quadrature grid.
    expect(probabilityGreater(1e30, 1e30, 1e30, 1e30)).toBe(0.5);
  });

  it('stays inside [0, 1]', () => {
    for (const [a1, b1, a2, b2] of [
      [1, 1, 1, 1],
      [0.5, 0.5, 200, 3],
      [1000, 2, 2, 1000],
    ] as const) {
      const p = probabilityGreater(a1, b1, a2, b2);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('probabilityWorseThan', () => {
  it('is high for a clearly inferior candidate', () => {
    const p = probabilityWorseThan({ alpha: 20, beta: 480 }, { alpha: 60, beta: 440 });
    expect(p).toBeGreaterThan(0.99);
  });

  it('is near a half for an indistinguishable candidate', () => {
    const p = probabilityWorseThan({ alpha: 50, beta: 450 }, { alpha: 50, beta: 450 });
    expect(p).toBeCloseTo(0.5, 2);
  });
});
