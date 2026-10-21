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
   * `SurfaceCounters`, run inside workerd rather than on Node.
   *
   * Referenced as a path because it needs a different pool, and a pool is per-project. Its
   * own file explains why mocking the runtime would have tested the mock: the correctness
   * argument for coalescing counts in memory rests on alarm replacement and on a flush
   * landing before a read, and neither is observable without the real scheduler.
   *
   * Two things to know about it. The bundled workerd lags the compatibility date
   * `wrangler.jsonc` pins, so these tests run on a slightly older runtime than production —
   * which is how `getByName` turned out to be unavailable. And the pool's miniflare does
   * not recognise the `ratelimits` field, which it warns about and ignores; nothing in this
   * project uses the limiter.
   */
  './apps/api/vitest.workers.config.ts',
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
