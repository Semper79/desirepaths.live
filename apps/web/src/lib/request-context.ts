/**
 * Turning an HTTP request into a `VisitorContext`.
 *
 * Runs in middleware, which is the only place with access to the raw request. What it
 * produces — an anonymous id and a bounded set of covariates — is passed downstream as
 * headers, and the raw inputs are discarded here and never travel further.
 *
 * WHERE THE ASSIGNMENT IS RESOLVED, AND WHY NOT HERE
 * The brief asks for edge middleware to perform variant assignment. Assignment needs
 * the posterior snapshot, and the snapshot lives in Redis — which the Edge runtime
 * cannot reach, because it has no TCP sockets. The options were:
 *
 *   a) Move the snapshot to an HTTP-reachable KV so middleware can fetch it. Adds a
 *      network round-trip to every request and a second datastore to operate.
 *   b) Resolve in the root layout, a React Server Component on the Node runtime, which
 *      already has the Redis connection.
 *
 * (b) is what this deployment does. The property that actually matters — the HTML that
 * leaves the origin is already adapted, so there is no client-side re-render and no
 * layout flash — holds either way, because both run before a byte is sent. What (a)
 * would buy is a few milliseconds of latency on a cache miss, at the cost of an extra
 * hop on every request. Revisit if the site ever moves to a platform where the edge and
 * the data are co-located.
 *
 * So middleware computes the *context*; the layout resolves the *assignment*.
 */

import { VisitorContextSchema, type VisitorContext, type VisitorIdentity } from '@morph/core';
import { maskFromCookieHeader } from './consent';

/** Headers middleware writes and the layout reads. Prefixed so they cannot collide. */
export const CONTEXT_HEADER = 'x-morph-context';
export const ANON_ID_HEADER = 'x-morph-anon';
export const BOT_SCORE_HEADER = 'x-morph-bot';

export interface EdgeRequest {
  readonly url: string;
  readonly headers: {
    get(name: string): string | null;
  };
  /** Set by the platform's geo lookup, when there is one. */
  readonly country?: string | undefined;
}

/**
 * Device class from Client Hints, falling back to the User-Agent.
 *
 * A trimmed version of the collector's classifier: middleware needs three buckets, and
 * duplicating the full heuristic here would mean two things to keep in step. The
 * collector's richer version is what labels the *events*; this one only has to pick a
 * covariate, and the two agreeing on phone/tablet/desktop is enough.
 */
function deviceFrom(headers: EdgeRequest['headers']): VisitorContext['device'] {
  const mobile = headers.get('sec-ch-ua-mobile');
  const platform = (headers.get('sec-ch-ua-platform') ?? '').replaceAll('"', '').toLowerCase();
  const ua = (headers.get('user-agent') ?? '').toLowerCase();

  if (mobile === '?1') return 'phone';
  if (mobile === '?0') return platform === 'android' ? 'tablet' : 'desktop';
  if (ua.includes('ipad') || (ua.includes('android') && !ua.includes('mobile'))) return 'tablet';
  if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) return 'phone';
  return 'desktop';
}

/**
 * Bot score from headers alone.
 *
 * Middleware has no behavioural signal — no event rate, no session history — so this is
 * necessarily weaker than the collector's. It is deliberately biased towards *calling
 * something a crawler*: the cost of a false positive is one human seeing the baseline,
 * which is a perfectly good experience; the cost of a false negative is a crawler
 * indexing a bandit-chosen variant, which is the failure this whole rule exists to
 * prevent. Asymmetric consequences, asymmetric threshold.
 */
const BOT_TOKENS = [
  'bot',
  'crawler',
  'spider',
  'scrape',
  'curl',
  'wget',
  'python-requests',
  'go-http-client',
  'headlesschrome',
  'facebookexternalhit',
  'lighthouse',
  'gptbot',
  'claudebot',
  'perplexitybot',
  'ccbot',
];

export function edgeBotScore(headers: EdgeRequest['headers']): number {
  const ua = (headers.get('user-agent') ?? '').toLowerCase();
  if (ua.length === 0) return 100;
  if (BOT_TOKENS.some((token) => ua.includes(token))) return 100;

  let score = 0;
  if ((headers.get('accept-language') ?? '').length === 0) score += 35;
  if (headers.get('sec-fetch-mode') === null) score += 25;
  if ((headers.get('accept') ?? '').includes('text/html')) score -= 10;
  return Math.max(0, Math.min(100, score));
}

/** Consent mask from the first-party cookie. Never from a query string or a header. */
export const consentFrom = maskFromCookieHeader;

const SOCIAL = [
  'tiktok.',
  'instagram.',
  'facebook.',
  'x.com',
  't.co',
  'reddit.',
  'discord.',
  'youtube.',
];
const SEARCH = ['google.', 'bing.', 'duckduckgo.', 'ecosia.', 'yandex.'];
const AI = [
  'chatgpt.',
  'chat.openai.',
  'perplexity.',
  'claude.ai',
  'copilot.microsoft.',
  'gemini.google.',
];

function referrerFrom(
  referer: string | null,
  selfHost: string,
): { referrerClass: VisitorContext['referrerClass']; source: string } {
  if (referer === null || referer.length === 0) {
    return { referrerClass: 'direct', source: 'direct' };
  }

  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return { referrerClass: 'direct', source: 'direct' };
  }

  if (host === selfHost || host.endsWith(`.${selfHost}`)) {
    return { referrerClass: 'internal', source: 'internal' };
  }

  const token = host.replace(/^www\./, '').split('.')[0] ?? 'unknown';
  const has = (list: readonly string[]): boolean => list.some((h) => host.includes(h));

  if (has(AI)) return { referrerClass: 'ai_agent', source: token };
  if (has(SEARCH)) return { referrerClass: 'search', source: token };
  if (has(SOCIAL)) return { referrerClass: 'social', source: token };
  return { referrerClass: 'referral', source: token };
}

/** Hour of week in the operator's timezone, 0 = Monday 00:00. */
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
  const index = days.indexOf(weekday);
  return (index < 0 ? 0 : index) * 24 + (hour % 24);
}

export interface BuildContextOptions {
  readonly identity: VisitorIdentity;
  readonly selfHost: string;
  readonly timezone: string;
  readonly now: Date;
  /** From the platform's geo header. Country only, never finer. */
  readonly country: string;
  /** Trusted proxy header. Never the leftmost X-Forwarded-For entry. */
  readonly ip: string;
}

export interface EdgeContext {
  readonly anonId: string;
  readonly botScore: number;
  readonly context: VisitorContext;
}

/**
 * Build the context for one request.
 *
 * The viewport is not known server-side on a first request — it is a client
 * measurement — so it is assumed from the device class. The client corrects it in the
 * first beacon, and the correction reaches the bandit through the events rather than
 * through a render-blocking round-trip.
 */
export async function buildContext(
  request: EdgeRequest,
  options: BuildContextOptions,
): Promise<EdgeContext> {
  const userAgent = request.headers.get('user-agent') ?? '';
  const anonId = await options.identity.idFor(options.ip, userAgent, options.now);
  const device = deviceFrom(request.headers);
  const { referrerClass, source } = referrerFrom(request.headers.get('referer'), options.selfHost);

  const context: VisitorContext = VisitorContextSchema.parse({
    device,
    viewport: device === 'phone' ? 'sm' : device === 'tablet' ? 'md' : 'lg',
    referrerClass,
    source: source.slice(0, 32),
    country: options.country.slice(0, 2).toUpperCase() || 'ZZ',
    hourOfWeek: hourOfWeek(options.now, options.timezone),
    depth: 0,
    returning: request.headers.get('cookie')?.includes('morph_seen=') ?? false,
    locale: (request.headers.get('accept-language') ?? 'en').split(',')[0]?.split('-')[0] ?? 'en',
    consentMask: consentFrom(request.headers.get('cookie')),
  });

  return { anonId, botScore: edgeBotScore(request.headers), context };
}

/** Serialise for the downstream header. Compact: it is on every request. */
export function encodeContext(context: VisitorContext): string {
  return JSON.stringify(context);
}

export function decodeContext(header: string | null): VisitorContext | null {
  if (header === null) return null;
  try {
    const parsed: unknown = JSON.parse(header);
    const result = VisitorContextSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
