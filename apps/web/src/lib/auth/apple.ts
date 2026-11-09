/**
 * Apple client secret generation (D5).
 *
 * Apple's client secret is a signed ES256 JWT that expires and must be generated from
 * the developer's private key (`.p8`), Services ID, and Team ID.
 *
 * Implemented with `jose` using Web Crypto primitives (`crypto.subtle`) rather than
 * `node:crypto`, ensuring native compatibility with Cloudflare Workers without Node shims.
 *
 * Supports both static secrets (if pre-generated and stored in `AUTH_APPLE_SECRET`)
 * and dynamic on-demand generation from `AUTH_APPLE_PRIVATE_KEY`.
 */

import { importPKCS8, SignJWT } from 'jose';

export async function getAppleClientSecret(): Promise<string | null> {
  const staticSecret = process.env['AUTH_APPLE_SECRET'];
  if (staticSecret && staticSecret.length > 0) {
    return staticSecret;
  }

  const keyId = process.env['AUTH_APPLE_KEY_ID'];
  const teamId = process.env['AUTH_APPLE_TEAM_ID'];
  const clientId = process.env['AUTH_APPLE_ID'];
  const privateKeyRaw = process.env['AUTH_APPLE_PRIVATE_KEY'];

  if (!keyId || !teamId || !clientId || !privateKeyRaw) {
    return null;
  }

  try {
    const privateKeyPem = privateKeyRaw.replace(/\\n/g, '\n');
    const privateKey = await importPKCS8(privateKeyPem, 'ES256');

    return await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt()
      .setExpirationTime('180d')
      .setAudience('https://appleid.apple.com')
      .setSubject(clientId)
      .sign(privateKey);
  } catch {
    return null;
  }
}
