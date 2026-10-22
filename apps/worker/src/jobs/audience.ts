/**
 * The audience job: engagement in, an interest vector out.
 *
 * This is the input the trend scorer has been missing. `audienceFit` is the cosine
 * similarity between a candidate topic and the centroid of the pages readers engage with
 * most — and until this job runs there is nothing to take a cosine against, so the
 * cluster job drops the term and scores on three signals instead of four.
 *
 * WHY THE SAME REWARD THE BANDIT USES
 * "Engagement" could mean a dozen things, and picking a fresh definition here would give
 * the system two: the bandit optimising one notion of a good page while the content
 * pipeline writes towards another. So the ranking runs `compositeReward` from
 * `@morph/adaptive` over per-page components, with the live weights from `engine_config`.
 * When the operator retunes the weights, both move together.
 *
 * WHY A MEDIAN AND NOT A TOP-N
 * A top-N is a fixed appetite regardless of how much there is to be confident about: with
 * six published pages it takes half the site, with six hundred it ignores most of what
 * readers liked. The median splits whatever exists, and its meaning does not change as
 * the site grows.
 *
 * WHAT IT REFUSES TO PRODUCE
 * A vector built from one or two pages is not an audience, it is those pages — and the
 * trend scorer would then reward topics resembling them and nothing else, which is a
 * feedback loop with a very short circumference. Below `MIN_CONTRIBUTORS` the job returns
 * nothing and the scorer keeps saying it does not know.
 */

import { compositeReward, type RewardWeights } from '@morph/adaptive';
import type {
  AudienceRepository,
  AudienceSnapshot,
  Clock,
  ContentRepository,
  EmbeddingProvider,
  EngagementRepository,
  Logger,
  PageEngagement,
  PublishedContent,
  TrendRepository,
} from '../ports';
import type { AudienceJob } from '../queues';

export interface AudienceDeps {
  readonly engagement: EngagementRepository;
  readonly content: ContentRepository;
  readonly trends: TrendRepository;
  readonly embeddings: EmbeddingProvider;
  readonly audience: AudienceRepository;
  /** Live from `engine_config`, so retuning the reward retunes this too. */
  readonly weights: RewardWeights;
  readonly bouncePenalty: number;
  readonly now: Clock;
  readonly log: Logger;
}

export type AudienceOutcome =
  | { readonly kind: 'computed'; readonly snapshot: AudienceSnapshot }
  | { readonly kind: 'insufficient'; readonly reason: string; readonly qualified: number };

/**
 * Below this, a page's rates are noise.
 *
 * A page with three views and one share has a 33% share rate and means nothing. The floor
 * is deliberately low rather than statistically derived: this is a ranking, not a
 * significance test, and a site that has just launched should not have to wait a month for
 * its first vector.
 */
export const MIN_IMPRESSIONS = 20;

/** Fewer contributors than this and the vector is those pages, not an audience. */
export const MIN_CONTRIBUTORS = 3;

export async function runAudience(deps: AudienceDeps, job: AudienceJob): Promise<AudienceOutcome> {
  const startedAt = deps.now();

  const engagement = await deps.engagement.byPage(job.windowDays);
  const eligible = engagement.filter((page) => page.impressions >= MIN_IMPRESSIONS);

  if (eligible.length < MIN_CONTRIBUTORS * 2) {
    // Times two, because the median discards half: eight eligible pages produce four
    // contributors, and four is the smallest set worth averaging.
    return insufficient(
      deps,
      `only ${String(eligible.length)} pages have ${String(MIN_IMPRESSIONS)}+ impressions`,
      eligible.length,
    );
  }

  const scored = eligible
    .map((page) => ({
      path: page.path,
      reward: compositeReward(toComponents(page), deps.weights, deps.bouncePenalty).perImpression,
    }))
    .sort((a, b) => b.reward - a.reward || a.path.localeCompare(b.path));

  const median = medianOf(scored.map((entry) => entry.reward));
  const above = scored.filter((entry) => entry.reward > median);

  if (above.length < MIN_CONTRIBUTORS) {
    // Every page scoring identically puts nothing strictly above the median. Not an
    // error — a site whose pages all perform the same has no preference to measure.
    return insufficient(
      deps,
      `only ${String(above.length)} pages scored above the median of ${median.toFixed(3)}`,
      above.length,
    );
  }

  const published = await deps.content.published();
  const bySlug = new Map(published.map((item) => [item.slug, item]));

  const contributors: { path: string; reward: number; vector: readonly number[] }[] = [];
  const unresolved: string[] = [];

  for (const entry of above) {
    const content = bySlug.get(slugFromPath(entry.path));
    if (content === undefined) {
      // A path with engagement and no content row: a page that was unpublished, or a
      // route that is not content at all. Reported rather than silently skipped, because
      // a rising count here means the path filter is wrong.
      unresolved.push(entry.path);
      continue;
    }

    const vector = await vectorFor(deps, content);
    if (vector === null) {
      unresolved.push(entry.path);
      continue;
    }

    contributors.push({ path: entry.path, reward: entry.reward, vector });
  }

  if (unresolved.length > 0) {
    deps.log.warn('audience.unresolved-pages', {
      count: unresolved.length,
      paths: unresolved.slice(0, 10),
    });
  }

  if (contributors.length < MIN_CONTRIBUTORS) {
    return insufficient(
      deps,
      `only ${String(contributors.length)} of ${String(above.length)} above-median pages could be resolved to a vector`,
      contributors.length,
    );
  }

  const vector = weightedCentroid(contributors);
  if (vector === null) {
    // Every contributing vector cancelled out, or all were zero. Vanishingly unlikely and
    // not worth a fabricated answer: a zero vector has no direction, so every cosine
    // against it would be 0 and every topic would look equally irrelevant.
    return insufficient(deps, 'the contributing vectors summed to zero', contributors.length);
  }

  const snapshot: AudienceSnapshot = {
    computedAt: startedAt,
    vector,
    sampleSize: contributors.length,
    medianReward: median,
    windowDays: job.windowDays,
    contributors: contributors.map((c) => ({ path: c.path, reward: c.reward })),
  };

  await deps.audience.save(snapshot);

  deps.log.info('audience.computed', {
    sampleSize: snapshot.sampleSize,
    medianReward: Number(median.toFixed(4)),
    eligible: eligible.length,
    windowDays: job.windowDays,
    top: snapshot.contributors.slice(0, 3).map((c) => c.path),
    durationMs: deps.now() - startedAt,
  });

  return { kind: 'computed', snapshot };
}

function insufficient(deps: AudienceDeps, reason: string, qualified: number): AudienceOutcome {
  // At info, not warn: before a site has traffic this is the expected state, and an
  // hourly warning for an expected state is how an operator learns to ignore warnings.
  deps.log.info('audience.insufficient', { reason, qualified });
  return { kind: 'insufficient', reason, qualified };
}

function toComponents(page: PageEngagement): Parameters<typeof compositeReward>[0] {
  return {
    impressions: page.impressions,
    signups: page.signups,
    engagedSessions: page.engagedSessions,
    scrollNormSum: page.scrollNormSum,
    returns: page.returns,
    shares: page.shares,
    bounces: page.bounces,
  };
}

/**
 * A page's position in the embedding space.
 *
 * The trend signal's centroid when the piece came from one: it is already in the right
 * space, it was computed from many documents rather than one summary, and using it costs
 * no embedding call. Otherwise the title and summary are embedded — which is what happens
 * for hand-written pages, and is the reason those still count towards the audience.
 */
async function vectorFor(
  deps: AudienceDeps,
  content: PublishedContent,
): Promise<readonly number[] | null> {
  if (content.trendSignalId !== null) {
    const signal = await deps.trends.byId(content.trendSignalId);
    if (signal !== null && signal.centroid.length === deps.embeddings.dimensions) {
      return signal.centroid;
    }
  }

  const [vector] = await deps.embeddings.embed([`${content.title}\n\n${content.summary}`]);
  if (vector === undefined || vector.length !== deps.embeddings.dimensions) return null;
  if (vector.some((value) => !Number.isFinite(value))) return null;

  return vector;
}

/**
 * The centroid, weighted by reward and normalised to unit length.
 *
 * Weighted, because the median has already decided *which* pages count and the reward
 * should decide *how much*: an unweighted mean treats the best page on the site and the
 * one just above the median as equally representative.
 *
 * Normalised, because everything downstream compares by cosine, and an unnormalised
 * centroid makes the comparison sensitive to how many pages happened to contribute.
 */
export function weightedCentroid(
  entries: readonly { readonly reward: number; readonly vector: readonly number[] }[],
): readonly number[] | null {
  const first = entries[0];
  if (first === undefined) return null;

  const sum = new Array<number>(first.vector.length).fill(0);
  let totalWeight = 0;

  for (const entry of entries) {
    // A reward of exactly zero would contribute nothing at all, which would silently drop
    // a page the median had selected. The floor keeps it in with the least possible say.
    const weight = Math.max(entry.reward, 1e-6);
    totalWeight += weight;

    for (let i = 0; i < sum.length; i += 1) {
      sum[i] = (sum[i] as number) + weight * (entry.vector[i] ?? 0);
    }
  }

  if (totalWeight === 0) return null;

  const mean = sum.map((value) => value / totalWeight);
  const norm = Math.sqrt(mean.reduce((total, value) => total + value * value, 0));
  if (norm === 0) return null;

  return mean.map((value) => value / norm);
}

/**
 * The median, taken as the lower of the two middle values on an even-length set.
 *
 * Not the mean of the two: the split has to be a value that a page actually scored, so
 * "above the median" always selects at least one page when any variation exists at all.
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** `/t/how-this-site-rebuilds-itself` → `how-this-site-rebuilds-itself`. */
export function slugFromPath(path: string): string {
  return path.replace(/^\/t\//, '').replace(/\/+$/, '');
}
