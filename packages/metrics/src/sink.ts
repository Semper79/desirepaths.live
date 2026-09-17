/**
 * Where a metric observation goes.
 *
 * The package used to be prom-client and a `Registry`, which meant the numbers lived in
 * process memory until Prometheus scraped them. A Worker has no process to scrape and
 * `prom-client` needs `node:cluster`, so the pull model is gone entirely (D31).
 *
 * WHAT REPLACES IT, AND WHY IT IS NOT A PORT
 * Analytics Engine does not hold counters. You do not increment
 * `morph_ingest_requests_total{outcome="accepted"}`; you write a row carrying the outcome
 * and let `SUM(_sample_interval) ... GROUP BY` produce the counter at query time. So an
 * observation here is not a mutation of stored state — it is a fact with dimensions, and
 * aggregation is the reader's job.
 *
 * That is why the instruments keep prom-client's `inc` / `set` / `observe` signatures while
 * meaning something different underneath. The call sites were already writing facts; only
 * the storage believed it was keeping a running total.
 *
 * THE LINE FROM D33, RESTATED HERE BECAUSE THIS IS WHERE IT WOULD BE CROSSED
 * Analytics Engine samples. Everything that arrives through this interface is therefore an
 * estimate, and none of it may ever be read back into a posterior, a reward, or any number
 * the adaptive engine reasons from. Those come from Durable Objects and are exact. A metric
 * is for a human looking at a dashboard during an incident; it is not evidence.
 */

/** The three shapes a metric can take. Kept from Prometheus because operators know them. */
export type MetricKind = 'counter' | 'gauge' | 'histogram';

/**
 * A metric's identity, as data.
 *
 * Pure, so `declaredMetricNames()` can be checked against the alert rules and the
 * dashboards without constructing anything or touching a binding.
 */
export interface MetricDeclaration {
  readonly name: string;
  readonly kind: MetricKind;
  /**
   * What an operator reads in the metric browser at 3am. The only documentation that
   * travels with the number, which is why it is a sentence rather than a label.
   */
  readonly help: string;
  /**
   * Label names, **in order**. The order is a contract: a sink that flattens an
   * observation into positional columns writes `labels[0]` first, and a query that reads
   * the third column back has to know it means `outcome`. Reordering this list silently
   * changes what every stored row means, so it is append-only in practice.
   */
  readonly labels: readonly string[];
}

/** One recorded fact. */
export interface MetricObservation {
  readonly declaration: MetricDeclaration;
  /** Label values positionally aligned to `declaration.labels`; `''` where unset. */
  readonly labelValues: readonly string[];
  readonly value: number;
}

export interface MetricSink {
  record(observation: MetricObservation): void;
}

/**
 * Drops everything, and counts what it dropped.
 *
 * The default, because a laptop has no Analytics Engine binding and a developer should not
 * have to configure telemetry to run the site. Counting rather than ignoring is the whole
 * difference between a quiet default and a silent failure: a deployment that forgot to
 * install a sink looks exactly like a healthy one from the outside, and this is what lets
 * `/api/ready` say so.
 */
export class NullSink implements MetricSink {
  private dropped = 0;

  record(): void {
    this.dropped += 1;
  }

  droppedObservations(): number {
    return this.dropped;
  }
}

/** Keeps observations in memory. For tests, and for nothing else. */
export class MemorySink implements MetricSink {
  private readonly observations: MetricObservation[] = [];

  record(observation: MetricObservation): void {
    this.observations.push(observation);
  }

  recorded(): readonly MetricObservation[] {
    return this.observations;
  }

  /** Every observation of one metric, which is what most assertions actually want. */
  recordedFor(name: string): readonly MetricObservation[] {
    return this.observations.filter((o) => o.declaration.name === name);
  }

  clear(): void {
    this.observations.length = 0;
  }
}

let active: MetricSink = new NullSink();

/**
 * Install the sink every observation goes to.
 *
 * On Workers this is called at the top of the request handler with the dataset from `env`,
 * and calling it on every request is intended rather than wasteful — it is the only moment
 * the binding is in hand.
 *
 * WHY MODULE-LEVEL STATE IS SAFE HERE AND IS NOT SAFE IN `bindings.ts`
 * `bindings.ts` refuses to memoise the Cloudflare context because that object carries
 * request-scoped things — `ctx`, the request itself — and holding one across requests leaks
 * one visitor's context into another's. An Analytics Engine binding carries none of that.
 * It is a property of the deployment, identical for every request the isolate serves, so
 * re-installing it is idempotent and sharing it is not a leak. The distinction is the
 * lifetime of what is being cached, not the fact of caching.
 */
export function installMetricSink(sink: MetricSink): void {
  active = sink;
}

export function currentSink(): MetricSink {
  return active;
}

/** Test seam, and the way a Worker returns to dropping on purpose. */
export function resetMetricSink(): void {
  active = new NullSink();
}
