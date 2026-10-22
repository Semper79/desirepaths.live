/**
 * The alert rules and the declarations must agree; an observation must reach its sink.
 *
 * The first half is the test the whole package exists for. `infra/prometheus/rules/morph.yml`
 * has alerted on nine `morph_*` names since Phase 0, and for most of that time no service
 * emitted a single one — so every rule evaluated against nothing and was permanently
 * not-firing. Nobody noticed, because a not-firing alert and a healthy system look identical
 * from the outside.
 *
 * Reading the rules off disk rather than restating the names here is the point. A list
 * maintained in two places drifts; a list checked against its own consumer cannot. That
 * still holds now the rules have no evaluator: the file is a list of names and thresholds,
 * and whoever ends up evaluating it — Grafana, or a cron that reads it — needs the names to
 * be real. Losing the metric and keeping the rule is the failure either way.
 *
 * The second half is new with the sink (D31). Under prom-client a recorded value stayed in
 * a registry and `/metrics` either showed it or did not. Now it is handed to whatever sink
 * is installed and nothing returns a receipt, so "does an increment actually arrive, in the
 * shape the dashboards expect" is a question only a test can answer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemorySink,
  NullSink,
  analyticsEngineSink,
  type AnalyticsEngineDataPointLike,
  declaredMetricNames,
  declaredMetrics,
  decisionDurationMs,
  holdoutLiftRelative,
  ingestEvents,
  ingestRequests,
  installMetricSink,
  resetMetricSink,
  webVitalP75,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(here, '..', '..', '..', 'infra', 'prometheus', 'rules', 'morph.yml');

/**
 * Every `morph_*` identifier the rules mention, with PromQL's suffixes stripped.
 *
 * A histogram declared as `morph_ingest_lag_ms` is queried as `morph_ingest_lag_ms_bucket`,
 * and a counter can be queried as `_total`. Matching the base name is what makes the
 * comparison meaningful rather than a string-equality accident.
 */
function referencedMetrics(rules: string): readonly string[] {
  const found = new Set<string>();

  for (const match of rules.matchAll(/morph_[a-z0-9_]+/g)) {
    found.add(match[0].replace(/_(bucket|sum|count)$/, ''));
  }

  return [...found].sort();
}

describe('the Prometheus contract', () => {
  const rules = readFileSync(rulesPath, 'utf8');

  it('defines every metric the alert rules fire on', () => {
    const declared = new Set(declaredMetricNames());
    // Counters are declared without `_total` and exposed with it, so accept either form.
    for (const name of declaredMetricNames()) declared.add(`${name}_total`);

    const missing = referencedMetrics(rules).filter((name) => !declared.has(name));

    expect(missing, `alert rules reference metrics nothing emits: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('references at least the nine names the rules were written around', () => {
    // Guards the guard. A rules file emptied by a bad merge would make the test above
    // pass trivially, and the alert coverage would be gone with nothing to say so.
    expect(referencedMetrics(rules).length).toBeGreaterThanOrEqual(9);
  });

  it('gives every metric a help string worth reading', () => {
    // A help of "requests" tells a person at 3am nothing they could not guess. This is a
    // cheap proxy for "somebody wrote a sentence".
    for (const { name, help } of declaredMetrics()) {
      expect(help.length, `${name} needs a real help string`).toBeGreaterThan(40);
      expect(help.endsWith('.'), `${name} help should be a sentence`).toBe(true);
    }
  });

  it('declares no metric twice', () => {
    // Under prom-client a duplicate name threw at construction, which was noisy but
    // effective. Declarations are plain data now and would silently coexist, with whichever
    // one a query happened to match winning.
    const names = declaredMetrics().map((d) => d.name);
    expect(names.length).toBe(new Set(names).size);
  });
});

describe('recording an observation', () => {
  beforeEach(() => {
    resetMetricSink();
  });

  it('drops silently by default, and says how much it dropped', () => {
    // The laptop case. What must not happen is a deployment that forgot to install a sink
    // looking identical to a healthy one, which is why the null sink counts.
    const sink = new NullSink();
    installMetricSink(sink);

    ingestRequests.inc({ outcome: 'accepted' });
    ingestRequests.inc({ outcome: 'rejected' });

    expect(sink.droppedObservations()).toBe(2);
  });

  it('defaults a counter increment to one and carries an explicit value through', () => {
    const sink = new MemorySink();
    installMetricSink(sink);

    ingestEvents.inc();
    ingestEvents.inc(17);

    expect(sink.recordedFor('morph_ingest_events_total').map((o) => o.value)).toEqual([1, 17]);
  });

  it('aligns label values to the declared order, filling an omitted label with an empty string', () => {
    // The positional contract the Analytics Engine row shape depends on. A sparse encoding
    // would shift every column after the gap, and the shift would only be visible as
    // outcomes appearing in the reason column of a dashboard.
    const sink = new MemorySink();
    installMetricSink(sink);

    webVitalP75.set({ metric: 'lcp' }, 2.1);
    ingestEvents.inc(1);

    expect(sink.recordedFor('morph_web_vital_p75')[0]?.labelValues).toEqual(['lcp']);
    expect(sink.recordedFor('morph_ingest_events_total')[0]?.labelValues).toEqual([]);
  });

  it('refuses a non-finite value rather than storing it', () => {
    // One NaN turns every aggregate that touches it into NaN, and a dashboard into a
    // blank. Division by a zero denominator is the realistic way one arrives.
    const sink = new MemorySink();
    installMetricSink(sink);

    holdoutLiftRelative.set(Number.NaN);
    holdoutLiftRelative.set(Number.POSITIVE_INFINITY);
    holdoutLiftRelative.set(0.12);

    expect(sink.recordedFor('morph_holdout_lift_relative').map((o) => o.value)).toEqual([0.12]);
  });
});

describe('the Analytics Engine row shape', () => {
  /** A binding is one method, so a fake is one object. */
  function capturingDataset() {
    const points: AnalyticsEngineDataPointLike[] = [];
    return {
      points,
      writeDataPoint(event?: AnalyticsEngineDataPointLike) {
        if (event !== undefined) points.push(event);
      },
    };
  }

  beforeEach(() => {
    resetMetricSink();
  });

  it('writes name, service and labels in the documented positions', () => {
    // This layout is a contract with every dashboard query, and Analytics Engine cannot
    // rewrite what is already stored — so a reordering silently changes the meaning of
    // three months of rows. Pinned here for that reason.
    const dataset = capturingDataset();
    installMetricSink(analyticsEngineSink(dataset, 'api'));

    ingestRequests.inc({ outcome: 'rate_limited' });

    expect(dataset.points).toHaveLength(1);
    const point = dataset.points[0];
    expect(point?.blobs).toEqual(['morph_ingest_requests_total', 'api', 'rate_limited']);
    expect(point?.doubles).toEqual([1]);
  });

  it('indexes on the metric name, so a firehose cannot sample a rare metric away', () => {
    // Analytics Engine samples per index value. Keying on the service instead would let
    // the ingest volume drag morph_holdout_lift_relative — one value an hour — down to the
    // firehose's sampling rate.
    const dataset = capturingDataset();
    installMetricSink(analyticsEngineSink(dataset, 'worker'));

    holdoutLiftRelative.set(0.07);

    expect(dataset.points[0]?.indexes).toEqual(['morph_holdout_lift_relative']);
  });

  it('does not let a telemetry failure reach the response', () => {
    // A page that 500s because monitoring broke inverts what monitoring is for.
    installMetricSink(
      analyticsEngineSink(
        {
          writeDataPoint() {
            throw new Error('per-invocation limit');
          },
        },
        'web',
      ),
    );

    expect(() => {
      decisionDurationMs.observe(1.4);
    }).not.toThrow();
  });
});
