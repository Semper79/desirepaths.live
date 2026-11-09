/**
 * D1 database adapter for Auth.js (NextAuth v5).
 *
 * Implements the `@auth/core/adapters` interface directly against D1 via Drizzle.
 * Resolves the database binding per operation so it works correctly under Cloudflare
 * Workers' request-scoped `env` model (D31) and in tests.
 *
 * TOKENS ARE NEVER STORED (CLAUDE.md guardrails 1 & 5).
 * MORPH only requests identity scopes and never requests posting or write permissions
 * on a visitor's social account. Therefore `social_identity` holds only account
 * identifiers, not OAuth access or refresh tokens.
 */

import type {
  Adapter,
  AdapterAccount,
  AdapterAuthenticator,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from 'next-auth/adapters';
import { and, eq, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import {
  authenticator,
  authSession,
  socialIdentity,
  user,
  verificationToken,
  type User as MorphUser,
} from '@morph/core/db/sqlite';
import { isAuthProvider } from '@morph/core/surfaces';

function toAdapterUser(row: MorphUser): AdapterUser {
  return {
    id: row.id,
    email: row.email ?? '',
    emailVerified: row.emailVerifiedAt ? new Date(row.emailVerifiedAt) : null,
    name: row.displayName ?? null,
    image: row.avatarUrl ?? null,
  };
}

export function createD1Adapter(getDb: () => Promise<ReturnType<typeof drizzle> | null>): Adapter {
  async function dbOrThrow(): Promise<ReturnType<typeof drizzle>> {
    const db = await getDb();
    if (db === null) {
      throw new Error('D1 database binding is unavailable');
    }
    return db;
  }

  return {
    async createUser(data: AdapterUser): Promise<AdapterUser> {
      const db = await dbOrThrow();
      const id = data.id || crypto.randomUUID();
      const now = new Date();
      await db.insert(user).values({
        id,
        email: data.email && data.email.length > 0 ? data.email : null,
        emailVerifiedAt: data.emailVerified ? new Date(data.emailVerified) : null,
        displayName: data.name ?? null,
        avatarUrl: data.image ?? null,
        // Auth.js calls createUser before linkAccount and does not say which provider it
        // is acting for, so the truth is not known yet. `pending` is a value the CHECK
        // admits for exactly this window; linkAccount replaces it a moment later.
        firstProvider: 'pending',
        createdAt: now,
        lastSeenAt: now,
      });

      const created = await this.getUser?.(id);
      if (!created) {
        return {
          id,
          email: data.email,
          emailVerified: data.emailVerified ?? null,
          name: data.name ?? null,
          image: data.image ?? null,
        };
      }
      return created;
    },

    async getUser(id: string): Promise<AdapterUser | null> {
      const db = await dbOrThrow();
      const [row] = await db
        .select()
        .from(user)
        .where(and(eq(user.id, id), isNull(user.deletedAt)));
      return row ? toAdapterUser(row) : null;
    },

    async getUserByEmail(email: string): Promise<AdapterUser | null> {
      if (!email || email.length === 0) return null;
      const db = await dbOrThrow();
      const [row] = await db
        .select()
        .from(user)
        .where(and(eq(user.email, email), isNull(user.deletedAt)));
      return row ? toAdapterUser(row) : null;
    },

    async getUserByAccount(
      providerAccountId: Pick<AdapterAccount, 'provider' | 'providerAccountId'>,
    ): Promise<AdapterUser | null> {
      // A provider this site does not offer cannot have an identity on file.
      if (!isAuthProvider(providerAccountId.provider)) return null;
      const db = await dbOrThrow();
      const [identity] = await db
        .select()
        .from(socialIdentity)
        .where(
          and(
            eq(socialIdentity.provider, providerAccountId.provider),
            eq(socialIdentity.providerAccountId, providerAccountId.providerAccountId),
          ),
        );
      if (!identity) return null;
      return this.getUser?.(identity.userId) ?? null;
    },

    async updateUser(data: Partial<AdapterUser> & Pick<AdapterUser, 'id'>): Promise<AdapterUser> {
      const db = await dbOrThrow();
      const updates: Partial<typeof user.$inferInsert> = {
        lastSeenAt: new Date(),
      };
      if (data.email !== undefined) {
        updates.email = data.email && data.email.length > 0 ? data.email : null;
      }
      if (data.emailVerified !== undefined) {
        updates.emailVerifiedAt = data.emailVerified ? new Date(data.emailVerified) : null;
      }
      if (data.name !== undefined) updates.displayName = data.name;
      if (data.image !== undefined) updates.avatarUrl = data.image;

      await db.update(user).set(updates).where(eq(user.id, data.id));
      const updated = await this.getUser?.(data.id);
      if (!updated) throw new Error(`User ${data.id} not found after update`);
      return updated;
    },

    async deleteUser(userId: string): Promise<void> {
      const db = await dbOrThrow();
      await db.delete(user).where(eq(user.id, userId));
    },

    async linkAccount(account: AdapterAccount): Promise<AdapterAccount> {
      if (!isAuthProvider(account.provider)) {
        throw new Error(`Unsupported sign-in provider: ${account.provider}`);
      }
      const db = await dbOrThrow();
      await db.insert(socialIdentity).values({
        id: crypto.randomUUID(),
        userId: account.userId,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        verifiedEmail: null,
        handle: null,
        linkedAt: new Date(),
        linkConfirmedAt: new Date(),
      });

      // Only the first link names the provider the account was opened with.
      const [u] = await db.select().from(user).where(eq(user.id, account.userId));
      if (u && u.firstProvider === 'pending') {
        await db
          .update(user)
          .set({ firstProvider: account.provider })
          .where(eq(user.id, account.userId));
      }

      return account;
    },

    async unlinkAccount(
      providerAccountId: Pick<AdapterAccount, 'provider' | 'providerAccountId'>,
    ): Promise<void> {
      if (!isAuthProvider(providerAccountId.provider)) return;
      const db = await dbOrThrow();
      await db
        .delete(socialIdentity)
        .where(
          and(
            eq(socialIdentity.provider, providerAccountId.provider),
            eq(socialIdentity.providerAccountId, providerAccountId.providerAccountId),
          ),
        );
    },

    async createSession(session: {
      sessionToken: string;
      userId: string;
      expires: Date;
    }): Promise<AdapterSession> {
      const db = await dbOrThrow();
      await db.insert(authSession).values({
        sessionToken: session.sessionToken,
        userId: session.userId,
        expires: session.expires,
      });
      return session;
    },

    async getSessionAndUser(
      sessionToken: string,
    ): Promise<{ session: AdapterSession; user: AdapterUser } | null> {
      const db = await dbOrThrow();
      const [sessionRow] = await db
        .select()
        .from(authSession)
        .where(eq(authSession.sessionToken, sessionToken));
      if (!sessionRow) return null;

      if (sessionRow.expires.getTime() < Date.now()) {
        await db.delete(authSession).where(eq(authSession.sessionToken, sessionToken));
        return null;
      }

      const userRow = await this.getUser?.(sessionRow.userId);
      if (!userRow) return null;

      return {
        session: {
          sessionToken: sessionRow.sessionToken,
          userId: sessionRow.userId,
          expires: sessionRow.expires,
        },
        user: userRow,
      };
    },

    async updateSession(
      session: Partial<AdapterSession> & Pick<AdapterSession, 'sessionToken'>,
    ): Promise<AdapterSession | null | undefined> {
      const db = await dbOrThrow();
      if (!session.expires) return null;

      const [updated] = await db
        .update(authSession)
        .set({ expires: session.expires })
        .where(eq(authSession.sessionToken, session.sessionToken))
        .returning();

      return updated
        ? {
            sessionToken: updated.sessionToken,
            userId: updated.userId,
            expires: updated.expires,
          }
        : null;
    },

    async deleteSession(sessionToken: string): Promise<void> {
      const db = await dbOrThrow();
      await db.delete(authSession).where(eq(authSession.sessionToken, sessionToken));
    },

    async createVerificationToken(
      token: VerificationToken,
    ): Promise<VerificationToken | null | undefined> {
      const db = await dbOrThrow();
      await db.insert(verificationToken).values({
        identifier: token.identifier,
        token: token.token,
        expires: token.expires,
      });
      return token;
    },

    async useVerificationToken(params: {
      identifier: string;
      token: string;
    }): Promise<VerificationToken | null> {
      const db = await dbOrThrow();
      const [found] = await db
        .select()
        .from(verificationToken)
        .where(
          and(
            eq(verificationToken.identifier, params.identifier),
            eq(verificationToken.token, params.token),
          ),
        );
      if (!found) return null;

      await db
        .delete(verificationToken)
        .where(
          and(
            eq(verificationToken.identifier, params.identifier),
            eq(verificationToken.token, params.token),
          ),
        );

      if (found.expires.getTime() < Date.now()) return null;
      return {
        identifier: found.identifier,
        token: found.token,
        expires: found.expires,
      };
    },

    async getAccount(providerAccountId: string, provider: string): Promise<AdapterAccount | null> {
      if (!isAuthProvider(provider)) return null;
      const db = await dbOrThrow();
      const [row] = await db
        .select()
        .from(socialIdentity)
        .where(
          and(
            eq(socialIdentity.providerAccountId, providerAccountId),
            eq(socialIdentity.provider, provider),
          ),
        );
      if (!row) return null;
      return {
        userId: row.userId,
        type: 'oauth',
        provider: row.provider,
        providerAccountId: row.providerAccountId,
      };
    },

    async getAuthenticator(credentialID: string): Promise<AdapterAuthenticator | null> {
      const db = await dbOrThrow();
      const [row] = await db
        .select()
        .from(authenticator)
        .where(eq(authenticator.credentialId, credentialID));
      if (!row) return null;
      return {
        userId: row.userId,
        providerAccountId: row.credentialId,
        credentialID: row.credentialId,
        credentialPublicKey: row.publicKey,
        counter: row.counter,
        credentialDeviceType: row.deviceType,
        credentialBackedUp: row.backedUp,
        transports: row.transports ?? null,
      };
    },

    async createAuthenticator(data: AdapterAuthenticator): Promise<AdapterAuthenticator> {
      const db = await dbOrThrow();
      await db.insert(authenticator).values({
        credentialId: data.credentialID,
        userId: data.userId,
        publicKey: data.credentialPublicKey,
        counter: data.counter,
        deviceType: data.credentialDeviceType,
        backedUp: data.credentialBackedUp,
        transports: data.transports ?? null,
        createdAt: new Date(),
      });
      return data;
    },

    async listAuthenticatorsByUserId(userId: string): Promise<AdapterAuthenticator[]> {
      const db = await dbOrThrow();
      const rows = await db.select().from(authenticator).where(eq(authenticator.userId, userId));
      return rows.map((row) => ({
        userId: row.userId,
        providerAccountId: row.credentialId,
        credentialID: row.credentialId,
        credentialPublicKey: row.publicKey,
        counter: row.counter,
        credentialDeviceType: row.deviceType,
        credentialBackedUp: row.backedUp,
        transports: row.transports ?? null,
      }));
    },

    async updateAuthenticatorCounter(
      credentialID: string,
      counter: number,
    ): Promise<AdapterAuthenticator> {
      const db = await dbOrThrow();
      await db
        .update(authenticator)
        .set({ counter })
        .where(eq(authenticator.credentialId, credentialID));
      const updated = await this.getAuthenticator?.(credentialID);
      if (!updated) throw new Error(`Authenticator ${credentialID} not found`);
      return updated;
    },
  };
}
