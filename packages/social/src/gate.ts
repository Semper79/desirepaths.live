/**
 * May we act on this platform, right now?
 *
 * One question, four independent reasons the answer can be no, and every one of them
 * failing closed. Pure: the clock is a parameter and the state is passed in and returned,
 * so "the breaker opened at 14:02 and it is now 14:31, may we retry" is a test rather than
 * a thirty-minute wait.
 *
 * THE FOUR GATES, IN THE ORDER THEY ARE CHECKED
 *
 *   1. Verification — nobody has read this platform's limits from its own documentation.
 *      Checked first because it is a statement about our diligence rather than about the
 *      platform's mood, and no amount of waiting fixes it.
 *
 *   2. Circuit breaker — the platform has been telling us to stop. Checked before the
 *      bucket because a breaker opens on 429 and 403, and continuing to spend tokens
 *      against a service that is refusing us is how a rate limit becomes a ban.
 *
 *   3. Daily cap — we have done enough today. This is our own ceiling, far below the
 *      platform's, and it does not reset on a rolling window but on a calendar day in the
 *      operator's timezone, because that is how the platforms count.
 *
 *   4. Token bucket — the sustained rate. Last, because it is the only one whose answer
 *      changes on the timescale of seconds.
 *
 * WHAT THIS PACKAGE DELIBERATELY CANNOT DO
 * There is no path here that retries around a refusal, rotates an identity, or spreads
 * load across accounts. `CLAUDE.md` forbids those, and the shape of this module is the
 * enforcement: `decide` returns a delay or a refusal, never an alternative route. A caller
 * that wants to act sooner has exactly one option, which is to wait.
 */

import { PLATFORM_LIMITS, type Platform, type PlatformLimit } from './limits.js';

export interface BreakerState {
  /** Consecutive failures since the last success. */
  readonly consecutiveFailures: number;
  /** When the breaker opened, or null while it is closed. */
  readonly openedAt: number | null;
  /**
   * Earliest time the platform said we may return, from a `Retry-After` header.
   *
   * Held separately from the breaker's own cooldown and always respected in full: a
   * platform telling us when to come back is the most authoritative signal available, and
   * treating it as advice is the behaviour that gets an application banned rather than
   * throttled.
   */
  readonly retryAfter: number | null;
}

export interface BucketState {
  readonly tokens: number;
  readonly updatedAt: number;
}

export interface PlatformState {
  readonly breaker: BreakerState;
  readonly bucket: BucketState;
  /** Actions taken on the current calendar day, and which day that is. */
  readonly usedToday: number;
  readonly day: string;
}

export type Refusal =
  | { readonly kind: 'unverified' }
  | { readonly kind: 'breaker_open'; readonly retryAtMs: number }
  | { readonly kind: 'daily_cap'; readonly used: number; readonly cap: number }
  | { readonly kind: 'rate'; readonly retryAtMs: number };

export type Decision =
  | { readonly allowed: true; readonly state: PlatformState }
  | { readonly allowed: false; readonly refusal: Refusal };

/**
 * How long the breaker stays open, and how it grows.
 *
 * Doubling per consecutive failure from one minute, capped at an hour. The cap exists
 * because an unbounded backoff eventually becomes indistinguishable from a broken
 * connector — an operator should be able to tell "the platform is refusing us" from "this
 * has been dead since Tuesday" without reading a log.
 */
const BREAKER_BASE_MS = 60_000;
const BREAKER_MAX_MS = 3_600_000;
const FAILURES_BEFORE_OPEN = 3;

export function breakerCooldownMs(consecutiveFailures: number): number {
  const doublings = Math.max(0, consecutiveFailures - FAILURES_BEFORE_OPEN);
  return Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** doublings);
}

/** The calendar day an instant falls in, in a named timezone. */
export function dayOf(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

export function initialState(now: number, timeZone: string, platform: Platform): PlatformState {
  return {
    breaker: { consecutiveFailures: 0, openedAt: null, retryAfter: null },
    bucket: { tokens: PLATFORM_LIMITS[platform].capacity, updatedAt: now },
    usedToday: 0,
    day: dayOf(now, timeZone),
  };
}

function refill(state: BucketState, now: number, limit: PlatformLimit): BucketState {
  const elapsedSeconds = Math.max(0, now - state.updatedAt) / 1000;
  const tokens = Math.min(limit.capacity, state.tokens + elapsedSeconds * limit.refillPerSecond);

  return { tokens, updatedAt: now };
}

export interface DecideInput {
  readonly platform: Platform;
  readonly state: PlatformState;
  readonly now: number;
  readonly timeZone: string;
  /**
   * The limits to apply, defaulting to this platform's entry in `PLATFORM_LIMITS`.
   *
   * Injectable because the table is the one thing here that is genuinely data, and a pure
   * function that reaches for a module-level constant cannot be tested against anything
   * else. Every real entry is unverified by design, so without this seam the machinery
   * below would be unreachable from a test — and the alternative, mutating the shared
   * table for the duration of a case, is the kind of test-only mutation that eventually
   * leaks into a parallel run.
   *
   * Production callers omit it. `assertVerified` remains the separate, explicit guard.
   */
  readonly limit?: PlatformLimit;
}

/**
 * Ask, and get back either permission plus the new state, or a refusal with a reason.
 *
 * The state is returned rather than mutated so a caller that decides not to act — because
 * the approval queue rejected the post between asking and sending — has not silently
 * spent a token. Permission is only committed by using the state that comes back.
 */
export function decide(input: DecideInput): Decision {
  const { platform, now, timeZone } = input;
  const limit = input.limit ?? PLATFORM_LIMITS[platform];

  if (limit.verifiedAt === null) return { allowed: false, refusal: { kind: 'unverified' } };

  const breaker = input.state.breaker;

  // The platform's own instruction outranks our cooldown, in whichever direction is
  // longer. Coming back before it asked is the mistake that escalates a throttle.
  const openUntil =
    breaker.openedAt === null
      ? 0
      : breaker.openedAt + breakerCooldownMs(breaker.consecutiveFailures);
  const blockedUntil = Math.max(openUntil, breaker.retryAfter ?? 0);

  if (blockedUntil > now) {
    return { allowed: false, refusal: { kind: 'breaker_open', retryAtMs: blockedUntil } };
  }

  // A new calendar day resets the count. Not a rolling 24 hours: the platforms publish
  // their caps per day, and a rolling window would let us sit at the ceiling indefinitely
  // by drifting the start time.
  const today = dayOf(now, timeZone);
  const usedToday = input.state.day === today ? input.state.usedToday : 0;

  if (usedToday >= limit.dailyCap) {
    return {
      allowed: false,
      refusal: { kind: 'daily_cap', used: usedToday, cap: limit.dailyCap },
    };
  }

  const bucket = refill(input.state.bucket, now, limit);
  if (bucket.tokens < 1) {
    const deficit = 1 - bucket.tokens;
    // A refill rate of zero means the connector is read-only, and no amount of waiting
    // produces a token. Reported as an unreachable time rather than as Infinity, which
    // formats badly everywhere it would be shown.
    const waitMs =
      limit.refillPerSecond > 0 ? (deficit / limit.refillPerSecond) * 1000 : BREAKER_MAX_MS;

    return { allowed: false, refusal: { kind: 'rate', retryAtMs: now + waitMs } };
  }

  return {
    allowed: true,
    state: {
      breaker: { consecutiveFailures: 0, openedAt: null, retryAfter: breaker.retryAfter },
      bucket: { tokens: bucket.tokens - 1, updatedAt: now },
      usedToday: usedToday + 1,
      day: today,
    },
  };
}

/** A platform accepted the call. Closes the breaker and clears any instruction to wait. */
export function recordSuccess(state: PlatformState): PlatformState {
  return {
    ...state,
    breaker: { consecutiveFailures: 0, openedAt: null, retryAfter: null },
  };
}

export interface FailureInput {
  readonly state: PlatformState;
  readonly now: number;
  /** HTTP status, when there was one. */
  readonly status?: number | undefined;
  /** Milliseconds the platform asked us to wait, parsed from `Retry-After`. */
  readonly retryAfterMs?: number | undefined;
}

/**
 * A platform refused, errored, or timed out.
 *
 * 429 and 403 open the breaker immediately rather than after three strikes. Both are the
 * platform saying "stop", and the difference between them — too fast, versus not allowed —
 * does not change what we should do next, which is stop.
 */
export function recordFailure(input: FailureInput): PlatformState {
  const previous = input.state.breaker;
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const immediate = input.status === 429 || input.status === 403;
  const opened = immediate || consecutiveFailures >= FAILURES_BEFORE_OPEN;

  return {
    ...input.state,
    breaker: {
      consecutiveFailures: immediate
        ? Math.max(consecutiveFailures, FAILURES_BEFORE_OPEN)
        : consecutiveFailures,
      openedAt: opened ? input.now : previous.openedAt,
      retryAfter:
        input.retryAfterMs === undefined
          ? previous.retryAfter
          : Math.max(previous.retryAfter ?? 0, input.now + input.retryAfterMs),
    },
  };
}

/** A refusal, in the words the operator sees in the hourly report. */
export function explain(refusal: Refusal, platform: Platform): string {
  switch (refusal.kind) {
    case 'unverified':
      return `${platform}: rate limits never verified against the platform's own documentation.`;
    case 'breaker_open':
      return `${platform}: circuit open until ${new Date(refusal.retryAtMs).toISOString()}.`;
    case 'daily_cap':
      return `${platform}: daily cap reached (${String(refusal.used)} of ${String(refusal.cap)}).`;
    case 'rate':
      return `${platform}: rate limited until ${new Date(refusal.retryAtMs).toISOString()}.`;
  }
}
