/**
 * Visitor context - the covariates the contextual bandit conditions on.
 *
 * This type is computed once, in edge middleware, from the request alone. It never
 * contains an IP address, a user agent string, a raw referrer URL, or anything else
 * that could re-identify a person. Every field is either a bounded enum or a small
 * integer, which is both a privacy property and the reason the feature vector is
 * cheap enough to build inside a 5ms decision budget.
 */

import { z } from 'zod';
import type { ContextBucket } from './brand';
import { contextBucket } from './brand';

export const DEVICE_CLASSES = ['phone', 'tablet', 'desktop', 'tv', 'bot'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const VIEWPORT_BUCKETS = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type ViewportBucket = (typeof VIEWPORT_BUCKETS)[number];

/**
 * Referrer *class*, never the referrer itself.
 *
 * `ai_agent` is its own class deliberately: traffic arriving from an AI answer
 * engine behaves nothing like traffic from a search result page - it lands
 * already-informed, converts differently, and is a growing share of the web. Folding
 * it into `referral` would hide the most interesting acquisition trend of the decade.
 */
export const REFERRER_CLASSES = [
  'direct',
  'search',
  'social',
  'referral',
  'internal',
  'ai_agent',
  'email',
  'campaign',
] as const;
export type ReferrerClass = (typeof REFERRER_CLASSES)[number];

export const VisitorContextSchema = z.object({
  device: z.enum(DEVICE_CLASSES),
  viewport: z.enum(VIEWPORT_BUCKETS),
  referrerClass: z.enum(REFERRER_CLASSES),
  /** Normalised source token, e.g. `google`, `tiktok`, `chatgpt`. Bounded vocabulary. */
  source: z.string().max(32),
  /** ISO 3166-1 alpha-2, or `ZZ` when unknown. Country only - never a finer geography. */
  country: z.string().length(2),
  /** 0..167, Monday 00:00 local = 0. Local to MORPH_TIMEZONE, not to the visitor. */
  hourOfWeek: z.number().int().min(0).max(167),
  /** Number of pageviews so far in this session, capped so the feature stays bounded. */
  depth: z.number().int().min(0).max(50),
  returning: z.boolean(),
  /** BCP-47 language subtag only, e.g. `it`. Never the full locale with region. */
  locale: z.string().max(8),
  /** Granted consent categories as a bitmask. See consent.ts. */
  consentMask: z.number().int().min(0).max(15),
});

export type VisitorContext = z.infer<typeof VisitorContextSchema>;

/**
 * Coarse discretisation used by the Thompson-sampling layer.
 *
 * WHY BUCKET AT ALL
 * Thompson sampling maintains one Beta posterior per cell. The full covariate space
 * is roughly 5 x 5 x 8 x 200 x 168 x ... cells, which at any realistic traffic level
 * means every cell has three observations and the posterior is the prior. Bucketing
 * to a few dozen cells makes each one statistically meaningful within hours.
 *
 * The full, unbucketed vector still reaches LinUCB, which does not need
 * discretisation because it shares strength across contexts through the linear model.
 * The two layers are complementary: Thompson is robust and coarse, LinUCB is
 * expressive and needs more data.
 *
 * The bucket is (device, referrer class, day-part). Three dimensions, 5 x 8 x 4 = 160
 * cells worst case, and in practice far fewer because most combinations never occur.
 */
export function bucketOf(ctx: VisitorContext): ContextBucket {
  const dayPart = Math.floor((ctx.hourOfWeek % 24) / 6); // 0 night, 1 morning, 2 afternoon, 3 evening
  return contextBucket(`${ctx.device}|${ctx.referrerClass}|${String(dayPart)}`);
}

/**
 * Dense feature vector for LinUCB.
 *
 * Design notes that matter:
 *  - Hour-of-week is encoded as two pairs of sine/cosine terms (daily and weekly
 *    period) rather than as 168 one-hot columns. Cyclical encoding means 23:00 and
 *    00:00 are adjacent in feature space, which they are in reality, and it costs 4
 *    dimensions instead of 168.
 *  - Session depth is log-compressed: the difference between the 1st and 2nd
 *    pageview is enormous, between the 20th and 21st it is noise.
 *  - A constant 1.0 intercept term is included so the model can fit a base rate.
 *  - Every value is in roughly [-1, 1]. LinUCB's confidence bound is scale-sensitive;
 *    an unnormalised feature would dominate the ellipsoid and quietly break exploration.
 */
export function featureVector(ctx: VisitorContext): readonly number[] {
  const hourOfDay = ctx.hourOfWeek % 24;
  const dayOfWeek = Math.floor(ctx.hourOfWeek / 24);

  const oneHot = <T extends string>(values: readonly T[], value: T): number[] =>
    values.map((v) => (v === value ? 1 : 0));

  return [
    1, // intercept
    ...oneHot(DEVICE_CLASSES, ctx.device),
    ...oneHot(VIEWPORT_BUCKETS, ctx.viewport),
    ...oneHot(REFERRER_CLASSES, ctx.referrerClass),
    Math.sin((2 * Math.PI * hourOfDay) / 24),
    Math.cos((2 * Math.PI * hourOfDay) / 24),
    Math.sin((2 * Math.PI * dayOfWeek) / 7),
    Math.cos((2 * Math.PI * dayOfWeek) / 7),
    Math.min(1, Math.log1p(ctx.depth) / Math.log(51)),
    ctx.returning ? 1 : 0,
    // Consent tier as an ordinal feature: a visitor who granted personalisation
    // behaves differently from one who granted only analytics, and the model should
    // be allowed to notice that rather than pooling them.
    (ctx.consentMask & 4) !== 0 ? 1 : 0,
  ];
}

/** Dimensionality of `featureVector`. Asserted in tests so a change here is deliberate. */
export const FEATURE_DIM =
  1 + DEVICE_CLASSES.length + VIEWPORT_BUCKETS.length + REFERRER_CLASSES.length + 4 + 1 + 1 + 1;
