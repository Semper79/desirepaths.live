/**
 * The metric contract.
 *
 * Nine `morph_*` names are referenced by the alert rules and by the Grafana dashboards.
 * This package declares them once, and `test/contract.test.ts` reads the rules off disk and
 * fails the build if any referenced name stops existing — so a rename disarms nothing
 * silently. That was the reason the package was created and it has not changed.
 *
 * WHAT CHANGED: THE STORAGE, NOT THE CONTRACT (D31)
 * This was prom-client and a `Registry` scraped over `/metrics`. A Worker has no process to
 * scrape and `prom-client` needs `node:cluster`, so the pull model is gone. Observations
 * now go to a sink — Analytics Engine in production, nothing on a laptop — and the
 * aggregation that a `Registry` used to do in memory is done by the query instead. See
 * `sink.ts` for why that is a better fit than a port would have been.
 *
 * WHAT WAS LOST, PLAINLY
 * `collectRuntimeMetrics` is gone and cannot be replaced. It brought Node's own numbers —
 * resident memory, event-loop lag, GC, handle counts — and a Worker has none of them: there
 * is no process, no heap that outlives a request, no event loop to lag. `bench/soak.js`
 * already noted it could not observe process memory; that gap is now permanent rather than
 * unimplemented. What replaces it in kind is Workers Logs and the CPU-time figures
 * Cloudflare reports per invocation, neither of which is a `morph_*` metric.
 *
 * WHY THE HELP TEXT IS LONG
 * It is what an operator reads in a metric browser at 3am, and it is the only documentation
 * that travels with the number.
 */

import { Counter, Gauge, Histogram } from './instruments';
import type { MetricDeclaration } from './sink';

export {
  installMetricSink,
  resetMetricSink,
  currentSink,
  MemorySink,
  NullSink,
  type MetricDeclaration,
  type MetricKind,
  type MetricObservation,
  type MetricSink,
} from './sink';
export {
  analyticsEngineSink,
  type AnalyticsEngineDataPointLike,
  type AnalyticsEngineLike,
} from './analytics-engine';
export { Counter, Gauge, Histogram } from './instruments';

/**
 * Every declaration, in one array.
 *
 * `declaredMetricNames()` reads this rather than a registry's contents, which makes the
 * contract check independent of whether anything was ever recorded. Under prom-client a
 * metric only appeared once constructed; a lazily-imported module could therefore have hid
 * a name from the very test meant to protect it.
 */
const DECLARATIONS: MetricDeclaration[] = [];

function declare(declaration: MetricDeclaration): MetricDeclaration {
  DECLARATIONS.push(declaration);
  return declaration;
}

// -----------------------------------------------------------------------------
// Ingest
// -----------------------------------------------------------------------------

export const ingestRequests = new Counter<'outcome'>(
  declare({
    name: 'morph_ingest_requests_total',
    kind: 'counter',
    help: 'Beacon requests accepted by the collector, by outcome. The denominator of the ingest error rate.',
    labels: ['outcome'],
  }),
);

export const ingestErrors = new Counter<'reason'>(
  declare({
    name: 'morph_ingest_errors_total',
    kind: 'counter',
    help: 'Beacon requests the collector could not accept, by reason: a malformed body, a rate limit, or a sink that refused the write.',
    labels: ['reason'],
  }),
);

export const ingestEvents = new Counter(
  declare({
    name: 'morph_ingest_events_total',
    kind: 'counter',
    help: 'Individual events accepted, which is not the same as requests: a beacon carries between one and fifty.',
    labels: [],
  }),
);

export const ingestLagMs = new Histogram(
  declare({
    name: 'morph_ingest_lag_ms',
    kind: 'histogram',
    help: 'Milliseconds between an event happening in a browser and the collector accepting it. Offline queues replay old events, so the long tail is expected and is not an error.',
    labels: [],
  }),
);

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

export const decisionDurationMs = new Histogram(
  declare({
    name: 'morph_decision_duration_ms',
    kind: 'histogram',
    help: 'Milliseconds to resolve a full eleven-surface assignment, excluding the snapshot read. The number §7 budgets at 5 ms.',
    labels: [],
  }),
);

export const snapshotAgeSeconds = new Gauge(
  declare({
    name: 'morph_snapshot_age_seconds',
    kind: 'gauge',
    help: 'Age of the posterior snapshot this renderer is serving. Climbing without bound means the adapt cycle has stopped and the site is adapting on stale conclusions.',
    labels: [],
  }),
);

// -----------------------------------------------------------------------------
// The adaptive engine
// -----------------------------------------------------------------------------

export const explorationRate = new Gauge(
  declare({
    name: 'morph_exploration_rate',
    kind: 'gauge',
    help: 'Share of impressions in the last cycle that went to a variant other than the leader. Below the exploration floor the bandit has stopped learning and will not notice the world changing.',
    labels: [],
  }),
);

export const holdoutLiftRelative = new Gauge(
  declare({
    name: 'morph_holdout_lift_relative',
    kind: 'gauge',
    help: 'Measured lift of the adaptive cohort over the pinned baseline, as a ratio. Negative means the adaptation is actively worse than doing nothing.',
    labels: [],
  }),
);

export const variantsQuarantined = new Counter(
  declare({
    name: 'morph_variants_quarantined_total',
    kind: 'counter',
    help: 'Variants removed by the health guardrail rather than by the reward statistics — a Core Web Vitals, client-error or bounce-rate breach. Which variant and why is in the adaptation log, which is the durable record; this is the rate.',
    labels: [],
  }),
);

export const variantsRetired = new Counter(
  declare({
    name: 'morph_variants_retired_total',
    kind: 'counter',
    help: 'Variants retired because the evidence settled against them, over time. The reasoning behind each one is in the adaptation log and in the hourly report.',
    labels: [],
  }),
);

export const webVitalP75 = new Gauge<'metric'>(
  declare({
    name: 'morph_web_vital_p75',
    kind: 'gauge',
    help: 'Seventy-fifth percentile of each Core Web Vital across the last cycle. The same budgets Lighthouse enforces in CI, so a variant cannot pass the gate and be quarantined for the number the gate approved.',
    labels: ['metric'],
  }),
);

export const queueWaiting = new Gauge<'queue'>(
  declare({
    name: 'morph_queue_waiting',
    kind: 'gauge',
    help: 'Messages waiting in each work queue. A backlog that grows monotonically is a consumer that has died, not a busy one.',
    labels: ['queue'],
  }),
);

export const queueFailed = new Gauge<'queue'>(
  declare({
    name: 'morph_queue_failed',
    kind: 'gauge',
    help: 'Messages in each queue that exhausted their attempts and reached the dead-letter queue. Unlike the waiting count this does not drain on its own.',
    labels: ['queue'],
  }),
);

export const adaptCycleHour = new Gauge(
  declare({
    name: 'morph_adapt_cycle_hour_seconds',
    kind: 'gauge',
    help: 'Unix time of the last hour folded into the posteriors. Compared against now, this is how far behind the adaptive loop has fallen.',
    labels: [],
  }),
);

/** Every declaration, for the dashboard and alert-rule checks. */
export function declaredMetrics(): readonly MetricDeclaration[] {
  return DECLARATIONS;
}

/** Every `morph_*` name this package defines. What `contract.test.ts` checks against. */
export function declaredMetricNames(): readonly string[] {
  return DECLARATIONS.map((d) => d.name)
    .filter((name) => name.startsWith('morph_'))
    .sort();
}
