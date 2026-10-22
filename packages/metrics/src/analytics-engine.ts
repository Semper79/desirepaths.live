/**
 * The Workers sink: one Analytics Engine data point per observation.
 *
 * THE ROW SHAPE, WHICH IS A CONTRACT
 *
 *   index1   metric name
 *   blob1    metric name
 *   blob2    service — 'web' | 'api' | 'worker'
 *   blob3..  label values, positionally aligned to `declaration.labels`
 *   double1  the value
 *
 * Every dashboard query depends on this layout, so changing it invalidates stored rows
 * rather than migrating them: Analytics Engine has no schema to alter and no way to
 * rewrite what is already written. Appending a column is safe. Reordering is not, and
 * neither is reusing a position for a different meaning — the old rows keep their old
 * meaning for three months and the two are indistinguishable in a query.
 *
 * WHY THE METRIC NAME IS THE INDEX
 * The index is the sampling key: Analytics Engine samples per index value, so only the
 * indexes receiving large volumes get sampled at all. Keying on the metric name means
 * `morph_ingest_requests_total` — millions a day — is sampled while
 * `morph_holdout_lift_relative` — one value an hour — is kept whole. Keying on the service
 * instead would have let the ingest firehose drag the engine's own rare, precious numbers
 * down to its sampling rate, which is the opposite of what anyone would want.
 *
 * The name is duplicated into blob1 on purpose. Grouping by an index in the SQL API is
 * possible but the blob is what the rest of the query already reads, and a row that
 * carries its own identity in the same place as its dimensions is one less thing to
 * remember at 3am.
 */

import type { MetricObservation, MetricSink } from './sink';

/**
 * A blob or index cell. Cloudflare accepts binary as well as text; this package only ever
 * writes strings, but narrowing the type here would stop a real binding satisfying it.
 */
type DataPointCell = ArrayBuffer | string | null;

/**
 * One data point, mirroring `AnalyticsEngineDataPoint` field for field.
 *
 * Four details are load-bearing and every one was found by the compiler rather than guessed
 * at. The arrays are mutable, so `readonly string[]` does not fit. The cells are wider than
 * `string`. `indexes` carries a `length: 0 | 1` brand, because Analytics Engine takes at
 * most one index per point — worth knowing independently of the types, since a second index
 * is not an error, it is silently the only one that counts. And the optional fields must
 * *not* be written `?: T | undefined`: `exactOptionalPropertyTypes` makes those two
 * different types, and the binding declares the bare form.
 */
export interface AnalyticsEngineDataPointLike {
  indexes?: DataPointCell[] & { length: 0 | 1 };
  blobs?: DataPointCell[];
  doubles?: number[];
}

/**
 * The shape of an Analytics Engine binding.
 *
 * Declared structurally rather than imported from `@cloudflare/workers-types`, so this
 * package stays dependency-free and testable under plain Node. A fake in a test is an
 * object with one method; a real binding satisfies the same shape.
 */
export interface AnalyticsEngineLike {
  writeDataPoint(event?: AnalyticsEngineDataPointLike): void;
}

/**
 * Analytics Engine accepts at most 20 blobs.
 *
 * Two are spent on the name and the service, so a metric could carry eighteen labels. The
 * declarations use at most one, and the cap exists so that a future metric with an
 * unreasonable label set is truncated rather than rejected — a dropped data point loses
 * the observation entirely, a truncated one still records that it happened.
 */
const MAX_BLOBS = 20;

export function analyticsEngineSink(dataset: AnalyticsEngineLike, service: string): MetricSink {
  return {
    record(observation: MetricObservation): void {
      const { declaration, labelValues, value } = observation;

      const blobs: DataPointCell[] = [declaration.name, service, ...labelValues].slice(
        0,
        MAX_BLOBS,
      );
      // Typed as a one-tuple so it satisfies the `length: 0 | 1` brand without a cast.
      const indexes: [string] = [declaration.name];

      try {
        dataset.writeDataPoint({ indexes, blobs, doubles: [value] });
      } catch {
        // Swallowed, and this is one of the few places that is right. `writeDataPoint` is
        // fire-and-forget by design, but it can still throw synchronously on a malformed
        // point or a per-invocation limit. Letting that propagate would turn a telemetry
        // problem into a failed response — the page would 500 because the monitoring
        // broke, which inverts what monitoring is for.
      }
    },
  };
}
