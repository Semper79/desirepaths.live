/**
 * Publishing the decision set to the renderer.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE. It is one `SET` and a `JSON.stringify`.
 *
 * WHY REDIS AND NOT POSTGRES
 * The renderer reads this before it can emit a byte, on every request that is not a cache
 * hit, against a 150 ms TTFB budget that also has to cover the assignment resolution
 * itself. Postgres holds the durable record — `posterior_snapshot`, written in the same
 * cycle — and this is the copy that is fast to read. Losing it costs the site nothing
 * permanent: the next cycle republishes, and until then the renderer serves baselines,
 * which is what it does at cold start anyway.
 *
 * WHY ONE KEY AND NOT ONE PER SURFACE
 * The renderer needs all eleven surfaces to resolve one assignment. Eleven round trips
 * inside a 150 ms budget is eleven chances to be unlucky, and a partial read — nine
 * surfaces from the new cycle and two from the old — would produce an assignment vector
 * that never existed as a decision, whose hash matches nothing, and which would then be
 * attributed to whichever combination it accidentally resembled.
 */

import type Redis from 'ioredis';
import type { PublishedSnapshot, SnapshotPublisher } from '../ports';

/** Shared with `apps/web`. Changing it on one side only makes the site stop adapting. */
export const SNAPSHOT_KEY = 'morph:snapshot:current';

/**
 * Long enough that a worker outage does not un-adapt the site mid-afternoon, short enough
 * that a worker that has been dead for a day stops pretending its conclusions are current.
 *
 * The renderer applies its own staleness judgement on top, from `generatedAt` — this
 * expiry is the backstop for the case where nobody is looking.
 */
const TTL_SECONDS = 6 * 60 * 60;

export function redisSnapshotPublisher(redis: Redis): SnapshotPublisher {
  return {
    async publish(snapshot: PublishedSnapshot): Promise<void> {
      await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), 'EX', TTL_SECONDS);
    },
  };
}
