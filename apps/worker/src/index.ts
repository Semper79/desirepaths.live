/**
 * The composition root.
 *
 * The only file in this app that knows Postgres, Redis, BullMQ and Anthropic all exist at
 * once. It builds the adapters, hands them to the jobs as ports, registers the repeatable
 * schedules and gets out of the way.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE, and deliberately: there is nothing here to test that
 * would not be testing BullMQ. Every decision worth asserting lives in `src/jobs/`, behind
 * the seam, where it is exercised without a network. This file's correctness is
 * "it starts and the queues drain", which is an integration concern.
 *
 * ONE CRAWL WORKER. `PolitenessScheduler` holds its per-host leases in this process's
 * memory. Running a second replica of this app means two processes each believing they
 * hold the only lease for a host, and "one concurrent request per host" — the first line
 * of `docs/COMPLIANCE.md` §2 — silently stops being true. The crawl queue's concurrency is
 * pinned to 1 and scaling out needs the lease moved to Redis first.
 */

import { createServer } from 'node:http';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DEFAULT_FETCHER_CONFIG, DEFAULT_POLITENESS, PoliteFetcher } from '@morph/crawler';
import { DEFAULT_ENGINE_CONFIG } from '@morph/core';
import { loadEnv, type Env } from './env.js';
import { POLICY, QUEUE, parseJob, type QueueName } from './queues.js';
import { createLogger } from './adapters/logger.js';
import { deterministicEmbeddings } from './adapters/deterministic-embeddings.js';
import { httpEmbeddings } from './adapters/http-embeddings.js';
import { anthropicGenerator } from './adapters/anthropic-generator.js';
import { anthropicProse } from './adapters/anthropic-prose.js';
import { clickhouseEngagement, clickhouseQuery } from './adapters/clickhouse.js';
import {
  CONTENT_TYPE,
  adaptCycleHour,
  collectRuntimeMetrics,
  explorationRate,
  queueFailed,
  queueWaiting,
  renderMetrics,
  variantsQuarantined,
  variantsRetired,
} from '@morph/metrics';
import { clickhouseMetrics } from './adapters/clickhouse-metrics.js';
import { clickhouseRewards } from './adapters/clickhouse-rewards.js';
import { postgresAdapt } from './adapters/postgres-adapt.js';
import { redisSnapshotPublisher } from './adapters/redis-snapshot.js';
import { reportRepository, reportRunRepository } from './adapters/postgres-report.js';
import {
  audienceRepository,
  contentRepository,
  documentRepository,
  sourceRepository,
  trendRepository,
  type Database,
} from './adapters/postgres.js';
import { runCrawl } from './jobs/crawl.js';
import { runEmbed } from './jobs/embed.js';
import { runCluster } from './jobs/cluster.js';
import { runAdapt } from './jobs/adapt.js';
import { cycleConfigFrom } from './lib/adapt-derive.js';
import { runAudience } from './jobs/audience.js';
import { runGenerate } from './jobs/generate.js';
import { runPrune } from './jobs/prune.js';
import { dispatch } from './jobs/dispatch.js';
import { runReport } from './jobs/report.js';
import { runEscalate } from './jobs/escalate.js';
import type { AlertState } from './lib/escalation.js';
import { telegramClient, type TelegramClient } from './adapters/telegram-api.js';
import type { EmbeddingProvider, Logger } from './ports.js';

const env: Env = loadEnv(process.env);
const log = createLogger({ service: 'worker' });

const sql = postgres(env.DATABASE_URL, { max: 8 });
const db: Database = drizzle(sql);

// `maxRetriesPerRequest: null` is BullMQ's requirement for a blocking connection: without
// it, a Redis blip terminates the worker instead of reconnecting.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

const sources = sourceRepository(db);
const documents = documentRepository(db);
const trends = trendRepository(db);
const content = contentRepository(db);
const audience = audienceRepository(db);

const clickhouse = {
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DATABASE,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
};

const engagement = clickhouseEngagement(clickhouse);
const metrics = clickhouseMetrics(clickhouseQuery(clickhouse));
const rewards = clickhouseRewards(clickhouseQuery(clickhouse));
const adaptStore = postgresAdapt(db);

/**
 * A second Redis connection, not the BullMQ one.
 *
 * `connection` is configured with `maxRetriesPerRequest: null` because BullMQ requires
 * it, which turns every command into one that waits indefinitely rather than failing.
 * That is right for a queue and wrong for a publish inside a job: a snapshot write that
 * hangs would hold the cycle open past the next one's start.
 */
const snapshotRedis = new IORedis(env.REDIS_URL);
const publisher = redisSnapshotPublisher(snapshotRedis);
const report = reportRepository(db);
const runs = reportRunRepository(db);

/** For the uptime line. Set once, at boot, and never adjusted. */
const startedAt = Date.now();

/**
 * What the escalation job has already reported.
 *
 * In this process on purpose: a restart re-escalates whatever is still broken, which is
 * the right behaviour when a worker has just come back during an outage. See the note at
 * the top of `jobs/escalate.ts`.
 */
const escalationState: { known: ReadonlyMap<string, AlertState> } = { known: new Map() };

/**
 * Reward weights, for now the compiled-in defaults.
 *
 * They belong in the `engine_config` row the operator console will write — reading them
 * from there means the audience computation and the bandit retune together. Until that
 * console exists the defaults are the live values, and this is the one line that changes
 * when it does.
 */
const engineConfig = DEFAULT_ENGINE_CONFIG;

const fetcher = new PoliteFetcher(
  { fetch: globalThis.fetch, now: () => Date.now(), sleep: wait },
  {
    ...DEFAULT_FETCHER_CONFIG,
    userAgent: env.CRAWLER_USER_AGENT,
    timeoutMs: env.CRAWLER_TIMEOUT_MS,
    politeness: {
      ...DEFAULT_POLITENESS,
      globalQps: env.CRAWLER_GLOBAL_QPS,
      defaultCrawlDelayMs: env.CRAWLER_DEFAULT_CRAWL_DELAY_MS,
    },
  },
);

const embeddings = buildEmbeddings(env, log);

const generator = anthropicGenerator({
  // Guaranteed present: `refineEnv` refuses to boot without it, because the generate
  // queue is scheduled and would otherwise fail twice a day forever.
  apiKey: env.ANTHROPIC_API_KEY ?? '',
  model: env.ANTHROPIC_MODEL_GENERATION,
  maxTokens: 16_000,
});

/**
 * The report's prose pass.
 *
 * Sonnet rather than the generation model: the task is four sentences over text that is
 * already in front of it, it runs every hour, and the deterministic report is the fallback
 * if it says anything unverifiable. Paying Opus rates for a lead is paying for capability
 * this task does not use.
 */
const prose = anthropicProse({
  apiKey: env.ANTHROPIC_API_KEY ?? '',
  model: env.ANTHROPIC_MODEL_REPORT,
});

const now = (): number => Date.now();

/**
 * The bot, when it is configured.
 *
 * Null is a supported state, not a degraded one: a worker whose job is the crawl does not
 * need a Telegram token, and `refineEnv` has already refused the half-configured case
 * where a token exists without a chat id.
 */
const bot: TelegramClient | null =
  env.TELEGRAM_BOT_TOKEN !== undefined && env.TELEGRAM_CHAT_ID !== undefined
    ? telegramClient({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID })
    : null;

/**
 * The audience interest vector, as of the last time the audience job produced one.
 *
 * Read fresh at the start of every cluster run rather than cached at boot: the vector is
 * recomputed four times a day, and a worker that has been up for a week would otherwise
 * still be scoring against the vector it happened to start with.
 *
 * `null` before the first computation — and the cluster job then drops the term and says
 * so, rather than scoring against a fabricated one. See the note in `jobs/cluster.ts`.
 */
async function currentAudienceVector(): Promise<readonly number[] | null> {
  const snapshot = await audience.current();
  return snapshot?.vector ?? null;
}

const handlers: Readonly<Record<QueueName, (job: Job) => Promise<unknown>>> = {
  [QUEUE.crawl]: (job) =>
    runCrawl({ fetcher, sources, documents, now, log }, parseJob(QUEUE.crawl, job.data)),

  [QUEUE.embed]: (job) =>
    runEmbed({ documents, embeddings, now, log }, parseJob(QUEUE.embed, job.data)),

  /**
   * The engine's numbers are emitted here rather than inside the job, so `runAdapt` stays
   * a pure function of its ports and its tests need no metrics fake. The composition root
   * is where I/O belongs, and a Prometheus counter is I/O by any honest definition.
   */
  [QUEUE.adapt]: async (job) => {
    const outcome = await runAdapt(
      {
        rewards,
        store: adaptStore,
        publisher,
        // Derived from the live engine config, so retuning the reward or the rollback
        // budgets retunes the loop rather than leaving it on a second, stale copy.
        config: cycleConfigFrom(engineConfig),
        adaptationEnabled: engineConfig.adaptationEnabled,
        now,
        log,
      },
      parseJob(QUEUE.adapt, job.data),
    );

    if (outcome.kind === 'applied') {
      variantsRetired.inc(outcome.retired);
      variantsQuarantined.inc(outcome.quarantined);
      adaptCycleHour.set(outcome.hour / 1000);

      // Left untouched when the hour measured nothing, rather than set to zero. A gauge
      // that reports no exploration on a quiet night would fire `ExplorationCollapsed`
      // every night, and an alert that cries wolf on a schedule is one nobody reads.
      if (outcome.explorationRate !== null) explorationRate.set(outcome.explorationRate);
    }

    return outcome;
  },

  [QUEUE.cluster]: async (job) =>
    runCluster(
      { documents, trends, audienceVector: await currentAudienceVector(), now, log },
      parseJob(QUEUE.cluster, job.data),
    ),

  [QUEUE.audience]: (job) =>
    runAudience(
      {
        engagement,
        content,
        trends,
        embeddings,
        audience,
        weights: engineConfig.weights,
        bouncePenalty: engineConfig.bouncePenalty,
        now,
        log,
      },
      parseJob(QUEUE.audience, job.data),
    ),

  [QUEUE.generate]: (job) =>
    runGenerate(
      { trends, documents, content, generator, now, log },
      parseJob(QUEUE.generate, job.data),
    ),

  [QUEUE.report]: (job) =>
    runReport(
      {
        metrics,
        report,
        runs,
        content,
        // The report sends through the same client the queue does, so a rate limit hit by
        // one is waited out for the other rather than raced against it.
        telegram: bot === null ? null : { send: (text) => bot.send(text) },
        prose,
        timezone: env.MORPH_TIMEZONE,
        startedAt,
        // Until the holdout's start is recorded, the cumulative lift covers everything
        // there is — which for a site that has not launched is the same window.
        holdoutSince: startedAt,
        autonomy: env.SOCIAL_AUTONOMY,
        now,
        log,
      },
      parseJob(QUEUE.report, job.data),
    ),

  [QUEUE.escalate]: () =>
    runEscalate({
      metrics,
      report,
      queues: {
        async failedCounts() {
          const counts = await Promise.all(
            queues.map(async (queue) => [queue.name, await queue.getFailedCount()] as const),
          );
          return Object.fromEntries(counts);
        },
      },
      telegram: bot === null ? null : { send: (text) => bot.send(text) },
      state: escalationState,
      now,
      log,
    }),

  [QUEUE.prune]: (job) => runPrune({ documents, now, log }, parseJob(QUEUE.prune, job.data)),
};

const workers = Object.values(QUEUE).map((name) => {
  const policy = POLICY[name];

  const worker = new Worker(name, handlers[name], {
    connection,
    concurrency: policy.concurrency,
  });

  worker.on('failed', (job, error) => {
    log.error('job.failed', {
      queue: name,
      jobId: job?.id ?? null,
      attempt: job?.attemptsMade ?? 0,
      message: error.message,
    });
  });

  return worker;
});

const queues = Object.values(QUEUE).map((name) => new Queue(name, { connection }));

async function registerSchedules(): Promise<void> {
  for (const queue of queues) {
    const policy = POLICY[queue.name as QueueName];

    await queue.upsertJobScheduler(
      // A stable key, so redeploying replaces the schedule rather than adding a second
      // copy of it — the failure mode being every job running twice an hour.
      `${queue.name}.schedule`,
      { pattern: policy.cron, tz: env.MORPH_TIMEZONE },
      {
        opts: {
          attempts: policy.attempts,
          backoff: { type: 'exponential', delay: policy.backoffMs },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      },
    );
  }
}

/**
 * Liveness and readiness, split for the same reason as in `apps/api`: a worker that is
 * alive but cannot reach Redis should be restarted, not merely taken out of rotation, and
 * conflating the two makes both answers useless.
 */
collectRuntimeMetrics('worker');

/**
 * Queue depth, read at scrape time rather than pushed.
 *
 * A gauge that is only updated when a job runs reports the depth as it was during the last
 * job, which on a stalled queue is the one number that will never change again — precisely
 * the situation `QueueBacklog` in `morph.yml` exists to catch. Reading on scrape costs one
 * round trip per queue every fifteen seconds and always describes now.
 */
async function sampleQueueDepth(): Promise<void> {
  await Promise.all(
    queues.map(async (queue) => {
      const [waiting, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getFailedCount(),
      ]);

      queueWaiting.set({ queue: queue.name }, waiting);
      queueFailed.set({ queue: queue.name }, failed);
    }),
  );
}

const health = createServer((request, response) => {
  const ready = connection.status === 'ready';

  if (request.url === '/metrics') {
    sampleQueueDepth()
      .catch(() => {
        // A Redis that cannot answer leaves the queue gauges at their previous values,
        // which is stale but not wrong — and the `up` series plus `ServiceDown` already
        // say the worker is in trouble. Failing the whole scrape would take the runtime
        // metrics down with it, and those are the ones that explain why.
      })
      .then(renderMetrics)
      .then((body) => {
        response.writeHead(200, { 'content-type': CONTENT_TYPE });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(500).end();
      });
    return;
  }

  if (request.url === '/ready') {
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready, redis: connection.status }));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ alive: true, queues: Object.values(QUEUE) }));
});

async function shutdown(signal: string): Promise<void> {
  log.info('worker.shutdown', { signal });

  // Workers first: a job in flight finishes before the connections it depends on close.
  // The reverse order is how a crawl job dies mid-batch holding a host's lease.
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(queues.map((queue) => queue.close()));
  await connection.quit();
  await sql.end();
  health.close();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        log.error('worker.shutdown-failed', { message: String(error) });
        process.exit(1);
      },
    );
  });
}

/**
 * The update loop.
 *
 * Long polling, sequential, and deliberately not a queue. Telegram's `offset` is the
 * acknowledgement — asking for updates after N is what tells the server the ones before N
 * were handled — so an update that is enqueued and then lost is an update Telegram
 * believes was delivered. Handling one at a time and advancing the offset afterwards
 * means a crash re-delivers rather than drops.
 *
 * A failure to handle one update must not stop the loop: the operator's next message is
 * the most likely way anybody finds out something is wrong, and a bot that stopped
 * listening cannot be asked.
 */
async function pollForever(client: TelegramClient): Promise<void> {
  let offset = 0;

  for (;;) {
    try {
      const updates = await client.poll(offset);

      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          await handleUpdate(client, update.raw);
        } catch (error) {
          log.error('telegram.handler-failed', {
            updateId: update.update_id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      log.error('telegram.poll-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      // Telegram is down, the network is out, or the token was revoked. Backing off keeps
      // a hard failure from becoming a tight loop against their API.
      await wait(5_000);
    }
  }
}

async function handleUpdate(client: TelegramClient, raw: unknown): Promise<void> {
  const outcome = await dispatch(
    {
      content,
      policy: {
        allowedChatId: env.TELEGRAM_CHAT_ID ?? '',
        adminUserIds: env.TELEGRAM_ADMIN_USER_IDS,
      },
      origin: env.MORPH_PUBLIC_URL,
      now,
      log,
    },
    raw,
  );

  // Acknowledged first: until this returns, Telegram shows the button spinning, and a
  // slow edit would leave the operator watching a loader wondering whether it worked.
  if (outcome.acknowledge !== undefined) {
    await client.answerCallback(outcome.acknowledge.callbackId, outcome.acknowledge.text);
  }

  for (const reply of outcome.replies) {
    if (reply.editMessageId === undefined) await client.send(reply.text, reply.keyboard);
    else await client.edit(reply.editMessageId, reply.text);
  }
}

await registerSchedules();
health.listen(env.WORKER_HEALTH_PORT);

if (bot !== null) {
  // Not awaited: the loop never returns. Failures inside it are logged, and the process
  // stays up for the queues.
  void pollForever(bot);
}

log.info('worker.started', {
  queues: Object.values(QUEUE),
  embeddings: embeddings.name,
  healthPort: env.WORKER_HEALTH_PORT,
  timezone: env.MORPH_TIMEZONE,
  bot: bot === null ? 'not configured' : 'polling',
});

function buildEmbeddings(config: Env, logger: Logger): EmbeddingProvider {
  if (config.EMBEDDING_PROVIDER === 'deterministic') {
    // `refineEnv` has already refused this in production. The warning is for the developer
    // who forgot they set it and is wondering why their clusters make no sense.
    logger.warn('embed.provider-is-a-stand-in', {
      detail: 'Vectors carry no semantic meaning; clustering will group by token overlap.',
    });
    return deterministicEmbeddings(config.EMBEDDING_DIMENSIONS);
  }

  return httpEmbeddings({
    provider: config.EMBEDDING_PROVIDER,
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    apiKey: config.EMBEDDING_API_KEY ?? '',
    baseUrl: config.EMBEDDING_BASE_URL,
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
