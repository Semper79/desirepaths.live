/**
 * `IngestMetrics`, backed by Prometheus.
 *
 * `CountingMetrics` in `routes/ingest.ts` has carried a comment since Phase 0 saying it
 * was "good enough until Prometheus is wired in Phase 8". This is that wiring, and it
 * needed no change to the route: the interface was already the seam, so the collector
 * still knows nothing about how its numbers are reported.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE. Each method is one counter increment. What is worth
 * testing is that the names exist and match the alert rules, and that is
 * `packages/metrics/test/contract.test.ts`.
 */

import { ingestErrors, ingestEvents, ingestLagMs, ingestRequests } from '@morph/metrics';
import type { IngestMetrics } from '../routes/ingest.js';

export function prometheusMetrics(): IngestMetrics {
  return {
    accepted(count: number): void {
      ingestRequests.inc({ outcome: 'accepted' });
      ingestEvents.inc(count);
    },

    rejected(count: number, reason: string): void {
      // Both, deliberately. `morph.yml` divides errors by requests, so a rejection has to
      // appear in the denominator as well or the ratio drifts upward as traffic grows.
      ingestRequests.inc({ outcome: 'rejected' });
      ingestErrors.inc({ reason }, count);
    },

    rateLimited(): void {
      ingestRequests.inc({ outcome: 'rate_limited' });
      ingestErrors.inc({ reason: 'rate_limited' });
    },

    sinkFailure(): void {
      ingestRequests.inc({ outcome: 'sink_failure' });
      ingestErrors.inc({ reason: 'sink_failure' });
    },
  };
}

/**
 * How stale an event was when it arrived.
 *
 * Recorded from the route rather than inside `enrich`, because the lag that matters is
 * measured at the moment of acceptance — the point the alert is about. Negative values
 * are dropped rather than clamped: a client clock ahead of the server produces them, and
 * folding those into the histogram as zero would make the p95 look better the more broken
 * the clocks were.
 */
export function observeIngestLag(eventTs: number, acceptedAt: number): void {
  const lag = acceptedAt - eventTs;
  if (lag >= 0) ingestLagMs.observe(lag);
}
