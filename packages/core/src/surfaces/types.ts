/**
 * THE SURFACE REGISTRY - type definition
 * =============================================================================
 * A *surface* is any part of MORPH that is allowed to change itself. A *variant*
 * is one concrete way that surface can look or behave. The registry is the closed
 * world of things the optimiser may touch: if it is not declared here, the bandit
 * cannot reach it, and a generated variant that does not fit a declared schema is
 * rejected before it can be served.
 *
 * Three properties matter more than anything else in this file:
 *
 *  1. TYPED END TO END. `SurfaceOf<'theme.palette'>` resolves to the palette payload
 *     type, not to `unknown`. A renderer that reads `.tokens['--color-bg']` fails to
 *     compile if the palette schema changes. Losing that would make an LLM-generated
 *     variant a runtime hazard instead of a compile-time one.
 *
 *  2. VARIANTS CARRY TOKENS, NOT CSS. Section 2.1: "each carries CSS custom-property
 *     values rather than arbitrary CSS". The visual system can restyle itself
 *     completely while staying inside a coherent token space, and a generated variant
 *     cannot inject a selector, an @import, or a 400px margin that breaks the layout.
 *
 *  3. THE ACCESSIBILITY GATE IS PART OF THE TYPE, NOT A LINT STEP. Every surface
 *     declares an `a11y` contract; `validateSurface` runs it at registration and at
 *     generation. There is no code path that admits a variant which failed it.
 */

import type { z } from 'zod';
import type { VariantId } from '../brand';

// -----------------------------------------------------------------------------
// Objectives
// -----------------------------------------------------------------------------

/**
 * Components of the composite reward, as defined in section 2.2. The weights live in
 * database config and are hot-reloadable, so they are deliberately NOT part of this
 * type - only the identity of each component is.
 */
export type RewardComponent =
  | 'signup'
  | 'meaningful_engagement'
  | 'scroll_depth_norm'
  | 'return_visit'
  | 'share'
  | 'bounce_penalty';

/**
 * Which parts of the composite reward a surface is judged on.
 *
 * Not every surface should be optimised against every component. `motion.intensity`
 * changing bounce rate is a real signal; `motion.intensity` changing return-visit
 * rate three weeks later is almost certainly noise, and letting the optimiser chase
 * it burns exploration budget on a link that does not exist.
 */
export interface ObjectiveSpec {
  /** Components this surface is credited or debited for. */
  readonly components: readonly RewardComponent[];
  /**
   * Binary sub-objective used for the Thompson-sampling layer. The contextual bandit
   * optimises the full composite; the Beta posteriors need one yes/no outcome.
   */
  readonly primaryBinary: Extract<RewardComponent, 'signup' | 'meaningful_engagement' | 'share'>;
}

// -----------------------------------------------------------------------------
// Accessibility contract
// -----------------------------------------------------------------------------

export interface ContrastRequirement {
  /** Token names, e.g. `['--color-text', '--color-bg']`. */
  readonly pair: readonly [string, string];
  readonly role: 'body' | 'large' | 'ui';
}

export interface A11yContract {
  /** Token pairs that must clear their WCAG 2.2 AA threshold. */
  readonly contrast?: readonly ContrastRequirement[];
  /**
   * Maximum US-grade reading level for generated copy. Section 3's audience is young and
   * mobile; copy that needs a degree to parse converts worse anyway, so this
   * constraint costs nothing and prevents the generator drifting into press-release
   * register.
   */
  readonly maxReadingGrade?: number;
  /**
   * `true` when the surface animates. Such a surface MUST declare a variant that is
   * valid under `prefers-reduced-motion: reduce`, and `validateSurface` enforces it.
   * Section 2.1: motion "respects prefers-reduced-motion - always".
   */
  readonly animates?: boolean;
  /** Minimum tap target in CSS pixels for any interactive output of this surface. */
  readonly minTapTargetPx?: number;
}

// -----------------------------------------------------------------------------
// Variants
// -----------------------------------------------------------------------------

export type VariantOrigin =
  /** Hand-authored, shipped with the product, and the fallback if everything is quarantined. */
  | 'baseline'
  /** Hand-authored by the operator. */
  | 'authored'
  /** Produced by `adapt.evolve` (section 2.3). Always traceable to a generation record. */
  | 'generated';

export type VariantStatus =
  /** Eligible for assignment. */
  | 'active'
  /** Serving suspended by a guardrail breach; keeps its history for the report. */
  | 'quarantined'
  /** Lost on the merits and will not come back. */
  | 'retired'
  /** Operator-pinned; assignment forced, learning suspended for this surface. */
  | 'pinned';

export interface VariantProvenance {
  readonly origin: VariantOrigin;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** `adaptation_log.id` of the generation event, for `generated` variants. */
  readonly generationId?: string;
  /** Ids of the variants this one was conditioned on. */
  readonly parents?: readonly VariantId[];
  /** Trend cluster ids that motivated it (section 3). */
  readonly trendSignals?: readonly string[];
  /** Model that produced it, so a bad batch is attributable. */
  readonly model?: string;
}

export interface Variant<TPayload> {
  readonly id: VariantId;
  /** Human-readable, used verbatim in the Telegram report. Keep it under 48 chars. */
  readonly label: string;
  readonly payload: TPayload;
  readonly status: VariantStatus;
  readonly provenance: VariantProvenance;
  /**
   * Optimistic prior for a newly injected variant, expressed as pseudo-observations
   * (alpha, beta) on the Beta posterior. Section 2.3 injects generated variants
   * optimistically so they get explored; a flat (1, 1) would let them starve behind
   * an established champion.
   */
  readonly prior?: { readonly alpha: number; readonly beta: number };
}

// -----------------------------------------------------------------------------
// Surfaces
// -----------------------------------------------------------------------------

export type SurfaceKind =
  /** Text the visitor reads. */
  | 'copy'
  /** Imagery, video, canvas. */
  | 'media'
  /** Design tokens: colour, type, spacing, motion. */
  | 'theme'
  /** Structural: density, section order. */
  | 'layout'
  /** Ordering of a list whose members are fixed. */
  | 'ordering'
  /** A ranking or selection strategy, not a visual. */
  | 'strategy';

export interface SurfaceConstraints {
  /**
   * Impressions a variant must accumulate before it may be retired (section 2.2).
   * Per-surface because a hero headline accumulates impressions far faster than a
   * signup-provider ordering, and a single global number would either retire
   * headlines too slowly or provider orderings on noise.
   */
  readonly minImpressionsBeforeRetire: number;
  /** Hard ceiling on simultaneously active variants. Exploration cost is linear in this. */
  readonly maxActiveVariants: number;
  /** Whether `adapt.evolve` may generate new variants for this surface. */
  readonly allowGenerated: boolean;
  /**
   * Whether this surface may differ between two visitors in the same context bucket.
   * `false` for surfaces whose inconsistency would be perceived as a bug rather than
   * as personalisation.
   */
  readonly allowPersonalisation: boolean;
  /**
   * Consent tier required before this surface may adapt at all. Aggregate adaptation
   * runs under legitimate interest (`analytics`); anything keyed to an individual
   * needs `personalisation`. See docs/PRIVACY.md.
   */
  readonly requiresConsent: 'necessary' | 'analytics' | 'personalisation';
}

export interface SurfaceDefinition<TId extends string, TPayload> {
  /**
   * The plain string literal, deliberately NOT branded as `SurfaceId`. The shape is
   * validated at construction by `defineSurface`, but a branded key cannot index a
   * mapped record type, and `SURFACES['theme.palette']` resolving to its exact
   * surface type is worth more than a brand on a value nothing else consumes.
   */
  readonly id: TId;
  readonly kind: SurfaceKind;
  /** One sentence, present tense, describing what changes. Shown in `/surfaces`. */
  readonly description: string;
  readonly objective: ObjectiveSpec;
  readonly a11y: A11yContract;
  readonly constraints: SurfaceConstraints;
  /** Runtime schema for the payload. The compile-time type is inferred from it. */
  readonly schema: z.ZodType<TPayload>;
  readonly variants: readonly Variant<TPayload>[];
  /** Must exist in `variants` with `origin: 'baseline'`. Served to the holdout cohort. */
  readonly baselineVariantId: VariantId;
  /**
   * Extra invariants the schema cannot express - cross-field rules, permutation
   * completeness, token-pair contrast. Returns an empty array when valid.
   */
  readonly invariants?: (payload: TPayload) => readonly string[];
}

/** Existential form, for code that iterates the registry without caring about payloads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the erased form is the point; every consumer narrows via SurfaceOf<K>
export type AnySurface = SurfaceDefinition<string, any>;

/** Build a keyed registry type from a tuple of surface definitions. */
export type RegistryOf<T extends readonly AnySurface[]> = {
  readonly [S in T[number] as S['id']]: S;
};

/** Payload type of a registered surface, e.g. `PayloadOf<'theme.palette'>`. */
export type PayloadOf<S extends AnySurface> =
  S extends SurfaceDefinition<string, infer P> ? P : never;

/**
 * A complete assignment: one variant per surface. This is what edge middleware
 * computes, what the renderer consumes, and what every event carries.
 */
export type Assignment<R extends Record<string, AnySurface>> = {
  readonly [K in keyof R]: VariantId;
};
