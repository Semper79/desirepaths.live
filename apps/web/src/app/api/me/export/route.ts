/**
 * GDPR Data Portability / Subject Access Request endpoint (Art. 15 & Art. 20).
 *
 * `GET /api/me/export` returns all personal data associated with the authenticated user:
 *   - User profile details
 *   - Linked social identities
 *   - Consent history records
 *   - Authenticator registrations
 *
 * Records the request in `data_subject_request` for compliance auditing.
 */

import { eq } from 'drizzle-orm';
import {
  authenticator,
  consentRecord,
  dataSubjectRequest,
  socialIdentity,
  user,
} from '@morph/core/db/sqlite';
import { auth } from '../../../../lib/auth';
import { database } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await database();
  if (!db) {
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  const [userData] = await db.select().from(user).where(eq(user.id, userId));
  if (!userData) {
    return Response.json({ error: 'user_not_found' }, { status: 404 });
  }

  const identities = await db
    .select()
    .from(socialIdentity)
    .where(eq(socialIdentity.userId, userId));
  const consents = await db.select().from(consentRecord).where(eq(consentRecord.userId, userId));
  const authenticators = await db
    .select()
    .from(authenticator)
    .where(eq(authenticator.userId, userId));

  const requestId = crypto.randomUUID();
  const now = new Date();

  await db.insert(dataSubjectRequest).values({
    id: requestId,
    kind: 'export',
    subjectRef: userId,
    requestedAt: now,
    completedAt: now,
    result: {
      user: 1,
      social_identity: identities.length,
      consent_record: consents.length,
      authenticator: authenticators.length,
    },
    error: null,
  });

  return Response.json({
    requestId,
    exportedAt: now.toISOString(),
    profile: {
      id: userData.id,
      email: userData.email,
      displayName: userData.displayName,
      avatarUrl: userData.avatarUrl,
      locale: userData.locale,
      firstProvider: userData.firstProvider,
      createdAt: userData.createdAt,
      lastSeenAt: userData.lastSeenAt,
    },
    identities: identities.map((i) => ({
      provider: i.provider,
      providerAccountId: i.providerAccountId,
      verifiedEmail: i.verifiedEmail,
      handle: i.handle,
      linkedAt: i.linkedAt,
    })),
    consents: consents.map((c) => ({
      mask: c.mask,
      source: c.source,
      policyVersion: c.policyVersion,
      recordedAt: c.recordedAt,
    })),
    authenticators: authenticators.map((a) => ({
      credentialId: a.credentialId,
      deviceType: a.deviceType,
      createdAt: a.createdAt,
    })),
  });
}
