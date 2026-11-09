/**
 * Configured OAuth and passwordless authentication providers (D5).
 *
 * Each provider is optional: an unset client ID or secret omits that provider
 * from the active Auth.js configuration. The adaptive surface (`signup.providers_order`)
 * and the registry adapt variant space accordingly.
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

export function passkeyEnabled(): boolean {
  const flag = process.env['AUTH_PASSKEY_ENABLED'];
  return flag === 'true' || flag === '1';
}

export async function configuredProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];

  // Google (D5)
  const googleId = process.env['AUTH_GOOGLE_ID'];
  const googleSecret = process.env['AUTH_GOOGLE_SECRET'];
  if (googleId && googleSecret) {
    providers.push(Google({ clientId: googleId, clientSecret: googleSecret }));
  }

  // Apple (D5)
  const appleId = process.env['AUTH_APPLE_ID'];
  const appleSecret = await getAppleClientSecret();
  if (appleId && appleSecret) {
    providers.push(Apple({ clientId: appleId, clientSecret: appleSecret }));
  }

  // Discord (D5)
  const discordId = process.env['AUTH_DISCORD_ID'];
  const discordSecret = process.env['AUTH_DISCORD_SECRET'];
  if (discordId && discordSecret) {
    providers.push(Discord({ clientId: discordId, clientSecret: discordSecret }));
  }

  // TikTok (D5)
  const tiktokId = process.env['AUTH_TIKTOK_ID'];
  const tiktokSecret = process.env['AUTH_TIKTOK_SECRET'];
  if (tiktokId && tiktokSecret) {
    providers.push(TikTok({ clientId: tiktokId, clientSecret: tiktokSecret }));
  }

  // Passkey / WebAuthn (D5)
  if (passkeyEnabled()) {
    providers.push(Passkey({}));
  }

  return providers;
}
