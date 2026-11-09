/**
 * NextAuth v5 configuration for Desire Path.
 *
 * Configured dynamically per request to ensure bindings (D1) and request
 * environment variables are correctly accessed under Cloudflare Workers.
 */

import type { NextAuthConfig } from 'next-auth';
import { createD1Adapter } from './d1-adapter';
import { configuredProviders, passkeyEnabled } from './providers';
import { authSecret } from './secret';
import { database } from '../db';

export async function createAuthConfig(): Promise<NextAuthConfig> {
  const providers = await configuredProviders();
  const secret = authSecret();

  return {
    adapter: createD1Adapter(database),
    providers,
    secret,
    trustHost: true,
    // Auth.js refuses the passkey provider unless WebAuthn is opted into explicitly.
    ...(passkeyEnabled() ? { experimental: { enableWebAuthn: true } } : {}),
    session: {
      strategy: 'database',
      maxAge: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    callbacks: {
      session({ session, user }) {
        session.user.id = user.id;
        return session;
      },
    },
  };
}
