/**
 * The event stream, written to Analytics Engine (D31).
 *
 * Replaces `RedpandaSink`. There is no broker, no connection to establish and nothing to
 * disconnect: `writeDataPoint` is a synchronous, fire-and-forget call into the runtime, and
 * the durability question it used to raise is answered differently — see below.
 *
 * THE ROW SHAPE, WHICH IS A CONTRACT
 *
 *   index1   event type
 *   blob1    event type            blob9   assignment hash
 *   blob2    anonymous id          blob10  surfaces, tab-joined
 *   blob3    session id            blob11  variants, tab-joined
 *   blob4    path                  blob12  event id
 *   blob5    device class          blob13  content id
 *   blob6    country               blob14  props.metric  (web_vital)
 *   blob7    referrer class        blob15  props.provider (signup_complete)
 *   blob8    hour of week
 *
 *   double1  value                 double3  consent mask
 *   double2  bot score             double4  ingest lag, ms
 *
 * Analytics Engine has no schema to alter and cannot rewrite what is already stored, so
 * appending a position is safe and reordering one is not: old rows keep their old meaning
 * for three months and nothing in a query can tell the two apart. `test/analytics-events.test.ts`
 * pins the layout for that reason.
 *
 * WHY THE INDEX IS THE EVENT TYPE
 * The index is the sampling key and Analytics Engine samples per index value, so only the
 * values arriving in bulk are sampled. Indexing on the type keeps `pageview` — millions a
 * day — sampled while `signup_complete` and `client_error` stay whole. Indexing on the
 * anonymous id instead would have been the intuitive choice and the wrong one: it would
 * sample nothing at all until a single visitor produced enough volume to matter, which is
 * never, so the firehose would be stored in full and the bill would follow.
 *
 * WHAT THIS IS NOT
 * It is not the input to a posterior. Sampling makes every count here an estimate, and D33
 * is explicit that an estimate may inform, rank and display but may not enter a Beta. The
 * exact per-variant counters live in a Durable Object. A query against this dataset that
 * feeds `alpha` or `beta` is a bug however plausible its numbers look.
 *
 * ON DURABILITY, WHICH GOT WEAKER AND SHOULD BE SAID SO
 * Redpanda acknowledged a write. This does not: `writeDataPoint` returns void, the runtime
 * buffers, and a data point can be lost without anything observing the loss. For behavioural
 * analytics that is an acceptable trade — the numbers are statistical and already sampled.
 * It would not be acceptable for anything transactional, which is why content, consent and
 * the adaptation log are in D1 instead.
 */

import type { IngestEvent } from '@morph/core';

/** A blob or index cell, matching what the runtime accepts. */
type DataPointCell = ArrayBuffer | string | null;

export interface EventDataPoint {
  indexes?: DataPointCell[] & { length: 0 | 1 };
  blobs?: DataPointCell[];
  doubles?: number[];
}

export interface EventDataset {
  writeDataPoint(event?: EventDataPoint): void;
}

/**
 * What the ingest handler publishes through.
 *
 * Narrower than the old `EventSink`: `connect`, `disconnect` and `healthy` described a
 * broker connection that no longer exists, and keeping them would have meant three methods
 * that either lie or do nothing.
 */
export interface EventPublisher {
  publish(events: readonly IngestEvent[]): void;
}

/**
 * Analytics Engine caps a Worker invocation at 250 data points.
 *
 * A beacon carries at most 50 events (`IngestBatchSchema`), so this cannot bind on one
 * batch. It is enforced anyway because the alternative is that the 251st write throws and
 * takes the whole response with it — a limit that is documented but not defended is a
 * limit that gets discovered in production.
 */
const MAX_POINTS_PER_INVOCATION = 250;

/** Tab-joined rather than JSON: the query reads these with `splitByChar`, not a parser. */
function joinList(values: readonly string[]): string {
  return values.join('\t');
}

export function analyticsEventPublisher(dataset: EventDataset): EventPublisher {
  return {
    publish(events: readonly IngestEvent[]): void {
      const writable = events.slice(0, MAX_POINTS_PER_INVOCATION);

      for (const event of writable) {
        const indexes: [string] = [event.type];

        const blobs: DataPointCell[] = [
          event.type,
          event.anonId,
          event.sessionId,
          event.path,
          event.ctx.device,
          event.ctx.country,
          event.ctx.referrerClass,
          String(event.ctx.hourOfWeek),
          event.assignmentHash,
          joinList(event.surfaces),
          joinList(event.variants),
          event.eventId,
          event.contentId ?? '',
          event.props['metric'] ?? '',
          event.props['provider'] ?? '',
        ];

        // Lag is computed here rather than stored by the client, because the client's
        // clock is the thing being corrected for. Clamped at zero: a browser running
        // five minutes fast is already refused by `validateEvent`, and a browser running
        // slightly fast should not contribute a negative lag that drags the mean down.
        const lagMs = Math.max(0, Date.now() - Date.parse(event.ts));

        const doubles: number[] = [event.value, event.botScore, event.consentMask, lagMs];

        try {
          dataset.writeDataPoint({ indexes, blobs, doubles });
        } catch {
          // One malformed point must not cost the rest of the batch, and must not cost
          // the response. The beacon has already been discarded by the browser; a 500
          // here would be a page-unload error nobody can act on.
        }
      }
    },
  };
}
