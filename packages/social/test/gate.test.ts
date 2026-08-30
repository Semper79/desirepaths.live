/**
 * The outbound gate.
 *
 * These tests are the compliance position. `docs/COMPLIANCE.md` claims a token bucket
 * seeded with documented limits, backoff that honours `Retry-After`, a breaker that opens
 * on 429 and 403, and a daily cap well below every platform ceiling — and a claim in a
 * document that no test enforces is a claim that quietly stops being true.
 *
 * Time is a parameter throughout, so "the breaker opened at 14:02, may we retry at 14:31"
 * is a case rather than a thirty-minute wait.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLATFORMS,
  PLATFORM_LIMITS,
  UnverifiedPlatformError,
  assertVerified,
  breakerCooldownMs,
  dayOf,
  decide,
  explain,
  initialState,
  recordFailure,
  recordSuccess,
  verifiedPlatforms,
  type Platform,
  type PlatformState,
} from '../src/index.js';

const TZ = 'Europe/Rome';
const NOON = Date.parse('2026-08-30T12:00:00Z');

/**
 * A platform treated as verified, for the cases that are about the machinery.
 *
 * Every real entry is unverified and must stay that way until a human reads the platform's
 * documentation — so the tests below fake verification rather than weakening the check
 * that enforces it.
 */
function verified(platform: Platform = 'discord'): {
  platform: Platform;
  state: PlatformState;
} {
  return { platform, state: initialState(NOON, TZ, platform) };
}

/**
 * `decide` against a verified copy of a platform's real limits.
 *
 * The numbers are the production ones; only `verifiedAt` is filled in. That keeps these
 * cases about the machinery — buckets, breakers, the daily cap — while leaving the real
 * table honestly unverified, which is what the first describe block asserts.
 */
function allow(platform: Platform, state: PlatformState, now: number) {
  const limit = { ...PLATFORM_LIMITS[platform], verifiedAt: '2026-08-30' };
  return decide({ platform, state, now, timeZone: TZ, limit });
}

describe('verification', () => {
  it('refuses every platform nobody has checked', () => {
    // The honest state today. If this test ever starts failing because a platform was
    // verified, the same commit must update the date in docs/COMPLIANCE.md.
    expect(verifiedPlatforms()).toEqual([]);

    for (const platform of PLATFORMS) {
      expect(() => {
        assertVerified(platform);
      }).toThrow(UnverifiedPlatformError);
    }
  });

  it('refuses to act rather than acting on numbers nobody read', () => {
    const { platform, state } = verified();
    const decision = decide({ platform, state, now: NOON, timeZone: TZ });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal.kind).toBe('unverified');
  });
});

describe('the daily cap', () => {
  it('stops well short of every documented platform ceiling', () => {
    // The gap is the design. Operating at 95% of a published limit makes every retry an
    // overage; operating at 40% means none of them are.
    for (const platform of PLATFORMS) {
      const limit = PLATFORM_LIMITS[platform];
      expect(limit.dailyCap, platform).toBeLessThanOrEqual(40);
    }
  });

  it('refuses once the day is spent', () => {
    const { platform } = verified();
    const cap = PLATFORM_LIMITS[platform].dailyCap;
    const spent: PlatformState = {
      ...initialState(NOON, TZ, platform),
      usedToday: cap,
      day: dayOf(NOON, TZ),
    };

    const decision = allow(platform, spent, NOON);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.kind).toBe('daily_cap');
      expect(explain(decision.refusal, platform)).toContain('daily cap');
    }
  });

  it('resets on a calendar day rather than on a rolling window', () => {
    // A rolling 24 hours would let the system sit permanently at the ceiling by drifting
    // its start time. The platforms count in days, so this does too.
    const { platform } = verified();
    const spent: PlatformState = {
      ...initialState(NOON, TZ, platform),
      usedToday: PLATFORM_LIMITS[platform].dailyCap,
      day: dayOf(NOON, TZ),
    };

    const tomorrow = NOON + 24 * 3_600_000;
    const decision = allow(platform, spent, tomorrow);

    expect(decision.allowed).toBe(true);
  });

  it('counts the day in the operator timezone, not in UTC', () => {
    // 23:30 UTC is already tomorrow in Rome. Getting this wrong would give the system a
    // second daily allowance in the two hours around midnight.
    const lateUtc = Date.parse('2026-08-30T23:30:00Z');

    expect(dayOf(lateUtc, 'Europe/Rome')).toBe('2026-08-31');
    expect(dayOf(lateUtc, 'UTC')).toBe('2026-08-30');
  });
});

describe('the circuit breaker', () => {
  it('opens immediately on a 429, without waiting for three strikes', () => {
    // 429 and 403 are the platform saying stop. The difference between "too fast" and
    // "not allowed" does not change what we should do, which is stop.
    const { platform, state } = verified();
    const after = recordFailure({ state, now: NOON, status: 429 });

    expect(after.breaker.openedAt).toBe(NOON);

    const decision = allow(platform, after, NOON + 1_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal.kind).toBe('breaker_open');
  });

  it('tolerates two transient failures before opening', () => {
    const { platform, state } = verified();
    let current = recordFailure({ state, now: NOON });
    current = recordFailure({ state: current, now: NOON + 1_000 });

    expect(current.breaker.openedAt).toBeNull();
    expect(allow(platform, current, NOON + 2_000).allowed).toBe(true);
  });

  it('backs off further on each consecutive failure, up to an hour', () => {
    expect(breakerCooldownMs(3)).toBe(60_000);
    expect(breakerCooldownMs(4)).toBe(120_000);
    expect(breakerCooldownMs(5)).toBe(240_000);

    // Capped, because an unbounded backoff eventually looks identical to a dead
    // connector, and an operator should be able to tell those apart without a log.
    expect(breakerCooldownMs(50)).toBe(3_600_000);
  });

  it('honours Retry-After in full, even past its own cooldown', () => {
    // A platform telling us when to come back is the most authoritative signal there is.
    // Treating it as advice is what turns a throttle into a ban.
    const { platform, state } = verified();
    const after = recordFailure({
      state,
      now: NOON,
      status: 429,
      retryAfterMs: 6 * 3_600_000,
    });

    // Long past the breaker's own one-minute cooldown, and still refused.
    const decision = allow(platform, after, NOON + 3_600_000);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed && decision.refusal.kind === 'breaker_open') {
      expect(decision.refusal.retryAtMs).toBe(NOON + 6 * 3_600_000);
    }
  });

  it('closes on a success and forgets the instruction to wait', () => {
    const { state } = verified();
    const failed = recordFailure({ state, now: NOON, status: 429, retryAfterMs: 60_000 });
    const recovered = recordSuccess(failed);

    expect(recovered.breaker.openedAt).toBeNull();
    expect(recovered.breaker.consecutiveFailures).toBe(0);
    expect(recovered.breaker.retryAfter).toBeNull();
  });
});

describe('the token bucket', () => {
  it('spends a token per action and refuses when empty', () => {
    const { platform } = verified();
    let state = initialState(NOON, TZ, platform);

    for (let i = 0; i < PLATFORM_LIMITS[platform].capacity; i += 1) {
      const decision = allow(platform, state, NOON);
      expect(decision.allowed, `action ${String(i)}`).toBe(true);
      if (decision.allowed) state = decision.state;
    }

    const exhausted = allow(platform, state, NOON);
    expect(exhausted.allowed).toBe(false);
    if (!exhausted.allowed) expect(exhausted.refusal.kind).toBe('rate');
  });

  it('does not spend a token on a decision the caller never uses', () => {
    // The approval queue can reject a post between asking and sending. Returning the new
    // state rather than mutating means declining to act costs nothing.
    const { platform, state } = verified();

    allow(platform, state, NOON);
    allow(platform, state, NOON);

    expect(state.bucket.tokens).toBe(PLATFORM_LIMITS[platform].capacity);
  });

  it('gives a read-only connector no way to post, however long it waits', () => {
    // YouTube is read-only at launch, expressed as a refill of zero rather than as a
    // small number. A connector that cannot post is safer than one that posts rarely.
    expect(PLATFORM_LIMITS.youtube.refillPerSecond).toBe(0);
    expect(PLATFORM_LIMITS.youtube.dailyCap).toBe(0);

    const state = initialState(NOON, TZ, 'youtube');
    const muchLater = NOON + 30 * 24 * 3_600_000;

    expect(allow('youtube', state, muchLater).allowed).toBe(false);
  });
});

describe('the compliance document', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const compliance = readFileSync(join(here, '..', '..', '..', 'docs', 'COMPLIANCE.md'), 'utf8');

  it('quotes the same daily caps the limiter enforces', () => {
    // A compliance claim in prose and a different number in code is worse than either
    // alone: the document is what a platform would be shown, and the code is what runs.
    for (const platform of PLATFORMS) {
      const cap = PLATFORM_LIMITS[platform].dailyCap;
      if (cap === 0) continue;

      expect(
        compliance.includes(`${String(cap)}/day`) ||
          compliance.includes(`${String(cap)} posts/day`) ||
          compliance.includes(`${String(cap)} messages/day`),
        `docs/COMPLIANCE.md does not mention the cap of ${String(cap)} enforced for ${platform}`,
      ).toBe(true);
    }
  });
});
