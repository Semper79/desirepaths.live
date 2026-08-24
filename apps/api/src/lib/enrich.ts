/**
 * Enrichment: turn a client beacon plus request metadata into the events that go on the
 * wire to Redpanda.
 *
 * This is the whole trust boundary of the ingest path, and it is pure so that it can be
 * exhaustively tested without a socket. The rule it enforces, in one sentence:
 *
 *     A client may report what it observed. The server decides what it is.
 *
 * Viewport width, scroll depth and session depth are observations only the browser has,
 * so they are accepted. Device class, country, referrer class, the anonymous identifier,
 * the consent mask and the bot score are claims about identity, and every one of them is
 * derived here from the request rather than read from the payload.
 *
 * Time is a parameter. Nothing in this file reads the clock.
 */

import {
  ClientBatchSchema,
  bucketOf,
  validateEvent,
  type IngestEvent,
  type VisitorContext,
} from '@morph/core';
import { botScore, classifyReferrer, deviceClass, viewportBucket } from './classify.js';
import type { SaltCache } from './anon-id.js';

export interface RequestMeta {
  /** Used to derive the anonymous id, then discarded. Never stored, never logged. */
  readonly ip: string;
  readonly userAgent?: string | undefined;
  readonly acceptLanguage?: string | undefined;
  readonly secFetchSite?: string | undefined;
  readonly chUaMobile?: string | undefined;
  readonly chUaPlatform?: string | undefined;
  /** ISO 3166-1 alpha-2 from the edge, or `ZZ`. Country only — never finer. */
  readonly country: string;
  readonly hasCookies: boolean;
  /** Consent mask read from the first-party cookie, not from the payload. */
  readonly consentMask: number;
  /** Present only for an authenticated session. */
  readonly userId?: string | undefined;
  /** Events per second recently observed for this identifier. Feeds the bot score. */
  readonly eventRate?: number | undefined;
  /** When the request arrived. */
  readonly now: Date;
}

export interface EnrichRejection {
  /** Index within the submitted batch, or -1 when the whole body was malformed. */
  readonly index: number;
  readonly reason: string;
}

export interface EnrichResult {
  readonly events: readonly IngestEvent[];
  readonly rejected: readonly EnrichRejection[];
  /** The derived identifier, returned so the caller can rate-limit on it. */
  readonly anonId: string | null;
}

export interface EnrichOptions {
  readonly saltCache: SaltCache;
  /** The site's own hostname, so self-referrals are classified as internal. */
  readonly selfHost: string;
  /** IANA timezone used for the hour-of-week feature. */
  readonly timezone: string;
}

/**
 * Hour of week in the operator's timezone, 0 = Monday 00:00.
 *
 * Deliberately the *operator's* timezone rather than the visitor's. The bandit is
 * learning when this audience is active relative to a single publishing schedule; a
 * feature expressed in each visitor's own local time would make "evening" mean twelve
 * different moments and the cyclical encoding meaningless.
 */
export function hourOfWeek(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayIndex = days.indexOf(weekday);
  return (dayIndex < 0 ? 0 : dayIndex) * 24 + (hour % 24);
}

/**
 * Enrich a batch.
 *
 * A malformed body is rejected wholesale — there is nothing to salvage and parsing
 * partial JSON is how a collector becomes an attack surface. A well-formed body with one
 * bad event keeps the rest: a single client bug should not cost a session's entire
 * measurement.
 */
export function enrich(body: unknown, meta: RequestMeta, options: EnrichOptions): EnrichResult {
  const parsed = ClientBatchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      events: [],
      rejected: [
        {
          index: -1,
          reason: first
            ? `${first.path.join('.') || '(root)'}: ${first.message}`
            : 'malformed body',
        },
      ],
      anonId: null,
    };
  }

  const batch = parsed.data;
  const anonId = options.saltCache.idFor(meta.ip, meta.userAgent ?? '', meta.now);

  const device = deviceClass({
    chUaMobile: meta.chUaMobile,
    chUaPlatform: meta.chUaPlatform,
    userAgent: meta.userAgent,
  });

  const { referrerClass, source } = classifyReferrer(batch.referrer, options.selfHost);

  const score = botScore({
    userAgent: meta.userAgent,
    acceptLanguage: meta.acceptLanguage,
    secFetchSite: meta.secFetchSite,
    hasCookies: meta.hasCookies,
    viewportWidth: batch.events[0]?.ctx.viewportWidth,
    eventRate: meta.eventRate,
  });

  const hw = hourOfWeek(meta.now, options.timezone);

  const events: IngestEvent[] = [];
  const rejected: EnrichRejection[] = [];

  batch.events.forEach((clientEvent, index) => {
    const ctx: VisitorContext = {
      device,
      viewport: viewportBucket(clientEvent.ctx.viewportWidth),
      referrerClass,
      source,
      country: meta.country,
      hourOfWeek: hw,
      depth: clientEvent.ctx.depth,
      returning: clientEvent.ctx.returning,
      // Language subtag only. A full locale narrows a visitor considerably more than
      // the measurement gains from knowing the region.
      locale: (clientEvent.ctx.locale.split('-')[0] ?? '').slice(0, 8),
      consentMask: meta.consentMask,
    };

    const event: IngestEvent = {
      v: 1,
      eventId: clientEvent.eventId,
      ts: clientEvent.ts,
      type: clientEvent.type,
      anonId,
      sessionId: clientEvent.sessionId,
      ...(meta.userId === undefined ? {} : { userId: meta.userId }),
      consentMask: meta.consentMask,
      ctx,
      path: clientEvent.path,
      ...(clientEvent.contentId === undefined ? {} : { contentId: clientEvent.contentId }),
      surfaces: clientEvent.surfaces,
      variants: clientEvent.variants,
      assignmentHash: clientEvent.assignmentHash,
      holdout: clientEvent.holdout,
      value: clientEvent.value,
      props: clientEvent.props,
      botScore: score,
    };

    const problems = validateEvent(event);
    if (problems.length > 0) {
      rejected.push({ index, reason: problems.join(' ') });
      return;
    }

    events.push(event);
  });

  return { events, rejected, anonId };
}

/** Context bucket for an enriched event, for metrics and for the assignment cache key. */
export function bucketFor(event: IngestEvent): string {
  return bucketOf(event.ctx);
}
