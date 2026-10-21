/**
 * The Durable Object's tests, run inside workerd.
 *
 * A separate project from the rest of `apps/api` because it needs a different runtime, not
 * a different configuration. `enrich`, `classify` and the ingest handler are plain
 * functions over plain values and run fine on Node; `SurfaceCounters` is not — it needs
 * real SQLite storage, real alarm scheduling and the real single-threaded request
 * serialisation that makes its in-memory accumulation safe.
 *
 * Mocking those would have tested the mock. The alarm in particular: the whole correctness
 * argument for coalescing writes in memory rests on `setAlarm` replacing rather than
 * stacking, and on a flush landing before a read. Neither is observable without the
 * scheduler that implements them.
 *
 * It reads `wrangler.jsonc` rather than restating the bindings, so a migration or a binding
 * added there is picked up here. The same discipline as the alert-rule and rate-limit
 * checks elsewhere: the test reads the config that production reads.
 */

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    name: 'api-workers',
    include: ['test/workers/**/*.test.ts'],
    poolOptions: {
      // `wrangler` alone, with no `miniflare.durableObjects` override. The first version of
      // this file added one, which replaced the binding that `wrangler.jsonc`'s migration
      // declares — and the string form of that override creates a key-value-backed object,
      // so every test failed with "SQL is not enabled for this Durable Object class". The
      // config that production reads is the config this reads; restating any of it is how
      // the two stop matching.
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
