/**
 * The generated D1 migration, executed against a real SQLite engine.
 *
 * WHY THIS TEST EXISTS
 * The Postgres schema enforced its domains with `pgEnum` and its invariants with CHECK.
 * The D1 port (D31) keeps the CHECKs and replaces the enums with `text({ enum })`, which
 * is a TypeScript narrowing and nothing more — so every invariant that used to be the
 * database's job is now carried by a CHECK constraint that must actually be emitted,
 * actually be valid SQLite, and actually reject the row.
 *
 * Typechecking proves none of that. `drizzle-kit generate` succeeding proves none of it
 * either: it will happily emit a constraint referring to a function SQLite does not have,
 * and the failure would surface on the first write to a live D1 database. So this test
 * runs the migration through `node:sqlite` and then tries to insert the rows the schema
 * is supposed to refuse.
 *
 * `json_array_length` is the specific worry. The Postgres original used
 * `jsonb_array_length`; the replacement comes from SQLite's JSON1 extension, which is
 * compiled in by default in both `node:sqlite` and D1, but "by default" is not the same
 * as "verified here".
 *
 * Reading the migration off disk rather than importing the schema is deliberate: what
 * ships to D1 is the .sql file, so the .sql file is what gets tested. A drift between the
 * Drizzle definition and the generated migration is precisely the bug this would catch.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `node:sqlite` is loaded through `createRequire` rather than imported.
 *
 * It is a prefix-only builtin and is absent from the module list Vite 5 resolves against,
 * so a static import is rewritten to a bare `sqlite` specifier and fails to resolve before
 * the test can even collect. Going through `createRequire` defers the lookup to Node,
 * where the module exists. Delete this the day Vite knows about it.
 */
const nodeRequire = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: readonly unknown[]): unknown;
  get(): unknown;
  all(): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'infra', 'd1', 'migrations');

/**
 * Drizzle separates statements with its own marker rather than with `;`, because a
 * statement can legitimately contain one inside a string literal.
 */
const STATEMENT_BREAK = '--> statement-breakpoint';

function migrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function freshDatabase(): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split(STATEMENT_BREAK)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) db.exec(trimmed);
    }
  }
  return db;
}

/** A content row that satisfies every constraint, for tests that vary one field. */
function validContent(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    slug: `slug-${Math.random().toString(36).slice(2)}`,
    kind: 'article',
    title: 'A title',
    body: JSON.stringify({ blocks: [] }),
    status: 'draft',
    sources: JSON.stringify([{ url: 'https://example.org', title: 'T', publisher: 'P' }]),
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function insertContent(db: SqliteDatabase, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO content (${columns.join(', ')}) VALUES (${placeholders})`).run(
    ...(Object.values(row) as never[]),
  );
}

describe('the D1 migration', () => {
  it('has been generated', () => {
    // A zero-length migration set would make every assertion below pass vacuously: an
    // empty database rejects every insert, for the wrong reason.
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it('applies to an empty SQLite database', () => {
    const db = freshDatabase();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as ReadonlyArray<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      'adaptation_log',
      'consent_record',
      'content',
      'data_subject_request',
      'engine_config',
      'posterior_snapshot',
      'variant',
    ]);
  });
});

describe('content invariants survive the port', () => {
  it('accepts a well-formed draft', () => {
    const db = freshDatabase();
    expect(() => {
      insertContent(db, validContent());
    }).not.toThrow();
  });

  it('refuses a status outside the enumerated domain', () => {
    // This is the one `pgEnum` used to guarantee for free. If the CHECK were missing,
    // SQLite would store 'banana' and the TypeScript type would be a comforting lie.
    const db = freshDatabase();
    expect(() => {
      insertContent(db, validContent({ status: 'banana' }));
    }).toThrow(/CHECK constraint failed/i);
  });

  it('refuses a published row with no sources', () => {
    // The `json_array_length` check. §3: a generated piece with no attribution does not
    // get published.
    const db = freshDatabase();
    expect(() => {
      insertContent(
        db,
        validContent({ status: 'published', sources: '[]', published_at: Date.now() }),
      );
    }).toThrow(/CHECK constraint failed/i);
  });

  it('allows a draft with no sources, because attribution is required only to publish', () => {
    const db = freshDatabase();
    expect(() => {
      insertContent(db, validContent({ status: 'draft', sources: '[]' }));
    }).not.toThrow();
  });

  it('refuses publishing generated content that nobody reviewed', () => {
    const db = freshDatabase();
    expect(() => {
      insertContent(
        db,
        validContent({ status: 'published', generated_by: 'claude-opus-5', reviewed_at: null }),
      );
    }).toThrow(/CHECK constraint failed/i);
  });

  it('allows publishing generated content once it has been reviewed', () => {
    const db = freshDatabase();
    expect(() => {
      insertContent(
        db,
        validContent({
          status: 'published',
          generated_by: 'claude-opus-5',
          reviewed_by: 'operator',
          reviewed_at: Date.now(),
          published_at: Date.now(),
        }),
      );
    }).not.toThrow();
  });

  it('refuses two rows with the same slug', () => {
    const db = freshDatabase();
    insertContent(db, validContent({ slug: 'same' }));
    expect(() => {
      insertContent(db, validContent({ slug: 'same' }));
    }).toThrow(/UNIQUE constraint failed/i);
  });
});

describe('variant invariants survive the port', () => {
  function validVariant(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
      id: `hero.headline#${Math.random().toString(36).slice(2)}`,
      surface_id: 'hero.headline',
      label: 'A headline',
      payload: JSON.stringify({ text: 'hello' }),
      status: 'active',
      origin: 'authored',
      prior_alpha: 1,
      prior_beta: 1,
      impressions: 0,
      conversions: 0,
      created_at: Date.now(),
      ...overrides,
    };
  }

  function insertVariant(db: SqliteDatabase, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    db.prepare(`INSERT INTO variant (${columns.join(', ')}) VALUES (${placeholders})`).run(
      ...(Object.values(row) as never[]),
    );
  }

  it('refuses a non-positive prior', () => {
    // A Beta(0, n) is not a distribution, and the engine would produce NaN rather than
    // an error the moment it sampled from one.
    const db = freshDatabase();
    expect(() => {
      insertVariant(db, validVariant({ prior_alpha: 0 }));
    }).toThrow(/CHECK constraint failed/i);
  });

  it('refuses more conversions than impressions', () => {
    const db = freshDatabase();
    expect(() => {
      insertVariant(db, validVariant({ impressions: 10, conversions: 11 }));
    }).toThrow(/CHECK constraint failed/i);
  });

  it('refuses an origin outside the enumerated domain', () => {
    const db = freshDatabase();
    expect(() => {
      insertVariant(db, validVariant({ origin: 'imagined' }));
    }).toThrow(/CHECK constraint failed/i);
  });
});

describe('adaptation_log invariants survive the port', () => {
  it('refuses an action outside the enumerated domain', () => {
    const db = freshDatabase();
    expect(() => {
      db.prepare(
        `INSERT INTO adaptation_log (id, occurred_at, action, reason, stats, reward_version, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), Date.now(), 'deleted_everything', 'because', '{}', 1, 'engine');
    }).toThrow(/CHECK constraint failed/i);
  });

  it('accepts every action the engine can actually take', () => {
    const db = freshDatabase();
    const actions = [
      'generated',
      'promoted',
      'retired',
      'quarantined',
      'released',
      'pinned',
      'unpinned',
      'rolled_back',
      'config_changed',
      'paused',
      'resumed',
    ];

    for (const action of actions) {
      expect(() => {
        db.prepare(
          `INSERT INTO adaptation_log (id, occurred_at, action, reason, stats, reward_version, actor)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), Date.now(), action, 'because', '{}', 1, 'engine');
      }, action).not.toThrow();
    }

    const stored = db.prepare(`SELECT COUNT(*) AS n FROM adaptation_log`).get() as { n: number };
    expect(stored.n).toBe(actions.length);
  });
});

describe('consent_record invariants survive the port', () => {
  it('refuses a record that identifies nobody', () => {
    // Consent attached to neither a user nor an anonymous hash is a row that can never be
    // honoured or withdrawn, which is worse than no record at all.
    const db = freshDatabase();
    expect(() => {
      db.prepare(
        `INSERT INTO consent_record (id, mask, source, policy_version, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), 1, 'banner', 'v1', Date.now());
    }).toThrow(/CHECK constraint failed/i);
  });

  it('accepts a record keyed on an anonymous hash alone', () => {
    const db = freshDatabase();
    expect(() => {
      db.prepare(
        `INSERT INTO consent_record (id, anon_id_hash, mask, source, policy_version, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), 'a'.repeat(32), 1, 'banner', 'v1', Date.now());
    }).not.toThrow();
  });
});
