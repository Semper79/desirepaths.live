/**
 * Reading a service's own numbers during a run.
 *
 * `soak.js` used to print, in its own summary, that it could not observe process memory or
 * connection-pool depth — because `infra/prometheus/prometheus.yml` scraped three
 * `/metrics` endpoints that no service served. `@morph/metrics` now serves them, so the
 * soak can watch the thing it is actually looking for instead of asking a human to keep
 * `docker stats` open for four hours.
 *
 * Deliberately a text scrape and not a Prometheus query. The soak wants the number *now*,
 * from the process under load, with no dependency on whether Prometheus happens to be
 * running or how far behind its scrape interval is — and a run whose measurements depend
 * on the monitoring stack being healthy cannot be trusted to report the monitoring stack
 * being unhealthy.
 */

import http from 'k6/http';

/** Where each service exposes itself. Matches `prometheus.yml`, which is the contract. */
export const METRICS = {
  api: __ENV.API_METRICS_URL || 'http://localhost:9464/metrics',
  web: __ENV.WEB_METRICS_URL || 'http://localhost:3000/api/metrics',
};

/**
 * One gauge or counter value out of the exposition text.
 *
 * Matches the sample line rather than parsing the whole format: the format is
 * `name{labels} value`, labels are optional, and a full parser here would be a second
 * implementation of something the run does not need.
 *
 * Returns null rather than zero when the series is absent, which is the distinction the
 * whole soak turns on — "not measured" and "measured as nothing" produce very different
 * conclusions about a four-hour run.
 */
export function readGauge(url, name) {
  const response = http.get(url, {
    timeout: '10s',
    // Kept out of the run's own latency metrics: a scrape of the service under test is
    // not traffic the service is being asked to serve fast.
    tags: { verification: 'true' },
  });

  if (response.status !== 200) return null;

  const body = String(response.body);
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue;
    if (!line.startsWith(name)) continue;

    // The character after the name must be a label brace or a space, or `morph_queue_waiting`
    // would match `morph_queue_waiting_total` and report a different series entirely.
    const next = line.charAt(name.length);
    if (next !== '{' && next !== ' ') continue;

    const value = Number(line.slice(line.lastIndexOf(' ') + 1).trim());
    if (Number.isFinite(value)) return value;
  }

  return null;
}

/** Resident set size of a service, in megabytes, or null if it is not answering. */
export function residentMemoryMb(url) {
  const bytes = readGauge(url, 'process_resident_memory_bytes');
  return bytes === null ? null : bytes / (1024 * 1024);
}
