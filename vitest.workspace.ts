import { defineWorkspace } from 'vitest/config';

/**
 * One Vitest workspace for the whole monorepo, so `pnpm test` at the root is the
 * single source of truth in CI.
 *
 * Coverage is deliberately NOT configured here - Vitest ignores per-project coverage
 * blocks and collects once for the whole run. It lives in `vitest.config.ts`, where
 * the two thresholds tiers are expressed as path globs.
 */
export default defineWorkspace([
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
      name: 'api',
      root: './apps/api',
      environment: 'node',
      include: ['test/**/*.test.ts'],
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
