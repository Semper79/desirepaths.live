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
import { currentSnapshot as readSnapshot } from './snapshot.js';
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
 * Sticky assignments.
 *
 * ⚠ Still in process. A restart forgets every sticky assignment and two instances do not
 * share them, so a returning visitor can be re-rolled — the variant stays *valid*, and
 * `isStillServable` still refuses one the guardrails have removed, but §2.2's promise
 * that a returning visitor keeps their variant holds only within one process.
 *
 * Moving it to Redis is a swap of this one line for a client of the same interface, which
 * is why the interface exists. It is deliberately not bundled into the adapt-loop change:
 * the snapshot is what makes the site adaptive at all, and stickiness is a property of how
 * that adaptation is experienced across visits.
 */
const store: AssignmentStore = new MemoryAssignmentStore();

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

  const resolved = resolveAssignment({
    anonId,
    context,
    snapshot: await readSnapshot(),
    botScore: Number.isFinite(botScore) ? botScore : 0,
    cached,
  });

  // Only a computed assignment is worth persisting: a crawler's is the baseline by
  // rule, and a sticky one is already there.
  if (resolved.source === 'computed' || resolved.source === 'holdout') {
    await store.write(anonId, resolved.assignment, 30 * 24 * 60 * 60);
  }

  return resolved;
}
