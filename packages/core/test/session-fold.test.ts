/**
 * The session fold, which is what the posteriors are actually built from.
 *
 * Every number in `/proof` traces back through here, so these cases are about the ways a
 * fold can be wrong while looking right: a denominator inflated by chatty clients, a
 * session counted in the wrong posterior cell because a later beacon overwrote its context,
 * a bot admitted because it looked human on its first event, and a reward credited to a
 * variant that was not on screen when it was earned.
 */

import { describe, expect, it } from 'vitest';
import {
  componentsFor,
  emptySession,
  foldEvent,
  isAttributable,
  type FoldableEvent,
  type SessionState,
} from '../src/session-fold.js';

const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);

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

/** Fold a list in order, which is how a live session arrives. */
function foldAll(events: readonly FoldableEvent[]): SessionState {
  return events.reduce(foldEvent, emptySession());
}

describe('merging events', () => {
  it('counts pageviews and leaves other event types out of the count', () => {
    const state = foldAll([
      event(),
      event({ type: 'engagement', value: 4000 }),
      event({ type: 'scroll_depth', value: 40 }),
      event(),
    ]);

    expect(state.pageviews).toBe(2);
  });

  it('counts an impression per pageview, not per event', () => {
    // The denominator of every posterior. Counting engagement pings here would inflate it
    // in proportion to how chatty the client is, which would make a variant look worse the
    // more the visitor interacted with it.
    const state = foldAll([
      event(),
      event({ type: 'engagement', value: 9000 }),
      event({ type: 'share' }),
    ]);

    expect(state.impressions['hero.headline\u0000hero.headline#v0']).toBe(1);
  });

  it('takes the maximum scroll depth, not the last', () => {
    const state = foldAll([
      event({ type: 'scroll_depth', value: 80 }),
      event({ type: 'scroll_depth', value: 20 }),
    ]);

    expect(state.maxScrollPct).toBe(80);
  });

  it('sums engagement across beacons', () => {
    const state = foldAll([
      event({ type: 'engagement', value: 6000 }),
      event({ type: 'engagement', value: 7000 }),
    ]);

    expect(state.engagedMs).toBe(13_000);
  });

  it('latches a sign-up and a share', () => {
    const state = foldAll([event(), event({ type: 'signup_complete' }), event()]);

    expect(state.signedUp).toBe(true);
    expect(state.shared).toBe(false);
  });

  it('keeps the context of the first event, not the last', () => {
    // A session's device and referrer class are properties of how it began. Letting a
    // later beacon overwrite them would move the session between posterior cells depending
    // on which one happened to arrive last.
    const state = foldAll([
      event({ contextBucket: 'phone|social|2' }),
      event({ contextBucket: 'desktop|direct|0' }),
    ]);

    expect(state.contextBucket).toBe('phone|social|2');
  });

  it('takes the worst bot score, not the first', () => {
    // A client that looks human on its first beacon and like a crawler on its fifth is a
    // crawler. Exclusion is the cheap direction to be wrong in.
    const state = foldAll([event({ botScore: 0 }), event({ botScore: 95 })]);

    expect(state.botScore).toBe(95);
    expect(isAttributable(state)).toBe(false);
  });

  it('does not care what order the events arrive in', () => {
    // The property that lets a session cost a handful of scalars instead of a list of its
    // events: every aggregation is min, max, sum or any. If this ever fails, the fold has
    // grown an order dependency and one Durable Object per session stops being enough.
    const events = [
      event({ ts: T0 }),
      event({ type: 'engagement', value: 8000, ts: T0 + 1000 }),
      event({ type: 'scroll_depth', value: 55, ts: T0 + 2000 }),
      event({ type: 'signup_complete', ts: T0 + 3000 }),
      event({ ts: T0 + 4000 }),
    ];

    const forwards = foldAll(events);
    const backwards = foldAll([...events].reverse());

    // `contextBucket`, `assignmentHash`, `isHoldout` and `isReturning` are `any`-style and
    // identical across these events, so every field should match.
    expect(backwards).toEqual(forwards);
  });

  it('records the first and last timestamps', () => {
    const state = foldAll([event({ ts: T0 + 5000 }), event({ ts: T0 }), event({ ts: T0 + 2000 })]);

    expect(state.startedAt).toBe(T0);
    expect(state.endedAt).toBe(T0 + 5000);
  });
});

describe('an assignment that changed mid-session', () => {
  it('is detected', () => {
    const state = foldAll([event({ assignmentHash: '111' }), event({ assignmentHash: '222' })]);

    expect(state.assignmentChanged).toBe(true);
  });

  it('is not detected when the assignment is stable', () => {
    const state = foldAll([event({ assignmentHash: '111' }), event({ assignmentHash: '111' })]);

    expect(state.assignmentChanged).toBe(false);
  });

  it('makes the session contribute nothing', () => {
    // The divergence from `mv_sessions`, which took `anyState(surfaces)` and credited the
    // whole session to whichever assignment `any` happened to return. There is no honest
    // answer to which variant earned a sign-up that happened after the variant changed, so
    // the session is dropped rather than guessed at.
    const state = foldAll([
      event({ assignmentHash: '111', variants: ['hero.headline#v0'] }),
      event({ type: 'signup_complete', assignmentHash: '222' }),
      event({ assignmentHash: '222', variants: ['hero.headline#v1'] }),
    ]);

    expect(isAttributable(state)).toBe(false);
    expect(componentsFor(state)).toEqual([]);
  });
});

describe('the components a session contributes', () => {
  it('gives every surface the same session-level values', () => {
    // Not double-counting: a surface's posterior answers "did sessions that saw this
    // variant convert", which needs the session to appear once in every surface it was
    // part of.
    const state = foldAll([
      event({
        surfaces: ['hero.headline', 'cta.label'],
        variants: ['hero.headline#v0', 'cta.label#v2'],
      }),
      event({ type: 'signup_complete' }),
    ]);

    const rows = componentsFor(state);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.signups === 1)).toBe(true);
    expect(rows.map((r) => r.surfaceId).sort()).toEqual(['cta.label', 'hero.headline']);
  });

  it('marks a session engaged on time alone', () => {
    const state = foldAll([event(), event({ type: 'engagement', value: 15_000 })]);

    expect(componentsFor(state)[0]?.engagedSessions).toBe(1);
  });

  it('marks a session engaged on a second pageview alone', () => {
    const state = foldAll([event(), event()]);

    expect(componentsFor(state)[0]?.engagedSessions).toBe(1);
  });

  it('marks a single quick pageview as a bounce', () => {
    const state = foldAll([event(), event({ type: 'engagement', value: 1000 })]);

    const row = componentsFor(state)[0];
    expect(row?.bounces).toBe(1);
    expect(row?.engagedSessions).toBe(0);
  });

  it('does not call a second pageview a bounce', () => {
    const state = foldAll([event(), event()]);

    expect(componentsFor(state)[0]?.bounces).toBe(0);
  });

  it('normalises scroll depth into zero-to-one, and clamps it', () => {
    const half = foldAll([event(), event({ type: 'scroll_depth', value: 50 })]);
    expect(componentsFor(half)[0]?.scrollNormSum).toBeCloseTo(0.5);

    // A client reporting 140% is a client with a bug, and an unclamped value would drag a
    // variant's mean reward above what the weights can produce.
    const absurd = foldAll([event(), event({ type: 'scroll_depth', value: 140 })]);
    expect(componentsFor(absurd)[0]?.scrollNormSum).toBe(1);
  });

  it('carries the holdout flag through', () => {
    const state = foldAll([event({ holdout: 1 })]);

    expect(componentsFor(state)[0]?.isHoldout).toBe(true);
  });

  it('returns nothing for a bot, rather than a row of zeroes', () => {
    // A zeroed row would enter the posteriors as evidence that a session saw the variant
    // and converted nothing — a claim about a bot rather than the absence of one.
    const state = foldAll([event({ botScore: 99 })]);

    expect(componentsFor(state)).toEqual([]);
  });

  it('returns nothing for a session with no pageview', () => {
    // A beacon carrying only an engagement ping, which happens when a page is restored
    // from the back-forward cache. There is no impression to attribute it to.
    const state = foldAll([event({ type: 'engagement', value: 20_000 })]);

    expect(isAttributable(state)).toBe(false);
    expect(componentsFor(state)).toEqual([]);
  });

  it('returns nothing for an empty session', () => {
    expect(componentsFor(emptySession())).toEqual([]);
  });
});
