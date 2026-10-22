import { describe, expect, it } from 'vitest';
import {
  commit,
  escalationDecisions,
  formatDuration,
  type AlertState,
} from '../src/lib/escalation';
import {
  FAILED_JOB_THRESHOLD,
  renderAlert,
  renderRecovery,
  runEscalate,
  type EscalateDeps,
} from '../src/jobs/escalate';
import { FakeLogger } from './fakes';
import type { Alert } from '@morph/telegram';
import type {
  AnomalyFacts,
  FunnelFacts,
  MetricsRepository,
  RewardFacts,
  TrafficFacts,
} from '../src/ports';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const critical = (title: string): Alert => ({ severity: 'critical', title, detail: 'Detail.' });
const warning = (title: string): Alert => ({ severity: 'warning', title, detail: 'Detail.' });

// -----------------------------------------------------------------------------
// The decision
// -----------------------------------------------------------------------------

describe('deciding what to escalate', () => {
  it('escalates a condition the first time it appears', () => {
    const decision = escalationDecisions([critical('Postgres is unreachable')], new Map(), NOW);

    expect(decision.toNotify).toHaveLength(1);
    expect(decision.resolved).toEqual([]);
  });

  /**
   * Escalation is about transitions; the report is about state. An operator who has been
   * told ClickHouse is down does not need to be told again every five minutes, and the
   * hourly report carries the ongoing condition anyway.
   */
  it('says nothing the second time', () => {
    const first = escalationDecisions([critical('Postgres is unreachable')], new Map(), NOW);
    const second = escalationDecisions(
      [critical('Postgres is unreachable')],
      commit(first, new Set(['Postgres is unreachable'])),
      NOW + 5 * MINUTE,
    );

    expect(second.toNotify).toEqual([]);
  });

  /**
   * An alert that fires and never resolves teaches the reader that alerts do not resolve,
   * and the next outage looks identical to the last one still being open.
   */
  it('reports a recovery', () => {
    const first = escalationDecisions([critical('Postgres is unreachable')], new Map(), NOW);
    const known = commit(first, new Set(['Postgres is unreachable']));

    const second = escalationDecisions([], known, NOW + 30 * MINUTE);

    expect(second.resolved.map((s) => s.title)).toEqual(['Postgres is unreachable']);
    expect(second.next.size).toBe(0);
  });

  /**
   * A push notification for "three drafts are waiting" is how an operator learns that push
   * notifications are not worth opening, and then misses the one that was.
   */
  it('ignores anything that is not critical', () => {
    const decision = escalationDecisions([warning('2 sources are stale')], new Map(), NOW);

    expect(decision.toNotify).toEqual([]);
    expect(decision.next.size).toBe(0);
  });

  it('keeps the first sighting, so a recovery can say how long it lasted', () => {
    const first = escalationDecisions([critical('Down')], new Map(), NOW);
    const known = commit(first, new Set(['Down']));

    const later = escalationDecisions([critical('Down')], known, NOW + 40 * MINUTE);
    expect(later.next.get('Down')?.firstSeenAt).toBe(NOW);
  });

  /** A count in the title is part of its identity: "3 hosts cut off" is news after "2". */
  it('treats a changed count as a new condition', () => {
    const first = escalationDecisions([critical('2 hosts cut off')], new Map(), NOW);
    const known = commit(first, new Set(['2 hosts cut off']));

    const second = escalationDecisions([critical('3 hosts cut off')], known, NOW + MINUTE);

    expect(second.toNotify.map((a) => a.title)).toEqual(['3 hosts cut off']);
    expect(second.resolved.map((s) => s.title)).toEqual(['2 hosts cut off']);
  });
});

describe('remembering only what was delivered', () => {
  /**
   * The one path where this is easy to get wrong: an escalation whose send failed must be
   * retried, and remembering it as sent would mean an outage nobody was ever told about.
   */
  it('forgets a transition whose message did not go out', () => {
    const decision = escalationDecisions([critical('Down')], new Map(), NOW);
    expect(commit(decision, new Set()).size).toBe(0);
  });

  it('remembers one that did', () => {
    const decision = escalationDecisions([critical('Down')], new Map(), NOW);
    expect(commit(decision, new Set(['Down'])).size).toBe(1);
  });

  it('keeps an already-known condition regardless of this run', () => {
    const first = commit(
      escalationDecisions([critical('Down')], new Map(), NOW),
      new Set(['Down']),
    );
    const second = escalationDecisions([critical('Down')], first, NOW + MINUTE);

    expect(commit(second, new Set()).has('Down')).toBe(true);
  });
});

describe('durations', () => {
  it('reads the way a person would say it', () => {
    expect(formatDuration(30_000)).toBe('under a minute');
    expect(formatDuration(MINUTE)).toBe('1 minute');
    expect(formatDuration(47 * MINUTE)).toBe('47 minutes');
    expect(formatDuration(120 * MINUTE)).toBe('2 hours');
    expect(formatDuration(95 * MINUTE)).toBe('1h 35m');
  });

  it('never reports a negative duration from a clock that moved backwards', () => {
    expect(formatDuration(-5000)).toBe('under a minute');
  });
});

describe('the message', () => {
  it('leads with the condition and escapes what MarkdownV2 would reject', () => {
    const text = renderAlert({
      severity: 'critical',
      title: 'The morph.crawl queue has 30 failed jobs',
      detail: 'Retries are exhausted (nothing is succeeding).',
    });

    expect(text.startsWith('🔴')).toBe(true);
    // The dot in a queue name and the brackets in the detail both need escaping, and one
    // unescaped character makes Telegram reject the whole message with a 400 — which for
    // an escalation means the outage goes unreported.
    expect(text).toContain('morph\\.crawl');
    expect(text).toContain('\\(');
    expect(text).toContain('\\)');
  });

  it('says how long a resolved condition lasted', () => {
    const state: AlertState = {
      title: 'Postgres is unreachable',
      firstSeenAt: NOW,
      notifiedAt: NOW,
    };
    const text = renderRecovery(state, NOW + 95 * MINUTE);

    expect(text.startsWith('🟢')).toBe(true);
    expect(text).toContain('1h 35m');
    expect(text).toContain('resolved');
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

function metricsThat(up: boolean): MetricsRepository {
  return {
    traffic: (): Promise<TrafficFacts> => Promise.resolve(NO_TRAFFIC),
    funnel: (): Promise<FunnelFacts> => Promise.resolve({}),
    providers: () => Promise.resolve([]),
    reward: (): Promise<RewardFacts> =>
      Promise.resolve({
        adaptiveReward: 0,
        adaptiveImpressions: 0,
        holdoutReward: 0,
        holdoutImpressions: 0,
      }),
    rewardSince: (): Promise<RewardFacts> =>
      Promise.resolve({
        adaptiveReward: 0,
        adaptiveImpressions: 0,
        holdoutReward: 0,
        holdoutImpressions: 0,
      }),
    anomalyProfile: (): Promise<AnomalyFacts> =>
      Promise.resolve({ meanSessions: 0, sdSessions: 0, weeksObserved: 0 }),
    ping: () => Promise.resolve(up),
  };
}

function harness(
  options: {
    metricsUp?: boolean;
    postgresUp?: boolean;
    failed?: Record<string, number>;
    failSend?: boolean;
    noBot?: boolean;
  } = {},
) {
  const sent: string[] = [];
  const log = new FakeLogger();
  const state: { known: ReadonlyMap<string, AlertState> } = { known: new Map() };

  const deps: EscalateDeps = {
    metrics: metricsThat(options.metricsUp ?? true),
    report: {
      ping: () => Promise.resolve(options.postgresUp ?? true),
    } as EscalateDeps['report'],
    queues: { failedCounts: () => Promise.resolve(options.failed ?? {}) },
    telegram:
      options.noBot === true
        ? null
        : {
            send: (text: string): Promise<readonly number[]> => {
              if (options.failSend === true) return Promise.reject(new Error('chat not found'));
              sent.push(text);
              return Promise.resolve([sent.length]);
            },
          },
    state,
    now: () => NOW,
    log,
  };

  return { sent, log, state, deps };
}

describe('the escalation job', () => {
  it('says nothing when everything is up', async () => {
    const h = harness();
    const result = await runEscalate(h.deps);

    expect(result).toEqual({ critical: 0, escalated: 0, recovered: 0 });
    expect(h.sent).toEqual([]);
  });

  it('escalates an unreachable store once', async () => {
    const h = harness({ postgresUp: false });

    const first = await runEscalate(h.deps);
    const second = await runEscalate(h.deps);

    expect(first.escalated).toBe(1);
    expect(second.escalated).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('Postgres');
  });

  it('escalates both stores when both are down', async () => {
    const h = harness({ postgresUp: false, metricsUp: false });
    expect((await runEscalate(h.deps)).escalated).toBe(2);
  });

  /**
   * Jobs fail — a host times out, a model rate-limits. What is not routine is a queue where
   * nothing is succeeding.
   */
  it('ignores a handful of failed jobs and escalates a queue that has stopped', async () => {
    const quiet = harness({ failed: { 'morph.crawl': FAILED_JOB_THRESHOLD - 1 } });
    expect((await runEscalate(quiet.deps)).escalated).toBe(0);

    const broken = harness({ failed: { 'morph.crawl': FAILED_JOB_THRESHOLD } });
    const result = await runEscalate(broken.deps);

    expect(result.escalated).toBe(1);
    expect(broken.sent[0]).toContain('morph');
  });

  it('reports the recovery when the condition clears', async () => {
    const down = harness({ postgresUp: false });
    await runEscalate(down.deps);

    // The same state, now with everything up.
    const up = harness();
    up.state.known = down.state.known;
    up.deps.state.known = down.state.known;

    const result = await runEscalate(up.deps);

    expect(result.recovered).toBe(1);
    expect(up.sent[0]).toContain('resolved');
  });

  /**
   * An outage nobody was told about is the failure this job exists to prevent, so a send
   * that fails must not be remembered as done.
   */
  it('retries an escalation whose message failed', async () => {
    const h = harness({ postgresUp: false, failSend: true });

    const first = await runEscalate(h.deps);
    expect(first.escalated).toBe(0);
    expect(h.state.known.size).toBe(0);
    expect(h.log.events('error')).toContain('escalate.send-failed');
  });

  it('does not swallow the transition when there is no bot at all', async () => {
    const h = harness({ postgresUp: false, noBot: true });

    await runEscalate(h.deps);

    expect(h.state.known.size).toBe(0);
    expect(h.log.events('warn')).toContain('escalate.no-transport');
  });

  /**
   * The probe must never be the reason something breaks: a queue count that throws costs
   * the queue check, not the store checks beside it.
   */
  it('still checks the stores when the queue probe fails', async () => {
    const h = harness({ postgresUp: false });
    h.deps.queues.failedCounts = () => Promise.reject(new Error('redis'));

    expect((await runEscalate(h.deps)).escalated).toBe(1);
  });
});

describe('when the recovery message cannot be sent', () => {
  /**
   * Softer than a failed escalation: the condition has cleared, so nobody is waiting on
   * this. It is logged as a warning and the state moves on — re-reporting a recovery on
   * the next run would mean a "resolved" message for something already resolved.
   */
  it('logs it and does not retry', async () => {
    const down = harness({ postgresUp: false });
    await runEscalate(down.deps);

    const up = harness({ failSend: true });
    up.deps.state.known = down.state.known;

    const result = await runEscalate(up.deps);

    expect(result.recovered).toBe(0);
    expect(up.log.events('warn')).toContain('escalate.recovery-send-failed');
    expect(up.deps.state.known.size).toBe(0);
  });
});
