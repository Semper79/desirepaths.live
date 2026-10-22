import { describe, expect, it } from 'vitest';
import {
  alertsFrom,
  anomalyZ,
  delta,
  deltaOrNull,
  FUNNEL_STEPS,
  funnelFrom,
  holdoutFrom,
  hourStartFor,
  intentionsFrom,
  MIN_WEEKS_FOR_ANOMALY,
  rate,
  sameHourLastWeek,
  topRows,
  TRAFFIC_Z_THRESHOLD,
} from '../src/lib/report-derive';
import { betaInterval, runReport, STALE_DRAFT_MS, TOP_N } from '../src/jobs/report';
import { FakeContent, FakeLogger } from './fakes';
import type {
  AdaptationFacts,
  AnomalyFacts,
  ChampionFacts,
  FunnelFacts,
  MetricsRepository,
  ReportRepository,
  ReportRun,
  ReportRunRepository,
  RewardFacts,
  TrafficFacts,
  TrendSignalRecord,
} from '../src/ports';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 24, 14, 37);

// -----------------------------------------------------------------------------
// Derivations
// -----------------------------------------------------------------------------

describe('comparisons', () => {
  it('computes a relative change', () => {
    expect(delta(120, 100)).toBeCloseTo(0.2);
    expect(delta(80, 100)).toBeCloseTo(-0.2);
  });

  /**
   * A new page, a new country, a source that appeared this week: all have a zero baseline
   * and all of them are the interesting rows. "+∞%" or "+100%" would put a number in front
   * of the operator that means "this is new" while looking like a measurement.
   */
  it('refuses a change against nothing', () => {
    expect(deltaOrNull(50, 0)).toBeNull();
    expect(deltaOrNull(0, 0)).toBeNull();
    expect(delta(50, 0)).toBe(0);
  });

  it('is a rate, not a division by zero', () => {
    expect(rate(3, 12)).toBe(0.25);
    expect(rate(3, 0)).toBe(0);
  });
});

describe('top rows', () => {
  const current = [
    { label: 'search', value: 300 },
    { label: 'direct', value: 500 },
    { label: 'social', value: 100 },
  ];

  it('orders by value and applies the limit', () => {
    expect(topRows(current, [], 2).map((r) => r.label)).toEqual(['direct', 'search']);
  });

  it('carries each row its own comparison', () => {
    const rows = topRows(current, [{ label: 'direct', value: 250 }], 3);
    expect(rows[0]?.deltaVsLastWeek).toBeCloseTo(1);
    // No baseline for `search` — reported as 0 rather than as a fabricated increase.
    expect(rows[1]?.deltaVsLastWeek).toBe(0);
  });

  /**
   * Otherwise an operator comparing two consecutive reports sees a reshuffle that means
   * nothing.
   */
  it('breaks ties deterministically', () => {
    const tied = [
      { label: 'zebra', value: 10 },
      { label: 'alpha', value: 10 },
    ];
    expect(topRows(tied, [], 2).map((r) => r.label)).toEqual(['alpha', 'zebra']);
  });
});

describe('the funnel', () => {
  const current: FunnelFacts = {
    land: 1000,
    signup_view: 400,
    signup_start: 100,
    signup_complete: 40,
    activated: 20,
  };

  it('reports every step in order', () => {
    expect(funnelFrom(current, {}).map((s) => s.step)).toEqual([...FUNNEL_STEPS]);
  });

  /**
   * A funnel reported against its first step says "conversion is down"; a funnel reported
   * step by step says which step it is down at.
   */
  it('measures each step against the one before it', () => {
    const funnel = funnelFrom(current, {});

    expect(funnel[0]?.stepConversion).toBe(1);
    expect(funnel[1]?.stepConversion).toBeCloseTo(0.4);
    expect(funnel[3]?.stepConversion).toBeCloseTo(0.4);
  });

  /**
   * Percentage points, not a relative change of a rate. "Conversion fell 3 points" is a
   * sentence about the funnel; "conversion fell 12%" is a sentence about a percentage.
   */
  it('compares in points against the same hour last week', () => {
    const lastWeek: FunnelFacts = { land: 1000, signup_view: 500 };
    const funnel = funnelFrom(current, lastWeek);

    expect(funnel[1]?.deltaVsLastWeek).toBeCloseTo(0.4 - 0.5);
  });

  it('survives an hour with no traffic at all', () => {
    const funnel = funnelFrom({}, {});
    expect(funnel.every((s) => s.sessions === 0)).toBe(true);
    expect(funnel[1]?.stepConversion).toBe(0);
  });
});

describe('the anomaly test', () => {
  const profile = { sessions: 100, meanSessions: 500, sdSessions: 50, weeksObserved: 8 };

  it('measures distance from the hour-of-week baseline', () => {
    expect(anomalyZ(profile)).toBeCloseTo(-8);
  });

  /**
   * A site so quiet that every week's 04:00 had exactly zero sessions has no variance, and
   * dividing by it would report the first visitor ever as an infinite anomaly.
   */
  it('declines when the baseline has no variance', () => {
    expect(anomalyZ({ ...profile, sdSessions: 0 })).toBeNull();
  });

  it('declines before there are enough weeks to have an opinion', () => {
    expect(anomalyZ({ ...profile, weeksObserved: MIN_WEEKS_FOR_ANOMALY - 1 })).toBeNull();
  });
});

describe('alerts', () => {
  const quiet = {
    services: [{ name: 'postgres', status: 'up' as const }],
    anomaly: { sessions: 500, meanSessions: 500, sdSessions: 50, weeksObserved: 8 },
    brokenHosts: [],
    staleDrafts: 0,
    staleRobots: 0,
  };

  it('says nothing when nothing is wrong', () => {
    expect(alertsFrom(quiet)).toEqual([]);
  });

  it('reports a service that is down as critical', () => {
    const alerts = alertsFrom({
      ...quiet,
      services: [{ name: 'clickhouse', status: 'down', detail: 'connection refused' }],
    });

    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    expect(alerts[0]?.detail).toBe('connection refused');
  });

  it('treats a collapse in traffic as critical and a spike as information', () => {
    const collapsed = alertsFrom({ ...quiet, anomaly: { ...quiet.anomaly, sessions: 0 } });
    const spiked = alertsFrom({ ...quiet, anomaly: { ...quiet.anomaly, sessions: 5_000 } });

    expect(collapsed[0]?.severity).toBe('critical');
    expect(spiked[0]?.severity).toBe('info');
  });

  it('stays quiet inside the threshold', () => {
    const withinBand = TRAFFIC_Z_THRESHOLD * 50 - 10;
    expect(
      alertsFrom({ ...quiet, anomaly: { ...quiet.anomaly, sessions: 500 + withinBand } }),
    ).toEqual([]);
  });

  /**
   * The compliance rule working, and worth reporting: a persistent count means a host has
   * become unreachable rather than that the crawler is behaving.
   */
  it('reports sources the crawler is refusing because their policy went stale', () => {
    const alerts = alertsFrom({ ...quiet, staleRobots: 4 });
    expect(alerts[0]?.title).toMatch(/4 sources are not being fetched/);
  });

  it('orders by severity, because the first line is the one read on a phone', () => {
    const alerts = alertsFrom({
      ...quiet,
      services: [{ name: 'redis', status: 'down' }],
      staleDrafts: 2,
      staleRobots: 1,
    });

    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'warning', 'info']);
  });

  it('pluralises a single broken host correctly', () => {
    expect(alertsFrom({ ...quiet, brokenHosts: ['a.example'] })[0]?.title).toMatch(
      /1 host cut off/,
    );
    expect(alertsFrom({ ...quiet, brokenHosts: ['a', 'b'] })[0]?.title).toMatch(/2 hosts cut off/);
  });
});

describe('the next hour', () => {
  const idle = {
    documentsAwaitingEmbedding: 0,
    clustersAwaitingContent: 0,
    draftsAwaitingReview: 0,
    audienceVectorKnown: true,
    staleDrafts: 0,
    brokenHosts: [],
  };

  it('says nothing when there is nothing to say', () => {
    expect(intentionsFrom(idle)).toEqual({ intentions: [], needsOperator: [] });
  });

  /**
   * The distinction is the point of the section: mixing them produces a report where every
   * line looks like a request and the operator stops reading any of them.
   */
  it('separates what will happen from what needs a person', () => {
    const result = intentionsFrom({
      ...idle,
      documentsAwaitingEmbedding: 40,
      draftsAwaitingReview: 3,
    });

    expect(result.intentions).toHaveLength(1);
    expect(result.needsOperator).toHaveLength(1);
    expect(result.needsOperator[0]).toMatch(/\/queue/);
  });

  /**
   * Said every hour until it stops being true: a scorer running on three of its four
   * signals is not broken, but it should not become invisible through familiarity.
   */
  it('keeps saying when the audience vector does not exist yet', () => {
    const result = intentionsFrom({ ...idle, audienceVectorKnown: false });
    expect(result.intentions[0]).toMatch(/three signals rather than four/);
  });
});

describe('the holdout', () => {
  it('reports lift, the split, and both rates', () => {
    const holdout = holdoutFrom({
      adaptiveReward: 120,
      adaptiveImpressions: 1000,
      holdoutReward: 5,
      holdoutImpressions: 50,
      cumulativeAdaptiveReward: 1200,
      cumulativeAdaptiveImpressions: 10_000,
      cumulativeHoldoutReward: 50,
      cumulativeHoldoutImpressions: 500,
      pValue: 0.04,
      conclusive: true,
    });

    expect(holdout.adaptiveRewardPerImpression).toBeCloseTo(0.12);
    expect(holdout.holdoutRewardPerImpression).toBeCloseTo(0.1);
    expect(holdout.hourLiftRelative).toBeCloseTo(0.2);
    expect(holdout.holdoutFraction).toBeCloseTo(50 / 1050);
  });

  it('does not divide by an empty holdout', () => {
    const holdout = holdoutFrom({
      adaptiveReward: 10,
      adaptiveImpressions: 100,
      holdoutReward: 0,
      holdoutImpressions: 0,
      cumulativeAdaptiveReward: 0,
      cumulativeAdaptiveImpressions: 0,
      cumulativeHoldoutReward: 0,
      cumulativeHoldoutImpressions: 0,
      pValue: 1,
      conclusive: false,
    });

    expect(holdout.hourLiftRelative).toBe(0);
    expect(holdout.holdoutFraction).toBe(0);
  });
});

describe('the credible interval', () => {
  it('brackets the mean and stays inside the unit interval', () => {
    const [low, high] = betaInterval(40, 60);

    expect(low).toBeLessThan(0.4);
    expect(high).toBeGreaterThan(0.4);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('narrows as evidence accumulates', () => {
    const [thinLow, thinHigh] = betaInterval(4, 6);
    const [thickLow, thickHigh] = betaInterval(400, 600);

    expect(thickHigh - thickLow).toBeLessThan(thinHigh - thinLow);
  });

  it('returns a point at zero rather than dividing by nothing', () => {
    expect(betaInterval(0, 0)).toEqual([0, 0]);
  });
});

describe('which hour is reported', () => {
  /**
   * A report about the hour in progress compares a partial hour to a complete one from
   * last week, which makes every metric look down.
   */
  it('is the one that has finished, not the one in progress', () => {
    expect(new Date(hourStartFor(NOW)).toISOString()).toBe('2026-08-24T13:00:00.000Z');
  });

  it('compares against the same hour a week earlier', () => {
    expect(new Date(sameHourLastWeek(hourStartFor(NOW))).toISOString()).toBe(
      '2026-08-17T13:00:00.000Z',
    );
  });
});

// -----------------------------------------------------------------------------
// The job
// -----------------------------------------------------------------------------

const NO_TRAFFIC: TrafficFacts = {
  sessions: 0,
  uniques: 0,
  pageviews: 0,
  newVisitors: 0,
  returningVisitors: 0,
  sources: [],
  countries: [],
  pages: [],
};

const NO_REWARD: RewardFacts = {
  adaptiveReward: 0,
  adaptiveImpressions: 0,
  holdoutReward: 0,
  holdoutImpressions: 0,
};

const NO_ANOMALY: AnomalyFacts = { meanSessions: 0, sdSessions: 0, weeksObserved: 0 };

class FakeMetrics implements MetricsRepository {
  constructor(
    private readonly facts: Partial<{
      traffic: TrafficFacts;
      funnel: FunnelFacts;
      anomaly: AnomalyFacts;
      up: boolean;
    }> = {},
  ) {}

  traffic(): Promise<TrafficFacts> {
    return Promise.resolve(this.facts.traffic ?? NO_TRAFFIC);
  }
  funnel(): Promise<FunnelFacts> {
    return Promise.resolve(this.facts.funnel ?? {});
  }
  providers(): Promise<readonly { provider: string; signups: number; starts: number }[]> {
    return Promise.resolve([]);
  }
  reward(): Promise<RewardFacts> {
    return Promise.resolve(NO_REWARD);
  }
  rewardSince(): Promise<RewardFacts> {
    return Promise.resolve(NO_REWARD);
  }
  anomalyProfile(): Promise<AnomalyFacts> {
    return Promise.resolve(this.facts.anomaly ?? NO_ANOMALY);
  }
  ping(): Promise<boolean> {
    return Promise.resolve(this.facts.up ?? true);
  }
}

class FakeReport implements ReportRepository {
  published: { title: string; slug: string }[] = [];
  drafts = 0;
  stale = 0;
  entries: AdaptationFacts[] = [];
  leaders: ChampionFacts[] = [];
  clusters: TrendSignalRecord[] = [];
  refused: TrendSignalRecord[] = [];

  adaptations(): Promise<readonly AdaptationFacts[]> {
    return Promise.resolve(this.entries);
  }
  champions(): Promise<readonly ChampionFacts[]> {
    return Promise.resolve(this.leaders);
  }
  rewardVersion(): Promise<number> {
    return Promise.resolve(1);
  }
  newClusters(): Promise<readonly TrendSignalRecord[]> {
    return Promise.resolve(this.clusters);
  }
  rejectedTopics(): Promise<readonly TrendSignalRecord[]> {
    return Promise.resolve(this.refused);
  }
  publishedInHour(): Promise<readonly { title: string; slug: string }[]> {
    return Promise.resolve(this.published);
  }
  documentsFetched(): Promise<{ documents: number; hosts: number }> {
    return Promise.resolve({ documents: 0, hosts: 0 });
  }
  staleRobotsCount(): Promise<number> {
    return Promise.resolve(0);
  }
  draftsAwaitingReview(): Promise<number> {
    return Promise.resolve(this.drafts);
  }
  draftsOlderThan(): Promise<number> {
    return Promise.resolve(this.stale);
  }
  documentsAwaitingEmbedding(): Promise<number> {
    return Promise.resolve(0);
  }
  clustersAwaitingContent(): Promise<number> {
    return Promise.resolve(0);
  }
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeRuns implements ReportRunRepository {
  readonly recorded: ReportRun[] = [];
  sent = new Set<number>();

  wasSent(hourStart: number): Promise<boolean> {
    return Promise.resolve(this.sent.has(hourStart));
  }
  record(run: ReportRun): Promise<void> {
    this.recorded.push(run);
    if (run.sentAt !== null) this.sent.add(run.hourStart);
    return Promise.resolve();
  }
}

function jobHarness(
  options: {
    metrics?: FakeMetrics;
    failSend?: boolean;
    prose?: {
      model: string;
      lead: (report: string, facts: unknown) => Promise<string | null>;
    } | null;
  } = {},
) {
  const metrics = options.metrics ?? new FakeMetrics();
  const report = new FakeReport();
  const runs = new FakeRuns();
  const content = new FakeContent();
  const log = new FakeLogger();
  const sent: string[] = [];

  const telegram = {
    send: (text: string): Promise<readonly number[]> => {
      if (options.failSend === true) return Promise.reject(new Error('chat not found'));
      sent.push(text);
      return Promise.resolve([sent.length]);
    },
  };

  return {
    metrics,
    report,
    runs,
    content,
    log,
    sent,
    deps: {
      metrics,
      report,
      runs,
      content,
      telegram,
      prose: options.prose ?? null,
      timezone: 'Europe/Rome',
      startedAt: NOW - 7_200_000,
      holdoutSince: NOW - 30 * 24 * HOUR,
      autonomy: 'review' as const,
      now: () => NOW,
      log,
    },
  };
}

describe('the report job', () => {
  it('composes and sends, then records that it did', async () => {
    const h = jobHarness();
    const result = await runReport(h.deps, {});

    expect(result.kind).toBe('sent');
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.runs.recorded[0]).toMatchObject({ sentAt: NOW, error: null });
  });

  /**
   * A retry after a failed send, a redeploy that re-registers the schedule, a restart
   * mid-hour: all can run this job again for an hour already reported, and none should
   * produce a second copy in the operator's chat.
   */
  it('will not send the same hour twice', async () => {
    const h = jobHarness();
    await runReport(h.deps, {});
    const second = await runReport(h.deps, {});

    expect(second.kind).toBe('already-sent');
    expect(h.runs.recorded).toHaveLength(1);
  });

  it('reports the hour that has finished', async () => {
    const h = jobHarness();
    const result = await runReport(h.deps, {});

    if (result.kind !== 'sent') throw new Error('expected a sent report');
    expect(new Date(result.hourStart).toISOString()).toBe('2026-08-24T13:00:00.000Z');
  });

  it('reports a specific hour when asked for one', async () => {
    const h = jobHarness();
    const hour = Date.UTC(2026, 7, 20, 9);
    const result = await runReport(h.deps, { hourStart: hour });

    expect(result.kind === 'sent' && result.hourStart).toBe(hour);
  });

  /**
   * A quiet 04:00 with eleven sessions and no decisions is most of the night on a
   * young-audience site, and a full nine-section report for it trains the operator to
   * ignore the notification.
   */
  it('sends the one-line form for an hour where nothing happened', async () => {
    const h = jobHarness();
    const result = await runReport(h.deps, {});

    expect(result.kind === 'sent' && result.reportKind).toBe('brief');
    expect(h.sent).toHaveLength(1);
  });

  it('sends the full form once something has happened', async () => {
    const h = jobHarness();
    h.report.published.push({ title: 'A piece', slug: 'a-piece' });

    const result = await runReport(h.deps, {});
    expect(result.kind === 'sent' && result.reportKind).toBe('full');
  });

  /**
   * Without the row, a report that failed to send is indistinguishable from an hour the
   * job never ran — the difference between "Telegram was down" and "the worker has been
   * dead since Tuesday".
   */
  it('records a failed send, with the reason', async () => {
    const h = jobHarness({ failSend: true });
    const result = await runReport(h.deps, {});

    expect(result.kind).toBe('failed');
    expect(h.runs.recorded[0]).toMatchObject({ sentAt: null, error: 'chat not found' });
  });

  it('lets a failed hour be retried', async () => {
    const h = jobHarness({ failSend: true });
    await runReport(h.deps, {});

    // Nothing was sent, so nothing stops the next attempt.
    expect(await h.runs.wasSent(hourStartFor(NOW))).toBe(false);
  });

  it('still composes and records when there is no bot configured', async () => {
    const h = jobHarness();
    const result = await runReport({ ...h.deps, telegram: null }, {});

    expect(result.kind).toBe('no-transport');
    expect(h.runs.recorded[0]?.inputs).toBeDefined();
    expect(h.log.events('warn')).toContain('report.no-transport');
  });

  /**
   * An hour where half the system is down is the hour the operator most needs the other
   * half's numbers — so a store being unreachable is a line in the report, not a reason
   * for there to be no report.
   */
  it('reports a store that is down rather than failing to report', async () => {
    const h = jobHarness({ metrics: new FakeMetrics({ up: false }) });
    const result = await runReport(h.deps, {});

    expect(result.kind).toBe('sent');
    const input = h.runs.recorded[0]?.inputs as { services: { name: string; status: string }[] };
    expect(input.services).toContainEqual({ name: 'clickhouse', status: 'down' });
  });

  it('carries the drafts waiting for review into the section that asks for a decision', async () => {
    const h = jobHarness();
    h.report.drafts = 3;
    h.report.stale = 1;

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as {
      next: { needsOperator: string[] };
      social: { awaitingApproval: number };
    };

    expect(input.social.awaitingApproval).toBe(3);
    expect(input.next.needsOperator.join(' ')).toMatch(/\/queue/);
  });

  it('asks for the documented number of rows in each top list', () => {
    expect(TOP_N).toBeGreaterThan(0);
    expect(STALE_DRAFT_MS).toBe(24 * HOUR);
  });
});

describe('the remaining next-hour lines', () => {
  const idle = {
    documentsAwaitingEmbedding: 0,
    clustersAwaitingContent: 0,
    draftsAwaitingReview: 0,
    audienceVectorKnown: true,
    staleDrafts: 0,
    brokenHosts: [] as readonly string[],
  };

  it('names scored topics waiting for a generation run', () => {
    expect(intentionsFrom({ ...idle, clustersAwaitingContent: 5 }).intentions[0]).toMatch(
      /5 scored topics/,
    );
  });

  /**
   * `/resume` is the operator's half of the circuit breaker: the crawler will not go back
   * to a host on its own, so a cut-off host stays cut off until somebody says otherwise.
   */
  it('asks for /resume when hosts are cut off', () => {
    const result = intentionsFrom({ ...idle, brokenHosts: ['a.example', 'b.example'] });
    expect(result.needsOperator[0]).toMatch(/2 hosts are cut off.*\/resume/);
  });

  it('says which drafts have gone stale, separately from how many are waiting', () => {
    const result = intentionsFrom({ ...idle, draftsAwaitingReview: 4, staleDrafts: 2 });

    expect(result.needsOperator).toHaveLength(2);
    expect(result.needsOperator[1]).toMatch(/over a day/);
  });
});

describe('what the report says about the engine and the web', () => {
  const signal = (over: Partial<TrendSignalRecord>): TrendSignalRecord => ({
    id: 'c1',
    label: 'A topic',
    centroid: [],
    documentCount: 12,
    momentum: 0.7,
    audienceFit: 0.6,
    saturation: 0.8,
    durability: 0.4,
    safetyVerdict: 'allow',
    safetyReason: null,
    safetyCategories: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    actedOnAt: null,
    ...over,
  });

  it('turns a champion’s counters into a mean and an interval', async () => {
    const h = jobHarness();
    h.report.leaders.push({
      surfaceId: 'hero.headline',
      variantId: 'hero.headline#3',
      variantLabel: 'Watch it learn',
      alpha: 41,
      beta: 209,
      impressions: 3100,
      activeVariants: 4,
    });
    h.report.entries.push({
      action: 'promoted',
      surfaceId: 'hero.headline',
      variantId: 'hero.headline#3',
      reason: 'Overtook the champion.',
      impressions: 3100,
    });

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as {
      adaptation: {
        champions: { posteriorMean: number; credibleInterval: [number, number] }[];
        entries: { impressions?: number }[];
      };
    };

    expect(input.adaptation.champions[0]?.posteriorMean).toBeCloseTo(41 / 250);
    const [low, high] = input.adaptation.champions[0]?.credibleInterval ?? [0, 0];
    expect(low).toBeLessThan(41 / 250);
    expect(high).toBeGreaterThan(41 / 250);
    expect(input.adaptation.entries[0]?.impressions).toBe(3100);
  });

  /**
   * An adaptation entry with no surface is a config change or a pause — real, and it must
   * not render as the word "undefined" in a message sent to a person.
   */
  it('names an entry with no surface rather than printing undefined', async () => {
    const h = jobHarness();
    h.report.entries.push({
      action: 'config_changed',
      surfaceId: null,
      variantId: null,
      reason: 'Reward weights updated.',
      impressions: null,
    });

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as {
      adaptation: { entries: { surfaceId: string }[] };
    };

    expect(input.adaptation.entries[0]?.surfaceId).not.toContain('undefined');
    expect(input.adaptation.entries[0]).not.toHaveProperty('impressions');
  });

  it('carries a rejected topic with the rule that refused it', async () => {
    const h = jobHarness();
    h.report.refused.push(
      signal({
        label: 'Election night',
        safetyVerdict: 'block',
        safetyReason: 'Blocked: elections.',
      }),
    );

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as { web: { rejected: { reason: string }[] } };

    expect(input.web.rejected[0]?.reason).toBe('Blocked: elections.');
  });

  /**
   * "The classifier said no" is not a reviewable answer, so a row with no recorded reason
   * says that rather than leaving the field empty.
   */
  it('says so when a rejection has no recorded reason', async () => {
    const h = jobHarness();
    h.report.refused.push(signal({ safetyVerdict: 'block', safetyReason: null }));

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as { web: { rejected: { reason: string }[] } };

    expect(input.web.rejected[0]?.reason).toBe('No reason recorded.');
  });

  /**
   * The audience vector's absence is inferred from whether any signal carries a fit that
   * was measured rather than the neutral prior the cluster job stores when it cannot.
   */
  it('notices that topics were scored without an audience vector', async () => {
    const h = jobHarness();
    h.report.clusters.push(signal({ audienceFit: 0.5 }));

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as { next: { intentions: string[] } };

    expect(input.next.intentions.join(' ')).toMatch(/three signals rather than four/);
  });

  it('says nothing about it once a vector exists', async () => {
    const h = jobHarness();
    h.report.clusters.push(signal({ audienceFit: 0.73 }));

    await runReport(h.deps, {});
    const input = h.runs.recorded[0]?.inputs as { next: { intentions: string[] } };

    expect(input.next.intentions.join(' ')).not.toMatch(/three signals/);
  });
});

describe('the prose pass', () => {
  const leadWriter = (lead: string | null) => ({
    model: 'claude-sonnet-5',
    lead: (): Promise<string | null> => Promise.resolve(lead),
  });

  async function sentReport(h: ReturnType<typeof jobHarness>): Promise<string> {
    await runReport(h.deps, {});
    return h.sent.join('\n');
  }

  /** Something has to have happened, or the brief form is used and skips the pass. */
  function eventful(h: ReturnType<typeof jobHarness>): void {
    h.report.published.push({ title: 'A piece', slug: 'a-piece' });
  }

  it('puts a verified lead on top of the report', async () => {
    const h = jobHarness({ prose: leadWriter('A quiet hour with one piece published.') });
    eventful(h);

    const text = await sentReport(h);
    expect(text.startsWith('A quiet hour with one piece published.')).toBe(true);
    expect(text).toContain('Desire Path');
  });

  /**
   * The case the verification exists for. A plausible sentence with a figure nobody
   * measured must not reach the operator, and the report must arrive anyway.
   */
  it('discards a lead that quotes a figure nobody measured', async () => {
    const h = jobHarness({ prose: leadWriter('Traffic reached 84,000 sessions this hour.') });
    eventful(h);

    const text = await sentReport(h);

    expect(text).not.toContain('84,000');
    expect(text).toContain('Desire Path');
    expect(h.log.find('report.prose-rejected')).toMatchObject({ violations: ['84,000'] });
  });

  /**
   * A model that is rate-limited or down costs the lead, not the hour.
   */
  it('sends the report when the writer fails', async () => {
    const h = jobHarness({
      prose: { model: 'claude-sonnet-5', lead: () => Promise.reject(new Error('rate limited')) },
    });
    eventful(h);

    const result = await runReport(h.deps, {});

    expect(result.kind).toBe('sent');
    expect(h.log.events('warn')).toContain('report.prose-failed');
  });

  it('sends the report when the writer has nothing to say', async () => {
    const h = jobHarness({ prose: leadWriter(null) });
    eventful(h);

    expect((await runReport(h.deps, {})).kind).toBe('sent');
  });

  it('sends the report when no writer is configured', async () => {
    const h = jobHarness();
    eventful(h);

    const text = await sentReport(h);
    expect(text).toContain('Desire Path');
  });

  /**
   * The brief form is one line whose whole point is that nothing happened. A model-written
   * paragraph on top of it would be the exact opposite of what it is for.
   */
  it('does not ask for a lead on a quiet hour', async () => {
    let asked = false;
    const h = jobHarness({
      prose: {
        model: 'claude-sonnet-5',
        lead: () => {
          asked = true;
          return Promise.resolve('Something.');
        },
      },
    });

    const result = await runReport(h.deps, {});

    expect(result.kind === 'sent' && result.reportKind).toBe('brief');
    expect(asked).toBe(false);
  });
});

describe('provenance', () => {
  const writer = (lead: string) => ({
    model: 'claude-sonnet-5',
    lead: (): Promise<string | null> => Promise.resolve(lead),
  });

  /**
   * The report goes to one person who turned the pass on, so labelling every message would
   * be noise — but "was this hour's opening written by a model, and which one" has to stay
   * answerable months later.
   */
  it('records which model wrote the lead', async () => {
    const h = jobHarness({ prose: writer('One piece published, nothing else moved.') });
    h.report.published.push({ title: 'A piece', slug: 'a-piece' });

    await runReport(h.deps, {});
    expect(h.runs.recorded[0]?.composedByModel).toBe('claude-sonnet-5');
  });

  it('records nothing when the lead was rejected', async () => {
    const h = jobHarness({ prose: writer('Traffic reached 84,000 sessions.') });
    h.report.published.push({ title: 'A piece', slug: 'a-piece' });

    await runReport(h.deps, {});
    expect(h.runs.recorded[0]?.composedByModel).toBeNull();
  });

  it('records nothing for a report nobody wrote a lead for', async () => {
    const h = jobHarness();
    await runReport(h.deps, {});
    expect(h.runs.recorded[0]?.composedByModel).toBeNull();
  });
});
