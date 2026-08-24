/**
 * The event contract.
 *
 * This schema is the boundary between the outside world and everything downstream.
 * The collector parses against it, the Redpanda payload matches it field for field,
 * and the ClickHouse materialised view in infra/clickhouse/init/001_events.sql reads
 * exactly these keys. When this changes, all three change together, and the topic
 * version in `.env.example` goes up.
 *
 * WHY THE KEYS ARE SHORT
 * A beacon is sent on unload, over a constrained mobile connection, at up to 5,000
 * per second. `ctx` instead of `context` and `v` instead of `version` is not
 * cleverness for its own sake - across 5M events a day it is real bandwidth, real
 * broker storage and real parse time, for zero loss of clarity in a schema this size.
 */

import { z } from 'zod';
import { VisitorContextSchema } from './context.js';

export const EVENT_TYPES = [
  /** First response of a session. */
  'land',
  'page_view',
  'scroll_depth',
  'engagement',
  'click',
  'signup_view',
  'signup_start',
  'signup_complete',
  'activated',
  'share',
  'web_vital',
  'client_error',
  'consent_change',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Hex-encoded 16-byte anonymous id: sha256(pepper || daily_salt || ip || ua)
 * truncated to 128 bits. Computed in the edge process; the inputs are discarded
 * immediately and never written anywhere.
 */
const AnonId = z.string().regex(/^[0-9a-f]{32}$/, 'anonId must be 32 lowercase hex characters');

export const IngestEventSchema = z.object({
  /** Schema version. Bumped only for breaking changes; additive fields do not bump it. */
  v: z.literal(1),
  /** Client-generated UUIDv7, which sorts by time and gives the pipeline idempotency. */
  eventId: z.string().uuid(),
  /** ISO-8601 with milliseconds, UTC. Clock skew is corrected against `ingested_at`. */
  ts: z.string().datetime({ offset: false }),
  type: z.enum(EVENT_TYPES),

  anonId: AnonId,
  sessionId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  consentMask: z.number().int().min(0).max(15),

  ctx: VisitorContextSchema,

  path: z.string().max(256),
  contentId: z.string().uuid().optional(),

  /**
   * The assignment the visitor was actually shown, as two parallel arrays. Sent on
   * every event, not just the first, because a session can span an assignment change
   * (a quarantine, an operator pin) and attributing later events to the earlier
   * assignment would silently corrupt the reward attribution.
   */
  surfaces: z.array(z.string().max(48)).max(32),
  variants: z.array(z.string().max(80)).max(32),
  /** 64-bit stable hash of the assignment vector, as a decimal string. */
  assignmentHash: z.string().regex(/^\d{1,20}$/),
  holdout: z.union([z.literal(0), z.literal(1)]),

  value: z.number().finite().default(0),
  props: z.record(z.string().max(32), z.string().max(256)).default({}),

  /** 0..100. Computed server-side; a client-supplied value is ignored. */
  botScore: z.number().int().min(0).max(100).default(0),
});

export type IngestEvent = z.infer<typeof IngestEventSchema>;

/**
 * Cross-field rules the schema cannot express.
 *
 * Kept separate from the schema so the hot path can do the cheap structural parse
 * first and reject 99% of malformed payloads before running any of this.
 */
export function validateEvent(event: IngestEvent): readonly string[] {
  const problems: string[] = [];

  if (event.surfaces.length !== event.variants.length) {
    problems.push('surfaces and variants must be the same length.');
  }

  if (event.type === 'scroll_depth' && (event.value < 0 || event.value > 100)) {
    problems.push('scroll_depth value must be a percentage.');
  }

  if (event.type === 'web_vital' && event.props['metric'] === undefined) {
    problems.push('web_vital events must name the metric in props.metric.');
  }

  if (event.type === 'signup_complete' && event.props['provider'] === undefined) {
    problems.push('signup_complete events must name the provider.');
  }

  // A timestamp far in the future is either a broken clock or a forged beacon;
  // either way it would poison the hour-of-week aggregates. The past is tolerated
  // generously because offline queues legitimately replay old events.
  const skewMs = Date.parse(event.ts) - Date.now();
  if (skewMs > 5 * 60_000) problems.push('Event timestamp is more than 5 minutes in the future.');

  return problems;
}

/** Batched beacon body. Clients coalesce events to survive flaky mobile networks. */
export const IngestBatchSchema = z.object({
  events: z.array(IngestEventSchema).min(1).max(50),
});

export type IngestBatch = z.infer<typeof IngestBatchSchema>;
