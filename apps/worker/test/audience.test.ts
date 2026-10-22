import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG } from '@morph/core';
import { cosineSimilarity } from '@morph/crawler';
import {
  MIN_CONTRIBUTORS,
  MIN_IMPRESSIONS,
  medianOf,
  runAudience,
  slugFromPath,
  weightedCentroid,
} from '../src/jobs/audience';
import { clickhouseEngagement, parseRows } from '../src/adapters/clickhouse';
import { FakeAudience, FakeContent, FakeEngagement, FakeLogger, FakeTrends } from './fakes';
import type { EmbeddingProvider, PageEngagement } from '../src/ports';

const NOW = 1_700_000_000_000;
const JOB = { windowDays: 30 };
const DIMENSIONS = 4;

/** A deterministic embedder: the slug decides the direction, so tests can predict it. */
function embedder(directions: Record<string, readonly number[]>): EmbeddingProvider {
  return {
    name: 'test',
    dimensions: DIMENSIONS,
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const match = Object.entries(directions).find(([key]) => text.includes(key));
          return match?.[1] ?? new Array<number>(DIMENSIONS).fill(0.5);
        }),
      ),
  };
}

function harness(directions: Record<string, readonly number[]> = {}) {
  const engagement = new FakeEngagement();
  const content = new FakeContent();
  const trends = new FakeTrends();
  const audience = new FakeAudience();
  const log = new FakeLogger();

  return {
    engagement,
    content,
    trends,
    audience,
    log,
    deps: {
      engagement,
      content,
      trends,
      audience,
      embeddings: embedder(directions),
      weights: DEFAULT_ENGINE_CONFIG.weights,
      bouncePenalty: DEFAULT_ENGINE_CONFIG.bouncePenalty,
      now: () => NOW,
      log,
    },
  };
}

/** A page that will score well: engaged, scrolled, shared, not bounced. */
const good = (path: string): Partial<PageEngagement> & Pick<PageEngagement, 'path'> => ({
  path,
  impressions: 100,
  signups: 8,
  engagedSessions: 70,
  scrollNormSum: 75,
  returns: 30,
  shares: 12,
  bounces: 4,
});

/** A page that will score badly: arrived, bounced, left. */
const poor = (path: string): Partial<PageEngagement> & Pick<PageEngagement, 'path'> => ({
  path,
  impressions: 100,
  signups: 0,
  engagedSessions: 3,
  scrollNormSum: 6,
  returns: 1,
  shares: 0,
  bounces: 82,
});

/** Six good and six poor pages, all published, all resolvable. */
function populate(h: ReturnType<typeof harness>, count = 6): void {
  for (let i = 0; i < count; i += 1) {
    h.engagement.add(good(`/t/good-${String(i)}`));
    h.engagement.add(poor(`/t/poor-${String(i)}`));
    h.content.publish({ slug: `good-${String(i)}` });
    h.content.publish({ slug: `poor-${String(i)}` });
  }
}

describe('computing the vector', () => {
  it('produces a vector from the pages above the median', async () => {
    const h = harness();
    populate(h);

    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('computed');
    if (result.kind !== 'computed') return;

    expect(result.snapshot.sampleSize).toBe(6);
    expect(result.snapshot.vector).toHaveLength(DIMENSIONS);
    expect(h.audience.saved).toHaveLength(1);
  });

  /**
   * The point of the whole job: the vector must point at what readers engaged with, not
   * at the average of everything published.
   */
  it('points towards the pages readers engaged with', async () => {
    const liked = [1, 0, 0, 0];
    const ignored = [0, 1, 0, 0];

    const h = harness({ good: liked, poor: ignored });
    populate(h);

    const result = await runAudience(h.deps, JOB);
    if (result.kind !== 'computed') throw new Error('expected a vector');

    expect(cosineSimilarity(result.snapshot.vector, liked)).toBeCloseTo(1);
    expect(cosineSimilarity(result.snapshot.vector, ignored)).toBeCloseTo(0);
  });

  it('records what it was computed from, so a decision can be argued with', async () => {
    const h = harness();
    populate(h);

    const result = await runAudience(h.deps, JOB);
    if (result.kind !== 'computed') throw new Error('expected a vector');

    expect(result.snapshot.contributors.every((c) => c.path.startsWith('/t/good-'))).toBe(true);
    expect(result.snapshot.windowDays).toBe(30);
    expect(result.snapshot.computedAt).toBe(NOW);

    // The invariant the split rests on: every contributor scored strictly above the
    // recorded median, so the number in the row explains the set beside it.
    for (const contributor of result.snapshot.contributors) {
      expect(contributor.reward).toBeGreaterThan(result.snapshot.medianReward);
    }
  });

  it('passes the window through to the engagement query', async () => {
    const h = harness();
    populate(h);

    await runAudience(h.deps, { windowDays: 90 });
    expect(h.engagement.windows).toEqual([90]);
  });

  /**
   * The trend signal's centroid is already in the right space and was computed from many
   * documents rather than one summary — using it costs no embedding call and is a better
   * estimate of the topic than the article's own words.
   */
  it('prefers a trend signal centroid to embedding the summary', async () => {
    const fromSignal = [0, 0, 1, 0];
    const h = harness({ good: [1, 0, 0, 0] });
    populate(h);

    h.trends.seedCluster({
      id: 'signal-1',
      centroid: fromSignal,
      memberIds: [],
      label: 'A topic',
      firstSeenAt: NOW - 1000,
    });
    for (const item of h.content.live) {
      if (item.slug.startsWith('good-')) {
        h.content.live[h.content.live.indexOf(item)] = { ...item, trendSignalId: 'signal-1' };
      }
    }

    const result = await runAudience(h.deps, JOB);
    if (result.kind !== 'computed') throw new Error('expected a vector');

    expect(cosineSimilarity(result.snapshot.vector, fromSignal)).toBeCloseTo(1);
  });

  it('falls back to embedding a page with no trend signal', async () => {
    const h = harness({ good: [1, 0, 0, 0] });
    populate(h);

    const result = await runAudience(h.deps, JOB);
    if (result.kind !== 'computed') throw new Error('expected a vector');

    expect(cosineSimilarity(result.snapshot.vector, [1, 0, 0, 0])).toBeCloseTo(1);
  });

  it('ignores a centroid of the wrong width rather than storing a mixed-space vector', async () => {
    const h = harness({ good: [1, 0, 0, 0] });
    populate(h);

    h.trends.seedCluster({
      id: 'signal-1',
      centroid: [1, 2, 3],
      memberIds: [],
      label: 'Wrong width',
      firstSeenAt: NOW,
    });
    for (const item of [...h.content.live]) {
      if (item.slug.startsWith('good-')) {
        h.content.live[h.content.live.indexOf(item)] = { ...item, trendSignalId: 'signal-1' };
      }
    }

    const result = await runAudience(h.deps, JOB);
    if (result.kind !== 'computed') throw new Error('expected a vector');

    // Fell through to the embedder, which gives the good pages their own direction.
    expect(result.snapshot.vector).toHaveLength(DIMENSIONS);
    expect(cosineSimilarity(result.snapshot.vector, [1, 0, 0, 0])).toBeCloseTo(1);
  });
});

describe('what it refuses to produce', () => {
  /**
   * A vector built from one or two pages is those pages, not an audience — and the trend
   * scorer would then reward topics resembling them and nothing else.
   */
  it('produces nothing when too few pages have any traffic', async () => {
    const h = harness();
    h.engagement.add(good('/t/only-one'));
    h.content.publish({ slug: 'only-one' });

    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('insufficient');
    if (result.kind === 'insufficient') expect(result.reason).toMatch(/impressions/);
    expect(h.audience.saved).toEqual([]);
  });

  /**
   * A page with three views and one share has a 33% share rate and means nothing.
   */
  it('ignores pages below the impressions floor', async () => {
    const h = harness();
    for (let i = 0; i < 12; i += 1) {
      h.engagement.add({ ...good(`/t/thin-${String(i)}`), impressions: MIN_IMPRESSIONS - 1 });
      h.content.publish({ slug: `thin-${String(i)}` });
    }

    const result = await runAudience(h.deps, JOB);
    expect(result.kind).toBe('insufficient');
  });

  /**
   * A site whose pages all perform identically has no preference to measure. Not an
   * error, and not a reason to invent one.
   */
  it('produces nothing when every page scores the same', async () => {
    const h = harness();
    for (let i = 0; i < 12; i += 1) {
      h.engagement.add(good(`/t/same-${String(i)}`));
      h.content.publish({ slug: `same-${String(i)}` });
    }

    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('insufficient');
    if (result.kind === 'insufficient') expect(result.reason).toMatch(/above the median/);
  });

  it('produces nothing when the above-median pages cannot be resolved to content', async () => {
    const h = harness();
    populate(h);
    // Every content row removed: engagement exists for paths the site no longer serves.
    h.content.live.length = 0;

    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('insufficient');
    if (result.kind === 'insufficient') expect(result.reason).toMatch(/resolved to a vector/);
    expect(h.log.events('warn')).toContain('audience.unresolved-pages');
  });

  /**
   * Before a site has traffic this is the expected state, and an hourly warning for an
   * expected state is how an operator learns to ignore warnings.
   */
  it('reports insufficiency at info, not as a warning', async () => {
    const h = harness();
    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('insufficient');
    expect(h.log.events('info')).toContain('audience.insufficient');
    expect(h.log.events('warn')).not.toContain('audience.insufficient');
  });

  /**
   * A NaN stored as the audience vector would make every cosine against it NaN, and no
   * topic would ever score — silently, because NaN comparisons simply return false.
   */
  it('drops a page whose embedding came back unusable', async () => {
    const h = harness({ good: [Number.NaN, 0, 0, 0] });
    populate(h);

    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('insufficient');
    if (result.kind === 'insufficient') expect(result.reason).toMatch(/resolved to a vector/);
    expect(h.log.events('warn')).toContain('audience.unresolved-pages');
  });

  /**
   * Vanishingly unlikely, and still not worth a fabricated answer: a zero vector has no
   * direction, so every cosine against it is 0 and every topic looks equally irrelevant.
   */
  it('produces nothing when the contributing vectors cancel out', async () => {
    // Three directions 120° apart. The pages are otherwise identical, so their rewards —
    // and therefore their weights — are equal and the weighted sum is exactly zero.
    const h = harness({
      'good-0': [1, 0, 0, 0],
      'good-1': [-0.5, Math.sqrt(3) / 2, 0, 0],
      'good-2': [-0.5, -Math.sqrt(3) / 2, 0, 0],
    });

    for (let i = 0; i < 3; i += 1) {
      h.engagement.add(good(`/t/good-${String(i)}`));
      h.content.publish({ slug: `good-${String(i)}` });
    }
    for (let i = 0; i < 5; i += 1) h.engagement.add(poor(`/t/poor-${String(i)}`));

    const result = await runAudience(h.deps, JOB);

    expect(result.kind).toBe('insufficient');
    if (result.kind === 'insufficient') expect(result.reason).toMatch(/summed to zero/);
    expect(h.audience.saved).toEqual([]);
  });

  it('needs at least the documented number of contributors', () => {
    expect(MIN_CONTRIBUTORS).toBeGreaterThanOrEqual(3);
  });
});

describe('the centroid', () => {
  it('is unit length, because everything downstream compares by cosine', () => {
    const centroid = weightedCentroid([
      { reward: 0.8, vector: [3, 0, 0, 0] },
      { reward: 0.4, vector: [0, 5, 0, 0] },
    ]);

    const norm = Math.sqrt((centroid ?? []).reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  /**
   * The median decides *which* pages count; the reward decides *how much*. An unweighted
   * mean treats the best page on the site and the one just above the median as equally
   * representative.
   */
  it('leans towards the higher-scoring page', () => {
    const centroid = weightedCentroid([
      { reward: 0.9, vector: [1, 0, 0, 0] },
      { reward: 0.1, vector: [0, 1, 0, 0] },
    ]);

    expect((centroid ?? [])[0]).toBeGreaterThan((centroid ?? [])[1] ?? 0);
  });

  /**
   * A reward of exactly zero would contribute nothing at all, silently dropping a page
   * the median had selected.
   */
  it('still includes a page that scored zero', () => {
    const centroid = weightedCentroid([{ reward: 0, vector: [1, 0, 0, 0] }]);
    expect(centroid).toEqual([1, 0, 0, 0]);
  });

  it('returns nothing for an empty set or vectors that cancel out', () => {
    expect(weightedCentroid([])).toBeNull();
    expect(
      weightedCentroid([
        { reward: 0.5, vector: [1, 0] },
        { reward: 0.5, vector: [-1, 0] },
      ]),
    ).toBeNull();
  });
});

describe('the median', () => {
  /**
   * The split has to be a value a page actually scored, so "above the median" selects at
   * least one page whenever any variation exists.
   */
  it('takes the lower middle value on an even-length set', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2);
    expect(medianOf([4, 3, 2, 1])).toBe(2);
  });

  it('takes the middle of an odd-length set', () => {
    expect(medianOf([5, 1, 3])).toBe(3);
  });

  it('is 0 for nothing', () => {
    expect(medianOf([])).toBe(0);
  });
});

describe('paths and slugs', () => {
  it('reads the slug out of a content path', () => {
    expect(slugFromPath('/t/how-this-site-rebuilds-itself')).toBe('how-this-site-rebuilds-itself');
    expect(slugFromPath('/t/trailing/')).toBe('trailing');
  });

  it('leaves a path that is not content alone, so it fails to resolve rather than matching', () => {
    expect(slugFromPath('/privacy')).toBe('/privacy');
  });
});

describe('reading ClickHouse', () => {
  /**
   * JSONEachRow is one object per line, not an array, and a UInt64 arrives as a string
   * because it does not fit a double.
   */
  it('parses one object per line and coerces the wide integers', () => {
    const body = [
      '{"page_path":"/t/a","impressions":"120","signups":"3","engaged_sessions":"80","scroll_norm_sum":91.5,"returns":"20","shares":"4","bounces":"9"}',
      '{"page_path":"/t/b","impressions":"40","signups":"0","engaged_sessions":"5","scroll_norm_sum":8,"returns":"1","shares":"0","bounces":"30"}',
      '',
    ].join('\n');

    expect(parseRows(body)).toEqual([
      {
        path: '/t/a',
        impressions: 120,
        signups: 3,
        engagedSessions: 80,
        scrollNormSum: 91.5,
        returns: 20,
        shares: 4,
        bounces: 9,
      },
      {
        path: '/t/b',
        impressions: 40,
        signups: 0,
        engagedSessions: 5,
        scrollNormSum: 8,
        returns: 1,
        shares: 0,
        bounces: 30,
      },
    ]);
  });

  it('handles an empty result', () => {
    expect(parseRows('')).toEqual([]);
    expect(parseRows('\n\n')).toEqual([]);
  });

  it('refuses a row that does not match the contract', () => {
    expect(() => parseRows('{"page_path":"/t/a"}')).toThrow();
  });
});

describe('the ClickHouse request', () => {
  const config = {
    url: 'http://clickhouse.internal:8123',
    database: 'morph',
    username: 'morph',
    password: 'secret',
  };

  interface Call {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }

  function stub(calls: Call[], reply: () => Response): typeof globalThis.fetch {
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(reply());
    };
  }

  const row =
    '{"page_path":"/t/a","impressions":"120","signups":"3","engaged_sessions":"80","scroll_norm_sum":91.5,"returns":"20","shares":"4","bounces":"9"}';

  it('sends the window as a query parameter rather than interpolating it', async () => {
    const calls: Call[] = [];
    const repo = clickhouseEngagement({ ...config, fetch: stub(calls, () => new Response(row)) });

    await repo.byPage(45);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('param_window')).toBe('45');
    expect(url.searchParams.get('database')).toBe('morph');
    // The value is never spliced into the SQL text.
    expect(calls[0]?.body).toContain('{window:UInt16}');
    expect(calls[0]?.body).not.toContain('45');
  });

  it('authenticates with the ClickHouse headers', async () => {
    const calls: Call[] = [];
    const repo = clickhouseEngagement({ ...config, fetch: stub(calls, () => new Response(row)) });

    await repo.byPage(30);

    expect(calls[0]?.headers['x-clickhouse-user']).toBe('morph');
    expect(calls[0]?.headers['x-clickhouse-key']).toBe('secret');
  });

  it('reads FINAL, because ReplacingMergeTree rows may not be merged yet', async () => {
    const calls: Call[] = [];
    const repo = clickhouseEngagement({ ...config, fetch: stub(calls, () => new Response(row)) });

    await repo.byPage(30);
    expect(calls[0]?.body).toContain('content_engagement_daily FINAL');
  });

  it('returns the parsed rows', async () => {
    const repo = clickhouseEngagement({ ...config, fetch: stub([], () => new Response(row)) });
    const pages = await repo.byPage(30);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.path).toBe('/t/a');
  });

  /**
   * ClickHouse puts a genuinely useful message in the body — a missing table, a type
   * mismatch, a memory limit — and a bare status sends whoever is on call to the wrong
   * place.
   */
  it('includes the response body in the error', async () => {
    const repo = clickhouseEngagement({
      ...config,
      fetch: stub(
        [],
        () => new Response('Table morph.content_engagement_daily does not exist', { status: 404 }),
      ),
    });

    await expect(repo.byPage(30)).rejects.toThrow(/HTTP 404.*does not exist/s);
  });
});
