/**
 * Current user profile and GDPR erasure endpoint (Art. 17).
 *
 * `DELETE /api/me` fulfills data subject erasure requests:
 *   1. Authenticates request via active session.
 *   2. Removes all personal data across `user`, `social_identity`, `authenticator`,
 *      `auth_session`, and `consent_record`.
 *   3. Writes an audit row to `data_subject_request` recording rows removed per table.
 *      The record outlives the data and references only an opaque ID that no longer
 *      resolves to anything, as required by docs/PRIVACY.md §4.
 *   4. Invalidates active session cookies.
 */

import { eq } from 'drizzle-orm';
import {
  authenticator,
  authSession,
  consentRecord,
  dataSubjectRequest,
  socialIdentity,
  user,
} from '@morph/core/db/sqlite';
import { auth } from '../../../lib/auth';
import { signInAvailable } from '../../../lib/auth/availability';
import { database } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * Why this answers 503 and not 401.
 *
 * `auth()` cannot run without `AUTH_SECRET`: `authSecret()` throws, and the route used to
 * answer 500 — the wrong thing for an endpoint a data subject is exercising a right
 * against. 401 would be wrong too: it says the caller is not authorised, when the truth is
 * that this deployment cannot authenticate anyone yet. 503 says the endpoint exists and is
 * not serving, which is the only accurate answer, and it disappears the moment the operator
 * sets the secret.
 */
function signInNotConfigured(): Response {
  return Response.json({ error: 'sign_in_not_configured' }, { status: 503 });
}

export async function GET(): Promise<Response> {
  if (!signInAvailable()) return signInNotConfigured();

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await database();
  if (!db) {
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  const [row] = await db.select().from(user).where(eq(user.id, session.user.id));
  if (!row) {
    return Response.json({ error: 'user_not_found' }, { status: 404 });
  }

  return Response.json({
    user: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      locale: row.locale,
      firstProvider: row.firstProvider,
      createdAt: row.createdAt,
    },
  });
}

export async function DELETE(): Promise<Response> {
  if (!signInAvailable()) return signInNotConfigured();

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await database();
  if (!db) {
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  // Delete all rows tied to the subject
  const deletedIdentities = await db
    .delete(socialIdentity)
    .where(eq(socialIdentity.userId, userId))
    .returning();
  const deletedAuthenticators = await db
    .delete(authenticator)
    .where(eq(authenticator.userId, userId))
    .returning();
  const deletedSessions = await db
    .delete(authSession)
    .where(eq(authSession.userId, userId))
    .returning();
  const deletedConsents = await db
    .delete(consentRecord)
    .where(eq(consentRecord.userId, userId))
    .returning();
  const deletedUsers = await db.delete(user).where(eq(user.id, userId)).returning();

  const resultCounts: Record<string, number> = {
    user: deletedUsers.length,
    social_identity: deletedIdentities.length,
    authenticator: deletedAuthenticators.length,
    auth_session: deletedSessions.length,
    consent_record: deletedConsents.length,
  };

  const requestId = crypto.randomUUID();
  const now = new Date();

  // Audit trail retained indefinitely with opaque subjectRef
  await db.insert(dataSubjectRequest).values({
    id: requestId,
    kind: 'erasure',
    subjectRef: userId,
    requestedAt: now,
    completedAt: now,
    result: resultCounts,
    error: null,
  });

  const responseHeaders = new Headers();
  // Clear Auth.js session cookies
  responseHeaders.append(
    'Set-Cookie',
    'authjs.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
  );
  responseHeaders.append(
    'Set-Cookie',
    '__Secure-authjs.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
  );

  return Response.json(
    {
      ok: true,
      erased: true,
      requestId,
      result: resultCounts,
    },
    { headers: responseHeaders },
  );
}
