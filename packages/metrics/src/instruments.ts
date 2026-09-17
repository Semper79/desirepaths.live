/**
 * Counter, Gauge and Histogram, with prom-client's call signatures and none of its guts.
 *
 * The signatures are kept deliberately. Every call site in `apps/api`, `apps/web` and
 * `apps/worker` was already written against them, and those sites are correct: they record
 * a fact at the moment it happens. Changing the shape of the call would have meant touching
 * thirty lines that had nothing wrong with them, and every one of those diffs would have
 * been noise in the review of a port that already changes enough.
 *
 * What is gone is the state. A prom-client `Counter` holds a running total until something
 * scrapes it; these hold nothing. `inc()` writes one observation and returns. The total is
 * reconstructed by the query — see `sink.ts` for why that is the only model Analytics
 * Engine has, and why it is a better fit than it first looks.
 *
 * ONE CONSEQUENCE WORTH STATING
 * `inc()` on a dropped observation is now invisible where before it would have shown up as
 * a counter that stopped moving. `NullSink` counts drops for exactly that reason, and
 * `/api/ready` is where the count is meant to surface.
 */

import { currentSink, type MetricDeclaration } from './sink.js';

/** Labels supplied at a call site, keyed by the names the declaration lists. */
type Labels<L extends string> = Readonly<Record<L, string>>;

/**
 * Flatten a label object into the positional array the sink stores.
 *
 * A label the declaration names but the call site omits becomes `''` rather than being
 * skipped, so column three is always the third declared label. A sparse encoding would
 * make one missing value shift every column after it, and the shift would be invisible
 * until somebody read a dashboard and saw outcomes in the reason column.
 */
function flatten(
  declaration: MetricDeclaration,
  labels: Readonly<Record<string, string>>,
): string[] {
  return declaration.labels.map((name) => labels[name] ?? '');
}

/** Disambiguates `inc(5)` from `inc({ outcome: 'accepted' })`. */
function split<L extends string>(
  first: Labels<L> | number | undefined,
  second: number | undefined,
): { readonly labels: Readonly<Record<string, string>>; readonly value: number | undefined } {
  if (typeof first === 'number') return { labels: {}, value: first };
  if (first === undefined) return { labels: {}, value: second };
  return { labels: first, value: second };
}

/**
 * Not generic over the label names: the base only ever sees an already-flattened object,
 * and the type parameter belongs where it is checked — on the public `inc` / `set` /
 * `observe` signatures.
 */
abstract class Instrument {
  constructor(readonly declaration: MetricDeclaration) {}

  protected emit(labels: Readonly<Record<string, string>>, value: number): void {
    // A non-finite value would be stored and would then poison every aggregate that
    // touched it — a single NaN turns an average into NaN and a dashboard into a blank.
    // Refusing it here is cheaper than finding it in a query at 3am.
    if (!Number.isFinite(value)) return;

    currentSink().record({
      declaration: this.declaration,
      labelValues: flatten(this.declaration, labels),
      value,
    });
  }
}

export class Counter<L extends string = never> extends Instrument {
  /** `inc()`, `inc(3)`, `inc({ outcome })`, `inc({ reason }, 3)`. Defaults to 1. */
  inc(first?: Labels<L> | number, second?: number): void {
    const { labels, value } = split<L>(first, second);
    this.emit(labels, value ?? 1);
  }
}

export class Gauge<L extends string = never> extends Instrument {
  /** `set(0.42)` or `set({ metric: 'lcp' }, 0.42)`. */
  set(first: Labels<L> | number, second?: number): void {
    const { labels, value } = split<L>(first, second);
    if (value === undefined) return;
    this.emit(labels, value);
  }
}

export class Histogram<L extends string = never> extends Instrument {
  /**
   * `observe(12.5)` or `observe({ route: '/' }, 12.5)`.
   *
   * There are no buckets any more, and that is an improvement rather than a compromise.
   * Prometheus needs them because it aggregates before it stores, so a quantile is
   * interpolated from whichever boundaries were guessed at in advance. Analytics Engine
   * stores the observations, so `quantileExactWeighted(0.95, double1, _sample_interval)`
   * reads the real distribution — no interpolation, and no p99 pinned to the top bucket
   * because the buckets stopped at a minute.
   */
  observe(first: Labels<L> | number, second?: number): void {
    const { labels, value } = split<L>(first, second);
    if (value === undefined) return;
    this.emit(labels, value);
  }
}
