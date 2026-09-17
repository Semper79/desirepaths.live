/**
 * The load test's payload, parsed by the schema the collector parses it with.
 *
 * `bench/ingest.js` claims 5,000 req/s on `POST /i`. That claim is only about ingest if the
 * requests are accepted: a batch the schema rejects gets a 400 without the route touching
 * the broker, which is *faster* than the real path and would flatter the number rather than
 * fail it. The k6 run guards this at runtime with `rejected_400: ['count==0']`, but that is
 * only discovered on the day somebody runs it — which, for a benchmark, is the day they
 * least want to be debugging a fixture.
 *
 * So the payload builder lives in `bench/payload.js` rather than inside the k6 script, and
 * this test parses what it produces. Schema drift is now a red gate, on the commit that
 * causes it.
 *
 * It lives in `apps/api` because `apps/api` owns `POST /i`; the load test is one more
 * client of that contract, and this sits beside the route's own tests.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { ClientBatchSchema } from '@morph/core';

import {
  BROWSER_AGENTS,
  IP_POOL,
  RENDER_IP_POOL,
  batch,
  beaconHeaders,
  clientIp,
  uuid,
} from '../../../bench/payload.js';
import { consentMaskFromCookie } from '../src/lib/consent-cookie.js';
import { isBotUserAgent } from '../src/lib/classify.js';

const here = dirname(fileURLToPath(import.meta.url));

interface RateLimitBinding {
  readonly name: string;
  readonly simple: { readonly limit: number; readonly period: number };
}

/**
 * A seeded generator, so a failure is reproducible.
 *
 * mulberry32 — three lines, no dependency, and good enough for choosing between four
 * strings. `batch` takes its randomness as a parameter precisely so this is possible.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the load-test payload', () => {
  it('is accepted by the schema the collector parses with', () => {
    const random = seeded(1);

    // One sample would only prove that one arm of every `pick` is valid. Two hundred
    // covers every branch the builder can take, including the one-event and six-event
    // batches at the ends of its range.
    for (let i = 0; i < 200; i += 1) {
      const parsed = ClientBatchSchema.safeParse(batch(random));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('is checked by a schema strict enough for that to mean something', () => {
    // A passing `safeParse` only proves drift is caught if the schema would reject the
    // drift. These are the mutations a schema change would actually look like: a renamed
    // event type, a field that quietly became optional, a timestamp format change.
    // Deliberately typed as loose bags rather than as the schema's own output: every
    // mutation below is one the *type* would reject, and the question here is whether the
    // schema rejects it at runtime, where the beacon actually arrives.
    type LooseBatch = { events: Record<string, unknown>[] };
    const good = JSON.stringify(batch(seeded(17)));

    const mutations: readonly [string, (batch: LooseBatch) => void][] = [
      ['an event type renamed', (b) => void (b.events[0]!['type'] = 'pageview')],
      ['assignmentHash dropped', (b) => void delete b.events[0]!['assignmentHash']],
      ['assignmentHash no longer decimal', (b) => void (b.events[0]!['assignmentHash'] = 'abc')],
      ['a timestamp sent as epoch millis', (b) => void (b.events[0]!['ts'] = '1756400000000')],
      ['an id that is not a uuid', (b) => void (b.events[0]!['eventId'] = 'nope')],
      ['an empty batch', (b) => void (b.events = [])],
    ];

    for (const [what, mutate] of mutations) {
      const copy = JSON.parse(good) as LooseBatch;
      mutate(copy);
      expect(ClientBatchSchema.safeParse(copy).success, what).toBe(false);
    }
  });

  it('produces batches across the whole size range the client can send', () => {
    const random = seeded(7);
    const sizes = new Set<number>();

    for (let i = 0; i < 500; i += 1) sizes.add(batch(random).events.length);

    expect(Math.min(...sizes)).toBe(1);
    expect(Math.max(...sizes)).toBe(6);
  });

  it('shares one session id across the events of a batch', () => {
    // A batch is one flush from one page, so the collector's session rollup would be
    // measuring something else entirely if these differed.
    const { events } = batch(seeded(3));
    const sessions = new Set(events.map((event) => event.sessionId));

    expect(sessions.size).toBe(1);
  });

  it('emits v4 uuids', () => {
    const random = seeded(11);

    for (let i = 0; i < 100; i += 1) {
      expect(uuid(random)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

/**
 * The ingest rate limit, read from the config that actually enforces it.
 *
 * Restating the number here would let the bench keep believing an old limit after somebody
 * changed the real one, and the symptom would be a benchmark that measures 429s at line
 * speed while reporting a triumphant, meaningless throughput. Reading `wrangler.jsonc` is
 * the same discipline `@morph/metrics` uses for the alert rules: the assumption is checked
 * against its own source rather than copied from it.
 *
 * Through wrangler's own parser rather than a comment-stripping regex. The file is JSONC
 * and the first version of this did strip comments by hand — which would have survived
 * today's config and broken on the first `//` that appeared inside a string, in a test
 * whose failure reads as "the bench is misconfigured". Using the parser that runs in
 * production removes the class of bug rather than the instance.
 */
function ingestRateLimit(): { readonly limit: number; readonly period: number } {
  // Annotated at the boundary: wrangler ships its config types as `.d.mts`, which this
  // project's resolution does not pick up, so the return arrives unresolved. Naming the
  // one field this test reads is narrower than widening the whole project's module
  // resolution for a test helper.
  const config: { ratelimits?: RateLimitBinding[] } = unstable_readConfig({
    config: join(here, '..', 'wrangler.jsonc'),
  });

  const limiter = config.ratelimits?.find((r) => r.name === 'INGEST_LIMITER');

  if (limiter === undefined) throw new Error('INGEST_LIMITER is not configured');
  return limiter.simple;
}

describe('the load-test identity', () => {
  it('spreads across enough identities that the rate limiter is not the constraint', () => {
    // The point of the whole exercise. The limiter permits `limit` beacons per `period`
    // seconds per identity (D34), so sustaining 5,000 req/s needs at least
    // 5000 / (limit / period) distinct identities. Anything less and the benchmark
    // measures 429s rather than throughput.
    const { limit, period } = ingestRateLimit();
    const beaconsPerSecondPerIdentity = limit / period;
    const needed = 5000 / beaconsPerSecondPerIdentity;

    expect(IP_POOL).toBeGreaterThan(needed * 4);
  });

  it('gives distinct addresses to concurrent virtual users', () => {
    // The case that matters most: these requests are in flight at the same moment and
    // would share a bucket refill window if they shared an identity.
    const addresses = new Set<string>();
    for (let vu = 1; vu <= 2000; vu += 1) addresses.add(clientIp(vu, 0));

    expect(addresses.size).toBe(2000);
  });

  it('never emits an unusable host octet', () => {
    // `.0` is a network address and `.255` a broadcast one. Nothing here routes, but a
    // benchmark that logs impossible addresses invites an afternoon spent on the wrong
    // question.
    for (let vu = 1; vu <= 60; vu += 1) {
      for (let iteration = 0; iteration < 60; iteration += 1) {
        const address = clientIp(vu, iteration);
        expect(address.endsWith('.0')).toBe(false);
        expect(address.endsWith('.255')).toBe(false);
      }
    }
  });

  it('maps distinct indices to distinct addresses in the render pool', () => {
    // The whole premise of `render.js` at its default settings. `apps/web` caches the
    // assignment under the derived identity for thirty days, so a recycled address is a
    // cache hit — and a run that starts hitting the cache half way through reports the
    // cheap path's TTFB under the expensive path's name.
    //
    // The indices below are what a two-minute run at 1,000 req/s produces at the
    // script's `maxVUs`. Every one must be a visitor the origin has never seen.
    const addresses = new Set<string>();
    let requests = 0;

    for (let iteration = 0; iteration < 80; iteration += 1) {
      for (let vu = 1; vu <= 1500; vu += 1) {
        addresses.add(clientIp(vu, iteration, RENDER_IP_POOL));
        requests += 1;
      }
    }

    expect(addresses.size).toBe(requests);
  });

  it('lets a repeat visit reuse the identity the previous one established', () => {
    // How `render.js` models a returning visitor: the same person, moments later, on
    // their second page. If consecutive iterations produced the same address anyway the
    // `RETURNING` knob would be inert and the run would be a cache benchmark throughout.
    expect(clientIp(7, 3, RENDER_IP_POOL)).not.toBe(clientIp(7, 4, RENDER_IP_POOL));
    expect(clientIp(7, 3, RENDER_IP_POOL)).toBe(clientIp(7, 3, RENDER_IP_POOL));
  });

  it('stays inside the pool it declares', () => {
    // 10/8 has room for 2^24 addresses and the pool is far smaller, but the masking is
    // done by hand and an off-by-one there would quietly shrink the identity space —
    // reintroducing exactly the rate-limit artefact this is all designed to avoid.
    const addresses = new Set<string>();
    for (let vu = 1; vu <= 400; vu += 1) {
      for (let iteration = 0; iteration < 200; iteration += 1) {
        addresses.add(clientIp(vu, iteration));
      }
    }

    expect(addresses.size).toBeLessThanOrEqual(IP_POOL);
  });

  it('sends a cookie the collector reads as analytics consent', () => {
    // A refusing visitor is still measured — anonymously and without the beacon — so a
    // run without this header would exercise a different, cheaper path and report a
    // number that is not about the site's actual traffic.
    const headers = beaconHeaders(1, 0, seeded(5));
    const mask = consentMaskFromCookie(headers.cookie);

    expect(mask & 2).toBe(2);
  });

  it('looks like a browser, so the context features are the ones production sees', () => {
    // `deviceClass` and `viewportBucket` are parsed out of the User-Agent. k6's default
    // agent says `k6`, and a run whose whole population lands in `unknown` would be
    // measuring a shape the site never actually serves.
    const random = seeded(13);

    for (let i = 0; i < 50; i += 1) {
      expect(beaconHeaders(1, i, random)['user-agent']).toMatch(/^Mozilla\/5\.0 /);
    }
  });

  it('declares itself, so its events never become evidence', () => {
    // The one that matters over a long run. Every aggregate in
    // `infra/clickhouse/init/002_aggregates.sql` filters `bot_score < 60`; a four-hour
    // soak at 1,000 req/s is tens of millions of events, and without this they are all
    // counted as real behaviour. The optimiser would then be learning from k6.
    const random = seeded(19);

    for (let i = 0; i < 50; i += 1) {
      // `String(...)` because the header bag comes from a `.js` module with no declared
      // types, so the indexed read is `any`. Coercing is honest here: the assertion is
      // about what the collector will do with whatever string arrives.
      expect(isBotUserAgent(String(beaconHeaders(1, i, random)['user-agent']))).toBe(true);
    }
  });

  it('leaves the render agents undeclared, because there the marker would hide the work', () => {
    // The mirror image, and the reason these are two lists rather than one. A high bot
    // score makes the renderer serve the baseline without resolving an assignment — so a
    // declared `render.js` would measure the branch that skips everything it is timing.
    // A GET writes no events, so there is nothing to exclude it from.
    for (const agent of BROWSER_AGENTS) {
      expect(isBotUserAgent(agent)).toBe(false);
    }
  });
});
