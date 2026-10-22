/**
 * A realistic hour, used three ways: as the worked example the specification asks
 * for, as the fixture the composer is tested against, and as the payload `pnpm
 * report:sample` prints so a change to the report's wording is visible in a diff.
 *
 * The numbers are internally consistent on purpose - sessions, funnel steps and
 * sign-ups actually reconcile, the holdout is 5% of traffic, and the champion's
 * credible interval brackets its mean. A sample with impossible numbers teaches the
 * reader to stop trusting the report.
 */

import type { ReportInput } from './types';

export const SAMPLE_REPORT_INPUT: ReportInput = {
  hourStart: '2026-08-24T14:00:00',
  timezone: 'Europe/Rome',
  uptimeSeconds: 11 * 86_400 + 6 * 3_600,
  rewardVersion: 3,

  services: [
    { name: 'web', status: 'up' },
    { name: 'api', status: 'up' },
    { name: 'worker', status: 'up' },
    { name: 'clickhouse', status: 'up' },
    { name: 'redpanda', status: 'degraded', detail: 'consumer lag 4.2s, recovering' },
  ],

  traffic: {
    sessions: 18_432,
    uniques: 15_907,
    pageviews: 47_115,
    newVisitors: 12_884,
    returningVisitors: 3_023,
    sessionsDeltaVsLastWeek: 0.212,
    topSources: [
      { label: 'tiktok', value: 6_215, deltaVsLastWeek: 0.48 },
      { label: 'organic search', value: 4_902, deltaVsLastWeek: 0.09 },
      { label: 'direct', value: 3_355, deltaVsLastWeek: 0.02 },
      { label: 'chatgpt', value: 2_118, deltaVsLastWeek: 1.34 },
      { label: 'discord', value: 1_842, deltaVsLastWeek: -0.07 },
    ],
    topCountries: [
      { label: 'IT', value: 5_930, deltaVsLastWeek: 0.11 },
      { label: 'US', value: 4_402, deltaVsLastWeek: 0.31 },
      { label: 'DE', value: 2_115, deltaVsLastWeek: 0.06 },
      { label: 'FR', value: 1_884, deltaVsLastWeek: 0.14 },
      { label: 'ES', value: 1_502, deltaVsLastWeek: 0.19 },
    ],
    topPages: [
      { label: '/', value: 18_432, deltaVsLastWeek: 0.21 },
      { label: '/live', value: 9_811, deltaVsLastWeek: 0.55 },
      { label: '/t/ambient-computing', value: 6_204, deltaVsLastWeek: 2.9 },
      { label: '/how-it-works', value: 4_118, deltaVsLastWeek: -0.04 },
      { label: '/join', value: 3_902, deltaVsLastWeek: 0.18 },
    ],
  },

  conversion: {
    signups: 421,
    signupRate: 0.0228,
    activationRate: 0.612,
    byProvider: [
      { provider: 'discord', signups: 138, conversionRate: 0.121 },
      { provider: 'google', signups: 112, conversionRate: 0.094 },
      { provider: 'tiktok', signups: 89, conversionRate: 0.083 },
      { provider: 'apple', signups: 51, conversionRate: 0.071 },
      { provider: 'passkey', signups: 19, conversionRate: 0.155 },
      { provider: 'email', signups: 12, conversionRate: 0.038 },
    ],
    funnel: [
      { step: 'land', sessions: 18_432, stepConversion: 1, deltaVsLastWeek: 0 },
      { step: 'signup_view', sessions: 7_640, stepConversion: 0.414, deltaVsLastWeek: 0.021 },
      { step: 'signup_start', sessions: 1_982, stepConversion: 0.259, deltaVsLastWeek: -0.038 },
      { step: 'signup_complete', sessions: 421, stepConversion: 0.212, deltaVsLastWeek: 0.006 },
      { step: 'activated', sessions: 258, stepConversion: 0.612, deltaVsLastWeek: 0.014 },
    ],
  },

  adaptation: {
    entries: [
      {
        action: 'retired',
        surfaceId: 'hero.headline',
        variantId: 'hero.headline#now',
        variantLabel: 'Urgency',
        reason:
          'Retired hero.headline#now — 96% probability of being worse than the leader over 3.1k impressions; sequential test concluded worse (always-valid p = 0.014).',
        impressions: 3_142,
      },
      {
        action: 'generated',
        surfaceId: 'hero.headline',
        variantId: 'hero.headline#g7f2',
        variantLabel: 'Ambient-computing angle',
        reason:
          'Generated from the winning "live proof" framing conditioned on the ambient-computing cluster (momentum 0.81). Passed schema, reading grade 6.4, and the safety classifier. Injected with an optimistic Beta(3, 12) prior.',
      },
      {
        action: 'quarantined',
        surfaceId: 'hero.media',
        variantId: 'hero.media#canvas',
        variantLabel: 'Reactive canvas',
        reason:
          'Quarantined by the rollback guardrail: LCP p75 2740ms exceeds the 2000ms budget on phone over 612 samples. Champion unaffected.',
        impressions: 612,
      },
      {
        action: 'promoted',
        surfaceId: 'signup.providers_order',
        variantId: 'signup.providers_order#discord-first',
        variantLabel: 'Discord first',
        reason:
          'Promoted to champion for the phone|social context bucket — 12.1% sign-up rate against 9.4% for Google-first over 4.8k impressions, 99% probability of being better.',
        impressions: 4_812,
      },
    ],
    champions: [
      {
        surfaceId: 'hero.headline',
        variantId: 'hero.headline#live-proof',
        variantLabel: 'Live proof',
        posteriorMean: 0.0271,
        credibleInterval: [0.0244, 0.03],
        impressions: 41_209,
        activeVariants: 6,
      },
      {
        surfaceId: 'theme.palette',
        variantId: 'theme.palette#dark-neon',
        variantLabel: 'Dark neon',
        posteriorMean: 0.0264,
        credibleInterval: [0.0248, 0.0281],
        impressions: 88_450,
        activeVariants: 4,
      },
      {
        surfaceId: 'signup.providers_order',
        variantId: 'signup.providers_order#discord-first',
        variantLabel: 'Discord first',
        posteriorMean: 0.121,
        credibleInterval: [0.112, 0.131],
        impressions: 4_812,
        activeVariants: 5,
      },
      {
        surfaceId: 'layout.density',
        variantId: 'layout.density#dense',
        variantLabel: 'Dense',
        posteriorMean: 0.0259,
        credibleInterval: [0.0241, 0.0278],
        impressions: 52_004,
        activeVariants: 3,
      },
    ],
    liveTheme: {
      palette: 'dark-neon',
      typography: 'grotesk',
      density: 'dense',
      motion: 'subtle',
    },
  },

  web: {
    documentsFetched: 4_812,
    hostsCrawled: 61,
    newClusters: [
      {
        id: 'c-8812',
        label: 'Ambient computing and always-on wearables',
        momentum: 0.81,
        audienceFit: 0.74,
        saturation: 0.22,
        documentCount: 143,
      },
      {
        id: 'c-8813',
        label: 'Open-weight small models on consumer hardware',
        momentum: 0.66,
        audienceFit: 0.69,
        saturation: 0.41,
        documentCount: 97,
      },
      {
        id: 'c-8814',
        label: 'Type design revival in indie web',
        momentum: 0.44,
        audienceFit: 0.58,
        saturation: 0.12,
        documentCount: 38,
      },
    ],
    published: [{ title: 'Why your watch is becoming the interface', slug: 't/ambient-computing' }],
    queued: [{ title: 'Small models, big rooms: what actually runs on a laptop now' }],
    rejected: [
      {
        label: 'Regional election polling surge',
        reason: 'political/electoral — categorically excluded',
      },
      {
        label: 'Unverified outage rumour at a major platform',
        reason: 'unverified breaking news — no corroborating primary source',
      },
    ],
  },

  social: {
    autonomy: 'review',
    awaitingApproval: 2,
    platforms: [
      {
        platform: 'x',
        posted: 1,
        impressions: 12_400,
        engagements: 388,
        followerDelta: 41,
        rateLimitHeadroom: 0.82,
      },
      {
        platform: 'instagram',
        posted: 1,
        impressions: 8_910,
        engagements: 612,
        followerDelta: 77,
        rateLimitHeadroom: 0.91,
      },
      {
        platform: 'discord',
        posted: 2,
        impressions: 3_150,
        engagements: 244,
        followerDelta: 19,
        rateLimitHeadroom: 0.95,
      },
    ],
  },

  holdout: {
    hourLiftRelative: 0.184,
    cumulativeLiftRelative: 0.163,
    cumulativePValue: 0.0007,
    conclusive: true,
    adaptiveRewardPerImpression: 0.0271,
    holdoutRewardPerImpression: 0.0233,
    holdoutFraction: 0.05,
  },

  alerts: [
    {
      severity: 'warning',
      title: 'Traffic spike on /t/ambient-computing',
      detail:
        'Pageviews are 4.1 standard deviations above the trailing 4-week profile for this hour-of-week. Source is TikTok; no bot signature detected.',
    },
    {
      severity: 'warning',
      title: 'Redpanda consumer lag',
      detail:
        'ClickHouse ingest lag peaked at 4.2s against a 1s target. No events dropped; the buffer absorbed the spike as designed.',
    },
  ],

  next: {
    intentions: [
      'Give hero.headline#g7f2 its first 1,000 impressions under novelty down-weighting.',
      'Re-test hero.media#canvas on desktop only, where its LCP budget is not the binding constraint.',
      'Extend the Discord-first provider ordering to the phone|direct bucket, where the posteriors now overlap.',
    ],
    needsOperator: ['Two posts are waiting in the approval queue and will expire in 4 hours.'],
  },
};

/** The same hour, with nothing in it - exercises the brief path. */
export const SAMPLE_QUIET_INPUT: ReportInput = {
  ...SAMPLE_REPORT_INPUT,
  hourStart: '2026-08-25T04:00:00',
  traffic: { ...SAMPLE_REPORT_INPUT.traffic, sessions: 31, uniques: 28, pageviews: 44 },
  conversion: { ...SAMPLE_REPORT_INPUT.conversion, signups: 0 },
  adaptation: { ...SAMPLE_REPORT_INPUT.adaptation, entries: [] },
  web: { ...SAMPLE_REPORT_INPUT.web, published: [], queued: [] },
  social: { ...SAMPLE_REPORT_INPUT.social, awaitingApproval: 0 },
  alerts: [],
};
