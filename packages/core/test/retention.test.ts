/**
 * Every table has a retention decision, and the migration is what decides which tables exist.
 *
 * This is the test that replaces what Postgres's partitioning used to guarantee. Retention
 * was declarative there — a month was a partition and dropping it was a DETACH, so the
 * obligation sat in the schema and could not be forgotten. On D1 it is a cron, and the thing
 * a cron cannot do is notice a table nobody told it about.
 *
 * So the policy is read against the generated migration rather than against a list kept
 * here. Adding a table to `sqlite.ts` and regenerating now fails this test until somebody
 * decides how long its rows live — at the moment they are thinking about the table, which is
 * the only moment the decision is cheap.
 *
 * `posterior_snapshot` is why this exists. It had no retention rule in either schema, and on
 * D1's 10 GB cap that is a wall rather than a disk-space line item.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_COLUMN, RETENTION_DAYS, retentionTasks } from '../src/db/retention.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'infra', 'd1', 'migrations');

/** Table names, read from the migration that actually creates them. */
function tablesInMigration(): readonly string[] {
  const found = new Set<string>();

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? `([a-z_]+)`/g)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
  }

  return [...found].sort();
}

describe('the retention policy', () => {
  it('finds the tables it is checking against', () => {
    // Guards the guard. A migration directory this could not parse would make every
    // assertion below pass over an empty set.
    expect(tablesInMigration().length).toBeGreaterThanOrEqual(7);
  });

  it('covers every table the migration creates', () => {
    const undecided = tablesInMigration().filter((table) => !(table in RETENTION_DAYS));

    expect(
      undecided,
      `tables with no retention decision: ${undecided.join(', ')}. Add them to RETENTION_DAYS — ` +
        `null is a valid answer, an absent entry is not.`,
    ).toEqual([]);
  });

  it('decides nothing about tables that do not exist', () => {
    // The other direction. A policy entry for a table that was renamed or dropped is a
    // delete the cron will run against nothing, which succeeds and means nothing.
    const tables = new Set(tablesInMigration());
    const orphaned = Object.keys(RETENTION_DAYS).filter((table) => !tables.has(table));

    expect(orphaned, `policy entries with no table: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('gives every finite retention a column to measure against', () => {
    for (const [table, days] of Object.entries(RETENTION_DAYS)) {
      if (days === null) continue;
      expect(RETENTION_COLUMN[table], `${table} needs a timestamp column`).toBeTypeOf('string');
    }
  });

  it('keeps posterior_snapshot bounded, which is the gap this was written for', () => {
    expect(RETENTION_DAYS['posterior_snapshot']).toBe(90);
  });

  it('keeps the decision log longer than the snapshots it explains', () => {
    // The ordering matters: a decision has to stay explainable after the surrounding
    // context has aged out, which is why `adaptation_log` stores its statistics verbatim.
    const log = RETENTION_DAYS['adaptation_log'];
    const snapshots = RETENTION_DAYS['posterior_snapshot'];

    expect(log).not.toBeNull();
    expect(snapshots).not.toBeNull();
    expect(log as number).toBeGreaterThan(snapshots as number);
  });
});

describe('retentionTasks', () => {
  const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

  it('returns one task per finite policy', () => {
    const tasks = retentionTasks(NOW);
    const finite = Object.values(RETENTION_DAYS).filter((d) => d !== null).length;

    expect(tasks).toHaveLength(finite);
  });

  it('computes the cutoff from the clock it is given', () => {
    // Pure and parameterised so a replay of yesterday's run produces yesterday's cutoffs.
    // A function reading `Date.now()` internally would make a retried job delete a day more
    // than the one it was retrying.
    const snapshots = retentionTasks(NOW).find((t) => t.table === 'posterior_snapshot');

    expect(snapshots?.cutoff).toBe(NOW - 90 * 86_400_000);
    expect(snapshots?.column).toBe('taken_at');
  });

  it('omits the tables kept permanently', () => {
    const tables = retentionTasks(NOW).map((t) => t.table);

    expect(tables).not.toContain('data_subject_request');
    expect(tables).not.toContain('consent_record');
  });
});
