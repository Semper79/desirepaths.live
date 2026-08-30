/**
 * Reading the decision set the worker publishes.
 *
 * A second reader, deliberately. `apps/web` has one and `apps/admin` cannot import it —
 * apps may depend on packages, never on other apps — so this duplicates about forty lines.
 *
 * Extracting it into a package is the obvious fix and is being deliberately deferred:
 * there are two consumers, and the third is when a shared abstraction stops being a guess
 * about what both need. The key and the shape are the parts that must not drift, and both
 * are asserted in `test/snapshot.test.ts`.
 *
 * No cache here, unlike the renderer's copy. The console is opened by one person a few
 * times a day, and an operator diagnosing an incident wants the number as it is now, not
 * as it was within the last minute.
 */

import Redis from 'ioredis';
import type { Arm } from '@morph/adaptive';

/** Shared with the worker and with `apps/web`. Changing one copy breaks the other two. */
export const SNAPSHOT_KEY = 'morph:snapshot:current';

export interface Snapshot {
  readonly arms: Readonly<Record<string, readonly Arm[]>>;
  readonly adaptationEnabled: boolean;
  readonly generatedAt: number;
}

export const EMPTY: Snapshot = { arms: {}, adaptationEnabled: true, generatedAt: 0 };

export function parseSnapshot(raw: string): Snapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const rawArms = record['arms'];
  if (typeof rawArms !== 'object' || rawArms === null) return null;

  const arms: Record<string, Arm[]> = {};

  for (const [surface, list] of Object.entries(rawArms as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const parsed: Arm[] = [];

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

let client: Redis | null = null;

/**
 * The current snapshot, or the empty one.
 *
 * Never throws. A console that 500s because Redis blinked is a console that is unavailable
 * exactly when it is wanted — the page renders with an explicit "nothing published yet"
 * instead, which is a true statement about what the reader can see.
 */
export async function readSnapshot(): Promise<Snapshot> {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url.length === 0) return EMPTY;

  if (client === null) {
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      lazyConnect: true,
    });
    client.on('error', () => {});
  }

  try {
    const raw = await client.get(SNAPSHOT_KEY);
    return raw === null ? EMPTY : (parseSnapshot(raw) ?? EMPTY);
  } catch {
    return EMPTY;
  }
}
