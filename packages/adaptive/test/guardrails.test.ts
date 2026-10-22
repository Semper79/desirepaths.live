import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETIREMENT_CONFIG,
  evaluateHealth,
  evaluateRetirement,
  holdoutLift,
  isHoldout,
  shouldForceExplore,
  uniformChoice,
  type HealthSample,
  type RollbackThresholds,
} from '../src/guardrails';
import { createRng } from '../src/rng';
import type { Arm } from '../src/thompson';

const arm = (variantId: string, alpha: number, beta: number, impressions: number): Arm => ({
  variantId,
  alpha,
  beta,
  impressions,
});

describe('isHoldout', () => {
  it('is empty at zero and everything at one', () => {
    expect(isHoldout('visitor', 0)).toBe(false);
    expect(isHoldout('visitor', -1)).toBe(false);
    expect(isHoldout('visitor', 1)).toBe(true);
    expect(isHoldout('visitor', 2)).toBe(true);
  });

  it('selects approximately the requested fraction', () => {
    let n = 0;
    const total = 50_000;
    for (let i = 0; i < total; i += 1) if (isHoldout(`anon-${String(i)}`, 0.05)) n += 1;
    expect(n / total).toBeGreaterThan(0.045);
    expect(n / total).toBeLessThan(0.055);
  });

  it('is stable for a given visitor', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isHoldout('same-visitor', 0.05)).toBe(isHoldout('same-visitor', 0.05));
    }
  });

  /**
   * The property the namespace prefix exists to guarantee. If holdout membership
   * correlated with the assignment stream, the holdout cohort would systematically
   * land on particular variants and the lift measurement would be biased.
   */
  it('is uncorrelated with the assignment hash of the same visitor', () => {
    let both = 0;
    let holdouts = 0;
    const total = 40_000;
    for (let i = 0; i < total; i += 1) {
      const id = `anon-${String(i)}`;
      const inHoldout = isHoldout(id, 0.1);
      if (inHoldout) {
        holdouts += 1;
        // An independent hash of the same id should be uniform within the cohort.
        if (createRng(`assign:sim:${id}`).next() < 0.5) both += 1;
      }
    }
    expect(both / holdouts).toBeGreaterThan(0.45);
    expect(both / holdouts).toBeLessThan(0.55);
  });
});

describe('shouldForceExplore', () => {
  it('never fires at a zero floor', () => {
    const rng = createRng(1);
    for (let i = 0; i < 200; i += 1) expect(shouldForceExplore(rng, 0)).toBe(false);
    expect(shouldForceExplore(createRng(2), -0.5)).toBe(false);
  });

  it('fires at approximately the configured rate', () => {
    const rng = createRng('explore');
    let hits = 0;
    const n = 100_000;
    for (let i = 0; i < n; i += 1) if (shouldForceExplore(rng, 0.02)) hits += 1;
    expect(hits / n).toBeGreaterThan(0.017);
    expect(hits / n).toBeLessThan(0.023);
  });
});

describe('uniformChoice', () => {
  it('refuses an empty set', () => {
    expect(() => uniformChoice([], createRng(1))).toThrow(RangeError);
  });

  it('covers every arm', () => {
    const arms = [arm('a', 1, 1, 0), arm('b', 1, 1, 0), arm('c', 1, 1, 0)];
    const rng = createRng('uniform');
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) seen.add(uniformChoice(arms, rng).variantId);
    expect(seen.size).toBe(3);
  });
});

describe('evaluateRetirement', () => {
  const leader = arm('s#leader', 300, 2_700, 3_000);

  it('never retires the baseline, however badly it performs', () => {
    const verdict = evaluateRetirement(arm('s#base', 10, 2_990, 3_000), leader, true);
    expect(verdict.retire).toBe(false);
    expect(verdict.code).toBe('is_baseline');
  });

  it('never retires the leader itself', () => {
    const verdict = evaluateRetirement(leader, leader, false);
    expect(verdict.retire).toBe(false);
    expect(verdict.code).toBe('is_leader');
  });

  it('waits for the minimum sample size', () => {
    const verdict = evaluateRetirement(arm('s#new', 1, 99, 100), leader, false);
    expect(verdict.retire).toBe(false);
    expect(verdict.code).toBe('insufficient_samples');
  });

  it('will not retire on an inconclusive sequential test', () => {
    // Plenty of impressions, but the difference is tiny.
    const verdict = evaluateRetirement(arm('s#close', 295, 2_705, 3_000), leader, false);
    expect(verdict.retire).toBe(false);
    expect(verdict.code).toBe('not_conclusive');
  });

  it('will not retire a candidate the sequential test concluded is better', () => {
    // The mSPRT is two-sided: it crosses on a large difference in either direction.
    // This is the real case where that matters - the leader was recomputed a moment
    // ago and a challenger has overtaken it. The sequential test fires, and the
    // posterior condition is what stops the engine retiring the wrong variant.
    const verdict = evaluateRetirement(arm('s#better', 900, 5_100, 6_000), leader, false);
    expect(verdict.test.crossed).toBe(true);
    expect(verdict.probabilityWorse).toBeLessThan(0.05);
    expect(verdict.retire).toBe(false);
    expect(verdict.code).toBe('not_worse');
  });

  it('retires a variant that is conclusively and substantially worse', () => {
    const verdict = evaluateRetirement(arm('s#bad', 60, 5_940, 6_000), leader, false, {
      ...DEFAULT_RETIREMENT_CONFIG,
      msprtTau: 0.05,
    });
    expect(verdict.retire).toBe(true);
    expect(verdict.code).toBe('retired');
    expect(verdict.probabilityWorse).toBeGreaterThan(0.95);
    expect(verdict.test.crossed).toBe(true);
  });

  it('uses the default configuration when none is supplied', () => {
    const withDefault = evaluateRetirement(arm('s#bad', 60, 5_940, 6_000), leader, false);
    const explicit = evaluateRetirement(
      arm('s#bad', 60, 5_940, 6_000),
      leader,
      false,
      DEFAULT_RETIREMENT_CONFIG,
    );
    expect(withDefault.code).toBe(explicit.code);
  });
});

describe('evaluateHealth', () => {
  const thresholds: RollbackThresholds = {
    maxLcpMs: 2_000,
    maxCls: 0.05,
    maxInpMs: 200,
    maxBounceRateDelta: 0.1,
    maxClientErrorRate: 0.02,
    minSamples: 200,
  };

  const healthy: HealthSample = {
    variantId: 'v1',
    samples: 1_000,
    p75LcpMs: 1_400,
    p75Cls: 0.01,
    p75InpMs: 120,
    clientErrorRate: 0.001,
    bounceRate: 0.42,
  };

  it('says nothing on a thin sample', () => {
    const verdict = evaluateHealth({ ...healthy, samples: 10, p75LcpMs: 9_000 }, 0.4, thresholds);
    expect(verdict.quarantine).toBe(false);
    expect(verdict.breaches).toEqual([]);
  });

  it('passes a healthy variant', () => {
    expect(evaluateHealth(healthy, 0.4, thresholds).quarantine).toBe(false);
  });

  it('quarantines on LCP', () => {
    const v = evaluateHealth({ ...healthy, p75LcpMs: 3_400 }, 0.4, thresholds);
    expect(v.quarantine).toBe(true);
    expect(v.breaches[0]).toContain('LCP p75 3400ms');
  });

  it('quarantines on CLS', () => {
    const v = evaluateHealth({ ...healthy, p75Cls: 0.2 }, 0.4, thresholds);
    expect(v.breaches.join(' ')).toContain('CLS p75 0.200');
  });

  it('quarantines on INP', () => {
    const v = evaluateHealth({ ...healthy, p75InpMs: 640 }, 0.4, thresholds);
    expect(v.breaches.join(' ')).toContain('INP p75 640ms');
  });

  it('quarantines on client errors', () => {
    const v = evaluateHealth({ ...healthy, clientErrorRate: 0.08 }, 0.4, thresholds);
    expect(v.breaches.join(' ')).toContain('Client error rate 8.00%');
  });

  it('quarantines on a bounce-rate regression against the champion', () => {
    const v = evaluateHealth({ ...healthy, bounceRate: 0.62 }, 0.4, thresholds);
    expect(v.breaches.join(' ')).toContain('worse than the champion');
  });

  it('reports every breach, not just the first', () => {
    const v = evaluateHealth(
      {
        ...healthy,
        p75LcpMs: 5_000,
        p75Cls: 0.3,
        p75InpMs: 900,
        clientErrorRate: 0.5,
        bounceRate: 0.9,
      },
      0.4,
      thresholds,
    );
    expect(v.breaches).toHaveLength(5);
  });
});

describe('holdoutLift', () => {
  it('reports a positive lift when the adaptive cohort does better', () => {
    const lift = holdoutLift(
      { impressions: 190_000, rewardPerImpression: 0.118 },
      { impressions: 10_000, rewardPerImpression: 0.1 },
    );
    expect(lift.relative).toBeCloseTo(0.18, 6);
    expect(lift.absolute).toBeCloseTo(0.018, 6);
    expect(lift.conclusive).toBe(true);
    expect(lift.adaptiveImpressions).toBe(190_000);
    expect(lift.holdoutImpressions).toBe(10_000);
  });

  it('reports a negative lift honestly', () => {
    const lift = holdoutLift(
      { impressions: 190_000, rewardPerImpression: 0.08 },
      { impressions: 10_000, rewardPerImpression: 0.1 },
    );
    expect(lift.relative).toBeLessThan(0);
  });

  it('does not divide by a zero baseline', () => {
    const lift = holdoutLift(
      { impressions: 1_000, rewardPerImpression: 0.05 },
      { impressions: 100, rewardPerImpression: 0 },
    );
    expect(lift.relative).toBe(0);
    expect(lift.absolute).toBeCloseTo(0.05, 12);
  });

  it('is inconclusive early', () => {
    const lift = holdoutLift(
      { impressions: 400, rewardPerImpression: 0.11 },
      { impressions: 20, rewardPerImpression: 0.1 },
    );
    expect(lift.conclusive).toBe(false);
  });

  it('accepts explicit alpha and tau', () => {
    const lift = holdoutLift(
      { impressions: 190_000, rewardPerImpression: 0.118 },
      { impressions: 10_000, rewardPerImpression: 0.1 },
      0.01,
      0.05,
    );
    expect(lift.pValue).toBeGreaterThanOrEqual(0);
    expect(lift.pValue).toBeLessThanOrEqual(1);
  });
});
