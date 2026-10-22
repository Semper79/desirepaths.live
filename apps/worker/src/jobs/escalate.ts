/**
 * The escalation job: what cannot wait an hour.
 *
 * Runs every few minutes, checks the handful of conditions that are cheap to check and
 * genuinely urgent, and sends a message when one appears or clears. Everything else — a
 * queue of drafts, a source going stale, traffic drifting — waits for the report, because
 * a channel that fires for everything is a channel that gets muted.
 *
 * WHY THE STATE IS IN THIS PROCESS
 * Which alerts have already been escalated lives in memory, not in Postgres. A restart
 * therefore re-escalates whatever is still broken, and that is the behaviour worth having:
 * a worker that just restarted during an outage is exactly the situation where the
 * operator's picture is most likely to be stale. The cost is one duplicate message in a
 * case that already warranted attention.
 *
 * WHAT IT DELIBERATELY CANNOT TELL YOU
 * That Redis is down. The queues run on Redis, so a Redis outage stops this job along with
 * everything else — it is the one failure the system cannot report on its own behalf, and
 * catching it needs an external check. `infra/prometheus/rules/morph.yml` is where that
 * belongs, and saying so here is better than implying this covers it.
 */

import { escalationDecisions, commit, formatDuration, type AlertState } from '../lib/escalation';
import { escape, bold, type Alert } from '@morph/telegram';
import type { Clock, Logger, MetricsRepository, ReportRepository } from '../ports';

/**
 * How many failed jobs in one queue before it is an emergency rather than a statistic.
 *
 * Jobs fail: a host times out, a model rate-limits, a query is slow. What is not routine is
 * a queue where nothing is succeeding, and at this depth the retries have long since been
 * exhausted for several jobs in a row.
 */
export const FAILED_JOB_THRESHOLD = 25;

export interface QueueProbe {
  /** Failed job counts by queue name. */
  failedCounts(): Promise<Readonly<Record<string, number>>>;
}

export interface EscalationSender {
  send(text: string): Promise<readonly number[]>;
}

export interface EscalateDeps {
  readonly metrics: MetricsRepository;
  readonly report: ReportRepository;
  readonly queues: QueueProbe;
  readonly telegram: EscalationSender | null;
  /** Read and written by the job. In-process by design — see the note above. */
  readonly state: { known: ReadonlyMap<string, AlertState> };
  readonly now: Clock;
  readonly log: Logger;
}

export interface EscalateOutcome {
  readonly critical: number;
  readonly escalated: number;
  readonly recovered: number;
}

/**
 * The payload is empty by design: there is nothing to configure about "check whether the
 * stores answer", and a knob nobody would turn is a knob that eventually gets turned.
 */
export async function runEscalate(deps: EscalateDeps): Promise<EscalateOutcome> {
  const now = deps.now();
  const active = await probe(deps);

  const decision = escalationDecisions(active, deps.state.known, now);

  if (decision.toNotify.length === 0 && decision.resolved.length === 0) {
    // Nothing changed. The state is still advanced, so a condition that has been critical
    // for an hour keeps its original `firstSeenAt` for the recovery message.
    deps.state.known = decision.next;
    return { critical: active.length, escalated: 0, recovered: 0 };
  }

  if (deps.telegram === null) {
    deps.log.warn('escalate.no-transport', {
      critical: decision.toNotify.map((alert) => alert.title),
    });
    // Not committed: with no way to tell anybody, the transition has not happened as far
    // as this job is concerned, and it will fire again once a transport exists.
    return { critical: active.length, escalated: 0, recovered: 0 };
  }

  const delivered = new Set<string>();

  for (const alert of decision.toNotify) {
    try {
      await deps.telegram.send(renderAlert(alert));
      delivered.add(alert.title);
      deps.log.error('escalate.sent', { title: alert.title });
    } catch (error) {
      // Left undelivered so the next run tries again. An outage nobody was told about is
      // the failure this job exists to prevent, and swallowing it here would recreate it.
      deps.log.error('escalate.send-failed', {
        title: alert.title,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let recovered = 0;

  for (const state of decision.resolved) {
    try {
      await deps.telegram.send(renderRecovery(state, now));
      recovered += 1;
      deps.log.info('escalate.recovered', { title: state.title });
    } catch (error) {
      deps.log.warn('escalate.recovery-send-failed', {
        title: state.title,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  deps.state.known = commit(decision, delivered);

  return { critical: active.length, escalated: delivered.size, recovered };
}

/**
 * The conditions worth checking between reports.
 *
 * Deliberately few, and all cheap: this runs every few minutes and must never be the
 * reason a store is under load. Anything needing a real query belongs in the hourly report,
 * where it is computed once.
 */
async function probe(deps: EscalateDeps): Promise<readonly Alert[]> {
  const alerts: Alert[] = [];

  const [metricsUp, postgresUp, failed] = await Promise.all([
    deps.metrics.ping(),
    deps.report.ping(),
    // A queue probe that throws costs the queue check, not the store checks beside it.
    deps.queues.failedCounts().catch((): Readonly<Record<string, number>> => ({})),
  ]);

  if (!postgresUp) {
    alerts.push({
      severity: 'critical',
      title: 'Postgres is unreachable',
      detail:
        'Nothing can be crawled, clustered, published or approved. The site serves whatever it last read.',
    });
  }

  if (!metricsUp) {
    alerts.push({
      severity: 'critical',
      title: 'ClickHouse is unreachable',
      detail:
        'Events are still being buffered by Redpanda, so nothing is lost yet — but the bandit is deciding on stale posteriors and the next report will have no numbers.',
    });
  }

  for (const [queue, count] of Object.entries(failed)) {
    if (count < FAILED_JOB_THRESHOLD) continue;

    alerts.push({
      severity: 'critical',
      title: `The ${queue} queue has ${String(count)} failed jobs`,
      detail: 'Retries are exhausted. Whatever this queue does has stopped happening.',
    });
  }

  return alerts;
}

/**
 * An escalation reads as an interruption, because it is one.
 *
 * No section numbering, no surrounding report: the title, what it means, and nothing else
 * to scroll past at whatever time of night this arrives.
 */
export function renderAlert(alert: Alert): string {
  return [`🔴 ${bold(alert.title)}`, '', escape(alert.detail)].join('\n');
}

export function renderRecovery(state: AlertState, now: number): string {
  return [
    `🟢 ${bold(state.title)} ${escape('— resolved')}`,
    '',
    escape(`Lasted ${formatDuration(now - state.firstSeenAt)}.`),
  ].join('\n');
}
