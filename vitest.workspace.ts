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
    test: {
      name: 'web',
      root: './apps/web',
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
      name: 'telegram',
      root: './packages/telegram',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
]);
