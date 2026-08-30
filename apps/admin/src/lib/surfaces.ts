/**
 * The surface registry, joined to whatever the engine currently believes about it.
 *
 * The registry is the closed world of what the site may change about itself — eleven
 * surfaces, each with a declared variant space — and it is the one view of the system that
 * exists nowhere else. The Telegram report says what changed this hour; this says what
 * *could* change, and what the posteriors currently say about each option.
 *
 * Pure. The snapshot is a parameter, so every row below is a test rather than a fixture
 * database and a Redis.
 */

import { SURFACES, SURFACE_KEYS, type SurfaceKey } from '@morph/core';
import { betaMean, summarise, type Arm } from '@morph/adaptive';

export interface VariantRow {
  readonly variantId: string;
  readonly isBaseline: boolean;
  /** Present once the engine has evidence; null for a variant it has never seen. */
  readonly posteriorMean: number | null;
  readonly impressions: number | null;
  /** Probability this variant beats the surface's current leader. The leader's own is 1. */
  readonly probabilityBest: number | null;
  readonly isLeader: boolean;
}

export interface SurfaceRow {
  readonly key: SurfaceKey;
  /** One sentence describing what changes. The registry calls this the description. */
  readonly description: string;
  readonly declaredVariants: number;
  /** How many the engine is currently choosing between. Zero before the first cycle. */
  readonly liveVariants: number;
  readonly variants: readonly VariantRow[];
  /**
   * Why this surface is not being optimised, or null when it is.
   *
   * Stated rather than left to be inferred from an empty column: "no evidence yet" and
   * "reduced to one variant" look identical in a table and mean opposite things.
   */
  readonly idleReason: string | null;
}

export function surfaceRows(arms: Readonly<Record<string, readonly Arm[]>>): readonly SurfaceRow[] {
  return SURFACE_KEYS.map((key) => {
    const surface = SURFACES[key];
    const live = arms[key] ?? [];
    const declared = surface.variants.map((variant) => variant.id);

    const stats = live.length > 0 ? summarise(live) : [];
    const leader =
      live.length > 0
        ? live.reduce((best, arm) =>
            betaMean(arm.alpha, arm.beta) > betaMean(best.alpha, best.beta) ? arm : best,
          )
        : null;

    const variants: VariantRow[] = declared.map((variantId) => {
      const stat = stats.find((entry) => entry.variantId === variantId);

      return {
        variantId,
        isBaseline: variantId === surface.baselineVariantId,
        posteriorMean: stat?.mean ?? null,
        impressions: stat?.impressions ?? null,
        probabilityBest: stat?.probabilityBest ?? null,
        isLeader: leader !== null && leader.variantId === variantId,
      };
    });

    return {
      key,
      description: surface.description,
      declaredVariants: declared.length,
      liveVariants: live.length,
      variants,
      idleReason: idleReasonFor(declared.length, live.length),
    };
  });
}

function idleReasonFor(declared: number, live: number): string | null {
  if (live === 0) {
    return declared > 1
      ? 'no evidence yet — the adapt job has not published a posterior for this surface'
      : 'only one variant declared, so there is nothing to choose between';
  }

  if (live === 1) return 'reduced to one live variant; the others were retired or quarantined';

  return null;
}
