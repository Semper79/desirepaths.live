import { describe, expect, it } from 'vitest';
import {
  createArm,
  decayArm,
  deserialiseArm,
  invert,
  scoreArm,
  serialiseArm,
  updateArm,
} from '../src/linucb.js';
import { createRng } from '../src/rng.js';

describe('createArm', () => {
  it('starts with A = lambda * I, so A^-1 = I / lambda', () => {
    const a = createArm(3, 2);
    expect(Array.from(a.a)).toEqual([2, 0, 0, 0, 2, 0, 0, 0, 2]);
    expect(Array.from(a.aInv)).toEqual([0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]);
    expect(Array.from(a.b)).toEqual([0, 0, 0]);
    expect(a.updates).toBe(0);
  });

  it('defaults lambda to 1', () => {
    expect(Array.from(createArm(2).aInv)).toEqual([1, 0, 0, 1]);
  });

  it('rejects an invalid dimension or ridge parameter', () => {
    expect(() => createArm(0)).toThrow(RangeError);
    expect(() => createArm(-1)).toThrow(RangeError);
    expect(() => createArm(2.5)).toThrow(RangeError);
    expect(() => createArm(3, 0)).toThrow(RangeError);
    expect(() => createArm(3, -1)).toThrow(RangeError);
  });
});

describe('updateArm', () => {
  it('rejects a feature vector of the wrong length', () => {
    expect(() => updateArm(createArm(3), [1, 0], 1)).toThrow(RangeError);
  });

  it('does not mutate the state it was given', () => {
    const before = createArm(2);
    const snapshot = Array.from(before.aInv);
    updateArm(before, [1, 0], 1);
    expect(Array.from(before.aInv)).toEqual(snapshot);
    expect(before.updates).toBe(0);
  });

  /**
   * The Sherman-Morrison update is the one piece of this package where an algebra
   * slip would be invisible: the model would simply learn the wrong thing, slowly.
   * So it is checked against an explicitly constructed inverse.
   */
  it('matches a directly computed inverse after a rank-1 update', () => {
    // A = I + x x^T with x = [1, 2]:  A = [[2, 2], [2, 5]], det = 6,
    // A^-1 = [[5/6, -2/6], [-2/6, 2/6]].
    const updated = updateArm(createArm(2), [1, 2], 0);
    const expected = [5 / 6, -2 / 6, -2 / 6, 2 / 6];
    Array.from(updated.aInv).forEach((v, i) => {
      expect(v).toBeCloseTo(expected[i] as number, 12);
    });
  });

  it('accumulates reward-weighted features into b', () => {
    const a = updateArm(updateArm(createArm(2), [1, 0], 1), [0, 1], 0.5);
    expect(Array.from(a.b)).toEqual([1, 0.5]);
    expect(a.updates).toBe(2);
  });
});

describe('scoreArm', () => {
  it('rejects a feature vector of the wrong length', () => {
    expect(() => scoreArm(createArm(3), [1])).toThrow(RangeError);
  });

  it('is pure exploration bonus before any data', () => {
    const s = scoreArm(createArm(2), [1, 0]);
    expect(s.mean).toBe(0);
    expect(s.bonus).toBeGreaterThan(0);
    expect(s.ucb).toBe(s.bonus);
  });

  it('shrinks the bonus as evidence accumulates', () => {
    let a = createArm(2);
    const before = scoreArm(a, [1, 0]).bonus;
    for (let i = 0; i < 100; i += 1) a = updateArm(a, [1, 0], 1);
    const after = scoreArm(a, [1, 0]).bonus;
    expect(after).toBeLessThan(before / 5);
  });

  it('keeps a large bonus for a context it has never seen', () => {
    let a = createArm(2);
    for (let i = 0; i < 100; i += 1) a = updateArm(a, [1, 0], 1);
    expect(scoreArm(a, [0, 1]).bonus).toBeGreaterThan(scoreArm(a, [1, 0]).bonus * 5);
  });

  it('honours a non-default alpha', () => {
    const a = createArm(2);
    expect(scoreArm(a, [1, 0], 2).bonus).toBeCloseTo(scoreArm(a, [1, 0], 1).bonus * 2, 12);
  });

  it('recovers a linear reward function', () => {
    // True model: reward = 0.2 * x0 + 0.8 * x1, no noise.
    let a = createArm(2);
    const rng = createRng('linucb-fit');
    for (let i = 0; i < 3_000; i += 1) {
      const x0 = rng.next();
      const x1 = rng.next();
      a = updateArm(a, [x0, x1], 0.2 * x0 + 0.8 * x1);
    }
    expect(scoreArm(a, [1, 0], 0).mean).toBeCloseTo(0.2, 2);
    expect(scoreArm(a, [0, 1], 0).mean).toBeCloseTo(0.8, 2);
  });

  it('never produces NaN from a numerically indefinite matrix', () => {
    // A hand-built state whose "inverse" is negative definite - only reachable via
    // a corrupted cache entry, which is exactly why the guard exists.
    const broken = deserialiseArm({
      dim: 2,
      lambda: 1,
      updates: 5,
      a: [-1, 0, 0, -1],
      aInv: [-1, 0, 0, -1],
      b: [0, 0],
    });
    const s = scoreArm(broken, [1, 1]);
    expect(Number.isNaN(s.bonus)).toBe(false);
    expect(s.bonus).toBe(0);
  });
});

describe('serialisation', () => {
  it('round-trips', () => {
    const a = updateArm(updateArm(createArm(3), [1, 0, 1], 1), [0, 1, 1], 0.25);
    const back = deserialiseArm(serialiseArm(a));
    expect(Array.from(back.aInv)).toEqual(Array.from(a.aInv));
    expect(Array.from(back.b)).toEqual(Array.from(a.b));
    expect(back.updates).toBe(a.updates);
    expect(back.dim).toBe(a.dim);
  });

  it('rejects an inconsistent design matrix', () => {
    expect(() =>
      deserialiseArm({
        dim: 2,
        lambda: 1,
        updates: 0,
        a: [1, 0, 0],
        aInv: [1, 0, 0, 1],
        b: [0, 0],
      }),
    ).toThrow(RangeError);
  });

  it('rejects an inconsistent inverse', () => {
    expect(() =>
      deserialiseArm({
        dim: 2,
        lambda: 1,
        updates: 0,
        a: [1, 0, 0, 1],
        aInv: [1, 0, 0],
        b: [0, 0],
      }),
    ).toThrow(RangeError);
  });

  it('rejects an inconsistent vector', () => {
    expect(() =>
      deserialiseArm({
        dim: 2,
        lambda: 1,
        updates: 0,
        a: [1, 0, 0, 1],
        aInv: [1, 0, 0, 1],
        b: [0],
      }),
    ).toThrow(RangeError);
  });
});

describe('invert', () => {
  it('inverts a well-conditioned matrix', () => {
    // [[4, 7], [2, 6]] has inverse [[0.6, -0.7], [-0.2, 0.4]].
    const inv = invert(Float64Array.from([4, 7, 2, 6]), 2);
    const expected = [0.6, -0.7, -0.2, 0.4];
    Array.from(inv).forEach((v, i) => {
      expect(v).toBeCloseTo(expected[i] as number, 12);
    });
  });

  it('handles a matrix that needs a row swap', () => {
    // A zero in the leading position forces partial pivoting.
    const inv = invert(Float64Array.from([0, 1, 1, 0]), 2);
    expect(Array.from(inv)).toEqual([0, 1, 1, 0]);
  });

  it('reproduces the identity for the identity', () => {
    expect(Array.from(invert(Float64Array.from([1, 0, 0, 1]), 2))).toEqual([1, 0, 0, 1]);
  });

  it('refuses a singular matrix rather than returning nonsense', () => {
    expect(() => invert(Float64Array.from([1, 2, 2, 4]), 2)).toThrow(RangeError);
  });

  it('round-trips a larger design matrix', () => {
    let arm = createArm(5);
    const rng = createRng('invert-roundtrip');
    for (let i = 0; i < 200; i += 1) {
      arm = updateArm(
        arm,
        Array.from({ length: 5 }, () => rng.next()),
        rng.next(),
      );
    }
    const recomputed = invert(arm.a, 5);
    // The incrementally maintained inverse and a fresh inversion must agree, or
    // Sherman-Morrison has drifted.
    Array.from(arm.aInv).forEach((v, i) => {
      expect(v).toBeCloseTo(recomputed[i] as number, 9);
    });
  });
});

describe('decayArm', () => {
  it('leaves an untouched arm exactly where it was', () => {
    const fresh = createArm(3, 2);
    const decayed = decayArm(fresh, 0.5);
    expect(Array.from(decayed.a)).toEqual(Array.from(fresh.a));
    Array.from(decayed.aInv).forEach((v, i) => {
      expect(v).toBeCloseTo(fresh.aInv[i] as number, 12);
    });
  });

  it('is a no-op at gamma = 1', () => {
    let arm = createArm(2);
    for (let i = 0; i < 50; i += 1) arm = updateArm(arm, [1, 0.5], 1);
    const decayed = decayArm(arm, 1);
    Array.from(decayed.a).forEach((v, i) => {
      expect(v).toBeCloseTo(arm.a[i] as number, 10);
    });
  });

  it('restores the confidence bonus that accumulated evidence had crushed', () => {
    let arm = createArm(2);
    for (let i = 0; i < 5_000; i += 1) arm = updateArm(arm, [1, 0], 1);
    const before = scoreArm(arm, [1, 0]).bonus;
    let decayed = arm;
    for (let cycle = 0; cycle < 50; cycle += 1) decayed = decayArm(decayed, 0.9);
    const after = scoreArm(decayed, [1, 0]).bonus;
    // This is the whole point: without forgetting, the model can never again
    // express doubt about a context it has seen thousands of times.
    expect(after).toBeGreaterThan(before * 5);
  });

  it('keeps the inverse consistent with the decayed design matrix', () => {
    let arm = createArm(4);
    const rng = createRng('decay-consistency');
    for (let i = 0; i < 300; i += 1) {
      arm = updateArm(
        arm,
        Array.from({ length: 4 }, () => rng.next()),
        rng.next(),
      );
    }
    const decayed = decayArm(arm, 0.9);
    const recomputed = invert(decayed.a, 4);
    Array.from(decayed.aInv).forEach((v, i) => {
      expect(v).toBeCloseTo(recomputed[i] as number, 9);
    });
  });

  it('shrinks the accumulated reward vector proportionally', () => {
    let arm = createArm(2);
    for (let i = 0; i < 10; i += 1) arm = updateArm(arm, [1, 0], 1);
    const decayed = decayArm(arm, 0.5);
    expect(decayed.b[0]).toBeCloseTo(5, 12);
    expect(decayed.updates).toBe(5);
  });

  it('rejects an invalid gamma', () => {
    expect(() => decayArm(createArm(2), 0)).toThrow(RangeError);
    expect(() => decayArm(createArm(2), -1)).toThrow(RangeError);
    expect(() => decayArm(createArm(2), 1.5)).toThrow(RangeError);
  });

  it('uses a sensible default gamma', () => {
    let arm = createArm(2);
    for (let i = 0; i < 100; i += 1) arm = updateArm(arm, [1, 0], 1);
    expect(decayArm(arm).updates).toBe(98);
  });
});
