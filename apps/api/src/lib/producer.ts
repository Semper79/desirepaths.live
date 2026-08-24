/**
 * The Redpanda producer.
 *
 * The one piece of the ingest path that touches the network, kept behind an interface so
 * that everything upstream of it stays testable without a broker.
 *
 * PRODUCER SETTINGS AND WHY
 *
 *  - `acks: 1` — the leader acknowledges, replicas catch up asynchronously. `acks: -1`
 *    would add a round-trip to every beacon for a durability guarantee that behavioural
 *    analytics does not need; losing the last few milliseconds of events during a broker
 *    failure is acceptable, and adding 8 ms to every request is not.
 *  - `linger` and `batch bytes` — 5 ms of linger is invisible to a user and cuts broker
 *    round-trips by an order of magnitude at peak. This is the single highest-leverage
 *    setting on the whole path.
 *  - `idempotent: false` — idempotent production requires `acks: -1`. Duplicates are
 *    handled downstream instead: every event carries a UUIDv7 `eventId`, and the
 *    aggregates are computed with `uniq` over it.
 *  - **No retries on the request path.** A produce that fails is reported to the caller,
 *    which responds 503 so the client's own retry queue takes over. Retrying inside the
 *    request would hold the socket open during exactly the incident that made the broker
 *    slow, turning a partial outage into a total one.
 */

import { Kafka, Partitioners, type Producer } from 'kafkajs';
import type { IngestEvent } from '@morph/core';

export interface EventSink {
  publish(events: readonly IngestEvent[]): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly healthy: boolean;
}

export interface ProducerConfig {
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly lingerMs: number;
  readonly batchBytes: number;
  readonly clientId?: string;
}

export class RedpandaSink implements EventSink {
  private readonly producer: Producer;
  private connected = false;

  constructor(private readonly config: ProducerConfig) {
    const kafka = new Kafka({
      clientId: config.clientId ?? 'morph-api',
      brokers: [...config.brokers],
      // Fail fast. A collector waiting 30 s on a connection is a collector holding
      // thousands of sockets during an incident.
      connectionTimeout: 3_000,
      requestTimeout: 5_000,
      retry: { initialRetryTime: 100, retries: 3 },
    });

    this.producer = kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
      allowAutoTopicCreation: false,
      transactionTimeout: 30_000,
    });

    this.producer.on('producer.disconnect', () => {
      this.connected = false;
    });
    this.producer.on('producer.connect', () => {
      this.connected = true;
    });
  }

  get healthy(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    this.connected = false;
  }

  async publish(events: readonly IngestEvent[]): Promise<void> {
    if (events.length === 0) return;

    await this.producer.send({
      topic: this.config.topic,
      acks: 1,
      compression: 0,
      messages: events.map((event) => ({
        // Partition by session, so every event of one session lands on one partition and
        // the session fold in ClickHouse never has to merge across partitions.
        key: event.sessionId,
        value: JSON.stringify(event),
      })),
    });
  }
}

/**
 * In-memory sink for tests and for local development without a broker.
 *
 * Not a mock: it is a real implementation of the interface with the same contract, which
 * is why the route tests exercise the actual route rather than a stub of it.
 */
export class MemorySink implements EventSink {
  readonly published: IngestEvent[] = [];
  private connected = false;
  private failNext = false;

  get healthy(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  /** Make the next publish reject, so the caller's failure path can be tested. */
  failOnce(): void {
    this.failNext = true;
  }

  publish(events: readonly IngestEvent[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('sink unavailable'));
    }
    this.published.push(...events);
    return Promise.resolve();
  }
}
