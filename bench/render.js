/**
 * The render load test: 1,000 req/s on the page, p95 TTFB under 150 ms.
 *
 * §7 for the rate, and `docs/ARCHITECTURE.md` for the latency target the whole edge design
 * is justified against.
 *
 * WHY THIS IS NOT THE SAME TEST AS `ingest.js`
 * The ingest path is a parse and a write to a broker. The render path resolves an
 * assignment for eleven surfaces before it can emit a byte, and the interesting question
 * is whether that stays under the budget when the assignment is a *miss* — a returning
 * visitor reads a cached decision from Redis, and a benchmark of returning visitors is a
 * benchmark of Redis.
 *
 * So the visitor identity is varied over a pool larger than any run can exhaust, and by
 * default every request is a first-time visitor. `-e RETURNING=0.8` mixes in the cheap
 * path once there is a mix worth reproducing; the honest default is the expensive case,
 * because a budget that only holds on the cheap path is not a budget.
 *
 * WHY THIS ONE DOES NOT DECLARE ITSELF
 * The ingest scripts append a marker to their User-Agent so their events are scored as
 * automated and excluded from the posteriors. This one must not: a high bot score makes
 * the renderer return the baseline without resolving an assignment at all, which is the
 * exact work under measurement. It costs nothing to omit, because a GET writes no events
 * — the only trace a run leaves is sticky assignments in Redis, which expire.
 *
 * WHAT WOULD MAKE THIS MEASURE NOTHING
 * A 500 that renders fast. The check below looks for the token bag in the response, which
 * is the one thing that proves the adaptive path ran rather than an error page — and it
 * is the same property `docs/ARCHITECTURE.md` claims about the first paint.
 *
 * Usage:
 *   k6 run bench/render.js
 *   k6 run -e MODE=smoke bench/render.js
 *   k6 run -e TARGET=https://… -e RETURNING=0.8 bench/render.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { BROWSER_AGENTS, RENDER_IP_POOL, clientIp, pick } from './payload.js';

const TARGET = __ENV.TARGET || 'http://localhost:3000';
const SMOKE = __ENV.MODE === 'smoke';
const RETURNING = Number(__ENV.RETURNING || '0');

const RATE = SMOKE ? 20 : 1000;
const DURATION = SMOKE ? '10s' : '2m';
const adapted = new Rate('adapted_html');

export const options = {
  // k6 defaults this to avg/min/med/max/p(90)/p(95) — no p(99). Thresholds compute their
  // own percentiles and were never affected, but `handleSummary` reads p(99) to print
  // the verdict, and an absent key there is a TypeError that takes the whole summary with
  // it: the run happens, the gate passes, and nothing is reported.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    render: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: SMOKE ? 20 : 300,
      maxVUs: SMOKE ? 50 : 1500,
    },
  },
  thresholds: {
    // TTFB, not total duration: the target in `docs/ARCHITECTURE.md` is about how long the
    // origin takes to start answering, and total duration folds in the transfer of a page
    // whose size is a separate concern with a separate budget.
    'http_req_waiting{expected_response:true}': ['p(95)<150'],
    http_req_failed: ['rate<0.001'],
    adapted_html: ['rate>0.999'],
    dropped_iterations: ['count==0'],
  },
};

/** The pages a visitor actually lands on, including the one that explains the run. */
const PATHS = ['/', '/how-it-works', '/t/how-this-site-rebuilds-itself', '/live'];

export default function () {
  // What actually makes a request a cache hit is the derived identity, because that is
  // what the sticky assignment is keyed on — `sha256(pepper ‖ salt ‖ ip ‖ ua)`, read from
  // Redis before the render. So a returning visitor is modelled by reusing this virtual
  // user's *previous* address: the same person, moments later, on their second page.
  //
  // The `morph_seen` cookie is sent alongside because a real returning visitor carries
  // one, but it is not what produces the hit — it is a context feature the bandit reads,
  // and sending it without the matching identity would be a visitor the origin has never
  // seen claiming to be an old friend.
  const returning = __ITER > 0 && Math.random() < RETURNING;
  const identity = clientIp(__VU, returning ? __ITER - 1 : __ITER, RENDER_IP_POOL);

  const response = http.get(`${TARGET}${pick(PATHS)}`, {
    headers: {
      'user-agent': pick(BROWSER_AGENTS),
      'accept-language': 'en-GB,en;q=0.9',
      accept: 'text/html,application/xhtml+xml',
      'sec-fetch-mode': 'navigate',
      'x-real-ip': identity,
      'x-country': pick(['IT', 'GB', 'DE', 'US']),
      cookie: returning ? 'morph_consent=3; morph_seen=1' : 'morph_consent=3',
    },
  });

  // The design tokens are written onto the root element before the page is sent. Their
  // presence is what distinguishes a rendered adaptive page from an error page that
  // happened to return quickly.
  const wasAdapted = response.status === 200 && response.body.includes('--color-');
  adapted.add(wasAdapted);

  check(response, {
    'adaptive HTML (200 with a token bag)': () => wasAdapted,
  });
}

export function handleSummary(data) {
  const ttfb = data.metrics.http_req_waiting.values['p(95)'];
  const rps = data.metrics.http_reqs.values.rate;
  const dropped = data.metrics.dropped_iterations
    ? data.metrics.dropped_iterations.values.count
    : 0;

  const verdict = ttfb < 150 && rps >= RATE * 0.99 && dropped === 0 ? 'PASS' : 'FAIL';

  const lines = [
    '',
    `  render — ${verdict}`,
    `  sustained  ${rps.toFixed(0)} req/s (target ${RATE})`,
    `  p95 TTFB   ${ttfb.toFixed(2)} ms (gate: under 150)`,
    `  p99 TTFB   ${data.metrics.http_req_waiting.values['p(99)'].toFixed(2)} ms`,
    `  returning mix ${(RETURNING * 100).toFixed(0)}%   dropped ${dropped}`,
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'bench/results/render.json': JSON.stringify(data, null, 2),
  };
}
