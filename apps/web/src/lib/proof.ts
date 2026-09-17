/**
 * What the site has worked out, in public.
 *
 * `/live` answers "what did *I* get, and why". This answers "what has this thing actually
 * learned", which is a different question with a different audience.
 *
 * It is publishable here for a structural reason rather than a brave one: an adaptive
 * optimiser normally runs on somebody else's site, so its results are that customer's to
 * disclose. This site is the thing being optimised, so the evidence is ours to show. See
 * D27 in `docs/DECISIONS.md`.
 *
 * Pure, and derived only from the published snapshot. Every number here is one the engine
 * actually used to serve a page — there is no separate reporting path that could flatter
 * it, which is exactly why it can be published.
 */

import { SURFACES, SURFACE_KEYS, type SurfaceKey } from '@morph/core';
import { betaCredibleInterval, betaMean, summarise, type Arm } from '@morph/adaptive';

export interface SettledSurface {
  readonly key: SurfaceKey;
  readonly description: string;
  /** The variant currently being served to most visitors. */
  readonly winner: string;
  /** Its measured reward per impression, in [0, 1]. */
  readonly reward: number;
  /** How much better than the surface's weakest live option, as a ratio. */
  readonly marginOverWorst: number;
  /**
   * Probability the strongest challenger is actually better.
   *
   * Low means settled. Reported rather than hidden because a leader at 48% is a coin flip
   * the site is currently calling, and saying so is the difference between transparency
   * and a scoreboard.
   */
  readonly challengerChance: number;
  readonly impressions: number;
  /** 95% credible interval on the winner's reward. The honest error bar. */
  readonly interval: readonly [number, number];
  readonly liveVariants: number;
  /**
   * Every option tried on this surface, best first.
   *
   * Carried so the page can draw the *spread* rather than a single mark. A bar scaled to
   * the winner alone always sits at the right-hand end and communicates nothing; showing
   * where the alternatives landed is what makes the winner's margin legible.
   */
  readonly options: readonly { readonly variantId: string; readonly reward: number }[];
}

export interface Proof {
  readonly settled: readonly SettledSurface[];
  /** Surfaces with live evidence but no clear answer yet. */
  readonly stillDeciding: readonly SettledSurface[];
  /** Surfaces the engine has no evidence for at all. */
  readonly notYetMeasured: readonly SurfaceKey[];
  readonly totalImpressions: number;
  readonly generatedAt: number;
  readonly adaptationEnabled: boolean;
}

/**
 * A surface counts as settled when the strongest challenger is under this.
 *
 * Five per cent, matching the retirement guardrail's own posture rather than inventing a
 * second threshold for display. A page that called something settled on evidence the
 * engine would not act on would be describing a different system.
 */
const SETTLED_BELOW = 0.05;

/** A Beta needs both parameters strictly positive and finite to be a distribution at all. */
function isUsable(arm: Arm): boolean {
  return Number.isFinite(arm.alpha) && arm.alpha > 0 && Number.isFinite(arm.beta) && arm.beta > 0;
}

export function proofFrom(
  arms: Readonly<Record<string, readonly Arm[]>>,
  generatedAt: number,
  adaptationEnabled: boolean,
): Proof {
  const settled: SettledSurface[] = [];
  const stillDeciding: SettledSurface[] = [];
  const notYetMeasured: SurfaceKey[] = [];
  let totalImpressions = 0;

  for (const key of SURFACE_KEYS) {
    // Filtered here as well as in `parseSnapshot`, and the redundancy is deliberate: a
    // Beta with a non-positive parameter is not a distribution, and `lnGamma` throws on
    // one rather than returning a wrong number. That throw would be a 500 on the most
    // shareable page the site has, caused by one malformed entry in a Redis key anything
    // in the cluster could write to. Found by a test that constructed exactly that.
    const live = (arms[key] ?? []).filter(isUsable);
    totalImpressions += live.reduce((sum, arm) => sum + arm.impressions, 0);

    // Fewer than two arms is not a result. One variant means there was never a question,
    // and reporting it as a finding would inflate the page with things nobody chose.
    if (live.length < 2) {
      notYetMeasured.push(key);
      continue;
    }

    const row = describe(key, live);
    if (row.challengerChance < SETTLED_BELOW) settled.push(row);
    else stillDeciding.push(row);
  }

  // Strongest results first: a reader scanning this page should meet the most convincing
  // thing the site knows, not whichever surface happens to sort first alphabetically.
  settled.sort((a, b) => b.marginOverWorst - a.marginOverWorst);
  stillDeciding.sort((a, b) => a.challengerChance - b.challengerChance);

  return {
    settled,
    stillDeciding,
    notYetMeasured,
    totalImpressions,
    generatedAt,
    adaptationEnabled,
  };
}

function describe(key: SurfaceKey, live: readonly Arm[]): SettledSurface {
  const stats = summarise(live);

  let leader = live[0] as Arm;
  for (const arm of live) {
    if (betaMean(arm.alpha, arm.beta) > betaMean(leader.alpha, leader.beta)) leader = arm;
  }

  const leaderReward = betaMean(leader.alpha, leader.beta);
  const worstReward = live.reduce(
    (worst, arm) => Math.min(worst, betaMean(arm.alpha, arm.beta)),
    Number.POSITIVE_INFINITY,
  );

  const challengerChance = stats
    .filter((stat) => stat.variantId !== leader.variantId)
    .reduce((strongest, stat) => Math.max(strongest, stat.probabilityBest), 0);

  return {
    key,
    description: SURFACES[key].description,
    winner: leader.variantId,
    reward: leaderReward,
    // Guarded: a worst arm at exactly zero would make the ratio infinite, and "∞% better"
    // is not a claim, it is a division that got away.
    marginOverWorst: worstReward > 0 ? leaderReward / worstReward - 1 : 0,
    challengerChance,
    impressions: live.reduce((sum, arm) => sum + arm.impressions, 0),
    interval: betaCredibleInterval(leader.alpha, leader.beta),
    liveVariants: live.length,
    options: live
      .map((arm) => ({ variantId: arm.variantId, reward: betaMean(arm.alpha, arm.beta) }))
      .sort((a, b) => b.reward - a.reward),
  };
}

/** One measurement, in the shape `packages/seo`'s `dataset()` wants. */
export interface ProofMeasurement {
  readonly name: string;
  readonly value: number;
  readonly unitCode: string;
  readonly description: string;
}

/**
 * The findings, as structured data.
 *
 * The whole AEO position in one array. An answer engine asked whether adaptive design
 * actually works wants a number with a name on it, and a `PropertyValue` gets quoted with
 * its value intact where the same figure in prose gets summarised away.
 *
 * ONLY SETTLED FINDINGS ARE PUBLISHED, AND THAT IS THE POINT
 * Emitting the undecided ones would be technically complete and strategically wrong. A
 * model has no way to carry "under a 5% chance the runner-up is better" through a
 * summary, so an ambiguous figure here becomes a confident claim somewhere else, with our
 * name on it. The page shows the undecided results to a human who can read the caveat
 * next to them; the machine-readable layer does not.
 */
export function measurements(proof: Proof): readonly ProofMeasurement[] {
  const findings = proof.settled.map((row) => ({
    name: row.key,
    // One decimal is as much precision as a ratio of two estimates supports, and more
    // would invite a reader to believe the last digit.
    value: Math.round(row.marginOverWorst * 1000) / 10,
    unitCode: 'P1',
    description: `${row.winner} outperformed the weakest option for this surface by ${String(
      Math.round(row.marginOverWorst * 100),
    )}% across ${format(row.impressions)} measured visits, with a 95% credible interval of ${(
      row.interval[0] * 100
    ).toFixed(1)}% to ${(row.interval[1] * 100).toFixed(1)}%.`,
  }));

  return [
    {
      name: 'Design decisions settled',
      value: proof.settled.length,
      unitCode: 'C62',
      description:
        'Adaptive surfaces where the evidence has reached the same threshold the engine requires before retiring a variant.',
    },
    {
      name: 'Measured visits',
      value: proof.totalImpressions,
      unitCode: 'C62',
      description:
        'Visits contributing to the figures on this page. Automated traffic and the pinned holdout cohort are excluded.',
    },
    ...findings,
  ];
}

/**
 * The one sentence a share should carry.
 *
 * Written from the data rather than chosen from a list, so it cannot describe a state the
 * site is not in. It is what goes on the social card and what an AI crawler is most likely
 * to quote, which makes it the highest-leverage string in the codebase.
 */
export function headline(proof: Proof): string {
  if (proof.generatedAt === 0) return 'This site has not measured anything yet.';

  if (proof.settled.length === 0) {
    return proof.stillDeciding.length === 0
      ? 'This site is still gathering its first evidence.'
      : `This site is testing ${String(proof.stillDeciding.length)} things about itself and has not settled any of them yet.`;
  }

  const best = proof.settled[0] as SettledSurface;
  const margin = Math.round(best.marginOverWorst * 100);

  return `This site has settled ${String(proof.settled.length)} of its own design decisions from ${format(proof.totalImpressions)} measured visits. The largest difference it found was ${String(margin)}%.`;
}

/** Compact, because a share does not have room for 1,284,003. */
export function format(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
