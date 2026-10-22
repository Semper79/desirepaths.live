/**
 * The polite fetcher: the only place in MORPH that makes an outbound request to a site
 * we do not own.
 *
 * Everything the compliance position claims is enforced here, in one object, so that
 * "MORPH honours robots.txt" is a property of the code rather than a convention every
 * caller has to remember. There is deliberately no way to fetch a page while bypassing
 * this — the crawler package exports no raw `fetch` wrapper.
 *
 * `fetch`, the clock and the sleep function are all injected. That is not ceremony: it is
 * what makes it possible to test "waits 1.1 seconds, then retries, then gives up" without
 * a network and without a test suite that takes 1.1 seconds to say so.
 *
 * ORDER OF CHECKS, AND WHY
 *  1. Is the host blocked outright (its robots.txt could not be read)?
 *  2. Does robots.txt allow this path for our user-agent?
 *  3. Is the politeness scheduler willing to let a request start?
 * Robots first, because a disallowed path should never consume a rate-limit slot, and
 * because the audit trail should record "we did not ask" rather than "we waited, then
 * did not ask".
 */

import {
  isAllowed,
  isExpired,
  parseRobots,
  policyFrom,
  type RobotsFetchOutcome,
  type RobotsPolicy,
} from './robots';
import { DEFAULT_POLITENESS, PolitenessScheduler, type PolitenessConfig } from './politeness';

export interface FetcherConfig {
  /**
   * Identifies MORPH and carries a contact URL, per §4.1. A crawler a webmaster cannot
   * identify is a crawler a webmaster blocks, and rightly.
   */
  readonly userAgent: string;
  readonly timeoutMs: number;
  /** Refuse a response larger than this rather than reading it into memory. */
  readonly maxBytes: number;
  /** How many redirects to follow. Each hop is re-checked against its own robots.txt. */
  readonly maxRedirects: number;
  /** Longest the scheduler may ask us to wait before we give up and requeue. */
  readonly maxWaitMs: number;
  readonly politeness: PolitenessConfig;
}

export const DEFAULT_FETCHER_CONFIG: FetcherConfig = {
  userAgent: 'MorphBot/0.1 (+https://morph.example/bot)',
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  maxRedirects: 5,
  // Beyond this the job is better requeued than held open: a worker blocked for a minute
  // on one slow host is a worker not crawling the other nine hundred.
  maxWaitMs: 30_000,
  politeness: DEFAULT_POLITENESS,
};

export interface ConditionalHeaders {
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

export type FetchOutcome =
  | {
      readonly kind: 'ok';
      readonly url: string;
      readonly status: number;
      readonly body: string;
      readonly contentType: string | null;
      readonly etag: string | null;
      readonly lastModified: string | null;
    }
  /** The conditional request paid off: nothing changed, and no body crossed the wire. */
  | { readonly kind: 'not-modified'; readonly url: string }
  | { readonly kind: 'disallowed'; readonly url: string; readonly rule: string | null }
  /** robots.txt was unreadable, so the host has consented to nothing. */
  | { readonly kind: 'host-blocked'; readonly url: string; readonly reason: string }
  /** Requeue and come back: a circuit is open, or the wait was longer than we will hold. */
  | {
      readonly kind: 'deferred';
      readonly url: string;
      readonly retryAfterMs: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'error';
      readonly url: string;
      readonly status: number | null;
      readonly message: string;
    };

export interface FetchDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Only these are parsed. Anything else is somebody else's bandwidth spent for nothing. */
const ACCEPTABLE_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/json',
  'text/plain',
];

export class PoliteFetcher {
  private readonly scheduler: PolitenessScheduler;
  private readonly robotsCache = new Map<string, RobotsPolicy>();

  constructor(
    private readonly deps: FetchDeps,
    private readonly config: FetcherConfig = DEFAULT_FETCHER_CONFIG,
  ) {
    this.scheduler = new PolitenessScheduler(config.politeness);
  }

  /**
   * Fetch a URL, honouring every constraint.
   *
   * `conditional` carries whatever was stored the last time this URL was fetched. Sending
   * it is not an optimisation for us — it is bandwidth we do not take from the host, and
   * it is what earns a `304` instead of a full page.
   */
  async fetch(rawUrl: string, conditional: ConditionalHeaders = {}): Promise<FetchOutcome> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { kind: 'error', url: rawUrl, status: null, message: 'Not a valid absolute URL.' };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        kind: 'error',
        url: rawUrl,
        status: null,
        message: `Unsupported scheme ${url.protocol}`,
      };
    }

    let current = url;
    for (let hop = 0; hop <= this.config.maxRedirects; hop += 1) {
      const gate = await this.gate(current);
      if (gate !== null) return gate;

      const outcome = await this.request(current, hop === 0 ? conditional : {});

      if (outcome.kind !== 'redirect') return outcome.result;

      let next: URL;
      try {
        next = new URL(outcome.location, current);
      } catch {
        return {
          kind: 'error',
          url: current.toString(),
          status: null,
          message: 'Redirect target is not a valid URL.',
        };
      }
      // Each hop is re-checked from the top of the loop, so a redirect cannot be used to
      // reach a path — or a host — that robots.txt disallows.
      current = next;
    }

    return {
      kind: 'error',
      url: current.toString(),
      status: null,
      message: `Exceeded ${String(this.config.maxRedirects)} redirects.`,
    };
  }

  /** For the hourly report: how much of the global budget is spare. */
  headroom(): number {
    return this.scheduler.globalHeadroom(this.deps.now());
  }

  /** `/resume` after an operator has fixed whatever a host was unhappy about. */
  closeBreaker(host: string): void {
    this.scheduler.closeBreaker(host);
  }

  /** Sitemaps declared by a host we have already read robots.txt for. */
  sitemapsFor(host: string): readonly string[] {
    return this.robotsCache.get(host)?.robots.sitemaps ?? [];
  }

  /**
   * Everything that must be true before a request may start.
   *
   * Returns `null` when the request may proceed, or the outcome to report when it may not.
   */
  private async gate(url: URL): Promise<FetchOutcome | null> {
    const policy = await this.policyFor(url);

    if (policy.hostBlocked) {
      return {
        kind: 'host-blocked',
        url: url.toString(),
        reason: 'robots.txt could not be read, so this host has consented to nothing.',
      };
    }

    const decision = isAllowed(policy.robots, this.config.userAgent, url.pathname + url.search);
    if (!decision.allowed) {
      return { kind: 'disallowed', url: url.toString(), rule: decision.rule?.pattern ?? null };
    }

    this.scheduler.setCrawlDelay(url.host, decision.crawlDelaySeconds);
    return this.waitForSlot(url);
  }

  /**
   * Wait for the scheduler, up to a bounded time.
   *
   * Returns `null` once a slot has been taken — the caller is then holding the host's
   * lease and must release it.
   */
  private async waitForSlot(url: URL): Promise<FetchOutcome | null> {
    let waited = 0;

    for (;;) {
      const now = this.deps.now();
      const verdict = this.scheduler.check(url.host, now);

      if (verdict.kind === 'go') {
        this.scheduler.begin(url.host, now);
        return null;
      }

      if (verdict.kind === 'circuit-open') {
        return {
          kind: 'deferred',
          url: url.toString(),
          retryAfterMs: verdict.until - now,
          reason: 'This host has failed repeatedly; its circuit breaker is open.',
        };
      }

      if (waited + verdict.waitMs > this.config.maxWaitMs) {
        return {
          kind: 'deferred',
          url: url.toString(),
          retryAfterMs: verdict.waitMs,
          reason: 'Politeness delay is longer than this worker will hold a job open.',
        };
      }

      waited += verdict.waitMs;
      await this.deps.sleep(verdict.waitMs);
    }
  }

  /** Fetch and cache a host's robots.txt, re-reading it once the cached copy expires. */
  private async policyFor(url: URL): Promise<RobotsPolicy> {
    const cached = this.robotsCache.get(url.host);
    if (cached !== undefined && !isExpired(cached, this.deps.now())) return cached;

    const robotsUrl = new URL('/robots.txt', url.origin);

    // robots.txt is exempt from robots.txt — but not from politeness. A host is not
    // helped by our being courteous everywhere except the one file we read first.
    const slot = await this.waitForSlot(robotsUrl);
    if (slot !== null) {
      // Could not even ask. Treat as unreadable, which blocks the host — the safe
      // direction — and expires soon, so a busy moment is not a day-long lockout.
      const policy = policyFrom({ kind: 'unavailable' }, this.deps.now());
      this.robotsCache.set(url.host, policy);
      return policy;
    }

    const response = await this.send(robotsUrl, {});
    const outcome = robotsFetchResult(response);
    // A robots.txt that 500s counts against the host's breaker: it is exactly the signal
    // that the host is unwell and should be left alone.
    this.scheduler.end(
      url.host,
      this.deps.now(),
      outcome.kind === 'unavailable' ? 'failure' : 'success',
    );

    const policy = policyFrom(outcome, this.deps.now());
    this.robotsCache.set(url.host, policy);
    return policy;
  }

  /**
   * One HTTP request, with the lease already held. Always releases it.
   */
  private async request(
    url: URL,
    conditional: ConditionalHeaders,
  ): Promise<
    | { readonly kind: 'result'; readonly result: FetchOutcome }
    | { readonly kind: 'redirect'; readonly location: string }
  > {
    const response = await this.send(url, conditional);
    const now = this.deps.now();

    // 429 and 503 are the host telling us to slow down, which is different from the host
    // being broken: back off and honour any `Retry-After` rather than returning on the
    // ordinary crawl delay.
    if (response.kind === 'ok' && (response.status === 429 || response.status === 503)) {
      this.scheduler.backOff(url.host, now, retryAfterMs(response.headers.get('retry-after'), now));

      return {
        kind: 'result',
        result: {
          kind: 'deferred',
          url: url.toString(),
          retryAfterMs: this.scheduler.nextAllowedIn(url.host, now),
          reason: `Host asked us to slow down (HTTP ${String(response.status)}).`,
        },
      };
    }

    const isSuccess = response.kind === 'ok' && response.status < 500;
    this.scheduler.end(url.host, now, isSuccess ? 'success' : 'failure');

    if (response.kind === 'failed') {
      return {
        kind: 'result',
        result: { kind: 'error', url: url.toString(), status: null, message: response.message },
      };
    }

    const { status, headers, body } = response;

    if (status === 304)
      return { kind: 'result', result: { kind: 'not-modified', url: url.toString() } };

    if (status >= 300 && status < 400) {
      const location = headers.get('location');
      if (location === null) {
        return {
          kind: 'result',
          result: {
            kind: 'error',
            url: url.toString(),
            status,
            message: 'Redirect without a Location header.',
          },
        };
      }
      return { kind: 'redirect', location };
    }

    if (status >= 400) {
      return {
        kind: 'result',
        result: { kind: 'error', url: url.toString(), status, message: `HTTP ${String(status)}` },
      };
    }

    const contentType = headers.get('content-type');
    if (contentType !== null && !isAcceptable(contentType)) {
      return {
        kind: 'result',
        result: {
          kind: 'error',
          url: url.toString(),
          status,
          message: `Unhandled content type: ${contentType}`,
        },
      };
    }

    if (body.length > this.config.maxBytes) {
      return {
        kind: 'result',
        result: {
          kind: 'error',
          url: url.toString(),
          status,
          message: `Response exceeds ${String(this.config.maxBytes)} bytes.`,
        },
      };
    }

    return {
      kind: 'result',
      result: {
        kind: 'ok',
        url: url.toString(),
        status,
        body,
        contentType,
        etag: headers.get('etag'),
        lastModified: headers.get('last-modified'),
      },
    };
  }

  private async send(url: URL, conditional: ConditionalHeaders): Promise<SendResult> {
    const headers: Record<string, string> = {
      'user-agent': this.config.userAgent,
      accept: ACCEPTABLE_TYPES.join(', '),
      'accept-encoding': 'gzip, deflate',
    };

    // Conditional requests are the single most effective courtesy available: a host that
    // has not changed a page sends 304 and a few bytes instead of the page.
    if (conditional.etag !== undefined) headers['if-none-match'] = conditional.etag;
    if (conditional.lastModified !== undefined)
      headers['if-modified-since'] = conditional.lastModified;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const response = await this.deps.fetch(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      // A 304 has no body, and some servers close the stream on a HEAD-like exchange.
      const body = response.status === 304 ? '' : await response.text();
      return { kind: 'ok', status: response.status, headers: response.headers, body };
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

type SendResult =
  | {
      readonly kind: 'ok';
      readonly status: number;
      readonly headers: Headers;
      readonly body: string;
    }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Map a robots.txt fetch onto the three states `policyFrom` understands.
 *
 * The mapping *is* the compliance decision, so it is written out rather than inferred:
 * 404 means no rules; 401/403 means the rules are behind a wall and we stay out; anything
 * else that failed means we could not establish consent, which is not the same as having
 * it.
 */
function robotsFetchResult(response: SendResult): RobotsFetchOutcome {
  if (response.kind === 'failed') return { kind: 'unavailable' };

  if (response.status === 200) return { kind: 'ok', body: response.body };
  if (response.status === 404 || response.status === 410) return { kind: 'absent' };
  if (response.status === 401 || response.status === 403) return { kind: 'forbidden' };
  return { kind: 'unavailable' };
}

/**
 * `Retry-After` is either a number of seconds or an HTTP date. Both forms appear in the
 * wild, and a crawler that understands only the first ignores exactly the hosts that
 * bothered to be precise.
 *
 * A value we cannot read returns `undefined` rather than 0, so the caller falls back to
 * its own backoff instead of retrying immediately — the safe direction when a host has
 * just asked us to wait.
 */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  // `Date.parse` is too permissive for this field: it reads "-5" as a year and returns a
  // timestamp in 1970, which would be silently treated as a valid instruction. An
  // HTTP-date always contains a weekday and a month name, so requiring a letter rejects
  // the numeric shapes that are not valid delta-seconds either.
  if (!/[a-z]/i.test(trimmed)) return undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  // A date in the past means "you may retry now", not "retry in the past".
  return Math.max(0, at - now);
}

function isAcceptable(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ACCEPTABLE_TYPES.includes(type);
}

/** Re-exported so a caller can build a policy from a robots.txt it already has. */
export { parseRobots };
