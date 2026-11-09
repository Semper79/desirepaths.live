/**
 * Which providers can actually complete a sign-in right now (§D5).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * Two different things need the answer and must never disagree: `providers.ts`, which
 * builds the Auth.js configuration, and the pages, which render the buttons. When the
 * page believed a provider was live and the configuration did not, the button answered
 * 500 — which is what shipped, and what this replaces. The table below is the single
 * source: `providers.ts` reads its credentials from here rather than naming env vars of
 * its own, so "configured" cannot mean two things.
 *
 * It deliberately imports no Auth.js code. A server component asking "is sign-in open?"
 * should not pull the whole provider tree and the adapter into its bundle.
 *
 * Everything here reads the environment at call time, never at module scope: on Workers
 * the values arrive with the request, and `/join` is a dynamic route precisely so this is
 * answered per request instead of frozen into a prerendered page at build time.
 */

import type { AuthProvider } from '@morph/core/surfaces';
import { AUTH_SECRET_MIN_LENGTH } from './secret';

/** Both halves of an OAuth client, present and non-empty. */
export interface OAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

function value(name: string): string | null {
  const read = process.env[name];
  return read !== undefined && read.length > 0 ? read : null;
}

function pair(idName: string, secretName: string): OAuthCredentials | null {
  const clientId = value(idName);
  const clientSecret = value(secretName);
  // Returned as a narrowed pair rather than two possibly-undefined reads, so the call in
  // `providers.ts` satisfies `exactOptionalPropertyTypes` without a non-null assertion.
  return clientId !== null && clientSecret !== null ? { clientId, clientSecret } : null;
}

/** The OAuth providers D5 implements, and the credentials each one needs. */
const OAUTH: Readonly<Record<'google' | 'discord' | 'tiktok', () => OAuthCredentials | null>> = {
  google: () => pair('AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET'),
  discord: () => pair('AUTH_DISCORD_ID', 'AUTH_DISCORD_SECRET'),
  tiktok: () => pair('AUTH_TIKTOK_ID', 'AUTH_TIKTOK_SECRET'),
};

export function oauthCredentials(provider: keyof typeof OAUTH): OAuthCredentials | null {
  return OAUTH[provider]();
}

/**
 * Apple's Services ID, when the material to sign a client secret with is also present.
 *
 * Apple's secret is an ES256 JWT with an expiry, so it is generated per request rather
 * than stored; `AUTH_APPLE_SECRET` is the pre-generated alternative. A malformed `.p8`
 * passes this check and fails in `getAppleClientSecret`, which leaves the provider out —
 * that ends on Auth.js's own "provider not supported" page rather than a 500, and it needs
 * the operator to look at the key, which no amount of checking here can do for them.
 */
export function appleClientId(): string | null {
  const clientId = value('AUTH_APPLE_ID');
  if (clientId === null) return null;
  const signable =
    value('AUTH_APPLE_SECRET') !== null ||
    (value('AUTH_APPLE_KEY_ID') !== null &&
      value('AUTH_APPLE_TEAM_ID') !== null &&
      value('AUTH_APPLE_PRIVATE_KEY') !== null);
  return signable ? clientId : null;
}

/** Passkeys are off unless asked for: Auth.js also needs `experimental.enableWebAuthn`. */
export function passkeyEnabled(): boolean {
  const flag = process.env['AUTH_PASSKEY_ENABLED'];
  return flag === 'true' || flag === '1';
}

/** The providers that are both implemented and hold credentials, in a fixed order. */
const IMPLEMENTED: readonly AuthProvider[] = ['google', 'apple', 'discord', 'tiktok', 'passkey'];

/** True when a provider is implemented and its credentials are in place. */
export function providerConfigured(provider: AuthProvider): boolean {
  switch (provider) {
    case 'google':
    case 'discord':
    case 'tiktok':
      return oauthCredentials(provider) !== null;
    case 'apple':
      return appleClientId() !== null;
    case 'passkey':
      return passkeyEnabled();
    // Declared in the surface's variant space so the engine has names to explore, but with
    // no implementation behind them (D5 lists them as deliberately unset). Spelled out
    // rather than left to a `default` so that adding a name to `AUTH_PROVIDERS` fails lint
    // here until someone decides which of the two groups it belongs in.
    case 'email':
    case 'x':
    case 'twitch':
    case 'instagram':
    case 'reddit':
    case 'spotify':
    case 'github':
      return false;
  }
}

/**
 * Whether `/api/auth/*` can serve a sign-in at all.
 *
 * Without `AUTH_SECRET` Auth.js refuses to start (`secret.ts`), so every provider button
 * would answer 500 however well configured it was. One unusable provider is a missing
 * button; a missing secret is a closed door, and the page says so.
 */
export function signInAvailable(): boolean {
  const secret = process.env['AUTH_SECRET'];
  if (secret === undefined || secret.length < AUTH_SECRET_MIN_LENGTH) return false;
  return IMPLEMENTED.some((provider) => providerConfigured(provider));
}

/** The providers a visitor can actually use, in the order asked for. */
export function availableProviders(
  order: readonly AuthProvider[] = IMPLEMENTED,
): readonly AuthProvider[] {
  return order.filter((provider) => providerConfigured(provider));
}

/** Whether clicking this provider's button would actually start a sign-in. */
export function providerSignsIn(provider: AuthProvider): boolean {
  return signInAvailable() && providerConfigured(provider);
}

/**
 * Where a provider button should point.
 *
 * `/join` for anything that cannot complete a sign-in, so the click is still recorded
 * against the provider — `signup.providers_order` is one of the eleven surfaces and which
 * name a visitor reaches for is the signal that says which provider to register next — but
 * the visitor lands on a page that explains itself instead of on an error.
 */
export function providerHref(provider: AuthProvider): string {
  return providerSignsIn(provider) ? `/api/auth/signin/${provider}` : '/join';
}
