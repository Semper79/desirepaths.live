/**
 * Reading and writing the consent cookie.
 *
 * One implementation, used by middleware, by the privacy page, by the endpoint that
 * sets it, and by the client beacon. It started as four copies of the same seven-line
 * loop, which is exactly the shape of thing that drifts: the day one of them reads a
 * different bit from the others, the site measures someone who said no, and nothing
 * fails to make that visible.
 *
 * It also cannot live in a route module — Next allows a route file to export only a
 * known set of names — which is what forced the consolidation and, on reflection, was
 * the framework being right.
 */

import { CONSENT_BIT, CONSENT_DEFAULT, maskOf, type ConsentCategory } from '@morph/core';

export const COOKIE_NAME = 'morph_consent';

/**
 * Bumped whenever the consent copy changes.
 *
 * Under GDPR the operator must be able to show what a person was actually told when
 * they agreed. Recording a version alongside the decision is what makes that
 * answerable; recording only the answer is not.
 */
export const POLICY_VERSION = '2026-08-1';

/** A year. Long enough not to nag, short enough that a stale choice expires. */
export const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Parse the mask out of a `Cookie` header, or `document.cookie`.
 *
 * Anything absent, malformed or out of range falls back to necessary-only. The safe
 * direction is always "less consent than claimed": misreading a refusal as consent is
 * a breach, misreading consent as a refusal costs one session of measurement.
 */
export function maskFromCookieHeader(header: string | null | undefined): number {
  if (header === null || header === undefined) return CONSENT_DEFAULT;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;

    const raw = part.slice(separator + 1).trim();

    // The whole value has to be digits. `Number.parseInt` stops at the first character
    // it does not understand, so `3.5.1` and `3junk` both parse as 3 — a corrupted or
    // hand-edited cookie would read as valid consent, which is the wrong direction to
    // fail in. Anything that is not exactly a small integer means "no choice recorded".
    if (!/^\d{1,2}$/.test(raw)) return CONSENT_DEFAULT;

    const parsed = Number.parseInt(raw, 10);
    return parsed >= 0 && parsed <= 15 ? parsed : CONSENT_DEFAULT;
  }

  return CONSENT_DEFAULT;
}

export function hasChosen(header: string | null | undefined): boolean {
  return (header ?? '').includes(`${COOKIE_NAME}=`);
}

export function allowsAnalytics(mask: number): boolean {
  return (mask & CONSENT_BIT.analytics) !== 0;
}

/** The three choices the banner and the privacy page offer. */
export type ConsentChoice = 'necessary' | 'analytics' | 'all';

const CHOICE_CATEGORIES: Readonly<Record<ConsentChoice, readonly ConsentCategory[]>> = {
  necessary: [],
  analytics: ['analytics'],
  all: ['analytics', 'personalisation'],
};

/**
 * Turn a submitted choice into a mask.
 *
 * An unrecognised value resolves to necessary-only, so a malformed or forged request
 * can only ever reduce what is collected.
 */
export function maskForChoice(choice: string): number {
  const known = (Object.keys(CHOICE_CATEGORIES) as ConsentChoice[]).find((c) => c === choice);
  return known === undefined ? CONSENT_DEFAULT : maskOf(CHOICE_CATEGORIES[known]);
}

/**
 * The `Set-Cookie` value.
 *
 * Deliberately **not** `HttpOnly`. The client beacon has to read this to decide whether
 * to measure at all, and a flag it cannot read would mean measuring first and asking
 * later. The cookie carries a four-bit preference and no identifier: it is not a
 * credential, and nothing is protected by hiding it from the page.
 */
export function setCookieValue(mask: number, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${String(mask)}`,
    'Path=/',
    `Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
