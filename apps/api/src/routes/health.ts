/**
 * `/health` and `/ready`.
 *
 * The distinction is the whole point and is routinely got wrong:
 *
 *  - **`/health`** — is this process alive? It must not touch a dependency. A liveness
 *    probe that fails because the broker is down restarts a healthy process during
 *    exactly the incident where restarts make things worse.
 *  - **`/ready`** — should this process receive traffic? It checks the dependencies it
 *    genuinely cannot serve without. A failing readiness probe removes the instance from
 *    the load balancer and leaves it running, which is the correct response to a
 *    downstream outage.
 */

import type { FastifyInstance } from 'fastify';
import type { EventSink } from '../lib/producer.js';

export interface HealthDeps {
  readonly sink: EventSink;
  readonly startedAt: number;
  readonly version: string;
  readonly now: () => number;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', () => ({
    status: 'ok',
    uptimeSeconds: Math.floor((deps.now() - deps.startedAt) / 1000),
    version: deps.version,
  }));

  app.get('/ready', (_request, reply) => {
    const checks = { sink: deps.sink.healthy };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });
}
