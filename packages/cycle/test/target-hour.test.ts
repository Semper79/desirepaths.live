/**
 * Which hour a cycle is allowed to read.
 *
 * `targetHour` used to return the previous hour and nothing pinned that, which is why the
 * change slipped past twenty-five passing tests. It was correct while ClickHouse fed the
 * cycle — `surface_rewards_hourly` was a refreshable view over a trailing window, so an hour
 * was recomputed as its sessions closed. The Durable Object fold cannot recompute, so an
 * hour has to be settled before it is read (D36).
 *
 * The failure mode is the reason this has its own file. Reading too early does not drop a
 * random sample: the sessions that straddle an hour boundary are the long ones, which are
 * the engaged ones, so it under-counts exactly the evidence that decides a comparison. And
 * it would present as a variant performing worse rather than as a timing bug.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_TIMEOUT_MS } from '@morph/core';
import { targetHour } from '../src/derive.js';

const HOUR = 3_600_000;

/** `2026-10-21T11:00:00Z` and friends, so the arithmetic is readable. */
function at(hour: number, minute: number): number {
  return Date.UTC(2026, 9, 21, hour, minute, 0);
}

describe('targetHour', () => {
  it('returns an hour whose sessions have all had time to close', () => {
    // Hour 10 ends at 11:00. A session starting at 10:59:59 closes at 11:29:59, so hour 10
    // is only safe to read after that.
    expect(targetHour(at(11, 35))).toBe(at(10, 0));
  });

  it('does not return an hour that could still have an open session', () => {
    // At 11:25, hour 10 would settle five minutes later. Reading it now would miss whatever
    // is still in flight, so the cycle takes hour 9 instead.
    expect(targetHour(at(11, 25))).toBe(at(9, 0));
  });

  it('is exactly one hour behind the boundary it waits for', () => {
    const boundary = at(11, 0) + SESSION_TIMEOUT_MS;

    // One millisecond before the deadline, hour 10 is not available.
    expect(targetHour(boundary - 1)).toBe(at(9, 0));
    // At it, it is.
    expect(targetHour(boundary)).toBe(at(10, 0));
  });

  it('always lands on an hour boundary', () => {
    for (let minute = 0; minute < 180; minute += 7) {
      const result = targetHour(at(12, 0) + minute * 60_000);
      expect(result % HOUR, `minute ${String(minute)}`).toBe(0);
    }
  });

  it('never returns an hour that has not finished settling, for any clock', () => {
    // The property, rather than three examples of it: whatever the time, the hour returned
    // must have ended at least one session timeout ago.
    for (let offset = 0; offset < 6 * HOUR; offset += 137_000) {
      const now = at(0, 0) + offset;
      const hour = targetHour(now);
      const hourEnded = hour + HOUR;

      expect(hourEnded + SESSION_TIMEOUT_MS, `offset ${String(offset)}`).toBeLessThanOrEqual(now);
    }
  });

  it('advances monotonically', () => {
    // A cycle that went backwards would re-read a settled hour, and `posteriorState` would
    // refuse it as already applied — correct, but it would mean the engine quietly stopped
    // learning rather than failing.
    let previous = targetHour(at(0, 0));

    for (let offset = 0; offset < 12 * HOUR; offset += 211_000) {
      const current = targetHour(at(0, 0) + offset);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
