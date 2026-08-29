/**
 * The spike scenario: 500 → 8,000 req/s in ten seconds, and back.
 *
 * §7, and the reason Redpanda is in the architecture at all.
 *
 * WHAT THIS IS ACTUALLY ASKING
 * Not "how fast is it" — `ingest.js` asks that. This asks how the system *behaves* when
 * load arrives faster than any autoscaler can react to: the buffer should absorb the
 * burst, consumer lag should rise and then drain, and no event should be lost. Latency is
 * expected to degrade during the burst. That is not the failure. Losing data is, and so is
 * failing to come back afterwards.
 *
 * WHY A 202 IS NOT ENOUGH HERE
 * The collector answers `202` once `sink.publish` resolves — the broker took it. Every hop
 * after that (Redpanda retention, the Kafka table engine, the materialised view into
 * `morph.events`) is exactly what a burst stresses, and none of it is visible from the
 * response. A run that counts 202s and concludes "nothing was dropped" would pass with the
 * producer misconfigured to `acks=0`, which is among the specific bugs this scenario
 * exists to catch.
 *
 * So every event carries a run id in `props` and teardown counts how many arrived. When
 * that count cannot be obtained the summary says the check was **skipped or inconclusive**
 * — never that it passed. A spike test that did not verify delivery has not tested the
 * thing it is for, and must not print a green line.
 *
 * WHAT THE PHASES ARE FOR
 * The two baseline phases bracket the burst so recovery is measurable rather than assumed.
 * A system that survives the spike but never returns to its former latency has still
 * failed, and without the trailing phase nobody would know.
 *
 * Usage:
 *   k6 run bench/spike.js
 *   k6 run -e MODE=smoke bench/spike.js
 *   k6 run -e TARGET=https://… -e CLICKHOUSE_URL=… -e CLICKHOUSE_USER=… \
 *          -e CLICKHOUSE_PASSWORD=… bench/spike.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { batch, beaconHeaders } from './payload.js';
import { awaitDelivery, clickhouseConfigured } from './clickhouse.js';

const TARGET = __ENV.TARGET || 'http://localhost:3001';
const SMOKE = __ENV.MODE === 'smoke';

const BASELINE = SMOKE ? 50 : 500;
const PEAK = SMOKE ? 400 : 8000;

const LEAD_MS = SMOKE ? 10_000 : 45_000;
const HOLD_MS = SMOKE ? 10_000 : 60_000;
const TRAIL_MS = SMOKE ? 15_000 : 90_000;
const RAMP_MS = 10_000;

/**
 * A run id, so teardown counts this run's events and not last week's.
 *
 * From `Math.random` in the init context, which k6 evaluates once per run before any
 * virtual user starts, so every VU sees the same value. A timestamp would be the obvious
 * choice and would collide between two runs started in the same second — which is exactly
 * what happens when someone is iterating on a threshold.
 */
const RUN_ID = `spike-${Math.random().toString(36).slice(2, 12)}`;

const eventsSent = new Counter('events_sent');
const rateLimited = new Counter('rate_limited');
const rejected = new Counter('rejected_400');
const sinkRefused = new Counter('sink_refused_503');
const accepted = new Rate('accepted_202');
const ttfbBefore = new Trend('ttfb_baseline_before', true);
const ttfbAfter = new Trend('ttfb_baseline_after', true);

export const options = {
  // k6 defaults this to avg/min/med/max/p(90)/p(95) — no p(99). Thresholds compute their
  // own percentiles and were never affected, but `handleSummary` reads p(99) to print
  // the verdict, and an absent key there is a TypeError that takes the whole summary with
  // it: the run happens, the gate passes, and nothing is reported.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    spike: {
      // Ramping, because the shape *is* the test. A constant rate would measure a
      // different system: one that had been given time to warm its connection pools.
      executor: 'ramping-arrival-rate',
      startRate: BASELINE,
      timeUnit: '1s',
      preAllocatedVUs: SMOKE ? 50 : 800,
      maxVUs: SMOKE ? 200 : 4000,
      stages: [
        { target: BASELINE, duration: `${LEAD_MS / 1000}s` },
        { target: PEAK, duration: `${RAMP_MS / 1000}s` },
        { target: PEAK, duration: `${HOLD_MS / 1000}s` },
        { target: BASELINE, duration: `${RAMP_MS / 1000}s` },
        { target: BASELINE, duration: `${TRAIL_MS / 1000}s` },
      ],
    },
  },
  thresholds: {
    // Deliberately not a latency threshold. Degrading under an unannounced sixteen-fold
    // burst is correct behaviour, and asserting otherwise would be asserting that the
    // buffer is never used. What must hold is that requests are answered, and answered
    // correctly.
    http_req_failed: ['rate<0.001'],
    accepted_202: ['rate>0.999'],
    rejected_400: ['count==0'],
    rate_limited: ['count==0'],

    // A 503 means `sink.publish` threw: the broker refused the write and the collector
    // honestly told the client to retry. Honest, and a failed spike — the buffer did not
    // absorb what it exists to absorb.
    sink_refused_503: ['count==0'],

    // Recovery, as a number rather than an impression. The trailing baseline may be a
    // little slower than the leading one — warm pools, different page cache — but a
    // system still limping ninety seconds after the burst has not recovered.
    ttfb_baseline_after: ['p(99)<50'],
  },
};

/**
 * Which phase of the ramp we are in, from the clock.
 *
 * k6 gives a scenario's stages no runtime identity, so this is derived from elapsed time
 * against the same durations declared above. It only brackets the burst for the recovery
 * comparison; being a second out at a boundary changes nothing.
 */
const STARTED_AT = Date.now();
const BURST_ENDS_MS = LEAD_MS + RAMP_MS + HOLD_MS + RAMP_MS;

export default function () {
  const body = batch(Math.random, new Date(), { bench_run: RUN_ID });

  const response = http.post(`${TARGET}/i`, JSON.stringify(body), {
    headers: beaconHeaders(__VU, __ITER),
    responseType: 'none',
  });

  if (response.status === 202) eventsSent.add(body.events.length);
  if (response.status === 429) rateLimited.add(1);
  if (response.status === 400) rejected.add(1);
  if (response.status === 503) sinkRefused.add(1);
  accepted.add(response.status === 202);

  const elapsed = Date.now() - STARTED_AT;
  if (elapsed < LEAD_MS) ttfbBefore.add(response.timings.waiting);
  else if (elapsed > BURST_ENDS_MS) ttfbAfter.add(response.timings.waiting);

  check(response, { 'accepted (202)': (r) => r.status === 202 });
}

/**
 * The delivery result, carried from `teardown` to `handleSummary`.
 *
 * k6 hands `teardown`'s return value to nobody — `handleSummary` receives metric data and
 * nothing else — so this module-level binding is the bridge. Both run outside the VU pool
 * and share this module instance.
 *
 * It starts as an explicit "not checked" rather than as a delivered count, so if that
 * sharing ever stops holding the summary degrades to *unverified* instead of to a silent
 * pass. `teardown` also logs the numbers directly, so they survive either way.
 */
let delivery = { checked: false, count: null, settled: false, reason: 'teardown did not run' };

export function teardown() {
  if (!clickhouseConfigured()) {
    delivery = {
      checked: false,
      count: null,
      settled: false,
      reason: 'no ClickHouse credentials — set CLICKHOUSE_USER and CLICKHOUSE_PASSWORD',
    };
    console.warn(`spike ${RUN_ID}: delivery NOT verified — ${delivery.reason}`);
    return;
  }

  // Generous, because the consumer is draining a backlog it deliberately fell behind on,
  // and the claim being tested is that the backlog clears rather than being discarded.
  const result = awaitDelivery(RUN_ID, sleep, {
    intervalMs: 5_000,
    settleForMs: 15_000,
    timeoutMs: SMOKE ? 60_000 : 300_000,
  });

  delivery = { checked: true, ...result };
  console.log(
    `spike ${RUN_ID}: ${String(result.count)} events in ClickHouse, settled=${String(result.settled)} (${result.reason})`,
  );
}

function deliveryVerdict(sent) {
  if (!delivery.checked) {
    return { ok: false, line: `  delivery   NOT CHECKED — ${delivery.reason}` };
  }
  if (!delivery.settled || delivery.count === null) {
    return {
      ok: false,
      line: `  delivery   INCONCLUSIVE — ${delivery.reason} (${String(delivery.count)} of ${sent})`,
    };
  }
  if (delivery.count >= sent) {
    return { ok: true, line: `  delivery   ${delivery.count} of ${sent} events (complete)` };
  }
  return {
    ok: false,
    line: `  delivery   ${delivery.count} of ${sent} events — ${sent - delivery.count} LOST`,
  };
}

export function handleSummary(data) {
  const sent = data.metrics.events_sent ? data.metrics.events_sent.values.count : 0;
  const refused = data.metrics.sink_refused_503 ? data.metrics.sink_refused_503.values.count : 0;
  const dropped = data.metrics.dropped_iterations
    ? data.metrics.dropped_iterations.values.count
    : 0;

  const before = data.metrics.ttfb_baseline_before;
  const after = data.metrics.ttfb_baseline_after;
  const beforeP99 = before ? before.values['p(99)'] : 0;
  const afterP99 = after ? after.values['p(99)'] : 0;

  const verdict = deliveryVerdict(sent);
  const passed = verdict.ok && refused === 0 && dropped === 0;

  const lines = [
    '',
    `  spike — ${passed ? 'PASS' : 'FAIL'}`,
    `  peak       ${PEAK} req/s offered, ${dropped} iterations dropped`,
    verdict.line,
    `  recovery   p99 TTFB ${beforeP99.toFixed(1)} ms before → ${afterP99.toFixed(1)} ms after`,
    `  sink 503s  ${refused}`,
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'bench/results/spike.json': JSON.stringify({ runId: RUN_ID, delivery, data }, null, 2),
  };
}
