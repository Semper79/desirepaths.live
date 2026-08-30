/**
 * The surfaces view's data.
 *
 * The console's job is to say what the engine is doing without the reader having to infer
 * it. That makes the distinction between "no evidence yet" and "reduced to one variant"
 * load-bearing: both leave a table looking empty, and they mean opposite things — one is a
 * system that has not started, the other is one that has finished deciding.
 */

import { describe, expect, it } from 'vitest';
import { SURFACES, SURFACE_KEYS } from '@morph/core';
import type { Arm } from '@morph/adaptive';
import { surfaceRows } from '../src/lib/surfaces.js';
import { EMPTY, parseSnapshot } from '../src/lib/snapshot.js';

/**
 * A surface with something to choose between, and its real variant ids.
 *
 * Found rather than hard-coded: the registry is allowed to change, and a test pinned to
 * `hero.headline` would quietly start testing nothing the day that surface was reduced to
 * a single variant. The ids are captured once so the fixtures below use the registry's own
 * rather than invented strings that merely look similar.
 */
const found = SURFACE_KEYS.find((key) => SURFACES[key].variants.length > 1);
if (found === undefined) throw new Error('no surface has more than one variant');

// Widened to a plain string for the computed key below: SurfaceKey is a union of literals,
// and TypeScript will not accept a union as a computed property name.
const contested: string = found;

const CONTESTED_IDS: readonly string[] = SURFACES[found].variants.map((variant) => variant.id);

/** Arms for the contested surface, at the given reward rates, in registry order. */
function armsFor(means: readonly number[]): Record<string, readonly Arm[]> {
  const arms: Arm[] = means.map((mean, index) => ({
    variantId: CONTESTED_IDS[index] ?? `unknown#${String(index)}`,
    alpha: mean * 1_000,
    beta: (1 - mean) * 1_000,
    impressions: 1_000,
  }));

  return { [contested]: arms };
}

describe('surfaceRows', () => {
  it('lists every declared surface, with or without evidence', () => {
    const rows = surfaceRows({});

    expect(rows).toHaveLength(SURFACE_KEYS.length);
    expect(rows.every((row) => row.variants.length > 0)).toBe(true);
  });

  it('says why a surface is idle rather than leaving the reader to guess', () => {
    const rows = surfaceRows({});
    const row = rows.find((entry) => entry.key === contested);

    expect(row?.idleReason).toContain('no evidence yet');
  });

  it('distinguishes never-started from finished-deciding', () => {
    // The two states that look identical in a table. One means the adapt job has not run;
    // the other means it ran and removed everything but the winner.
    const single = surfaceRows(armsFor([0.3]));
    const row = single.find((entry) => entry.key === contested);

    expect(row?.idleReason).toContain('reduced to one live variant');
  });

  it('marks the leader, and only the leader', () => {
    const rows = surfaceRows(armsFor([0.2, 0.5]));
    const row = rows.find((entry) => entry.key === contested);
    const leaders = row?.variants.filter((variant) => variant.isLeader) ?? [];

    expect(leaders).toHaveLength(1);
    expect(leaders[0]?.posteriorMean).toBeCloseTo(0.5, 2);
    expect(row?.idleReason).toBeNull();
  });

  it('leaves a variant the engine has never seen as null rather than zero', () => {
    // Zero is a measurement. A variant with no posterior has not scored zero — it has not
    // been measured, and a console that renders those the same way is lying in a table.
    const rows = surfaceRows({});

    for (const row of rows) {
      for (const variant of row.variants) {
        expect(variant.posteriorMean).toBeNull();
        expect(variant.impressions).toBeNull();
      }
    }
  });

  it('marks exactly one baseline per surface', () => {
    for (const row of surfaceRows({})) {
      const baselines = row.variants.filter((variant) => variant.isBaseline);
      expect(baselines, row.key).toHaveLength(1);
    }
  });
});

describe('the snapshot reader', () => {
  it('uses the same key the worker publishes to', async () => {
    // Three copies of this string now exist — worker, web, admin — and they must agree or
    // the site silently stops adapting. Asserted here rather than trusted.
    const { SNAPSHOT_KEY } = await import('../src/lib/snapshot.js');
    expect(SNAPSHOT_KEY).toBe('morph:snapshot:current');
  });

  it('falls back to an empty snapshot rather than throwing', () => {
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot('[]')).toBeNull();
    expect(EMPTY.generatedAt).toBe(0);
    expect(Object.keys(EMPTY.arms)).toHaveLength(0);
  });

  it('drops arms a Beta cannot take', () => {
    const snapshot = parseSnapshot(
      JSON.stringify({
        arms: {
          s: [
            { variantId: 's#ok', alpha: 2, beta: 2 },
            { variantId: 's#bad', alpha: 0, beta: 2 },
          ],
        },
        generatedAt: 1,
      }),
    );

    expect(snapshot?.arms['s']).toHaveLength(1);
  });
});
