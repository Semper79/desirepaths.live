/**
 * `SessionAggregate`, in workerd — the piece that decides a session is over.
 *
 * The fold rules themselves are pure and tested exhaustively in
 * `packages/core/test/session-fold.test.ts`. What cannot be tested there is the part that
 * makes them useful: that the state survives between beacons, that the inactivity deadline
 * moves with activity instead of firing on schedule, that the alarm fans the components out
 * to the right surface objects, and that the session then stops existing.
 *
 * Those are all properties of the runtime. In particular the deadline: `setAlarm` replaces
 * rather than stacks, which is the behaviour `SurfaceCounters` must avoid relying on and
 * this object depends on entirely. Same API, opposite correct use, and only one of them can
 * be demonstrated with a fake.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { FoldableEvent } from '@morph/core';
import { SESSION_TIMEOUT_MS } from '../../src/session';

const T0 = Date.UTC(2026, 9, 21, 10, 30, 0);

function event(over: Partial<FoldableEvent> = {}): FoldableEvent {
  return {
    type: 'page_view',
    ts: T0,
    value: 0,
    surfaces: ['hero.headline'],
    variants: ['hero.headline#v0'],
    assignmentHash: '12345',
    holdout: 0,
    botScore: 0,
    contextBucket: 'phone|social|2',
    isReturning: false,
    ...over,
  };
}

let session = 0;
function freshSession() {
  session += 1;
  const name = `session-${String(session)}`;
  return env.SESSIONS.get(env.SESSIONS.idFromName(name));
}

function surface(name: string) {
  return env.COUNTERS.get(env.COUNTERS.idFromName(name));
}

/** The hour `startedAt` falls in, which is where the components land. */
const HOUR = Math.floor(T0 / 3_600_000) * 3_600_000;

describe('accumulating a session', () => {
  it('keeps state between beacons', async () => {
    // The reason this is an object and not a pure function: a session spans requests, and
    // in-memory accumulation in a Worker would forget it between them.
    const stub = freshSession();

    await stub.record([event()]);
    await stub.record([event({ type: 'engagement', value: 9000 })]);

    const state = await stub.state();
    expect(state.pageviews).toBe(1);
    expect(state.engagedMs).toBe(9000);
  });

  it('ignores an empty batch rather than arming a deadline for nothing', async () => {
    const stub = freshSession();
    await stub.record([]);

    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });

  it('moves the deadline forward on every beacon', async () => {
    // The opposite of the counters' rule, and the thing a fake cannot show. Each event is
    // activity, so the inactivity deadline has to move — an object that armed its alarm
    // once would close a session that was still being used.
    const stub = freshSession();

    await stub.record([event()]);
    const first = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

    await stub.record([event()]);
    const second = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second as number).toBeGreaterThanOrEqual(first as number);
  });

  it('arms the deadline a session timeout away', async () => {
    const stub = freshSession();
    const before = Date.now();
    await stub.record([event()]);

    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

    expect(alarm as number).toBeGreaterThanOrEqual(before + SESSION_TIMEOUT_MS);
  });
});

describe('closing a session', () => {
  it('hands its components to the surface it saw', async () => {
    const stub = freshSession();
    await stub.record([
      event({ surfaces: ['s-a'], variants: ['s-a#v1'] }),
      event({ type: 'signup_complete' }),
    ]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const rows = await surface('s-a').countersBetween(HOUR, HOUR);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.variantId).toBe('s-a#v1');
    expect(rows[0]?.impressions).toBe(1);
    expect(rows[0]?.signups).toBe(1);
    expect(rows[0]?.contextBucket).toBe('phone|social|2');
  });

  it('fans out to every surface the session saw, with one call each', async () => {
    const stub = freshSession();
    await stub.record([
      event({ surfaces: ['s-b', 's-c'], variants: ['s-b#v0', 's-c#v0'] }),
      event({ type: 'engagement', value: 20_000 }),
    ]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // One sign-up-free but engaged session, counted once for each surface. Not
    // double-counting: a surface's posterior asks whether sessions that saw this variant
    // engaged, which needs the session present in both.
    for (const name of ['s-b', 's-c']) {
      const rows = await surface(name).countersBetween(HOUR, HOUR);
      expect(rows, name).toHaveLength(1);
      expect(rows[0]?.engagedSessions, name).toBe(1);
    }
  });

  it('files the components under the hour the session started in', async () => {
    // Not the hour it ended. An hour's traffic is the sessions that began in it, and a
    // session's hour must not move as it continues — otherwise a long session would leave
    // the window the adapt cycle had already read.
    const stub = freshSession();
    const earlier = HOUR - 3_600_000;

    await stub.record([
      event({ ts: earlier + 1000, surfaces: ['s-d'], variants: ['s-d#v0'] }),
      event({ ts: T0, surfaces: ['s-d'], variants: ['s-d#v0'] }),
    ]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expect(await surface('s-d').countersBetween(earlier, earlier)).toHaveLength(1);
    expect(await surface('s-d').countersBetween(HOUR, HOUR)).toHaveLength(0);
  });

  it('deletes itself, so the object count stays bounded', async () => {
    // A session object exists for the length of a session plus the timeout. Without this
    // every visitor would leave one behind for ever.
    const stub = freshSession();
    await stub.record([event({ surfaces: ['s-e'], variants: ['s-e#v0'] })]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const state = await stub.state();
    expect(state.pageviews).toBe(0);
  });

  it('writes nothing for a bot, and still cleans up', async () => {
    const stub = freshSession();
    await stub.record([event({ surfaces: ['s-f'], variants: ['s-f#v0'], botScore: 99 })]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expect(await surface('s-f').countersBetween(HOUR, HOUR)).toEqual([]);
    expect((await stub.state()).pageviews).toBe(0);
  });

  it('writes nothing when the assignment changed mid-session', async () => {
    // D36's divergence from the ClickHouse fold, end to end: there is no honest answer to
    // which variant earned a sign-up that happened after the variant changed, so the
    // session contributes nothing rather than being credited to whichever came first.
    const stub = freshSession();
    await stub.record([
      event({ surfaces: ['s-g'], variants: ['s-g#v0'], assignmentHash: '111' }),
      event({ surfaces: ['s-g'], variants: ['s-g#v1'], assignmentHash: '222' }),
      event({ type: 'signup_complete', assignmentHash: '222' }),
    ]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expect(await surface('s-g').countersBetween(HOUR, HOUR)).toEqual([]);
  });

  it('accumulates across two sessions that saw the same variant', async () => {
    // The end-to-end property the whole chain exists for: separate sessions, separate
    // objects, one posterior.
    const first = freshSession();
    const second = freshSession();

    for (const stub of [first, second]) {
      await stub.record([event({ surfaces: ['s-h'], variants: ['s-h#v0'] })]);
      await runInDurableObject(stub, async (instance) => {
        await instance.alarm();
      });
    }

    const rows = await surface('s-h').countersBetween(HOUR, HOUR);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.impressions).toBe(2);
  });
});

describe('a beacon arriving after the session closed', () => {
  it('is accepted rather than throwing on a dropped table', async () => {
    // The bug this file found. `alarm` ends with `deleteAll()`, which removes the schema
    // along with the row, and the constructor does not run again — so the next beacon hit
    // "no such table: fold" and the collector would have answered 503.
    //
    // Not hypothetical: an offline queue replays events minutes or hours late, which is
    // what `ingestLagMs`'s long tail is for, and thirty minutes is well inside it.
    const stub = freshSession();
    await stub.record([event({ surfaces: ['s-i'], variants: ['s-i#v0'] })]);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    await expect(
      stub.record([event({ ts: T0 + SESSION_TIMEOUT_MS + 1000 })]),
    ).resolves.toBeUndefined();

    expect((await stub.state()).pageviews).toBe(1);
  });

  it('starts a fresh session rather than resurrecting the old one', async () => {
    // The late events are a new session as far as the counters are concerned, because the
    // old one has already been folded and handed on. Counting them into the same state
    // would attribute them twice.
    const stub = freshSession();
    await stub.record([event({ surfaces: ['s-j'], variants: ['s-j#v0'] })]);
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    await stub.record([event({ surfaces: ['s-j'], variants: ['s-j#v0'] })]);
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const rows = await surface('s-j').countersBetween(HOUR, HOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.impressions).toBe(2);
  });
});
