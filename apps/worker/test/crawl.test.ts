import { describe, expect, it } from 'vitest';
import { DEFAULT_FETCHER_CONFIG, DEFAULT_POLITENESS, PoliteFetcher } from '@morph/crawler';
import { DEDUPE_WINDOW_MS, MAX_ITEMS_PER_FEED, runCrawl } from '../src/jobs/crawl';
import { FakeDocuments, FakeLogger, FakeSources } from './fakes';

/**
 * The crawl job with a real `PoliteFetcher` over a fake network, so the compliance
 * behaviour under test is the behaviour that ships rather than a re-implementation of it.
 */

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

class Net {
  clock = 0;
  private readonly replies = new Map<string, Reply>();
  readonly asked: string[] = [];

  on(url: string, reply: Reply): this {
    this.replies.set(url, reply);
    return this;
  }

  fetcher(): PoliteFetcher {
    return new PoliteFetcher(
      {
        fetch: (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          this.asked.push(url);

          const reply = this.replies.get(url);
          if (reply === undefined) return Promise.resolve(new Response('', { status: 404 }));

          return Promise.resolve(
            new Response(reply.status === 304 ? null : (reply.body ?? ''), {
              status: reply.status ?? 200,
              headers: { 'content-type': 'application/rss+xml', ...reply.headers },
            }),
          );
        },
        now: () => this.clock,
        sleep: (ms) => {
          this.clock += ms;
          return Promise.resolve();
        },
      },
      { ...DEFAULT_FETCHER_CONFIG, politeness: { ...DEFAULT_POLITENESS, defaultCrawlDelayMs: 0 } },
    );
  }
}

const ALLOW_ALL = { body: 'User-agent: *\nDisallow:', headers: { 'content-type': 'text/plain' } };

const feed = (items: readonly { title: string; link: string; description?: string }[]): string =>
  `<rss><channel><title>Example</title>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description ?? 'Body text for this item.'}</description></item>`,
    )
    .join('')}</channel></rss>`;

function harness() {
  const net = new Net();
  const sources = new FakeSources();
  const documents = new FakeDocuments();
  const log = new FakeLogger();

  return {
    net,
    sources,
    documents,
    log,
    deps: () => ({ fetcher: net.fetcher(), sources, documents, now: () => net.clock, log }),
  };
}

describe('storing what it finds', () => {
  it('turns a feed into documents', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.net.on('https://example.com/robots.txt', ALLOW_ALL).on('https://example.com/feed.xml', {
      body: feed([
        { title: 'First story', link: 'https://example.com/a' },
        { title: 'Second story', link: 'https://example.com/b' },
      ]),
    });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.documentsStored).toBe(2);
    expect(h.documents.stored.map((d) => d.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(h.documents.stored[0]?.title).toBe('First story');
  });

  it('extracts an article from an HTML source', async () => {
    const h = harness();
    h.sources.add({ id: 's1', kind: 'html', url: 'https://example.com/post' });

    const prose = Array.from(
      { length: 6 },
      () =>
        '<p>A paragraph about incremental clustering and why stable identifiers matter when a ' +
        'pipeline needs to accumulate a history of attention over time for any given subject.</p>',
    ).join('');

    h.net.on('https://example.com/robots.txt', ALLOW_ALL).on('https://example.com/post', {
      body: `<html lang="en"><head><title>A post</title></head><body><article>${prose}</article></body></html>`,
      headers: { 'content-type': 'text/html' },
    });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.documentsStored).toBe(1);
    expect(h.documents.stored[0]?.lang).toBe('en');
  });

  /**
   * The same article reached through a tracking parameter must not become a second
   * document — it would double-count towards momentum and split its own cluster.
   */
  it('prefers the canonical URL an article names for itself', async () => {
    const h = harness();
    h.sources.add({ id: 's1', kind: 'html', url: 'https://example.com/post?utm_source=x' });

    const prose = Array.from(
      { length: 6 },
      () =>
        '<p>A paragraph long enough to clear the extractor floor, discussing the same subject ' +
        'at sufficient length that the density heuristic has something real to score here.</p>',
    ).join('');

    h.net
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/post?utm_source=x', {
        body: `<html><head><link rel="canonical" href="https://example.com/post"></head><body><article>${prose}</article></body></html>`,
        headers: { 'content-type': 'text/html' },
      });

    await runCrawl(h.deps(), { batchSize: 10 });

    expect(h.documents.stored[0]?.url).toBe('https://example.com/post');
  });

  it('caps how many items one feed can contribute in a run', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });

    const items = Array.from({ length: MAX_ITEMS_PER_FEED + 20 }, (_, i) => ({
      title: `Story number ${String(i)}`,
      link: `https://example.com/${String(i)}`,
    }));

    h.net
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/feed.xml', { body: feed(items) });

    const result = await runCrawl(h.deps(), { batchSize: 10 });
    expect(result.documentsStored).toBe(MAX_ITEMS_PER_FEED);
  });

  it('records nothing when a feed parses to no usable items', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.net
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/feed.xml', { body: '<html>not a feed</html>' });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.documentsStored).toBe(0);
    expect(h.log.events()).toContain('crawl.nothing-usable');
  });
});

describe('deduplication', () => {
  /**
   * The failure the whole stage exists to prevent: forty sources carrying one wire story
   * must contribute one document, or momentum measures distribution lists.
   */
  it('drops a story already stored inside the window', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://a.example/feed.xml' });
    h.sources.add({ id: 's2', url: 'https://b.example/feed.xml' });

    const story = {
      title: 'Regulator publishes guidance',
      link: '',
      description: 'The same wire copy.',
    };

    h.net
      .on('https://a.example/robots.txt', ALLOW_ALL)
      .on('https://b.example/robots.txt', ALLOW_ALL)
      .on('https://a.example/feed.xml', { body: feed([{ ...story, link: 'https://a.example/1' }]) })
      .on('https://b.example/feed.xml', {
        body: feed([{ ...story, link: 'https://b.example/1' }]),
      });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.documentsStored).toBe(1);
    expect(result.duplicatesDropped).toBe(1);
  });

  it('lets a story back in once it is outside the window', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.documents.seed({
      title: 'Old copy',
      simhash: '123',
      fetchedAt: -DEDUPE_WINDOW_MS - 1,
    });

    h.net.on('https://example.com/robots.txt', ALLOW_ALL).on('https://example.com/feed.xml', {
      body: feed([{ title: 'A story', link: 'https://example.com/x' }]),
    });

    const result = await runCrawl(h.deps(), { batchSize: 10 });
    expect(result.documentsStored).toBe(1);
  });
});

describe('honouring the host', () => {
  it('records a disallowed source rather than retrying it', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/private/feed.xml' });
    h.net.on('https://example.com/robots.txt', {
      body: 'User-agent: *\nDisallow: /private',
      headers: { 'content-type': 'text/plain' },
    });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.disallowed).toBe(1);
    expect(result.failed).toBe(0);
    expect(h.sources.robots).toEqual([{ sourceId: 's1', allowed: false }]);
    // Never asked for the feed itself.
    expect(h.net.asked).toEqual(['https://example.com/robots.txt']);
  });

  it('records a host whose robots.txt could not be read as refused, not failed', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.net.on('https://example.com/robots.txt', { status: 503 });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.disallowed).toBe(1);
    expect(h.sources.robots[0]?.allowed).toBe(false);
  });

  /**
   * 429 is an instruction, not a fault. Counting it as a failure would drive the source
   * towards its circuit breaker for doing exactly what it was asked.
   */
  it('treats a slow-down request as deferred rather than failed', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.net
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/feed.xml', { status: 429, headers: { 'retry-after': '600' } });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.deferred).toBe(1);
    expect(result.failed).toBe(0);
    expect(h.sources.fetches.filter((f) => f.failed)).toHaveLength(0);
  });

  it('records a genuine error as a failure', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.net
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/feed.xml', { status: 500 });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.failed).toBe(1);
    expect(h.sources.fetches.at(-1)).toMatchObject({ sourceId: 's1', status: 500, failed: true });
  });
});

describe('conditional requests', () => {
  it('sends the stored validators and records a 304 as unchanged', async () => {
    const h = harness();
    h.sources.add({
      id: 's1',
      url: 'https://example.com/feed.xml',
      etag: '"v1"',
      lastModified: 'Tue, 03 Jun 2025 09:00:00 GMT',
    });
    h.net
      .on('https://example.com/robots.txt', ALLOW_ALL)
      .on('https://example.com/feed.xml', { status: 304 });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.unchanged).toBe(1);
    expect(result.documentsStored).toBe(0);
    // Not a failure: this is the steady state for most sources most of the time.
    expect(h.sources.fetches.at(-1)).toMatchObject({ status: 304, failed: false });
  });

  it('stores the validators returned for next time', async () => {
    const h = harness();
    h.sources.add({ id: 's1', url: 'https://example.com/feed.xml' });
    h.net.on('https://example.com/robots.txt', ALLOW_ALL).on('https://example.com/feed.xml', {
      body: feed([{ title: 'A story', link: 'https://example.com/x' }]),
      headers: { etag: '"v2"', 'last-modified': 'Tue, 03 Jun 2025 09:00:00 GMT' },
    });

    await runCrawl(h.deps(), { batchSize: 10 });

    expect(h.sources.fetches.at(-1)).toMatchObject({
      etag: '"v2"',
      lastModified: 'Tue, 03 Jun 2025 09:00:00 GMT',
    });
  });
});

describe('the batch', () => {
  it('respects the batch size', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1)
      h.sources.add({ id: `s${String(i)}`, url: `https://h${String(i)}.example/f.xml` });

    const result = await runCrawl(h.deps(), { batchSize: 2 });
    expect(result.sourcesAttempted).toBe(2);
  });

  it('does nothing gracefully when no source is due', async () => {
    const h = harness();
    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result).toMatchObject({ sourcesAttempted: 0, documentsStored: 0 });
    expect(h.log.find('crawl.batch')).toMatchObject({ sourcesAttempted: 0 });
  });

  /**
   * One bad source must not cost the other twenty-four in the batch.
   */
  it('continues after a source fails', async () => {
    const h = harness();
    h.sources.add({ id: 'bad', url: 'https://bad.example/f.xml' });
    h.sources.add({ id: 'good', url: 'https://good.example/f.xml' });

    h.net
      .on('https://bad.example/robots.txt', ALLOW_ALL)
      .on('https://bad.example/f.xml', { status: 500 })
      .on('https://good.example/robots.txt', ALLOW_ALL)
      .on('https://good.example/f.xml', {
        body: feed([{ title: 'Fine', link: 'https://good.example/1' }]),
      });

    const result = await runCrawl(h.deps(), { batchSize: 10 });

    expect(result.failed).toBe(1);
    expect(result.documentsStored).toBe(1);
  });
});
