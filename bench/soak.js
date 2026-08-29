/**
 * The soak: 1,000 req/s for four hours.
 *
 * §7. Looking for memory growth, connection-pool exhaustion, and ClickHouse part-count
 * drift — the failures that do not exist at minute one and are obvious at hour six.
 *
 * THE GATE IS DRIFT, NOT LEVEL
 * A soak that reports "p99 was 18 ms" has answered the wrong question; `ingest.js` already
 * answered that one, faster and for free. What matters here is whether the number at the
 * end matches the number at the start. So the run brackets itself: the first and last
 * tenth are recorded as separate metrics and compared in the summary. A system that is
 * 40% slower after four hours has failed even at a p99 of 18 ms.
 *
 * WHAT THIS CAN AND CANNOT SEE
 * Two of the three named failures are observable from here. Latency drift is measured
 * directly, and ClickHouse part count is queried from `system.parts` — parts accumulate
 * when inserts outrun merges, and the end state is `too many parts` rejecting every write.
 *
 * Process memory and connection-pool exhaustion are **not** observable from here, and this
 * script does not pretend otherwise. They need `/metrics` on the collector, which
 * `infra/prometheus/prometheus.yml` already scrapes and which no service currently serves
 * — `CountingMetrics` in `apps/api/src/routes/ingest.ts` says so in as many words. Until
 * that exists, a soak run needs a human watching `docker stats`, and the summary below
 * says so rather than quietly reporting two of three as if it were three of three.
 *
 * Usage:
 *   k6 run bench/soak.js                        # four hours
 *   k6 run -e HOURS=0.5 bench/soak.js           # a shorter sanity run
 *   k6 run -e MODE=smoke bench/soak.js          # 30 seconds, for CI
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { batch, beaconHeaders } from './payload.js';
import { activePartCount, awaitDelivery, clickhouseConfigured } from './clickhouse.js';

const TARGET = __ENV.TARGET || 'http://localhost:3001';
const SMOKE = __ENV.MODE === 'smoke';

const RATE = SMOKE ? 50 : 1000;
const DURATION_MS = SMOKE ? 30_000 : Math.round(Number(__ENV.HOURS || '4') * 3_600_000);

/**
 * How much of each end counts as "early" and "late".
 *
 * A tenth at each end: long enough that the comparison is not noise, short enough that
 * the middle — where a slow leak actually does its work — is excluded from both sides.
 * Comparing the first half against the second would blunt exactly the signal being
 * looked for.
 */
const WINDOW_MS = Math.max(DURATION_MS / 10, SMOKE ? 3_000 : 60_000);

/** Growth beyond this between the two windows is a finding rather than weather. */
const DRIFT_LIMIT = 1.4;

const RUN_ID = `soak-${Math.random().toString(36).slice(2, 12)}`;

const eventsSent = new Counter('events_sent');
const rateLimited = new Counter('rate_limited');
const rejected = new Counter('rejected_400');
const sinkRefused = new Counter('sink_refused_503');
const accepted = new Rate('accepted_202');
const ttfbEarly = new Trend('ttfb_early', true);
const ttfbLate = new Trend('ttfb_late', true);
const partsEarly = new Trend('clickhouse_parts_early');
const partsLate = new Trend('clickhouse_parts_late');

export const options = {
  // k6 defaults this to avg/min/med/max/p(90)/p(95) — no p(99). Thresholds compute their
  // own percentiles and were never affected, but `handleSummary` reads p(99) to print
  // the verdict, and an absent key there is a TypeError that takes the whole summary with
  // it: the run happens, the gate passes, and nothing is reported.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${Math.round(DURATION_MS / 1000)}s`,
      preAllocatedVUs: SMOKE ? 20 : 200,
      maxVUs: SMOKE ? 50 : 1000,
    },
    // Sampling ClickHouse's part count on its own schedule, because the interesting
    // number changes on the order of minutes and reading it once per request would be a
    // second load test pointed at the database.
    parts: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: SMOKE ? '5s' : '60s',
      duration: `${Math.round(DURATION_MS / 1000)}s`,
      preAllocatedVUs: 1,
      maxVUs: 2,
      exec: 'sampleParts',
    },
  },
  thresholds: {
    // Scoped to the ingest requests by tag. Without the tag this would silently fold in
    // the `system.parts` queries, and a database round trip inside a 25 ms budget would
    // make the p99 a statement about the sampler.
    'http_req_duration{op:ingest}': ['p(99)<25'],
    'http_req_failed{op:ingest}': ['rate<0.001'],
    accepted_202: ['rate>0.999'],
    rejected_400: ['count==0'],
    rate_limited: ['count==0'],
    sink_refused_503: ['count==0'],
    dropped_iterations: ['count==0'],
  },
};

const STARTED_AT = Date.now();

function phase() {
  const elapsed = Date.now() - STARTED_AT;
  if (elapsed < WINDOW_MS) return 'early';
  if (elapsed > DURATION_MS - WINDOW_MS) return 'late';
  return 'middle';
}

export default function () {
  const body = batch(Math.random, new Date(), { bench_run: RUN_ID });

  const response = http.post(`${TARGET}/i`, JSON.stringify(body), {
    headers: beaconHeaders(__VU, __ITER),
    responseType: 'none',
    tags: { op: 'ingest' },
  });

  if (response.status === 202) eventsSent.add(body.events.length);
  if (response.status === 429) rateLimited.add(1);
  if (response.status === 400) rejected.add(1);
  if (response.status === 503) sinkRefused.add(1);
  accepted.add(response.status === 202);

  const where = phase();
  if (where === 'early') ttfbEarly.add(response.timings.waiting);
  else if (where === 'late') ttfbLate.add(response.timings.waiting);

  check(response, { 'accepted (202)': (r) => r.status === 202 });
}

export function sampleParts() {
  if (!clickhouseConfigured()) return;

  const parts = activePartCount();
  if (parts === null) return;

  const where = phase();
  if (where === 'early') partsEarly.add(parts);
  else if (where === 'late') partsLate.add(parts);
}

/** Same bridge as `spike.js`, and the same fail-safe default. */
let delivery = { checked: false, count: null, settled: false, reason: 'teardown did not run' };

export function teardown() {
  if (!clickhouseConfigured()) {
    delivery = {
      checked: false,
      count: null,
      settled: false,
      reason: 'no ClickHouse credentials — set CLICKHOUSE_USER and CLICKHOUSE_PASSWORD',
    };
    console.warn(`soak ${RUN_ID}: delivery NOT verified — ${delivery.reason}`);
    return;
  }

  const result = awaitDelivery(RUN_ID, sleep, {
    intervalMs: 10_000,
    settleForMs: 30_000,
    timeoutMs: 600_000,
  });

  delivery = { checked: true, ...result };
  console.log(
    `soak ${RUN_ID}: ${String(result.count)} events in ClickHouse, settled=${String(result.settled)} (${result.reason})`,
  );
}

/**
 * Compare two windows, and refuse to draw a conclusion from an empty one.
 *
 * A run shorter than two windows, or one where the sampler never got a reading, leaves a
 * metric absent. Treating that as "no drift detected" would turn a missing measurement
 * into a pass, which is the failure mode this whole file is arranged against.
 */
function drift(label, early, late, unit) {
  if (!early || !late || early.values.count === 0 || late.values.count === 0) {
    return { ok: false, line: `  ${label}  NOT MEASURED — one of the two windows is empty` };
  }

  const from = early.values['p(99)'] ?? early.values.avg;
  const to = late.values['p(99)'] ?? late.values.avg;
  const ratio = from > 0 ? to / from : 1;
  const ok = ratio <= DRIFT_LIMIT;

  return {
    ok,
    line: `  ${label}  ${from.toFixed(1)}${unit} → ${to.toFixed(1)}${unit}  (×${ratio.toFixed(2)}${ok ? '' : '  DRIFT'})`,
  };
}

export function handleSummary(data) {
  const sent = data.metrics.events_sent ? data.metrics.events_sent.values.count : 0;
  const refused = data.metrics.sink_refused_503 ? data.metrics.sink_refused_503.values.count : 0;

  const latency = drift('latency ', data.metrics.ttfb_early, data.metrics.ttfb_late, ' ms p99');
  const parts = drift(
    'parts   ',
    data.metrics.clickhouse_parts_early,
    data.metrics.clickhouse_parts_late,
    '',
  );

  let deliveryLine;
  let deliveryOk;
  if (!delivery.checked) {
    deliveryOk = false;
    deliveryLine = `  delivery  NOT CHECKED — ${delivery.reason}`;
  } else if (!delivery.settled || delivery.count === null) {
    deliveryOk = false;
    deliveryLine = `  delivery  INCONCLUSIVE — ${delivery.reason}`;
  } else {
    deliveryOk = delivery.count >= sent;
    deliveryLine = deliveryOk
      ? `  delivery  ${delivery.count} of ${sent} events (complete)`
      : `  delivery  ${delivery.count} of ${sent} events — ${sent - delivery.count} LOST`;
  }

  const passed = latency.ok && parts.ok && deliveryOk && refused === 0;

  const lines = [
    '',
    `  soak — ${passed ? 'PASS' : 'FAIL'}   ${(DURATION_MS / 3_600_000).toFixed(2)} h at ${RATE} req/s`,
    latency.line,
    parts.line,
    deliveryLine,
    '',
    '  not observed: process memory and connection-pool depth. Both need /metrics on the',
    '  collector, which Prometheus is configured to scrape and nothing currently serves.',
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'bench/results/soak.json': JSON.stringify({ runId: RUN_ID, delivery, data }, null, 2),
  };
}
