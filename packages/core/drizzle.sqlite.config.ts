/**
 * Migration generation for D1 (D31).
 *
 * Named for its dialect rather than left as `drizzle.config.ts`, because the Postgres
 * schema is still in the tree and a single ambiguous config is how the wrong dialect gets
 * generated against the wrong file. When `schema.ts` goes, this becomes `drizzle.config.ts`
 * and the suffix goes with it.
 *
 * `dialect: 'sqlite'` and not `driver: 'd1-http'`: this config only ever generates SQL.
 * Applying it is `wrangler d1 migrations apply`, which reads the same directory and keeps
 * the applied-migrations bookkeeping inside D1 itself — so there is exactly one component
 * that knows what has run, rather than drizzle-kit and wrangler each holding an opinion.
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/sqlite.ts',
  out: '../../infra/d1/migrations',
  strict: true,
  verbose: true,
});
