/**
 * @morph/adaptive - the bandit engine.
 *
 * Rules for this package, enforced by review and by `package.json` having an empty
 * `dependencies` block:
 *
 *   - No I/O. No database client, no HTTP, no filesystem, no clock. Every input
 *     arrives as an argument and every output is a return value.
 *   - No `Date.now()`. Time is a parameter. A function that reads the clock cannot
 *     be tested at a chosen moment, and the novelty-decay window depends on exactly
 *     that.
 *   - No `Math.random()`. See src/rng.ts.
 *   - 100% branch coverage, enforced in vitest.workspace.ts. Not aspirational.
 *
 * The purity is not aesthetic. It is what makes the decision path fast enough to run
 * inside edge middleware, and it is what makes the statistical claims in
 * docs/BENCHMARKS.md testable rather than asserted.
 */

export * from './rng.js';
export * from './beta.js';
export * from './reward.js';
export * from './msprt.js';
export * from './thompson.js';
export * from './linucb.js';
export * from './guardrails.js';
export * from './assign.js';
export { simulate, STANDARD_WORLD } from './sim/index.js';
export type { SimulationResult, SimulationSpec, VariantTruth } from './sim/index.js';
