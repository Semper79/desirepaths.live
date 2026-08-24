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
  type PosteriorSnapshot,
  type ResolvedAssignment,
} from './assignment.js';
import {
  ANON_ID_HEADER,
  BOT_SCORE_HEADER,
  CONTEXT_HEADER,
  decodeContext,
} from './request-context.js';

/**
 * The posterior snapshot.
 *
 * Published by the worker every aggregation cycle. Until the worker exists (Phase 5),
 * this returns an empty snapshot, which resolves every surface to its baseline — the
 * site renders correctly and simply does not adapt yet. A cold cache is a baseline
 * page, never a slow one and never an error.
 */
export function currentSnapshot(): PosteriorSnapshot {
  return { arms: {}, adaptationEnabled: true, generatedAt: 0 };
}

/** Swapped for the Redis-backed store once the data plane is wired. */
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
    snapshot: currentSnapshot(),
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
