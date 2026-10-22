/**
 * The engine's own state, read from the snapshot the renderer just used.
 *
 * Thin on purpose: the arithmetic lives in `@morph/adaptive`, which is pure and carries
 * 100% branch coverage. This file only translates one shape into another and decides what
 * an unpublished snapshot means — which is the single judgement call, and it is here
 * rather than buried in the component so it can be tested.
 */

import { sophistication, type Sophistication, type SurfaceEvidence } from '@morph/adaptive';
import { SURFACE_KEYS } from '@morph/core';
import type { PosteriorSnapshot } from './assignment';

/**
 * Every registered surface, including the ones the snapshot has nothing for.
 *
 * Absent surfaces are included with no arms rather than skipped, because breadth is the
 * fraction of the site under optimisation and skipping them would make a site optimising
 * one surface out of eleven report a perfect score on that term. The denominator has to be
 * what the site *could* be optimising, not what it happens to have data for.
 */
export function siteSophistication(snapshot: PosteriorSnapshot, now: number): Sophistication {
  const surfaces: readonly SurfaceEvidence[] = SURFACE_KEYS.map((key) => ({
    surfaceKey: key,
    arms: snapshot.arms[key] ?? [],
  }));

  // `generatedAt` of zero is the placeholder for "the worker has never published one",
  // which is unknown age rather than infinite age. Passing a vast number instead would
  // apply the staleness penalty to a site whose only real problem is that it is new — and
  // the reading is zero anyway on the terms that matter, so inventing a second penalty
  // would just be a worse explanation of the same number.
  const age = snapshot.generatedAt === 0 ? null : Math.max(0, now - snapshot.generatedAt);

  return sophistication(surfaces, age);
}
