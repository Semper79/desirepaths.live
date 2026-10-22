import { beforeEach, describe, expect, it } from 'vitest';
import { resetMetricSink } from '@morph/metrics';
import worker from '../src/worker';
import { consentMaskFromCookie } from '../src/lib/consent-cookie';
import { VisitorIdentity, type FoldableEvent } from '@morph/core';
import { enrich, hourOfWeek } from '../src/lib/enrich';

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
  // The header the Cloudflare edge sets. `x-real-ip` used to be read here and is now
  // deliberately ignored — see the forged-header case below, which is D34's regression test.
  'cf-connecting-ip': '203.0.113.7',
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

/**
 * The Worker, driven the way the runtime drives it.
 *
 * `app.inject` is gone with Fastify (D31). A Worker's entry point is a plain function over
 * (Request, Env, ExecutionContext), so a test needs no harness at all — which is a real
 * gain: what runs here is what runs in production, rather than a framework's simulation
 * of a request.
 */

/** Captures data points instead of writing them. */
function capturingDataset() {
  const points: { blobs?: unknown[]; doubles?: number[] }[] = [];
  return {
    points,
    writeDataPoint(event?: { blobs?: unknown[]; doubles?: number[] }) {
      if (event !== undefined) points.push(event);
    },
  };
}

/**
 * A SESSIONS namespace that records what the collector handed it.
 *
 * Deliberately a capture rather than a throw, unlike the counters: the ingest path is
 * supposed to reach this, and what it sends — grouped by session, folded per event — is a
 * contract worth asserting. The counters stay unreachable, which is now a stronger
 * statement than it was: only the session object may write to the posteriors' source.
 */
function recordingSessions() {
  const calls: { sessionId: string; events: FoldableEvent[] }[] = [];

  return {
    calls,
    idFromName(name: string): DurableObjectId {
      // `DurableObjectId` is three members, so this is the real interface rather than a
      // cast past it. The id only has to round-trip back to the name for these assertions;
      // nothing here exercises Cloudflare's hashing.
      return {
        name,
        toString: () => name,
        equals: (other: DurableObjectId) => other.toString() === name,
      };
    },
    get(id: DurableObjectId) {
      const sessionId = String(id);
      return {
        record(events: FoldableEvent[]) {
          calls.push({ sessionId, events });
          return Promise.resolve();
        },
      };
    },
  };
}

/** A limiter that permits everything until a case says otherwise. */
function fakeLimiter() {
  return {
    calls: [] as string[],
    allow: true,
    limit(options: { key: string }) {
      this.calls.push(options.key);
      return Promise.resolve({ success: this.allow });
    },
  };
}

function buildEnv(over: Record<string, unknown> = {}) {
  return {
    EVENTS: capturingDataset(),
    METRICS: capturingDataset(),
    INGEST_LIMITER: fakeLimiter(),
    ANON_ID_PEPPER: PEPPER,
    MORPH_PUBLIC_URL: 'https://' + SELF,
    MORPH_TIMEZONE: 'Europe/Rome',
    // Configured by default, because almost every case here is about something else and a
    // collector with no controller refuses every beacon (D4). The refusal has its own
    // case below rather than being the implicit state of the whole file.
    MORPH_CONTROLLER_NAME: 'Example Operator Srl',
    MORPH_CONTROLLER_ADDRESS: 'Via Esempio 1, 24100 Bergamo, Italy',
    MORPH_CONTROLLER_EMAIL: 'privacy@morph.example',
    SESSIONS: recordingSessions(),
    ...over,
  };
}

/** `cf` cannot be set through the Request constructor, so it is attached afterwards. */
function beacon(
  body: unknown,
  headers: Record<string, string> = BROWSER_HEADERS,
  country = 'IT',
): Request {
  const request = new Request('https://ingest.example/i', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, 'cf', { value: { country }, configurable: true });
  return request;
}

/**
 * A real `ExecutionContext`, not a cast.
 *
 * The handler only reaches `waitUntil` and `passThroughOnException`, so it would have been
 * shorter to stub those two and assert the rest away. Everything the interface also
 * declares is implemented as a throw instead, which costs four lines and buys the thing an
 * assertion would have destroyed: if this Worker ever starts using `tracing` or `abort`,
 * the test says so rather than silently handing it `undefined`.
 */
/**
 * Deferred work, collected so a case can wait for it.
 *
 * The collector hands the session fold to `waitUntil` on purpose — the beacon cannot act
 * on whether it succeeded. A test that ignored it would assert against a fan-out that had
 * not happened yet and pass or fail on timing.
 */
const deferred: Promise<unknown>[] = [];

async function settleDeferred(): Promise<void> {
  await Promise.all(deferred.splice(0, deferred.length));
}

const ctx: ExecutionContext = {
  waitUntil(promise: Promise<unknown>) {
    deferred.push(promise);
  },
  passThroughOnException() {
    // The handler catches its own errors on purpose (D31). If this fires, an exception
    // reached the runtime and the collector answered with whatever Cloudflare decided
    // instead of the 503 a retry queue understands.
    throw new Error('the collector must never pass an exception through');
  },
  abort() {
    throw new Error('the collector never aborts its own invocation');
  },
  get exports(): never {
    throw new Error('the collector has no entrypoints to call');
  },
  get tracing(): never {
    throw new Error('tracing is not wired in these tests');
  },
  props: {},
};

/** The published event, decoded back out of its data point. Mirrors the row contract. */
function publishedEvent(env: ReturnType<typeof buildEnv>, at = 0) {
  const point = env.EVENTS.points[at];
  const blobs = point?.blobs ?? [];
  return {
    type: blobs[0] as string,
    anonId: blobs[1] as string,
    path: blobs[3] as string,
    device: blobs[4] as string,
    country: blobs[5] as string,
    referrerClass: blobs[6] as string,
    consentMask: point?.doubles?.[2],
  };
}

describe('POST /i', () => {
  let env: ReturnType<typeof buildEnv>;

  beforeEach(() => {
    env = buildEnv();
    deferred.length = 0;
    // Back to the null sink between cases, so an observation from one cannot be counted
    // by the next. The Worker installs the real one itself on every request.
    resetMetricSink();
  });

  async function send(
    body: unknown = { events: [clientEvent()] },
    headers: Record<string, string> = BROWSER_HEADERS,
  ): Promise<Response> {
    return worker.fetch(beacon(body, headers), env, ctx);
  }

  it('accepts a valid beacon with 202 and an empty body', async () => {
    const response = await send();

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(env.EVENTS.points).toHaveLength(1);
  });

  it('publishes the enriched event, not the client payload', async () => {
    await send({ events: [clientEvent()], referrer: 'https://chatgpt.com/c/1' });

    const published = publishedEvent(env);
    expect(published.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(published.referrerClass).toBe('ai_agent');
    expect(published.country).toBe('IT');
    expect(published.consentMask).toBe(3);
  });

  it('takes the country from the edge, not from a header a client can set', async () => {
    // x-country used to carry this and was set by Caddy. A client sending one is now
    // simply ignored: request.cf.country is the edge's own geolocation.
    await send({ events: [clientEvent()] }, { ...BROWSER_HEADERS, 'x-country': 'US' });

    expect(publishedEvent(env).country).toBe('IT');
  });

  it('rejects a malformed body with 400', async () => {
    const response = await send({ events: 'not an array' });

    expect(response.status).toBe(400);
    expect(env.EVENTS.points).toHaveLength(0);
  });

  it('rejects unparseable JSON with 400 rather than throwing', async () => {
    const request = new Request('https://ingest.example/i', {
      method: 'POST',
      headers: BROWSER_HEADERS,
      body: '{ not json',
    });
    Object.defineProperty(request, 'cf', { value: { country: 'IT' } });

    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(400);
  });

  it('accepts a batch whose every event was rejected, without publishing', async () => {
    const response = await send({ events: [clientEvent({ type: 'scroll_depth', value: 900 })] });

    expect(response.status).toBe(202);
    expect(env.EVENTS.points).toHaveLength(0);
  });

  it('refuses a body larger than the cap before allocating it', async () => {
    // Content-Length is a claim; the cap is enforced on the bytes actually read. A Worker
    // has 128 MB, and .text() on an unbounded body is how it runs out of them.
    const huge = 'x'.repeat(300 * 1024);
    const request = new Request('https://ingest.example/i', {
      method: 'POST',
      headers: BROWSER_HEADERS,
      body: JSON.stringify({ padding: huge }),
    });
    Object.defineProperty(request, 'cf', { value: { country: 'IT' } });

    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(413);
  });

  it('rate-limits on the derived anonymous id, and says when to retry', async () => {
    env.INGEST_LIMITER.allow = false;
    const response = await send();

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(env.EVENTS.points).toHaveLength(0);

    // Keyed on the anonymous id, not on an address: the limiter never sees an IP.
    expect(env.INGEST_LIMITER.calls[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('limits per visitor, not globally', async () => {
    await send();
    await send(
      { events: [clientEvent()] },
      { ...BROWSER_HEADERS, 'cf-connecting-ip': '198.51.100.9' },
    );

    const [first, second] = env.INGEST_LIMITER.calls;
    expect(first).not.toBe(second);
  });

  it('ignores a forged x-real-ip, and identifies by cf-connecting-ip', async () => {
    // D34's regression test, and the reason the port touched this file at all.
    //
    // The Fastify version read x-real-ip, which Caddy filled from the TCP peer. Behind
    // Cloudflare that peer is a PoP, so every visitor through one datacentre would have
    // hashed to the same anonymous id and shared one rate-limit bucket. The forged
    // headers must change nothing here; the edge header must change everything.
    await send(
      { events: [clientEvent()] },
      { ...BROWSER_HEADERS, 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.2' },
    );
    const withForged = publishedEvent(env).anonId;

    env.EVENTS.points.length = 0;
    await send();
    expect(publishedEvent(env).anonId, 'forged headers must not move the identity').toBe(
      withForged,
    );

    env.EVENTS.points.length = 0;
    await send(
      { events: [clientEvent()] },
      { ...BROWSER_HEADERS, 'cf-connecting-ip': '198.51.100.9' },
    );
    expect(publishedEvent(env).anonId, 'the edge header must move it').not.toBe(withForged);
  });

  it('treats a visitor with no consent cookie as necessary-only', async () => {
    const { cookie, ...noCookie } = BROWSER_HEADERS;
    void cookie;
    await send({ events: [clientEvent()] }, noCookie);

    expect(publishedEvent(env).consentMask).toBe(1);
  });

  it('records the outcome as a metric rather than a log line', async () => {
    // Read from the METRICS dataset rather than from a sink installed here, because the
    // Worker installs its own on every request and would overwrite one this test set —
    // which it should, since that is the only moment the binding exists. The first version
    // of this case asserted against a MemorySink and failed for exactly that reason.
    await send();
    await send({ events: 'not an array' });

    const outcomes = env.METRICS.points
      .filter((p) => p.blobs?.[0] === 'morph_ingest_requests_total')
      .map((p) => p.blobs?.[2]);

    expect(outcomes).toEqual(['accepted', 'rejected']);
  });

  it('hands the session its events, keyed on the session id', async () => {
    await send();
    await settleDeferred();

    expect(env.SESSIONS.calls).toHaveLength(1);
    expect(env.SESSIONS.calls[0]?.sessionId).toBe('018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9e');
    expect(env.SESSIONS.calls[0]?.events).toHaveLength(1);
  });

  it('derives the context bucket rather than passing the raw context through', async () => {
    // Bucketing is a decision about the covariate space and `packages/core` owns it. The
    // fold groups by what it is handed, so if this arrived un-bucketed every session would
    // land in its own posterior cell and Thompson sampling would never have enough data.
    await send();
    await settleDeferred();

    const folded = env.SESSIONS.calls[0]?.events[0];
    expect(folded?.contextBucket).toMatch(/^phone\|/);
  });

  it('groups a replayed batch by session rather than merging it', async () => {
    // A beacon is normally one session's flush, but an offline queue can replay two. Sending
    // them as one would merge a visitor's morning into their afternoon.
    await send({
      events: [clientEvent(), clientEvent({ sessionId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9f' })],
    });
    await settleDeferred();

    expect(env.SESSIONS.calls).toHaveLength(2);
    expect(new Set(env.SESSIONS.calls.map((c) => c.sessionId)).size).toBe(2);
  });

  it('sends one call per session, not one per event', async () => {
    await send({ events: [clientEvent(), clientEvent(), clientEvent()] });
    await settleDeferred();

    expect(env.SESSIONS.calls).toHaveLength(1);
    expect(env.SESSIONS.calls[0]?.events).toHaveLength(3);
  });

  it('folds nothing when the batch was wholly rejected', async () => {
    await send({ events: [clientEvent({ type: 'scroll_depth', value: 900 })] });
    await settleDeferred();

    expect(env.SESSIONS.calls).toHaveLength(0);
  });

  it('refuses every beacon when no data controller is configured', async () => {
    // D4, enforced rather than documented. Art. 13 requires the visitor to be told who is
    // responsible before any processing, so a deployment that cannot name a controller
    // does not get to measure anybody. /privacy says exactly this in the same state, and
    // the sentence there is only true because of this refusal.
    env = buildEnv({
      MORPH_CONTROLLER_NAME: undefined,
      MORPH_CONTROLLER_ADDRESS: undefined,
      MORPH_CONTROLLER_EMAIL: undefined,
    });

    const response = await send();

    expect(response.status).toBe(503);
    expect(env.EVENTS.points).toHaveLength(0);
    // An hour, not five seconds: this is fixed by an operator editing configuration, not
    // by a transient blip, and a client retrying every five seconds helps nobody.
    expect(response.headers.get('retry-after')).toBe('3600');
  });

  it('refuses a partially configured controller, rather than publishing half a notice', async () => {
    // A name with no contact address satisfies nothing — Art. 13 wants both — so a
    // half-filled configuration is treated as none at all.
    env = buildEnv({ MORPH_CONTROLLER_EMAIL: undefined });

    expect((await send()).status).toBe(503);
    expect(env.EVENTS.points).toHaveLength(0);
  });

  it('refuses a controller whose contact address is not an address', async () => {
    env = buildEnv({ MORPH_CONTROLLER_EMAIL: 'not-an-email' });

    expect((await send()).status).toBe(503);
  });

  it('refuses a method other than POST', async () => {
    const request = new Request('https://ingest.example/i', { method: 'GET' });
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('health and readiness', () => {
  const ok = buildEnv();

  it('is healthy', async () => {
    const health = await worker.fetch(new Request('https://ingest.example/health'), ok, ctx);
    expect(health.status).toBe(200);
  });

  it('is ready with a real pepper', async () => {
    const ready = await worker.fetch(new Request('https://ingest.example/ready'), ok, ctx);
    expect(ready.status).toBe(200);
  });

  it('is not ready without one, and says which variable', async () => {
    // A collector that accepts events while hashing every visitor to the same id is worse
    // than one that refuses them, because the damage is silent and retroactive. Naming the
    // variable matters as much as the status: "not ready" with no reason sends somebody
    // into the source at the worst possible moment.
    const weak = buildEnv({ ANON_ID_PEPPER: 'short' });
    const ready = await worker.fetch(new Request('https://ingest.example/ready'), weak, ctx);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, missing: ['ANON_ID_PEPPER'] });
  });

  it('is not ready without a data controller', async () => {
    const anonymous = buildEnv({
      MORPH_CONTROLLER_NAME: undefined,
      MORPH_CONTROLLER_ADDRESS: undefined,
      MORPH_CONTROLLER_EMAIL: undefined,
    });
    const ready = await worker.fetch(new Request('https://ingest.example/ready'), anonymous, ctx);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      ready: false,
      missing: ['MORPH_CONTROLLER_NAME', 'MORPH_CONTROLLER_ADDRESS', 'MORPH_CONTROLLER_EMAIL'],
    });
  });

  it('closes every other path', async () => {
    const response = await worker.fetch(new Request('https://ingest.example/admin'), ok, ctx);
    expect(response.status).toBe(404);
  });
});
