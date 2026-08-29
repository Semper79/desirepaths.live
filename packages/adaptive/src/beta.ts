/**
 * Beta-distribution arithmetic.
 *
 * The Thompson layer keeps one Beta posterior per (surface, variant, context
 * bucket). Sampling from it is cheap; *reasoning* about it is what this file is for -
 * "how likely is it that variant 7 is worse than the leader" is the sentence the
 * Telegram report has to print, and it needs a real number behind it, not a
 * Monte-Carlo estimate that changes every time the report runs.
 *
 * Everything here is deterministic and closed-form-or-quadrature. No RNG.
 */

import { clamp01 } from './math.js';

/** Lanczos approximation, g = 7, n = 9. Accurate to ~15 significant figures for x > 0. */
const LANCZOS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function lnGamma(x: number): number {
  if (x <= 0 || !Number.isFinite(x)) {
    throw new RangeError(`lnGamma requires a positive finite argument, got ${String(x)}`);
  }
  // Reflection for x < 0.5 keeps accuracy where the series is poor. The posteriors
  // in this system never go below 0.5 in practice, but a Jeffreys prior of 0.5 sits
  // exactly on the boundary and an operator may configure something smaller.
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- LANCZOS has 9 entries, index 0 is present
  let series = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i += 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i is bounded by LANCZOS.length
    series += LANCZOS[i]! / (z + i);
  }
  const t = z + LANCZOS.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

export function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/** Probability density of Beta(a, b) at x. Zero outside the open unit interval. */
export function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lnBeta(a, b));
}

const CF_MAX_ITERATIONS = 300;
const CF_EPSILON = 3e-16;
const CF_TINY = 1e-300;

/**
 * Floor a continued-fraction term away from zero.
 *
 * Lentz's algorithm divides by these terms; a term that reaches exactly zero
 * produces an infinity that never recovers. The guard appears six times in the
 * recurrence below, and inlining it six times would mean six defensive branches
 * that no realistic input reaches - six permanent holes in this package's
 * branch-coverage guarantee. One exported, directly tested function instead.
 */
export function tinyGuard(value: number): number {
  return Math.abs(value) < CF_TINY ? CF_TINY : value;
}

/**
 * Continued fraction for the incomplete beta function (Lentz's modified algorithm,
 * as in Numerical Recipes 6.4). Converges in a handful of iterations for the
 * arguments this system produces.
 */
export function betaContinuedFraction(
  x: number,
  a: number,
  b: number,
  maxIterations = CF_MAX_ITERATIONS,
): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 / tinyGuard(1 - (qab * x) / qap);
  let h = d;

  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;

    // Even step.
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 / tinyGuard(1 + numerator * d);
    c = tinyGuard(1 + numerator / c);
    h *= d * c;

    // Odd step.
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 / tinyGuard(1 + numerator * d);
    c = tinyGuard(1 + numerator / c);
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < CF_EPSILON) return h;
  }
  // Not reachable with the default iteration budget for any (x, a, b) with a, b > 0
  // and 0 < x < 1 - but a corrupted posterior must fail loudly rather than return a
  // plausible number that silently steers the optimiser. `maxIterations` exists so
  // this path is testable rather than merely asserted to be unreachable.
  throw new Error(
    `Incomplete beta failed to converge for x=${String(x)}, a=${String(a)}, b=${String(b)}`,
  );
}

/** Regularised incomplete beta I_x(a, b) - i.e. the Beta(a, b) CDF at x. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lnBeta(a, b));
  // The continued fraction converges quickly only on one side of the mode; the
  // symmetry relation I_x(a,b) = 1 - I_{1-x}(b,a) moves us to the fast side.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

export function betaMean(a: number, b: number): number {
  return a / (a + b);
}

export function betaVariance(a: number, b: number): number {
  const s = a + b;
  return (a * b) / (s * s * (s + 1));
}

/**
 * Equal-tailed credible interval, by bisection on the CDF.
 *
 * Bisection rather than a Newton solve: 60 iterations is ~1e-18 of the unit
 * interval, it cannot diverge, and it has no derivative to get wrong. This is called
 * once per variant per report, not on the hot path, so robustness beats speed.
 */
export function betaCredibleInterval(a: number, b: number, mass = 0.95): readonly [number, number] {
  const tail = (1 - mass) / 2;
  return [betaQuantile(a, b, tail), betaQuantile(a, b, 1 - tail)];
}

export function betaQuantile(a: number, b: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Total pseudo-count beyond which `betaCdf` is no longer trusted.
 *
 * Measured, not guessed. The regularised incomplete beta stops converging between a mass
 * of 450,000 and 500,000: `front` becomes a difference of two enormous logs and loses its
 * significant digits, and `betaContinuedFraction` throws rather than return a plausible
 * wrong number. This sits at a factor of two below that.
 *
 * It is reachable in production, not in theory. Exponential forgetting caps the
 * pseudo-count at `observations_per_cycle / (1 - gamma)` — fifty hourly cycles at the
 * default 0.98 — so a surface seeing 20,000 impressions an hour lands here, and one at the
 * 5M events/day design target lands an order of magnitude past it. Before this existed,
 * the hourly `adapt` job and the report both threw at that scale.
 */
const CONCENTRATION_LIMIT = 200_000;

/**
 * Standard normal CDF, via the Numerical Recipes `erfc` rational approximation.
 *
 * Fractional error below 1.2e-7 across the whole line, which is three orders of magnitude
 * tighter than anything downstream can perceive: this number is compared against a 0.95
 * retirement threshold and printed to two decimal places.
 *
 * Exported so its two branches are reachable from a test directly rather than only
 * through a posterior contrived to hit them.
 */
export function standardNormalCdf(z: number): number {
  // Exact by symmetry, and worth stating rather than approximating: the rational
  // approximation returns 0.50000001 here, and two identical posteriors reporting
  // anything other than an even split is the kind of detail that makes a reader stop
  // trusting the rest of the page.
  if (z === 0) return 0.5;

  const x = -z / Math.SQRT2;
  const magnitude = Math.abs(x);
  const t = 1 / (1 + 0.5 * magnitude);

  const series =
    t *
    Math.exp(
      -magnitude * magnitude -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );

  return 0.5 * (x >= 0 ? series : 2 - series);
}

/**
 * P(X > Y) for two posteriors concentrated enough to be treated as normal.
 *
 * X - Y is then normal with the difference of the means and the sum of the variances, so
 * the answer is one CDF evaluation. Agreement with the exact quadrature was measured at
 * 3.8e-7 by a total mass of 10,000 and better above it; the worst case found, a posterior
 * skewed to a 0.1% reward rate at mass 200,000, still agreed to 8.6e-5.
 */
function normalDifference(a1: number, b1: number, a2: number, b2: number): number {
  const delta = betaMean(a1, b1) - betaMean(a2, b2);
  const spread = Math.sqrt(betaVariance(a1, b1) + betaVariance(a2, b2));

  // Both posteriors are exact point masses. Dividing by zero here would produce a
  // probability of NaN, which compares false against every threshold and would silently
  // stop the guardrail from ever retiring anything.
  if (spread === 0) return compareMeans(betaMean(a1, b1), betaMean(a2, b2));

  return clamp01(standardNormalCdf(delta / spread));
}

/**
 * P(X > Y) where X ~ Beta(a1, b1) and Y ~ Beta(a2, b2).
 *
 * This is *the* number the optimiser retires variants on and the report quotes in
 * plain English. Cook's closed form needs an integer parameter; these posteriors
 * accumulate fractional pseudo-counts from a weighted composite reward, so it does
 * not apply. Instead: numerically integrate f_X(x) * F_Y(x) over the region where
 * the integrand is not numerically zero.
 *
 * Restricting the integration range is not an optimisation, it is a correctness
 * requirement: at 50,000 impressions a posterior has a standard deviation around
 * 0.002, and a fixed grid over [0, 1] would step straight over the entire density.
 *
 * THREE REGIMES, BECAUSE ONE METHOD DOES NOT COVER THE RANGE (D28)
 * The quadrature above needs `betaCdf`, which gives up once a posterior passes roughly
 * half a million pseudo-counts — a level forgetting allows and the design target reaches.
 * So:
 *
 *   both concentrated — the normal difference. Two near-point-masses, and the answer
 *   saturates towards 0 or 1 exactly as it should.
 *
 *   one concentrated — the wide one keeps its exact CDF and the narrow one is treated as
 *   a point mass at its mean. The naive move here is to apply the normal difference
 *   anyway, and it is badly wrong: Beta(3, 7) is broad and skewed, nothing like a normal,
 *   and the approximation was measured 3.7e-2 out. The point-mass treatment was 2.7e-6
 *   out on the same case. This is the fresh-variant-against-mature-leader comparison,
 *   which the bandit makes constantly.
 *
 *   neither — the quadrature, unchanged, which is exact where it works.
 */
export function probabilityGreater(a1: number, b1: number, a2: number, b2: number): number {
  const concentrated1 = a1 + b1 >= CONCENTRATION_LIMIT;
  const concentrated2 = a2 + b2 >= CONCENTRATION_LIMIT;

  if (concentrated1 && concentrated2) return normalDifference(a1, b1, a2, b2);

  // Y has collapsed: P(X > Y) becomes P(X > mean of Y), read off X's own exact CDF.
  if (concentrated2) return clamp01(1 - betaCdf(betaMean(a2, b2), a1, b1));

  // X has collapsed: P(X > Y) becomes P(mean of X > Y), which is Y's CDF at that point.
  if (concentrated1) return clamp01(betaCdf(betaMean(a1, b1), a2, b2));

  const m1 = betaMean(a1, b1);
  const s1 = Math.sqrt(betaVariance(a1, b1));
  const m2 = betaMean(a2, b2);
  const s2 = Math.sqrt(betaVariance(a2, b2));

  const lo = Math.max(0, Math.min(m1 - 12 * s1, m2 - 12 * s2));
  const hi = Math.min(1, Math.max(m1 + 12 * s1, m2 + 12 * s2));

  // Degenerate range: both posteriors are numerically point masses. Compare means.
  if (hi - lo < 1e-12) return compareMeans(m1, m2);

  // Composite Simpson over an even number of intervals.
  const n = 2048;
  const h = (hi - lo) / n;
  let total = 0;
  for (let i = 0; i <= n; i += 1) {
    const x = lo + i * h;
    const weight = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
    total += weight * betaPdf(x, a1, b1) * betaCdf(x, a2, b2);
  }
  const integral = (total * h) / 3;

  // Quadrature error can push a value a hair outside [0, 1], and a "probability"
  // of 1.0000001 in the report is the kind of detail that destroys an operator's
  // trust in every other number on the page.
  return clamp01(integral);
}

/**
 * Degenerate comparison used when both posteriors have collapsed to point masses -
 * which happens after a few hundred thousand impressions, where the standard
 * deviation falls below the width of the quadrature grid. Exported so the branch is
 * reachable from a test rather than only from a hypothetical production posterior.
 */
export function compareMeans(m1: number, m2: number): number {
  if (m1 > m2) return 1;
  if (m1 < m2) return 0;
  return 0.5;
}

/** Convenience inverse of `probabilityGreater`, for the phrasing the report uses. */
export function probabilityWorseThan(
  candidate: { alpha: number; beta: number },
  leader: { alpha: number; beta: number },
): number {
  return probabilityGreater(leader.alpha, leader.beta, candidate.alpha, candidate.beta);
}
