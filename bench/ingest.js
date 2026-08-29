/**
 * The ingest load test: 5,000 req/s on `POST /i`, p99 under 25 ms.
 *
 * §7 of the brief, and the gate for Phase 1.
 *
 * THE THING THAT MAKES OR BREAKS THIS TEST
 * `INGEST_BUCKET` is `{ capacity: 60, refillPerSecond: 2 }`, keyed on the derived
 * anonymous id — which is `sha256(pepper ‖ salt ‖ ip ‖ ua)`. A load generator that sends
 * every request from one IP with one User-Agent is therefore one visitor, and after its
 * first sixty requests it gets a 429 for everything else.
 *
 * That failure is worse than an error, because it looks like a triumph: 429 is the
 * cheapest response the server can produce, and a run that measures it will report
 * 40,000 req/s at a p99 of two milliseconds. The number would be real and would mean
 * nothing.
 *
 * So `X-Real-IP` is varied across a large pool — the same header Caddy sets, and the only
 * lever a load generator has over the identity. At 2 tokens per second per identity,
 * 5,000 req/s needs at least 2,500 identities in steady state; the pool is far larger than
 * that so no single one is ever near its limit, and the test measures the collector rather
 * than its defences. `rate_limited` below is a hard threshold precisely so this cannot go
 * unnoticed if the maths ever changes.
 *
 * WHAT ELSE WOULD SILENTLY MEASURE THE WRONG THING
 * A payload the zod schema rejects. The collector answers 400 without touching the broker,
 * which is fast and meaningless — so `checks` requires 202 specifically, not `2xx`.
 * `dropped_iterations` is a threshold too: k6 quietly stops scheduling when the target
 * cannot be met, and a server managing 2,000 req/s otherwise "passes" a 5,000 req/s test.
 *
 * Usage:
 *   k6 run bench/ingest.js                       # the full gate
 *   k6 run -e MODE=smoke bench/ingest.js         # ten seconds at 50 req/s, for CI
 *   k6 run -e TARGET=https://… bench/ingest.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { batch, beaconHeaders } from './payload.js';

const TARGET = __ENV.TARGET || 'http://localhost:3001';
const SMOKE = __ENV.MODE === 'smoke';

/**
 * The rate the gate asks for, and the rate a smoke run uses.
 *
 * Smoke is not a smaller benchmark — it is a different test. It asks "does this script
 * still exercise the happy path", which is the failure that would otherwise be discovered
 * on the day somebody wanted a number.
 */
const RATE = SMOKE ? 50 : 5000;
const DURATION = SMOKE ? '10s' : '3m';

const rateLimited = new Counter('rate_limited');
const rejected = new Counter('rejected_400');
const accepted = new Rate('accepted_202');

export const options = {
  scenarios: {
    ingest: {
      // Arrival rate, not virtual users: the gate is a statement about requests per
      // second, and a VU-based test measures whatever concurrency happens to produce.
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: SMOKE ? 20 : 400,
      maxVUs: SMOKE ? 50 : 2000,
    },
  },
  thresholds: {
    // The gate, stated as the tool understands it.
    'http_req_duration{expected_response:true}': ['p(99)<25'],
    http_req_failed: ['rate<0.001'],
    accepted_202: ['rate>0.999'],

    // The three ways this test could pass while measuring nothing.
    rate_limited: ['count==0'],
    rejected_400: ['count==0'],
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  const response = http.post(`${TARGET}/i`, JSON.stringify(batch()), {
    headers: beaconHeaders(__VU, __ITER),
    // The beacon is fire-and-forget; a response body would be waste at this rate, and the
    // route sends none. Discarding it here keeps k6 from allocating one per request.
    responseType: 'none',
  });

  if (response.status === 429) rateLimited.add(1);
  if (response.status === 400) rejected.add(1);
  accepted.add(response.status === 202);

  check(response, {
    'accepted (202)': (r) => r.status === 202,
  });
}

/**
 * A one-line summary that answers the gate directly.
 *
 * The default k6 output is thorough and does not say whether the thing passed. This does,
 * in the form the benchmark document quotes.
 */
export function handleSummary(data) {
  const p99 = data.metrics.http_req_duration.values['p(99)'];
  const rps = data.metrics.http_reqs.values.rate;
  const limited = data.metrics.rate_limited ? data.metrics.rate_limited.values.count : 0;
  const dropped = data.metrics.dropped_iterations
    ? data.metrics.dropped_iterations.values.count
    : 0;

  const verdict =
    p99 < 25 && rps >= RATE * 0.99 && limited === 0 && dropped === 0 ? 'PASS' : 'FAIL';

  const lines = [
    '',
    `  ingest — ${verdict}`,
    `  sustained  ${rps.toFixed(0)} req/s (target ${RATE})`,
    `  p99        ${p99.toFixed(2)} ms (gate: under 25)`,
    `  p95        ${data.metrics.http_req_duration.values['p(95)'].toFixed(2)} ms`,
    `  rate limited ${limited}   dropped ${dropped}`,
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'bench/results/ingest.json': JSON.stringify(data, null, 2),
  };
}
