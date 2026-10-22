import { describe, expect, it } from 'vitest';
import {
  BASELINE_ASSIGNMENT,
  SURFACES,
  SURFACE_KEYS,
  maskOf,
  type VisitorContext,
} from '@morph/core';
import type { Arm } from '@morph/adaptive';
import {
  BOT_THRESHOLD,
  MemoryAssignmentStore,
  fromWire,
  isStillServable,
  resolveAssignment,
  toWire,
  type PosteriorSnapshot,
} from '../src/lib/assignment';

/**
 * The assignment layer is where an adaptive site either stays indexable or quietly
 * stops being one. Most of these tests are about that.
 */

const context = (over: Partial<VisitorContext> = {}): VisitorContext => ({
  device: 'phone',
  viewport: 'sm',
  referrerClass: 'social',
  source: 'tiktok',
  country: 'IT',
  hourOfWeek: 50,
  depth: 1,
  returning: false,
  locale: 'it',
  consentMask: maskOf(['analytics']),
  ...over,
});

/** Arms built from the shipped registry, so the ids are real. */
function snapshotFromRegistry(over: Partial<PosteriorSnapshot> = {}): PosteriorSnapshot {
  const arms: Record<string, Arm[]> = {};
  for (const key of SURFACE_KEYS) {
    arms[key] = SURFACES[key].variants
      .filter((v) => v.status === 'active')
      .map((v, index) => ({
        variantId: v.id,
        // A deliberate spread so one variant is clearly ahead: the point of most of
        // these tests is which arm is chosen, not whether the maths is right.
        alpha: 10 + index * 5,
        beta: 90,
        impressions: 1_000,
      }));
  }
  return { arms, adaptationEnabled: true, generatedAt: 0, ...over };
}

const SNAPSHOT = snapshotFromRegistry();

describe('the crawler rule', () => {
  /**
   * The single most important test in this file. Serving a bandit-chosen variant to a
   * crawler means the indexed page changes between crawls and the site is serving
   * search engines systematically different content from humans.
   */
  it('serves the baseline to anything at or above the bot threshold', () => {
    const result = resolveAssignment({
      anonId: 'crawler-1',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: BOT_THRESHOLD,
      cached: null,
    });

    expect(result.source).toBe('crawler');
    expect(result.assignment).toEqual(BASELINE_ASSIGNMENT);
  });

  it('serves the same bytes to a crawler on every visit, forever', () => {
    const results = Array.from({ length: 50 }, (_, i) =>
      resolveAssignment({
        anonId: `crawler-${String(i)}`,
        context: context({ device: i % 2 === 0 ? 'phone' : 'desktop' }),
        snapshot: SNAPSHOT,
        botScore: 100,
        cached: null,
      }),
    );

    const hashes = new Set(results.map((r) => r.hash));
    expect(hashes.size).toBe(1);
  });

  it('ignores a sticky assignment for a crawler', () => {
    // A crawler that once picked up a cookie must not keep a non-baseline variant.
    const sticky = { ...BASELINE_ASSIGNMENT, 'hero.headline': 'hero.headline#blunt' };
    const result = resolveAssignment({
      anonId: 'crawler-2',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: 90,
      cached: sticky as typeof BASELINE_ASSIGNMENT,
    });
    expect(result.assignment).toEqual(BASELINE_ASSIGNMENT);
  });

  it('excludes crawler traffic from measurement', () => {
    // A crawler never converts. Counting it teaches the optimiser every variant is bad.
    const crawler = resolveAssignment({
      anonId: 'c',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: 100,
      cached: null,
    });
    expect(crawler.measurable).toBe(false);

    const human = resolveAssignment({
      anonId: 'h',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: null,
    });
    expect(human.measurable).toBe(true);
  });

  it('lets a human just below the threshold adapt normally', () => {
    const result = resolveAssignment({
      anonId: 'human-1',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: BOT_THRESHOLD - 1,
      cached: null,
    });
    expect(result.source).not.toBe('crawler');
  });

  it('uses the same threshold as the collector', () => {
    // Two different numbers in two files is a silent bug that shows up as traffic
    // counted in one place and excluded in the other.
    expect(BOT_THRESHOLD).toBe(60);
  });
});

describe('consent', () => {
  it('serves the baseline without analytics consent', () => {
    const result = resolveAssignment({
      anonId: 'no-consent',
      context: context({ consentMask: maskOf([]) }),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: null,
    });
    expect(result.source).toBe('baseline');
    expect(result.assignment).toEqual(BASELINE_ASSIGNMENT);
  });

  it('adapts once analytics consent is granted', () => {
    const result = resolveAssignment({
      anonId: 'consented',
      context: context({ consentMask: maskOf(['analytics']) }),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: null,
    });
    expect(['computed', 'holdout']).toContain(result.source);
  });
});

describe('sticky assignment', () => {
  it('reuses a cached assignment that is still servable', () => {
    const first = resolveAssignment({
      anonId: 'visitor-1',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: null,
    });

    const second = resolveAssignment({
      anonId: 'visitor-1',
      context: context({ depth: 4 }),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: first.assignment,
    });

    expect(second.source).toBe('sticky');
    expect(second.assignment).toEqual(first.assignment);
    expect(second.hash).toBe(first.hash);
  });

  /**
   * A 30-day sticky assignment must not outlive a quarantine. A returning visitor
   * seeing a variant the rollback guardrail removed is the guardrail not working.
   */
  it('recomputes when a cached variant has been retired', () => {
    const stale = {
      ...BASELINE_ASSIGNMENT,
      'hero.headline': 'hero.headline#no-longer-exists',
    } as typeof BASELINE_ASSIGNMENT;

    const result = resolveAssignment({
      anonId: 'visitor-2',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: stale,
    });

    expect(result.source).not.toBe('sticky');
    expect(result.assignment['hero.headline']).not.toBe('hero.headline#no-longer-exists');
  });

  it('always considers the baseline servable, because it cannot be retired', () => {
    expect(
      isStillServable(BASELINE_ASSIGNMENT, { arms: {}, adaptationEnabled: true, generatedAt: 0 }),
    ).toBe(true);
  });
});

describe('a cold cache is not a slow page', () => {
  it('falls back to the baseline with an empty snapshot', () => {
    const result = resolveAssignment({
      anonId: 'visitor-3',
      context: context(),
      snapshot: { arms: {}, adaptationEnabled: true, generatedAt: 0 },
      botScore: 0,
      cached: null,
    });
    expect(result.assignment).toEqual(BASELINE_ASSIGNMENT);
    for (const key of SURFACE_KEYS) expect(result.reasons[key]).toBe('baseline_fallback');
  });

  it('freezes on champions when adaptation is paused', () => {
    const result = resolveAssignment({
      anonId: 'visitor-4',
      context: context(),
      snapshot: snapshotFromRegistry({ adaptationEnabled: false }),
      botScore: 0,
      cached: null,
    });
    for (const key of SURFACE_KEYS) expect(result.reasons[key]).toBe('adaptation_paused');
  });
});

describe('operator pins', () => {
  it('honours a pin above everything else', () => {
    const pinnedVariant = 'theme.palette#high-contrast';
    const result = resolveAssignment({
      anonId: 'visitor-5',
      context: context(),
      snapshot: snapshotFromRegistry({ pinned: { 'theme.palette': pinnedVariant } }),
      botScore: 0,
      cached: null,
    });
    expect(result.assignment['theme.palette']).toBe(pinnedVariant);
    expect(result.reasons['theme.palette']).toBe('pinned');
  });
});

describe('completeness', () => {
  it('always assigns every surface in the registry', () => {
    for (const botScore of [0, 100]) {
      for (const consent of [maskOf([]), maskOf(['analytics'])]) {
        const result = resolveAssignment({
          anonId: 'visitor-6',
          context: context({ consentMask: consent }),
          snapshot: SNAPSHOT,
          botScore,
          cached: null,
        });
        for (const key of SURFACE_KEYS) {
          expect(result.assignment[key], `${key} @ bot=${String(botScore)}`).toBeDefined();
        }
      }
    }
  });

  it('holds roughly the configured holdout share', () => {
    let holdouts = 0;
    const total = 5_000;
    for (let i = 0; i < total; i += 1) {
      const result = resolveAssignment({
        anonId: `v-${String(i)}`,
        context: context(),
        snapshot: SNAPSHOT,
        botScore: 0,
        cached: null,
      });
      if (result.isHoldout) holdouts += 1;
    }
    expect(holdouts / total).toBeGreaterThan(0.03);
    expect(holdouts / total).toBeLessThan(0.07);
  });
});

describe('the wire format', () => {
  it('round-trips', () => {
    const resolved = resolveAssignment({
      anonId: 'visitor-7',
      context: context(),
      snapshot: SNAPSHOT,
      botScore: 0,
      cached: null,
    });

    const wire = toWire(resolved);
    expect(wire.surfaces).toHaveLength(SURFACE_KEYS.length);
    expect(wire.variants).toHaveLength(SURFACE_KEYS.length);
    expect(fromWire(wire)).toEqual(resolved.assignment);
  });

  it('matches the ClickHouse column layout: two parallel arrays', () => {
    const wire = toWire(
      resolveAssignment({
        anonId: 'v',
        context: context(),
        snapshot: SNAPSHOT,
        botScore: 0,
        cached: null,
      }),
    );
    expect(wire.surfaces.length).toBe(wire.variants.length);
    expect(wire.assignmentHash).toMatch(/^\d+$/);
    expect([0, 1]).toContain(wire.holdout);
  });

  it('rejects a partial assignment rather than rendering an undefined surface', () => {
    expect(
      fromWire({
        surfaces: ['hero.headline'],
        variants: ['hero.headline#v0'],
        assignmentHash: '1',
        holdout: 0,
      }),
    ).toBeNull();
  });

  it('rejects mismatched array lengths', () => {
    expect(
      fromWire({ surfaces: ['a', 'b'], variants: ['a#1'], assignmentHash: '1', holdout: 0 }),
    ).toBeNull();
  });

  it('ignores an unknown surface and a malformed variant id', () => {
    const wire = toWire(
      resolveAssignment({
        anonId: 'v',
        context: context(),
        snapshot: SNAPSHOT,
        botScore: 0,
        cached: null,
      }),
    );
    const tampered = {
      ...wire,
      surfaces: [...wire.surfaces, 'not.a.surface'],
      variants: [...wire.variants, 'NOT A VALID ID'],
    };
    // The extra pair is dropped; the genuine ones survive.
    expect(fromWire(tampered)).not.toBeNull();
  });
});

describe('MemoryAssignmentStore', () => {
  it('reads back what it wrote', async () => {
    const store = new MemoryAssignmentStore();
    expect(await store.read('v1')).toBeNull();
    await store.write('v1', BASELINE_ASSIGNMENT, 60);
    expect(await store.read('v1')).toEqual(BASELINE_ASSIGNMENT);
    expect(store.size).toBe(1);
  });
});
