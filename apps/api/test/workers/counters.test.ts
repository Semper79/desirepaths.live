/**
 * `SurfaceCounters`, in workerd.
 *
 * This is the half of the measurement that sampling may never touch (D33), so it is the
 * half where a wrong number is a retired-good-variant rather than a wobbly chart. The cases
 * below are about the three things that could produce a wrong number without anything
 * looking broken:
 *
 *   1. A read that misses counts still sitting in memory.
 *   2. An accumulation that overwrites instead of adding.
 *   3. An alarm that never fires, or fires so late that the pending map is the real store.
 *
 * All three need the real runtime. A fake `setAlarm` cannot demonstrate that calling it
 * twice replaces rather than stacks, and that property is the entire reason the flush
 * interval is bounded.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HourlyFold } from '../../src/counters.js';

const HOUR = 1_780_000_000_000 - (1_780_000_000_000 % 3_600_000);

/** A fold with everything at zero except what a case sets. */
function fold(over: Partial<HourlyFold> = {}): HourlyFold {
  return {
    hourStart: HOUR,
    variantId: 'hero.headline#v0',
    contextBucket: 'phone:social',
    isHoldout: false,
    impressions: 1,
    signups: 0,
    engagedSessions: 0,
    scrollNormSum: 0,
    returns: 0,
    shares: 0,
    bounces: 0,
    ...over,
  };
}

/**
 * Each case gets its own surface, so none of them can see another's counts.
 *
 * `idFromName` + `get` rather than `getByName`: the newer one-call form is not in the
 * workerd build this pool ships, and the production code uses the same pair for the same
 * reason. A deterministic name is the point either way — `getByName(surfaceId)` and
 * `get(idFromName(surfaceId))` address the same object.
 */
let surface = 0;
function freshSurface() {
  surface += 1;
  const name = `surface-${String(surface)}`;
  return env.COUNTERS.get(env.COUNTERS.idFromName(name));
}

describe('recording folds', () => {
  beforeEach(() => {
    surface += 1;
  });

  it('reads back what was recorded', async () => {
    const stub = freshSurface();
    await stub.record([fold({ impressions: 3, signups: 1, scrollNormSum: 0.75 })]);

    const rows = await stub.countersBetween(HOUR, HOUR);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.impressions).toBe(3);
    expect(rows[0]?.signups).toBe(1);
    expect(rows[0]?.scrollNormSum).toBeCloseTo(0.75);
  });

  it('adds to an existing row rather than replacing it', async () => {
    // The UPSERT's `DO UPDATE SET x = x + excluded.x`. A plain INSERT OR REPLACE here would
    // make every hour's count equal to whatever the last flush happened to contain, and the
    // posteriors would track the most recent ten seconds of traffic for ever.
    const stub = freshSurface();

    await stub.record([fold({ impressions: 2, signups: 1 })]);
    await stub.countersBetween(HOUR, HOUR); // forces a flush
    await stub.record([fold({ impressions: 5, signups: 2 })]);

    const rows = await stub.countersBetween(HOUR, HOUR);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.impressions).toBe(7);
    expect(rows[0]?.signups).toBe(3);
  });

  it('keeps variants, context buckets and the holdout flag apart', async () => {
    const stub = freshSurface();

    await stub.record([
      fold({ variantId: 'a', impressions: 1 }),
      fold({ variantId: 'b', impressions: 2 }),
      fold({ variantId: 'a', contextBucket: 'desktop:direct', impressions: 4 }),
      fold({ variantId: 'a', isHoldout: true, impressions: 8 }),
    ]);

    const rows = await stub.countersBetween(HOUR, HOUR);

    expect(rows).toHaveLength(4);
    expect(rows.reduce((sum: number, r) => sum + r.impressions, 0)).toBe(15);
  });

  it('keeps hours apart, because the engine decays by hour', async () => {
    const stub = freshSurface();
    const earlier = HOUR - 3_600_000;

    await stub.record([fold({ hourStart: earlier, impressions: 10 }), fold({ impressions: 1 })]);

    expect(await stub.countersBetween(earlier, earlier)).toHaveLength(1);
    expect((await stub.countersBetween(earlier, HOUR)).length).toBe(2);
    expect((await stub.countersBetween(HOUR, HOUR))[0]?.impressions).toBe(1);
  });

  it('keeps surfaces apart, which is the point of one object per surface', async () => {
    const first = freshSurface();
    const second = freshSurface();

    await first.record([fold({ impressions: 1 })]);

    expect(await second.countersBetween(HOUR, HOUR)).toEqual([]);
  });
});

describe('the flush', () => {
  it('happens before a read, so a reader never misses what is pending', async () => {
    // The bias this prevents is the dangerous kind: counts in flight belong
    // disproportionately to the busiest surfaces, so dropping them would under-count
    // exactly where the evidence is strongest.
    const stub = freshSurface();
    await stub.record([fold({ impressions: 1 })]);

    // Inspected from inside the object: the row is in SQLite by the time the read returns,
    // which is only true because `countersBetween` flushes first.
    const rows = await stub.countersBetween(HOUR, HOUR);
    expect(rows[0]?.impressions).toBe(1);

    await runInDurableObject(stub, (instance, state) => {
      const stored = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM counters')
        .one();
      expect(stored.n).toBe(1);
      expect(instance).toBeDefined();
    });
  });

  it('leaves nothing pending after it runs', async () => {
    const stub = freshSurface();
    await stub.record([fold({ impressions: 1 })]);
    await stub.countersBetween(HOUR, HOUR);

    // A pending map that is not cleared would double-count on the next flush, and the
    // error would compound every ten seconds rather than showing up once.
    await stub.record([fold({ impressions: 1 })]);
    const rows = await stub.countersBetween(HOUR, HOUR);

    expect(rows[0]?.impressions).toBe(2);
  });

  it('schedules exactly one alarm across many records', async () => {
    // `setAlarm` replaces rather than stacks, so calling it on every record would push the
    // flush ten seconds further away on every write — and a surface under continuous load
    // would never flush at all, turning the in-memory map into the real store. This is the
    // property that bounds the eviction window, and it is not observable without a real
    // scheduler.
    const stub = freshSurface();

    await stub.record([fold()]);
    const first = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

    await stub.record([fold()]);
    await stub.record([fold()]);
    const later = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

    expect(first).not.toBeNull();
    expect(later).toBe(first);
  });

  it('writes the pending counts when the alarm runs', async () => {
    const stub = freshSurface();
    await stub.record([fold({ impressions: 4 })]);

    // Run the handler directly rather than waiting ten seconds of wall clock.
    // Run the handler directly rather than waiting ten seconds of wall clock. The
    // instance is the real object, so this is the same code the scheduler would call.
    await runInDurableObject(stub, (instance) => {
      instance.alarm();
    });

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ impressions: number }>('SELECT impressions FROM counters')
        .one();
      expect(row.impressions).toBe(4);
    });
  });
});

describe('retention', () => {
  it('removes hours before the cutoff and reports how many', async () => {
    const stub = freshSurface();
    const old = HOUR - 100 * 3_600_000;

    await stub.record([fold({ hourStart: old }), fold()]);

    const removed = await stub.pruneBefore(HOUR);

    expect(removed).toBe(1);
    expect(await stub.countersBetween(old, HOUR)).toHaveLength(1);
  });

  it('removes nothing when there is nothing old enough', async () => {
    const stub = freshSurface();
    await stub.record([fold()]);

    expect(await stub.pruneBefore(HOUR)).toBe(0);
  });
});
