/**
 * Read the consent mask from the first-party cookie.
 *
 * Lifted out of the Fastify route it used to live in (D31) without a line changing. It was
 * always framework-free; it was only ever sitting in the wrong file.
 *
 * Not from the payload: a script on the page can set a field, and a consent decision that a
 * script can set is not a consent decision. The cookie is set by the consent gate on the
 * server side and is `SameSite=Lax; Secure; HttpOnly`.
 */

import { CONSENT_DEFAULT } from '@morph/core';

export function consentMaskFromCookie(cookieHeader: string | undefined): number {
  if (cookieHeader === undefined) return CONSENT_DEFAULT;
  for (const part of cookieHeader.split(';')) {
    const [rawName, rawValue] = part.split('=');
    if ((rawName ?? '').trim() !== 'morph_consent') continue;
    const parsed = Number.parseInt((rawValue ?? '').trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 15) return parsed;
    return CONSENT_DEFAULT;
  }
  return CONSENT_DEFAULT;
}
