/**
 * Hot-reloadable engine configuration.
 *
 * Section 2.2: "Weights live in DB config and are hot-reloadable." This file is the
 * schema for that row. The values below are defaults for a cold start, not the
 * source of truth at runtime - the worker reads the row, validates it here, and
 * publishes it to Redis for the edge to pick up on its next decision.
 *
 * Every field that changes the meaning of a historical measurement is versioned:
 * changing a reward weight makes yesterday's rewards incomparable with today's, so
 * `rewardVersion` is stamped onto every adaptation-log entry. The Telegram report
 * refuses to compare across versions rather than quietly reporting a fake lift.
 */

import { z } from 'zod';

export const RewardWeightsSchema = z
  .object({
    signup: z.number().min(0).max(1),
    meaningful_engagement: z.number().min(0).max(1),
    scroll_depth_norm: z.number().min(0).max(1),
    return_visit: z.number().min(0).max(1),
    share: z.number().min(0).max(1),
  })
  .refine(
    (w) =>
      Math.abs(
        w.signup + w.meaningful_engagement + w.scroll_depth_norm + w.return_visit + w.share - 1,
      ) < 1e-6,
    { message: 'Positive reward weights must sum to exactly 1.' },
  );

export type RewardWeights = z.infer<typeof RewardWeightsSchema>;

/** The defaults from section 2.2, verbatim. */
export const DEFAULT_REWARD_WEIGHTS: RewardWeights = {
  signup: 0.4,
  meaningful_engagement: 0.25,
  scroll_depth_norm: 0.2,
  return_visit: 0.1,
  share: 0.05,
};

export const EngineConfigSchema = z.object({
  /** Bumped whenever weights change, so incomparable history is never compared. */
  rewardVersion: z.number().int().min(1),
  weights: RewardWeightsSchema,
  /**
   * Subtracted from the reward of a bounced session. Kept outside the weight
   * simplex because it is a penalty, not a share of a budget: making it one of the
   * five positive weights would force a trade-off against sign-ups that has no
   * meaning.
   */
  bouncePenalty: z.number().min(0).max(0.5),

  /** Section 2.2 guardrails. */
  holdoutFraction: z.number().min(0).max(0.2),
  explorationFloor: z.number().min(0.001).max(0.5),
  minImpressionsBeforeRetire: z.number().int().min(100),
  msprtAlpha: z.number().min(0.001).max(0.2),
  noveltyDecayHours: z.number().int().min(0).max(336),

  /** Automatic rollback thresholds, evaluated per variant against the champion. */
  rollback: z.object({
    /** Absolute p75 LCP ceiling in ms. Section 7 budget is 2.0s. */
    maxLcpMs: z.number().int().min(500).max(10_000),
    maxCls: z.number().min(0).max(1),
    maxInpMs: z.number().int().min(50).max(2_000),
    /** Relative bounce-rate degradation vs the champion that triggers quarantine. */
    maxBounceRateDelta: z.number().min(0).max(1),
    /** Client error rate ceiling, as a fraction of impressions. */
    maxClientErrorRate: z.number().min(0).max(1),
    /** Impressions needed before a rollback threshold may fire, to avoid twitchiness. */
    minSamples: z.number().int().min(50),
  }),

  /** Master switch, flipped by /pause_adaptation and /kill. */
  adaptationEnabled: z.boolean(),
  /** When true, only the Thompson layer runs. Used to debug a suspect LinUCB fit. */
  contextualEnabled: z.boolean(),
});

export type EngineConfig = z.infer<typeof EngineConfigSchema>;

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  rewardVersion: 1,
  weights: DEFAULT_REWARD_WEIGHTS,
  bouncePenalty: 0.15,
  holdoutFraction: 0.05,
  explorationFloor: 0.02,
  minImpressionsBeforeRetire: 1_000,
  msprtAlpha: 0.05,
  noveltyDecayHours: 48,
  rollback: {
    maxLcpMs: 2_000,
    maxCls: 0.05,
    maxInpMs: 200,
    maxBounceRateDelta: 0.1,
    maxClientErrorRate: 0.02,
    minSamples: 200,
  },
  adaptationEnabled: true,
  contextualEnabled: true,
};

/** Autonomy of the outbound approval queue (section 0 and section 6). */
export const AUTONOMY_LEVELS = ['manual', 'review', 'auto'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/**
 * `review` is the default and the only safe default. `auto` is legal exclusively for
 * content that both passed the safety classifier and matched an operator-approved
 * template; that pair of conditions is enforced in packages/social, not here.
 */
export const DEFAULT_AUTONOMY: AutonomyLevel = 'review';
