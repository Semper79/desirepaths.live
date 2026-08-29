/**
 * The beacon payload the load test sends, and the identity it sends it as.
 *
 * Separated from `ingest.js` for one reason: it can be imported by a test, and it is.
 * The most likely way a load test written today fails in three months is that the event
 * schema moved and the run silently measures 400s — fast, meaningless, and impossible to
 * notice from a summary that says "5,000 req/s".
 *
 * `apps/api/test/bench-payload.test.ts` parses what this produces with the real
 * `ClientBatchSchema`, so that drift is a failing test rather than a wasted benchmark
 * afternoon.
 *
 * ON THE VARYING `X-Real-IP`, WHICH DESERVES A SENTENCE
 * `CLAUDE.md` forbids IP rotation, and this file varies an address header. They are not the
 * same thing and the difference is the target: the forbidden capability is rotating
 * addresses against *someone else's* service to get past their rate limits or their
 * enforcement. This is MORPH's own collector, its own limiter, and the addresses are
 * synthetic 10/8 values that route nowhere. Simulating twenty thousand visitors is the only
 * way to measure a per-visitor limiter without measuring the limiter instead — and the
 * limiter stays on for the run, which is the point of the `rate_limited` threshold.
 *
 * Plain JavaScript with no imports, because k6 runs it too and k6 does not run TypeScript.
 */

export const EVENT_TYPES = ['page_view', 'scroll_depth', 'engagement', 'click'];

export const SURFACES = [
  'hero.headline',
  'hero.subhead',
  'theme.palette',
  'theme.typography',
  'cta.copy',
];

/**
 * Plausible browsers.
 *
 * Not k6's default agent: the collector scores it, and a run made entirely as a crawler
 * exercises the crawler path — different branches, different cache behaviour, and not what
 * production does.
 *
 * Used bare by `render.js` only. See `SYNTHETIC_AGENTS` for why the ingest side differs.
 */
export const BROWSER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

/**
 * The token that tells the collector these events are ours and are not evidence.
 *
 * `isBotUserAgent` matches it, which stamps `bot_score = 100`, which is what every
 * aggregate in `infra/clickhouse/init/002_aggregates.sql` filters on. Without it a
 * four-hour soak writes tens of millions of synthetic events *into the posteriors* — a
 * benchmark that corrupts the thing it is measuring, and does so invisibly, because the
 * damage shows up weeks later as an optimiser confidently serving whatever k6 liked.
 *
 * It is free on this path. The ingest route computes the score once and stores it; no
 * branch above the write reads it, so a synthetic batch and a real one do identical work.
 */
export const SYNTHETIC_TOKEN = 'MorphBench/1';

/**
 * What the ingest-side scripts send: a real browser string with the marker appended.
 *
 * Still a browser, because `deviceClass` and `viewportBucket` are parsed out of it and a
 * run that produced only `unknown` context would be measuring a shape production never
 * sees. The marker rides along at the end, where a User-Agent's product tokens belong.
 */
export const SYNTHETIC_AGENTS = BROWSER_AGENTS.map((agent) => `${agent} ${SYNTHETIC_TOKEN}`);

export const PATHS = ['/', '/how-it-works', '/t/how-this-site-rebuilds-itself', '/privacy'];

/**
 * How many distinct visitors the ingest run appears to come from.
 *
 * `INGEST_BUCKET` refills two tokens per second per identity, so 5,000 req/s needs at
 * least 2,500 identities just to break even. This is far above that, so the bucket is
 * never the binding constraint and the test measures the collector rather than its
 * defences.
 *
 * Bounded rather than unlimited on purpose: the limiter holds a bucket per identity, and
 * a run that invents a million of them would be measuring that map's growth. Twenty
 * thousand is comfortably past the point where the bucket binds and comfortably short of
 * the point where its bookkeeping does.
 */
export const IP_POOL = 20_000;

/**
 * The render run's pool, which is a different question and needs a different answer.
 *
 * `apps/web` does not rate-limit; what it does is cache the assignment under the same
 * derived identity for thirty days. So on the render path a *repeated* address is a cache
 * hit, and `render.js` claims by default that every request is a miss. A dense pool would
 * make that claim false about twenty seconds into the run — the cheap path would quietly
 * take over and the measured TTFB would be the one that was not being asked about.
 *
 * This is larger than any plausible run, so reuse only happens when `render.js` asks for
 * it explicitly.
 */
export const RENDER_IP_POOL = 4_000_000;

/**
 * Stride between virtual users in the identity index.
 *
 * The index is `iteration * VU_STRIDE + vu`, which is injective as long as `vu` stays
 * below the stride — so this is a ceiling on `maxVUs`, and both scripts sit well under it.
 * The obvious alternative, a coprime multiplier modulo the pool, spreads just as nicely
 * but collides at a birthday rate, and a few per cent of accidental cache hits is exactly
 * the contamination this is here to avoid.
 */
const VU_STRIDE = 2048;

/** Distinct addresses reachable per pool: `10.a.b.c` with `c` in 1..254. */
const ADDRESSES_PER_BLOCK = 254;

/** A v4 UUID from `Math.random`. Not cryptographic, and does not need to be. */
export function uuid(random = Math.random) {
  const hex = '0123456789abcdef';
  let out = '';

  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[8 + Math.floor(random() * 4)];
    else out += hex[Math.floor(random() * 16)];
  }

  return out;
}

export function pick(list, random = Math.random) {
  return list[Math.floor(random() * list.length)];
}

/**
 * A client address for one virtual user's one iteration.
 *
 * In 10/8 so it cannot collide with anything real, and derived rather than random so a
 * rerun exercises the same identities — which is what makes two runs on the same machine
 * comparable, and what lets `render.js` ask for a repeat visit by asking for a previous
 * iteration's address.
 *
 * The host octet runs 1..254: `.0` is a network address and `.255` a broadcast one, and
 * while nothing here routes, a benchmark that logs impossible addresses invites an
 * afternoon of investigating the wrong thing. The mapping is a bijection over the pool
 * up to `254 × 65536`, so "distinct index" and "distinct visitor" mean the same thing.
 */
export function clientIp(vu, iteration, pool = IP_POOL) {
  const n = (iteration * VU_STRIDE + vu) % pool;
  const host = (n % ADDRESSES_PER_BLOCK) + 1;
  const block = Math.floor(n / ADDRESSES_PER_BLOCK);

  return `10.${(block >> 8) & 0xff}.${block & 0xff}.${host}`;
}

/**
 * One beacon, as the site actually sends them.
 *
 * Between one and six events: the client batches on a timer and flushes on `pagehide`, so
 * a real batch is small and variable. A fixed size would measure one point on a curve and
 * report it as the curve.
 *
 * `marker` is merged into every event's `props`. `spike.js` and `soak.js` put a run id
 * there so they can ask ClickHouse afterwards how many of the events they sent actually
 * arrived — which is the only way "nothing was dropped" is a measurement rather than a
 * hope. A `202` says the collector handed the batch to the broker; it says nothing about
 * what happened after that, and the spike scenario exists precisely to stress that gap.
 */
export function batch(random = Math.random, at = new Date(), marker = null) {
  const count = 1 + Math.floor(random() * 6);
  const sessionId = uuid(random);
  const ts = at.toISOString();
  const events = [];

  for (let i = 0; i < count; i += 1) {
    events.push({
      v: 1,
      eventId: uuid(random),
      ts,
      type: i === 0 ? 'page_view' : pick(EVENT_TYPES, random),
      sessionId,
      ctx: {
        viewportWidth: 360 + Math.floor(random() * 1200),
        depth: i,
        returning: random() < 0.3,
        locale: pick(['en', 'it', 'de', 'fr'], random),
      },
      path: pick(PATHS, random),
      surfaces: SURFACES,
      variants: SURFACES.map(() => `variant#${1 + Math.floor(random() * 4)}`),
      // The schema wants a decimal string of at most 20 digits.
      assignmentHash: String(Math.floor(random() * 1e15)),
      holdout: random() < 0.05 ? 1 : 0,
      value: Math.round(random() * 100),
      props: marker === null ? {} : { ...marker },
    });
  }

  return {
    events,
    referrer: pick(['', 'https://www.google.com/', 'https://news.ycombinator.com/'], random),
  };
}

/** The headers a measured visitor's beacon carries. */
export function beaconHeaders(vu, iteration, random = Math.random) {
  return {
    'content-type': 'application/json',
    'user-agent': pick(SYNTHETIC_AGENTS, random),
    'accept-language': 'en-GB,en;q=0.9',
    'sec-fetch-mode': 'no-cors',
    'x-real-ip': clientIp(vu, iteration),
    'x-country': pick(['IT', 'GB', 'DE', 'US'], random),
    // Analytics consent granted, which is what a measured visitor looks like. Without it
    // the collector still accepts the batch, but the run would be measuring the path a
    // refusing visitor takes rather than the common one.
    cookie: 'morph_consent=3',
  };
}
