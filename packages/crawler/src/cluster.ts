/**
 * Clustering documents into topics.
 *
 * WHY NOT HDBSCAN
 * The brief names HDBSCAN, and for a static corpus it is the better algorithm: it finds
 * clusters of varying density and labels the rest as noise, without being told how many
 * to look for. Two things make it the wrong fit here.
 *
 * First, the corpus is not static. It turns over completely every 30 days and grows by
 * a few thousand documents an hour. HDBSCAN is not incremental — every run reclusters
 * everything, and cluster identity is not stable between runs. A `trend_signal` whose id
 * changes every hour cannot accumulate a momentum history, and momentum over time is the
 * entire point of the pipeline.
 *
 * Second, it would be a dependency with a native build step in a package that otherwise
 * has none, to solve a problem the simpler algorithm solves adequately.
 *
 * So: greedy nearest-centroid assignment against the clusters that already exist, with a
 * similarity threshold, and new clusters created for documents that match nothing. This
 * is incremental by construction, so cluster ids are stable across runs, which is what
 * makes a momentum history possible at all.
 *
 * WHAT WE GIVE UP
 * Cluster quality depends on arrival order, and a badly-placed early document can anchor
 * a cluster somewhere unhelpful. The mitigation is the periodic re-centroiding below,
 * plus the fact that a bad cluster scores poorly on audience fit and never gets
 * published. It is worth knowing this is the trade rather than discovering it.
 */

/** Cosine similarity of two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `Vectors must match: got ${String(a.length)} and ${String(b.length)} dimensions.`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  // A zero vector has no direction, so it is similar to nothing. Returning 0 rather than
  // NaN keeps one degenerate embedding from poisoning every comparison it takes part in.
  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ClusterMember {
  readonly id: string;
  readonly embedding: readonly number[];
}

export interface Cluster {
  readonly id: string;
  /** Mean of the members' embeddings. */
  readonly centroid: readonly number[];
  readonly memberIds: readonly string[];
}

/**
 * Similarity above which a document joins an existing cluster.
 *
 * 0.82 is deliberately high. The cost of splitting one topic into two clusters is that
 * both look less important than the topic is; the cost of merging two topics is a
 * cluster that means nothing, scores confusingly, and produces incoherent generated
 * content. Splitting is recoverable, merging is not.
 */
export const JOIN_THRESHOLD = 0.82;

export function centroidOf(vectors: readonly (readonly number[])[]): readonly number[] {
  const first = vectors[0];
  if (first === undefined) return [];

  const sum = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < sum.length; i += 1) sum[i] = (sum[i] as number) + (vector[i] ?? 0);
  }
  return sum.map((value) => value / vectors.length);
}

export interface AssignResult {
  readonly clusters: readonly Cluster[];
  /** Which cluster each document landed in, and how confidently. */
  readonly assignments: readonly {
    readonly memberId: string;
    readonly clusterId: string;
    readonly similarity: number;
    readonly createdCluster: boolean;
  }[];
}

/**
 * Assign documents to existing clusters, creating new ones where nothing fits.
 *
 * Incremental: `existing` comes from the database, so a cluster keeps its id — and
 * therefore its momentum history — across runs.
 */
export function assignToClusters(
  documents: readonly ClusterMember[],
  existing: readonly Cluster[],
  newClusterId: (document: ClusterMember) => string,
  threshold = JOIN_THRESHOLD,
): AssignResult {
  // Mutable working copies, so a document can join a cluster created earlier in this
  // same batch — otherwise a burst of forty articles about one story creates forty
  // clusters, which is exactly the failure deduplication and clustering exist to avoid.
  const clusters = existing.map((c) => ({
    id: c.id,
    centroid: [...c.centroid],
    memberIds: [...c.memberIds],
  }));

  const assignments: AssignResult['assignments'][number][] = [];

  for (const document of documents) {
    let best = -1;
    let bestSimilarity = -Infinity;

    for (let i = 0; i < clusters.length; i += 1) {
      const candidate = clusters[i];
      if (candidate === undefined) continue;
      const similarity = cosineSimilarity(document.embedding, candidate.centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = i;
      }
    }

    const winner = best >= 0 && bestSimilarity >= threshold ? clusters[best] : undefined;

    if (winner !== undefined) {
      // A running mean, not a midpoint between the centroid and the new document. The
      // midpoint would weight one arrival as heavily as the forty documents already in
      // the cluster, and the centroid would chase whatever arrived last instead of
      // describing the topic.
      const n = winner.memberIds.length + 1;
      winner.centroid = winner.centroid.map(
        (value, i) => value + ((document.embedding[i] ?? 0) - value) / n,
      );
      winner.memberIds.push(document.id);

      assignments.push({
        memberId: document.id,
        clusterId: winner.id,
        similarity: bestSimilarity,
        createdCluster: false,
      });
      continue;
    }

    const id = newClusterId(document);
    clusters.push({ id, centroid: [...document.embedding], memberIds: [document.id] });
    // A cluster of one sits exactly on its only member, so the similarity is 1 by
    // construction rather than by measurement.
    assignments.push({ memberId: document.id, clusterId: id, similarity: 1, createdCluster: true });
  }

  return { clusters, assignments };
}

/**
 * Recompute a cluster's centroid from all of its members.
 *
 * The correction for the incremental algorithm's one real weakness: assigning members
 * one at a time drifts the centroid towards whatever arrived most recently. Run
 * periodically over the members still inside the retention window, this pulls it back
 * to where the cluster actually is.
 */
export function recentroid(memberEmbeddings: readonly (readonly number[])[]): readonly number[] {
  return centroidOf(memberEmbeddings);
}

/**
 * Split a cluster that has drifted into covering two topics.
 *
 * Detected rather than assumed: if the two members furthest from each other are less
 * similar than the join threshold, the cluster is no longer one thing. Reported to the
 * operator rather than acted on automatically — splitting a cluster discards its
 * momentum history, and that is a decision worth a human.
 */
export function cohesion(memberEmbeddings: readonly (readonly number[])[]): number {
  if (memberEmbeddings.length < 2) return 1;

  let worst = 1;
  for (let i = 0; i < memberEmbeddings.length; i += 1) {
    for (let j = i + 1; j < memberEmbeddings.length; j += 1) {
      const similarity = cosineSimilarity(
        memberEmbeddings[i] as readonly number[],
        memberEmbeddings[j] as readonly number[],
      );
      if (similarity < worst) worst = similarity;
    }
  }
  return worst;
}
