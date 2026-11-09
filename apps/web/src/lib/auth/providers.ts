/**
 * Configured OAuth and passwordless authentication providers (D5).
 *
 * Each provider is optional: without credentials it is omitted from the Auth.js
 * configuration, and the pages omit its button, because both ask `availability.ts`.
 * That module owns which env vars a provider needs and hands back a checked pair; this
 * one owns how to turn that into an Auth.js provider.
 *
 * Decided by D5:
 *   - Google, Apple, Discord, TikTok, Passkey (WebAuthn), Email link.
 *   - Declared but unset: X, Twitch, Instagram, Reddit, Spotify, GitHub.
 */

import Google from 'next-auth/providers/google';
import Apple from 'next-auth/providers/apple';
import Discord from 'next-auth/providers/discord';
import TikTok from 'next-auth/providers/tiktok';
import Passkey from 'next-auth/providers/passkey';
import type { Provider } from 'next-auth/providers';
import { getAppleClientSecret } from './apple';
import { appleClientId, oauthCredentials, passkeyEnabled } from './availability';

export { passkeyEnabled };

export async function configuredProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];

  const google = oauthCredentials('google');
  if (google !== null) providers.push(Google(google));

  const apple = appleClientId();
  if (apple !== null) {
    const clientSecret = await getAppleClientSecret();
    if (clientSecret !== null) providers.push(Apple({ clientId: apple, clientSecret }));
  }

  const discord = oauthCredentials('discord');
  if (discord !== null) providers.push(Discord(discord));

  const tiktok = oauthCredentials('tiktok');
  if (tiktok !== null) providers.push(TikTok(tiktok));

  if (passkeyEnabled()) providers.push(Passkey({}));

  return providers;
}
