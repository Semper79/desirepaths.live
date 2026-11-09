import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createD1Adapter } from '../src/lib/auth/d1-adapter';

const nodeRequire = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'infra', 'd1', 'migrations');
const STATEMENT_BREAK = '--> statement-breakpoint';

function freshDb(): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split(STATEMENT_BREAK)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) db.exec(trimmed);
    }
  }
  return db;
}

const dummyMeta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

function mockD1(db: SqliteDatabase): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values.map((v) => {
            if (v instanceof Date) return v.getTime();
            if (typeof v === 'boolean') return v ? 1 : 0;
            return v ?? null;
          });
          return stmt;
        },
        all<T>() {
          const s = db.prepare(query);
          const results = s.all(...bound) as T[];
          const res: D1Result<T> = { results, success: true, meta: dummyMeta };
          return Promise.resolve(res);
        },
        run<T>() {
          const s = db.prepare(query);
          s.run(...bound);
          const res: D1Result<T> = { results: [], success: true, meta: dummyMeta };
          return Promise.resolve(res);
        },
        first<T>(colName?: string) {
          const s = db.prepare(query);
          const row = s.get(...bound) as Record<string, unknown> | undefined;
          if (!row) return Promise.resolve(null);
          if (colName) return Promise.resolve((row[colName] as T) ?? null);
          return Promise.resolve(row as T);
        },
        raw: (() => {
          const s = db.prepare(query);
          const rows = s.all(...bound) as Record<string, unknown>[];
          const mapped = rows.map((r) => Object.values(r));
          return Promise.resolve(mapped);
        }) as D1PreparedStatement['raw'],
      };
      return stmt;
    },
    async batch<T>(stmts: D1PreparedStatement[]) {
      const res: D1Result<T>[] = [];
      for (const s of stmts) {
        res.push(await s.run<T>());
      }
      return res;
    },
    exec(query: string) {
      db.exec(query);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    dump() {
      return Promise.resolve(new ArrayBuffer(0));
    },
    withSession() {
      throw new Error('withSession not implemented in mock');
    },
  };
}

describe('D1 Auth.js adapter', () => {
  it('creates and retrieves a user', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    const created = await adapter.createUser!({
      id: 'user-1',
      email: 'visitor@example.com',
      emailVerified: null,
      name: 'Visitor One',
      image: 'https://example.com/avatar.png',
    });

    expect(created.id).toBe('user-1');
    expect(created.email).toBe('visitor@example.com');
    expect(created.name).toBe('Visitor One');

    const byId = await adapter.getUser!('user-1');
    expect(byId).not.toBeNull();
    expect(byId?.email).toBe('visitor@example.com');

    const byEmail = await adapter.getUserByEmail!('visitor@example.com');
    expect(byEmail).not.toBeNull();
    expect(byEmail?.id).toBe('user-1');
  });

  it('permits creating a user without email (TikTok, Discord)', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    const created = await adapter.createUser!({
      id: 'tiktok-user',
      email: '',
      emailVerified: null,
      name: 'TikTok Visitor',
      image: null,
    });

    expect(created.id).toBe('tiktok-user');
    expect(created.email).toBe('');

    const byId = await adapter.getUser!('tiktok-user');
    expect(byId).not.toBeNull();
    expect(byId?.id).toBe('tiktok-user');
  });

  it('links an account and retrieves user by account', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    await adapter.createUser!({
      id: 'user-oauth',
      email: 'oauth@example.com',
      emailVerified: null,
      name: 'OAuth User',
      image: null,
    });

    await adapter.linkAccount!({
      userId: 'user-oauth',
      type: 'oauth',
      provider: 'google',
      providerAccountId: 'google-sub-12345',
    });

    const found = await adapter.getUserByAccount!({
      provider: 'google',
      providerAccountId: 'google-sub-12345',
    });

    expect(found).not.toBeNull();
    expect(found?.id).toBe('user-oauth');

    const notFound = await adapter.getUserByAccount!({
      provider: 'discord',
      providerAccountId: 'nonexistent',
    });
    expect(notFound).toBeNull();
  });

  it('manages database sessions correctly', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    await adapter.createUser!({
      id: 'user-sess',
      email: 'sess@example.com',
      emailVerified: null,
      name: 'Sess User',
      image: null,
    });

    const expires = new Date(Date.now() + 86400 * 1000);
    const session = await adapter.createSession!({
      sessionToken: 'token-abc',
      userId: 'user-sess',
      expires,
    });
    expect(session.sessionToken).toBe('token-abc');

    const sessionAndUser = await adapter.getSessionAndUser!('token-abc');
    expect(sessionAndUser).not.toBeNull();
    expect(sessionAndUser?.user.id).toBe('user-sess');
    expect(sessionAndUser?.session.sessionToken).toBe('token-abc');

    const newExpires = new Date(Date.now() + 172800 * 1000);
    await adapter.updateSession!({
      sessionToken: 'token-abc',
      expires: newExpires,
    });

    const updated = await adapter.getSessionAndUser!('token-abc');
    expect(updated?.session.expires.getTime()).toBe(newExpires.getTime());

    await adapter.deleteSession!('token-abc');
    const deleted = await adapter.getSessionAndUser!('token-abc');
    expect(deleted).toBeNull();
  });

  it('handles verification tokens for passwordless link', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    const expires = new Date(Date.now() + 3600 * 1000);
    await adapter.createVerificationToken!({
      identifier: 'visitor@example.com',
      token: 'magic-hash-token',
      expires,
    });

    const used = await adapter.useVerificationToken!({
      identifier: 'visitor@example.com',
      token: 'magic-hash-token',
    });

    expect(used).not.toBeNull();
    expect(used?.identifier).toBe('visitor@example.com');

    // Second use must return null (single use token)
    const secondUse = await adapter.useVerificationToken!({
      identifier: 'visitor@example.com',
      token: 'magic-hash-token',
    });
    expect(secondUse).toBeNull();
  });

  it('manages WebAuthn authenticators for passkeys', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    await adapter.createUser!({
      id: 'passkey-user',
      email: 'passkey@example.com',
      emailVerified: null,
      name: 'Passkey User',
      image: null,
    });

    await adapter.createAuthenticator!({
      userId: 'passkey-user',
      providerAccountId: 'cred-1',
      credentialID: 'cred-1',
      credentialPublicKey: 'pubkey-base64',
      counter: 0,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      transports: 'internal',
    });

    const authRecord = await adapter.getAuthenticator!('cred-1');
    expect(authRecord).not.toBeNull();
    expect(authRecord?.userId).toBe('passkey-user');
    expect(authRecord?.counter).toBe(0);

    const list = await adapter.listAuthenticatorsByUserId!('passkey-user');
    expect(list).toHaveLength(1);
    expect(list[0]?.credentialID).toBe('cred-1');

    await adapter.updateAuthenticatorCounter!('cred-1', 5);
    const updated = await adapter.getAuthenticator!('cred-1');
    expect(updated?.counter).toBe(5);
  });

  it('updates and deletes a user', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    await adapter.createUser!({
      id: 'user-update',
      email: 'initial@example.com',
      emailVerified: null,
      name: 'Initial Name',
      image: null,
    });

    const updated = await adapter.updateUser!({
      id: 'user-update',
      name: 'Updated Name',
      email: 'updated@example.com',
    });
    expect(updated.name).toBe('Updated Name');
    expect(updated.email).toBe('updated@example.com');

    await adapter.deleteUser!('user-update');
    const gone = await adapter.getUser!('user-update');
    expect(gone).toBeNull();
  });

  it('unlinks accounts and looks up account by providerAccountId', async () => {
    const raw = freshDb();
    const d1 = mockD1(raw);
    const db = drizzle(d1);
    const adapter = createD1Adapter(() => Promise.resolve(db));

    await adapter.createUser!({
      id: 'user-unlink',
      email: 'unlink@example.com',
      emailVerified: null,
      name: 'Unlink User',
      image: null,
    });

    await adapter.linkAccount!({
      userId: 'user-unlink',
      type: 'oauth',
      provider: 'github',
      providerAccountId: 'gh-123',
    });

    const acc = await adapter.getAccount!('gh-123', 'github');
    expect(acc).not.toBeNull();
    expect(acc?.userId).toBe('user-unlink');

    await adapter.unlinkAccount!({
      provider: 'github',
      providerAccountId: 'gh-123',
    });

    const accGone = await adapter.getAccount!('gh-123', 'github');
    expect(accGone).toBeNull();
  });

  it('throws an error if D1 binding is unavailable', async () => {
    const adapter = createD1Adapter(() => Promise.resolve(null));
    await expect(adapter.getUser!('any-id')).rejects.toThrow('D1 database binding is unavailable');
  });
});

describe('first_provider across the createUser / linkAccount gap', () => {
  const setup = (): {
    raw: SqliteDatabase;
    adapter: ReturnType<typeof createD1Adapter>;
  } => {
    const raw = freshDb();
    const adapter = createD1Adapter(() => Promise.resolve(drizzle(mockD1(raw))));
    return { raw, adapter };
  };
  const firstProviderOf = (raw: SqliteDatabase, id: string): unknown =>
    (
      raw.prepare(`SELECT first_provider FROM user WHERE id = ?`).get(id) as {
        first_provider: string;
      }
    ).first_provider;

  it("stores 'pending' until a provider is linked, not a provider it cannot know", async () => {
    const { raw, adapter } = setup();
    await adapter.createUser!({
      id: 'u-pending',
      email: 'p@example.com',
      emailVerified: null,
      name: null,
      image: null,
    });
    expect(firstProviderOf(raw, 'u-pending')).toBe('pending');
  });

  it('records the provider the account was opened with, and keeps it on a second link', async () => {
    const { raw, adapter } = setup();
    await adapter.createUser!({
      id: 'u-first',
      email: 'f@example.com',
      emailVerified: null,
      name: null,
      image: null,
    });
    await adapter.linkAccount!({
      userId: 'u-first',
      type: 'oauth',
      provider: 'google',
      providerAccountId: 'g-1',
    });
    expect(firstProviderOf(raw, 'u-first')).toBe('google');

    await adapter.linkAccount!({
      userId: 'u-first',
      type: 'oauth',
      provider: 'discord',
      providerAccountId: 'd-1',
    });
    expect(firstProviderOf(raw, 'u-first')).toBe('google');
  });
});

describe('providers this site does not offer', () => {
  const adapter = (): ReturnType<typeof createD1Adapter> =>
    createD1Adapter(() => Promise.resolve(drizzle(mockD1(freshDb()))));

  it('refuses to link one, rather than failing later on the database CHECK', async () => {
    const a = adapter();
    await a.createUser!({
      id: 'u-x',
      email: 'x@example.com',
      emailVerified: null,
      name: null,
      image: null,
    });
    await expect(
      a.linkAccount!({
        userId: 'u-x',
        type: 'oauth',
        provider: 'banana',
        providerAccountId: 'b-1',
      }),
    ).rejects.toThrow(/Unsupported sign-in provider/);
  });

  it('answers lookups and unlinking for one as "nothing there"', async () => {
    const a = adapter();
    expect(await a.getUserByAccount!({ provider: 'banana', providerAccountId: 'b-1' })).toBeNull();
    expect(await a.getAccount!('b-1', 'banana')).toBeNull();
    await expect(
      a.unlinkAccount!({ provider: 'banana', providerAccountId: 'b-1' }),
    ).resolves.toBeUndefined();
  });
});
