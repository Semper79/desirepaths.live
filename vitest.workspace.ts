import { fileURLToPath } from 'node:url';
import { defineWorkspace } from 'vitest/config';

/** Vitest rejects a relative alias and says so; these have to be absolute. */
const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * One Vitest workspace for the whole monorepo, so `pnpm test` at the root is the
 * single source of truth in CI.
 *
 * Coverage is deliberately NOT configured here - Vitest ignores per-project coverage
 * blocks and collects once for the whole run. It lives in `vitest.config.ts`, where
 * the two thresholds tiers are expressed as path globs.
 */
export default defineWorkspace([
  /**
   * The workerd project is NOT here, and that is not an oversight.
   *
   * `@cloudflare/vitest-pool-workers` cannot run under `@vitest/coverage-v8`: the coverage
   * provider imports `node:inspector`, which workerd has no module for. The symptom is
   * ugly and misleading — the pool crashes, the run reports a fraction of the tests as
   * though that were all of them, and the coverage threshold fails on code that is in
   * fact covered.
   *
   * It is a documented limitation of the pool, not something to work around:
   * developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
   *
   * So `apps/api/vitest.workers.config.ts` runs on its own, through `pnpm test:workers`,
   * and `pnpm verify` runs both. This cost a CI run to discover, because `vitest run`
   * without coverage is fine and that is the command I kept using — the gate is
   * `test:coverage`, and verifying with anything else proves less than it looks.
   */
  {
    test: {
      name: 'core',
      root: './packages/core',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'cron',
      root: './apps/cron',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'cycle',
      root: './packages/cycle',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'adaptive',
      root: './packages/adaptive',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'admin',
      root: './apps/admin',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'api',
      root: './apps/api',
      environment: 'node',
      include: ['test/**/*.test.ts'],
      // `test/workers` belongs to the workerd project above. Without this exclusion both
      // projects collect it and the Node one fails on `cloudflare:test`.
      exclude: ['test/workers/**'],
      // `worker.ts` re-exports the Durable Object class, which drags `cloudflare:workers`
      // into the graph of every test that imports the handler. These tests never construct
      // a Durable Object — the env stub throws if the counters are reached — so the base
      // class only has to resolve. `test/stubs/cloudflare-workers.ts` says why that is
      // honest here and would not be in the other project.
      alias: {
        'cloudflare:workers': `${here}apps/api/test/stubs/cloudflare-workers.ts`,
      },
    },
  },
  {
    // The web tsconfig sets `jsx: preserve` because Next does the transform. Vitest does
    // not run Next, and esbuild defaults to the classic runtime — which compiles JSX to
    // `React.createElement` against a global that server components never import. Naming
    // the automatic runtime here keeps the workaround in the test config, rather than
    // adding a React import to every component to satisfy a tool that is not the one
    // building the app.
    esbuild: { jsx: 'automatic' },
    test: {
      name: 'web',
      root: './apps/web',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'worker',
      root: './apps/worker',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'crawler',
      root: './packages/crawler',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'seo',
      root: './packages/seo',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'ui',
      root: './packages/ui',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'metrics',
      root: './packages/metrics',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'social',
      root: './packages/social',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'telegram',
      root: './packages/telegram',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
]);
