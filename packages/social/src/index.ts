/**
 * `@morph/social` — the outbound machinery, without any connectors.
 *
 * Everything here is platform-agnostic and pure: token buckets, a circuit breaker, the
 * daily cap, and the single `decide` that composes them. Connectors are thin adapters over
 * this, added one at a time as credentials arrive, and each one gets its `verifiedAt` set
 * only when a human has re-read that platform's published limits.
 *
 * WHAT THIS PACKAGE WILL NEVER CONTAIN
 * `CLAUDE.md`'s forbidden list is mostly about this area, so it is worth stating positively
 * rather than trusting it to be remembered:
 *
 *   - no automated account creation; MORPH acts only through accounts the operator made
 *     and authenticated through official OAuth
 *   - no proxy or identity rotation, no evasion of automation detection, no CAPTCHA
 *     solving, no session-cookie replay, no "humanisation" jitter  guardrail-ok: this
 *     line names the forbidden capabilities in order to rule them out, and it is the
 *     first thing anyone adding a connector here will read. The scanner cannot tell a
 *     prohibition from an implementation, so the marker says which this is.
 *   - no follow/unfollow churn, mass DMs, engagement pods, comment spraying, hashtag
 *     stuffing, or automated engagement with accounts that have not opted in
 *   - no stored platform passwords; OAuth tokens only, encrypted at rest
 *
 * The design enforces the second of those rather than merely promising it: `decide` returns
 * permission, a delay, or a refusal. It never returns an alternative route, because there
 * is no code path here that could produce one. A caller that wants to act sooner has
 * exactly one option, which is to wait.
 */

export {
  PLATFORMS,
  PLATFORM_LIMITS,
  UnverifiedPlatformError,
  assertVerified,
  verifiedPlatforms,
  type Platform,
  type PlatformLimit,
} from './limits';

export {
  breakerCooldownMs,
  dayOf,
  decide,
  explain,
  initialState,
  recordFailure,
  recordSuccess,
  type BreakerState,
  type BucketState,
  type Decision,
  type DecideInput,
  type FailureInput,
  type PlatformState,
  type Refusal,
} from './gate';
