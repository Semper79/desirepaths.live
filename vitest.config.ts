import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Coverage lives here rather than per project because Vitest collects coverage once,
 * for the whole workspace run - a `coverage` block inside a workspace project is
 * silently ignored, which is a very easy way to believe you have a 100% branch gate
 * and actually have nothing at all. Thresholds are therefore expressed as globs.
 *
 * The two tiers come straight from section 7 of the specification: 100% branch coverage in
 * `packages/adaptive`, 80% elsewhere.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'packages/*/src/**/*.ts',
        'apps/api/src/**/*.ts',
        'apps/web/src/lib/**/*.ts',
        'apps/admin/src/lib/**/*.ts',
        'apps/worker/src/**/*.ts',
      ],
      exclude: [
        // Covered by the workerd suite, which cannot report coverage (see
        // vitest.workspace.ts). Excluding them is honest only because `pnpm verify` runs
        // that suite: 24 cases over real SQLite, real alarms and real request
        // serialisation, which is stronger evidence than a line count would be. If the
        // workers run ever leaves the gate, these come back in and the threshold tells
        // the truth again.
        'apps/api/src/counters.ts',
        'apps/api/src/session.ts',
        // Re-export barrels: no logic, and covering them measures nothing.
        '**/src/index.ts',
        '**/src/surfaces/index.ts',
        // Type-only modules compile to nothing.
        '**/src/types.ts',
        // The convergence harness is test infrastructure, exercised by sim.test.ts.
        // Measuring its own coverage would be measuring the ruler.
        'packages/adaptive/src/sim/**',
        // Developer entry points, run by hand and by `pnpm report:sample`.
        '**/src/*-cli.ts',
        'packages/telegram/src/sample.ts',
        // Declarative Drizzle table definitions. There is no behaviour to cover;
        // the schema is verified by the migration test against a real database.
        'packages/core/src/db/**',
        // Process entry point: boot ordering and signal handling, exercised by running
        // the service rather than by a unit test that would only assert its own mock.
        'apps/api/src/index.ts',
        // Thin adapter over kafkajs. MemorySink implements the same interface and is
        // what the route tests actually run against; covering this file would be
        // covering kafkajs.
        'apps/api/src/lib/producer.ts',
        // Worker composition root: builds every adapter, registers the schedules, wires
        // the signal handlers. Testing it would be testing BullMQ.
        'apps/worker/src/index.ts',
        // Thin query adapters. Each method is one statement with no branch, and they
        // need a live Postgres with pgvector to run at all; the jobs above them are
        // covered against in-memory fakes that implement the same ports.
        'apps/worker/src/adapters/postgres.ts',
        // The one call into the Anthropic API. The prompt and the schema agreement are
        // covered by generator-adapter.test.ts; the request itself would be covering
        // the SDK.
        'apps/worker/src/adapters/anthropic-generator.ts',
        // The report's prose pass. The prompt is covered by telegram.test.ts and the
        // verification that makes the pass safe is covered in @morph/telegram; the request
        // itself would be covering the SDK.
        'apps/worker/src/adapters/anthropic-prose.ts',
        // The web app's one database query. The row mapping and the seed it falls back to
        // live in content.ts and are covered; what is left needs a live Postgres.
        'apps/web/src/lib/db.ts',
        // The console's Redis read: a client, a GET and a fallback. What is worth testing
        // is the parse, and `parseSnapshot` is covered directly.
        'apps/admin/src/lib/snapshot.ts',
        // The report's reads. Same reasoning as postgres.ts: each is a query and a shape
        // conversion with no branch, needing a live store to run at all, and every number
        // derived from what they return is covered in lib/report-derive.ts.
        'apps/worker/src/adapters/postgres-report.ts',
        'apps/worker/src/adapters/clickhouse-metrics.ts',
        // The adaptive loop's I/O. Same reasoning again: three queries and a
        // transaction, needing a live ClickHouse and Postgres to run at all, with every
        // decision they carry out made in lib/adapt-derive.ts, which is covered.
        'apps/worker/src/adapters/clickhouse-rewards.ts',
        'apps/worker/src/adapters/postgres-adapt.ts',
        // One SET and a JSON.stringify.
        'apps/worker/src/adapters/redis-snapshot.ts',
        // The renderer's read of that snapshot is a Redis client, a cache and a timer;
        // what is worth testing is the parse, and `parseSnapshot` is covered directly.
        'apps/web/src/lib/snapshot.ts',
      ],
      thresholds: {
        // Section 7: "100% branch coverage in packages/adaptive (including a statistical
        // simulation harness proving the bandit converges on a known-truth synthetic
        // dataset), >= 80% elsewhere."
        'packages/adaptive/src/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
