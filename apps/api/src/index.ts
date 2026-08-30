/**
 * Entry point.
 *
 * Boot order matters: validate the environment, connect the sink, and only then listen.
 * A process that accepts requests before it can publish them returns 503 to every
 * caller for its first few seconds — which a load balancer reads as a failed deploy.
 */

import { createServer } from 'node:http';
import { CONTENT_TYPE, collectRuntimeMetrics, renderMetrics } from '@morph/metrics';
import { loadEnv } from './env.js';
import { RedpandaSink } from './lib/producer.js';
import { prometheusMetrics } from './lib/prometheus-metrics.js';
import { buildServer } from './server.js';

const env = loadEnv();

const sink = new RedpandaSink({
  brokers: env.REDPANDA_BROKERS,
  topic: env.REDPANDA_TOPIC_EVENTS,
  lingerMs: env.REDPANDA_LINGER_MS,
  batchBytes: env.REDPANDA_BATCH_BYTES,
});

collectRuntimeMetrics('api');

const app = buildServer({
  sink,
  pepper: env.ANON_ID_PEPPER,
  selfHost: new URL(env.MORPH_PUBLIC_URL).hostname,
  timezone: env.MORPH_TIMEZONE,
  metrics: prometheusMetrics(),
  logger: true,
});

/**
 * Metrics on their own port, which is what `infra/prometheus/prometheus.yml` has always
 * scraped and what nothing has ever served.
 *
 * A separate listener rather than a route on the public server, for two reasons that both
 * matter. The public port sits behind Caddy and is reachable from the internet; an
 * exposition endpoint there would publish the shape of the system's traffic to anyone who
 * asked. And a scrape every fifteen seconds should not compete for the same connection
 * pool as a beacon at five thousand a second.
 */
const metricsServer = createServer((request, response) => {
  if (request.url !== '/metrics') {
    response.writeHead(404).end();
    return;
  }

  renderMetrics()
    .then((body) => {
      response.writeHead(200, { 'content-type': CONTENT_TYPE });
      response.end(body);
    })
    .catch(() => {
      // A failed scrape must never take the collector with it. Prometheus records the
      // target as down, which is itself the signal.
      response.writeHead(500).end();
    });
});

async function start(): Promise<void> {
  await sink.connect();
  metricsServer.listen(env.PROMETHEUS_METRICS_PORT);
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
  metricsServer.close();
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
