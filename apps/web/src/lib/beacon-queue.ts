/**
 * The client beacon's queue.
 *
 * Pure: no `window`, no `fetch`, no clock. The browser wiring is in
 * `components/beacon.tsx`; everything that can be got wrong lives here, where it can
 * be tested exhaustively without a browser.
 *
 * WHAT THIS HAS TO SURVIVE
 * A beacon runs on a phone, on a train, on a connection that disappears mid-request,
 * in a tab the user closes without warning. The failure modes that matter are not
 * exotic:
 *
 *  - **The tab closes before the flush.** Handled by flushing on `pagehide` with
 *    `sendBeacon`, which the browser delivers after the page is gone. That is why the
 *    payload has to stay small enough for `sendBeacon`'s 64 KB limit.
 *  - **The network is down.** Events are persisted and retried, rather than dropped.
 *  - **The network is down for a week.** The persisted queue is bounded, and it drops
 *    the *oldest* events. Losing the start of a long-abandoned session is better than
 *    filling a visitor's storage, and far better than sending a week-old session that
 *    would land in the wrong hour-of-week bucket anyway.
 *  - **The same events get sent twice.** Every event carries a UUIDv7 `eventId`, and
 *    the aggregates count `uniq(event_id)`, so a duplicate is free. That is what makes
 *    "retry aggressively" the right policy here.
 */

import type { ClientEvent } from '@morph/core';

/** Storage the queue persists to. `localStorage` in a browser, a Map in a test. */
export interface QueueStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export interface QueueConfig {
  /** Flush once this many events are waiting. */
  readonly batchSize: number;
  /** Flush after this long, even if the batch is not full. */
  readonly maxAgeMs: number;
  /**
   * Hard cap on persisted events. `sendBeacon` refuses payloads over 64 KB and a
   * visitor's storage is not ours to fill; 200 events is roughly 60 KB of JSON.
   */
  readonly maxQueued: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  // A page load produces a handful of events; 20 keeps a normal session to one or two
  // requests without waiting long enough to lose them to a closed tab.
  batchSize: 20,
  maxAgeMs: 10_000,
  maxQueued: 200,
};

export interface QueuedEvent {
  readonly event: ClientEvent;
  /** When it was enqueued, for the age-based flush and for eviction order. */
  readonly at: number;
}

export type FlushReason = 'batch-full' | 'max-age' | 'page-hidden' | 'manual';

export class BeaconQueue {
  private queue: QueuedEvent[] = [];

  constructor(
    private readonly storage: QueueStorage,
    private readonly config: QueueConfig = DEFAULT_QUEUE_CONFIG,
  ) {
    this.queue = this.restore();
  }

  get size(): number {
    return this.queue.length;
  }

  /** Everything waiting, oldest first. Exposed for tests and for the flush path. */
  peek(): readonly QueuedEvent[] {
    return [...this.queue];
  }

  enqueue(event: ClientEvent, at: number): void {
    this.queue.push({ event, at });

    // Drop the oldest rather than refusing the newest. Recent behaviour is the
    // behaviour the bandit can still act on.
    if (this.queue.length > this.config.maxQueued) {
      this.queue = this.queue.slice(this.queue.length - this.config.maxQueued);
    }

    this.persist();
  }

  /** Should the queue be flushed now? */
  shouldFlush(now: number): FlushReason | null {
    if (this.queue.length === 0) return null;
    if (this.queue.length >= this.config.batchSize) return 'batch-full';

    const oldest = this.queue[0];
    if (oldest !== undefined && now - oldest.at >= this.config.maxAgeMs) return 'max-age';

    return null;
  }

  /**
   * Take everything out of the queue for sending.
   *
   * The queue is cleared *before* the send, not after. If the send fails the caller
   * calls `restoreFailed`, which puts them back. Clearing after would mean a send that
   * never resolves — the common case when a tab is closing — leaves the events queued
   * forever and re-sent on the next visit.
   */
  take(): readonly ClientEvent[] {
    const taken = this.queue.map((q) => q.event);
    this.queue = [];
    try {
      this.storage.clear();
    } catch {
      // Same reason as `persist`: in a private window, or with storage blocked, every
      // access throws. The in-memory queue is already empty, which is what correctness
      // depends on — the persisted copy is an optimisation, and losing it costs at most
      // one duplicated batch, which `uniq(event_id)` absorbs downstream.
    }
    return taken;
  }

  /**
   * Put a failed batch back at the front.
   *
   * At the front, because these are older than anything enqueued since. Order matters
   * only for eviction — the server does not care — but evicting a *newer* event while
   * keeping an older one would be exactly backwards.
   */
  restoreFailed(events: readonly ClientEvent[], at: number): void {
    this.queue = [...events.map((event) => ({ event, at })), ...this.queue];
    if (this.queue.length > this.config.maxQueued) {
      this.queue = this.queue.slice(this.queue.length - this.config.maxQueued);
    }
    this.persist();
  }

  private persist(): void {
    try {
      this.storage.write(JSON.stringify(this.queue));
    } catch {
      // Storage can be full, or disabled entirely in a private window. Measurement is
      // not worth breaking a page over: keep the events in memory and carry on.
    }
  }

  /**
   * Read the persisted queue.
   *
   * Anything that does not parse, or is not the shape expected, is discarded rather
   * than repaired. The stored value is from a previous version of this code as often
   * as it is corrupt, and guessing at a half-understood payload is how a client bug
   * becomes a server bug.
   */
  private restore(): QueuedEvent[] {
    try {
      const raw = this.storage.read();
      if (raw === null) return [];

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (entry): entry is QueuedEvent =>
          typeof entry === 'object' &&
          entry !== null &&
          'event' in entry &&
          'at' in entry &&
          typeof (entry as { at: unknown }).at === 'number',
      );
    } catch {
      return [];
    }
  }
}

/**
 * Split a batch so no request exceeds `sendBeacon`'s limit.
 *
 * The browser silently returns `false` for an over-sized payload — no error, no event,
 * nothing to notice. Splitting up front means the limit can never be the reason
 * measurement stopped working.
 */
export const SEND_BEACON_LIMIT_BYTES = 64 * 1024;

export function chunkForBeacon(
  events: readonly ClientEvent[],
  limitBytes = SEND_BEACON_LIMIT_BYTES,
): readonly (readonly ClientEvent[])[] {
  const chunks: ClientEvent[][] = [];
  let current: ClientEvent[] = [];

  for (const event of events) {
    const candidate = [...current, event];
    // Measured on the actual serialisation, including the envelope, rather than
    // estimated from a field count. The envelope is small but the margin is smaller.
    if (JSON.stringify({ events: candidate }).length > limitBytes && current.length > 0) {
      chunks.push(current);
      current = [event];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
