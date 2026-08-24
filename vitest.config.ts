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
      include: ['packages/*/src/**/*.ts'],
      exclude: [
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
