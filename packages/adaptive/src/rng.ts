/**
 * Deterministic pseudo-random number generation.
 *
 * WHY NOT Math.random()
 * Three reasons, in ascending order of importance:
 *  1. `Math.random()` cannot be seeded, so a bandit test is a coin flip and a failing
 *     CI run cannot be reproduced.
 *  2. The simulation harness (src/sim) has to prove convergence on a known-truth
 *     dataset. "Proof" that changes every run is not proof.
 *  3. Sticky assignment must be reproducible across processes: two edge nodes given
 *     the same visitor and the same posteriors must reach the same decision, or the
 *     visitor sees the site flicker between variants on every request.
 *
 * The generator is sfc32 - 128 bits of state, passes PractRand well beyond the
 * sample counts this system will ever draw, and is about four machine instructions
 * per call. Statistical quality here is not academic: a generator with structure in
 * its low bits would bias Thompson sampling in a way that looks like a real effect.
 */

import { outsideUnitDisc } from './math.js';

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  nextInt(n: number): number;
  /** Standard normal. */
  normal(): number;
  /** Gamma(shape, 1). */
  gamma(shape: number): number;
  /** Beta(alpha, beta) in (0, 1). */
  beta(alpha: number, beta: number): number;
}

/**
 * splitmix32 - used only to expand a seed into the four words sfc32 needs.
 * A poor expansion leaves correlated streams for adjacent seeds, which would make
 * two visitors with adjacent hashes get correlated variant draws.
 */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

class Sfc32 implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  /** Cached second Box-Muller deviate; normals come in pairs and throwing one away doubles the cost. */
  private spare: number | null = null;

  constructor(seed: number) {
    const mix = splitmix32(seed);
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    // Discard the first outputs: sfc32 needs a short warm-up before its state is
    // well mixed, and the first few draws of an un-warmed generator are the ones a
    // low-traffic surface would actually use.
    for (let i = 0; i < 12; i += 1) this.next();
  }

  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`nextInt requires a positive integer bound, got ${String(n)}`);
    }
    return Math.floor(this.next() * n);
  }

  normal(): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    // Polar (Marsaglia) form: no trigonometry, and the rejection loop is cheaper
    // than two calls to Math.sin/cos at the volumes the simulator draws.
    let u: number;
    let v: number;
    let s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (outsideUnitDisc(s));
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * factor;
    return u * factor;
  }

  /**
   * Marsaglia-Tsang (2000). Squeeze step included: it accepts ~96% of proposals
   * without evaluating a logarithm, which matters because the simulation harness
   * draws tens of millions of gamma variates.
   */
  gamma(shape: number): number {
    if (!(shape > 0) || !Number.isFinite(shape)) {
      throw new RangeError(`gamma requires a positive finite shape, got ${String(shape)}`);
    }

    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a) for a < 1. The direct method is only
    // valid for shape >= 1, and shapes below 1 are common - a Beta(0.5, 0.5)
    // Jeffreys prior is a perfectly reasonable thing for an operator to configure.
    if (shape < 1) {
      // A draw of exactly 0 would send the boost term to 0 and the sample outside the
      // support. `Math.max` rather than a conditional: an unreachable branch would be
      // a permanent hole in this package's branch-coverage guarantee.
      const u = Math.max(this.next(), Number.EPSILON);
      return this.gamma(shape + 1) * Math.pow(u, 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = this.next();
      const x2 = x * x;

      // Squeeze: accept without the logarithm in the overwhelming majority of cases.
      if (u < 1 - 0.0331 * x2 * x2) return d * v;
      if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  beta(alpha: number, beta: number): number {
    const x = this.gamma(alpha);
    const y = this.gamma(beta);
    return ratioOrHalf(x, x + y);
  }
}

/**
 * `x / sum`, or 0.5 when the sum underflowed to zero.
 *
 * Both gamma draws underflowing is astronomically unlikely but not impossible for
 * extreme shapes, and a NaN entering a posterior poisons every decision made from it
 * thereafter - silently, because NaN comparisons are all false and an argmax over
 * NaNs returns the first element. Exported rather than inlined so the degenerate
 * case is reachable from a test instead of being an untested defensive branch.
 */
export function ratioOrHalf(x: number, sum: number): number {
  return sum === 0 ? 0.5 : x / sum;
}

export function createRng(seed: number | string): Rng {
  return new Sfc32(typeof seed === 'number' ? seed : hashString(seed));
}

/**
 * FNV-1a, 32-bit.
 *
 * Used for seeding and for sticky assignment. Not cryptographic and not required to
 * be: an attacker who predicts their own variant assignment gains the ability to
 * see a different hero headline. What it must be is *stable across processes and
 * across releases*, which rules out anything using a per-process seed.
 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Map a string to a uniform value in [0, 1).
 *
 * This is the primitive behind holdout selection and sticky assignment. Two
 * independent decisions must never be derived from the same hash of the same
 * string - a visitor who lands in the holdout would then also always land in the
 * same variant slot, correlating two things that must stay independent. Callers
 * therefore always namespace: `unitHash('holdout:' + anonId)`.
 */
export function unitHash(input: string): number {
  return hashString(input) / 4294967296;
}
