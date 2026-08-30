/**
 * The door.
 *
 * This is the only thing standing between the internet and a console that can publish
 * content, retire variants and read the adaptation log. Its failure modes are all silent:
 * a token that verifies when it should not looks exactly like a token that verifies
 * because it should.
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_MAX_AGE_SECONDS,
  WeakSecretError,
  assertUsableSecret,
  isOperator,
  issueToken,
  verifyToken,
} from '../src/lib/session.js';

const SECRET = 'a'.repeat(48);
const OTHER = 'b'.repeat(48);
const NOW = Date.parse('2026-08-30T12:00:00Z');

describe('the session token', () => {
  it('verifies a token it just issued', async () => {
    expect(await verifyToken(SECRET, await issueToken(SECRET, NOW), NOW)).toBe(true);
  });

  it('refuses a token signed with a different secret', async () => {
    // This is what rotating ADMIN_SECRET does: every cookie ever issued stops working,
    // which is the revocation story a single-operator console actually needs.
    expect(await verifyToken(SECRET, await issueToken(OTHER, NOW), NOW)).toBe(false);
  });

  it('refuses a token past its expiry', async () => {
    const token = await issueToken(SECRET, NOW);
    const afterExpiry = NOW + SESSION_MAX_AGE_SECONDS * 1000 + 1;

    expect(await verifyToken(SECRET, token, afterExpiry)).toBe(false);
  });

  it('refuses an expiry the holder extended themselves', async () => {
    // The reason the expiry lives inside the signed payload rather than in the cookie's
    // Max-Age: Max-Age is a request the client is free to ignore, and a token replayed
    // after its expiry has to fail server-side.
    const token = await issueToken(SECRET, NOW);
    const [, signature] = token.split('.');
    const forged = `${String(NOW + 10 * 365 * 24 * 3_600_000)}.${String(signature)}`;

    expect(await verifyToken(SECRET, forged, NOW)).toBe(false);
  });

  it('refuses a token with no signature at all', async () => {
    expect(await verifyToken(SECRET, String(NOW + 1_000), NOW)).toBe(false);
    expect(await verifyToken(SECRET, '', NOW)).toBe(false);
    expect(await verifyToken(SECRET, '.abc', NOW)).toBe(false);
  });

  it('refuses everything when no cookie was sent', async () => {
    expect(await verifyToken(SECRET, undefined, NOW)).toBe(false);
  });
});

describe('the secret', () => {
  it('refuses to issue against a secret too short to matter', async () => {
    // Below this the HMAC is theatre: the signature is only as strong as the key, and a
    // twelve-character secret is a weekend of brute force.
    // Rejects rather than throws: the guard runs inside an async function, so the failure
    // arrives as a rejected promise. Asserting `toThrow` here would pass vacuously against
    // a function that never throws synchronously — which is exactly what it is now.
    await expect(issueToken('short', NOW)).rejects.toThrow(WeakSecretError);

    expect(() => {
      assertUsableSecret('short');
    }).toThrow(WeakSecretError);
  });

  it('fails closed rather than throwing when verifying against a weak secret', async () => {
    // A misconfigured deployment must refuse requests, not crash on every one of them —
    // a crash loop takes the console down in a way that reads as an outage rather than
    // as a configuration error.
    expect(await verifyToken('short', await issueToken(SECRET, NOW), NOW)).toBe(false);
    expect(await isOperator('short', 'short')).toBe(false);
  });
});

describe('the operator check', () => {
  it('accepts the secret and nothing else', async () => {
    expect(await isOperator(SECRET, SECRET)).toBe(true);
    expect(await isOperator(SECRET, OTHER)).toBe(false);
    expect(await isOperator(SECRET, '')).toBe(false);
    expect(await isOperator(SECRET, `${SECRET}x`)).toBe(false);
  });

  it('takes the same path for a one-character guess and a huge one', async () => {
    // Both sides are HMAC'd to a fixed 32 bytes before comparison, so length never
    // short-circuits anything. A length check would itself be the timing signal, and an
    // implementation that threw on a mismatch — the obvious one — would leak through the
    // difference between a rejection and a false.
    await expect(isOperator(SECRET, 'x')).resolves.toBe(false);
    await expect(isOperator(SECRET, 'x'.repeat(10_000))).resolves.toBe(false);
  });
});
