/**
 * Request classification: device, viewport, referrer class, traffic source, bot score.
 *
 * Everything here runs on the ingest hot path, so it is pure, allocation-light, and
 * free of regular expressions that backtrack. It also runs on data that is about to be
 * discarded — the User-Agent is classified and then dropped, never stored.
 *
 * A note on why this is heuristic and unapologetic about it: every alternative is worse.
 * A User-Agent parsing library is a 200 KB dependency updated weekly that answers a
 * question we only need three buckets of. A commercial bot-detection service is a
 * third-party processor, a per-request network call in a 5 ms budget, and a privacy
 * problem. The heuristics below are wrong sometimes; the design accounts for that by
 * using a *score* with a threshold rather than a boolean, so a misclassification costs
 * one excluded session rather than a wrong decision.
 */

import type { DeviceClass, ReferrerClass, ViewportBucket } from '@morph/core';

// -----------------------------------------------------------------------------
// Device
// -----------------------------------------------------------------------------

/**
 * Prefer Client Hints, fall back to the User-Agent.
 *
 * `Sec-CH-UA-Mobile` is a single unambiguous bit sent by every Chromium browser, and it
 * is *the* answer to the question "is this a phone" — far better than pattern-matching a
 * string that has been deliberately frozen and lied about for a decade. The UA path
 * exists for Safari and Firefox, which do not send hints.
 */
export function deviceClass(headers: {
  readonly chUaMobile?: string | undefined;
  readonly chUaPlatform?: string | undefined;
  readonly userAgent?: string | undefined;
}): DeviceClass {
  const ua = (headers.userAgent ?? '').toLowerCase();

  if (isBotUserAgent(ua)) return 'bot';
  if (ua.includes('smart-tv') || ua.includes('smarttv') || ua.includes('appletv')) return 'tv';

  if (headers.chUaMobile === '?1') return 'phone';
  if (headers.chUaMobile === '?0') {
    // A Chromium tablet reports mobile: ?0 but names its platform Android.
    const platform = (headers.chUaPlatform ?? '').replaceAll('"', '').toLowerCase();
    return platform === 'android' ? 'tablet' : 'desktop';
  }

  if (ua.includes('ipad') || (ua.includes('android') && !ua.includes('mobile'))) return 'tablet';
  if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) return 'phone';
  return 'desktop';
}

/** Viewport buckets, from the client-reported width. */
export function viewportBucket(width: number): ViewportBucket {
  if (width < 480) return 'xs';
  if (width < 768) return 'sm';
  if (width < 1024) return 'md';
  if (width < 1440) return 'lg';
  return 'xl';
}

// -----------------------------------------------------------------------------
// Referrer
// -----------------------------------------------------------------------------

const SEARCH_HOSTS = ['google.', 'bing.', 'duckduckgo.', 'ecosia.', 'yandex.', 'baidu.', 'brave.'];
const SOCIAL_HOSTS = [
  'tiktok.',
  'instagram.',
  'facebook.',
  'twitter.',
  'x.com',
  't.co',
  'reddit.',
  'discord.',
  'youtube.',
  'linkedin.',
  'threads.',
  'twitch.',
  'pinterest.',
  'mastodon.',
  'bsky.',
];
/**
 * AI answer engines get their own class.
 *
 * Traffic arriving from an AI answer lands already-informed, converts differently, and
 * is a growing share of the web. Folding it into `referral` would hide the most
 * interesting acquisition trend of the decade behind an average.
 */
const AI_HOSTS = [
  'chatgpt.',
  'chat.openai.',
  'perplexity.',
  'claude.ai',
  'copilot.microsoft.',
  'gemini.google.',
];
const EMAIL_HOSTS = ['mail.google.', 'outlook.', 'mail.yahoo.', 'proton.me'];

export interface ReferrerInfo {
  readonly referrerClass: ReferrerClass;
  /** Normalised, bounded source token. Never a full URL. */
  readonly source: string;
}

/**
 * Classify a referrer into a class and a bounded source token.
 *
 * The full referrer URL is never returned and never stored: it can carry a search query,
 * a private document title, or a session token in a query string. Only the registrable
 * part of the host survives, and only as a member of a bounded vocabulary.
 */
export function classifyReferrer(
  referrer: string | undefined,
  selfHost: string,
  utmSource?: string,
): ReferrerInfo {
  // An explicit campaign tag wins: it is what the operator asked to be measured, and it
  // is the only source token that did not have to be inferred.
  if (utmSource !== undefined && utmSource.length > 0) {
    return { referrerClass: 'campaign', source: normaliseToken(utmSource) };
  }

  if (referrer === undefined || referrer.length === 0) {
    return { referrerClass: 'direct', source: 'direct' };
  }

  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    // A malformed referrer is a client bug or a probe, not a source.
    return { referrerClass: 'direct', source: 'direct' };
  }

  if (host === selfHost || host.endsWith(`.${selfHost}`)) {
    return { referrerClass: 'internal', source: 'internal' };
  }

  const match = (list: readonly string[]): boolean => list.some((h) => host.includes(h));

  // Order is significant, from most specific host to least. `mail.google.com` and
  // `gemini.google.com` both contain `google.`, so checking search first would swallow
  // them - and an email referral counted as organic search quietly inflates the channel
  // the whole acquisition strategy is judged on.
  if (match(AI_HOSTS)) return { referrerClass: 'ai_agent', source: sourceToken(host) };
  if (match(EMAIL_HOSTS)) return { referrerClass: 'email', source: sourceToken(host) };
  if (match(SEARCH_HOSTS)) return { referrerClass: 'search', source: sourceToken(host) };
  if (match(SOCIAL_HOSTS)) return { referrerClass: 'social', source: sourceToken(host) };

  return { referrerClass: 'referral', source: sourceToken(host) };
}

/** Registrable-ish name: `www.google.co.uk` → `google`. Bounded and greppable. */
function sourceToken(host: string): string {
  const parts = host.replace(/^www\./, '').split('.');
  const name = parts.length > 2 ? parts[parts.length - 3] : parts[0];
  return normaliseToken(name ?? host);
}

function normaliseToken(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32) || 'unknown'
  );
}

// -----------------------------------------------------------------------------
// Bot scoring
// -----------------------------------------------------------------------------

const BOT_TOKENS = [
  'bot',
  'crawler',
  'spider',
  'scrape',
  'curl',
  'wget',
  'python-requests',
  'httpclient',
  'go-http-client',
  'okhttp',
  'headlesschrome',
  'phantomjs',
  'slurp',
  'facebookexternalhit',
  'preview',
  'lighthouse',
  'gtmetrix',
  'pingdom',
  'uptimerobot',
  // Our own load tests (`bench/`), which are the largest single source of synthetic
  // traffic this system will ever see: a four-hour soak writes tens of millions of
  // events. Without this token they arrive wearing a browser's User-Agent, score below
  // 60, and are counted as evidence — a benchmark that corrupts the thing it measures.
  //
  // Excluding them costs the measurement nothing. On the ingest path the score is
  // computed once and stored; no branch above the write reads it, so a synthetic batch
  // and a real one do identical work. The render path is the opposite — a high score
  // skips assignment resolution entirely — which is why `bench/render.js` deliberately
  // does *not* carry this token. See §2.3 of `docs/BENCHMARKS.md`.
  'morphbench',
];

export function isBotUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return BOT_TOKENS.some((token) => ua.includes(token));
}

export interface BotSignals {
  readonly userAgent?: string | undefined;
  readonly acceptLanguage?: string | undefined;
  readonly secFetchSite?: string | undefined;
  readonly hasCookies: boolean;
  /** Client-reported viewport. Zero or absent is a strong signal. */
  readonly viewportWidth?: number | undefined;
  /** Events per second observed for this identifier in the current window. */
  readonly eventRate?: number | undefined;
}

/**
 * Score how likely a request is automated, 0–100.
 *
 * A score, not a boolean, because the consequences differ: at 60 and above the session
 * is excluded from posteriors and from the report's traffic numbers, but it is still
 * served normally. Getting this wrong in the conservative direction costs one session of
 * evidence; getting it wrong in the permissive direction lets a crawler move a posterior,
 * which is how an optimiser ends up optimising for Googlebot.
 *
 * The signals are ordered by how much they are worth, and each carries its reasoning.
 */
export function botScore(signals: BotSignals): number {
  let score = 0;

  const ua = signals.userAgent ?? '';

  // Self-declared. The overwhelming majority of automated traffic is honest about it,
  // and there is no reason to spend effort on the rest.
  if (isBotUserAgent(ua)) return 100;

  // No User-Agent at all is not a browser. It is a script that did not bother.
  if (ua.length === 0) score += 70;

  // Every real browser sends Accept-Language. Almost no HTTP client does by default.
  if ((signals.acceptLanguage ?? '').length === 0) score += 25;

  // Fetch metadata is sent by every current browser and by very little else.
  if (signals.secFetchSite === undefined) score += 15;

  // A client that cannot hold a cookie cannot hold a session.
  if (!signals.hasCookies) score += 10;

  // A zero or absurd viewport means the value was fabricated or never measured.
  const width = signals.viewportWidth;
  if (width !== undefined && (width <= 0 || width > 10_000)) score += 20;

  // Humans do not generate twenty events a second. This is the one signal that catches
  // a well-disguised client, because it measures behaviour rather than headers.
  const rate = signals.eventRate ?? 0;
  if (rate > 20) score += 40;
  else if (rate > 8) score += 15;

  return score > 100 ? 100 : score;
}

/** The threshold at which a session stops counting. Matches the ClickHouse views. */
export const BOT_THRESHOLD = 60;
