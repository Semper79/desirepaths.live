/**
 * The queues, their payloads, and how a failure is retried.
 *
 * Payloads are zod schemas rather than interfaces because a queue is a process boundary:
 * the JSON that comes back out of Redis was written by a different deploy of this code,
 * possibly a different version of it, and `JSON.parse` returns `any` no matter how
 * confident the type annotation looks. §Conventions — anything crossing a process
 * boundary is parsed, never cast.
 *
 * WHY EACH JOB IS SMALL AND RESUMABLE
 * Every job here takes a batch size and processes one batch. Not because batching is
 * elegant, but because a job that runs for twenty minutes is a job that loses twenty
 * minutes of work when the worker is redeployed, and BullMQ's stalled-job detection will
 * eventually decide it died and run it again from the start. Small jobs that record
 * progress as they go are restartable at any point.
 */

import { z } from 'zod';

export const QUEUE = {
  crawl: 'morph.crawl',
  embed: 'morph.embed',
  cluster: 'morph.cluster',
  generate: 'morph.generate',
  prune: 'morph.prune',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// -----------------------------------------------------------------------------
// Payloads
// -----------------------------------------------------------------------------

export const CrawlJobSchema = z.object({
  /** How many sources this run may take. Bounded so one run cannot monopolise a worker. */
  batchSize: z.number().int().min(1).max(200).default(25),
});

export const EmbedJobSchema = z.object({
  batchSize: z.number().int().min(1).max(256).default(64),
});

export const ClusterJobSchema = z.object({
  batchSize: z.number().int().min(1).max(2_000).default(500),
  /** Documents older than this are not candidates for a new cluster. */
  windowHours: z.number().int().min(1).max(720).default(72),
});

export const GenerateJobSchema = z.object({
  /**
   * Deliberately small. Each draft costs an operator's attention in the review queue,
   * which is the scarcest resource in the system — a run that produces twenty drafts
   * produces twenty unread drafts.
   */
  maxDrafts: z.number().int().min(1).max(5).default(2),
});

export const PruneJobSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).default(30),
});

export type CrawlJob = z.infer<typeof CrawlJobSchema>;
export type EmbedJob = z.infer<typeof EmbedJobSchema>;
export type ClusterJob = z.infer<typeof ClusterJobSchema>;
export type GenerateJob = z.infer<typeof GenerateJobSchema>;
export type PruneJob = z.infer<typeof PruneJobSchema>;

export const JOB_SCHEMAS = {
  [QUEUE.crawl]: CrawlJobSchema,
  [QUEUE.embed]: EmbedJobSchema,
  [QUEUE.cluster]: ClusterJobSchema,
  [QUEUE.generate]: GenerateJobSchema,
  [QUEUE.prune]: PruneJobSchema,
} as const;

// -----------------------------------------------------------------------------
// Scheduling and retries
// -----------------------------------------------------------------------------

export interface QueuePolicy {
  /** Cron expression for the repeatable job, in the operator's timezone. */
  readonly cron: string;
  readonly attempts: number;
  readonly backoffMs: number;
  /**
   * How many jobs from this queue may run at once *in one process*.
   *
   * `crawl` is 1 and is not configurable. `PolitenessScheduler` holds its per-host leases
   * in process memory, so two concurrent crawl jobs sharing one fetcher would still be
   * correct, but two crawl *workers* would not — see the warning in `jobs/crawl.ts`.
   */
  readonly concurrency: number;
}

export const POLICY: Readonly<Record<QueueName, QueuePolicy>> = {
  // Hourly, because the momentum score buckets by hour and a finer cadence would measure
  // noise. Offset from the top of the hour so a crawl is finishing, not starting, when
  // the report is composed.
  [QUEUE.crawl]: { cron: '10 * * * *', attempts: 3, backoffMs: 30_000, concurrency: 1 },

  // Every ten minutes: embedding is the cheapest stage and keeping the backlog short
  // means clustering always has fresh material.
  [QUEUE.embed]: { cron: '*/10 * * * *', attempts: 5, backoffMs: 10_000, concurrency: 2 },

  [QUEUE.cluster]: { cron: '25 * * * *', attempts: 3, backoffMs: 30_000, concurrency: 1 },

  // Twice a day rather than hourly. There is no reader for twelve machine-written
  // articles a day, and no operator with the attention to review them.
  [QUEUE.generate]: { cron: '30 7,15 * * *', attempts: 2, backoffMs: 60_000, concurrency: 1 },

  // Nightly, off-peak. Deleting a day of documents is a large write and there is no
  // reason for it to compete with a crawl.
  [QUEUE.prune]: { cron: '15 4 * * *', attempts: 2, backoffMs: 60_000, concurrency: 1 },
};

/**
 * Parse a payload arriving from Redis.
 *
 * Returns the defaults for `undefined`, which is what a manually-enqueued job or an
 * older producer looks like. A payload that is present but wrong throws, because a job
 * silently running with a batch size of 25 when the operator asked for 200 is worse than
 * a job that fails and says so.
 */
export function parseJob<T extends QueueName>(
  queue: T,
  payload: unknown,
): z.infer<(typeof JOB_SCHEMAS)[T]> {
  const schema = JOB_SCHEMAS[queue];
  const result = schema.safeParse(payload ?? {});

  if (!result.success) {
    throw new Error(
      `Malformed ${queue} payload: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  return result.data;
}
