import { describe, expect, it } from 'vitest';
import type { ClientEvent } from '@morph/core';
import {
  BeaconQueue,
  chunkForBeacon,
  DEFAULT_QUEUE_CONFIG,
  SEND_BEACON_LIMIT_BYTES,
  type QueueStorage,
} from '../src/lib/beacon-queue';

/** An in-memory `QueueStorage`, and one that fails the way a private window does. */
const memoryStorage = (): QueueStorage & { value: string | null } => ({
  value: null,
  read(): string | null {
    return this.value;
  },
  write(v: string): void {
    this.value = v;
  },
  clear(): void {
    this.value = null;
  },
});

const hostileStorage = (): QueueStorage => ({
  read: () => {
    throw new Error('storage disabled');
  },
  write: () => {
    throw new Error('quota exceeded');
  },
  clear: () => {
    throw new Error('storage disabled');
  },
});

let counter = 0;
const event = (over: Partial<ClientEvent> = {}): ClientEvent => {
  counter += 1;
  return {
    v: 1,
    eventId: `018f1f8c-2f3a-7c2a-9e2b-${String(counter).padStart(12, '0')}`,
    ts: '2026-08-24T14:30:00.000Z',
    type: 'page_view',
    sessionId: '018f1f8c-2f3a-7c2a-9e2b-3d5a6f7b8c9e',
    ctx: { viewportWidth: 390, depth: 1, returning: false, locale: 'it' },
    path: '/',
    surfaces: ['hero.headline'],
    variants: ['hero.headline#v0'],
    assignmentHash: '12345678901234567',
    holdout: 0,
    value: 0,
    props: {},
    ...over,
  };
};

describe('flushing', () => {
  it('does not flush an empty queue', () => {
    expect(new BeaconQueue(memoryStorage()).shouldFlush(0)).toBeNull();
  });

  it('flushes once the batch is full', () => {
    const queue = new BeaconQueue(memoryStorage());
    for (let i = 0; i < DEFAULT_QUEUE_CONFIG.batchSize - 1; i += 1) queue.enqueue(event(), 0);
    expect(queue.shouldFlush(0)).toBeNull();

    queue.enqueue(event(), 0);
    expect(queue.shouldFlush(0)).toBe('batch-full');
  });

  it('flushes a part-full batch once it is old enough', () => {
    const queue = new BeaconQueue(memoryStorage());
    queue.enqueue(event(), 1_000);
    expect(queue.shouldFlush(1_100)).toBeNull();
    expect(queue.shouldFlush(1_000 + DEFAULT_QUEUE_CONFIG.maxAgeMs)).toBe('max-age');
  });

  it('measures age from the oldest event, not the newest', () => {
    const queue = new BeaconQueue(memoryStorage());
    queue.enqueue(event(), 0);
    queue.enqueue(event(), 9_000);
    // A steady trickle must not postpone the flush indefinitely.
    expect(queue.shouldFlush(DEFAULT_QUEUE_CONFIG.maxAgeMs)).toBe('max-age');
  });
});

describe('taking and returning a batch', () => {
  it('empties the queue when taken', () => {
    const queue = new BeaconQueue(memoryStorage());
    queue.enqueue(event(), 0);
    queue.enqueue(event(), 0);

    expect(queue.take()).toHaveLength(2);
    expect(queue.size).toBe(0);
    expect(queue.shouldFlush(0)).toBeNull();
  });

  /**
   * The queue is cleared *before* the send. A send that never resolves — the common
   * case when a tab is closing — would otherwise leave the events queued forever and
   * re-send them on the next visit.
   */
  it('clears storage on take, so an unresolved send cannot resurrect the batch', () => {
    const storage = memoryStorage();
    const queue = new BeaconQueue(storage);
    queue.enqueue(event(), 0);
    expect(storage.value).not.toBeNull();

    queue.take();
    expect(storage.value).toBeNull();
    expect(new BeaconQueue(storage).size).toBe(0);
  });

  it('puts a failed batch back at the front', () => {
    const queue = new BeaconQueue(memoryStorage());
    const first = event();
    queue.enqueue(first, 0);
    const taken = queue.take();

    const later = event();
    queue.enqueue(later, 100);
    queue.restoreFailed(taken, 200);

    // Older events first: order only matters for eviction, and evicting a newer event
    // while keeping an older one would be exactly backwards.
    expect(queue.peek().map((q) => q.event.eventId)).toEqual([first.eventId, later.eventId]);
  });
});

describe('bounded storage', () => {
  it('drops the oldest events past the cap', () => {
    const queue = new BeaconQueue(memoryStorage(), { ...DEFAULT_QUEUE_CONFIG, maxQueued: 3 });
    const events = [event(), event(), event(), event(), event()];
    for (const e of events) queue.enqueue(e, 0);

    expect(queue.size).toBe(3);
    // The three most recent survive: recent behaviour is what the bandit can act on.
    expect(queue.peek().map((q) => q.event.eventId)).toEqual([
      events[2]?.eventId,
      events[3]?.eventId,
      events[4]?.eventId,
    ]);
  });

  it('applies the cap when a failed batch is restored too', () => {
    const queue = new BeaconQueue(memoryStorage(), { ...DEFAULT_QUEUE_CONFIG, maxQueued: 2 });
    queue.enqueue(event(), 0);
    queue.restoreFailed([event(), event(), event()], 0);
    expect(queue.size).toBe(2);
  });
});

describe('persistence', () => {
  it('survives a reload', () => {
    const storage = memoryStorage();
    const first = new BeaconQueue(storage);
    first.enqueue(event(), 0);
    first.enqueue(event(), 0);

    expect(new BeaconQueue(storage).size).toBe(2);
  });

  it('discards a corrupt or unrecognised stored payload rather than repairing it', () => {
    for (const stored of ['not json', '{"not":"an array"}', '[1,2,3]', '[{"nope":true}]']) {
      const storage = memoryStorage();
      storage.value = stored;
      expect(new BeaconQueue(storage).size, stored).toBe(0);
    }
  });

  it('keeps working when storage throws, as it does in a private window', () => {
    const queue = new BeaconQueue(hostileStorage());
    expect(queue.size).toBe(0);
    // Measurement is not worth breaking a page over: hold the events in memory.
    expect(() => {
      queue.enqueue(event(), 0);
    }).not.toThrow();
    expect(queue.size).toBe(1);
    expect(() => queue.take()).not.toThrow();
  });
});

describe('chunkForBeacon', () => {
  it('leaves a small batch in one piece', () => {
    expect(chunkForBeacon([event(), event()])).toHaveLength(1);
  });

  it('returns nothing for an empty batch', () => {
    expect(chunkForBeacon([])).toEqual([]);
  });

  /**
   * `sendBeacon` returns false for an over-sized payload — no error, no event, nothing
   * to notice. Splitting up front means the limit can never be why measurement stopped.
   */
  it('keeps every chunk under the sendBeacon limit', () => {
    const many = Array.from({ length: 400 }, () => event());
    const chunks = chunkForBeacon(many);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(JSON.stringify({ events: chunk }).length).toBeLessThanOrEqual(SEND_BEACON_LIMIT_BYTES);
    }
    expect(chunks.flat()).toHaveLength(400);
  });

  it('never drops an event that cannot fit on its own', () => {
    // A single oversized event still goes out, in a chunk of one. Losing it silently
    // would be worse than a request the server rejects and reports.
    const huge = event({ props: { blob: 'x'.repeat(300) } });
    const chunks = chunkForBeacon([huge], 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });
});
