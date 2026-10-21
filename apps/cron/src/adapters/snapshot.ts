/**
 * `SnapshotPublisher`, over Workers KV.
 *
 * The other end of `apps/web/src/lib/snapshot.ts`. One key, rewritten once an hour, read by
 * every render — which is why it has its own namespace rather than sharing the assignments
 * one: a single hot key that must never be purged has nothing operationally in common with
 * millions of cold keys that expire on their own.
 *
 * WHY THERE IS NO TTL
 * An expiring snapshot would un-adapt the site the moment the cycle missed a run, and a
 * missed run is exactly when the adaptation matters most — the site would fall back to
 * baselines because a cron was late. The renderer handles staleness itself: it serves what
 * it has and `sophistication()` reports the age on the page, so a snapshot that has stopped
 * advancing is visible to a visitor rather than silently replaced by nothing.
 *
 * WHY THE KEY IS A CONSTANT SHARED BY NAME AND NOT BY IMPORT
 * `apps/web` cannot import from `apps/cron` — apps do not depend on each other — so the key
 * is written out in both places. That is a duplication with no compiler check behind it, and
 * the failure is total and silent: the renderer would read a key nobody writes and resolve
 * every surface to its baseline for ever. `test/wiring.test.ts` reads the renderer's source
 * and asserts the two strings match, which is the only guard available.
 */

import type { PublishedSnapshot, SnapshotPublisher } from '@morph/cycle';

/** Shared with `apps/web/src/lib/snapshot.ts`. Changing it on one side only breaks both. */
export const SNAPSHOT_KEY = 'morph:snapshot:current';

/**
 * The one thing publishing needs: write a key.
 *
 * Narrower than `KVNamespace`, which also offers `get`, `list` and `delete`. The publisher
 * has no reason to read the snapshot back or to remove it, and a type that cannot do those
 * is a stronger statement than a comment saying it does not. It also means a test's fake is
 * one method instead of a cast past five.
 */
export interface SnapshotWriter {
  put(key: string, value: string): Promise<void>;
}

export function kvSnapshotPublisher(kv: SnapshotWriter): SnapshotPublisher {
  return {
    async publish(snapshot: PublishedSnapshot): Promise<void> {
      // Serialised here rather than by the caller, so the shape the renderer parses is
      // decided in one place. `apps/web`'s `parseSnapshot` is deliberately tolerant about
      // arms it does not recognise and strict about their contents, which means a surface
      // added since the renderer deployed is ignored rather than fatal.
      await kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    },
  };
}
