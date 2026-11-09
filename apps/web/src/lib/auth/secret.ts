/**
 * The Auth.js signing secret, and the one rule about it.
 *
 * Lives apart from `config.ts` so `/api/ready` can share the threshold without importing
 * Auth.js, the adapter and the database. Two copies of "32" is how a readiness probe says
 * ready while the handler refuses to start.
 */

export const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * There is deliberately no fallback value.
 *
 * Auth.js encrypts the OAuth state and PKCE cookies with this secret. A default committed
 * to a public repository would make those cookies forgeable by anyone who read the source,
 * and the failure would be silent: sign-in would work. Refusing to start makes a missing
 * secret a 500 on `/api/auth/*` and a named entry in `/api/ready` instead.
 */
export function authSecret(): string {
  const secret = process.env['AUTH_SECRET'];
  if (secret === undefined || secret.length < AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `AUTH_SECRET is missing or shorter than ${String(AUTH_SECRET_MIN_LENGTH)} characters`,
    );
  }
  return secret;
}
