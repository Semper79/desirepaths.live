import { describe, expect, it } from 'vitest';
import {
  BASELINE_ASSIGNMENT,
  SURFACES,
  VisitorIdentity,
  checkContrast,
  tokensToStyleAttribute,
  variantId,
} from '@morph/core';
import { checkTokenContract } from '@morph/ui';
import {
  consentFrom,
  decodeContext,
  edgeBotScore,
  encodeContext,
  buildContext,
  hourOfWeek,
} from '../src/lib/request-context.js';
import { motionAllowed, payloadOf, sectionOrder, tokensFor } from '../src/lib/render.js';
import { STATIC_ROUTES, publishedContent, siteIdentity } from '../src/lib/site.js';

/** A minimal `Headers`-like object, so these tests need no framework. */
const headersOf = (entries: Readonly<Record<string, string>>) => ({
  get: (name: string): string | null => entries[name.toLowerCase()] ?? null,
});

describe('edge bot scoring', () => {
  /**
   * Deliberately biased towards calling something a crawler. A false positive costs
   * one human the baseline, which is a good page; a false negative lets a crawler
   * index a bandit-chosen variant, which is the failure the rule exists to prevent.
   */
  it('is certain about self-declared agents, including AI crawlers', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
      'curl/8.4.0',
    ]) {
      expect(edgeBotScore(headersOf({ 'user-agent': ua })), ua).toBe(100);
    }
  });

  it('treats a missing user agent as certainly automated', () => {
    expect(edgeBotScore(headersOf({}))).toBe(100);
  });

  it('leaves a plausible browser well below the threshold', () => {
    const score = edgeBotScore(
      headersOf({
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile',
        'accept-language': 'it-IT,it;q=0.9',
        'sec-fetch-mode': 'navigate',
        accept: 'text/html,application/xhtml+xml',
      }),
    );
    expect(score).toBeLessThan(60);
  });

  it('accumulates weak signals towards the threshold', () => {
    const bare = edgeBotScore(headersOf({ 'user-agent': 'Mozilla/5.0' }));
    const rich = edgeBotScore(
      headersOf({
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en',
        'sec-fetch-mode': 'navigate',
        accept: 'text/html',
      }),
    );
    expect(bare).toBeGreaterThan(rich);
  });

  it('never leaves the 0-100 range', () => {
    for (const headers of [{}, { 'user-agent': 'x', accept: 'text/html' }]) {
      const score = edgeBotScore(headersOf(headers));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe('consent from the cookie', () => {
  it('defaults to necessary-only', () => {
    expect(consentFrom(null)).toBe(1);
    expect(consentFrom('other=1')).toBe(1);
  });

  it('reads a valid mask', () => {
    expect(consentFrom('morph_consent=7')).toBe(7);
    expect(consentFrom('a=1; morph_consent=3')).toBe(3);
  });

  it('falls back on a malformed or out-of-range value', () => {
    expect(consentFrom('morph_consent=nope')).toBe(1);
    expect(consentFrom('morph_consent=64')).toBe(1);
  });
});

describe('hourOfWeek', () => {
  it('is Monday 00:00 = 0, in the operator timezone', () => {
    // 2026-08-24 is a Monday; 14:30 UTC is 16:30 in Rome.
    expect(hourOfWeek(new Date('2026-08-24T14:30:00.000Z'), 'Europe/Rome')).toBe(16);
  });

  it('uses the operator timezone rather than UTC', () => {
    expect(hourOfWeek(new Date('2026-08-24T23:30:00.000Z'), 'Europe/Rome')).toBe(25);
  });

  it('stays in range across a whole week', () => {
    for (let h = 0; h < 24 * 8; h += 1) {
      const value = hourOfWeek(new Date(Date.UTC(2026, 7, 24, h)), 'Europe/Rome');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(167);
    }
  });
});

describe('buildContext', () => {
  const identity = new VisitorIdentity('p'.repeat(64));
  const options = {
    identity,
    selfHost: 'morph.example',
    timezone: 'Europe/Rome',
    now: new Date('2026-08-24T14:30:00.000Z'),
    country: 'it',
    ip: '203.0.113.7',
  };

  it('derives an identifier and a valid context', async () => {
    const result = await buildContext(
      {
        url: 'https://morph.example/',
        headers: headersOf({
          'user-agent': 'Mozilla/5.0 (iPhone) Mobile',
          'accept-language': 'it-IT,it;q=0.9',
          'sec-ch-ua-mobile': '?1',
          referer: 'https://www.tiktok.com/@x',
          cookie: 'morph_consent=3',
        }),
      },
      options,
    );

    expect(result.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.context.device).toBe('phone');
    expect(result.context.referrerClass).toBe('social');
    expect(result.context.source).toBe('tiktok');
    expect(result.context.country).toBe('IT');
    expect(result.context.consentMask).toBe(3);
    expect(result.context.locale).toBe('it');
  });

  it('classifies an AI answer engine as its own channel', async () => {
    const result = await buildContext(
      { url: 'https://morph.example/', headers: headersOf({ referer: 'https://chatgpt.com/c/1' }) },
      options,
    );
    expect(result.context.referrerClass).toBe('ai_agent');
  });

  it('treats a self-referral as internal', async () => {
    const result = await buildContext(
      {
        url: 'https://morph.example/',
        headers: headersOf({ referer: 'https://morph.example/how-it-works' }),
      },
      options,
    );
    expect(result.context.referrerClass).toBe('internal');
  });

  it('survives a malformed referrer', async () => {
    const result = await buildContext(
      { url: 'https://morph.example/', headers: headersOf({ referer: 'not a url' }) },
      options,
    );
    expect(result.context.referrerClass).toBe('direct');
  });

  it('is stable for the same visitor within a day', async () => {
    const request = {
      url: 'https://morph.example/',
      headers: headersOf({ 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' }),
    };
    const a = await buildContext(request, options);
    const b = await buildContext(request, options);
    expect(a.anonId).toBe(b.anonId);
  });

  it('recognises a returning visitor from the first-party marker', async () => {
    const result = await buildContext(
      { url: 'https://morph.example/', headers: headersOf({ cookie: 'morph_seen=1' }) },
      options,
    );
    expect(result.context.returning).toBe(true);
  });
});

describe('context encoding', () => {
  it('round-trips', async () => {
    const { context } = await buildContext(
      { url: 'https://morph.example/', headers: headersOf({ 'user-agent': 'Mozilla/5.0' }) },
      {
        identity: new VisitorIdentity('p'.repeat(64)),
        selfHost: 'morph.example',
        timezone: 'Europe/Rome',
        now: new Date('2026-08-24T14:30:00.000Z'),
        country: 'IT',
        ip: '1.2.3.4',
      },
    );
    expect(decodeContext(encodeContext(context))).toEqual(context);
  });

  it('rejects a missing, malformed or invalid header rather than guessing', () => {
    expect(decodeContext(null)).toBeNull();
    expect(decodeContext('not json')).toBeNull();
    expect(decodeContext(JSON.stringify({ device: 'toaster' }))).toBeNull();
  });
});

describe('rendering an assignment', () => {
  it('produces a complete, renderable token bag for the baseline', () => {
    const tokens = tokensFor(BASELINE_ASSIGNMENT);
    expect(checkTokenContract(tokens).missing).toEqual([]);
    expect(() => tokensToStyleAttribute(tokens)).not.toThrow();
  });

  /**
   * The whole point of the token boundary: whatever the optimiser picks, the page it
   * produces is renderable and legible. Every shipped combination is checked in
   * `@morph/ui`; this checks the composition path the renderer actually takes.
   */
  it('keeps text legible on the background for every palette', () => {
    for (const variant of SURFACES['theme.palette'].variants) {
      const assignment = { ...BASELINE_ASSIGNMENT, 'theme.palette': variant.id };
      const tokens = tokensFor(assignment);
      const result = checkContrast(
        tokens['--color-text'] ?? '',
        tokens['--color-bg'] ?? '',
        'body',
      );
      expect(result.passes, `${variant.id}: ${String(result.ratio)}:1`).toBe(true);
    }
  });

  it('lets a later surface override an earlier one', () => {
    // `cta.style` is composed last and owns the CTA colours.
    const ctaStyle = SURFACES['cta.style'].variants.find((v) => v.id === 'cta.style#block');
    const assignment = {
      ...BASELINE_ASSIGNMENT,
      'cta.style': ctaStyle?.id ?? BASELINE_ASSIGNMENT['cta.style'],
    };
    expect(tokensFor(assignment)['--cta-bg']).toBe('#ffffff');
  });

  it('falls back to the baseline variant when an assignment names something unknown', () => {
    const broken = { ...BASELINE_ASSIGNMENT, 'hero.headline': variantId('hero.headline#gone') };
    // Rather than throwing or rendering undefined, it renders the baseline copy.
    expect(payloadOf(broken, 'hero.headline').text).toBe(
      payloadOf(BASELINE_ASSIGNMENT, 'hero.headline').text,
    );
  });

  it('returns a full section permutation with the hero first', () => {
    const order = sectionOrder(BASELINE_ASSIGNMENT);
    expect(order[0]).toBe('hero');
    expect(new Set(order).size).toBe(order.length);
  });

  it('reports whether motion is permitted', () => {
    expect(motionAllowed(BASELINE_ASSIGNMENT)).toBe(true);
    const still = {
      ...BASELINE_ASSIGNMENT,
      'motion.intensity': variantId('motion.intensity#none'),
    };
    expect(motionAllowed(still)).toBe(false);
  });
});

describe('site configuration', () => {
  it('exposes an identity with an absolute origin', () => {
    const site = siteIdentity();
    expect(() => new URL(site.origin)).not.toThrow();
    expect(site.origin.endsWith('/')).toBe(false);
  });

  it('publishes content with the source attribution the schema requires', () => {
    for (const item of publishedContent()) {
      expect(item.sources.length).toBeGreaterThan(0);
      for (const source of item.sources) expect(() => new URL(source.url)).not.toThrow();
    }
  });

  it('lists static routes as paths, not URLs', () => {
    for (const route of STATIC_ROUTES) {
      expect(route.path.startsWith('/')).toBe(true);
      expect(route.priority).toBeGreaterThan(0);
      expect(route.priority).toBeLessThanOrEqual(1);
    }
  });
});
