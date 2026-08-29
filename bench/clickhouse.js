/**
 * Asking ClickHouse what actually landed.
 *
 * `spike.js` and `soak.js` both make a claim a load generator cannot make on its own:
 * that nothing was dropped. A `202` from `POST /i` means the collector handed the batch
 * to the broker and no more than that — and the whole point of a spike is to stress
 * exactly the part of the path that comes after. Counting 202s and calling it delivery is
 * how a buffer misconfiguration passes a test.
 *
 * So both scripts stamp a run id into every event's `props` and, in teardown, count what
 * arrived. This file is the query.
 *
 * Same conventions as `apps/worker/src/adapters/clickhouse.ts`: values go through
 * `param_*` rather than into the SQL text, and credentials go in the `x-clickhouse-*`
 * headers. Two implementations of one convention is already one too many, but k6 does not
 * run TypeScript and cannot import the worker's.
 */

import http from 'k6/http';

/** Matches `.env.example`. Absent credentials mean the check is skipped, not faked. */
export const CLICKHOUSE = {
  url: __ENV.CLICKHOUSE_URL || 'http://localhost:8123',
  database: __ENV.CLICKHOUSE_DATABASE || 'morph',
  username: __ENV.CLICKHOUSE_USER || '',
  password: __ENV.CLICKHOUSE_PASSWORD || '',
};

export function clickhouseConfigured() {
  return CLICKHOUSE.username.length > 0;
}

/**
 * Run one query and return the first column of the first row as a number.
 *
 * Returns `null` on any failure rather than throwing. A teardown that throws loses the
 * whole summary, including the latency numbers the run was actually for — and a
 * verification step that destroys the measurement it was verifying is worse than one that
 * says "I could not check".
 */
export function scalar(sql, params) {
  const query = [];
  query.push(`database=${encodeURIComponent(CLICKHOUSE.database)}`);
  for (const name of Object.keys(params)) {
    query.push(`param_${name}=${encodeURIComponent(String(params[name]))}`);
  }

  const response = http.post(`${CLICKHOUSE.url}/?${query.join('&')}`, sql, {
    headers: {
      'x-clickhouse-user': CLICKHOUSE.username,
      'x-clickhouse-key': CLICKHOUSE.password,
      'content-type': 'text/plain; charset=utf-8',
    },
    timeout: '30s',
    // This is not part of the load being measured, and letting it into the request
    // metrics would put a 30 ms database round trip into the p99 of a 25 ms budget.
    tags: { verification: 'true' },
  });

  if (response.status !== 200) return null;

  const value = Number(String(response.body).trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * How many of this run's events reached the raw table.
 *
 * Partition-pruned on `event_date` — the column is `MATERIALIZED toDate(ts)` and is the
 * table's partition key, so without this the count is a full scan of every event the
 * system has ever stored. Two days rather than one because a run that crosses midnight
 * UTC would otherwise report that half its events vanished.
 */
export function deliveredCount(runId) {
  return scalar(
    `SELECT count()
     FROM events
     WHERE event_date >= today() - 1
       AND props['bench_run'] = {run:String}`,
    { run: runId },
  );
}

/**
 * Poll until the count stops rising, or until patience runs out.
 *
 * ClickHouse consumes from Redpanda asynchronously, so the count after the last request
 * is not the final count — it climbs for some seconds and then flattens. Reading it once
 * would report a shortfall that is really just a queue draining, which is the most
 * plausible way this check produces a false alarm.
 *
 * Returns the count *and* whether it had settled. A run that was still rising when the
 * clock ran out has not proved delivery and must not be reported as if it had; that is
 * the distinction `settled` exists to carry.
 */
export function awaitDelivery(runId, sleep, options) {
  const settleForMs = options.settleForMs;
  const timeoutMs = options.timeoutMs;
  const intervalMs = options.intervalMs;

  let best = deliveredCount(runId);
  if (best === null) return { count: null, settled: false, reason: 'query failed' };

  let waited = 0;
  let stableFor = 0;

  while (waited < timeoutMs) {
    sleep(intervalMs / 1000);
    waited += intervalMs;

    const now = deliveredCount(runId);
    if (now === null) return { count: best, settled: false, reason: 'query failed mid-poll' };

    if (now > best) {
      best = now;
      stableFor = 0;
    } else {
      stableFor += intervalMs;
      if (stableFor >= settleForMs) {
        return { count: best, settled: true, reason: 'count stopped rising' };
      }
    }
  }

  return { count: best, settled: false, reason: 'still rising when the timeout expired' };
}

/**
 * How many active parts the raw events table is carrying.
 *
 * One of the three things `docs/BENCHMARKS.md` says the soak is looking for. Parts
 * accumulate when inserts arrive faster than merges retire them, and the failure is
 * gradual: nothing is wrong at hour one, and at hour six `too many parts` rejects every
 * write. A count that climbs monotonically across a four-hour run is the early warning
 * that a batch size or an async-insert setting is wrong.
 */
export function activePartCount() {
  return scalar(
    `SELECT count()
     FROM system.parts
     WHERE database = {db:String} AND table = 'events' AND active`,
    { db: CLICKHOUSE.database },
  );
}
