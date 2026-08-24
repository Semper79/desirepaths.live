/**
 * Turning a resolved assignment into everything the renderer needs.
 *
 * Pure. Given an assignment, it produces the token bag for `<html>` and the typed
 * payload for each surface, with the registry as the only source of truth about what
 * a variant means.
 *
 * The failure this design prevents: a renderer reaching into a variant payload by
 * string key and getting `undefined` because a schema changed. Every payload here goes
 * through the surface's own zod schema on the way out, so a mismatch is an exception at
 * render time with a message naming the field — not an empty hero section.
 */

import { SURFACES, type FullAssignment, type SurfaceKey } from '@morph/core';
import { composeTokens, FALLBACK_TOKENS } from '@morph/ui';

/** The payload of one surface, parsed and typed. */
export function payloadOf<K extends SurfaceKey>(
  assignment: FullAssignment,
  key: K,
): ReturnType<(typeof SURFACES)[K]['schema']['parse']> {
  const surface = SURFACES[key];
  const variantId = assignment[key];
  const variant =
    surface.variants.find((v) => v.id === variantId) ??
    surface.variants.find((v) => v.id === surface.baselineVariantId);

  if (variant === undefined) {
    // Unreachable through the registry's own validation, which requires a baseline —
    // but reachable through a corrupted cache, and an exception naming the surface is
    // far better than rendering nothing and wondering why.
    throw new Error(`No variant and no baseline for surface ${key}`);
  }

  return surface.schema.parse(variant.payload) as ReturnType<
    (typeof SURFACES)[K]['schema']['parse']
  >;
}

/** Token-bearing surfaces, in the order they cascade. Later wins. */
const TOKEN_SURFACES = [
  'theme.palette',
  'theme.typography',
  'layout.density',
  'motion.intensity',
  'hero.media',
  'cta.style',
] as const;

/**
 * Compose the token bag for a page.
 *
 * Order matters and is not alphabetical: palette sets the colour system, typography
 * and density layer on top, and `cta.style` comes last because it is allowed to
 * override the accent colours for one component. Reordering this silently changes
 * which surface wins a conflict.
 */
export function tokensFor(assignment: FullAssignment): Readonly<Record<string, string>> {
  const bags = TOKEN_SURFACES.map((key) => {
    const payload = payloadOf(assignment, key) as { tokens?: Record<string, string> };
    return payload.tokens ?? {};
  });
  return composeTokens(...bags);
}

/** The token bag used when no assignment could be resolved at all. */
export const FALLBACK_BAG = FALLBACK_TOKENS;

/**
 * Section order, from `layout.order`.
 *
 * Returned as a plain list so the page maps over it. The registry's invariant already
 * guarantees it is a permutation with the hero first; this does not re-check, because
 * a rule enforced in two places is a rule that will disagree with itself.
 */
export function sectionOrder(assignment: FullAssignment): readonly string[] {
  return payloadOf(assignment, 'layout.order').sections;
}

/**
 * Whether motion is permitted for this assignment.
 *
 * The `prefers-reduced-motion` media query in `globals.css` is the real guarantee —
 * it cannot be overridden by a variant and does not depend on this function being
 * called. This is the *additional* server-side signal, so a reduced-motion visitor
 * does not even receive the markup for an animation.
 */
export function motionAllowed(assignment: FullAssignment): boolean {
  return payloadOf(assignment, 'motion.intensity').level !== 'none';
}
