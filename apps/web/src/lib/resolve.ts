/**
 * Server-side assignment resolution for a request.
 *
 * The bridge between the headers middleware set and the pure resolver in
 * `assignment.ts`. Lives on the Node runtime, so it can reach the posterior snapshot;
 * see the note in `request-context.ts` for why that matters.
 */

import { BASELINE_ASSIGNMENT, type VisitorContext } from '@morph/core';
import {
  MemoryAssignmentStore,
  resolveAssignment,
  type AssignmentStore,
  type ResolvedAssignment,
} from './assignment.js';
import { decisionDurationMs, snapshotAgeSeconds } from '@morph/metrics';
import { currentSnapshot as readSnapshot } from './snapshot.js';
import { redisAssignmentStore } from './assignment-store.js';
import {
  ANON_ID_HEADER,
  BOT_SCORE_HEADER,
  CONTEXT_HEADER,
  decodeContext,
} from './request-context.js';

/**
 * The posterior snapshot, re-exported so callers have one import for the whole seam.
 *
 * Reads what `apps/worker`'s adapt job publishes, through a one-minute in-process cache.
 * Before the first cycle — or with no `REDIS_URL` — it answers with the cold snapshot,
 * which resolves every surface to its baseline: a correct page, never a slow one and
 * never an error.
 */
export { currentSnapshot } from './snapshot.js';

/**
 * Sticky assignments, in Redis.
 *
 * §2.2's promise — a returning visitor keeps their variant for thirty days — is now a
 * property of the system rather than of whichever container answered. `MemoryAssignmentStore`
 * survives for tests and for running the site with no Redis at all, where a process-lifetime
 * store is exactly as much stickiness as a single process can honestly offer.
 */
const store: AssignmentStore =
  process.env['REDIS_URL'] === undefined || process.env['REDIS_URL'].length === 0
    ? new MemoryAssignmentStore()
    : redisAssignmentStore();

export interface RequestHeaders {
  get(name: string): string | null;
}

/**
 * Resolve the assignment for the current request.
 *
 * Falls back to the baseline whenever middleware did not run — a direct hit on a
 * route outside the matcher, or a deployment with no pepper configured. Rendering the
 * baseline is always safe; rendering nothing is not.
 */
export async function assignmentForRequest(headers: RequestHeaders): Promise<ResolvedAssignment> {
  const anonId = headers.get(ANON_ID_HEADER);
  const context: VisitorContext | null = decodeContext(headers.get(CONTEXT_HEADER));

  if (anonId === null || context === null) {
    return {
      assignment: BASELINE_ASSIGNMENT,
      hash: '0',
      isHoldout: false,
      source: 'baseline',
      measurable: false,
      reasons: {},
    };
  }

  const botScore = Number.parseInt(headers.get(BOT_SCORE_HEADER) ?? '0', 10);
  const cached = await store.read(anonId);

  const snapshot = await readSnapshot();

  // Age is reported here rather than by the worker that wrote it, and the difference
  // matters: this is the age of what *this renderer is actually serving*, which is what
  // `morph_snapshot_age_seconds` is asked about during an incident. A worker that thinks
  // it published fifteen minutes ago and a renderer still holding yesterday's copy is
  // precisely the disagreement worth being able to see. Zero means nothing was ever
  // published, so it is reported as such rather than as an infinitely old snapshot.
  if (snapshot.generatedAt > 0) {
    snapshotAgeSeconds.set((Date.now() - snapshot.generatedAt) / 1000);
  }

  // Timed around the resolution alone. The snapshot read is deliberately outside it: §7
  // budgets the *decision* at 5 ms, and folding a cache miss into that number would make
  // the budget look breached by a network round trip the decision does not perform.
  const startedAt = performance.now();
  const resolved = resolveAssignment({
    anonId,
    context,
    snapshot,
    botScore: Number.isFinite(botScore) ? botScore : 0,
    cached,
  });
  decisionDurationMs.observe(performance.now() - startedAt);

  // Only a computed assignment is worth persisting: a crawler's is the baseline by
  // rule, and a sticky one is already there.
  if (resolved.source === 'computed' || resolved.source === 'holdout') {
    await store.write(anonId, resolved.assignment, 30 * 24 * 60 * 60);
  }

  return resolved;
}
