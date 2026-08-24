/**
 * Assignment resolution — the request-path heart of the adaptive site.
 *
 * Runs in edge middleware, once per visitor per request, inside a budget of about 5 ms
 * for all eleven surfaces together. Everything here is either a map lookup or a call
 * into `@morph/adaptive`, which is pure; the only I/O is a single cache read.
 *
 * THE RULE THAT MAKES AN ADAPTIVE SITE INDEXABLE
 *
 * A search crawler is a visitor. Left alone, that means:
 *
 *  - the indexed version of a page is whichever variant the bandit drew for the
 *    crawler that day, and it changes between crawls, so ranking signals accumulate
 *    against a moving target; and
 *  - the site serves crawlers systematically different content from humans, which has
 *    the shape of cloaking regardless of the fact that a bandit rather than a person
 *    is choosing.
 *
 * So: **any request at or above the bot threshold receives the baseline assignment** —
 * byte-for-byte what the 5% holdout cohort sees, every time, forever. Crawler traffic
 * is also excluded from the posteriors, which it would otherwise pollute; a crawler
 * never converts, so counting it would teach the optimiser that every variant is bad.
 *
 * That single rule is what lets the site be simultaneously adaptive and SEO-legible.
 */

import {
  BASELINE_ASSIGNMENT,
  SURFACE_KEYS,
  SURFACES,
  featureVector,
  mayAdapt,
  variantId,
  type FullAssignment,
  type SurfaceKey,
  type VariantId,
  type VisitorContext,
} from '@morph/core';
import { assignmentHash, decide, type Arm } from '@morph/adaptive';

/**
 * The variant pool as the engine sees it, keyed by surface.
 *
 * Published to the cache by the worker every aggregation cycle. Middleware never
 * queries a database: a cold cache means the baseline, not a slow page.
 */
export interface PosteriorSnapshot {
  readonly arms: Readonly<Record<string, readonly Arm[]>>;
  /** Operator pins, from `/pin`. Overrides everything including a quarantine. */
  readonly pinned?: Readonly<Record<string, string>>;
  readonly adaptationEnabled: boolean;
  /** Stamped so a stale snapshot is visible rather than silently believed. */
  readonly generatedAt: number;
}

export interface AssignmentStore {
  /** Sticky assignment for a returning visitor, or null. */
  read(anonId: string): Promise<FullAssignment | null>;
  write(anonId: string, assignment: FullAssignment, ttlSeconds: number): Promise<void>;
}

export interface ResolveInput {
  readonly anonId: string;
  readonly context: VisitorContext;
  readonly snapshot: PosteriorSnapshot;
  /** 0–100, from the same scorer the collector uses. */
  readonly botScore: number;
  /** Sticky assignment already read from the cache, when there was one. */
  readonly cached: FullAssignment | null;
}

export type AssignmentSource =
  /** Served the baseline because the request is automated. */
  | 'crawler'
  /** Reused a sticky assignment from the cache. */
  | 'sticky'
  /** Computed fresh. */
  | 'computed'
  /** Pinned baseline cohort. */
  | 'holdout'
  /** Consent not granted for adaptation. */
  | 'baseline';

export interface ResolvedAssignment {
  readonly assignment: FullAssignment;
  readonly hash: string;
  readonly isHoldout: boolean;
  readonly source: AssignmentSource;
  /**
   * Whether this request's behaviour should count towards the posteriors. False for
   * crawlers: a crawler never converts, so counting it teaches the optimiser that
   * every variant is bad.
   */
  readonly measurable: boolean;
  /** Per-surface reason, for the admin console and for debugging a surprising page. */
  readonly reasons: Readonly<Record<string, string>>;
}

/** Matches the collector's threshold. Two different numbers here would be a silent bug. */
export const BOT_THRESHOLD = 60;

/** Section 2.2: a returning visitor keeps their variant. 30 days. */
export const STICKY_TTL_SECONDS = 30 * 24 * 60 * 60;

function baselineResult(
  source: AssignmentSource,
  isHoldout: boolean,
  reason: string,
): ResolvedAssignment {
  const reasons: Record<string, string> = {};
  for (const key of SURFACE_KEYS) reasons[key] = reason;
  return {
    assignment: BASELINE_ASSIGNMENT,
    hash: assignmentHash(BASELINE_ASSIGNMENT),
    isHoldout,
    source,
    measurable: source !== 'crawler',
    reasons,
  };
}

/**
 * Resolve the assignment for one request.
 *
 * Pure: the caller performs the cache read and passes the result in, and performs the
 * write afterwards. That keeps this function testable and keeps the I/O visible at the
 * call site rather than hidden three layers down.
 */
export function resolveAssignment(input: ResolveInput): ResolvedAssignment {
  // 1. Automated traffic gets the baseline, always. See the note at the top of this file.
  if (input.botScore >= BOT_THRESHOLD) {
    return baselineResult('crawler', false, 'crawler: baseline served for index stability');
  }

  // 2. Consent gates adaptation entirely. The baseline is not a degraded experience —
  //    it is exactly what the holdout cohort sees.
  if (!mayAdapt(input.context.consentMask, 'analytics')) {
    return baselineResult('baseline', false, 'no analytics consent');
  }

  // 3. A sticky assignment is reused if every surface in it is still servable. A
  //    variant that has since been retired or quarantined must not be re-served, or a
  //    returning visitor keeps seeing something the guardrails removed.
  if (input.cached !== null && isStillServable(input.cached, input.snapshot)) {
    const reasons: Record<string, string> = {};
    for (const key of SURFACE_KEYS) reasons[key] = 'sticky';
    return {
      assignment: input.cached,
      hash: assignmentHash(input.cached),
      isHoldout: false,
      source: 'sticky',
      measurable: true,
      reasons,
    };
  }

  // 4. Compute, one surface at a time.
  const features = featureVector(input.context);
  const assignment: Partial<Record<SurfaceKey, VariantId>> = {};
  const reasons: Record<string, string> = {};
  let isHoldout = false;

  for (const key of SURFACE_KEYS) {
    const surface = SURFACES[key];
    const arms = input.snapshot.arms[key] ?? [];
    const pinned = input.snapshot.pinned?.[key];

    const decision = decide({
      anonId: input.anonId,
      surfaceId: key,
      arms,
      baselineVariantId: surface.baselineVariantId,
      features,
      adaptationEnabled: input.snapshot.adaptationEnabled,
      // A surface may require a higher consent tier than the site as a whole.
      consentGranted: mayAdapt(input.context.consentMask, surface.constraints.requiresConsent),
      ...(pinned === undefined ? {} : { pinnedVariantId: pinned }),
    });

    // Branded at the boundary. The ids come from our own registry, so this is a
    // redundancy rather than a check — but it is a redundancy that costs a regex test
    // and catches a corrupted cache entry at the point it is read.
    assignment[key] = variantId(decision.variantId);
    reasons[key] = decision.reason;
    if (decision.isHoldout) isHoldout = true;
  }

  // Every key was written in the loop above, so the Partial is complete.
  const full = assignment as FullAssignment;

  return {
    assignment: full,
    hash: assignmentHash(assignment),
    isHoldout,
    source: isHoldout ? 'holdout' : 'computed',
    measurable: true,
    reasons,
  };
}

/**
 * Is every variant in a cached assignment still eligible to be served?
 *
 * The baseline always is — it cannot be retired, by construction. Anything else must
 * still appear in the current arm set, which the worker builds from active variants
 * only. This is what stops a 30-day sticky assignment from outliving a quarantine.
 */
export function isStillServable(assignment: FullAssignment, snapshot: PosteriorSnapshot): boolean {
  for (const key of SURFACE_KEYS) {
    const variantId = assignment[key];
    if (variantId === SURFACES[key].baselineVariantId) continue;

    const arms = snapshot.arms[key];
    if (arms === undefined || !arms.some((arm) => arm.variantId === variantId)) return false;
  }
  return true;
}

/**
 * Payload written onto every event, and read back by the renderer.
 *
 * Two parallel arrays rather than an object, matching the ClickHouse column layout
 * exactly — see `infra/clickhouse/init/001_events.sql`. Converting shape at the
 * boundary is where field-name drift starts.
 */
export interface AssignmentWire {
  readonly surfaces: readonly string[];
  readonly variants: readonly string[];
  readonly assignmentHash: string;
  readonly holdout: 0 | 1;
}

export function toWire(resolved: ResolvedAssignment): AssignmentWire {
  const surfaces: string[] = [];
  const variants: string[] = [];
  for (const key of SURFACE_KEYS) {
    surfaces.push(key);
    variants.push(resolved.assignment[key]);
  }
  return {
    surfaces,
    variants,
    assignmentHash: resolved.hash,
    holdout: resolved.isHoldout ? 1 : 0,
  };
}

/** Parse the wire form back into an assignment, ignoring anything unrecognised. */
export function fromWire(wire: AssignmentWire): FullAssignment | null {
  if (wire.surfaces.length !== wire.variants.length) return null;

  const assignment: Partial<Record<SurfaceKey, VariantId>> = {};
  wire.surfaces.forEach((surface, index) => {
    const variant = wire.variants[index];
    if (variant === undefined) return;
    if (!(SURFACE_KEYS as readonly string[]).includes(surface)) return;
    try {
      assignment[surface as SurfaceKey] = variantId(variant);
    } catch {
      // A malformed id from a cookie, a stale cache or a hand-edited request. Leaving
      // the surface unset makes the assignment incomplete, which is rejected below.
    }
  });

  // A partial assignment is not an assignment: rendering with a missing surface is
  // exactly the `undefined` in a hero section the registry exists to prevent.
  for (const key of SURFACE_KEYS) {
    if (assignment[key] === undefined) return null;
  }
  return assignment as FullAssignment;
}

/** In-memory store, for tests and for local development without Redis. */
export class MemoryAssignmentStore implements AssignmentStore {
  private readonly entries = new Map<string, FullAssignment>();

  read(anonId: string): Promise<FullAssignment | null> {
    return Promise.resolve(this.entries.get(anonId) ?? null);
  }

  write(anonId: string, assignment: FullAssignment, _ttlSeconds: number): Promise<void> {
    // The TTL is ignored: this store exists for tests and for local development, where
    // the process is shorter-lived than any TTL worth honouring. The Redis
    // implementation is where expiry actually means something.
    void _ttlSeconds;
    this.entries.set(anonId, assignment);
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }
}

export type { SurfaceKey };
