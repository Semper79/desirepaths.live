import { describe, expect, it } from 'vitest';
import {
  BrandError,
  clampUnit,
  contextBucket,
  count,
  millis,
  surfaceId,
  unitInterval,
  variantId,
} from '../src/brand';
import { readability, syllablesIn } from '../src/text';
import {
  bucketOf,
  featureVector,
  FEATURE_DIM,
  VisitorContextSchema,
  type VisitorContext,
} from '../src/context';
import { categoriesOf, CONSENT_BIT, hasConsent, maskOf, mayAdapt } from '../src/consent';
import { IngestEventSchema, validateEvent, type IngestEvent } from '../src/events';
import { DEFAULT_ENGINE_CONFIG, EngineConfigSchema, RewardWeightsSchema } from '../src/config';

// -----------------------------------------------------------------------------
// Branded primitives
// -----------------------------------------------------------------------------

describe('branded primitives', () => {
  it('accepts values in range', () => {
    expect(unitInterval(0)).toBe(0);
    expect(unitInterval(1)).toBe(1);
    expect(unitInterval(0.5)).toBe(0.5);
    expect(count(3)).toBe(3);
    expect(millis(0)).toBe(0);
  });

  it('throws rather than silently clamping a bad probability', () => {
    expect(() => unitInterval(1.2)).toThrow(BrandError);
    expect(() => unitInterval(-0.1)).toThrow(BrandError);
    expect(() => unitInterval(Number.NaN)).toThrow(BrandError);
  });

  it('clamps only where the input is measurement noise', () => {
    expect(clampUnit(-2)).toBe(0);
    expect(clampUnit(2)).toBe(1);
    expect(clampUnit(0.25)).toBe(0.25);
    expect(() => clampUnit(Number.NaN)).toThrow(BrandError);
  });

  it('rejects malformed counts and durations', () => {
    expect(() => count(1.5)).toThrow(BrandError);
    expect(() => count(-1)).toThrow(BrandError);
    expect(() => millis(-1)).toThrow(BrandError);
  });

  it('enforces the shape of surface and variant ids', () => {
    expect(surfaceId('hero.headline')).toBe('hero.headline');
    expect(surfaceId('signup.providers_order')).toBe('signup.providers_order');
    expect(() => surfaceId('Hero.Headline')).toThrow(BrandError);
    expect(() => surfaceId('hero')).toThrow(BrandError);
    expect(() => surfaceId('hero.head line')).toThrow(BrandError);

    expect(variantId('hero.headline#v0')).toBe('hero.headline#v0');
    expect(() => variantId('hero.headline')).toThrow(BrandError);
    expect(() => variantId('#v0')).toThrow(BrandError);
  });

  it('bounds context buckets', () => {
    expect(contextBucket('phone|social|2')).toBe('phone|social|2');
    expect(() => contextBucket('')).toThrow(BrandError);
    expect(() => contextBucket('x'.repeat(65))).toThrow(BrandError);
  });
});

// -----------------------------------------------------------------------------
// Readability
// -----------------------------------------------------------------------------

describe('readability', () => {
  it('counts syllables well enough for the gate it guards', () => {
    expect(syllablesIn('cat')).toBe(1);
    expect(syllablesIn('shape')).toBe(1);
    expect(syllablesIn('subtle')).toBe(2);
    expect(syllablesIn('website')).toBe(2);
    expect(syllablesIn('')).toBe(0);
    expect(syllablesIn('!!!')).toBe(0);
    expect(syllablesIn('shaped')).toBe(1);
    expect(syllablesIn('wanted')).toBe(2);
  });

  it('scores an empty string as trivially readable', () => {
    const score = readability('   ');
    expect(score.words).toBe(0);
    expect(score.grade).toBe(0);
    expect(score.ease).toBe(100);
  });

  it('rates plain copy low and corporate copy high', () => {
    const plain = readability('This site changes. It learns from what you do.');
    const dense = readability(
      'Leveraging synergistic infrastructural transformation methodologies, our organisation systematically operationalises unprecedented multidimensional optimisation paradigms.',
    );
    expect(plain.grade).toBeLessThan(6);
    expect(dense.grade).toBeGreaterThan(15);
    expect(plain.ease).toBeGreaterThan(dense.ease);
  });

  it('treats an unpunctuated headline as one sentence', () => {
    expect(readability('A website that rebuilds itself around you').sentences).toBe(1);
  });

  it('keeps every shipped headline inside its reading ceiling', () => {
    expect(readability('A website that rebuilds itself around you.').grade).toBeLessThan(9);
  });
});

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

const ctx = (over: Partial<VisitorContext> = {}): VisitorContext => ({
  device: 'phone',
  viewport: 'sm',
  referrerClass: 'social',
  source: 'tiktok',
  country: 'IT',
  hourOfWeek: 50,
  depth: 1,
  returning: false,
  locale: 'it',
  consentMask: 3,
  ...over,
});

describe('visitor context', () => {
  it('parses a well-formed context', () => {
    expect(VisitorContextSchema.parse(ctx())).toEqual(ctx());
  });

  it('rejects an out-of-range hour-of-week or a long country code', () => {
    expect(VisitorContextSchema.safeParse(ctx({ hourOfWeek: 200 })).success).toBe(false);
    expect(VisitorContextSchema.safeParse(ctx({ country: 'ITA' })).success).toBe(false);
  });

  it('buckets by device, referrer class and day-part', () => {
    expect(bucketOf(ctx({ hourOfWeek: 2 }))).toBe('phone|social|0');
    expect(bucketOf(ctx({ hourOfWeek: 10 }))).toBe('phone|social|1');
    expect(bucketOf(ctx({ hourOfWeek: 15 }))).toBe('phone|social|2');
    expect(bucketOf(ctx({ hourOfWeek: 21 }))).toBe('phone|social|3');
  });

  it('keeps the bucket count small enough to learn from', () => {
    const buckets = new Set<string>();
    for (let h = 0; h < 168; h += 1) buckets.add(bucketOf(ctx({ hourOfWeek: h })));
    expect(buckets.size).toBe(4);
  });

  it('produces a feature vector of the declared dimension', () => {
    expect(featureVector(ctx())).toHaveLength(FEATURE_DIM);
    expect(FEATURE_DIM).toBe(26);
  });

  it('normalises every feature into roughly [-1, 1]', () => {
    for (const h of [0, 23, 87, 167]) {
      for (const d of [0, 1, 50]) {
        for (const v of featureVector(ctx({ hourOfWeek: h, depth: d, returning: true }))) {
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('encodes the hour cyclically, so 23:00 and 00:00 are neighbours', () => {
    const at = (h: number): readonly number[] => featureVector(ctx({ hourOfWeek: h }));
    const distance = (a: readonly number[], b: readonly number[]): number =>
      Math.hypot(...a.map((v, i) => v - (b[i] as number)));
    expect(distance(at(23), at(0))).toBeLessThan(distance(at(23), at(12)));
  });

  it('marks personalisation consent as its own feature', () => {
    const without = featureVector(ctx({ consentMask: 3 }));
    const with_ = featureVector(ctx({ consentMask: 7 }));
    expect(without.at(-1)).toBe(0);
    expect(with_.at(-1)).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Consent
// -----------------------------------------------------------------------------

describe('consent', () => {
  it('always includes the necessary category', () => {
    expect(maskOf([])).toBe(CONSENT_BIT.necessary);
    expect(hasConsent(maskOf([]), 'necessary')).toBe(true);
  });

  it('composes and decomposes a mask', () => {
    const mask = maskOf(['analytics', 'personalisation']);
    expect(hasConsent(mask, 'analytics')).toBe(true);
    expect(hasConsent(mask, 'personalisation')).toBe(true);
    expect(hasConsent(mask, 'marketing')).toBe(false);
    expect(categoriesOf(mask)).toEqual(['necessary', 'analytics', 'personalisation']);
  });

  it('gates adaptation on the tier a surface actually needs', () => {
    const analyticsOnly = maskOf(['analytics']);
    expect(mayAdapt(analyticsOnly, 'necessary')).toBe(true);
    expect(mayAdapt(analyticsOnly, 'analytics')).toBe(true);
    expect(mayAdapt(analyticsOnly, 'personalisation')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

const event = (over: Partial<IngestEvent> = {}): IngestEvent =>
  IngestEventSchema.parse({
    v: 1,
    eventId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9d',
    ts: new Date().toISOString(),
    type: 'page_view',
    anonId: 'a'.repeat(32),
    sessionId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9e',
    consentMask: 3,
    ctx: ctx(),
    path: '/',
    surfaces: ['hero.headline'],
    variants: ['hero.headline#v0'],
    assignmentHash: '12345678901234567',
    holdout: 0,
    ...over,
  });

describe('ingest events', () => {
  it('parses a well-formed event and applies defaults', () => {
    const parsed = event();
    expect(parsed.value).toBe(0);
    expect(parsed.props).toEqual({});
    expect(parsed.botScore).toBe(0);
  });

  it('rejects a malformed anonymous id', () => {
    expect(() => event({ anonId: 'not-hex' })).toThrow();
  });

  it('rejects an unknown event type', () => {
    expect(() => IngestEventSchema.parse({ ...event(), type: 'mystery' })).toThrow();
  });

  it('requires surfaces and variants to line up', () => {
    const problems = validateEvent(event({ surfaces: ['a', 'b'], variants: ['a#1'] }));
    expect(problems).toContain('surfaces and variants must be the same length.');
  });

  it('bounds a scroll-depth percentage', () => {
    expect(validateEvent(event({ type: 'scroll_depth', value: 140 }))).toContain(
      'scroll_depth value must be a percentage.',
    );
    expect(validateEvent(event({ type: 'scroll_depth', value: 55 }))).toEqual([]);
  });

  it('requires a web vital to name its metric', () => {
    expect(validateEvent(event({ type: 'web_vital' }))).toContain(
      'web_vital events must name the metric in props.metric.',
    );
    expect(validateEvent(event({ type: 'web_vital', props: { metric: 'lcp' } }))).toEqual([]);
  });

  it('requires a sign-up to name its provider', () => {
    expect(validateEvent(event({ type: 'signup_complete' }))).toContain(
      'signup_complete events must name the provider.',
    );
  });

  it('rejects a timestamp from the future, which would poison hour-of-week aggregates', () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(validateEvent(event({ ts: future }))).toContain(
      'Event timestamp is more than 5 minutes in the future.',
    );
  });

  it('tolerates a replayed event from an offline queue', () => {
    const past = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    expect(validateEvent(event({ ts: past }))).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Engine configuration
// -----------------------------------------------------------------------------

describe('engine configuration', () => {
  it('accepts the shipped defaults', () => {
    expect(() => EngineConfigSchema.parse(DEFAULT_ENGINE_CONFIG)).not.toThrow();
  });

  it('matches the weights written in the specification', () => {
    expect(DEFAULT_ENGINE_CONFIG.weights).toEqual({
      signup: 0.4,
      meaningful_engagement: 0.25,
      scroll_depth_norm: 0.2,
      return_visit: 0.1,
      share: 0.05,
    });
  });

  it('refuses reward weights that do not sum to one', () => {
    const result = RewardWeightsSchema.safeParse({
      signup: 0.5,
      meaningful_engagement: 0.25,
      scroll_depth_norm: 0.2,
      return_visit: 0.1,
      share: 0.05,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a holdout large enough to cost real traffic', () => {
    expect(
      EngineConfigSchema.safeParse({ ...DEFAULT_ENGINE_CONFIG, holdoutFraction: 0.5 }).success,
    ).toBe(false);
  });

  it('refuses an exploration floor of exactly zero', () => {
    expect(
      EngineConfigSchema.safeParse({ ...DEFAULT_ENGINE_CONFIG, explorationFloor: 0 }).success,
    ).toBe(false);
  });

  it('keeps the rollback budgets aligned with the Core Web Vitals targets', () => {
    expect(DEFAULT_ENGINE_CONFIG.rollback.maxLcpMs).toBe(2_000);
    expect(DEFAULT_ENGINE_CONFIG.rollback.maxCls).toBe(0.05);
    expect(DEFAULT_ENGINE_CONFIG.rollback.maxInpMs).toBe(200);
  });
});
