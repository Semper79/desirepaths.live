/**
 * How much this site actually knows, as one number a visitor can be shown.
 *
 * WHY THIS EXISTS
 * Every competitor in adaptive optimisation hides the machine. The optimiser runs, the
 * page changes, and the visitor is told nothing — partly because most of those systems
 * could not survive being looked at. This one can, and that is the product's only real
 * moat: it is the one that can show its working.
 *
 * So the home page carries a live reading of the engine's own state. It is a marketing
 * surface and a technical one at the same time, which makes the honesty requirement
 * harder rather than softer.
 *
 * THE RULE THAT MAKES IT WORTH ANYTHING
 * Every number below is derived from the posteriors the renderer actually used. Nothing
 * is staged, nothing drifts upward on a timer, and the level goes **down** when the
 * evidence goes down — after a retirement, after a rollback, after a snapshot goes stale.
 * A bar that only ever climbs is a progress animation, and a visitor who works that out
 * has correctly concluded the whole site is theatre.
 *
 * WHAT IT MUST NEVER BECOME
 * An adaptive surface. If the bandit were allowed to optimise the presentation of this
 * number it would discover, correctly and quickly, which reading keeps people on the page
 * — and would then be reporting the most engaging number rather than the true one. The
 * surface registry has no entry for it and `sophistication.test.ts` asserts that it does
 * not.
 *
 * THREE COMPONENTS AND A DECAY
 * Same shape as `packages/crawler/src/score.ts`: weights are data rather than constants
 * buried in an expression, and every component is reported alongside the total.
 *
 * Freshness is deliberately *not* a fourth weighted component. It was, in the first
 * version, and that version reported 15% for a site with no surfaces, no traffic and
 * nothing learned — because its empty snapshot happened to be recent. A bar that pays out
 * for a working cron job is exactly the flattering number this module exists to refuse.
 * Staleness now multiplies what is known, so it can only take away.
 */

import { betaMean, probabilityGreater } from './beta';
import type { Arm } from './thompson';

/** One surface's arms, as the snapshot holds them. */
export interface SurfaceEvidence {
  readonly surfaceKey: string;
  readonly arms: readonly Arm[];
}

export interface SophisticationWeights {
  readonly evidence: number;
  readonly certainty: number;
  readonly breadth: number;
}

/**
 * Evidence leads because nothing else means anything without it: a surface can look
 * perfectly certain on nine impressions and be wrong. Certainty is close behind — it is
 * what a visitor intuitively reads as "does it know what it is doing". Breadth is the
 * smallest, because optimising three surfaces well beats optimising eleven badly.
 */
export const DEFAULT_SOPHISTICATION_WEIGHTS: SophisticationWeights = {
  evidence: 0.4,
  certainty: 0.35,
  breadth: 0.25,
};

export interface SophisticationConfig {
  readonly weights: SophisticationWeights;
  /** Below this many total impressions the site is honestly at zero. */
  readonly evidenceFloor: number;
  /** Total impressions at which the evidence term is full. */
  readonly evidenceHorizon: number;
  /** Impressions a surface needs before it counts as genuinely under optimisation. */
  readonly minImpressionsPerSurface: number;
  /** Snapshot age at which freshness reaches zero. */
  readonly staleAfterMs: number;
  /**
   * What a completely stale snapshot costs, as a fraction of the reading.
   *
   * Half, rather than everything. A worker six hours behind has not made the site
   * ignorant — it has made its conclusions old, and roughly half of what was true this
   * morning is still true. Zeroing the bar there would be its own kind of lie, and would
   * turn a routine pipeline hiccup into a page that claims the system knows nothing.
   */
  readonly stalePenalty: number;
}

export const DEFAULT_SOPHISTICATION_CONFIG: SophisticationConfig = {
  weights: DEFAULT_SOPHISTICATION_WEIGHTS,
  evidenceFloor: 100,
  evidenceHorizon: 1_000_000,
  // Matches `DEFAULT_RETIREMENT_CONFIG.minImpressionsBeforeRetire`. The same number
  // governs "enough evidence to act on" in both places, and two different answers to
  // that question would be a slow argument nobody notices they are having.
  minImpressionsPerSurface: 1_000,
  // The worker regenerates the snapshot hourly. Six hours means several regenerations
  // have been missed, which is a broken pipeline rather than a quiet period.
  staleAfterMs: 6 * 60 * 60 * 1000,
  stalePenalty: 0.5,
};

export interface SophisticationComponents {
  readonly evidence: number;
  readonly certainty: number;
  readonly breadth: number;
  /** Null when the snapshot's age is unknown; the term is dropped rather than guessed. */
  readonly freshness: number | null;
}

/**
 * The ladder shown next to the bar.
 *
 * Deliberately plain. The number is the hook; an adjective doing the work the number
 * should be doing is the first step towards a bar that means nothing.
 */
export type SophisticationLabel =
  'cold start' | 'observing' | 'learning' | 'deciding' | 'confident' | 'converged';

export interface Sophistication {
  /** 0..1. */
  readonly level: number;
  readonly label: SophisticationLabel;
  readonly components: SophisticationComponents;
  /** Total impressions behind the reading. */
  readonly observations: number;
  /** Surfaces carrying a real choice — two or more arms past the impression floor. */
  readonly surfacesOptimising: number;
  readonly surfacesTotal: number;
  /** Plain language, for the page and for the operator asking why it moved. */
  readonly reason: string;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Log-scaled, because the tenth thousand impression teaches far less than the tenth.
 *
 * Linear would sit near zero for months and then jump, which is both a worse description
 * of what is happening and a worse thing to look at.
 */
function evidenceTerm(total: number, config: SophisticationConfig): number {
  const floor = Math.log10(1 + config.evidenceFloor);
  const horizon = Math.log10(1 + config.evidenceHorizon);
  if (horizon <= floor) return 0;

  return clamp01((Math.log10(1 + total) - floor) / (horizon - floor));
}

/**
 * How separated the leader is from its strongest challenger, per surface.
 *
 * `probabilityGreater(challenger, leader)` at 0.5 means a coin flip: the site has two
 * variants and no idea which is better, which is exactly zero knowledge and scores zero.
 * At 0.02 the question is settled and it scores 0.96.
 *
 * Surfaces with one arm are excluded rather than scored 1. There is no question there, and
 * counting a site with ten single-variant surfaces as maximally certain would let the
 * reading be inflated by removing variants — an incentive pointing the wrong way.
 *
 * THERE USED TO BE A `catch` HERE
 * `probabilityGreater` used to throw once the pseudo-counts passed roughly half a million,
 * which forgetting allows and the design target reaches, so this dropped such a surface
 * rather than let the home page fail. That was the right response to the bug and the wrong
 * thing to keep once it was fixed: D28 gave `beta.ts` a normal approximation for the
 * concentrated regime, and the call no longer throws.
 *
 * Removing the guard rather than leaving it is deliberate. A catch that can never fire is
 * a branch no test can reach, and this package's gate is 100% of them — so dead defensive
 * code here does not sit quietly, it fails the build. That is the gate working.
 */
function surfaceCertainty(arms: readonly Arm[]): number | null {
  if (arms.length < 2) return null;

  let leader = arms[0] as Arm;
  for (const arm of arms) {
    if (betaMean(arm.alpha, arm.beta) > betaMean(leader.alpha, leader.beta)) leader = arm;
  }

  let strongestChallenge = 0;
  for (const arm of arms) {
    if (arm.variantId === leader.variantId) continue;
    const chance = probabilityGreater(arm.alpha, arm.beta, leader.alpha, leader.beta);
    if (chance > strongestChallenge) strongestChallenge = chance;
  }

  // A challenger cannot be more than even money against the leader by posterior mean, so
  // this maps [0, 0.5] onto [1, 0] rather than wasting half the range.
  return clamp01(1 - strongestChallenge * 2);
}

/**
 * Where the reading is on the ladder.
 *
 * The bands are uneven on purpose. Getting off zero is easy and getting past 0.9 should be
 * rare, because "converged" is a strong claim and a site that shows it while still
 * exploring has lied to everyone reading the bar.
 */
export function labelFor(level: number): SophisticationLabel {
  if (level < 0.08) return 'cold start';
  if (level < 0.25) return 'observing';
  if (level < 0.45) return 'learning';
  if (level < 0.65) return 'deciding';
  if (level < 0.85) return 'confident';
  return 'converged';
}

/**
 * The reading, from the same arms the renderer just used.
 *
 * `snapshotAgeMs` is a parameter rather than a clock read, so "a six-hour-old snapshot
 * scores zero on freshness" is a test rather than a wait. Pass `null` when the age is
 * genuinely unknown and the term will be dropped — which is different from passing a large
 * number, and the difference is visible in `components.freshness`.
 */
export function sophistication(
  surfaces: readonly SurfaceEvidence[],
  snapshotAgeMs: number | null,
  config: SophisticationConfig = DEFAULT_SOPHISTICATION_CONFIG,
): Sophistication {
  let observations = 0;
  let optimising = 0;
  let certaintySum = 0;

  for (const surface of surfaces) {
    let surfaceImpressions = 0;
    for (const arm of surface.arms) surfaceImpressions += arm.impressions;
    observations += surfaceImpressions;

    // Evidence gates certainty rather than merely outweighing it. A weighted sum let a
    // surface with a confident-looking posterior and almost no traffic carry the reading
    // to 35% — which contradicts the first line of the weights' own rationale, that a
    // surface can look perfectly certain on nine impressions and be wrong. Below the
    // floor there is nothing to be certain *about*, however separated the arms look.
    if (surfaceImpressions < config.minImpressionsPerSurface) continue;

    const certainty = surfaceCertainty(surface.arms);
    if (certainty !== null) {
      certaintySum += certainty;
      optimising += 1;
    }
  }

  const evidence = evidenceTerm(observations, config);

  // No surface past the floor with a live choice means there is nothing to be certain
  // about. Zero rather than dropped: a site with no experiment it can act on is genuinely
  // unsophisticated, which is a different statement from "this could not be measured".
  const certainty = optimising === 0 ? 0 : certaintySum / optimising;
  const breadth = surfaces.length === 0 ? 0 : optimising / surfaces.length;
  const freshness =
    snapshotAgeMs === null ? null : clamp01(1 - snapshotAgeMs / config.staleAfterMs);

  const weights = config.weights;
  const weighted =
    evidence * weights.evidence + certainty * weights.certainty + breadth * weights.breadth;
  const totalWeight = weights.evidence + weights.certainty + weights.breadth;
  const knowledge = totalWeight === 0 ? 0 : clamp01(weighted / totalWeight);

  // A multiplier, so it can only take away. An unknown age is not treated as staleness —
  // it is treated as no information, which leaves the reading alone and shows up as a null
  // in `components.freshness` for anyone who wants to know why.
  const decay = freshness === null ? 1 : 1 - config.stalePenalty * (1 - freshness);
  const level = clamp01(knowledge * decay);

  return {
    level,
    label: labelFor(level),
    components: { evidence, certainty, breadth, freshness },
    observations,
    surfacesOptimising: optimising,
    surfacesTotal: surfaces.length,
    reason: explain(level, observations, optimising, surfaces.length, freshness),
  };
}

/**
 * Why the bar reads what it reads, in one sentence.
 *
 * Named after the thing that is actually holding the number down, because "37%" invites
 * the question and a page that raises a question it will not answer is worse than one that
 * stayed quiet. The order is the order a person would diagnose it in: no data beats
 * unclear data beats a narrow experiment beats a stale pipeline.
 */
function explain(
  level: number,
  observations: number,
  optimising: number,
  total: number,
  freshness: number | null,
): string {
  if (total === 0) return 'No surfaces are registered, so there is nothing to learn about.';

  if (observations === 0) {
    return 'No visits measured yet — every surface is serving its baseline while it waits.';
  }

  if (freshness !== null && freshness < 0.2) {
    return `The posteriors are stale: ${String(observations)} observations are recorded, but the snapshot has not been refreshed recently, so the site is running on old conclusions.`;
  }

  if (optimising === 0) {
    return `${String(observations)} observations so far, none of them on a surface with enough evidence to decide anything yet.`;
  }

  if (optimising < total) {
    return `Actively optimising ${String(optimising)} of ${String(total)} surfaces from ${String(observations)} observations; the rest are still gathering evidence.`;
  }

  if (level < 0.85) {
    return `All ${String(total)} surfaces are under optimisation across ${String(observations)} observations, and several still have credible challengers.`;
  }

  return `All ${String(total)} surfaces have settled on a champion across ${String(observations)} observations, with no challenger close enough to matter.`;
}
