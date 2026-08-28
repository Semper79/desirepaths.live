import { describe, expect, it } from 'vitest';
import { CONSENT_BIT, categoriesOf } from '@morph/core';
import {
  allowsAnalytics,
  COOKIE_NAME,
  hasChosen,
  maskForChoice,
  maskFromCookieHeader,
  POLICY_VERSION,
  setCookieValue,
} from '../src/lib/consent.js';

/**
 * Consent is the one place where the safe failure direction is always the same: read
 * less consent than was given rather than more. Misreading a refusal as agreement is a
 * breach; misreading agreement as a refusal costs one session of measurement.
 */

describe('reading the cookie', () => {
  it('defaults to necessary-only when there is nothing to read', () => {
    expect(maskFromCookieHeader(null)).toBe(CONSENT_BIT.necessary);
    expect(maskFromCookieHeader(undefined)).toBe(CONSENT_BIT.necessary);
    expect(maskFromCookieHeader('')).toBe(CONSENT_BIT.necessary);
    expect(maskFromCookieHeader('other=1; another=2')).toBe(CONSENT_BIT.necessary);
  });

  it('reads a valid mask wherever it appears in the header', () => {
    expect(maskFromCookieHeader(`${COOKIE_NAME}=3`)).toBe(3);
    expect(maskFromCookieHeader(`a=1; ${COOKIE_NAME}=7; b=2`)).toBe(7);
    expect(maskFromCookieHeader(` ${COOKIE_NAME} = 3 `)).toBe(3);
  });

  it('falls back to necessary-only on anything malformed', () => {
    for (const header of [
      `${COOKIE_NAME}=`,
      `${COOKIE_NAME}=abc`,
      `${COOKIE_NAME}=-1`,
      `${COOKIE_NAME}=99`,
      `${COOKIE_NAME}=3.5.1`,
      COOKIE_NAME,
    ]) {
      expect(maskFromCookieHeader(header), header).toBe(CONSENT_BIT.necessary);
    }
  });

  it('is not fooled by a cookie whose name merely ends the same way', () => {
    expect(maskFromCookieHeader('not_morph_consent=15')).toBe(CONSENT_BIT.necessary);
  });

  it('distinguishes "chose necessary-only" from "has not chosen"', () => {
    // Both read as mask 1, but only one of them should stop the banner appearing.
    expect(hasChosen(`${COOKIE_NAME}=1`)).toBe(true);
    expect(hasChosen('other=1')).toBe(false);
    expect(hasChosen(null)).toBe(false);
    expect(maskFromCookieHeader(`${COOKIE_NAME}=1`)).toBe(maskFromCookieHeader(null));
  });
});

describe('interpreting a choice', () => {
  it('maps the three offered choices', () => {
    expect(categoriesOf(maskForChoice('necessary'))).toEqual(['necessary']);
    expect(categoriesOf(maskForChoice('analytics'))).toEqual(['necessary', 'analytics']);
    expect(categoriesOf(maskForChoice('all'))).toEqual([
      'necessary',
      'analytics',
      'personalisation',
    ]);
  });

  it('resolves anything unrecognised to necessary-only', () => {
    // A forged or malformed submission can only ever reduce what is collected.
    for (const choice of ['', 'everything', 'marketing', '[object Object]', '15']) {
      expect(maskForChoice(choice), choice).toBe(CONSENT_BIT.necessary);
    }
  });

  it('never grants marketing consent, which nothing asks for', () => {
    for (const choice of ['necessary', 'analytics', 'all']) {
      expect(categoriesOf(maskForChoice(choice))).not.toContain('marketing');
    }
  });

  it('gates analytics on the analytics bit alone', () => {
    expect(allowsAnalytics(maskForChoice('necessary'))).toBe(false);
    expect(allowsAnalytics(maskForChoice('analytics'))).toBe(true);
    expect(allowsAnalytics(maskForChoice('all'))).toBe(true);
  });
});

describe('the Set-Cookie value', () => {
  it('carries the attributes the privacy design promises', () => {
    const value = setCookieValue(3, true);
    expect(value).toContain(`${COOKIE_NAME}=3`);
    expect(value).toContain('Path=/');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Secure');
  });

  it('omits Secure over plain http, or the cookie is silently dropped in development', () => {
    expect(setCookieValue(3, false)).not.toContain('Secure');
  });

  /**
   * Deliberately not HttpOnly: the client beacon has to read this to decide whether to
   * measure at all. A flag it cannot read would mean measuring first and asking later.
   */
  it('is readable by the page, because the beacon depends on reading it', () => {
    expect(setCookieValue(3, true)).not.toContain('HttpOnly');
  });

  it('round-trips through the reader', () => {
    for (const mask of [1, 3, 7]) {
      expect(maskFromCookieHeader(setCookieValue(mask, true).split(';')[0])).toBe(mask);
    }
  });
});

describe('the policy version', () => {
  it('is recorded, because a consent record must say what was shown', () => {
    // Under GDPR the operator must be able to demonstrate what a person was told when
    // they agreed. Storing only the answer does not answer that.
    expect(POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d+$/);
  });
});
