/**
 * The seed, and the generated file it produces.
 *
 * This is the data the engine spends weeks comparing, and it is applied by hand to a
 * production database — so the two things worth testing are that the registry arrives
 * intact and that the SQL is valid when a headline contains an apostrophe.
 *
 * The generated file is also checked against the generator, the same way the metrics
 * contract is checked against the alert rules: a variant added to the registry and not
 * regenerated would be a variant the engine never serves, silently.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SURFACE_LIST } from '../src/surfaces/registry.js';
import {
  contentSeedStatements,
  engineConfigSeedStatement,
  seedSql,
  sqlString,
  variantSeedStatements,
  type SeedArticle,
} from '../src/db/seed.js';

const nodeRequire = createRequire(import.meta.url);
const SEED_FILE = join(import.meta.dirname, '..', '..', '..', 'infra', 'd1', 'seed.sql');
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown; get(): unknown };
}

const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'infra', 'd1', 'migrations');

/** The schema, so the seed can be executed against something real. */
function migratedDatabase(): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(join(MIGRATIONS, '0000_rainy_george_stacy.sql'), 'utf8');

  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) db.exec(trimmed);
  }

  return db;
}

describe('sqlString', () => {
  it('doubles an embedded quote', () => {
    // The realistic case, and the one that would otherwise produce a syntax error on a
    // production database: a headline with an apostrophe in it.
    expect(sqlString("it's")).toBe("'it''s'");
  });

  it('leaves ordinary text alone', () => {
    expect(sqlString('plain')).toBe("'plain'");
  });
});

describe('the variant pool', () => {
  it('covers every variant the registry defines', () => {
    const expected = SURFACE_LIST.flatMap((s) => s.variants.length);
    const total = expected.reduce((sum, n) => sum + n, 0);

    expect(variantSeedStatements(NOW)).toHaveLength(total);
  });

  it('marks exactly one baseline per surface', () => {
    // A surface with no baseline has nothing to fall back to when every other variant is
    // retired; one with two has an ambiguous holdout. Both are unrecoverable at runtime.
    const statements = variantSeedStatements(NOW).join('\n');

    for (const surface of SURFACE_LIST) {
      const baselines = surface.variants.filter((v) => v.id === surface.baselineVariantId);
      expect(baselines, surface.id).toHaveLength(1);
      expect(statements).toContain(sqlString(surface.baselineVariantId));
    }

    const baselineCount = (statements.match(/'baseline'/g) ?? []).length;
    expect(baselineCount).toBe(SURFACE_LIST.length);
  });

  it('gives every variant a positive prior', () => {
    // `variant_prior_positive` would refuse the row, but a seed that fails halfway leaves a
    // partially populated pool — which is worse than failing at generation time.
    for (const surface of SURFACE_LIST) {
      for (const variant of surface.variants) {
        expect(variant.prior?.alpha ?? 1, `${variant.id} alpha`).toBeGreaterThan(0);
        expect(variant.prior?.beta ?? 1, `${variant.id} beta`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the content rows', () => {
  const article: SeedArticle = {
    slug: 'a-slug',
    kind: 'article',
    title: "Someone's headline",
    summary: 'A summary.',
    body: { blocks: [] },
    sources: [{ url: 'https://example.org', title: 'T', publisher: 'P' }],
    publishedAt: NOW,
  };

  it('leaves generated_by unset, because a human wrote these', () => {
    // The schema refuses to publish generated content nobody reviewed. Claiming a human
    // wrote what a model produced would be exactly the provenance lie that check exists to
    // prevent — so the column is absent rather than filled with something plausible.
    const [statement] = contentSeedStatements([article], NOW);

    expect(statement).not.toContain('generated_by');
  });

  it('escapes a title containing an apostrophe', () => {
    const [statement] = contentSeedStatements([article], NOW);

    expect(statement).toContain("'Someone''s headline'");
  });

  it('writes NULL for an absent summary rather than an empty string', () => {
    // The column is nullable and "" is a value: a summary of "" would render as an empty
    // paragraph and go into the feed as one.
    const [statement] = contentSeedStatements([{ ...article, summary: undefined }], NOW);

    expect(statement).toMatch(/,\s*NULL,/);
  });
});

describe('the generated file', () => {
  it('is applicable to a freshly migrated database', () => {
    // The whole point. Every CHECK in the schema — the enumerated domains, the positive
    // priors, the published-needs-sources rule — is enforced here rather than discovered on
    // a production database halfway through a seed.
    const db = migratedDatabase();
    const sql = readFileSync(SEED_FILE, 'utf8');

    expect(() => {
      db.exec(sql);
    }).not.toThrow();

    const variants = db.prepare('SELECT COUNT(*) AS n FROM variant').get() as { n: number };
    const content = db.prepare('SELECT COUNT(*) AS n FROM content').get() as { n: number };
    const config = db.prepare('SELECT COUNT(*) AS n FROM engine_config').get() as { n: number };

    expect(variants.n).toBeGreaterThan(0);
    expect(content.n).toBeGreaterThan(0);
    expect(config.n).toBe(1);
  });

  it('can be applied twice without changing anything', () => {
    // `INSERT OR IGNORE` throughout, because a seed may be re-applied after a time-travel
    // restore or against a partially populated database.
    const db = migratedDatabase();
    const sql = readFileSync(SEED_FILE, 'utf8');

    db.exec(sql);
    const first = db.prepare('SELECT COUNT(*) AS n FROM variant').get() as { n: number };

    db.exec(sql);
    const second = db.prepare('SELECT COUNT(*) AS n FROM variant').get() as { n: number };

    expect(second.n).toBe(first.n);
  });

  it('matches what the generator produces now', () => {
    // A variant added to the registry and not regenerated would be a variant the engine
    // never serves — and nothing else in the build would notice.
    const onDisk = readFileSync(SEED_FILE, 'utf8');
    const regenerated = seedSql([], Number(/created_at.*?(\d{13})/s.exec(onDisk)?.[1] ?? NOW));

    // Content ids are random per generation, so the comparison is on the variant pool and
    // the configuration — the two sections that must not drift.
    const variantSection = (text: string) => text.slice(0, text.indexOf('Hand-written content'));

    expect(variantSection(onDisk)).toBe(variantSection(regenerated));
  });

  it('includes the engine configuration explicitly', () => {
    // The cycle falls back to the defaults without it, which is the reason to write it: an
    // absent row means the weights in force are whatever the deployed code says, and nobody
    // can read them without reading the source.
    expect(readFileSync(SEED_FILE, 'utf8')).toContain('INSERT OR IGNORE INTO engine_config');
    expect(engineConfigSeedStatement(NOW)).toContain("'seed'");
  });
});
