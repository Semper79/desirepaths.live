import { describe, expect, it } from 'vitest';
import { PUBLISH_THRESHOLD } from '@morph/crawler';
import { publisherFrom, runGenerate } from '../src/jobs/generate';
import { FakeContent, FakeDocuments, FakeGenerator, FakeLogger, FakeTrends } from './fakes';
import type { GeneratedContent, GenerationBrief, TrendSignalRecord } from '../src/ports';

const NOW = 1_700_000_000_000;

/** Comfortably above the publish threshold on every component. */
const STRONG = { momentum: 0.9, audienceFit: 0.9, saturation: 0.9, durability: 0.9 };

function harness(respond: (brief: GenerationBrief) => Partial<GeneratedContent> = () => ({})) {
  const trends = new FakeTrends();
  const documents = new FakeDocuments();
  const content = new FakeContent();
  const generator = new FakeGenerator(respond);
  const log = new FakeLogger();

  const signal = (id: string, overrides: Partial<TrendSignalRecord> = {}): void => {
    trends.seedCluster(
      { id, centroid: [1, 0], memberIds: [], label: `Topic ${id}`, firstSeenAt: NOW - 100_000 },
      { ...STRONG, ...overrides },
    );
  };

  const document = (clusterId: string, title: string, url: string): void => {
    documents.seed({ title, url, clusterId, fetchedAt: NOW });
  };

  return {
    trends,
    documents,
    content,
    generator,
    log,
    signal,
    document,
    deps: { trends, documents, content, generator, now: () => NOW, log },
  };
}

describe('the happy path', () => {
  it('produces a draft with its sources', async () => {
    const h = harness();
    h.signal('t1');
    h.document('t1', 'A source article', 'https://publisher.example/one');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(1);
    expect(h.content.drafts).toHaveLength(1);
    expect(h.content.drafts[0]?.sources).toHaveLength(1);
    expect(h.content.drafts[0]?.sources[0]?.publisher).toBe('publisher.example');
  });

  /**
   * §7.3 and `content_generated_needs_review`. The database enforces this too; the job
   * enforcing it as well is what stops a future caller passing a different status.
   */
  it('never produces anything but a draft, and always records the model', async () => {
    const h = harness();
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');

    await runGenerate(h.deps, { maxDrafts: 2 });

    expect(h.content.drafts[0]?.generatedBy).toBe('fake-model');
    expect(h.content.drafts[0]?.generationPrompt).toBe('fake-prompt');
    expect(h.content.drafts[0]?.trendSignalId).toBe('t1');
  });

  it('marks the signal as acted on, so it is not written about twice', async () => {
    const h = harness();
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');

    await runGenerate(h.deps, { maxDrafts: 2 });
    expect(h.trends.signals.get('t1')?.actedOnAt).toBe(NOW);

    // A second run finds nothing left to do.
    const second = await runGenerate(h.deps, { maxDrafts: 2 });
    expect(second.drafted).toBe(0);
  });

  it('passes the scorer rationale into the brief', async () => {
    const h = harness();
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');

    await runGenerate(h.deps, { maxDrafts: 2 });

    expect(h.generator.briefs[0]?.rationale).toMatch(/composite score of 0\.9/);
    expect(h.generator.briefs[0]?.label).toBe('Topic t1');
  });

  it('stops at maxDrafts', async () => {
    const h = harness();
    for (const id of ['t1', 't2', 't3']) {
      h.signal(id);
      h.document(id, `Source for ${id}`, `https://publisher.example/${id}`);
    }

    const result = await runGenerate(h.deps, { maxDrafts: 2 });
    expect(result.drafted).toBe(2);
  });
});

describe('what it refuses to write about', () => {
  it('skips a topic the classifier did not clear', async () => {
    const h = harness();
    h.signal('t1', { safetyVerdict: 'review' });
    h.document('t1', 'A source', 'https://publisher.example/one');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/safety verdict is review/);
  });

  it('skips a topic that scores below the publish threshold', async () => {
    const h = harness();
    h.signal('t1', { momentum: 0.1, audienceFit: 0.1, saturation: 0.1, durability: 0.1 });
    h.document('t1', 'A source', 'https://publisher.example/one');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/below the publish threshold/);
    expect(PUBLISH_THRESHOLD).toBeGreaterThan(0.1);
  });

  /**
   * Attribution is mandatory, so a cluster nothing can be attributed to is not publishable
   * however well it scores.
   */
  it('skips a topic with no attributable source', async () => {
    const h = harness();
    h.signal('t1');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('no attributable sources');
  });

  it('skips a topic already acted on', async () => {
    const h = harness();
    h.signal('t1', { actedOnAt: NOW - 1000 });
    h.document('t1', 'A source', 'https://publisher.example/one');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });
    expect(result.drafted).toBe(0);
  });
});

describe('what it refuses to accept from the generator', () => {
  /**
   * The failure that matters most and is least visible downstream: a draft citing a URL
   * nobody supplied looks perfectly well-sourced. An attribution system that passes those
   * on launders a fabrication into a reference.
   */
  it('discards a citation it never offered, and says so loudly', async () => {
    const h = harness(() => ({ citedUrls: ['https://invented.example/story'] }));
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/cited none of the sources/);
    expect(h.log.events('error')).toContain('generate.invented-citation');
  });

  it('keeps the real citations and drops the invented one', async () => {
    const h = harness((brief) => ({
      citedUrls: [brief.sources[0]?.url ?? '', 'https://invented.example/story'],
    }));
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');
    h.document('t1', 'Another source', 'https://publisher.example/two');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(1);
    expect(h.content.drafts[0]?.sources).toHaveLength(1);
    expect(h.log.events('error')).toContain('generate.invented-citation');
  });

  it('rejects a draft with no usable title or summary', async () => {
    const empty = harness(() => ({ title: '   ' }));
    empty.signal('t1');
    empty.document('t1', 'A source', 'https://publisher.example/one');
    expect((await runGenerate(empty.deps, { maxDrafts: 2 })).rejected[0]?.reason).toMatch(
      /no usable title or summary/,
    );

    const thin = harness(() => ({ summary: 'Too short.' }));
    thin.signal('t1');
    thin.document('t1', 'A source', 'https://publisher.example/one');
    expect((await runGenerate(thin.deps, { maxDrafts: 2 })).rejected[0]?.reason).toMatch(
      /no usable title or summary/,
    );
  });

  /**
   * A topic can be safe while a specific article about it is not.
   */
  it('re-checks the generated text and rejects it on its own merits', async () => {
    const h = harness(() => ({
      title: 'What the indictment means',
      summary:
        'The indictment was unsealed this week, and the defendant is expected to enter a plea at the hearing that follows.',
    }));
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');

    const result = await runGenerate(h.deps, { maxDrafts: 2 });

    expect(result.drafted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/generated text was block/);
  });
});

describe('slugs', () => {
  it('derives a slug from the title', async () => {
    const h = harness(() => ({ title: 'How This Site Rebuilds Itself' }));
    h.signal('t1');
    h.document('t1', 'A source', 'https://publisher.example/one');

    await runGenerate(h.deps, { maxDrafts: 2 });
    expect(h.content.drafts[0]?.slug).toBe('how-this-site-rebuilds-itself');
  });

  it('suffixes rather than colliding when two titles slugify the same', async () => {
    const h = harness(() => ({ title: 'The same title' }));
    h.signal('t1');
    h.signal('t2');
    h.document('t1', 'A source', 'https://publisher.example/one');
    h.document('t2', 'Another source', 'https://publisher.example/two');

    await runGenerate(h.deps, { maxDrafts: 2 });

    expect(h.content.drafts.map((d) => d.slug)).toEqual(['the-same-title', 'the-same-title-2']);
  });
});

describe('publisher names', () => {
  it('uses the host, without the www', () => {
    expect(publisherFrom('https://www.example.com/a/b')).toBe('example.com');
    expect(publisherFrom('https://news.example.co.uk/x')).toBe('news.example.co.uk');
  });

  it('says so rather than guessing when the URL is unusable', () => {
    expect(publisherFrom('not a url')).toBe('unknown');
  });
});
