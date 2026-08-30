/**
 * What each platform says it allows, and the much smaller number we hold ourselves to.
 *
 * Transcribed from the table in `docs/COMPLIANCE.md`, which is the document a platform
 * would be shown if it ever asked. The two must agree, and `limits.test.ts` asserts they
 * do by reading that file — a compliance claim in prose and a different number in code is
 * the worst of both.
 *
 * THE GAP IS THE POINT
 * Every `dailyCap` here is far below the documented ceiling. Operating at 95% of a
 * published limit means every retry, every clock skew and every duplicate is an overage;
 * operating at 40% means none of them are. Hitting a documented limit is not an accident
 * to be recovered from, it is a signal that the system was designed too close to the line.
 *
 * THE `verified` FIELD IS NOT DECORATION
 * Every entry is currently unverified, and says so. The documented numbers below came from
 * platform documentation at the time `docs/COMPLIANCE.md` was written and **must be re-read
 * from each platform's developer console at the moment credentials are obtained**. A rate
 * limit copied from a blog post and trusted for a year is how an account gets suspended.
 * `assertVerified` exists so a deployment can refuse to post through an entry nobody has
 * checked.
 */

export const PLATFORMS = [
  'x',
  'instagram',
  'threads',
  'tiktok',
  'discord',
  'reddit',
  'youtube',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export interface PlatformLimit {
  readonly platform: Platform;
  /** Human-readable, quoted in the compliance document. */
  readonly documented: string;
  /**
   * Sustained request rate we allow ourselves, in requests per second.
   *
   * Not the platform's rate. This is the token bucket's refill, chosen so a burst plus a
   * retry storm still lands inside the documented ceiling.
   */
  readonly refillPerSecond: number;
  /** Burst allowance. Small on purpose: a burst is what a limiter is asked to forgive. */
  readonly capacity: number;
  /** Hard ceiling on actions per rolling day, well below the platform's own. */
  readonly dailyCap: number;
  /**
   * ISO date the documented limit was last read from the platform's own documentation, or
   * null when nobody has. Null means "do not post through this connector".
   */
  readonly verifiedAt: string | null;
}

/**
 * Deliberately conservative, and deliberately unverified.
 *
 * The refill rates are derived from the daily cap rather than from the platform's rate:
 * a cap of 40 posts a day spread evenly is one every 36 minutes, and there is no reason
 * for the limiter to permit anything faster. Bursting past that would only ever be a bug
 * or a queue draining after an outage, and both are cases where slower is correct.
 */
export const PLATFORM_LIMITS: Readonly<Record<Platform, PlatformLimit>> = {
  x: {
    platform: 'x',
    documented: '100 posts / 24 h per user; 60 reads / 15 min (API v2, Basic tier)',
    refillPerSecond: 40 / 86_400,
    capacity: 3,
    dailyCap: 40,
    verifiedAt: null,
  },
  instagram: {
    platform: 'instagram',
    documented: '50 content publishes / 24 h per account (Graph API)',
    refillPerSecond: 25 / 86_400,
    capacity: 2,
    dailyCap: 25,
    verifiedAt: null,
  },
  threads: {
    platform: 'threads',
    documented: '50 content publishes / 24 h per account (Graph API)',
    refillPerSecond: 25 / 86_400,
    capacity: 2,
    dailyCap: 25,
    verifiedAt: null,
  },
  tiktok: {
    platform: 'tiktok',
    documented: 'Per-app limits published in the developer console (Content Posting API)',
    refillPerSecond: 10 / 86_400,
    capacity: 2,
    dailyCap: 10,
    verifiedAt: null,
  },
  discord: {
    platform: 'discord',
    documented: 'Global 50 req/s; per-route buckets from response headers (Bot API)',
    refillPerSecond: 40 / 86_400,
    capacity: 5,
    dailyCap: 40,
    verifiedAt: null,
  },
  reddit: {
    platform: 'reddit',
    documented: '100 QPM per OAuth client, averaged over 10 min',
    refillPerSecond: 20 / 86_400,
    capacity: 2,
    dailyCap: 20,
    verifiedAt: null,
  },
  youtube: {
    platform: 'youtube',
    documented: '10,000 quota units/day; a read costs 1, an upload 1,600 (Data API v3)',
    // Read-only at launch, so the write cap is zero rather than small. A connector that
    // cannot post is safer than one that can post rarely, and this is the difference
    // between the two stated in a number the limiter enforces.
    refillPerSecond: 0,
    capacity: 0,
    dailyCap: 0,
    verifiedAt: null,
  },
};

export class UnverifiedPlatformError extends Error {
  constructor(readonly platform: Platform) {
    super(
      `Refusing to act on ${platform}: its rate limits have never been read from the platform's own documentation. Set verifiedAt in packages/social/src/limits.ts and update docs/COMPLIANCE.md with the same date.`,
    );
    this.name = 'UnverifiedPlatformError';
  }
}

/**
 * Refuse to act through a connector whose limits nobody has checked.
 *
 * The alternative is a deployment that posts happily against numbers transcribed from a
 * document written months earlier, discovers they moved, and finds out through an
 * enforcement action rather than through a 429. Failing closed costs a deploy; failing
 * open costs the account.
 */
export function assertVerified(platform: Platform): void {
  if (PLATFORM_LIMITS[platform].verifiedAt === null) {
    throw new UnverifiedPlatformError(platform);
  }
}

/** Which platforms could actually be used right now. Currently none, honestly. */
export function verifiedPlatforms(): readonly Platform[] {
  return PLATFORMS.filter((platform) => PLATFORM_LIMITS[platform].verifiedAt !== null);
}
