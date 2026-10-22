/**
 * The dashboards must point at metrics that exist.
 *
 * A panel whose query references a metric nothing emits is not an error anywhere. Grafana
 * draws an empty rectangle, which is exactly what a healthy idle system looks like — so
 * the failure is discovered during the incident the panel was built for, by someone who
 * now has one fewer source of truth than they thought.
 *
 * This reads the dashboard JSON off disk and checks every expression against the registry,
 * the same way `contract.test.ts` checks the alert rules. Between the two, every consumer
 * of a `morph_*` name is verified against its producer.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredMetricNames } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(
  here,
  '..',
  '..',
  '..',
  'infra',
  'grafana',
  'provisioning',
  'dashboards',
  'json',
);

interface Target {
  readonly expr?: unknown;
}

interface Panel {
  readonly type?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly targets?: readonly Target[];
}

interface Dashboard {
  readonly uid?: unknown;
  readonly title?: unknown;
  readonly panels?: readonly Panel[];
}

function dashboards(): readonly { file: string; dashboard: Dashboard }[] {
  return readdirSync(dashboardDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      file,
      dashboard: JSON.parse(readFileSync(join(dashboardDir, file), 'utf8')) as Dashboard,
    }));
}

function expressionsOf(dashboard: Dashboard): readonly string[] {
  const found: string[] = [];

  for (const panel of dashboard.panels ?? []) {
    for (const target of panel.targets ?? []) {
      if (typeof target.expr === 'string') found.push(target.expr);
    }
  }

  return found;
}

/** Base names, with PromQL's histogram and counter suffixes stripped. */
function metricsIn(expression: string): readonly string[] {
  return [...expression.matchAll(/morph_[a-z0-9_]+/g)].map((match) =>
    match[0].replace(/_(bucket|sum|count)$/, ''),
  );
}

describe('the provisioned dashboards', () => {
  const all = dashboards();

  it('exist at all', () => {
    // The provisioning file has pointed at this directory since Phase 0. An empty one is
    // a Grafana with a MORPH folder and nothing in it.
    expect(all.length).toBeGreaterThan(0);
  });

  it('only query metrics something emits', () => {
    const declared = new Set(declaredMetricNames());
    for (const name of declaredMetricNames()) declared.add(`${name}_total`);

    const missing: string[] = [];
    for (const { file, dashboard } of all) {
      for (const expression of expressionsOf(dashboard)) {
        for (const metric of metricsIn(expression)) {
          if (!declared.has(metric)) missing.push(`${file}: ${metric}`);
        }
      }
    }

    expect(missing, `dashboards query metrics nothing emits:\n${missing.join('\n')}`).toEqual([]);
  });

  it('query something, so the check above is not vacuous', () => {
    const total = all.flatMap(({ dashboard }) => expressionsOf(dashboard)).length;

    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('give every panel a description', () => {
    // Grafana shows it on hover, and it is the only documentation that reaches the person
    // reading the panel at 3am. A title alone says what the line is; the description is
    // where "and here is what it means when it moves" lives.
    const undocumented: string[] = [];

    for (const { file, dashboard } of all) {
      for (const panel of dashboard.panels ?? []) {
        const description = typeof panel.description === 'string' ? panel.description : '';
        if (description.length < 40) {
          undocumented.push(`${file}: ${String(panel.title)}`);
        }
      }
    }

    expect(
      undocumented,
      `panels without a usable description:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });

  it('have a stable uid, so a link to a panel survives a redeploy', () => {
    for (const { file, dashboard } of all) {
      expect(typeof dashboard.uid, file).toBe('string');
      expect(String(dashboard.uid).length, file).toBeGreaterThan(0);
    }
  });
});
