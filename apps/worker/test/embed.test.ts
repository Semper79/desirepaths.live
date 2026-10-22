import { describe, expect, it } from 'vitest';
import { EMBED_TEXT_LIMIT, embeddingText, runEmbed } from '../src/jobs/embed';
import {
  deterministicEmbeddings,
  hashingVector,
} from '../src/adapters/deterministic-embeddings';
import { FakeDocuments, FakeLogger } from './fakes';
import type { EmbeddingProvider, StoredDocument } from '../src/ports';

const DIMENSIONS = 8;

function provider(embed: EmbeddingProvider['embed'], dimensions = DIMENSIONS): EmbeddingProvider {
  return { name: 'test-provider', dimensions, embed };
}

function harness(embeddings: EmbeddingProvider) {
  const documents = new FakeDocuments();
  const log = new FakeLogger();
  return { documents, log, deps: { documents, embeddings, now: () => 0, log } };
}

const vector = (fill: number, size = DIMENSIONS): number[] => new Array<number>(size).fill(fill);

describe('the happy path', () => {
  it('embeds every pending document', async () => {
    const h = harness(provider((texts) => Promise.resolve(texts.map(() => vector(0.5)))));
    h.documents.seed({ title: 'First' });
    h.documents.seed({ title: 'Second' });

    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(result).toMatchObject({ attempted: 2, embedded: 2, skipped: 0 });
    expect(h.documents.stored.every((d) => d.embedding !== null)).toBe(true);
  });

  it('does nothing when there is nothing pending', async () => {
    const h = harness(provider(() => Promise.reject(new Error('should not be called'))));
    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(result).toEqual({ attempted: 0, embedded: 0, skipped: 0 });
  });

  it('leaves documents that already have an embedding alone', async () => {
    const h = harness(provider((texts) => Promise.resolve(texts.map(() => vector(0.5)))));
    h.documents.seed({ title: 'Done', embedding: vector(0.1) });
    h.documents.seed({ title: 'Pending' });

    const result = await runEmbed(h.deps, { batchSize: 10 });
    expect(result.attempted).toBe(1);
  });

  it('honours the batch size', async () => {
    const h = harness(provider((texts) => Promise.resolve(texts.map(() => vector(0.5)))));
    for (let i = 0; i < 5; i += 1) h.documents.seed({ title: `Doc ${String(i)}` });

    const result = await runEmbed(h.deps, { batchSize: 2 });
    expect(result.attempted).toBe(2);
  });
});

describe('what it sends', () => {
  it('combines the title and the excerpt', () => {
    const document = { title: 'A title', excerpt: 'Some body text.' } as StoredDocument;
    expect(embeddingText(document)).toBe('A title\n\nSome body text.');
  });

  it('caps the length, because an embedding of ten thousand words means nothing', () => {
    const document = { title: 'T', excerpt: 'x'.repeat(5_000) } as StoredDocument;
    expect(embeddingText(document).length).toBe(EMBED_TEXT_LIMIT);
  });

  /**
   * An empty string is a wasted request and some providers reject it outright, taking the
   * rest of the batch with them.
   */
  it('never sends a document with nothing to embed', async () => {
    const sent: string[][] = [];
    const h = harness(
      provider((texts) => {
        sent.push([...texts]);
        return Promise.resolve(texts.map(() => vector(0.5)));
      }),
    );
    h.documents.seed({ title: '', excerpt: '' });
    h.documents.seed({ title: 'Real', excerpt: 'Text' });

    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(sent[0]).toHaveLength(1);
    expect(result).toMatchObject({ attempted: 2, embedded: 1, skipped: 1 });
    expect(h.log.events('warn')).toContain('embed.empty-text');
  });

  it('reports a batch that is entirely empty without calling the provider', async () => {
    const h = harness(provider(() => Promise.reject(new Error('should not be called'))));
    h.documents.seed({ title: '', excerpt: '' });

    const result = await runEmbed(h.deps, { batchSize: 10 });
    expect(result).toMatchObject({ attempted: 1, embedded: 0, skipped: 1 });
  });
});

describe('refusing bad vectors', () => {
  /**
   * Positional correspondence is the whole contract. Writing a short list in order would
   * attach the wrong meaning to every document after the gap, silently.
   */
  it('throws when the provider returns the wrong number of vectors', async () => {
    const h = harness(provider(() => Promise.resolve([vector(0.5)])));
    h.documents.seed({ title: 'One' });
    h.documents.seed({ title: 'Two' });

    await expect(runEmbed(h.deps, { batchSize: 10 })).rejects.toThrow(/returned 1 vectors for 2/);
  });

  /**
   * The column is `vector(768)`. Without this check the error surfaces inside pgvector,
   * naming neither the document nor the provider, with the batch half-written.
   */
  it('skips a vector of the wrong width rather than storing it', async () => {
    const h = harness(provider((texts) => Promise.resolve(texts.map(() => vector(0.5, 3)))));
    h.documents.seed({ title: 'Wrong width' });

    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(result).toMatchObject({ embedded: 0, skipped: 1 });
    expect(h.documents.stored[0]?.embedding).toBeNull();
    expect(h.log.find('embed.wrong-width')).toMatchObject({ expected: DIMENSIONS, received: 3 });
  });

  /**
   * A NaN stored in pgvector makes every cosine distance involving that row NaN — not an
   * error anywhere, just a document that never matches and never explains why.
   */
  it('skips a vector containing a non-finite number', async () => {
    const h = harness(
      provider((texts) =>
        Promise.resolve(texts.map(() => [Number.NaN, ...vector(0.5, DIMENSIONS - 1)])),
      ),
    );
    h.documents.seed({ title: 'Poisoned' });

    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(result).toMatchObject({ embedded: 0, skipped: 1 });
    expect(h.log.events('warn')).toContain('embed.non-finite');
  });

  /**
   * One bad row must not cost the rest of the batch, or a queue containing one bad row
   * never drains.
   */
  it('embeds the good documents alongside a bad one', async () => {
    let call = 0;
    const h = harness(
      provider((texts) =>
        Promise.resolve(
          texts.map(() => {
            call += 1;
            return call === 1 ? vector(0.5, 2) : vector(0.5);
          }),
        ),
      ),
    );
    h.documents.seed({ title: 'Bad' });
    h.documents.seed({ title: 'Good' });

    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(result).toMatchObject({ embedded: 1, skipped: 1 });
  });
});

describe('the deterministic development provider', () => {
  it('produces a vector of the requested width', () => {
    expect(hashingVector('some text here', 768)).toHaveLength(768);
  });

  it('is stable for stable input', () => {
    expect(hashingVector('the same text', 64)).toEqual(hashingVector('the same text', 64));
  });

  it('is unit length, so cosine behaves like a similarity', () => {
    const norm = Math.sqrt(
      hashingVector('a longer piece of text to hash', 64).reduce((s, v) => s + v * v, 0),
    );
    expect(norm).toBeCloseTo(1);
  });

  it('returns a zero vector for text with nothing in it', () => {
    expect(hashingVector('', 4)).toEqual([0, 0, 0, 0]);
  });

  it('puts unrelated texts far apart and identical texts together', () => {
    const a = hashingVector('regulator publishes guidance on automated decisions', 256);
    const b = hashingVector('regulator publishes guidance on automated decisions', 256);
    const c = hashingVector('football club confirms signing of a midfielder', 256);

    const dot = (x: readonly number[], y: readonly number[]): number =>
      x.reduce((sum, value, i) => sum + value * (y[i] ?? 0), 0);

    expect(dot(a, b)).toBeCloseTo(1);
    expect(Math.abs(dot(a, c))).toBeLessThan(0.5);
  });

  /**
   * The name is load-bearing: it appears in every log line the embed job writes, so an
   * operator reading them can see at a glance that the vectors mean nothing.
   */
  it('names itself as development-only', () => {
    expect(deterministicEmbeddings(768).name).toMatch(/development only/i);
  });

  it('satisfies the provider contract end to end', async () => {
    const embeddings = deterministicEmbeddings(768);
    const h = harness(embeddings);
    h.documents.seed({ title: 'A story', excerpt: 'With some text.' });

    const result = await runEmbed(h.deps, { batchSize: 10 });

    expect(result.embedded).toBe(1);
    expect(h.documents.stored[0]?.embedding).toHaveLength(768);
  });
});
