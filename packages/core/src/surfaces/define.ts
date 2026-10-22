/**
 * The surface DSL and its validation gate.
 *
 * `defineSurface` is the only way a surface enters the registry, and
 * `validateSurface` is the only gate a variant passes through - at registration,
 * at generation (section 2.3), and in CI. There is deliberately no bypass parameter.
 *
 * A note on the shape of the API: variants are declared as plain objects *inside*
 * `defineSurface` rather than built by a standalone helper. That is not a style
 * choice. It is what lets the payload type flow contextually from the zod schema
 * into each variant literal, so writing `tone: 'dierct'` is a compile error naming
 * the field rather than a runtime rejection three weeks later.
 */

import { z } from 'zod';
import { surfaceId, variantId, type VariantId } from '../brand';
import { checkContrast } from '../color';
import { readability } from '../text';
import type {
  A11yContract,
  AnySurface,
  ObjectiveSpec,
  SurfaceConstraints,
  SurfaceDefinition,
  SurfaceKind,
  Variant,
  VariantOrigin,
  VariantStatus,
} from './types';

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

const DEFAULT_CONSTRAINTS: SurfaceConstraints = {
  minImpressionsBeforeRetire: 1_000,
  maxActiveVariants: 12,
  allowGenerated: true,
  allowPersonalisation: false,
  requiresConsent: 'analytics',
};

/**
 * Fixed timestamp for hand-authored variants.
 *
 * Using `new Date()` here would make the registry non-deterministic, which breaks
 * snapshot tests and, worse, makes the novelty-decay window (section 2.2) start
 * ticking at process boot rather than at authorship. Authored variants are not novel.
 */
const AUTHORED_AT = '2026-01-01T00:00:00.000Z';

// -----------------------------------------------------------------------------
// Variant construction
// -----------------------------------------------------------------------------

export interface DefineVariantInput<TPayload> {
  /** Lower-kebab slug, unique within the surface. The full id is `<surface>#<slug>`. */
  readonly slug: string;
  /** Human-readable, used verbatim in the Telegram report. Keep it under 48 chars. */
  readonly label: string;
  readonly payload: TPayload;
  readonly origin?: VariantOrigin;
  readonly status?: VariantStatus;
  readonly createdAt?: string;
  readonly generationId?: string;
  readonly parents?: readonly VariantId[];
  readonly trendSignals?: readonly string[];
  readonly model?: string;
  readonly prior?: { readonly alpha: number; readonly beta: number };
}

export function buildVariant<TPayload>(
  surface: string,
  input: DefineVariantInput<TPayload>,
): Variant<TPayload> {
  return {
    id: variantId(`${surface}#${input.slug}`),
    label: input.label,
    payload: input.payload,
    status: input.status ?? 'active',
    provenance: {
      origin: input.origin ?? 'authored',
      createdAt: input.createdAt ?? AUTHORED_AT,
      ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
      ...(input.parents === undefined ? {} : { parents: input.parents }),
      ...(input.trendSignals === undefined ? {} : { trendSignals: input.trendSignals }),
      ...(input.model === undefined ? {} : { model: input.model }),
    },
    ...(input.prior === undefined ? {} : { prior: input.prior }),
  };
}

// -----------------------------------------------------------------------------
// Surface construction
// -----------------------------------------------------------------------------

export interface DefineSurfaceInput<TId extends string, TSchema extends z.ZodTypeAny> {
  readonly id: TId;
  readonly kind: SurfaceKind;
  readonly description: string;
  readonly objective: ObjectiveSpec;
  readonly schema: TSchema;
  readonly a11y?: A11yContract;
  readonly constraints?: Partial<SurfaceConstraints>;
  readonly variants: readonly DefineVariantInput<z.infer<TSchema>>[];
  /** Slug of the baseline variant. Must exist in `variants` with origin 'baseline'. */
  readonly baseline: string;
  readonly invariants?: (payload: z.infer<TSchema>) => readonly string[];
}

export function defineSurface<TId extends string, TSchema extends z.ZodTypeAny>(
  input: DefineSurfaceInput<TId, TSchema>,
): SurfaceDefinition<TId, z.infer<TSchema>> {
  // Validated for shape, then discarded: see the note on SurfaceDefinition.id.
  surfaceId(input.id);
  return {
    id: input.id,
    kind: input.kind,
    description: input.description,
    objective: input.objective,
    a11y: input.a11y ?? {},
    constraints: { ...DEFAULT_CONSTRAINTS, ...input.constraints },
    schema: input.schema,
    variants: input.variants.map((v) => buildVariant(input.id, v)),
    baselineVariantId: variantId(`${input.id}#${input.baseline}`),
    ...(input.invariants === undefined ? {} : { invariants: input.invariants }),
  };
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  readonly severity: IssueSeverity;
  readonly surface: string;
  readonly variant?: string;
  readonly rule: string;
  readonly message: string;
}

const err = (
  surface: string,
  rule: string,
  message: string,
  variant?: string,
): ValidationIssue => ({
  severity: 'error',
  surface,
  rule,
  message,
  ...(variant === undefined ? {} : { variant }),
});

const warn = (
  surface: string,
  rule: string,
  message: string,
  variant?: string,
): ValidationIssue => ({
  severity: 'warning',
  surface,
  rule,
  message,
  ...(variant === undefined ? {} : { variant }),
});

/** Payloads that carry design tokens expose them under `tokens`. */
const TOKEN_BAG = z.object({ tokens: z.record(z.string(), z.string()) });
/** Payloads that carry copy expose it under `text`. */
const TEXT_BAG = z.object({ text: z.string() });
/** Animating payloads must state whether they are safe under reduced motion. */
const MOTION_BAG = z.object({ reducedMotionSafe: z.boolean() });

/**
 * Validate one surface and every variant in it.
 *
 * Returns issues rather than throwing so a generation batch can reject three bad
 * candidates and keep the two good ones, and so the Telegram report can say *why*
 * something was rejected instead of "generation failed".
 */
export function validateSurface(surface: AnySurface): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sid = surface.id;

  // --- structural ----------------------------------------------------------
  const seen = new Set<string>();
  for (const v of surface.variants) {
    if (seen.has(v.id)) {
      issues.push(err(sid, 'variant/unique-id', `Duplicate variant id ${v.id}.`, v.id));
    }
    seen.add(v.id);

    if (!v.id.startsWith(`${sid}#`)) {
      issues.push(
        err(sid, 'variant/id-prefix', `Variant id ${v.id} is not scoped to its surface.`, v.id),
      );
    }
  }

  const baseline = surface.variants.find((v) => v.id === surface.baselineVariantId);
  if (!baseline) {
    issues.push(
      err(
        sid,
        'surface/baseline-exists',
        `Baseline ${surface.baselineVariantId} is not a variant.`,
      ),
    );
  } else if (baseline.provenance.origin !== 'baseline') {
    issues.push(
      err(
        sid,
        'surface/baseline-origin',
        `Baseline ${baseline.id} must have origin 'baseline'; it has '${baseline.provenance.origin}'.`,
        baseline.id,
      ),
    );
  } else if (baseline.status !== 'active') {
    // The holdout cohort is served the baseline unconditionally. A quarantined
    // baseline means 5% of traffic has nothing valid to render.
    issues.push(
      err(sid, 'surface/baseline-active', `Baseline ${baseline.id} must stay active.`, baseline.id),
    );
  }

  const active = surface.variants.filter((v) => v.status === 'active' || v.status === 'pinned');
  if (active.length === 0) {
    issues.push(err(sid, 'surface/has-active', 'No active variants; the surface cannot render.'));
  }
  if (active.length > surface.constraints.maxActiveVariants) {
    issues.push(
      err(
        sid,
        'surface/max-active',
        `${String(active.length)} active variants exceeds the cap of ${String(surface.constraints.maxActiveVariants)}.`,
      ),
    );
  }

  const pinned = surface.variants.filter((v) => v.status === 'pinned');
  if (pinned.length > 1) {
    issues.push(err(sid, 'surface/single-pin', 'More than one variant is pinned.'));
  }

  // --- per-variant payload -------------------------------------------------
  for (const v of surface.variants) {
    const parsed = surface.schema.safeParse(v.payload);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        issues.push(
          err(
            sid,
            'variant/schema',
            `${problem.path.join('.') || '(root)'}: ${problem.message}`,
            v.id,
          ),
        );
      }
      // Everything below reads the payload; a payload that failed its schema cannot
      // be reasoned about further.
      continue;
    }

    if (surface.invariants) {
      for (const message of surface.invariants(parsed.data)) {
        issues.push(err(sid, 'variant/invariant', message, v.id));
      }
    }

    issues.push(...checkA11y(surface.a11y, sid, v.id, v.payload));

    if (v.prior && (v.prior.alpha <= 0 || v.prior.beta <= 0)) {
      issues.push(
        err(sid, 'variant/prior', 'Beta prior parameters must both be strictly positive.', v.id),
      );
    }
  }

  // --- motion contract -----------------------------------------------------
  // Section 2.1: motion "respects prefers-reduced-motion - always". An animating
  // surface with no reduced-motion-safe active variant has no legal state to fall
  // back to for a visitor who asked for less motion.
  if (surface.a11y.animates === true) {
    const hasSafe = active.some((v) => {
      const m = MOTION_BAG.safeParse(v.payload);
      return m.success && m.data.reducedMotionSafe;
    });
    if (!hasSafe) {
      issues.push(
        err(
          sid,
          'a11y/reduced-motion-fallback',
          'Animating surface has no active variant marked reducedMotionSafe.',
        ),
      );
    }
  }

  return issues;
}

function checkA11y(
  contract: A11yContract,
  sid: string,
  vid: string,
  payload: unknown,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (contract.contrast && contract.contrast.length > 0) {
    const bag = TOKEN_BAG.safeParse(payload);
    if (!bag.success) {
      issues.push(
        err(
          sid,
          'a11y/contrast-tokens',
          'Surface declares contrast requirements but the payload has no `tokens` map.',
          vid,
        ),
      );
    } else {
      for (const req of contract.contrast) {
        const [fgName, bgName] = req.pair;
        const fg = bag.data.tokens[fgName];
        const bg = bag.data.tokens[bgName];
        if (fg === undefined || bg === undefined) {
          issues.push(
            err(
              sid,
              'a11y/contrast-missing-token',
              `Contrast pair (${fgName}, ${bgName}) references a token this variant does not define.`,
              vid,
            ),
          );
          continue;
        }
        const result = checkContrast(fg, bg, req.role);
        if (!result.passes) {
          issues.push(
            err(
              sid,
              'a11y/contrast',
              `${fgName} on ${bgName} is ${result.ratio.toFixed(2)}:1, below the ${result.required.toFixed(1)}:1 required for ${req.role} content.`,
              vid,
            ),
          );
        } else if (result.ratio < result.required * 1.15) {
          // Not a failure, but a variant sitting 3% above the line will fail the
          // moment a generated palette nudges a token. Worth knowing about.
          issues.push(
            warn(
              sid,
              'a11y/contrast-margin',
              `${fgName} on ${bgName} passes at ${result.ratio.toFixed(2)}:1 with little margin.`,
              vid,
            ),
          );
        }
      }
    }
  }

  if (contract.maxReadingGrade !== undefined) {
    const bag = TEXT_BAG.safeParse(payload);
    if (bag.success) {
      const score = readability(bag.data.text);
      if (score.grade > contract.maxReadingGrade) {
        issues.push(
          err(
            sid,
            'a11y/reading-level',
            `Reading grade ${score.grade.toFixed(1)} exceeds the maximum of ${contract.maxReadingGrade.toFixed(1)}.`,
            vid,
          ),
        );
      }
    }
  }

  return issues;
}

/**
 * Validate the whole registry. Called at module load in `registry.ts` and in CI.
 *
 * Throwing on load is intentional: a registry with an inconsistent surface is not a
 * degraded site, it is a site that will render `undefined` into someone's hero
 * section. Fail at boot, where it is one alert, not at request time, where it is a
 * thousand.
 */
export function assertRegistryValid(surfaces: readonly AnySurface[]): readonly ValidationIssue[] {
  const all = surfaces.flatMap((s) => validateSurface(s));
  const errors = all.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  - [${e.surface}${e.variant ? ` / ${e.variant}` : ''}] ${e.rule}: ${e.message}`)
      .join('\n');
    throw new Error(`Surface registry is invalid:\n${detail}`);
  }
  return all;
}
