import { describe, expect, it } from 'vitest';
import {
  assignToClusters,
  centroidOf,
  cohesion,
  cosineSimilarity,
  JOIN_THRESHOLD,
  recentroid,
  type Cluster,
} from '../src/cluster';

/** A unit vector at `angle` radians, so similarity is controllable rather than guessed. */
const at = (angle: number): readonly number[] => [Math.cos(angle), Math.sin(angle)];

describe('cosine similarity', () => {
  it('is 1 for identical directions and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  /**
   * One degenerate embedding must not poison every comparison it takes part in, which is
   * what NaN would do.
   */
  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it('refuses mismatched dimensions rather than comparing nonsense', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimensions/);
  });
});

describe('centroids', () => {
  it('averages component-wise', () => {
    expect(
      centroidOf([
        [0, 0],
        [2, 4],
      ]),
    ).toEqual([1, 2]);
  });

  it('returns nothing for no vectors', () => {
    expect(centroidOf([])).toEqual([]);
  });

  it('treats a short vector as zero-padded rather than throwing', () => {
    expect(centroidOf([[2, 2], [0]])).toEqual([1, 1]);
  });

  it('recentroid is the mean of every member', () => {
    expect(
      recentroid([
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]),
    ).toEqual([0, 0]);
  });
});

describe('assignment', () => {
  const newId = (d: { id: string }): string => `cluster-for-${d.id}`;

  it('creates a cluster when nothing exists yet', () => {
    const result = assignToClusters([{ id: 'a', embedding: [1, 0] }], [], newId);

    expect(result.clusters).toHaveLength(1);
    expect(result.assignments[0]?.createdCluster).toBe(true);
    expect(result.assignments[0]?.clusterId).toBe('cluster-for-a');
    expect(result.clusters[0]?.memberIds).toEqual(['a']);
  });

  it('joins an existing cluster when close enough', () => {
    const existing: Cluster[] = [{ id: 'topic-1', centroid: [1, 0], memberIds: ['seed'] }];
    const result = assignToClusters([{ id: 'a', embedding: at(0.2) }], existing, newId);

    expect(result.assignments[0]?.createdCluster).toBe(false);
    expect(result.assignments[0]?.clusterId).toBe('topic-1');
    expect(result.clusters[0]?.memberIds).toEqual(['seed', 'a']);
  });

  it('creates a new cluster when the nearest is too far', () => {
    const existing: Cluster[] = [{ id: 'topic-1', centroid: [1, 0], memberIds: ['seed'] }];
    const result = assignToClusters([{ id: 'a', embedding: [0, 1] }], existing, newId);

    expect(result.assignments[0]?.createdCluster).toBe(true);
    expect(result.clusters).toHaveLength(2);
  });

  /**
   * The failure this stage exists to prevent: forty articles about one story must not
   * become forty clusters. A document has to be able to join a cluster created moments
   * earlier in the same batch.
   */
  it('lets a document join a cluster created earlier in the same batch', () => {
    const documents = Array.from({ length: 5 }, (_, i) => ({
      id: `doc-${String(i)}`,
      embedding: at(i * 0.02),
    }));

    const result = assignToClusters(documents, [], newId);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.memberIds).toHaveLength(5);
  });

  /**
   * The bug a midpoint update would have: one arrival must not move the centroid as far
   * as the forty documents already in the cluster did.
   */
  it('moves the centroid less as a cluster grows', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `d${String(i)}`, embedding: [1, 0] }));
    const grown = assignToClusters(many, [], newId);
    const before = grown.clusters[0]?.centroid ?? [];

    const after =
      assignToClusters([{ id: 'newcomer', embedding: at(0.3) }], grown.clusters, newId).clusters[0]
        ?.centroid ?? [];

    // 21st member: the centroid should move by roughly a twentieth of the gap, not half.
    expect(cosineSimilarity(before, after)).toBeGreaterThan(0.99);
  });

  it('reports the similarity that decided the assignment', () => {
    const existing: Cluster[] = [{ id: 'topic-1', centroid: [1, 0], memberIds: ['seed'] }];
    const result = assignToClusters([{ id: 'a', embedding: at(0.1) }], existing, newId);

    expect(result.assignments[0]?.similarity).toBeCloseTo(Math.cos(0.1));
  });

  it('honours a threshold the caller supplies', () => {
    const existing: Cluster[] = [{ id: 'topic-1', centroid: [1, 0], memberIds: ['seed'] }];
    const document = { id: 'a', embedding: at(1.0) }; // similarity ≈ 0.54

    expect(assignToClusters([document], existing, newId, 0.5).assignments[0]?.createdCluster).toBe(
      false,
    );
    expect(assignToClusters([document], existing, newId, 0.6).assignments[0]?.createdCluster).toBe(
      true,
    );
  });

  it('leaves existing clusters untouched when there is nothing to assign', () => {
    const existing: Cluster[] = [{ id: 'topic-1', centroid: [1, 0], memberIds: ['seed'] }];
    const result = assignToClusters([], existing, newId);

    expect(result.clusters).toEqual(existing);
    expect(result.assignments).toEqual([]);
  });

  /**
   * Cluster identity across runs is what makes a momentum history possible. If ids
   * changed every hour, no topic could ever accumulate one.
   */
  it('preserves cluster ids across runs', () => {
    const first = assignToClusters([{ id: 'a', embedding: [1, 0] }], [], newId);
    const second = assignToClusters([{ id: 'b', embedding: at(0.1) }], first.clusters, newId);

    expect(second.clusters[0]?.id).toBe(first.clusters[0]?.id);
  });

  it('does not mutate the clusters it was given', () => {
    const existing: Cluster[] = [{ id: 'topic-1', centroid: [1, 0], memberIds: ['seed'] }];
    assignToClusters([{ id: 'a', embedding: [1, 0] }], existing, newId);

    expect(existing[0]?.memberIds).toEqual(['seed']);
    expect(existing[0]?.centroid).toEqual([1, 0]);
  });
});

describe('cohesion', () => {
  it('is 1 for a cluster of one', () => {
    expect(cohesion([[1, 0]])).toBe(1);
    expect(cohesion([])).toBe(1);
  });

  it('reports the least similar pair', () => {
    expect(cohesion([at(0), at(0.1), at(0.2)])).toBeCloseTo(Math.cos(0.2));
  });

  it('falls below the join threshold once a cluster covers two topics', () => {
    expect(
      cohesion([
        [1, 0],
        [1, 0],
        [0, 1],
      ]),
    ).toBeLessThan(JOIN_THRESHOLD);
  });
});
