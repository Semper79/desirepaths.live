/**
 * The rows a brand new D1 database needs before anything works.
 *
 * WHY THIS IS NOT A MIGRATION
 * A migration is schema and runs exactly once, tracked. A seed is data: it may be re-applied
 * after a `d1 time-travel`, it may be partially present, and re-running it must be harmless.
 * So every statement is `INSERT OR IGNORE` and the seed is applied by hand rather than by
 * the deploy — a deploy that silently re-seeded would overwrite an operator's edits to the
 * variant pool.
 *
 * WHAT GOES WRONG WITHOUT IT, WHICH IS THE WHOLE POINT
 * `activeVariants()` returns an empty list, so the adapt cycle reports `no_variants`, so no
 * snapshot is ever published, so every surface resolves to its baseline for ever. The site
 * renders correctly and reports "cold start" on the thinking bar, which is exactly what a
 * brand new site looks like — so the failure is invisible until somebody wonders why nothing
 * has changed in a fortnight.
 *
 * WHY IT IS PURE
 * It builds SQL text from the registry and returns it. No database client, no `fs`, no
 * clock it did not receive — which is what lets `test/seed.test.ts` assert the statements
 * directly, including the escaping, without standing a database up.
 *
 * ON ESCAPING, WHICH IS THE ONE RISK HERE
 * D1's `execute --file` takes plain SQL, so there is no parameter binding and every value is
 * interpolated. Everything interpolated comes from source — the surface registry and the
 * seed articles, both TypeScript literals in this repository — so none of it is untrusted.
 * `sqlString` below still doubles every quote, because "no untrusted input reaches this"
 * is a property somebody has to keep true rather than one the compiler enforces, and a
 * headline containing an apostrophe is not hypothetical.
 */

import { DEFAULT_ENGINE_CONFIG } from '../config.js';
import { SURFACE_LIST } from '../surfaces/registry.js';

/** A single-quoted SQL literal, with embedded quotes doubled. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** What `content` needs. Structurally declared so the seed does not import from an app. */
export interface SeedArticle {
  readonly slug: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly body: unknown;
  readonly sources: readonly { url: string; title: string; publisher: string }[];
  readonly publishedAt: number;
}

/**
 * The variant pool, from the hand-authored registry.
 *
 * The registry is the schema and this table is the population — the same relationship the
 * Postgres version had. A variant the registry defines but the table lacks is simply never
 * served, which is why this runs before the first cycle rather than after it.
 *
 * `origin` comes from the variant's provenance rather than being inferred: a baseline is
 * the one variant that can never be retired, and getting it wrong would either leave a
 * surface with nothing to fall back to or pin it to a variant nobody chose.
 */
export function variantSeedStatements(now: number): readonly string[] {
  const statements: string[] = [];

  for (const surface of SURFACE_LIST) {
    for (const variant of surface.variants) {
      const isBaseline = variant.id === surface.baselineVariantId;

      statements.push(
        `INSERT OR IGNORE INTO variant (
           id, surface_id, label, payload, status, origin,
           prior_alpha, prior_beta, impressions, conversions, created_at, activated_at
         ) VALUES (
           ${sqlString(variant.id)},
           ${sqlString(surface.id)},
           ${sqlString(variant.label)},
           ${sqlString(JSON.stringify(variant.payload))},
           ${sqlString(variant.status)},
           ${sqlString(isBaseline ? 'baseline' : variant.provenance.origin)},
           ${String(variant.prior?.alpha ?? 1)},
           ${String(variant.prior?.beta ?? 1)},
           0, 0, ${String(now)}, ${String(now)}
         )`,
      );
    }
  }

  return statements;
}

/**
 * The hand-written articles.
 *
 * `generated_by` is left null, which matters: the schema's own CHECK refuses to publish
 * generated content that nobody reviewed, and claiming a human wrote something a model did
 * would be exactly the provenance lie that check exists to prevent. These were written by
 * hand, so the column is honestly empty.
 */
export function contentSeedStatements(
  articles: readonly SeedArticle[],
  now: number,
): readonly string[] {
  return articles.map(
    (article) =>
      `INSERT OR IGNORE INTO content (
         id, slug, kind, title, summary, body, status, sources,
         published_at, created_at, updated_at
       ) VALUES (
         ${sqlString(crypto.randomUUID())},
         ${sqlString(article.slug)},
         ${sqlString(article.kind)},
         ${sqlString(article.title)},
         ${article.summary === undefined ? 'NULL' : sqlString(article.summary)},
         ${sqlString(JSON.stringify(article.body))},
         'published',
         ${sqlString(JSON.stringify(article.sources))},
         ${String(article.publishedAt)}, ${String(now)}, ${String(now)}
       )`,
  );
}

/**
 * The engine configuration, written explicitly rather than left to the defaults.
 *
 * The cycle falls back to `DEFAULT_ENGINE_CONFIG` when the row is absent, so this is not
 * strictly required — which is the reason to write it anyway. An absent row means the
 * reward weights in force are whatever the deployed code says, and nobody can read them
 * without reading the source. A present row makes them inspectable, and makes changing
 * them an edit rather than a deploy.
 */
export function engineConfigSeedStatement(now: number): string {
  return `INSERT OR IGNORE INTO engine_config (id, config, reward_version, updated_at, updated_by)
          VALUES (1, ${sqlString(JSON.stringify(DEFAULT_ENGINE_CONFIG))}, ${String(
            DEFAULT_ENGINE_CONFIG.rewardVersion,
          )}, ${String(now)}, 'seed')`;
}

/** Everything, as one applicable file. */
export function seedSql(articles: readonly SeedArticle[], now: number): string {
  const sections: readonly [string, readonly string[]][] = [
    ['The variant pool, from packages/core/src/surfaces/registry.ts', variantSeedStatements(now)],
    ['Hand-written content', contentSeedStatements(articles, now)],
    ['The live engine configuration', [engineConfigSeedStatement(now)]],
  ];

  const body = sections
    .map(
      ([title, statements]) =>
        `-- ${'-'.repeat(74)}\n-- ${title}\n-- ${'-'.repeat(74)}\n\n${statements
          .map((s) => `${s};`)
          .join('\n\n')}`,
    )
    .join('\n\n');

  return `-- Generated by scripts/seed-d1.mjs. Do not edit by hand.
--
-- Every statement is INSERT OR IGNORE, so applying this twice is harmless and applying it
-- to a partially seeded database fills only the gaps. It is NOT a migration: a deploy that
-- re-seeded automatically would overwrite an operator's edits to the variant pool.
--
--   wrangler d1 execute morph --remote --file=infra/d1/seed.sql
--
-- See packages/core/src/db/seed.ts for why each table is here.

${body}
`;
}
