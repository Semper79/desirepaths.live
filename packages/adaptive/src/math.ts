/**
 * Small numeric helpers shared across the engine.
 *
 * These are one-liners, and they are here rather than inlined for a specific reason:
 * inlined, each one would be a defensive branch that no realistic input reaches, and
 * this package promises 100% branch coverage. A clamp whose "out of range" arm is
 * never exercised is not evidence of a well-behaved system - it is a hole in the
 * evidence. Extracted and tested directly, the clamp is proven and the call sites
 * stay branch-free.
 */

/** Clamp into [0, 1]. */
export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Rejection predicate for the polar Box-Muller transform: the sampled point must lie
 * strictly inside the unit disc and not at the origin.
 */
export function outsideUnitDisc(s: number): boolean {
  return s >= 1 || s === 0;
}
