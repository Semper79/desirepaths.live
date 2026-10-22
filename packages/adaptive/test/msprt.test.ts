import { describe, expect, it } from 'vitest';
import {
  boundedVariance,
  explainSequential,
  INITIAL_SEQUENTIAL_STATE,
  msprt,
  updateSequential,
  type ArmSummary,
} from '../src/msprt';
import { createRng } from '../src/rng';

const arm = (n: number, mean: number): ArmSummary => ({
  n,
  mean,
  variance: boundedVariance(mean),
});

describe('boundedVariance', () => {
  it('is the Bernoulli variance in range', () => {
    expect(boundedVariance(0.5)).toBeCloseTo(0.25, 12);
    expect(boundedVariance(0.1)).toBeCloseTo(0.09, 12);
  });

  it('clamps out-of-range means', () => {
    expect(boundedVariance(-1)).toBe(0);
    expect(boundedVariance(2)).toBe(0);
  });
});

describe('msprt', () => {
  it('is undecided with no observations on either arm', () => {
    expect(msprt(arm(0, 0.1), arm(100, 0.2)).crossed).toBe(false);
    expect(msprt(arm(100, 0.1), arm(0, 0.2)).pValue).toBe(1);
    expect(msprt(arm(0, 0.1), arm(0, 0.2)).standardError).toBe(Number.POSITIVE_INFINITY);
  });

  it('is undecided when there is no variance to reason about', () => {
    // Both arms at exactly zero reward: nothing has happened yet.
    const r = msprt({ n: 500, mean: 0, variance: 0 }, { n: 500, mean: 0, variance: 0 });
    expect(r.crossed).toBe(false);
    expect(r.pValue).toBe(1);
  });

  it('rejects invalid tau and alpha', () => {
    expect(() => msprt(arm(10, 0.1), arm(10, 0.2), 0)).toThrow(RangeError);
    expect(() => msprt(arm(10, 0.1), arm(10, 0.2), -1)).toThrow(RangeError);
    expect(() => msprt(arm(10, 0.1), arm(10, 0.2), 0.05, 0)).toThrow(RangeError);
    expect(() => msprt(arm(10, 0.1), arm(10, 0.2), 0.05, 1)).toThrow(RangeError);
  });

  it('does not fire on a small sample', () => {
    expect(msprt(arm(50, 0.1), arm(50, 0.14)).crossed).toBe(false);
  });

  it('fires on a large, real difference', () => {
    const r = msprt(arm(20_000, 0.1), arm(20_000, 0.14));
    expect(r.crossed).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.delta).toBeCloseTo(0.04, 10);
  });

  it('uses supplied defaults when tau and alpha are omitted', () => {
    const withDefaults = msprt(arm(20_000, 0.1), arm(20_000, 0.14));
    const explicit = msprt(arm(20_000, 0.1), arm(20_000, 0.14), 0.05, 0.05);
    expect(withDefaults).toEqual(explicit);
  });

  /**
   * The property that matters: under the null hypothesis, peeking at every step must
   * not inflate the false-positive rate beyond alpha. A fixed-horizon test peeked
   * this way would fire on a large fraction of these runs.
   */
  it('controls type-I error under continuous peeking', () => {
    const rng = createRng('msprt-null');
    const trials = 200;
    const steps = 400;
    const p = 0.2;
    let falsePositives = 0;

    for (let t = 0; t < trials; t += 1) {
      let controlHits = 0;
      let treatmentHits = 0;
      let fired = false;

      for (let i = 1; i <= steps; i += 1) {
        if (rng.next() < p) controlHits += 1;
        if (rng.next() < p) treatmentHits += 1;
        // Peek on every single observation - the worst case.
        const r = msprt(arm(i, controlHits / i), arm(i, treatmentHits / i), 0.05, 0.05);
        if (r.crossed) {
          fired = true;
          break;
        }
      }
      if (fired) falsePositives += 1;
    }

    // Ville's inequality guarantees <= alpha in the limit; allow generous slack for
    // 200 trials while still failing loudly if the test is not always-valid at all.
    expect(falsePositives / trials).toBeLessThan(0.1);
  });
});

describe('updateSequential', () => {
  it('tracks the running minimum p-value', () => {
    let state = INITIAL_SEQUENTIAL_STATE;
    state = updateSequential(state, msprt(arm(100, 0.1), arm(100, 0.11)), 100);
    const afterFirst = state.minPValue;
    state = updateSequential(state, msprt(arm(200, 0.1), arm(200, 0.3)), 200);
    expect(state.minPValue).toBeLessThan(afterFirst);
    expect(state.looks).toBe(2);
  });

  it('records the sample size at which it first crossed, and never moves it', () => {
    let state = INITIAL_SEQUENTIAL_STATE;
    state = updateSequential(state, msprt(arm(20_000, 0.1), arm(20_000, 0.14)), 20_000);
    expect(state.crossedAt).toBe(20_000);
    state = updateSequential(state, msprt(arm(30_000, 0.1), arm(30_000, 0.1001)), 30_000);
    expect(state.crossedAt).toBe(20_000);
  });

  it('stays uncrossed while the evidence is weak', () => {
    const state = updateSequential(
      INITIAL_SEQUENTIAL_STATE,
      msprt(arm(100, 0.1), arm(100, 0.1)),
      100,
    );
    expect(state.crossedAt).toBeNull();
  });

  it('honours a non-default alpha', () => {
    const weak = msprt(arm(4_000, 0.1), arm(4_000, 0.12));
    const strict = updateSequential(INITIAL_SEQUENTIAL_STATE, weak, 4_000, 0.001);
    const lenient = updateSequential(INITIAL_SEQUENTIAL_STATE, weak, 4_000, 0.5);
    expect(lenient.crossedAt).toBe(4_000);
    expect(strict.crossedAt).toBeNull();
  });
});

describe('explainSequential', () => {
  it('says so plainly when the evidence is not yet conclusive', () => {
    const text = explainSequential(msprt(arm(100, 0.1), arm(100, 0.1)), 0.62, 3_100);
    expect(text).toContain('62%');
    expect(text).toContain('3.1k impressions');
    expect(text).toContain('not yet conclusive');
  });

  it('reports a concluded loss', () => {
    const text = explainSequential(msprt(arm(20_000, 0.14), arm(20_000, 0.1)), 0.94, 20_000);
    expect(text).toContain('94%');
    expect(text).toContain('concluded worse');
  });

  it('reports a concluded win', () => {
    const text = explainSequential(msprt(arm(20_000, 0.1), arm(20_000, 0.14)), 0.02, 20_000);
    expect(text).toContain('concluded better');
  });

  it('prints small impression counts without the k suffix', () => {
    const text = explainSequential(msprt(arm(10, 0.1), arm(10, 0.1)), 0.5, 400);
    expect(text).toContain('400 impressions');
    expect(text).not.toContain('k impressions');
  });
});
