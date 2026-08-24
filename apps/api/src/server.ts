/**
 * The Fastify instance.
 *
 * Built as a function taking its dependencies so the tests exercise the real server
 * rather than a stub of it. `app.inject()` runs the full request lifecycle in-process,
 * which means the route tests cover the routing, the parsing and the error handling —
 * not just the handler body.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { SaltCache } from './lib/anon-id.js';
import type { EventSink } from './lib/producer.js';
import { CountingMetrics, registerIngestRoute, type IngestMetrics } from './routes/ingest.js';
import { registerHealthRoutes } from './routes/health.js';

export interface ServerOptions {
  readonly sink: EventSink;
  readonly pepper: string;
  readonly selfHost: string;
  readonly timezone: string;
  readonly version?: string;
  readonly metrics?: IngestMetrics;
  readonly now?: () => Date;
  readonly logger?: boolean;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    // Structured logs at warn level: at 5,000 requests per second, one info line per
    // request would be the largest disk write in the system. Errors still surface.
    // (Fastify's `disableRequestLogging` would do the same and is deprecated in v5.)
    logger: options.logger === true ? { level: 'warn' } : false,
    // A beacon carrying 50 events is a few kilobytes. Anything larger is not a beacon.
    bodyLimit: 256 * 1024,
    // Trust the proxy in front, but read the IP from the header Caddy sets explicitly -
    // see the note in routes/ingest.ts.
    trustProxy: true,
    // Requests are short-lived by design; a slow one is a stuck one.
    requestTimeout: 10_000,
  });

  const now = options.now ?? ((): Date => new Date());

  registerIngestRoute(app, {
    sink: options.sink,
    saltCache: new SaltCache(options.pepper),
    selfHost: options.selfHost,
    timezone: options.timezone,
    metrics: options.metrics ?? new CountingMetrics(),
    now,
  });

  registerHealthRoutes(app, {
    sink: options.sink,
    startedAt: now().getTime(),
    version: options.version ?? '0.1.0',
    now: () => now().getTime(),
  });

  return app;
}
