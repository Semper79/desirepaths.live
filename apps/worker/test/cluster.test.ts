import { describe, expect, it } from 'vitest';
import { MOMENTUM_WINDOW_HOURS, runCluster } from '../src/jobs/cluster';
import { FakeDocuments, FakeLogger, FakeTrends } from './fakes';
import type { ClusterJob } from '../src/queues';

const NOW = 1_700_000_000_000;
const JOB: ClusterJob = { batchSize: 100, windowHours: 72 };

/** A unit vector at `angle`, so cluster membership is controlled rather than guessed. */
const at = (angle: number): readonly number[] => [Math.cos(angle), Math.sin(angle)];

function harness(audienceVector: readonly number[] | null = null) {
  const documents = new FakeDocuments();
  const trends = new FakeTrends();
  const log = new FakeLogger();

  return {
    documents,
    trends,
    log,
    /** Seeds are fetched "now" unless a test is deliberately testing the window. */
    seed: (document: Parameters<typeof documents.seed>[0]) =>
      documents.seed({ fetchedAt: NOW, ...document }),
    deps: { documents, trends, audienceVector, now: () => NOW, log },
  };
}

describe('assigning documents', () => {
  it('creates a cluster for a document that matches nothing', async () => {
    const h = harness();
    h.seed({ title: 'A new subject entirely', embedding: at(0) });

    const result = await runCluster(h.deps, JOB);

    expect(result).toMatchObject({ documentsAssigned: 1, clustersCreated: 1, clustersUpdated: 0 });
    expect(h.trends.signals.size).toBe(1);
    expect(h.documents.stored[0]?.clusterId).toBe('cluster-1');
  });

  it('adds a close document to the cluster that already exists', async () => {
    const h = harness();
    h.trends.seedCluster({
      id: 'existing',
      centroid: at(0),
      memberIds: ['old-1'],
      label: 'Established topic',
      firstSeenAt: NOW - 100_000,
    });
    h.seed({ title: 'More on the same thing', embedding: at(0.05) });

    const result = await runCluster(h.deps, JOB);

    expect(result).toMatchObject({ clustersCreated: 0, clustersUpdated: 1 });
    expect(h.documents.stored[0]?.clusterId).toBe('existing');
  });

  /**
   * Cluster identity across runs is the reason this stage is incremental at all (D14):
   * a label that changes every hour is a topic the operator has to re-learn every hour.
   */
  it('keeps the original label when a cluster gains members', async () => {
    const h = harness();
    h.trends.seedCluster({
      id: 'existing',
      centroid: at(0),
      memberIds: ['old-1'],
      label: 'The original name',
      firstSeenAt: NOW - 100_000,
    });
    h.seed({ title: 'Completely different words in this headline', embedding: at(0.05) });

    await runCluster(h.deps, JOB);

    expect(h.trends.signals.get('existing')?.label).toBe('The original name');
  });

  it('names a new cluster from the titles that formed it', async () => {
    const h = harness();
    h.seed({ title: 'Regulator publishes guidance', embedding: at(0) });
    h.seed({ title: 'Regulator guidance takes effect', embedding: at(0.02) });

    await runCluster(h.deps, JOB);

    const label = [...h.trends.signals.values()][0]?.label ?? '';
    expect(label.toLowerCase()).toContain('regulator');
    expect(label.toLowerCase()).toContain('guidance');
  });

  it('does nothing when there is nothing unclustered', async () => {
    const h = harness();
    const result = await runCluster(h.deps, JOB);

    expect(result).toMatchObject({ documentsAssigned: 0, clustersCreated: 0 });
    expect(h.log.events()).not.toContain('cluster.batch');
  });

  it('ignores documents older than the window', async () => {
    const h = harness();
    h.seed({ title: 'Ancient', embedding: at(0), fetchedAt: NOW - 100 * 3_600_000 });

    const result = await runCluster(h.deps, { ...JOB, windowHours: 24 });
    expect(result.documentsAssigned).toBe(0);
  });
});

describe('scoring', () => {
  it('records every component the report reads', async () => {
    const h = harness();
    h.seed({ title: 'A topic', embedding: at(0) });
    h.documents.counts.set('cluster-1', new Array<number>(MOMENTUM_WINDOW_HOURS).fill(20));
    h.documents.sourceCounts.set('cluster-1', 3);

    await runCluster(h.deps, JOB);
    const signal = h.trends.signals.get('cluster-1');

    expect(signal?.momentum).toBeGreaterThan(0);
    expect(signal?.saturation).toBeGreaterThan(0.8);
    expect(signal?.documentCount).toBe(1);
    expect(signal?.lastSeenAt).toBe(NOW);
  });

  it('uses the audience vector when there is one', async () => {
    const aligned = harness(at(0));
    aligned.seed({ title: 'On target', embedding: at(0) });
    await runCluster(aligned.deps, JOB);

    const away = harness(at(Math.PI));
    away.seed({ title: 'Off target', embedding: at(0) });
    await runCluster(away.deps, JOB);

    expect(aligned.trends.signals.get('cluster-1')?.audienceFit).toBeCloseTo(1);
    expect(away.trends.signals.get('cluster-1')?.audienceFit).toBe(0);
  });

  /**
   * Before there is engagement data there is no audience vector, and a fabricated number
   * would be worse than none: 0 suppresses everything, 1 promotes everything, and neither
   * announces itself.
   */
  it('stores a neutral prior and says so when audience fit is unknown', async () => {
    const h = harness(null);
    h.seed({ title: 'A topic', embedding: at(0) });

    await runCluster(h.deps, JOB);

    expect(h.trends.signals.get('cluster-1')?.audienceFit).toBe(0.5);
    expect(h.log.find('cluster.batch')).toMatchObject({ audienceFitKnown: false });
  });

  it('renormalises the remaining weights when audience fit is dropped', async () => {
    // With the component dropped, a topic that is strong on the other three must still be
    // able to reach a high total — not be capped at 70% of one by the missing weight.
    const h = harness(null);
    h.seed({ title: 'A topic', embedding: at(0), publishedAt: NOW - 500 * 3_600_000 });
    h.documents.counts.set('cluster-1', new Array<number>(MOMENTUM_WINDOW_HOURS).fill(60));
    h.documents.sourceCounts.set('cluster-1', 1);

    await runCluster(h.deps, JOB);
    const signal = h.trends.signals.get('cluster-1');

    expect(signal?.momentum).toBeGreaterThan(0.7);
    expect(signal?.durability).toBeGreaterThan(0.8);
  });

  /**
   * A topic's age is when it started being discussed, not when this crawler noticed.
   */
  it('dates a cluster from the earliest publication it contains', async () => {
    const h = harness();
    const published = NOW - 10 * 3_600_000;
    h.seed({ title: 'A topic', embedding: at(0), publishedAt: published, fetchedAt: NOW });

    await runCluster(h.deps, JOB);
    expect(h.trends.signals.get('cluster-1')?.firstSeenAt).toBe(published);
  });

  it('keeps the original first-seen date when a cluster grows', async () => {
    const h = harness();
    const original = NOW - 200 * 3_600_000;
    h.trends.seedCluster(
      {
        id: 'existing',
        centroid: at(0),
        memberIds: ['old'],
        label: 'Topic',
        firstSeenAt: original,
      },
      { firstSeenAt: original },
    );
    h.seed({ title: 'New arrival', embedding: at(0.05), publishedAt: NOW });

    await runCluster(h.deps, JOB);
    expect(h.trends.signals.get('existing')?.firstSeenAt).toBe(original);
  });
});

describe('safety', () => {
  it('blocks a cluster whose coverage is about an ongoing trial', async () => {
    const h = harness();
    h.seed({
      title: 'The lawsuit continues',
      excerpt: 'The defendant denied the allegations at trial.',
      embedding: at(0),
    });

    const result = await runCluster(h.deps, JOB);
    const signal = h.trends.signals.get('cluster-1');

    expect(result.blocked).toBe(1);
    expect(signal?.safetyVerdict).toBe('block');
    expect(signal?.safetyReason).toMatch(/Blocked from automated publication/);
    expect(signal?.safetyCategories).toContain('legal');
  });

  it('holds unverified breaking news for review', async () => {
    const h = harness();
    h.seed({
      title: 'A development',
      excerpt: 'Breaking: sources say a deal is close, though it remains unconfirmed.',
      embedding: at(0),
    });

    const result = await runCluster(h.deps, JOB);

    expect(result.heldForReview).toBe(1);
    expect(h.trends.signals.get('cluster-1')?.safetyVerdict).toBe('review');
  });

  it('allows an ordinary technical topic', async () => {
    const h = harness();
    h.seed({
      title: 'Incremental clustering keeps identifiers stable',
      excerpt: 'A library adds a mode that preserves cluster identity across runs.',
      embedding: at(0),
    });

    await runCluster(h.deps, JOB);
    const signal = h.trends.signals.get('cluster-1');

    expect(signal?.safetyVerdict).toBe('allow');
    expect(signal?.safetyReason).toBeNull();
  });

  /**
   * The decision most worth finding here rather than in a post-mortem: a topic that was
   * blocked does not become publishable because this hour's three articles were bland.
   * The subject did not change, the sample did.
   */
  it('never lets a stored verdict improve on its own', async () => {
    const h = harness();
    h.trends.seedCluster(
      {
        id: 'existing',
        centroid: at(0),
        memberIds: ['old'],
        label: 'Topic',
        firstSeenAt: NOW - 1000,
      },
      {
        safetyVerdict: 'block',
        safetyReason: 'Blocked earlier for a reason that still holds.',
        safetyCategories: ['legal'],
      },
    );
    h.seed({
      title: 'A perfectly bland headline',
      excerpt: 'Nothing notable.',
      embedding: at(0.05),
    });

    await runCluster(h.deps, JOB);
    const signal = h.trends.signals.get('existing');

    expect(signal?.safetyVerdict).toBe('block');
    // And the reason quoted is the one that actually made the decision.
    expect(signal?.safetyReason).toBe('Blocked earlier for a reason that still holds.');
  });

  it('does let a verdict get worse', async () => {
    const h = harness();
    h.trends.seedCluster(
      {
        id: 'existing',
        centroid: at(0),
        memberIds: ['old'],
        label: 'Topic',
        firstSeenAt: NOW - 1000,
      },
      { safetyVerdict: 'allow' },
    );
    h.seed({
      title: 'Now with an indictment',
      excerpt: 'The indictment was unsealed on Tuesday.',
      embedding: at(0.05),
    });

    await runCluster(h.deps, JOB);
    expect(h.trends.signals.get('existing')?.safetyVerdict).toBe('block');
  });

  it('accumulates the categories that have ever fired', async () => {
    const h = harness();
    h.trends.seedCluster(
      {
        id: 'existing',
        centroid: at(0),
        memberIds: ['old'],
        label: 'Topic',
        firstSeenAt: NOW - 1000,
      },
      { safetyVerdict: 'review', safetyCategories: ['breaking'] },
    );
    h.seed({ title: 'Now legal', excerpt: 'The lawsuit was filed.', embedding: at(0.05) });

    await runCluster(h.deps, JOB);
    expect(h.trends.signals.get('existing')?.safetyCategories).toEqual(['breaking', 'legal']);
  });
});
