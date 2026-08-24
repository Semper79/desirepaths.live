/**
 * `POST /i` — the event collector.
 *
 * This route runs 5,000 times a second. Everything about it is shaped by that:
 *
 *  - It responds **202 Accepted** as soon as the batch is on its way to the broker. The
 *    client does not need to know whether ClickHouse ingested it, and making it wait
 *    would couple page unload to a merge storm.
 *  - It returns an empty body. A beacon's response is discarded by the browser; sending
 *    JSON would be 200 bytes × 5,000/s of pure waste.
 *  - It does no logging on the happy path. At this rate, one log line per request is the
 *    largest disk write in the system.
 *  - Rate limiting happens **after** enrichment, because the limiter's key is the
 *    derived anonymous id, and deriving it is cheaper than the parse that precedes it
 *    anyway.
 *
 * A rejected event is counted, not logged individually — a client bug would otherwise
 * produce millions of identical lines. The counter is what the alert watches.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONSENT_DEFAULT } from '@morph/core';
import { enrich, type RequestMeta } from '../lib/enrich.js';
import type { SaltCache } from '../lib/anon-id.js';
import type { EventSink } from '../lib/producer.js';
import { INGEST_BUCKET, TokenBucketLimiter } from '../lib/rate-limit.js';

export interface IngestDeps {
  readonly sink: EventSink;
  readonly saltCache: SaltCache;
  readonly selfHost: string;
  readonly timezone: string;
  readonly metrics: IngestMetrics;
  /** Injected so tests control time; production passes `() => new Date()`. */
  readonly now: () => Date;
}

export interface IngestMetrics {
  accepted(count: number): void;
  rejected(count: number, reason: string): void;
  rateLimited(): void;
  sinkFailure(): void;
}

/** A counting implementation, good enough until Prometheus is wired in Phase 8. */
export class CountingMetrics implements IngestMetrics {
  acceptedTotal = 0;
  rejectedTotal = 0;
  rateLimitedTotal = 0;
  sinkFailureTotal = 0;
  readonly rejectionReasons = new Map<string, number>();

  accepted(count: number): void {
    this.acceptedTotal += count;
  }

  rejected(count: number, reason: string): void {
    this.rejectedTotal += count;
    // Bounded: an attacker controls the reason only indirectly, but a map keyed by a
    // zod message could still grow. Keep the top offenders and drop the tail.
    if (this.rejectionReasons.size < 64 || this.rejectionReasons.has(reason)) {
      this.rejectionReasons.set(reason, (this.rejectionReasons.get(reason) ?? 0) + 1);
    }
  }

  rateLimited(): void {
    this.rateLimitedTotal += 1;
  }

  sinkFailure(): void {
    this.sinkFailureTotal += 1;
  }
}

/**
 * Read the consent mask from the first-party cookie.
 *
 * Not from the payload: a script on the page can set a field, and a consent decision
 * that a script can set is not a consent decision. The cookie is set by the consent gate
 * on the server side and is `SameSite=Lax; Secure; HttpOnly`.
 */
export function consentMaskFromCookie(cookieHeader: string | undefined): number {
  if (cookieHeader === undefined) return CONSENT_DEFAULT;
  for (const part of cookieHeader.split(';')) {
    const [rawName, rawValue] = part.split('=');
    if ((rawName ?? '').trim() !== 'morph_consent') continue;
    const parsed = Number.parseInt((rawValue ?? '').trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 15) return parsed;
    return CONSENT_DEFAULT;
  }
  return CONSENT_DEFAULT;
}

/**
 * The client IP, taken from the header Caddy sets.
 *
 * `X-Forwarded-For` is a client-controllable list; only the value the trusted proxy
 * appended can be believed, which is why Caddy sets `X-Real-IP` explicitly and that is
 * what is read here. Trusting the leftmost `X-Forwarded-For` entry — the common mistake —
 * lets any client choose its own identifier.
 */
export function clientIp(request: FastifyRequest): string {
  const real = request.headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  return request.ip;
}

export function registerIngestRoute(app: FastifyInstance, deps: IngestDeps): void {
  const limiter = new TokenBucketLimiter(INGEST_BUCKET);

  app.post('/i', async (request: FastifyRequest, reply: FastifyReply) => {
    const now = deps.now();

    const meta: RequestMeta = {
      ip: clientIp(request),
      userAgent: header(request, 'user-agent'),
      acceptLanguage: header(request, 'accept-language'),
      secFetchSite: header(request, 'sec-fetch-site'),
      chUaMobile: header(request, 'sec-ch-ua-mobile'),
      chUaPlatform: header(request, 'sec-ch-ua-platform'),
      // Set by the edge from its own geo database. `ZZ` when unknown; never inferred
      // from the IP inside this process, which has already discarded it.
      country: (header(request, 'x-country') ?? 'ZZ').slice(0, 2).toUpperCase(),
      hasCookies: header(request, 'cookie') !== undefined,
      consentMask: consentMaskFromCookie(header(request, 'cookie')),
      now,
    };

    const result = enrich(request.body, meta, {
      saltCache: deps.saltCache,
      selfHost: deps.selfHost,
      timezone: deps.timezone,
    });

    for (const rejection of result.rejected) {
      deps.metrics.rejected(1, rejection.reason);
    }

    // A wholly malformed body is a client bug worth telling the client about; a partial
    // rejection is not, because the beacon has already been discarded by the browser.
    if (result.anonId === null) {
      return reply.code(400).send();
    }

    const decision = limiter.consume(result.anonId, now.getTime(), result.events.length || 1);
    if (!decision.allowed) {
      deps.metrics.rateLimited();
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)))
        .send();
    }

    if (result.events.length === 0) {
      // Everything in the batch was rejected. Nothing to publish, and nothing the
      // client can usefully do about it.
      return reply.code(202).send();
    }

    try {
      await deps.sink.publish(result.events);
    } catch {
      // 503, not 500: the client's retry queue should try again, and a 5xx that is not
      // explicitly retryable tends to be dropped.
      deps.metrics.sinkFailure();
      return reply.code(503).header('retry-after', '5').send();
    }

    deps.metrics.accepted(result.events.length);
    return reply.code(202).send();
  });
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}
