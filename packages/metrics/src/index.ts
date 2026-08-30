/**
 * The Prometheus contract.
 *
 * `infra/prometheus/prometheus.yml` has always scraped `/metrics` on the api, the web app
 * and the worker, and `infra/prometheus/rules/morph.yml` has always alerted on nine
 * `morph_*` metric names. Until this package existed, **no service emitted any of them**:
 * every scrape target 404'd, every alert rule evaluated against nothing, and every one of
 * them was therefore permanently not-firing. An alert that cannot fire is worse than no
 * alert, because the absence of a page reads as "everything is fine".
 *
 * WHY ONE PACKAGE AND NOT A FILE PER SERVICE
 * The nine names are a contract between three services, a scrape config, a rules file and
 * (next) a set of dashboards. Six places that must agree on a string. Here they are
 * declared once, and `test/contract.test.ts` reads the alert rules off disk and asserts
 * that every `morph_*` name they reference exists in this registry — so a renamed metric
 * fails the build rather than silently disarming an alert.
 *
 * WHY THE HELP TEXT IS LONG
 * It is what an operator sees in Grafana's metric browser at 3am, and it is the only
 * documentation that travels with the number.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

/**
 * Node's own numbers: resident memory, event-loop lag, handle counts, GC.
 *
 * `bench/soak.js` says in its summary that it cannot observe process memory or
 * connection-pool depth, because nothing served them. `process_resident_memory_bytes`
 * arrives with this call, which closes the first half of that gap.
 */
let runtimeCollected = false;

export function collectRuntimeMetrics(service: string): void {
  // Idempotent, because the call sites differ per service and one of them is a Next
  // instrumentation hook that can run more than once across a dev reload. Registering
  // the default collectors twice throws on a duplicate metric name, which would take
  // the whole process down at boot for the sake of a monitoring convenience.
  if (runtimeCollected) return;
  runtimeCollected = true;

  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
}

// -----------------------------------------------------------------------------
// Ingest — apps/api
// -----------------------------------------------------------------------------

export const ingestRequests = new Counter({
  name: 'morph_ingest_requests_total',
  help: 'Beacon requests accepted by the collector, by outcome. The denominator of the ingest error rate.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const ingestErrors = new Counter({
  name: 'morph_ingest_errors_total',
  help: 'Beacon requests the collector could not accept, by reason: a malformed body, a rate limit, or a broker that refused the write.',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const ingestEvents = new Counter({
  name: 'morph_ingest_events_total',
  help: 'Individual events accepted, which is not the same as requests: a beacon carries between one and fifty.',
  registers: [registry],
});

/**
 * How far behind an event was by the time it was accepted.
 *
 * Buckets stop at a minute rather than continuing: past that the question is no longer
 * "how laggy" but "is the queue draining", which the count answers on its own. The
 * alert in `morph.yml` fires on the p95 crossing five seconds.
 */
export const ingestLagMs = new Histogram({
  name: 'morph_ingest_lag_ms',
  help: 'Milliseconds between an event happening in a browser and the collector accepting it. Offline queues replay old events, so the long tail is expected and is not an error.',
  buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000],
  registers: [registry],
});

// -----------------------------------------------------------------------------
// Rendering — apps/web
// -----------------------------------------------------------------------------

/**
 * How long resolving an assignment takes.
 *
 * §7 puts the adaptive decision under 5 ms and `morph.yml` alerts on the p95 crossing it.
 * Buckets are dense below that and sparse above, because the difference between 1 ms and
 * 2 ms is the budget and the difference between 50 ms and 100 ms is only ever a bug.
 */
export const decisionDurationMs = new Histogram({
  name: 'morph_decision_duration_ms',
  help: 'Milliseconds to resolve a full eleven-surface assignment, excluding the snapshot read. The number §7 budgets at 5 ms.',
  buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 50, 100],
  registers: [registry],
});

export const snapshotAgeSeconds = new Gauge({
  name: 'morph_snapshot_age_seconds',
  help: 'Age of the posterior snapshot this renderer is serving. Climbing without bound means the adapt job has stopped and the site is adapting on stale conclusions.',
  registers: [registry],
});

// -----------------------------------------------------------------------------
// The adaptive engine — apps/worker
// -----------------------------------------------------------------------------

export const explorationRate = new Gauge({
  name: 'morph_exploration_rate',
  help: 'Share of impressions in the last cycle that went to a variant other than the leader. Below the exploration floor the bandit has stopped learning and will not notice the world changing.',
  registers: [registry],
});

export const holdoutLiftRelative = new Gauge({
  name: 'morph_holdout_lift_relative',
  help: 'Measured lift of the adaptive cohort over the pinned baseline, as a ratio. Negative means the adaptation is actively worse than doing nothing.',
  registers: [registry],
});

export const variantsQuarantined = new Counter({
  name: 'morph_variants_quarantined_total',
  help: 'Variants removed by the health guardrail rather than by the reward statistics — a Core Web Vitals, client-error or bounce-rate breach. Which variant and why is in the adaptation log, which is the durable record; this is the rate.',
  registers: [registry],
});

export const variantsRetired = new Counter({
  name: 'morph_variants_retired_total',
  help: 'Variants retired because the evidence settled against them, over time. The reasoning behind each one is in the adaptation log and in the hourly report.',
  registers: [registry],
});

export const webVitalP75 = new Gauge({
  name: 'morph_web_vital_p75',
  help: 'Seventy-fifth percentile of each Core Web Vital across the last cycle. The same budgets Lighthouse enforces in CI, so a variant cannot pass the gate and be quarantined for the number the gate approved.',
  labelNames: ['metric'] as const,
  registers: [registry],
});

export const queueWaiting = new Gauge({
  name: 'morph_queue_waiting',
  help: 'Jobs waiting in each BullMQ queue. A backlog that grows monotonically is a consumer that has died, not a busy one.',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const queueFailed = new Gauge({
  name: 'morph_queue_failed',
  help: 'Jobs in each queue that exhausted their attempts. Unlike the waiting count this does not drain on its own.',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const adaptCycleHour = new Gauge({
  name: 'morph_adapt_cycle_hour_seconds',
  help: 'Unix time of the last hour folded into the posteriors. Compared against now, this is how far behind the adaptive loop has fallen.',
  registers: [registry],
});

/**
 * The exposition text, for a `/metrics` handler.
 *
 * Async because `prom-client` collects lazily — a gauge can be backed by a callback that
 * reads a live value, and the runtime metrics are gathered at scrape time.
 */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const CONTENT_TYPE = registry.contentType;

/** Every `morph_*` name this registry defines. What `contract.test.ts` checks against. */
export function declaredMetricNames(): readonly string[] {
  return registry
    .getMetricsAsArray()
    .map((metric) => metric.name)
    .filter((name) => name.startsWith('morph_'))
    .sort();
}
