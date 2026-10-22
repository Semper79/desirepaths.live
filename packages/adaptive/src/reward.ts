/**
 * The composite reward.
 *
 * Section 2.2 defines it as
 *   0.40*signup + 0.25*meaningful_engagement + 0.20*scroll_depth_norm
 * + 0.10*return_visit + 0.05*share, minus a bounce penalty,
 * with the weights configurable and hot-reloadable.
 *
 * ClickHouse stores the *components*, never the reward - see the note at the top of
 * infra/clickhouse/init/002_aggregates.sql. This module is where the weights are
 * applied, which means a weight change takes effect on the next decision without a
 * backfill, and historical component data stays comparable forever.
 */

import { clamp01 } from './math';

/** Sufficient statistics for one (surface, variant, bucket) cell over some window. */
export interface RewardComponents {
  /** Sessions that saw this variant. The denominator for everything below. */
  readonly impressions: number;
  readonly signups: number;
  /** Sessions with >= 15s engaged time or >= 2 pageviews. */
  readonly engagedSessions: number;
  /** Sum of clamp(maxScroll / 100, 0, 1) across sessions. */
  readonly scrollNormSum: number;
  readonly returns: number;
  readonly shares: number;
  /** Single pageview and under 5s engaged. */
  readonly bounces: number;
}

export interface RewardWeights {
  readonly signup: number;
  readonly meaningful_engagement: number;
  readonly scroll_depth_norm: number;
  readonly return_visit: number;
  readonly share: number;
}

export const EMPTY_COMPONENTS: RewardComponents = {
  impressions: 0,
  signups: 0,
  engagedSessions: 0,
  scrollNormSum: 0,
  returns: 0,
  shares: 0,
  bounces: 0,
};

export function addComponents(a: RewardComponents, b: RewardComponents): RewardComponents {
  return {
    impressions: a.impressions + b.impressions,
    signups: a.signups + b.signups,
    engagedSessions: a.engagedSessions + b.engagedSessions,
    scrollNormSum: a.scrollNormSum + b.scrollNormSum,
    returns: a.returns + b.returns,
    shares: a.shares + b.shares,
    bounces: a.bounces + b.bounces,
  };
}

export interface RewardResult {
  /** Total reward accumulated over the window, in reward-units. */
  readonly total: number;
  /** Mean reward per impression, clamped to [0, 1]. This is what the Beta posterior tracks. */
  readonly perImpression: number;
  /** Contribution of each term, for the report's "why did this win" line. */
  readonly breakdown: Readonly<Record<keyof RewardWeights | 'bounce_penalty', number>>;
}

/**
 * Compute the composite reward.
 *
 * The result is clamped into [0, 1] because the Thompson layer models it as a Beta
 * likelihood, which has no support outside the unit interval. The clamp is a real
 * modelling choice with a real consequence: a variant with a catastrophic bounce
 * rate saturates at zero rather than going arbitrarily negative, so it stops being
 * punished further once it is already last. That is acceptable - the rollback
 * guardrail, not the reward, is what removes a genuinely broken variant.
 */
export function compositeReward(
  components: RewardComponents,
  weights: RewardWeights,
  bouncePenalty: number,
): RewardResult {
  const n = components.impressions;

  if (n <= 0) {
    return {
      total: 0,
      perImpression: 0,
      breakdown: {
        signup: 0,
        meaningful_engagement: 0,
        scroll_depth_norm: 0,
        return_visit: 0,
        share: 0,
        bounce_penalty: 0,
      },
    };
  }

  const breakdown = {
    signup: weights.signup * (components.signups / n),
    meaningful_engagement: weights.meaningful_engagement * (components.engagedSessions / n),
    scroll_depth_norm: weights.scroll_depth_norm * (components.scrollNormSum / n),
    return_visit: weights.return_visit * (components.returns / n),
    share: weights.share * (components.shares / n),
    bounce_penalty: -bouncePenalty * (components.bounces / n),
  } as const;

  const raw =
    breakdown.signup +
    breakdown.meaningful_engagement +
    breakdown.scroll_depth_norm +
    breakdown.return_visit +
    breakdown.share +
    breakdown.bounce_penalty;

  const perImpression = clamp01(raw);

  return { total: perImpression * n, perImpression, breakdown };
}

/**
 * Novelty decay (section 2.2 guardrail).
 *
 * A brand-new variant gets a burst of attention purely because it is different.
 * Regulars notice the change, click it, and inflate its early numbers; a week later
 * that lift is gone. Promoting on the strength of the first day is how an optimiser
 * ends up chasing its own tail, replacing a good variant with a worse one that
 * merely looked exciting on Tuesday.
 *
 * The fix is to weight early observations down and let them earn full weight as the
 * novelty wears off. The ramp is linear because the alternative - fitting an
 * exponential decay to the actual novelty curve - requires knowing that curve, and
 * every attempt to estimate it from data is contaminated by the very effect it is
 * trying to measure.
 *
 * Returns 1 when `decayHours` is 0, which is how the guardrail is disabled.
 */
export const NOVELTY_FLOOR = 0.35;

export function noveltyWeight(ageHours: number, decayHours: number): number {
  if (decayHours <= 0) return 1;
  if (ageHours >= decayHours) return 1;
  if (ageHours <= 0) return NOVELTY_FLOOR;
  return NOVELTY_FLOOR + (1 - NOVELTY_FLOOR) * (ageHours / decayHours);
}

export interface BetaPosterior {
  readonly alpha: number;
  readonly beta: number;
}

/**
 * Fold observed components into a Beta posterior.
 *
 * The reward is continuous in [0, 1] rather than binary, so this is a Beta
 * likelihood over a fractional success count - the standard trick, and the reason
 * the posteriors carry fractional pseudo-counts. `effectiveN` is the impression
 * count after novelty down-weighting; alpha and beta split it by the mean reward.
 *
 * Both parameters are floored just above zero. A Beta with a zero parameter is not a
 * distribution, and every consumer downstream would produce NaN rather than an
 * obviously wrong number.
 */
const PARAM_FLOOR = 1e-6;

export function foldPosterior(
  prior: BetaPosterior,
  components: RewardComponents,
  weights: RewardWeights,
  bouncePenalty: number,
  novelty = 1,
): BetaPosterior {
  const { perImpression } = compositeReward(components, weights, bouncePenalty);
  const effectiveN = components.impressions * novelty;
  const successes = perImpression * effectiveN;
  return {
    alpha: Math.max(PARAM_FLOOR, prior.alpha + successes),
    beta: Math.max(PARAM_FLOOR, prior.beta + (effectiveN - successes)),
  };
}

/**
 * Exponential forgetting.
 *
 * WHY THIS IS NOT OPTIONAL
 * The exploration floor guarantees that every variant keeps receiving traffic. It
 * does NOT guarantee the system can act on what it learns from that traffic. After
 * 20,000 observations a Beta posterior is so concentrated that 2% of traffic
 * trickling into a challenger cannot move it within any useful timeframe - the
 * simulation harness demonstrates exactly this: with the floor alone, a world whose
 * best arm changes leaves the bandit stuck on the old winner essentially forever.
 *
 * The fix is to bound the *effective* sample size. Each aggregation cycle, the
 * accumulated evidence is pulled back towards the prior by a factor gamma:
 *
 *     alpha' = prior.alpha + (alpha - prior.alpha) * gamma
 *
 * which caps the total pseudo-count at roughly `observations_per_cycle / (1 - gamma)`.
 * Old evidence fades geometrically, so a change in the world shows up in the
 * posterior within a few multiples of that horizon instead of never.
 *
 * CHOOSING GAMMA
 * The effective memory is `1 / (1 - gamma)` cycles. At the hourly cadence the worker
 * runs, 0.98 is about two days of memory - long enough to average over a weekend's
 * traffic pattern, short enough that a genuine change is picked up the same week.
 * Lower it and the bandit becomes twitchy; raise it and it becomes a museum.
 */
export const DEFAULT_DECAY = 0.98;

export function decayPosterior(
  posterior: BetaPosterior,
  prior: BetaPosterior,
  gamma = DEFAULT_DECAY,
): BetaPosterior {
  if (!(gamma > 0 && gamma <= 1)) {
    throw new RangeError(`decay gamma must be in (0, 1], got ${String(gamma)}`);
  }
  return {
    alpha: Math.max(PARAM_FLOOR, prior.alpha + (posterior.alpha - prior.alpha) * gamma),
    beta: Math.max(PARAM_FLOOR, prior.beta + (posterior.beta - prior.beta) * gamma),
  };
}

/**
 * Effective sample size a posterior can reach under a given decay, as a sanity check
 * on the configuration. Surfaced in the admin console so the operator can see that
 * "gamma = 0.999" means a variant needs 1,000 hours of evidence to be dislodged.
 */
export function effectiveMemoryCycles(gamma: number): number {
  if (gamma >= 1) return Number.POSITIVE_INFINITY;
  return 1 / (1 - gamma);
}
