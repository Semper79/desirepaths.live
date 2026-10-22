/**
 * Sticky assignments, in Workers KV.
 *
 * §2.2: a returning visitor keeps their variant for thirty days. The Redis implementation
 * this replaces is in `assignment-store.ts`, and every judgement it made still holds — a
 * failed read means "no sticky assignment" and the resolver rolls a fresh one, a failed
 * write means the assignment is simply not sticky. `parseAssignment` is shared rather than
 * reimplemented, so the rule that a partial vector is discarded instead of repaired is the
 * same rule in both.
 *
 * WHY KV AND NOT A DURABLE OBJECT (D33)
 * KV is eventually consistent: a write can take up to a minute to be visible everywhere,
 * so a returning visitor can read nothing back and be re-rolled. That sounds like a
 * correctness problem and is not one, because of what the miss produces. The page renders
 * whatever variant was rolled, and the impression is recorded against the variant actually
 * served. Nothing is mis-attributed. The cost is measurement noise and a page that changes
 * under a returning reader — both of which this store has always accepted, because the
 * alternative was a 500 when a cache blinked.
 *
 * A Durable Object would make the read exact and would mean one object per rotating daily
 * anonymous id. That is the wrong shape at any price, and it would buy exactness in the
 * one place where staleness is indistinguishable from an honest absence.
 *
 * WHAT IS STORED
 * The assignment vector only. No context, no identifier beyond the key, nothing that
 * outlives the thirty days the key does — and the anonymous id it is keyed on rotates
 * daily, so a key older than a day is already unreachable by the visitor it belonged to.
 */

import { SURFACE_KEYS, type FullAssignment, type SurfaceKey } from '@morph/core';
import type { AssignmentStore } from './assignment';
import { assignmentKv } from './bindings';

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

/**
 * Namespaced, as the Redis keys were.
 *
 * KV namespaces are already isolated from one another, so this buys less than the Redis
 * prefix did. It is kept because the two stores must produce the same keys for the
 * duration of the port: a deployment that reads KV and a rollback that reads Redis should
 * not disagree about which visitor is which.
 */
function keyFor(anonId: string): string {
  return `morph:assign:${anonId}`;
}

/**
 * A KV-backed store, falling back to `fallback` while there is no binding.
 *
 * The fallback is a parameter rather than a decision made once at module scope, because on
 * Workers the binding belongs to the request. Choosing the implementation at import time
 * would read `env` outside a request, where it is not there, and would then serve every
 * request from the fallback for the life of the isolate — a site that silently forgets
 * every returning visitor while looking completely healthy.
 *
 * In practice the fallback is `MemoryAssignmentStore`, which is exactly as much stickiness
 * as a single process can honestly offer and is the right answer for `pnpm dev`.
 */
export function kvAssignmentStore(fallback: AssignmentStore): AssignmentStore {
  return {
    async read(anonId: string): Promise<FullAssignment | null> {
      const kv = await assignmentKv();
      if (kv === null) return fallback.read(anonId);

      try {
        const raw = await kv.get(keyFor(anonId), 'text');
        return raw === null ? null : parseAssignment(raw);
      } catch {
        return null;
      }
    },

    async write(anonId: string, assignment: FullAssignment, ttlSeconds: number): Promise<void> {
      const kv = await assignmentKv();
      if (kv === null) return fallback.write(anonId, assignment, ttlSeconds);

      try {
        // KV refuses a TTL under 60 seconds. The caller's value comes from
        // ASSIGNMENT_TTL_SECONDS and is thirty days, so this floor should never bind —
        // it is here so that a future caller passing something short gets a short-lived
        // key rather than a rejected write that silently stops stickiness working.
        await kv.put(keyFor(anonId), JSON.stringify(assignment), {
          expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
        });
      } catch {
        // Not sticky this time. The next request re-rolls, which is the same outcome as a
        // first visit and is indistinguishable from one to everything downstream.
      }
    },
  };
}
