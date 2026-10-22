import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FETCHER_CONFIG,
  PoliteFetcher,
  retryAfterMs,
  type FetchDeps,
  type FetcherConfig,
} from '../src/fetch';
import { DEFAULT_POLITENESS } from '../src/politeness';

/**
 * No network, no clock, no sleeping. Time is advanced by the fake `sleep`, so "waits 1.1
 * seconds then retries" is asserted in microseconds.
 */

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Throw instead of replying, the way a timeout or DNS failure does. */
  readonly fail?: string;
}

class Harness {
  clock = 0;
  readonly requests: Recorded[] = [];
  readonly slept: number[] = [];
  private readonly replies = new Map<string, Reply | readonly Reply[]>();
  private readonly counts = new Map<string, number>();

  on(url: string, reply: Reply | readonly Reply[]): this {
    this.replies.set(url, reply);
    return this;
  }

  deps(): FetchDeps {
    return {
      fetch: (input, init) => {
        // The fetcher only ever passes a string, but the signature allows all three.
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        );
        this.requests.push({ url, headers });

        const configured = this.replies.get(url);
        if (configured === undefined) {
          return Promise.resolve(new Response('not configured', { status: 404 }));
        }

        const seen = this.counts.get(url) ?? 0;
        this.counts.set(url, seen + 1);
        const reply = Array.isArray(configured)
          ? (configured[Math.min(seen, configured.length - 1)] as Reply)
          : (configured as Reply);

        if (reply.fail !== undefined) return Promise.reject(new Error(reply.fail));

        return Promise.resolve(
          new Response(reply.status === 304 ? null : (reply.body ?? ''), {
            status: reply.status ?? 200,
            headers: { 'content-type': 'text/html', ...reply.headers },
          }),
        );
      },
      now: () => this.clock,
      sleep: (ms) => {
        this.slept.push(ms);
        this.clock += ms;
        return Promise.resolve();
      },
    };
  }

  fetcher(overrides: Partial<FetcherConfig> = {}): PoliteFetcher {
    return new PoliteFetcher(this.deps(), { ...DEFAULT_FETCHER_CONFIG, ...overrides });
  }
}

const ALLOW_ALL = { body: 'User-agent: *\nDisallow:' };

describe('robots.txt comes first', () => {
  it('reads robots.txt before the page', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { body: '<p>Hello</p>' });

    const result = await harness.fetcher().fetch('https://example.com/page');

    expect(result.kind).toBe('ok');
    expect(harness.requests[0]?.url).toBe('https://example.com/robots.txt');
    expect(harness.requests[1]?.url).toBe('https://example.com/page');
  });

  it('refuses a disallowed path without requesting it', async () => {
    const harness = new Harness().on('https://example.com/robots.txt', {
      body: 'User-agent: *\nDisallow: /private',
    });

    const result = await harness.fetcher().fetch('https://example.com/private/thing');

    expect(result.kind).toBe('disallowed');
    if (result.kind === 'disallowed') expect(result.rule).toBe('/private');
    // Not merely refused after asking: never asked.
    expect(harness.requests.map((r) => r.url)).toEqual(['https://example.com/robots.txt']);
  });

  /**
   * The decision most crawlers get backwards. A server having a bad day has not consented
   * to anything.
   */
  it('blocks a host whose robots.txt returned a server error', async () => {
    const harness = new Harness().on('https://example.com/robots.txt', { status: 503 });
    const result = await harness.fetcher().fetch('https://example.com/page');

    expect(result.kind).toBe('host-blocked');
  });

  it('blocks a host whose robots.txt could not be reached at all', async () => {
    const harness = new Harness().on('https://example.com/robots.txt', { fail: 'ECONNREFUSED' });
    expect((await harness.fetcher().fetch('https://example.com/page')).kind).toBe('host-blocked');
  });

  it('treats a missing robots.txt as no restrictions', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', { status: 404 })
      .on('https://example.com/page', { body: 'ok' });

    expect((await harness.fetcher().fetch('https://example.com/page')).kind).toBe('ok');
  });

  it('stays out when robots.txt is behind authentication', async () => {
    const harness = new Harness().on('https://example.com/robots.txt', { status: 403 });
    expect((await harness.fetcher().fetch('https://example.com/page')).kind).toBe('host-blocked');
  });

  it('caches robots.txt rather than re-reading it for every page', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/a', { body: 'a' })
      .on('https://example.com/b', { body: 'b' });

    const fetcher = harness.fetcher();
    await fetcher.fetch('https://example.com/a');
    harness.clock += DEFAULT_POLITENESS.defaultCrawlDelayMs;
    await fetcher.fetch('https://example.com/b');

    const robotsRequests = harness.requests.filter((r) => r.url.endsWith('/robots.txt'));
    expect(robotsRequests).toHaveLength(1);
  });

  it('exposes the sitemaps a host declared', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', {
        body: 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml',
      })
      .on('https://example.com/page', { body: 'ok' });

    const fetcher = harness.fetcher();
    await fetcher.fetch('https://example.com/page');

    expect(fetcher.sitemapsFor('example.com')).toEqual(['https://example.com/sitemap.xml']);
  });
});

describe('identifying ourselves', () => {
  it('sends a descriptive User-Agent with a contact URL on every request', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { body: 'ok' });

    await harness.fetcher().fetch('https://example.com/page');

    for (const request of harness.requests) {
      expect(request.headers['user-agent']).toBe(DEFAULT_FETCHER_CONFIG.userAgent);
      expect(request.headers['user-agent']).toMatch(/\+https?:\/\//);
    }
  });
});

describe('conditional requests', () => {
  it('sends the stored validators', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { status: 304 });

    const result = await harness.fetcher().fetch('https://example.com/page', {
      etag: '"abc"',
      lastModified: 'Tue, 03 Jun 2025 09:00:00 GMT',
    });

    const pageRequest = harness.requests.find((r) => r.url.endsWith('/page'));
    expect(pageRequest?.headers['if-none-match']).toBe('"abc"');
    expect(pageRequest?.headers['if-modified-since']).toBe('Tue, 03 Jun 2025 09:00:00 GMT');
    expect(result.kind).toBe('not-modified');
  });

  it('sends no validators when there are none to send', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { body: 'ok' });

    await harness.fetcher().fetch('https://example.com/page');

    const pageRequest = harness.requests.find((r) => r.url.endsWith('/page'));
    expect(pageRequest?.headers['if-none-match']).toBeUndefined();
    expect(pageRequest?.headers['if-modified-since']).toBeUndefined();
  });

  it('returns the validators for next time', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', {
        body: 'ok',
        headers: { etag: '"v2"', 'last-modified': 'Tue, 03 Jun 2025 09:00:00 GMT' },
      });

    const result = await harness.fetcher().fetch('https://example.com/page');

    expect(result.kind === 'ok' && result.etag).toBe('"v2"');
    expect(result.kind === 'ok' && result.lastModified).toBe('Tue, 03 Jun 2025 09:00:00 GMT');
  });
});

describe('politeness in practice', () => {
  it('waits the crawl delay between two pages on the same host', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', { body: 'User-agent: *\nCrawl-delay: 5\nDisallow:' })
      .on('https://example.com/a', { body: 'a' })
      .on('https://example.com/b', { body: 'b' });

    const fetcher = harness.fetcher();
    await fetcher.fetch('https://example.com/a');
    const before = harness.clock;
    await fetcher.fetch('https://example.com/b');

    expect(harness.clock - before).toBeGreaterThanOrEqual(5_000);
  });

  it('gives up rather than holding a job open longer than it will wait', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', { body: 'User-agent: *\nCrawl-delay: 60\nDisallow:' })
      .on('https://example.com/a', { body: 'a' })
      .on('https://example.com/b', { body: 'b' });

    const fetcher = harness.fetcher({ maxWaitMs: 10_000 });
    await fetcher.fetch('https://example.com/a');
    const result = await fetcher.fetch('https://example.com/b');

    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') expect(result.retryAfterMs).toBeGreaterThan(10_000);
  });

  it('defers once a host has failed enough to open its breaker', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { status: 500 });

    const fetcher = harness.fetcher({
      politeness: { ...DEFAULT_POLITENESS, breakerThreshold: 2, defaultCrawlDelayMs: 0 },
    });

    expect((await fetcher.fetch('https://example.com/page')).kind).toBe('error');
    expect((await fetcher.fetch('https://example.com/page')).kind).toBe('error');

    const third = await fetcher.fetch('https://example.com/page');
    expect(third.kind).toBe('deferred');
    if (third.kind === 'deferred') expect(third.reason).toMatch(/circuit breaker/i);
  });

  it('reopens a host after an operator closes its breaker', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', [{ status: 500 }, { status: 500 }, { body: 'recovered' }]);

    const fetcher = harness.fetcher({
      politeness: { ...DEFAULT_POLITENESS, breakerThreshold: 2, defaultCrawlDelayMs: 0 },
    });

    await fetcher.fetch('https://example.com/page');
    await fetcher.fetch('https://example.com/page');
    fetcher.closeBreaker('example.com');

    expect((await fetcher.fetch('https://example.com/page')).kind).toBe('ok');
  });

  it('reports its remaining global headroom', () => {
    const harness = new Harness();
    expect(harness.fetcher().headroom()).toBe(DEFAULT_POLITENESS.globalQps);
  });
});

describe('redirects', () => {
  it('follows a redirect and re-checks robots at the destination', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/old', {
        status: 301,
        headers: { location: 'https://other.example/new' },
      })
      .on('https://other.example/robots.txt', ALLOW_ALL)
      .on('https://other.example/new', { body: 'moved here' });

    const result = await harness.fetcher().fetch('https://example.com/old');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.url).toBe('https://other.example/new');
    expect(harness.requests.map((r) => r.url)).toContain('https://other.example/robots.txt');
  });

  /**
   * A redirect must not become a way to reach a path robots.txt disallows.
   */
  it('refuses a redirect into a disallowed path', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', { body: 'User-agent: *\nDisallow: /private' })
      .on('https://example.com/open', {
        status: 302,
        headers: { location: 'https://example.com/private/thing' },
      });

    const result = await harness.fetcher().fetch('https://example.com/open');
    expect(result.kind).toBe('disallowed');
  });

  it('resolves a relative Location against the current URL', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/a/old', { status: 302, headers: { location: '../b/new' } })
      .on('https://example.com/b/new', { body: 'here' });

    const result = await harness
      .fetcher({ politeness: { ...DEFAULT_POLITENESS, defaultCrawlDelayMs: 0 } })
      .fetch('https://example.com/a/old');

    expect(result.kind === 'ok' && result.url).toBe('https://example.com/b/new');
  });

  it('stops after the redirect limit rather than looping', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/loop', {
        status: 302,
        headers: { location: 'https://example.com/loop' },
      });

    const result = await harness
      .fetcher({ maxRedirects: 2, politeness: { ...DEFAULT_POLITENESS, defaultCrawlDelayMs: 0 } })
      .fetch('https://example.com/loop');

    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/redirects/);
  });

  it('reports a redirect with no Location header as an error', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { status: 302 });

    const result = await harness.fetcher().fetch('https://example.com/page');
    expect(result.kind === 'error' && result.message).toMatch(/Location/);
  });

  it('reports a malformed redirect target rather than following it', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { status: 302, headers: { location: 'http://[bad' } });

    const result = await harness.fetcher().fetch('https://example.com/page');
    expect(result.kind === 'error' && result.message).toMatch(/not a valid URL/i);
  });
});

describe('what it refuses to read', () => {
  it('rejects a URL that is not absolute', async () => {
    const result = await new Harness().fetcher().fetch('/relative/path');
    expect(result.kind === 'error' && result.message).toMatch(/valid absolute URL/);
  });

  it('rejects a scheme it does not speak', async () => {
    const result = await new Harness().fetcher().fetch('ftp://example.com/file');
    expect(result.kind === 'error' && result.message).toMatch(/Unsupported scheme/);
  });

  it('rejects a content type it cannot use', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/file.zip', {
        body: 'PK',
        headers: { 'content-type': 'application/zip' },
      });

    const result = await harness.fetcher().fetch('https://example.com/file.zip');
    expect(result.kind === 'error' && result.message).toMatch(/Unhandled content type/);
  });

  it('accepts a content type with a charset parameter', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', {
        body: 'ok',
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });

    expect((await harness.fetcher().fetch('https://example.com/page')).kind).toBe('ok');
  });

  it('refuses a response larger than the size limit', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/huge', { body: 'x'.repeat(5_000) });

    const result = await harness.fetcher({ maxBytes: 1_000 }).fetch('https://example.com/huge');
    expect(result.kind === 'error' && result.message).toMatch(/exceeds/);
  });

  it('reports an HTTP error status', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/gone', { status: 404 });

    const result = await harness.fetcher().fetch('https://example.com/gone');
    expect(result.kind === 'error' && result.status).toBe(404);
  });

  it('reports a network failure', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { fail: 'socket hang up' });

    const result = await harness.fetcher().fetch('https://example.com/page');
    expect(result.kind === 'error' && result.message).toBe('socket hang up');
  });
});

describe('when a host asks us to slow down', () => {
  const noJitter = { ...DEFAULT_POLITENESS, random: () => 1 };

  /**
   * 429 and 503 are different from a broken host: they are an instruction, and returning
   * on the ordinary crawl delay ignores it.
   */
  for (const status of [429, 503]) {
    it(`defers rather than erroring on ${String(status)}`, async () => {
      const harness = new Harness()
        .on('https://example.com/robots.txt', ALLOW_ALL)
        .on('https://example.com/page', { status });

      const result = await harness
        .fetcher({ politeness: noJitter })
        .fetch('https://example.com/page');

      expect(result.kind).toBe('deferred');
      if (result.kind === 'deferred') {
        expect(result.reason).toMatch(/slow down/);
        expect(result.retryAfterMs).toBeGreaterThan(DEFAULT_POLITENESS.defaultCrawlDelayMs);
      }
    });
  }

  it('honours a Retry-After in seconds', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { status: 429, headers: { 'retry-after': '300' } });

    const result = await harness
      .fetcher({ politeness: noJitter })
      .fetch('https://example.com/page');

    expect(result.kind === 'deferred' && result.retryAfterMs).toBe(300_000);
  });

  it('will not ask again before the host said to', async () => {
    const harness = new Harness()
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/page', { status: 429, headers: { 'retry-after': '300' } });

    const fetcher = harness.fetcher({ politeness: noJitter, maxWaitMs: 1_000 });
    await fetcher.fetch('https://example.com/page');

    const attempts = harness.requests.filter((r) => r.url.endsWith('/page')).length;
    const second = await fetcher.fetch('https://example.com/page');

    expect(second.kind).toBe('deferred');
    expect(harness.requests.filter((r) => r.url.endsWith('/page'))).toHaveLength(attempts);
  });
});

describe('parsing Retry-After', () => {
  it('reads a delay in seconds', () => {
    expect(retryAfterMs('120', 0)).toBe(120_000);
    expect(retryAfterMs('  120  ', 0)).toBe(120_000);
    expect(retryAfterMs('0', 0)).toBe(0);
  });

  /**
   * Both forms appear in the wild, and a crawler that understands only the first ignores
   * exactly the hosts that bothered to be precise.
   */
  it('reads an HTTP date', () => {
    const now = Date.parse('Tue, 03 Jun 2025 09:00:00 GMT');
    expect(retryAfterMs('Tue, 03 Jun 2025 09:05:00 GMT', now)).toBe(300_000);
  });

  it('treats a date in the past as no wait rather than a negative one', () => {
    const now = Date.parse('Tue, 03 Jun 2025 09:00:00 GMT');
    expect(retryAfterMs('Tue, 03 Jun 2025 08:00:00 GMT', now)).toBe(0);
  });

  /**
   * Undefined rather than 0, so the caller falls back to its own backoff instead of
   * retrying immediately — the safe direction when a host has just asked us to wait.
   */
  it('reports a value it cannot read as absent', () => {
    expect(retryAfterMs(null, 0)).toBeUndefined();
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs('', 0)).toBeUndefined();
    expect(retryAfterMs('-5', 0)).toBeUndefined();
  });
});
