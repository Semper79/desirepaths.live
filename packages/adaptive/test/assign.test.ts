import { describe, expect, it } from 'vitest';
import {
  assignmentHash,
  contextualWeight,
  decide,
  DEFAULT_ASSIGNMENT_CONFIG,
  rngFor,
  type AssignmentConfig,
  type AssignmentInput,
} from '../src/assign';
import { createArm, updateArm, type LinUcbArmState } from '../src/linucb';
import type { Arm } from '../src/thompson';

const arms: Arm[] = [
  { variantId: 's#a', alpha: 10, beta: 90, impressions: 100 },
  { variantId: 's#b', alpha: 30, beta: 70, impressions: 100 },
  { variantId: 's#c', alpha: 20, beta: 80, impressions: 100 },
];

const base = (over: Partial<AssignmentInput> = {}): AssignmentInput => ({
  anonId: 'anon-1',
  surfaceId: 'hero.headline',
  arms,
  baselineVariantId: 's#a',
  adaptationEnabled: true,
  consentGranted: true,
  ...over,
});

/** An anonId known to be outside the 5% holdout, so tests below it are stable. */
const NON_HOLDOUT = (() => {
  for (let i = 0; i < 1000; i += 1) {
    const id = `anon-${String(i)}`;
    if (!decide(base({ anonId: id })).isHoldout) return id;
  }
  throw new Error('no non-holdout id found');
})();

/** An anonId known to be inside the 5% holdout. */
const HOLDOUT_ID = (() => {
  for (let i = 0; i < 5000; i += 1) {
    const id = `anon-${String(i)}`;
    if (decide(base({ anonId: id })).isHoldout) return id;
  }
  throw new Error('no holdout id found');
})();

describe('decide - order of precedence', () => {
  it('honours an operator pin above everything else', () => {
    const d = decide(
      base({ anonId: HOLDOUT_ID, pinnedVariantId: 's#c', adaptationEnabled: false }),
    );
    expect(d.variantId).toBe('s#c');
    expect(d.reason).toBe('pinned');
  });

  it('falls back to the baseline when no arms are eligible', () => {
    const d = decide(base({ arms: [] }));
    expect(d.variantId).toBe('s#a');
    expect(d.reason).toBe('baseline_fallback');
  });

  it('freezes on the champion when adaptation is paused', () => {
    const d = decide(base({ anonId: NON_HOLDOUT, adaptationEnabled: false }));
    expect(d.reason).toBe('adaptation_paused');
    expect(d.variantId).toBe('s#b'); // highest posterior mean
  });

  it('serves the baseline without consent', () => {
    const d = decide(base({ anonId: NON_HOLDOUT, consentGranted: false }));
    expect(d.reason).toBe('no_consent');
    expect(d.variantId).toBe('s#a');
  });

  it('serves the baseline to the holdout cohort', () => {
    const d = decide(base({ anonId: HOLDOUT_ID }));
    expect(d.reason).toBe('holdout');
    expect(d.isHoldout).toBe(true);
    expect(d.variantId).toBe('s#a');
  });

  it('forces exploration at the configured rate', () => {
    const alwaysExplore: AssignmentConfig = {
      ...DEFAULT_ASSIGNMENT_CONFIG,
      holdoutFraction: 0,
      explorationFloor: 1,
    };
    const d = decide(base({ config: alwaysExplore }));
    expect(d.reason).toBe('forced_exploration');
    expect(arms.map((a) => a.variantId)).toContain(d.variantId);
  });

  it('uses Thompson sampling when no contextual model is supplied', () => {
    const d = decide(base({ anonId: NON_HOLDOUT }));
    expect(d.reason).toBe('thompson');
    expect(d.scores?.size).toBe(3);
  });

  it('uses the default config when none is passed', () => {
    expect(decide(base({ anonId: NON_HOLDOUT, config: undefined })).reason).toBe('thompson');
  });
});

describe('decide - contextual blending', () => {
  const features = [1, 1, 0];

  const warmArm = (reward: number): LinUcbArmState => {
    let a = createArm(3);
    for (let i = 0; i < 2_000; i += 1) a = updateArm(a, features, reward);
    return a;
  };

  it('ignores the contextual model when there are no features', () => {
    const contextualArms = new Map([['s#a', warmArm(1)]]);
    const d = decide(base({ anonId: NON_HOLDOUT, contextualArms }));
    expect(d.reason).toBe('thompson');
  });

  it('ignores the contextual model for arms it has never seen', () => {
    const d = decide(base({ anonId: NON_HOLDOUT, features, contextualArms: new Map() }));
    expect(d.reason).toBe('thompson');
  });

  it('ignores a contextual arm that has no evidence yet', () => {
    // A cold arm has zero weight, so the decision is still pure Thompson.
    const contextualArms = new Map([['s#a', createArm(3)]]);
    const d = decide(base({ anonId: NON_HOLDOUT, features, contextualArms }));
    expect(d.reason).toBe('thompson');
  });

  it('lets a warm contextual model steer the decision', () => {
    // The Thompson posteriors favour s#b, but the contextual model has strong
    // evidence that s#c wins in this exact context.
    const contextualArms = new Map<string, LinUcbArmState>([
      ['s#a', warmArm(0)],
      ['s#b', warmArm(0)],
      ['s#c', warmArm(1)],
    ]);
    const d = decide(base({ anonId: NON_HOLDOUT, features, contextualArms }));
    expect(d.reason).toBe('contextual');
    expect(d.variantId).toBe('s#c');
  });
});

describe('contextualWeight', () => {
  it('ramps from zero to the cap', () => {
    expect(contextualWeight(0, DEFAULT_ASSIGNMENT_CONFIG)).toBe(0);
    expect(contextualWeight(250, DEFAULT_ASSIGNMENT_CONFIG)).toBeCloseTo(
      DEFAULT_ASSIGNMENT_CONFIG.maxContextualWeight / 2,
      12,
    );
    expect(contextualWeight(500, DEFAULT_ASSIGNMENT_CONFIG)).toBe(
      DEFAULT_ASSIGNMENT_CONFIG.maxContextualWeight,
    );
  });

  it('never exceeds the cap, so the robust layer always retains a say', () => {
    expect(contextualWeight(10_000_000, DEFAULT_ASSIGNMENT_CONFIG)).toBe(
      DEFAULT_ASSIGNMENT_CONFIG.maxContextualWeight,
    );
    expect(DEFAULT_ASSIGNMENT_CONFIG.maxContextualWeight).toBeLessThan(1);
  });

  it('goes straight to the cap when warm-up is disabled', () => {
    const config = { ...DEFAULT_ASSIGNMENT_CONFIG, contextualWarmupUpdates: 0 };
    expect(contextualWeight(0, config)).toBe(config.maxContextualWeight);
  });
});

describe('rngFor', () => {
  it('is reproducible for the same visitor and surface', () => {
    expect(rngFor('v1', 'hero.headline').next()).toBe(rngFor('v1', 'hero.headline').next());
  });

  it('decorrelates surfaces, so variant combinations are not systematically paired', () => {
    expect(rngFor('v1', 'hero.headline').next()).not.toBe(rngFor('v1', 'theme.palette').next());
  });
});

describe('decide - distributional behaviour', () => {
  it('sends most traffic to the best arm without collapsing exploration', () => {
    const counts = new Map<string, number>();
    const total = 20_000;
    for (let i = 0; i < total; i += 1) {
      const d = decide(base({ anonId: `visitor-${String(i)}` }));
      counts.set(d.variantId, (counts.get(d.variantId) ?? 0) + 1);
    }
    const best = counts.get('s#b') ?? 0;
    expect(best / total).toBeGreaterThan(0.7);
    expect(best / total).toBeLessThan(0.98);
    // Every arm keeps getting some traffic - this is the exploration floor working.
    expect(counts.get('s#a') ?? 0).toBeGreaterThan(0);
    expect(counts.get('s#c') ?? 0).toBeGreaterThan(0);
  });

  it('holds roughly the configured holdout share', () => {
    let holdouts = 0;
    const total = 20_000;
    for (let i = 0; i < total; i += 1) {
      if (decide(base({ anonId: `visitor-${String(i)}` })).isHoldout) holdouts += 1;
    }
    expect(holdouts / total).toBeGreaterThan(0.04);
    expect(holdouts / total).toBeLessThan(0.06);
  });
});

describe('assignmentHash', () => {
  it('is stable and order-independent', () => {
    const a = assignmentHash({
      'hero.headline': 'hero.headline#v0',
      'theme.palette': 'theme.palette#dark-neon',
    });
    const b = assignmentHash({
      'theme.palette': 'theme.palette#dark-neon',
      'hero.headline': 'hero.headline#v0',
    });
    expect(a).toBe(b);
  });

  it('changes when any variant changes', () => {
    const a = assignmentHash({ 'hero.headline': 'hero.headline#v0' });
    const b = assignmentHash({ 'hero.headline': 'hero.headline#question' });
    expect(a).not.toBe(b);
  });

  it('produces a decimal string that fits a 64-bit unsigned integer', () => {
    const h = assignmentHash({ 'hero.headline': 'hero.headline#v0' });
    expect(h).toMatch(/^\d+$/);
    expect(BigInt(h)).toBeLessThan(2n ** 64n);
  });

  it('handles the empty assignment', () => {
    expect(assignmentHash({})).toMatch(/^\d+$/);
  });
});
