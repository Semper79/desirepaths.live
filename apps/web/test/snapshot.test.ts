/**
 * Parsing the decision set the worker publishes.
 *
 * The renderer resolves an assignment from whatever this returns, so a malformed arm here
 * does not throw — it produces `NaN` samples, and a variant whose Thompson draw is always
 * `NaN` is a variant that loses every comparison for ever. Silent, permanent, and
 * indistinguishable from the bandit having decided it was bad.
 */

import { describe, expect, it } from 'vitest';
import { COLD_SNAPSHOT, parseSnapshot } from '../src/lib/snapshot.js';

const good = JSON.stringify({
  arms: {
    'hero.headline': [
      { variantId: 'hero.headline#a', alpha: 41, beta: 61, impressions: 100 },
      { variantId: 'hero.headline#b', alpha: 12, beta: 90, impressions: 100 },
    ],
  },
  adaptationEnabled: true,
  generatedAt: 1_700_000_000_000,
});

describe('parseSnapshot', () => {
  it('reads a snapshot the worker wrote', () => {
    const snapshot = parseSnapshot(good);

    expect(snapshot?.arms['hero.headline']).toHaveLength(2);
    expect(snapshot?.generatedAt).toBe(1_700_000_000_000);
    expect(snapshot?.adaptationEnabled).toBe(true);
  });

  it('drops an arm with a parameter a Beta cannot take', () => {
    // Alpha of zero or below is not a distribution. Keeping the arm would make its every
    // draw `NaN`, which loses silently rather than erroring.
    const snapshot = parseSnapshot(
      JSON.stringify({
        arms: {
          s: [
            { variantId: 's#ok', alpha: 2, beta: 2, impressions: 4 },
            { variantId: 's#zero', alpha: 0, beta: 2, impressions: 4 },
            { variantId: 's#nan', alpha: null, beta: 2, impressions: 4 },
          ],
        },
        generatedAt: 1,
      }),
    );

    expect(snapshot?.arms['s']).toHaveLength(1);
    expect(snapshot?.arms['s']?.[0]?.variantId).toBe('s#ok');
  });

  it('drops a surface whose arms were all unusable rather than leaving it empty', () => {
    // An empty arm array reaches `sampleArm`, which throws on it. A surface that is
    // absent resolves to its baseline, which is the correct page.
    const snapshot = parseSnapshot(
      JSON.stringify({ arms: { s: [{ variantId: 's#bad', alpha: -1, beta: 1 }] }, generatedAt: 1 }),
    );

    expect(snapshot?.arms['s']).toBeUndefined();
  });

  it('treats a missing adaptationEnabled as on, and an explicit false as off', () => {
    // Only an explicit `false` disables adaptation. An older worker that predates the
    // field must not read as "the operator switched the site off".
    expect(parseSnapshot(JSON.stringify({ arms: {}, generatedAt: 1 }))?.adaptationEnabled).toBe(
      true,
    );
    expect(
      parseSnapshot(JSON.stringify({ arms: {}, adaptationEnabled: false, generatedAt: 1 }))
        ?.adaptationEnabled,
    ).toBe(false);
  });

  it('reports an unusable timestamp as zero rather than as a date', () => {
    // Zero is what `siteSophistication` reads as "never published", which is honest.
    // A NaN would propagate into the freshness term and make the whole reading NaN.
    expect(parseSnapshot(JSON.stringify({ arms: {} }))?.generatedAt).toBe(0);
  });

  it('refuses a payload that is not a snapshot', () => {
    expect(parseSnapshot('null')).toBeNull();
    expect(parseSnapshot('[]')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ arms: 'nope' }))).toBeNull();
  });

  it('ignores an arms entry that is not a list', () => {
    const snapshot = parseSnapshot(JSON.stringify({ arms: { s: 'nope' }, generatedAt: 1 }));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.arms['s']).toBeUndefined();
  });

  it('has a cold snapshot that resolves everything to baseline', () => {
    // What the site serves before the first cycle, and whenever Redis is unreachable.
    expect(Object.keys(COLD_SNAPSHOT.arms)).toHaveLength(0);
    expect(COLD_SNAPSHOT.generatedAt).toBe(0);
  });
});
