/**
 * Sticky assignments, in Redis.
 *
 * §2.2: a returning visitor keeps their variant for thirty days. Until now the store was
 * in process, which meant a restart forgot every assignment and two instances disagreed
 * about what a visitor had been shown — so the promise held only within one process, and
 * "returning visitor" was a property of which container answered.
 *
 * WHY A FAILED READ IS NOT AN ERROR
 * A read that fails means "no sticky assignment", and the resolver then computes a fresh
 * one. The visitor may see a different variant than last time, which is a real cost paid
 * in measurement noise — but it is a *correct page*, and the alternative is a 500 because
 * a cache was briefly unreachable. The same is true of a failed write: the assignment is
 * simply not sticky, and the next request re-rolls it.
 *
 * WHY THE WRITE IS AWAITED ANYWAY
 * It would be tempting to fire it and move on, since nothing downstream reads it. But an
 * un-awaited promise that rejects is an unhandled rejection, and Next will happily log
 * those for the rest of the process's life. The write is bounded by the client's
 * `commandTimeout`, so awaiting it costs at most half a second in the worst case and
 * nothing at all in the normal one.
 *
 * WHAT IS STORED
 * The assignment vector only. No context, no identifier beyond the key, nothing that
 * outlives the thirty days the key does — the anonymous id it is keyed on rotates daily,
 * so a key older than a day is already unreachable by the visitor it belonged to.
 */

import { SURFACE_KEYS, type FullAssignment, type SurfaceKey } from '@morph/core';
import type { AssignmentStore } from './assignment.js';
import { redis } from './redis.js';

/** Namespaced so a `KEYS morph:assign:*` during an incident cannot match anything else. */
function keyFor(anonId: string): string {
  return `morph:assign:${anonId}`;
}

/**
 * Parse a stored assignment, requiring every surface to be present.
 *
 * A partial vector is rejected rather than repaired. The tempting alternative is to fill
 * the gaps with baselines, which would silently convert "this visitor was shown a variant
 * we can no longer name" into "this visitor was shown the baseline" — and that assignment
 * then gets reported as evidence for the baseline. Discarding it costs one visitor's
 * stickiness; repairing it corrupts a posterior.
 *
 * Exported for its own test: this runs on every returning visitor and its failure mode is
 * invisible from the page.
 */
export function parseAssignment(raw: string): FullAssignment | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const assignment: Record<string, string> = {};

  for (const key of SURFACE_KEYS) {
    const variantId = record[key];
    if (typeof variantId !== 'string' || variantId.length === 0) return null;
    assignment[key] = variantId;
  }

  return assignment as Record<SurfaceKey, string> as FullAssignment;
}

export function redisAssignmentStore(): AssignmentStore {
  return {
    async read(anonId: string): Promise<FullAssignment | null> {
      const client = redis();
      if (client === null) return null;

      try {
        const raw = await client.get(keyFor(anonId));
        return raw === null ? null : parseAssignment(raw);
      } catch {
        return null;
      }
    },

    async write(anonId: string, assignment: FullAssignment, ttlSeconds: number): Promise<void> {
      const client = redis();
      if (client === null) return;

      try {
        await client.set(keyFor(anonId), JSON.stringify(assignment), 'EX', ttlSeconds);
      } catch {
        // Not sticky this time. The next request re-rolls, which is the same outcome as a
        // first visit and is indistinguishable from one to everything downstream.
      }
    },
  };
}
