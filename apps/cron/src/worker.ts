/**
 * The scheduled Worker: the last link between the counters and what a visitor sees.
 *
 * Until this existed the chain stopped one step short. Beacons reached Analytics Engine,
 * sessions folded into the surface counters, and nothing read them — so the published
 * snapshot was never written and every surface resolved to its baseline for ever. The
 * engine had a producer and no consumer, which is the same shape the whole system was in
 * before the adapt job was written, one layer down.
 *
 * WHY A SEPARATE WORKER FROM THE COLLECTOR
 * Least privilege, and it is not theoretical here. The collector handles thousands of
 * requests a second from the open internet; this one holds the D1 binding that can retire a
 * variant and the KV key that decides what every visitor is shown. Putting both in one
 * script would mean an exploit in the beacon parser reaching the decision set.
 *
 * They do share the counters namespace, which a Durable Object permits across scripts
 * through `script_name`. That is the one coupling and it runs the right way round: the
 * collector writes through the session object, this reads.
 *
 * WHY IT REFUSES TO RUN WITHOUT THE ANALYTICS CREDENTIALS
 * `decideAdaptations` looks up each variant's health with `health.find(...)` and skips the
 * guardrail when it finds nothing. So a cycle with no readable vitals still retires variants
 * on reward evidence while being unable to quarantine a harmful one — the retirement loop
 * running with its safety off, reporting success.
 *
 * That is precisely what D30 was written about: a threshold checked against an absent
 * measurement is worse than no threshold, because it looks like protection. So the absence
 * is refused rather than warned about, the same treatment the controller gets in the
 * collector (D4) and the deterministic embedding provider gets in the worker.
 */

import { DEFAULT_ENGINE_CONFIG, EngineConfigSchema } from '@morph/core';
import { cycleConfigFrom, runAdapt, type Logger } from '@morph/cycle';
import type { AnalyticsEngineDataset, D1Database, KVNamespace } from '@cloudflare/workers-types';
import { cloudflareRewards, type CounterReader } from './adapters/rewards';
import { d1AdaptStore } from './adapters/adapt-store';
import { kvSnapshotPublisher } from './adapters/snapshot';

interface Env {
  /** Read-only here. The collector writes through the session object; this reads. */
  readonly COUNTERS: CounterReader;
  readonly DB: D1Database;
  readonly SNAPSHOT: KVNamespace;
  readonly METRICS: AnalyticsEngineDataset;

  /** The SQL API has no binding, so reading the event stream needs these. */
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly ANALYTICS_API_TOKEN: string;
  readonly MORPH_EVENTS_DATASET: string;

  /** `"0"` pauses adaptation without a deploy: the cycle still runs and still records. */
  readonly ADAPTATION_ENABLED: string;
}

/**
 * Structured JSON, because Workers Logs is the only observability this has.
 *
 * `packages/metrics` lost its pull endpoint with prom-client (D31), so a cycle's outcome
 * reaches a human either through these lines or through the hourly report. One line per
 * event and no free text: a cron that runs 24 times a day can afford to be legible.
 */
function workerLogger(): Logger {
  const emit = (level: string, event: string, fields?: Readonly<Record<string, unknown>>): void => {
    console.log(JSON.stringify({ level, event, ...fields }));
  };

  return {
    info: (event, fields) => {
      emit('info', event, fields);
    },
    warn: (event, fields) => {
      emit('warn', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
  };
}

/**
 * Which required values are absent. Named, so a failed run says what to fix.
 *
 * Typed as the three string keys rather than `keyof Env`: the bindings are objects, and a
 * `String()` over one would compare "[object Object]" against the empty string and always
 * pass. ESLint caught that, and the narrower type is the fix rather than a cast.
 */
type RequiredSecret = 'CLOUDFLARE_ACCOUNT_ID' | 'ANALYTICS_API_TOKEN' | 'MORPH_EVENTS_DATASET';

function missingConfig(env: Env): readonly RequiredSecret[] {
  const required: readonly RequiredSecret[] = [
    'CLOUDFLARE_ACCOUNT_ID',
    'ANALYTICS_API_TOKEN',
    'MORPH_EVENTS_DATASET',
  ];

  return required.filter((key) => env[key].length === 0);
}

/**
 * The live engine configuration, or the defaults.
 *
 * Parsed rather than cast. The row is written by the admin console, which means it crosses
 * a process boundary, and a malformed weight vector would not fail loudly — it would shift
 * what the engine optimises for. The schema's own refinement requires the positive weights
 * to sum to exactly one, so a bad row is rejected here and the cycle runs on the defaults
 * with a warning rather than on arithmetic nobody chose.
 */
async function engineConfigFrom(env: Env, log: Logger) {
  try {
    const row = await env.DB.prepare(`SELECT config FROM engine_config WHERE id = 1`).first<{
      config: string;
    }>();

    if (row === null) return DEFAULT_ENGINE_CONFIG;

    const parsed = EngineConfigSchema.safeParse(JSON.parse(row.config));
    if (parsed.success) return parsed.data;

    log.error('cycle.config-invalid', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return DEFAULT_ENGINE_CONFIG;
  } catch (error) {
    log.error('cycle.config-unreadable', {
      message: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_ENGINE_CONFIG;
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const log = workerLogger();

    const missing = missingConfig(env);
    if (missing.length > 0) {
      // Thrown, not logged and swallowed. A thrown scheduled handler is a failed invocation
      // in the dashboard, which is the only place a missed cron is visible — swallowing it
      // would make a cycle that never ran look like a cycle with nothing to do.
      log.error('cycle.not-configured', { missing });
      throw new Error(`the adapt cycle cannot run without: ${missing.join(', ')}`);
    }

    const engine = await engineConfigFrom(env, log);

    const outcome = await runAdapt(
      {
        rewards: cloudflareRewards(
          env.COUNTERS,
          { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.ANALYTICS_API_TOKEN },
          env.MORPH_EVENTS_DATASET,
        ),
        store: d1AdaptStore(env.DB),
        publisher: kvSnapshotPublisher(env.SNAPSHOT),
        config: cycleConfigFrom(engine),
        // `"0"` means the cycle still runs, still folds evidence and still records — it just
        // publishes a snapshot that tells the renderer to serve baselines. Pausing by not
        // running would leave a gap in the posteriors that no later run could fill.
        adaptationEnabled: env.ADAPTATION_ENABLED !== '0',
        now: () => controller.scheduledTime,
        log,
      },
      // No target hour: the cycle picks the most recent settled one itself, which is the
      // only correct answer for a scheduled run. An explicit hour is for a replay.
      {},
    );

    log.info('cycle.finished', { cron: controller.cron, ...outcome });

    // Nothing is deferred, but the parameter is part of the handler's contract and
    // destructuring it would break `waitUntil` for whoever adds the first deferred step.
    void ctx;
  },
} satisfies ExportedHandler<Env>;
