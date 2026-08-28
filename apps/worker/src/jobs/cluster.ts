/**
 * The cluster job: documents in, scored topics out.
 *
 * This is where the pipeline stops handling articles and starts handling subjects. New
 * embedded documents are assigned to the clusters that already exist — keeping cluster
 * ids stable across runs, which is what makes a momentum history possible at all (D14) —
 * and every cluster that gained a member is rescored and re-checked for safety.
 *
 * TWO DECISIONS WORTH FINDING HERE RATHER THAN IN A POST-MORTEM
 *
 * **A safety verdict never improves by itself.** The verdict stored on a cluster is the
 * worst one it has ever received, not the one this hour's three articles produced. A
 * topic that was blocked as an ongoing legal matter does not become publishable because
 * the latest coverage happened to be bland — the subject did not change, the sample did.
 *
 * **Audience fit is a measurement or it is absent.** Before there is engagement data
 * there is no audience vector, and inventing a number would be worse than not having one:
 * a fabricated 0 suppresses every topic, a fabricated 1 promotes every topic, and neither
 * announces itself. Instead the component is dropped and the remaining three weights
 * renormalise, so the total still reads as a fraction and the log records that it was
 * scored on three signals rather than four.
 */

import {
  assessSafety,
  assignToClusters,
  cosineSimilarity,
  DEFAULT_WEIGHTS,
  scoreTopic,
  type Cluster,
  type TopicHistory,
} from '@morph/crawler';
import { labelFor } from '../lib/label.js';
import type {
  Clock,
  DocumentRepository,
  EmbeddedDocument,
  Logger,
  StoredCluster,
  TrendRepository,
  TrendSignalRecord,
} from '../ports.js';
import type { ClusterJob } from '../queues.js';

export interface ClusterDeps {
  readonly documents: DocumentRepository;
  readonly trends: TrendRepository;
  /**
   * The site's measured interest, built from the embeddings of pages with above-median
   * engagement. `null` until there is enough engagement to build one.
   */
  readonly audienceVector: readonly number[] | null;
  readonly now: Clock;
  readonly log: Logger;
}

export interface ClusterOutcome {
  readonly documentsAssigned: number;
  readonly clustersCreated: number;
  readonly clustersUpdated: number;
  readonly blocked: number;
  readonly heldForReview: number;
}

/** How many hours of history the momentum score reads. */
export const MOMENTUM_WINDOW_HOURS = 24;

const SEVERITY = { allow: 0, review: 1, block: 2 } as const;

export async function runCluster(deps: ClusterDeps, job: ClusterJob): Promise<ClusterOutcome> {
  const now = deps.now();
  const since = now - job.windowHours * 3_600_000;

  const documents = await deps.documents.unclustered(since, job.batchSize);
  if (documents.length === 0) {
    return {
      documentsAssigned: 0,
      clustersCreated: 0,
      clustersUpdated: 0,
      blocked: 0,
      heldForReview: 0,
    };
  }

  const existing = await deps.trends.activeClusters(since);
  const byId = new Map(existing.map((cluster) => [cluster.id, cluster]));

  const result = assignToClusters(
    documents.map((document) => ({ id: document.id, embedding: document.embedding })),
    existing.map(toCrawlerCluster),
    () => deps.trends.nextClusterId(),
  );

  // Which documents landed where, so each touched cluster can be labelled and
  // safety-checked from the text that actually joined it.
  const arrivals = new Map<string, EmbeddedDocument[]>();
  const documentsById = new Map(documents.map((document) => [document.id, document]));

  for (const assignment of result.assignments) {
    const document = documentsById.get(assignment.memberId);
    if (document === undefined) continue;

    await deps.documents.setCluster(document.id, assignment.clusterId);
    const list = arrivals.get(assignment.clusterId);
    if (list === undefined) arrivals.set(assignment.clusterId, [document]);
    else list.push(document);
  }

  let created = 0;
  let updated = 0;
  let blocked = 0;
  let heldForReview = 0;

  for (const cluster of result.clusters) {
    const joined = arrivals.get(cluster.id);
    if (joined === undefined || joined.length === 0) continue;

    const previous = byId.has(cluster.id) ? await deps.trends.byId(cluster.id) : null;
    const record = await scoreCluster(deps, cluster, joined, previous, now);

    await deps.trends.save(record);

    if (previous === null) created += 1;
    else updated += 1;
    if (record.safetyVerdict === 'block') blocked += 1;
    if (record.safetyVerdict === 'review') heldForReview += 1;
  }

  const outcome: ClusterOutcome = {
    documentsAssigned: result.assignments.length,
    clustersCreated: created,
    clustersUpdated: updated,
    blocked,
    heldForReview,
  };

  deps.log.info('cluster.batch', {
    ...outcome,
    audienceFitKnown: deps.audienceVector !== null,
    durationMs: deps.now() - now,
  });

  return outcome;
}

async function scoreCluster(
  deps: ClusterDeps,
  cluster: {
    readonly id: string;
    readonly centroid: readonly number[];
    readonly memberIds: readonly string[];
  },
  joined: readonly EmbeddedDocument[],
  previous: TrendSignalRecord | null,
  now: number,
): Promise<TrendSignalRecord> {
  const history: TopicHistory = {
    hourlyMentions: await deps.documents.hourlyCounts(cluster.id, now, MOMENTUM_WINDOW_HOURS),
    distinctSources: await deps.documents.distinctSources(cluster.id),
    firstSeenAt: previous?.firstSeenAt ?? earliest(joined, now),
  };

  const audienceKnown = deps.audienceVector !== null;
  const similarity = audienceKnown ? cosineSimilarity(cluster.centroid, deps.audienceVector) : 0;

  const weights = audienceKnown ? DEFAULT_WEIGHTS : { ...DEFAULT_WEIGHTS, audienceFit: 0 };
  const score = scoreTopic(history, similarity, now, weights);

  const assessment = assessSafety({
    // The label carries the topic; the titles and excerpts carry what the coverage
    // actually says. A cluster named blandly can still be about an ongoing trial.
    title: previous?.label ?? '',
    text: joined.map((d) => `${d.title}\n${d.excerpt}`).join('\n\n'),
  });

  const verdict = worst(previous?.safetyVerdict ?? 'allow', assessment.verdict);

  return {
    id: cluster.id,
    // The label is set once and kept. An operator recognises a topic by its name, and a
    // name that drifts every hour is a topic they have to re-learn every hour.
    label: previous?.label ?? labelFor(joined.map((d) => d.title)),
    centroid: cluster.centroid,
    documentCount: cluster.memberIds.length,
    momentum: score.components.momentum,
    // Stored as the neutral prior when unknown, because the column is NOT NULL and
    // constrained to [0, 1]. It is excluded from the weighted total above, so this value
    // describes the row rather than influencing the decision.
    audienceFit: audienceKnown ? score.components.audienceFit : 0.5,
    saturation: score.components.saturation,
    durability: score.components.durability,
    safetyVerdict: verdict,
    safetyReason: reasonFor(verdict, assessment.summary, previous),
    safetyCategories: mergeCategories(previous?.safetyCategories, assessment),
    firstSeenAt: history.firstSeenAt,
    lastSeenAt: now,
    actedOnAt: previous?.actedOnAt ?? null,
  };
}

function toCrawlerCluster(cluster: StoredCluster): Cluster {
  return { id: cluster.id, centroid: cluster.centroid, memberIds: cluster.memberIds };
}

function earliest(documents: readonly EmbeddedDocument[], fallback: number): number {
  // `publishedAt` where the publisher gave one, because a topic's age is when it started
  // being discussed, not when this crawler happened to notice it.
  const times = documents.map((d) => d.publishedAt ?? d.fetchedAt);
  return times.length === 0 ? fallback : Math.min(...times);
}

function worst(
  a: TrendSignalRecord['safetyVerdict'],
  b: TrendSignalRecord['safetyVerdict'],
): TrendSignalRecord['safetyVerdict'] {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function reasonFor(
  verdict: TrendSignalRecord['safetyVerdict'],
  summary: string,
  previous: TrendSignalRecord | null,
): string | null {
  if (verdict === 'allow') return null;
  // When the stored verdict is the one that survived, its reason is the one that explains
  // the row — quoting this batch's summary would describe a decision that was not made.
  if (previous !== null && SEVERITY[previous.safetyVerdict] >= SEVERITY[verdict]) {
    return previous.safetyReason ?? summary;
  }
  return summary;
}

function mergeCategories(
  previous: readonly string[] | undefined,
  assessment: ReturnType<typeof assessSafety>,
): readonly string[] {
  return [...new Set([...(previous ?? []), ...assessment.matches.map((m) => m.categoryId)])].sort();
}
