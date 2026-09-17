import { describe, expect, it } from 'vitest';
import {
  BOT_THRESHOLD,
  botScore,
  classifyReferrer,
  deviceClass,
  isBotUserAgent,
  viewportBucket,
} from '../src/lib/classify.js';

describe('deviceClass', () => {
  it('prefers client hints over the user agent', () => {
    // A desktop UA string with a mobile hint: the hint is the one that is not a decade
    // of accumulated lies.
    expect(
      deviceClass({ chUaMobile: '?1', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }),
    ).toBe('phone');
  });

  it('reads a Chromium tablet from the platform hint', () => {
    expect(deviceClass({ chUaMobile: '?0', chUaPlatform: '"Android"' })).toBe('tablet');
    expect(deviceClass({ chUaMobile: '?0', chUaPlatform: '"Windows"' })).toBe('desktop');
  });

  it('falls back to the user agent for browsers that send no hints', () => {
    expect(
      deviceClass({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148' }),
    ).toBe('phone');
    expect(deviceClass({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' })).toBe('tablet');
    expect(deviceClass({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Safari' })).toBe(
      'phone',
    );
    expect(deviceClass({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Safari' })).toBe('tablet');
    expect(deviceClass({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })).toBe(
      'desktop',
    );
  });

  it('recognises televisions', () => {
    expect(deviceClass({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux) AppleWebKit' })).toBe('tv');
  });

  it('recognises bots before anything else', () => {
    expect(deviceClass({ chUaMobile: '?1', userAgent: 'Googlebot/2.1' })).toBe('bot');
  });

  it('defaults to desktop with no information at all', () => {
    expect(deviceClass({})).toBe('desktop');
  });
});

describe('viewportBucket', () => {
  it('buckets by the breakpoints the design system uses', () => {
    expect(viewportBucket(320)).toBe('xs');
    expect(viewportBucket(479)).toBe('xs');
    expect(viewportBucket(480)).toBe('sm');
    expect(viewportBucket(767)).toBe('sm');
    expect(viewportBucket(768)).toBe('md');
    expect(viewportBucket(1023)).toBe('md');
    expect(viewportBucket(1024)).toBe('lg');
    expect(viewportBucket(1439)).toBe('lg');
    expect(viewportBucket(1440)).toBe('xl');
    expect(viewportBucket(3840)).toBe('xl');
  });
});

describe('classifyReferrer', () => {
  const SELF = 'morph.example';

  it('treats a missing referrer as direct', () => {
    expect(classifyReferrer(undefined, SELF)).toEqual({
      referrerClass: 'direct',
      source: 'direct',
    });
    expect(classifyReferrer('', SELF)).toEqual({ referrerClass: 'direct', source: 'direct' });
  });

  it('lets an explicit campaign tag win', () => {
    expect(classifyReferrer('https://www.google.com/', SELF, 'summer-launch')).toEqual({
      referrerClass: 'campaign',
      source: 'summer-launch',
    });
  });

  it('recognises internal navigation', () => {
    expect(classifyReferrer('https://morph.example/how-it-works', SELF).referrerClass).toBe(
      'internal',
    );
    expect(classifyReferrer('https://blog.morph.example/x', SELF).referrerClass).toBe('internal');
  });

  it('gives AI answer engines their own class', () => {
    expect(classifyReferrer('https://chatgpt.com/c/abc', SELF)).toEqual({
      referrerClass: 'ai_agent',
      source: 'chatgpt',
    });
    expect(classifyReferrer('https://www.perplexity.ai/search?q=x', SELF).referrerClass).toBe(
      'ai_agent',
    );
  });

  it('classifies search, social, email and the long tail', () => {
    expect(classifyReferrer('https://www.google.co.uk/search?q=secret', SELF)).toEqual({
      referrerClass: 'search',
      source: 'google',
    });
    expect(classifyReferrer('https://www.tiktok.com/@x/video/1', SELF).referrerClass).toBe(
      'social',
    );
    expect(classifyReferrer('https://t.co/abc', SELF).referrerClass).toBe('social');
    expect(classifyReferrer('https://mail.google.com/mail/u/0', SELF).referrerClass).toBe('email');
    expect(classifyReferrer('https://some-blog.dev/post', SELF)).toEqual({
      referrerClass: 'referral',
      source: 'some-blog',
    });
  });

  /**
   * A referrer URL can carry a search query, a private document title, or a session
   * token. None of it survives classification.
   */
  it('never returns anything but a bounded token', () => {
    const result = classifyReferrer(
      'https://www.google.com/search?q=very+private+thing&token=abc123',
      SELF,
    );
    expect(result.source).toBe('google');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('abc123');
  });

  it('treats a malformed referrer as direct rather than throwing', () => {
    expect(classifyReferrer('not a url', SELF).referrerClass).toBe('direct');
  });

  it('bounds and sanitises a hostile campaign tag', () => {
    const result = classifyReferrer(undefined, SELF, `<script>${'x'.repeat(200)}`);
    expect(result.source).toMatch(/^[a-z0-9_-]{1,32}$/);
  });

  it('falls back to a placeholder when nothing usable is left', () => {
    expect(classifyReferrer(undefined, SELF, '!!!').source).toBe('unknown');
  });
});

describe('bot detection', () => {
  it('recognises self-declared automation', () => {
    for (const ua of [
      'Googlebot/2.1 (+http://www.google.com/bot.html)',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Mozilla/5.0 HeadlessChrome/120.0.0.0',
      'facebookexternalhit/1.1',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
      expect(botScore({ userAgent: ua, hasCookies: false })).toBe(100);
    }
  });

  it('leaves a plausible browser well below the threshold', () => {
    const score = botScore({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148',
      acceptLanguage: 'it-IT,it;q=0.9',
      secFetchSite: 'same-origin',
      hasCookies: true,
      viewportWidth: 390,
      eventRate: 1.2,
    });
    expect(score).toBeLessThan(BOT_THRESHOLD);
  });

  it('scores a headerless HTTP client above the threshold', () => {
    expect(botScore({ hasCookies: false })).toBeGreaterThanOrEqual(BOT_THRESHOLD);
  });

  it('accumulates weak signals', () => {
    const base = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hasCookies: true,
      viewportWidth: 1440,
    };
    const clean = botScore({ ...base, acceptLanguage: 'en', secFetchSite: 'none', eventRate: 1 });
    const suspicious = botScore({ ...base, eventRate: 1 });
    expect(suspicious).toBeGreaterThan(clean);
  });

  it('catches a well-disguised client through its behaviour', () => {
    const disguised = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15',
      acceptLanguage: 'en-US',
      secFetchSite: 'same-origin',
      hasCookies: true,
      viewportWidth: 1440,
    };
    expect(botScore({ ...disguised, eventRate: 1 })).toBeLessThan(BOT_THRESHOLD);
    expect(botScore({ ...disguised, eventRate: 50 })).toBeGreaterThan(
      botScore({ ...disguised, eventRate: 1 }),
    );
  });

  it('flags a fabricated viewport', () => {
    const base = {
      userAgent: 'Mozilla/5.0 (X11)',
      acceptLanguage: 'en',
      secFetchSite: 'none',
      hasCookies: true,
    };
    expect(botScore({ ...base, viewportWidth: 0 })).toBeGreaterThan(
      botScore({ ...base, viewportWidth: 1280 }),
    );
    expect(botScore({ ...base, viewportWidth: 99_999 })).toBeGreaterThan(
      botScore({ ...base, viewportWidth: 1280 }),
    );
  });

  it('never exceeds 100', () => {
    expect(botScore({ hasCookies: false, viewportWidth: 0, eventRate: 100 })).toBe(100);
  });

  it('scores a moderate event rate between the two extremes', () => {
    const base = {
      userAgent: 'Mozilla/5.0 (X11)',
      acceptLanguage: 'en',
      secFetchSite: 'none',
      hasCookies: true,
      viewportWidth: 1280,
    };
    const low = botScore({ ...base, eventRate: 1 });
    const mid = botScore({ ...base, eventRate: 10 });
    const high = botScore({ ...base, eventRate: 30 });
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });
});
