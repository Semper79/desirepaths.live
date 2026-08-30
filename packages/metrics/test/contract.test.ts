/**
 * The alert rules and the registry must agree.
 *
 * This is the test the whole package exists for. `infra/prometheus/rules/morph.yml` has
 * alerted on nine `morph_*` names since Phase 0, and until now no service emitted a single
 * one of them — so every rule evaluated against nothing and was therefore permanently
 * not-firing. Nobody noticed, because a not-firing alert and a healthy system look
 * identical from the outside.
 *
 * Reading the rules off disk rather than restating the names here is the point. A list
 * maintained in two places drifts; a list checked against its own consumer cannot.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredMetricNames, registry, renderMetrics } from '../src/index.js';

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

  it('renders valid exposition text', async () => {
    const text = await renderMetrics();

    expect(registry.contentType).toContain('text/plain');
    // Every metric carries HELP and TYPE, which is what makes the browser in Grafana
    // usable rather than a list of opaque identifiers.
    expect(text).toContain('# HELP morph_ingest_requests_total');
    expect(text).toContain('# TYPE morph_ingest_requests_total counter');
  });

  it('gives every metric a help string worth reading', () => {
    // A help of "requests" tells a person at 3am nothing they could not guess. This is a
    // cheap proxy for "somebody wrote a sentence".
    for (const { name, help } of registry.getMetricsAsArray()) {
      if (!name.startsWith('morph_')) continue;

      expect(help.length, `${name} needs a real help string`).toBeGreaterThan(40);
      expect(help.endsWith('.'), `${name} help should be a sentence`).toBe(true);
    }
  });
});
