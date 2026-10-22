/**
 * The hourly report.
 *
 * Gathers the facts, derives the numbers, composes the message, sends it, and records
 * that it did. The composer has existed since Phase 6 and is fully tested; this is the
 * part that gives it something true to say.
 *
 * WHY THE HOUR IS THE ONE THAT FINISHED
 * A report about the hour in progress is a report about a partial hour, and comparing a
 * partial hour to a complete one from last week makes every metric look down. The job runs
 * a few minutes past the hour and reports the hour before it.
 *
 * WHY IT WILL NOT SEND TWICE
 * `report_run` has a unique key on `hour_start`, and the job checks it before composing. A
 * retry after a failed send, a redeploy that re-registers the schedule, a worker restart
 * mid-hour: all of them can run this job again for an hour already reported, and none of
 * them should produce a second copy in the operator's chat.
 *
 * WHY A FAILED SEND IS STILL RECORDED
 * The row is written with `sent_at` null and the error text. Without that, a report that
 * failed to send is indistinguishable from an hour the job never ran — and the difference
 * is the difference between "Telegram was down" and "the worker has been dead since
 * Tuesday".
 */

import { composeReport, verifyLead, withLead, type ReportInput } from '@morph/telegram';
import {
  alertsFrom,
  delta,
  funnelFrom,
  hourStartFor,
  holdoutFrom,
  intentionsFrom,
  rate,
  sameHourLastWeek,
  topRows,
} from '../lib/report-derive';
import type {
  Clock,
  ContentRepository,
  Logger,
  MetricsRepository,
  ReportRepository,
  ReportRunRepository,
} from '../ports';
import type { ReportJob } from '../queues';

export interface ReportSender {
  send(text: string): Promise<readonly number[]>;
}

/**
 * The optional prose pass.
 *
 * `null` is a first-class state: no key, a model that is down, or an operator who would
 * rather read the deterministic form. Everything below treats a missing lead and a rejected
 * one identically, which is what makes the pass safe to turn off and safe to leave on.
 */
export interface ProseWriter {
  readonly model: string;
  lead(report: string, facts: ReportInput): Promise<string | null>;
}

export interface ReportDeps {
  readonly metrics: MetricsRepository;
  readonly report: ReportRepository;
  readonly runs: ReportRunRepository;
  readonly content: ContentRepository;
  readonly telegram: ReportSender | null;
  readonly prose: ProseWriter | null;
  readonly timezone: string;
  /** When the process started, for the uptime line. */
  readonly startedAt: number;
  /** When the holdout cohort began accumulating, for the cumulative lift. */
  readonly holdoutSince: number;
  /** `off` in the environment is `manual` in the report's vocabulary. */
  readonly autonomy: 'off' | 'manual' | 'review' | 'auto';
  readonly now: Clock;
  readonly log: Logger;
}

export type ReportOutcome =
  | {
      readonly kind: 'sent';
      readonly hourStart: number;
      readonly messages: number;
      readonly reportKind: 'full' | 'brief';
    }
  | { readonly kind: 'already-sent'; readonly hourStart: number }
  | { readonly kind: 'no-transport'; readonly hourStart: number }
  | { readonly kind: 'failed'; readonly hourStart: number; readonly error: string };

/** How many rows of each top-N list the report carries. */
export const TOP_N = 5;

/** How the messages are rejoined for the model, matching how the composer split them. */
const SECTION_GAP = '\n\n';

/** A draft older than this is called stale, in the alerts and in the next-hour section. */
export const STALE_DRAFT_MS = 24 * 60 * 60 * 1000;

export async function runReport(deps: ReportDeps, job: ReportJob): Promise<ReportOutcome> {
  const hourStart = job.hourStart ?? hourStartFor(deps.now());
  const hourEnd = hourStart + 3_600_000;

  if (await deps.runs.wasSent(hourStart)) {
    deps.log.info('report.already-sent', { hourStart: new Date(hourStart).toISOString() });
    return { kind: 'already-sent', hourStart };
  }

  const input = await gather(deps, hourStart, hourEnd);
  const composed = composeReport(input);

  // The brief form is one line. Adding a model-written paragraph to a message whose whole
  // point is that nothing happened would be the exact opposite of what it is for.
  const led =
    composed.kind === 'brief'
      ? { messages: composed.messages, model: null }
      : await withVerifiedLead(deps, composed.messages, input);

  const messages = led.messages;

  if (deps.telegram === null) {
    // Recorded anyway, with its inputs: an operator who later configures a bot can see
    // that the reports were being produced, and `report_run.inputs` lets one be re-composed
    // months later without the metrics still existing.
    await deps.runs.record({
      hourStart,
      kind: composed.kind,
      messageIds: [],
      charCount: composed.charCount,
      inputs: input,
      composedByModel: led.model,
      sentAt: null,
      error: 'No Telegram transport is configured.',
    });

    deps.log.warn('report.no-transport', { hourStart: new Date(hourStart).toISOString() });
    return { kind: 'no-transport', hourStart };
  }

  const messageIds: number[] = [];

  try {
    for (const message of messages) {
      messageIds.push(...(await deps.telegram.send(message)));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    await deps.runs.record({
      hourStart,
      kind: composed.kind,
      messageIds,
      charCount: composed.charCount,
      inputs: input,
      composedByModel: led.model,
      sentAt: null,
      error: detail,
    });

    deps.log.error('report.send-failed', {
      hourStart: new Date(hourStart).toISOString(),
      message: detail,
    });
    return { kind: 'failed', hourStart, error: detail };
  }

  await deps.runs.record({
    hourStart,
    kind: composed.kind,
    messageIds,
    charCount: composed.charCount,
    inputs: input,
    composedByModel: led.model,
    sentAt: deps.now(),
    error: null,
  });

  deps.log.info('report.sent', {
    hourStart: new Date(hourStart).toISOString(),
    kind: composed.kind,
    messages: messages.length,
    chars: composed.charCount,
  });

  return { kind: 'sent', hourStart, messages: messages.length, reportKind: composed.kind };
}

/**
 * Ask for a lead, verify it, and use it only if it survives.
 *
 * Three outcomes, and two of them are the same message: no writer configured, the writer
 * failed, or the lead quoted a figure nobody measured. In all three the operator gets the
 * report they would have got anyway — the deterministic render is the contract, and the
 * prose is the part that is allowed to not arrive.
 *
 * A rejected lead is logged with the offending tokens, because the failure worth acting on
 * is not one bad lead but a pattern of them, and a pattern is only visible if each one is
 * written down.
 */
async function withVerifiedLead(
  deps: ReportDeps,
  messages: readonly string[],
  input: ReportInput,
): Promise<{ readonly messages: readonly string[]; readonly model: string | null }> {
  const unchanged = { messages, model: null };
  if (deps.prose === null) return unchanged;

  let lead: string | null;

  try {
    lead = await deps.prose.lead(messages.join(SECTION_GAP), input);
  } catch (error) {
    // The report is not held up by the optional part of it. A model that is rate-limited
    // or down costs the lead, not the hour.
    deps.log.warn('report.prose-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return unchanged;
  }

  if (lead === null) return unchanged;

  const verdict = verifyLead(lead, input);

  if (!verdict.ok) {
    deps.log.warn('report.prose-rejected', {
      violations: verdict.violations.map((v) => v.token),
      lead: lead.slice(0, 200),
      model: deps.prose.model,
    });
    return unchanged;
  }

  return { messages: withLead(messages, verdict.lead), model: deps.prose.model };
}

/**
 * Every fact the report states, gathered in one place.
 *
 * The two stores are queried independently and their failures are not equivalent: without
 * ClickHouse there are no metrics and the report says so in its health line; without
 * Postgres there is nothing to say about adaptation or content. Neither is allowed to
 * prevent the other from being reported, because an hour where half the system is down is
 * the hour the operator most needs the other half's numbers.
 */
async function gather(deps: ReportDeps, hourStart: number, hourEnd: number): Promise<ReportInput> {
  const lastWeek = sameHourLastWeek(hourStart);

  const [metricsUp, postgresUp] = await Promise.all([deps.metrics.ping(), deps.report.ping()]);

  const services = [
    { name: 'postgres', status: postgresUp ? ('up' as const) : ('down' as const) },
    { name: 'clickhouse', status: metricsUp ? ('up' as const) : ('down' as const) },
  ];

  const [traffic, trafficLastWeek, funnel, funnelLastWeek, providers, reward, cumulative, anomaly] =
    await Promise.all([
      deps.metrics.traffic(hourStart),
      deps.metrics.traffic(lastWeek),
      deps.metrics.funnel(hourStart),
      deps.metrics.funnel(lastWeek),
      deps.metrics.providers(hourStart),
      deps.metrics.reward(hourStart),
      deps.metrics.rewardSince(deps.holdoutSince),
      deps.metrics.anomalyProfile(hourStart),
    ]);

  const [
    adaptations,
    champions,
    rewardVersion,
    newClusters,
    rejected,
    published,
    crawled,
    staleRobots,
    draftsAwaitingReview,
    staleDrafts,
    documentsAwaitingEmbedding,
    clustersAwaitingContent,
    queued,
  ] = await Promise.all([
    deps.report.adaptations(hourStart, hourEnd),
    deps.report.champions(),
    deps.report.rewardVersion(),
    deps.report.newClusters(hourStart, hourEnd, TOP_N),
    deps.report.rejectedTopics(hourStart, hourEnd, TOP_N),
    deps.report.publishedInHour(hourStart, hourEnd),
    deps.report.documentsFetched(hourStart, hourEnd),
    deps.report.staleRobotsCount(deps.now()),
    deps.report.draftsAwaitingReview(),
    deps.report.draftsOlderThan(deps.now() - STALE_DRAFT_MS),
    deps.report.documentsAwaitingEmbedding(),
    deps.report.clustersAwaitingContent(),
    deps.content.pendingReview(TOP_N),
  ]);

  const signups = funnel['signup_complete'] ?? 0;
  const landings = funnel['land'] ?? 0;

  const alerts = alertsFrom({
    services,
    anomaly: { sessions: traffic.sessions, ...anomaly },
    // Populated once the crawl scheduler's breaker state is persisted; until then the
    // alert cannot fire and says nothing rather than saying zero hosts are broken.
    brokenHosts: [],
    staleDrafts,
    staleRobots,
  });

  const next = intentionsFrom({
    documentsAwaitingEmbedding,
    clustersAwaitingContent,
    draftsAwaitingReview,
    // The cluster job reports this in its own log; here it is inferred from whether any
    // signal carries a fit that was measured rather than the neutral prior.
    audienceVectorKnown: newClusters.some((c) => c.audienceFit !== 0.5),
    staleDrafts,
    brokenHosts: [],
  });

  return {
    hourStart: new Date(hourStart).toISOString(),
    timezone: deps.timezone,
    uptimeSeconds: Math.max(0, Math.floor((deps.now() - deps.startedAt) / 1000)),
    services,

    traffic: {
      sessions: traffic.sessions,
      uniques: traffic.uniques,
      pageviews: traffic.pageviews,
      newVisitors: traffic.newVisitors,
      returningVisitors: traffic.returningVisitors,
      sessionsDeltaVsLastWeek: delta(traffic.sessions, trafficLastWeek.sessions),
      topSources: topRows(traffic.sources, trafficLastWeek.sources, TOP_N),
      topCountries: topRows(traffic.countries, trafficLastWeek.countries, TOP_N),
      topPages: topRows(traffic.pages, trafficLastWeek.pages, TOP_N),
    },

    conversion: {
      signups,
      signupRate: rate(signups, landings),
      activationRate: rate(funnel['activated'] ?? 0, signups),
      byProvider: providers.map((provider) => ({
        provider: provider.provider,
        signups: provider.signups,
        // Of the people who started with this provider, how many finished. Not of all
        // visitors — that would rank providers by how prominently they were placed, which
        // is the surface the bandit is already optimising.
        conversionRate: rate(provider.signups, provider.starts),
      })),
      funnel: funnelFrom(funnel, funnelLastWeek),
    },

    adaptation: {
      entries: adaptations.map((entry) => ({
        action: entry.action as never,
        surfaceId: entry.surfaceId ?? '—',
        variantId: entry.variantId ?? '—',
        variantLabel: entry.variantId ?? '—',
        reason: entry.reason,
        ...(entry.impressions === null ? {} : { impressions: entry.impressions }),
      })),
      champions: champions.map((champion) => ({
        surfaceId: champion.surfaceId,
        variantId: champion.variantId,
        variantLabel: champion.variantLabel,
        posteriorMean: champion.alpha / (champion.alpha + champion.beta),
        credibleInterval: betaInterval(champion.alpha, champion.beta),
        impressions: champion.impressions,
        activeVariants: champion.activeVariants,
      })),
      liveTheme: LIVE_THEME_UNKNOWN,
    },

    web: {
      newClusters: newClusters.map((cluster) => ({
        id: cluster.id,
        label: cluster.label,
        momentum: cluster.momentum,
        audienceFit: cluster.audienceFit,
        saturation: cluster.saturation,
        documentCount: cluster.documentCount,
      })),
      published,
      queued: queued.map((draft) => ({ title: draft.title })),
      rejected: rejected.map((signal) => ({
        label: signal.label,
        reason: signal.safetyReason ?? 'No reason recorded.',
      })),
      documentsFetched: crawled.documents,
      hostsCrawled: crawled.hosts,
    },

    social: {
      // Phase 7. Reported as an empty list rather than omitted, so the section says
      // "nothing posted" — which is true — instead of disappearing and leaving the
      // operator to wonder whether it failed.
      platforms: [],
      awaitingApproval: draftsAwaitingReview,
      autonomy: deps.autonomy === 'off' ? 'manual' : deps.autonomy,
    },

    holdout: holdoutFrom({
      ...reward,
      cumulativeAdaptiveReward: cumulative.adaptiveReward,
      cumulativeAdaptiveImpressions: cumulative.adaptiveImpressions,
      cumulativeHoldoutReward: cumulative.holdoutReward,
      cumulativeHoldoutImpressions: cumulative.holdoutImpressions,
      // The always-valid test lives in `@morph/adaptive` and runs on the engine's own
      // state, not on a report's snapshot. Until the aggregation job feeds it, the report
      // says "not conclusive", which is both true and the safe direction.
      pValue: 1,
      conclusive: false,
    }),

    alerts,
    next,
    rewardVersion,
  };
}

/**
 * The live theme, when nothing has recorded one.
 *
 * The assignment is chosen per visitor at the edge, so "the live theme" is only meaningful
 * as the current champion of each design surface — which the adaptation aggregation job
 * will record. Naming it as unknown beats naming a variant that was true for one visitor.
 */
const LIVE_THEME_UNKNOWN = {
  palette: 'not yet recorded',
  typography: 'not yet recorded',
  density: 'not yet recorded',
  motion: 'not yet recorded',
} as const;

/**
 * A rough 95% interval for a Beta posterior.
 *
 * The exact quantiles are in `@morph/adaptive`, and using them here would mean the report
 * job depending on the engine to print a number. The normal approximation is accurate to
 * a fraction of a percentage point at the impression counts a champion has by the time it
 * is a champion, and the report rounds to two decimals anyway.
 */
export function betaInterval(alpha: number, beta: number): readonly [number, number] {
  const total = alpha + beta;
  if (total <= 0) return [0, 0];

  const mean = alpha / total;
  const variance = (alpha * beta) / (total * total * (total + 1));
  const spread = 1.96 * Math.sqrt(variance);

  return [Math.max(0, mean - spread), Math.min(1, mean + spread)];
}
