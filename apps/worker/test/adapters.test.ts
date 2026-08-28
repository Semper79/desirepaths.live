import { describe, expect, it } from 'vitest';
import { createLogger, formatLine } from '../src/adapters/logger.js';
import { httpEmbeddings } from '../src/adapters/http-embeddings.js';

const AT = new Date('2026-06-03T09:00:00.000Z');

describe('the logger', () => {
  it('writes one JSON object per line', () => {
    const lines: string[] = [];
    const log = createLogger({ now: () => AT, write: (line) => lines.push(line) });

    log.info('crawl.batch', { stored: 12 });

    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: '2026-06-03T09:00:00.000Z',
      level: 'info',
      event: 'crawl.batch',
      service: 'worker',
      fields: { stored: 12 },
    });
  });

  it('records the level', () => {
    const lines: string[] = [];
    const log = createLogger({ now: () => AT, write: (line) => lines.push(line) });

    log.warn('crawl.refused', {});
    log.error('generate.invented-citation', {});

    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual(['warn', 'error']);
  });

  it('defaults the fields, so an event with nothing to say still logs', () => {
    const lines: string[] = [];
    createLogger({ now: () => AT, write: (line) => lines.push(line) }).info('prune.batch');

    expect(JSON.parse(lines[0] as string)).toMatchObject({ fields: {} });
  });

  it('writes to stdout and stamps the real clock by default', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };

    try {
      createLogger().info('worker.started', { queues: 5 });
    } finally {
      process.stdout.write = original;
    }

    const line = JSON.parse((written[0] ?? '').trim()) as { ts: string; service: string };
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(line.service).toBe('worker');
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
  });

  it('takes a service name, so two processes are distinguishable in one log stream', () => {
    const lines: string[] = [];
    createLogger({ service: 'worker-crawl', now: () => AT, write: (l) => lines.push(l) }).info('x');

    expect(JSON.parse(lines[0] as string)).toMatchObject({ service: 'worker-crawl' });
  });

  /**
   * An error object carrying a request is the usual source of a circular reference, and
   * the job that was only trying to report progress must not die of it.
   */
  it('survives a field it cannot serialise', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const line = JSON.parse(formatLine('error', 'x.y', circular, AT, 'worker')) as {
      fields: { unserialisable: string[] };
    };

    expect(line.fields.unserialisable).toEqual(['name', 'self']);
  });
});

describe('HTTP embeddings', () => {
  const config = {
    provider: 'voyage' as const,
    model: 'voyage-3-lite',
    dimensions: 3,
    apiKey: 'test-key',
  };

  interface Call {
    readonly url: string;
    readonly headers: Record<string, string>;
  }

  /** A typed fetch stub, so no test needs a cast to satisfy the signature. */
  function stub(calls: Call[], reply: () => Response): typeof globalThis.fetch {
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
      return Promise.resolve(reply());
    };
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const vectors = { data: [{ index: 0, embedding: [1, 2, 3] }] };

  it('returns the vectors in order', async () => {
    const provider = httpEmbeddings({
      ...config,
      fetch: stub([], () =>
        json({
          data: [
            { index: 1, embedding: [4, 5, 6] },
            { index: 0, embedding: [1, 2, 3] },
          ],
        }),
      ),
    });

    expect(await provider.embed(['a', 'b'])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('names itself by provider and model, which the embed job logs', () => {
    expect(httpEmbeddings(config).name).toBe('voyage:voyage-3-lite');
  });

  it('sends nothing for an empty batch', async () => {
    const calls: Call[] = [];
    const provider = httpEmbeddings({ ...config, fetch: stub(calls, () => json(vectors)) });

    expect(await provider.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  /**
   * The useful part of an embedding failure — a too-long input, a rate limit, an unknown
   * model — is in the body. A bare status code sends whoever is on call to the wrong place.
   */
  it('includes the response body in the error', async () => {
    const provider = httpEmbeddings({
      ...config,
      fetch: stub([], () => json({ error: 'input exceeds the maximum length' }, 400)),
    });

    await expect(provider.embed(['x'])).rejects.toThrow(/HTTP 400.*maximum length/s);
  });

  /**
   * A provider returning `{"embedding": null}` on a partial failure would otherwise reach
   * pgvector as a null and fail three stages later, with the error message long gone.
   */
  it('refuses a response that does not match the contract', async () => {
    const provider = httpEmbeddings({
      ...config,
      fetch: stub([], () => json({ data: [{ index: 0, embedding: null }] })),
    });

    await expect(provider.embed(['x'])).rejects.toThrow();
  });

  it('calls the configured base URL for an OpenAI-compatible service', async () => {
    const calls: Call[] = [];
    const provider = httpEmbeddings({
      ...config,
      provider: 'openai-compatible',
      baseUrl: 'https://embeddings.internal/v1/',
      fetch: stub(calls, () => json(vectors)),
    });

    await provider.embed(['x']);
    expect(calls[0]?.url).toBe('https://embeddings.internal/v1/embeddings');
  });

  it('sends the key as a bearer token', async () => {
    const calls: Call[] = [];
    const provider = httpEmbeddings({ ...config, fetch: stub(calls, () => json(vectors)) });

    await provider.embed(['x']);
    expect(calls[0]?.headers['authorization']).toBe('Bearer test-key');
  });
});
