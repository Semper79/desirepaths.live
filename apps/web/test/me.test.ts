import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
  authenticator,
  authSession,
  consentRecord,
  dataSubjectRequest,
  socialIdentity,
  user,
} from '@morph/core/db/sqlite';
import { eq } from 'drizzle-orm';

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

let mockSession: { user?: { id?: string; email?: string } } | null = null;
let currentDrizzle: ReturnType<typeof drizzle> | null = null;

vi.mock('../src/lib/auth', () => ({
  auth: () => Promise.resolve(mockSession),
}));

vi.mock('../src/lib/db', () => ({
  database: () => Promise.resolve(currentDrizzle),
}));

import { DELETE as meDelete, GET as meGet } from '../src/app/api/me/route';
import { GET as exportGet } from '../src/app/api/me/export/route';

describe('/api/me (Profile, Erasure, and Export)', () => {
  let rawDb: SqliteDatabase;

  beforeEach(() => {
    rawDb = freshDb();
    const d1 = mockD1(rawDb);
    currentDrizzle = drizzle(d1);
    mockSession = null;
  });

  describe('GET /api/me', () => {
    it('returns 401 when not authenticated', async () => {
      mockSession = null;
      const res = await meGet();
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe('unauthorized');
    });

    it('returns 503 when database is unavailable', async () => {
      mockSession = { user: { id: 'u1' } };
      currentDrizzle = null;
      const res = await meGet();
      expect(res.status).toBe(503);
    });

    it('returns 404 when user does not exist in database', async () => {
      mockSession = { user: { id: 'nonexistent' } };
      const res = await meGet();
      expect(res.status).toBe(404);
    });

    it('returns user profile when authenticated and found', async () => {
      const now = new Date();
      await currentDrizzle!.insert(user).values({
        id: 'u-123',
        email: 'user@example.com',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.jpg',
        locale: 'en',
        firstProvider: 'google',
        createdAt: now,
        lastSeenAt: now,
      });

      mockSession = { user: { id: 'u-123', email: 'user@example.com' } };
      const res = await meGet();
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        user: { id: string; email: string; displayName: string };
      };
      expect(json.user.id).toBe('u-123');
      expect(json.user.email).toBe('user@example.com');
      expect(json.user.displayName).toBe('Test User');
    });
  });

  describe('DELETE /api/me (GDPR Erasure)', () => {
    it('returns 401 when not authenticated', async () => {
      mockSession = null;
      const res = await meDelete();
      expect(res.status).toBe(401);
    });

    it('deletes all personal data and writes audit row to data_subject_request', async () => {
      const now = new Date();
      const db = currentDrizzle!;

      // Populate user and related rows
      await db.insert(user).values({
        id: 'user-to-erase',
        email: 'erase@example.com',
        firstProvider: 'google',
        createdAt: now,
        lastSeenAt: now,
      });

      await db.insert(socialIdentity).values({
        id: 'ident-1',
        userId: 'user-to-erase',
        provider: 'google',
        providerAccountId: 'google-sub-999',
        linkedAt: now,
      });

      await db.insert(authenticator).values({
        credentialId: 'cred-abc',
        userId: 'user-to-erase',
        publicKey: 'pubkey',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: now,
      });

      await db.insert(authSession).values({
        sessionToken: 'sess-token-123',
        userId: 'user-to-erase',
        expires: new Date(Date.now() + 86400000),
      });

      await db.insert(consentRecord).values({
        id: 'consent-1',
        userId: 'user-to-erase',
        anonIdHash: 'anon-1',
        mask: 3,
        source: 'banner',
        policyVersion: '2026-10-22',
        recordedAt: now,
      });

      mockSession = { user: { id: 'user-to-erase' } };

      const res = await meDelete();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        erased: boolean;
        requestId: string;
        result: Record<string, number>;
      };

      expect(body.ok).toBe(true);
      expect(body.erased).toBe(true);
      expect(body.result['user']).toBe(1);
      expect(body.result['social_identity']).toBe(1);
      expect(body.result['authenticator']).toBe(1);
      expect(body.result['auth_session']).toBe(1);
      expect(body.result['consent_record']).toBe(1);

      // Verify Set-Cookie header clears authjs session tokens
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('Max-Age=0');

      // Verify records are gone from DB
      const remainingUsers = await db.select().from(user).where(eq(user.id, 'user-to-erase'));
      expect(remainingUsers).toHaveLength(0);

      const remainingIdentities = await db
        .select()
        .from(socialIdentity)
        .where(eq(socialIdentity.userId, 'user-to-erase'));
      expect(remainingIdentities).toHaveLength(0);

      const remainingSessions = await db
        .select()
        .from(authSession)
        .where(eq(authSession.userId, 'user-to-erase'));
      expect(remainingSessions).toHaveLength(0);

      // Verify audit record exists in data_subject_request with opaque subjectRef
      const auditRows = await db
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, body.requestId));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.kind).toBe('erasure');
      expect(auditRows[0]?.subjectRef).toBe('user-to-erase');
      expect(auditRows[0]?.error).toBeNull();
    });
  });

  describe('GET /api/me/export (GDPR Portability)', () => {
    it('returns 401 when unauthenticated', async () => {
      mockSession = null;
      const res = await exportGet();
      expect(res.status).toBe(401);
    });

    it('exports all personal data and logs request in data_subject_request', async () => {
      const now = new Date();
      const db = currentDrizzle!;

      await db.insert(user).values({
        id: 'export-user',
        email: 'export@example.com',
        displayName: 'Export Visitor',
        firstProvider: 'discord',
        createdAt: now,
        lastSeenAt: now,
      });

      await db.insert(socialIdentity).values({
        id: 'ident-exp',
        userId: 'export-user',
        provider: 'discord',
        providerAccountId: 'discord-sub-1',
        linkedAt: now,
      });

      mockSession = { user: { id: 'export-user' } };

      const res = await exportGet();
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        requestId: string;
        profile: { id: string; email: string };
        identities: { provider: string }[];
      };

      expect(data.profile.id).toBe('export-user');
      expect(data.profile.email).toBe('export@example.com');
      expect(data.identities).toHaveLength(1);
      expect(data.identities[0]?.provider).toBe('discord');

      // Verify audit log
      const audit = await db
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, data.requestId));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.kind).toBe('export');
      expect(audit[0]?.subjectRef).toBe('export-user');
    });
  });
});
