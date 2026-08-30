/**
 * Who is allowed in, and how that is proved.
 *
 * ON THE DESIGN, WHICH IS DELIBERATELY SMALL
 * One operator, one secret, one signed cookie. No user table, no password hashing, no
 * account recovery, no roles. Those exist to manage a population of users, and there is
 * exactly one person who will ever open this console — building them would be solving a
 * problem that does not exist, and every one of them is a surface an attacker can reach.
 *
 * This is **not** what Phase 4 builds. Auth.js and the five OAuth providers in D5 are for
 * *visitors* signing up to the public site: a different audience, a different threat model,
 * and a different table. Merging them would mean the operator console shares an
 * authentication path with the internet.
 *
 * WHY WEB CRYPTO AND NOT `node:crypto`
 * The first version used `node:crypto`, and the build caught it: Next middleware runs on
 * the Edge runtime, which has no Node built-ins, so importing it there fails the build
 * outright. Web Crypto is present in both runtimes, which means one implementation guards
 * the middleware and the login route rather than two that can disagree about what a valid
 * session is. Everything here is async as a consequence, and that is the whole cost.
 *
 * WHY A SIGNED COOKIE AND NOT A SESSION STORE
 * A session store buys revocation and nothing else here. With one operator, revocation is
 * rotating `ADMIN_SECRET`, which invalidates every cookie ever issued because they are all
 * derived from it. That is a better revocation story than a store, not a worse one.
 */

export const SESSION_COOKIE = 'morph_admin';

/**
 * Thirty days, for no deeper reason than that the operator should not be asked to sign in
 * more often than they change anything.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Below this the HMAC is theatre: a signature is only as strong as its key. */
const MIN_SECRET_LENGTH = 32;

export class WeakSecretError extends Error {
  constructor(length: number) {
    super(
      `ADMIN_SECRET is ${String(length)} characters; at least ${String(MIN_SECRET_LENGTH)} are required. Generate one with: openssl rand -base64 48`,
    );
    this.name = 'WeakSecretError';
  }
}

/**
 * The token stored in the cookie: an expiry, and an HMAC over it.
 *
 * The expiry lives inside the signed payload rather than in the cookie's `Max-Age`, because
 * `Max-Age` is a request the client is free to ignore. A cookie replayed after its expiry
 * has to fail server-side, and it can only do that if the server signed the expiry itself.
 */
export async function issueToken(secret: string, now: number): Promise<string> {
  assertUsableSecret(secret);

  const payload = String(now + SESSION_MAX_AGE_SECONDS * 1000);
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifyToken(
  secret: string,
  token: string | undefined,
  now: number,
): Promise<boolean> {
  if (token === undefined) return false;
  if (secret.length < MIN_SECRET_LENGTH) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);

  if (!(await constantTimeEqual(await sign(secret, payload), provided))) return false;

  // Checked after the signature, deliberately. Reading an expiry out of an unverified
  // payload and acting on it means acting on attacker-controlled input.
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Whether the supplied passphrase is the operator's.
 *
 * Compared against the same secret that signs the session rather than against a separate
 * password: one secret means one thing to rotate, and a console with two credentials has
 * one the operator will forget to change.
 */
export async function isOperator(secret: string, supplied: string): Promise<boolean> {
  if (secret.length < MIN_SECRET_LENGTH) return false;
  return constantTimeEqual(secret, supplied);
}

export function assertUsableSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) throw new WeakSecretError(secret.length);
}

const encoder = new TextEncoder();

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return crypto.subtle.sign('HMAC', imported, encoder.encode(message));
}

async function sign(secret: string, payload: string): Promise<string> {
  const bytes = new Uint8Array(await hmac(secret, payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  // base64url, so the value is cookie-safe without escaping.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Compare without leaking length or prefix through timing.
 *
 * Both sides are HMAC'd to a fixed 32 bytes first, so a one-character guess and a
 * ten-thousand-character guess take the same path — an early length check would itself be
 * the timing signal. The comparison then accumulates differences with XOR rather than
 * returning early, which is what makes it constant-time over those bytes.
 */
async function constantTimeEqual(expected: string, provided: string): Promise<boolean> {
  const a = new Uint8Array(await hmac('compare', expected));
  const b = new Uint8Array(await hmac('compare', provided));

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);

  return difference === 0;
}
