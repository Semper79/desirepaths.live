/**
 * Reading the decision set the worker publishes.
 *
 * The other end of `apps/worker/src/adapters/redis-snapshot.ts`. Until this existed the
 * renderer resolved every surface to its baseline for ever — the engine had no consumer,
 * and the reading on the home page sat at zero not because the site was new but because
 * the wire was not connected.
 *
 * WHY IT IS CACHED IN PROCESS
 * The snapshot changes once an hour and is identical for every visitor, so a read per
 * request would be the same bytes fetched thousands of times inside a 150 ms budget that
 * also has to cover the assignment resolution itself. The cache is refreshed on demand
 * and never blocks on a refresh that is already in flight, so a burst of concurrent
 * requests after an expiry produces one Redis round trip rather than four hundred.
 *
 * The client itself, and why its timeouts are what they are, is in `redis.ts` — shared
 * with the sticky assignment store so one outage produces one error stream.
 *
 * WHY A STALE COPY IS SERVED WHILE REFRESHING FAILS
 * A Redis blip must not un-adapt the site. An hour-old decision set is a good decision
 * set; falling back to baselines because a network call timed out would throw away
 * everything the system knows over a problem that will likely have resolved by the next
 * request. `sophistication()` reports the age either way, so a snapshot that has stopped
 * being refreshed is visible on the page rather than hidden behind it.
 */

import type { PosteriorSnapshot } from './assignment.js';
import { redis } from './redis.js';

/** Shared with the worker. Changing it on one side only makes the site stop adapting. */
const SNAPSHOT_KEY = 'morph:snapshot:current';

/**
 * How long a cached copy is used before a refresh is attempted.
 *
 * The worker publishes hourly, so a minute is fifty-nine parts caution: it bounds how
 * long a *new* snapshot waits to take effect, at the cost of one Redis read a minute per
 * instance, which is nothing.
 */
const CACHE_TTL_MS = 60_000;

/**
 * How long to wait before trying again after a failed read.
 *
 * Separate from the cache TTL, and the separation is the whole point. The first version
 * only recorded the time of a *successful* read, so during a Redis outage every single
 * request found the cache expired, attempted a refresh, and waited for it to fail — a
 * per-render tax for as long as the outage lasted, on the one path that has a 150 ms
 * budget. Recording the attempt bounds that to one slow request every five seconds per
 * instance, and everything else is served from the copy already held.
 */
const RETRY_AFTER_MS = 5_000;

/** What every path falls back to: a correct, un-adapted page. Never an error. */
const COLD: PosteriorSnapshot = { arms: {}, adaptationEnabled: true, generatedAt: 0 };

let cached: PosteriorSnapshot = COLD;
let cachedAt = 0;
let attemptedAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * Parse what came back, structurally.
 *
 * Deliberately tolerant about arms it does not recognise and strict about their shape: a
 * surface added to the registry after this instance started should not break the read,
 * but an arm without a usable alpha would produce `NaN` samples that quietly make one
 * variant unpickable for ever.
 */
function parseSnapshot(raw: string): PosteriorSnapshot | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const rawArms = record['arms'];
  if (typeof rawArms !== 'object' || rawArms === null) return null;

  const arms: Record<
    string,
    { variantId: string; alpha: number; beta: number; impressions: number }[]
  > = {};

  for (const [surface, list] of Object.entries(rawArms as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const parsed = [];

    for (const entry of list as Record<string, unknown>[]) {
      const variantId = entry['variantId'];
      const alpha = entry['alpha'];
      const beta = entry['beta'];
      const impressions = entry['impressions'];

      if (typeof variantId !== 'string') continue;
      if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0) continue;
      if (typeof beta !== 'number' || !Number.isFinite(beta) || beta <= 0) continue;

      parsed.push({
        variantId,
        alpha,
        beta,
        impressions:
          typeof impressions === 'number' && Number.isFinite(impressions) ? impressions : 0,
      });
    }

    if (parsed.length > 0) arms[surface] = parsed;
  }

  const generatedAt = record['generatedAt'];

  return {
    arms,
    adaptationEnabled: record['adaptationEnabled'] !== false,
    generatedAt: typeof generatedAt === 'number' && Number.isFinite(generatedAt) ? generatedAt : 0,
  };
}

async function refresh(): Promise<void> {
  // Recorded before the attempt, not after it, so a read that fails slowly backs off by
  // the same amount as one that fails quickly.
  attemptedAt = Date.now();

  const client = redis();
  if (client === null) return;

  try {
    const raw = await client.get(SNAPSHOT_KEY);
    if (raw === null) return;

    const parsed = parseSnapshot(raw);
    if (parsed === null) return;

    cached = parsed;
    cachedAt = Date.now();
  } catch {
    // Swallowed on purpose, and this is the one place in the codebase where that is the
    // right call. The alternative is a page that fails to render because a cache read
    // failed, and the correct response to "I could not check for a newer decision set"
    // is to keep using the one already held.
  }
}

/**
 * The posterior snapshot for this request.
 *
 * Never throws and never blocks on a refresh already running. Returns the cold snapshot
 * before the first successful read, which resolves every surface to its baseline — a
 * correct page, never a slow one and never an error.
 */
export async function currentSnapshot(): Promise<PosteriorSnapshot> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cached;
  if (now - attemptedAt < RETRY_AFTER_MS) return cached;

  inFlight ??= refresh().finally(() => {
    inFlight = null;
  });
  await inFlight;

  return cached;
}

/** Test seam. Resets the module-level cache between cases. */
export function __resetSnapshotCache(): void {
  cached = COLD;
  cachedAt = 0;
  attemptedAt = 0;
  inFlight = null;
}

export { parseSnapshot, COLD as COLD_SNAPSHOT };
