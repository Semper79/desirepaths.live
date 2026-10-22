/**
 * The decision function.
 *
 * Everything else in this package is machinery; this is the thing that runs on the
 * request path, inside edge middleware, once per surface per visitor, with a budget
 * of 5 ms for all of them together. It is pure: same inputs, same output, no clock,
 * no network, no global state.
 *
 * ORDER OF PRECEDENCE - read this before changing anything
 *   1. Operator pin          - a human said so; nothing overrides a human.
 *   2. Adaptation disabled   - /pause_adaptation and /kill freeze on the champion.
 *   3. Consent not granted   - no measurement means no adaptation. Baseline.
 *   4. Holdout cohort        - the 5% that must never adapt, or lift is unmeasurable.
 *   5. Forced exploration    - the floor that keeps the system able to learn.
 *   6. Thompson + LinUCB     - the actual optimiser.
 *   7. Baseline fallback     - nothing eligible is left; render something valid.
 *
 * The list is ordered by authority, not by convenience. Every rule above a given
 * line is allowed to ignore everything below it.
 */

import { createRng, hashString, type Rng } from './rng';
import { leaderOf, type Arm } from './thompson';
import { scoreArm, type LinUcbArmState } from './linucb';
import { isHoldout, shouldForceExplore, uniformChoice } from './guardrails';
import { clamp01 } from './math';

export type DecisionReason =
  | 'pinned'
  | 'adaptation_paused'
  | 'no_consent'
  | 'holdout'
  | 'forced_exploration'
  | 'thompson'
  | 'contextual'
  | 'baseline_fallback';

export interface AssignmentConfig {
  readonly holdoutFraction: number;
  readonly explorationFloor: number;
  /**
   * Maximum weight the contextual model may take in the blended score. Capped below
   * 1 so the robust layer always retains a say: LinUCB is a linear model of a
   * non-linear world and its confidence is only as good as its specification.
   */
  readonly maxContextualWeight: number;
  /**
   * Updates a LinUCB arm needs before it reaches `maxContextualWeight`. Below this
   * the linear fit is mostly ridge prior, and trusting it would be trusting noise
   * with a confident-looking bound attached.
   */
  readonly contextualWarmupUpdates: number;
  /** LinUCB exploration coefficient. */
  readonly contextualAlpha: number;
}

export const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
  holdoutFraction: 0.05,
  explorationFloor: 0.02,
  maxContextualWeight: 0.6,
  contextualWarmupUpdates: 500,
  contextualAlpha: 0.6,
};

export interface AssignmentInput {
  /** Rotating daily anonymous id. Never a raw identifier. */
  readonly anonId: string;
  readonly surfaceId: string;
  /** Eligible arms: active variants only. Quarantined and retired ones never appear. */
  readonly arms: readonly Arm[];
  readonly baselineVariantId: string;
  /** Set when an operator pinned a variant with /pin. */
  readonly pinnedVariantId?: string | undefined;
  /** Dense covariate vector. Absent means the contextual layer is skipped. */
  readonly features?: readonly number[] | undefined;
  /** Per-variant LinUCB state, keyed by variant id. */
  readonly contextualArms?: ReadonlyMap<string, LinUcbArmState> | undefined;
  readonly adaptationEnabled: boolean;
  /** Whether the visitor's consent tier reaches this surface's requirement. */
  readonly consentGranted: boolean;
  readonly config?: AssignmentConfig | undefined;
}

export interface AssignmentDecision {
  readonly variantId: string;
  readonly reason: DecisionReason;
  readonly isHoldout: boolean;
  /** Scores for every eligible arm, for debugging and the admin console. */
  readonly scores?: ReadonlyMap<string, number> | undefined;
}

/**
 * Weight given to the contextual model, ramped by how much evidence it has.
 *
 * A cold LinUCB arm returns a large confidence bonus for every context, because
 * every context is unexplored. Blending that in at full weight from the first
 * request would turn a careful Bayesian bandit into a random number generator with
 * extra steps.
 */
export function contextualWeight(updates: number, config: AssignmentConfig): number {
  if (config.contextualWarmupUpdates <= 0) return config.maxContextualWeight;
  const ramp = Math.min(1, updates / config.contextualWarmupUpdates);
  return config.maxContextualWeight * ramp;
}

/**
 * Deterministic per-(visitor, surface) RNG.
 *
 * Seeding from the visitor id means the draw is reproducible: two edge nodes handling
 * two requests from the same visitor in the same second reach the same decision
 * without sharing state. Including the surface id means the ten surfaces do not all
 * draw from a correlated stream, which would make certain combinations of variants
 * systematically over-represented.
 *
 * Note what this does NOT do: it does not make the assignment stable *over time*. The
 * posteriors move, so the same seed can produce a different winner tomorrow. Session
 * stickiness is the caching layer's job - the resolved assignment is written to Redis
 * with a 30-day TTL. Trying to achieve stickiness here, by hashing into a fixed slot,
 * would freeze a visitor onto a variant that has since been retired.
 */
export function rngFor(anonId: string, surfaceId: string): Rng {
  return createRng(hashString(`assign:${surfaceId}:${anonId}`));
}

export function decide(input: AssignmentInput): AssignmentDecision {
  const config = input.config ?? DEFAULT_ASSIGNMENT_CONFIG;
  const holdout = isHoldout(input.anonId, config.holdoutFraction);

  // 1. An operator pin outranks everything, including a quarantine: if a human
  //    pinned it, a human can unpin it, and second-guessing them here would make
  //    /pin unreliable exactly when it is being used to stop an incident.
  if (input.pinnedVariantId !== undefined) {
    return { variantId: input.pinnedVariantId, reason: 'pinned', isHoldout: holdout };
  }

  // 7. (evaluated early because everything below assumes at least one arm)
  if (input.arms.length === 0) {
    return { variantId: input.baselineVariantId, reason: 'baseline_fallback', isHoldout: holdout };
  }

  // 2. Frozen by /pause_adaptation or /kill. The site keeps working on the current
  //    champion; it simply stops learning.
  if (!input.adaptationEnabled) {
    return {
      variantId: leaderOf(input.arms).variantId,
      reason: 'adaptation_paused',
      isHoldout: holdout,
    };
  }

  // 3. No consent, no measurement, no adaptation. The baseline is not a degraded
  //    experience - it is exactly what the holdout cohort sees.
  if (!input.consentGranted) {
    return { variantId: input.baselineVariantId, reason: 'no_consent', isHoldout: holdout };
  }

  // 4. The pinned baseline cohort.
  if (holdout) {
    return { variantId: input.baselineVariantId, reason: 'holdout', isHoldout: true };
  }

  const rng = rngFor(input.anonId, input.surfaceId);

  // 5. Exploration floor.
  if (shouldForceExplore(rng, config.explorationFloor)) {
    return {
      variantId: uniformChoice(input.arms, rng).variantId,
      reason: 'forced_exploration',
      isHoldout: false,
    };
  }

  // 6. Thompson draw, optionally blended with the contextual model.
  const scores = new Map<string, number>();
  let best = input.arms[0] as Arm;
  let bestScore = Number.NEGATIVE_INFINITY;
  let usedContextual = false;

  for (const arm of input.arms) {
    const thompsonSample = rng.beta(arm.alpha, arm.beta);
    let score = thompsonSample;

    const contextual = input.contextualArms?.get(arm.variantId);
    if (contextual !== undefined && input.features !== undefined) {
      const { ucb } = scoreArm(contextual, input.features, config.contextualAlpha);
      const weight = contextualWeight(contextual.updates, config);
      if (weight > 0) {
        usedContextual = true;
        // The UCB is not bounded to [0, 1] the way a Thompson draw is; clamping
        // rather than rescaling keeps the two comparable without letting one
        // pathological arm compress the whole range.
        const clamped = clamp01(ucb);
        score = (1 - weight) * thompsonSample + weight * clamped;
      }
    }

    scores.set(arm.variantId, score);
    if (score > bestScore) {
      bestScore = score;
      best = arm;
    }
  }

  return {
    variantId: best.variantId,
    reason: usedContextual ? 'contextual' : 'thompson',
    isHoldout: false,
    scores,
  };
}

/**
 * Stable 64-bit hash of a complete assignment vector, as a decimal string.
 *
 * Written onto every event so a whole combination can be evaluated without exploding
 * the per-surface arrays. FNV-1a over the sorted `surface=variant` pairs: sorted so
 * two structurally identical assignments hash identically regardless of iteration
 * order, and BigInt so the value survives the round trip through JSON, Kafka and a
 * ClickHouse UInt64 without the silent precision loss a double would introduce past
 * 2^53.
 */
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function assignmentHash(assignment: Readonly<Record<string, string>>): string {
  // `Object.keys().sort()` then index, rather than sorting entries: a comparator over
  // entries needs an equal-keys arm that is unreachable (object keys are unique), and
  // this package does not ship unreachable branches.
  const canonical = Object.keys(assignment)
    .sort()
    .map((key) => `${key}=${String(assignment[key])}`)
    .join(' ');

  let h = FNV64_OFFSET;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= BigInt(canonical.charCodeAt(i));
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString();
}
