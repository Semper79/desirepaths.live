/**
 * Entry point.
 *
 * Boot order matters: validate the environment, connect the sink, and only then listen.
 * A process that accepts requests before it can publish them returns 503 to every
 * caller for its first few seconds — which a load balancer reads as a failed deploy.
 */

import { loadEnv } from './env.js';
import { RedpandaSink } from './lib/producer.js';
import { buildServer } from './server.js';

const env = loadEnv();

const sink = new RedpandaSink({
  brokers: env.REDPANDA_BROKERS,
  topic: env.REDPANDA_TOPIC_EVENTS,
  lingerMs: env.REDPANDA_LINGER_MS,
  batchBytes: env.REDPANDA_BATCH_BYTES,
});

const app = buildServer({
  sink,
  pepper: env.ANON_ID_PEPPER,
  selfHost: new URL(env.MORPH_PUBLIC_URL).hostname,
  timezone: env.MORPH_TIMEZONE,
  logger: true,
});

async function start(): Promise<void> {
  await sink.connect();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

/**
 * Graceful shutdown.
 *
 * Fastify stops accepting connections and drains in-flight requests; only then does the
 * producer disconnect, so no accepted beacon is lost between the two. Without the
 * ordering, a rolling deploy quietly drops a few seconds of events each time.
 */
async function stop(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await sink.disconnect();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void stop(signal);
  });
}

start().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${String(error)}\n`);
  process.exit(1);
});
