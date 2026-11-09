/**
 * NextAuth initialization for apps/web (D5, D6).
 *
 * Lazy initialization passes a config factory so environment variables and D1
 * database bindings are accessed at request time rather than module scope.
 */

import NextAuth, { type NextAuthResult } from 'next-auth';
import { createAuthConfig } from './config';

const nextAuth: NextAuthResult = NextAuth(async () => {
  return createAuthConfig();
});

export const handlers: NextAuthResult['handlers'] = nextAuth.handlers;
export const auth: NextAuthResult['auth'] = nextAuth.auth;
export const signIn: NextAuthResult['signIn'] = nextAuth.signIn;
export const signOut: NextAuthResult['signOut'] = nextAuth.signOut;
