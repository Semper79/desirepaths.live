/**
 * Generate `infra/d1/seed.sql` from the registry and the seed articles.
 *
 * Writes the file and stops. Applying it is a separate, deliberate command:
 *
 *   wrangler d1 execute morph --local  --file=infra/d1/seed.sql
 *   wrangler d1 execute morph --remote --file=infra/d1/seed.sql
 *
 * The split is the point. A script that generated and applied in one step would be one typo
 * away from seeding production, and the generated SQL is worth reading before it runs — it
 * is the variant pool the engine will spend weeks comparing.
 *
 * The file is committed, so a deploy does not need this script and a reviewer can see what
 * changed when a variant is added to the registry.
 *
 * TypeScript, run through `tsx`, because `packages/core` exports source rather than build
 * output — that is the internal-source package pattern the whole monorepo uses, and there is
 * no `dist` for a plain `.mjs` to import from.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedSql, type SeedArticle } from '@morph/core';
import { SEED_CONTENT } from '../apps/web/src/lib/content';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A fixed timestamp, not `Date.now()`.
 *
 * The generated file is committed, so a clock-derived value would make every regeneration a
 * diff even when nothing changed — and a diff that is only a timestamp trains people to stop
 * reading the ones that are not.
 */
const SEEDED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);

const articles: readonly SeedArticle[] = SEED_CONTENT.map((article) => ({
  slug: article.slug,
  kind: 'article',
  title: article.title,
  summary: article.summary,
  body: article.body,
  sources: article.sources.map((source) => ({ ...source })),
  // `publishedAt` is an ISO string in the fixtures and epoch milliseconds in the column.
  publishedAt: Date.parse(article.publishedAt),
}));

const out = join(root, 'infra', 'd1', 'seed.sql');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, seedSql(articles, SEEDED_AT), 'utf8');

process.stdout.write(`Wrote ${out}\n\nApply it with:\n`);
process.stdout.write('  wrangler d1 execute morph --local  --file=infra/d1/seed.sql\n');
process.stdout.write('  wrangler d1 execute morph --remote --file=infra/d1/seed.sql\n');
