/**
 * The adaptive cycle: read a settled hour's evidence, fold it into the posteriors, decide
 * what to retire, publish the decision set.
 *
 * Written entirely against the ports in `ports.ts` and against `@morph/adaptive`, which has
 * no I/O of its own. So this package has no idea whether its numbers come from ClickHouse and
 * Postgres or from Durable Objects, Analytics Engine, D1 and KV — which is what let the
 * storage change underneath it (D31) without the cycle changing at all.
 */

export * from './ports';
export * from './derive';
export * from './adapt';
