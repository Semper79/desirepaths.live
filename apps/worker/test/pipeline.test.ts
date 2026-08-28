import { describe, expect, it } from 'vitest';
import { runPrune } from '../src/jobs/prune.js';
import { labelFor, MAX_LABEL_LENGTH, slugify, tokenise } from '../src/lib/label.js';
import { parseJob, POLICY, QUEUE } from '../src/queues.js';
import { EnvSchema, loadEnv, refineEnv, type Env } from '../src/env.js';
import { FakeDocuments, FakeLogger } from './fakes.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('pruning', () => {
  function harness() {
    const documents = new FakeDocuments();
    const log = new FakeLogger();
    return { documents, log, deps: { documents, now: () => NOW, log } };
  }

  it('deletes documents past the retention window and keeps the rest', async () => {
    const h = harness();
    h.documents.seed({ title: 'Old', fetchedAt: NOW - 40 * DAY });
    h.documents.seed({ title: 'Recent', fetchedAt: NOW - 5 * DAY });

    const result = await runPrune(h.deps, { retentionDays: 30 });

    expect(result.deleted).toBe(1);
    expect(h.documents.stored.map((d) => d.title)).toEqual(['Recent']);
  });

  it('computes the cutoff from the retention it was given', async () => {
    const h = harness();
    const result = await runPrune(h.deps, { retentionDays: 7 });
    expect(result.cutoff).toBe(NOW - 7 * DAY);
  });

  /**
   * "The retention job has silently done nothing for six weeks" looks exactly like "there
   * was nothing to remove" unless it says so every time.
   */
  it('reports even when it removed nothing', async () => {
    const h = harness();
    const result = await runPrune(h.deps, { retentionDays: 30 });

    expect(result.deleted).toBe(0);
    expect(h.log.find('prune.batch')).toMatchObject({ deleted: 0, retentionDays: 30 });
  });
});

describe('labelling a cluster', () => {
  it('drops stopwords and short tokens', () => {
    expect(tokenise('The regulator has published a new set of rules')).toEqual([
      'regulator',
      'published',
      'set',
      'rules',
    ]);
  });

  it('names a cluster from the terms its titles share', () => {
    const label = labelFor([
      'Regulator publishes guidance on automated decisions',
      'New regulator guidance lands in January',
      'What the regulator guidance means for operators',
    ]);

    expect(label.toLowerCase()).toContain('regulator');
    expect(label.toLowerCase()).toContain('guidance');
  });

  /**
   * Ranking by raw count would let one verbose headline repeating a word six times
   * outvote six headlines that each mention it once — naming the loudest article rather
   * than the topic.
   */
  it('ranks by how many titles contain a term, not by how often it appears', () => {
    const label = labelFor(
      [
        'Widget widget widget widget widget widget',
        'Regulator publishes guidance',
        'Regulator guidance explained',
      ],
      1,
    );

    expect(label.toLowerCase()).toBe('regulator');
  });

  it('is deterministic', () => {
    const titles = ['Alpha beta gamma', 'Beta gamma delta', 'Gamma delta epsilon'];
    expect(labelFor(titles)).toBe(labelFor(titles));
  });

  it('respects the column width', () => {
    const long = Array.from({ length: 40 }, (_, i) => `verylongterm${String(i)} shared`);
    expect(labelFor(long, 40).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
  });

  /**
   * A row with an empty label is a row nobody can talk about in the report.
   */
  it('always produces something', () => {
    expect(labelFor([])).toBe('Unlabelled topic');
    expect(labelFor(['the a of and'])).toBe('Unlabelled topic');
    expect(labelFor(['...', '???'])).toBe('Unlabelled topic');
  });

  it('capitalises the result', () => {
    expect(labelFor(['regulator guidance'])).toMatch(/^[A-Z]/);
  });
});

describe('slugs', () => {
  it('lowercases, strips punctuation and joins with hyphens', () => {
    expect(slugify('How This Site Rebuilds Itself!')).toBe('how-this-site-rebuilds-itself');
  });

  it('strips diacritics rather than dropping the letters', () => {
    expect(slugify('Cosa significa la révision européenne')).toBe(
      'cosa-significa-la-revision-europeenne',
    );
  });

  it('never ends in a hyphen, including after truncation', () => {
    expect(slugify('a'.repeat(99) + ' word')).not.toMatch(/-$/);
    expect(slugify('trailing punctuation --- ')).toBe('trailing-punctuation');
  });

  it('is deterministic, so a re-run collides instead of publishing twice', () => {
    expect(slugify('The same title')).toBe(slugify('The same title'));
  });

  it('always produces something usable', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('???')).toBe('untitled');
  });
});

describe('job payloads', () => {
  it('applies defaults for an empty or missing payload', () => {
    expect(parseJob(QUEUE.crawl, undefined)).toEqual({ batchSize: 25 });
    expect(parseJob(QUEUE.crawl, {})).toEqual({ batchSize: 25 });
  });

  it('accepts a payload within range', () => {
    expect(parseJob(QUEUE.cluster, { batchSize: 10, windowHours: 12 })).toEqual({
      batchSize: 10,
      windowHours: 12,
    });
  });

  /**
   * A queue is a process boundary: this JSON was written by a different deploy. Silently
   * running with a batch size of 25 when the operator asked for 200 is worse than failing.
   */
  it('refuses a payload outside the permitted range', () => {
    expect(() => parseJob(QUEUE.crawl, { batchSize: 5_000 })).toThrow(/Malformed morph.crawl/);
    expect(() => parseJob(QUEUE.embed, { batchSize: 'lots' })).toThrow(/Malformed morph.embed/);
  });

  it('caps how many drafts one generate run may produce', () => {
    expect(parseJob(QUEUE.generate, {})).toEqual({ maxDrafts: 2 });
    expect(() => parseJob(QUEUE.generate, { maxDrafts: 50 })).toThrow();
  });

  it('gives every queue a schedule and a retry policy', () => {
    for (const queue of Object.values(QUEUE)) {
      const policy = POLICY[queue];
      expect(policy.cron.split(' ')).toHaveLength(5);
      expect(policy.attempts).toBeGreaterThan(0);
      expect(policy.concurrency).toBeGreaterThan(0);
    }
  });

  /**
   * `PolitenessScheduler` keeps its per-host leases in process memory. Raising this
   * without moving the lease to Redis is how "one concurrent request per host" quietly
   * stops being true.
   */
  it('pins the crawl queue to one worker', () => {
    expect(POLICY[QUEUE.crawl].concurrency).toBe(1);
  });
});

describe('the environment', () => {
  const base: Record<string, string> = {
    DATABASE_URL: 'postgres://morph@localhost:5432/morph',
    REDIS_URL: 'redis://localhost:6379',
    CRAWLER_USER_AGENT: 'MorphBot/0.1 (+https://example.com/bot)',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  };

  const env = (overrides: Record<string, string> = {}): Env =>
    EnvSchema.parse({ ...base, ...overrides });

  /** The base environment with one variable removed. */
  const without = (name: string): Record<string, string> =>
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== name));

  it('accepts a complete development environment', () => {
    expect(loadEnv(base).EMBEDDING_PROVIDER).toBe('deterministic');
  });

  it('rejects a User-Agent with no contact URL', () => {
    expect(() => loadEnv({ ...base, CRAWLER_USER_AGENT: 'MorphBot' })).toThrow(/contact URL/);
  });

  it('names the variable when something is missing', () => {
    expect(() => loadEnv(without('DATABASE_URL'))).toThrow(/DATABASE_URL/);
  });

  /**
   * A production deployment using the hashing stand-in would cluster documents by hash
   * collision and score topics from noise, and nothing would appear broken.
   */
  it('refuses the deterministic embedder in production', () => {
    const problems = refineEnv(env({ NODE_ENV: 'production' }));
    expect(problems.map((p) => p.variable)).toContain('EMBEDDING_PROVIDER');
  });

  it('allows it outside production', () => {
    expect(refineEnv(env({ NODE_ENV: 'development' }))).toEqual([]);
  });

  it('requires a key once a real provider is named', () => {
    const problems = refineEnv(env({ EMBEDDING_PROVIDER: 'voyage' }));
    expect(problems.map((p) => p.variable)).toContain('EMBEDDING_API_KEY');
  });

  it('requires a base URL for an OpenAI-compatible provider', () => {
    const problems = refineEnv(
      env({ EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_API_KEY: 'k' }),
    );
    expect(problems.map((p) => p.variable)).toContain('EMBEDDING_BASE_URL');
  });

  /**
   * The generate queue is scheduled, so a missing key is not a dormant problem — it is a
   * job failing twice a day forever with the only symptom in a log.
   */
  it('requires the generation key, because the queue is scheduled', () => {
    expect(() => loadEnv(without('ANTHROPIC_API_KEY'))).toThrow(/ANTHROPIC_API_KEY/);
  });

  /**
   * D15: the classifier cannot detect content naming a private individual, and that gap
   * is carried by human review.
   */
  it('refuses full autonomy while the safety gap is carried by review', () => {
    const problems = refineEnv(env({ SOCIAL_AUTONOMY: 'auto' }));
    expect(problems.map((p) => p.variable)).toContain('SOCIAL_AUTONOMY');
  });

  it('reports every problem at once rather than one per restart', () => {
    const problems = refineEnv(
      env({ NODE_ENV: 'production', EMBEDDING_PROVIDER: 'voyage', SOCIAL_AUTONOMY: 'auto' }),
    );
    expect(problems.length).toBeGreaterThan(1);
  });
});

describe('the bot environment', () => {
  const base: Record<string, string> = {
    DATABASE_URL: 'postgres://morph@localhost:5432/morph',
    REDIS_URL: 'redis://localhost:6379',
    CRAWLER_USER_AGENT: 'MorphBot/0.1 (+https://example.com/bot)',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  };

  const env = (overrides: Record<string, string> = {}): Env =>
    EnvSchema.parse({ ...base, ...overrides });

  /**
   * A worker whose job is the crawl does not need a bot, so no configuration at all is a
   * supported state rather than a degraded one.
   */
  it('accepts a worker with no bot configured', () => {
    expect(refineEnv(env())).toEqual([]);
  });

  /**
   * A token with no chat id is a bot that starts, polls, and can never answer.
   */
  it('refuses half a bot', () => {
    expect(refineEnv(env({ TELEGRAM_BOT_TOKEN: 't' })).map((p) => p.variable)).toContain(
      'TELEGRAM_CHAT_ID',
    );
    expect(refineEnv(env({ TELEGRAM_CHAT_ID: '-100' })).map((p) => p.variable)).toContain(
      'TELEGRAM_BOT_TOKEN',
    );
  });

  /**
   * Approving is limited to named users. With none, the queue is visible and nothing in it
   * can ever be published — which reads as a broken bot rather than a configuration gap.
   */
  it('refuses a bot nobody can approve anything with', () => {
    const problems = refineEnv(env({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100' }));
    expect(problems.map((p) => p.variable)).toContain('TELEGRAM_ADMIN_USER_IDS');
  });

  it('accepts a fully configured bot', () => {
    const problems = refineEnv(
      env({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100', TELEGRAM_ADMIN_USER_IDS: '55501' }),
    );
    expect(problems).toEqual([]);
  });
});
