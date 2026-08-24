import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { MemorySink } from '../src/lib/producer.js';
import { CountingMetrics, consentMaskFromCookie } from '../src/routes/ingest.js';
import { VisitorIdentity } from '@morph/core';
import { enrich, hourOfWeek } from '../src/lib/enrich.js';
import { loadEnv } from '../src/env.js';

const PEPPER = 'p'.repeat(64);
const NOW = new Date('2026-08-24T14:30:00.000Z'); // a Monday
const SELF = 'morph.example';

function clientEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    eventId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9d',
    ts: NOW.toISOString(),
    type: 'page_view',
    sessionId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9e',
    ctx: { viewportWidth: 390, depth: 1, returning: false, locale: 'it-IT' },
    path: '/',
    surfaces: ['hero.headline'],
    variants: ['hero.headline#v0'],
    assignmentHash: '12345678901234567',
    holdout: 0,
    ...over,
  };
}

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148',
  'accept-language': 'it-IT,it;q=0.9',
  'sec-fetch-site': 'same-origin',
  'sec-ch-ua-mobile': '?1',
  'x-real-ip': '203.0.113.7',
  'x-country': 'it',
  cookie: 'morph_consent=3',
  'content-type': 'application/json',
};

describe('hourOfWeek', () => {
  it('is Monday 00:00 = 0, in the operator timezone', () => {
    // 2026-08-24 is a Monday. 14:30 UTC is 16:30 in Rome (CEST).
    expect(hourOfWeek(new Date('2026-08-24T14:30:00.000Z'), 'Europe/Rome')).toBe(16);
  });

  it('advances a day at a time', () => {
    expect(hourOfWeek(new Date('2026-08-25T14:30:00.000Z'), 'Europe/Rome')).toBe(24 + 16);
    expect(hourOfWeek(new Date('2026-08-30T14:30:00.000Z'), 'Europe/Rome')).toBe(6 * 24 + 16);
  });

  it('uses the operator timezone rather than UTC', () => {
    // 23:30 UTC on Monday is already Tuesday in Rome.
    expect(hourOfWeek(new Date('2026-08-24T23:30:00.000Z'), 'Europe/Rome')).toBe(24 + 1);
  });

  it('stays inside the declared range for every hour of a week', () => {
    for (let h = 0; h < 24 * 8; h += 1) {
      const at = new Date(Date.UTC(2026, 7, 24, h));
      const value = hourOfWeek(at, 'Europe/Rome');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(167);
    }
  });
});

describe('consentMaskFromCookie', () => {
  it('defaults to necessary-only with no cookie', () => {
    expect(consentMaskFromCookie(undefined)).toBe(1);
    expect(consentMaskFromCookie('other=1')).toBe(1);
  });

  it('reads a valid mask', () => {
    expect(consentMaskFromCookie('morph_consent=7')).toBe(7);
    expect(consentMaskFromCookie('a=1; morph_consent=3; b=2')).toBe(3);
  });

  it('falls back to necessary-only on a malformed or out-of-range value', () => {
    expect(consentMaskFromCookie('morph_consent=abc')).toBe(1);
    expect(consentMaskFromCookie('morph_consent=99')).toBe(1);
    expect(consentMaskFromCookie('morph_consent=')).toBe(1);
  });
});

describe('enrich — the trust boundary', () => {
  const options = {
    identity: new VisitorIdentity(PEPPER),
    selfHost: SELF,
    timezone: 'Europe/Rome',
  };
  const meta = {
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (iPhone) Mobile',
    acceptLanguage: 'it-IT',
    secFetchSite: 'same-origin',
    chUaMobile: '?1',
    country: 'IT',
    hasCookies: true,
    consentMask: 3,
    now: NOW,
  };

  it('derives every identity field server-side', async () => {
    const result = await enrich(
      { events: [clientEvent()], referrer: 'https://www.tiktok.com/@x' },
      meta,
      options,
    );

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event?.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(event?.ctx.device).toBe('phone');
    expect(event?.ctx.referrerClass).toBe('social');
    expect(event?.ctx.source).toBe('tiktok');
    expect(event?.ctx.country).toBe('IT');
    expect(event?.consentMask).toBe(3);
  });

  it('accepts what the browser observed', async () => {
    const event = (await enrich({ events: [clientEvent()] }, meta, options)).events[0];
    expect(event?.ctx.viewport).toBe('xs'); // bucketed from 390
    expect(event?.ctx.depth).toBe(1);
    expect(event?.ctx.returning).toBe(false);
  });

  it('drops the region from the locale', async () => {
    const event = (await enrich({ events: [clientEvent()] }, meta, options)).events[0];
    expect(event?.ctx.locale).toBe('it');
  });

  it('ignores an identity a hostile client tries to assert', async () => {
    const forged = clientEvent();
    // A client that adds these fields is trying to choose its own identity. The schema
    // strips them, and even if it did not, enrichment overwrites them.
    Object.assign(forged, {
      anonId: 'f'.repeat(32),
      botScore: 0,
      consentMask: 15,
      ctx: {
        viewportWidth: 390,
        depth: 1,
        returning: false,
        locale: 'it',
        device: 'desktop',
        country: 'US',
      },
    });

    const event = (await enrich({ events: [forged] }, { ...meta, consentMask: 1 }, options))
      .events[0];
    expect(event?.anonId).not.toBe('f'.repeat(32));
    expect(event?.consentMask).toBe(1);
    expect(event?.ctx.device).toBe('phone');
    expect(event?.ctx.country).toBe('IT');
  });

  it('rejects a malformed body wholesale', async () => {
    const result = await enrich({ nope: true }, meta, options);
    expect(result.events).toEqual([]);
    expect(result.anonId).toBeNull();
    expect(result.rejected[0]?.index).toBe(-1);
  });

  it('keeps the good events when one is bad', async () => {
    const result = await enrich(
      {
        events: [
          clientEvent(),
          clientEvent({ type: 'scroll_depth', value: 400 }),
          clientEvent({ type: 'engagement', value: 1200 }),
        ],
      },
      meta,
      options,
    );
    expect(result.events).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reason).toContain('percentage');
  });

  it('attaches the user id only when the session is authenticated', async () => {
    const anonymous = (await enrich({ events: [clientEvent()] }, meta, options)).events[0];
    expect(anonymous?.userId).toBeUndefined();

    const authed = (
      await enrich(
        { events: [clientEvent()] },
        { ...meta, userId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9f' },
        options,
      )
    ).events[0];
    expect(authed?.userId).toBe('018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9f');
  });

  it('scores automated traffic and lets it through, marked', async () => {
    const result = await enrich(
      { events: [clientEvent()] },
      { ...meta, userAgent: 'Googlebot/2.1', acceptLanguage: undefined, hasCookies: false },
      options,
    );
    // Not rejected - excluded downstream by the views, which keeps the raw record honest.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.botScore).toBe(100);
  });
});

describe('POST /i', () => {
  let app: FastifyInstance;
  let sink: MemorySink;
  let metrics: CountingMetrics;

  beforeEach(async () => {
    sink = new MemorySink();
    metrics = new CountingMetrics();
    await sink.connect();
    app = buildServer({
      sink,
      pepper: PEPPER,
      selfHost: SELF,
      timezone: 'Europe/Rome',
      metrics,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid beacon with 202 and an empty body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: [clientEvent()] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('');
    expect(sink.published).toHaveLength(1);
    expect(metrics.acceptedTotal).toBe(1);
  });

  it('publishes the enriched event, not the client payload', async () => {
    await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: [clientEvent()], referrer: 'https://chatgpt.com/c/1' },
    });

    const published = sink.published[0];
    expect(published?.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(published?.ctx.referrerClass).toBe('ai_agent');
    expect(published?.ctx.country).toBe('IT');
    expect(published?.consentMask).toBe(3);
  });

  it('rejects a malformed body with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: 'not an array' },
    });
    expect(response.statusCode).toBe(400);
    expect(sink.published).toHaveLength(0);
    expect(metrics.rejectedTotal).toBe(1);
  });

  it('accepts a batch whose every event was rejected, without publishing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: [clientEvent({ type: 'scroll_depth', value: 900 })] },
    });
    expect(response.statusCode).toBe(202);
    expect(sink.published).toHaveLength(0);
    expect(metrics.rejectedTotal).toBe(1);
  });

  it('rate-limits a client that floods, and says when to retry', async () => {
    const send = async (): Promise<number> => {
      const r = await app.inject({
        method: 'POST',
        url: '/i',
        headers: BROWSER_HEADERS,
        payload: { events: [clientEvent()] },
      });
      return r.statusCode;
    };

    // Time is frozen, so nothing refills: the bucket's full capacity and no more.
    const codes: number[] = [];
    for (let i = 0; i < 65; i += 1) codes.push(await send());

    expect(codes.filter((c) => c === 202)).toHaveLength(60);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(metrics.rateLimitedTotal).toBeGreaterThan(0);

    const limited = await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: [clientEvent()] },
    });
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('limits per visitor, not globally', async () => {
    for (let i = 0; i < 61; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/i',
        headers: BROWSER_HEADERS,
        payload: { events: [clientEvent()] },
      });
    }
    const other = await app.inject({
      method: 'POST',
      url: '/i',
      headers: { ...BROWSER_HEADERS, 'x-real-ip': '198.51.100.9' },
      payload: { events: [clientEvent()] },
    });
    expect(other.statusCode).toBe(202);
  });

  it('returns 503 with a retry hint when the sink is unavailable', async () => {
    sink.failOnce();
    const response = await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: [clientEvent()] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(metrics.sinkFailureTotal).toBe(1);
  });

  it('does not trust a forged X-Forwarded-For over the proxy header', async () => {
    const withForged = await app.inject({
      method: 'POST',
      url: '/i',
      headers: { ...BROWSER_HEADERS, 'x-forwarded-for': '10.0.0.1' },
      payload: { events: [clientEvent()] },
    });
    expect(withForged.statusCode).toBe(202);

    const forgedId = sink.published.at(-1)?.anonId;
    sink.published.length = 0;

    await app.inject({
      method: 'POST',
      url: '/i',
      headers: BROWSER_HEADERS,
      payload: { events: [clientEvent()] },
    });
    // Same X-Real-IP, so the same visitor, regardless of the forwarded header.
    expect(sink.published.at(-1)?.anonId).toBe(forgedId);
  });

  it('treats a visitor with no consent cookie as necessary-only', async () => {
    const { cookie, ...noCookie } = BROWSER_HEADERS;
    void cookie;
    await app.inject({
      method: 'POST',
      url: '/i',
      headers: noCookie,
      payload: { events: [clientEvent()] },
    });
    expect(sink.published[0]?.consentMask).toBe(1);
  });
});

describe('health and readiness', () => {
  it('reports alive without touching a dependency', async () => {
    const sink = new MemorySink(); // deliberately not connected
    const app = buildServer({ sink, pepper: PEPPER, selfHost: SELF, timezone: 'Europe/Rome' });
    await app.ready();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });

    // Not ready: a liveness pass with a readiness fail is exactly the right state for a
    // healthy process whose downstream is unavailable.
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ready: false, checks: { sink: false } });

    await app.close();
  });

  it('reports ready once the sink is connected', async () => {
    const sink = new MemorySink();
    await sink.connect();
    const app = buildServer({ sink, pepper: PEPPER, selfHost: SELF, timezone: 'Europe/Rome' });
    await app.ready();

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    await app.close();
  });
});

describe('environment validation', () => {
  const valid = {
    NODE_ENV: 'production',
    MORPH_PUBLIC_URL: 'https://morph.example',
    ANON_ID_PEPPER: PEPPER,
    REDPANDA_BROKERS: 'a:9092,b:9092',
  };

  it('accepts a complete environment and splits the broker list', () => {
    const env = loadEnv(valid);
    expect(env.REDPANDA_BROKERS).toEqual(['a:9092', 'b:9092']);
    expect(env.PORT).toBe(3001);
  });

  it('refuses the placeholder pepper', () => {
    expect(() =>
      loadEnv({
        ...valid,
        ANON_ID_PEPPER: 'replace-with-openssl-rand-hex-32',
      }),
    ).toThrow(/placeholder/);
  });

  it('refuses a pepper too short to be a secret', () => {
    expect(() => loadEnv({ ...valid, ANON_ID_PEPPER: 'short' })).toThrow(/at least 32 characters/);
  });

  it('refuses the consent bypass in production', () => {
    expect(() => loadEnv({ ...valid, MORPH_DEV_BYPASS_CONSENT: '1' })).toThrow(
      /must not be set in production/,
    );
  });

  it('allows the consent bypass in development', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'development',
        MORPH_PUBLIC_URL: 'http://localhost:3000',
        MORPH_DEV_BYPASS_CONSENT: '1',
      }),
    ).not.toThrow();
  });

  it('refuses plaintext http in production', () => {
    expect(() => loadEnv({ ...valid, MORPH_PUBLIC_URL: 'http://morph.example' })).toThrow(
      /https in production/,
    );
  });

  it('names the variable that is wrong', () => {
    expect(() => loadEnv({ ...valid, REDPANDA_BROKERS: '' })).toThrow(/REDPANDA_BROKERS/);
  });
});
