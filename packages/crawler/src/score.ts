/**
 * Scoring a topic: is this worth writing about, and is it worth writing about *now*?
 *
 * Pure functions over counts and timestamps. No I/O, no clock — `now` is a parameter, so
 * "this topic peaked six hours ago" is a test rather than a wait.
 *
 * The four components answer four different questions, and a topic has to do well on all
 * of them. Weighting them into one number is a decision that gets argued about, so the
 * weights are data (`DEFAULT_WEIGHTS`) rather than constants buried in an expression, and
 * every component is reported alongside the total. When the operator asks the Telegram
 * bot why a topic was picked, the answer is the breakdown, not the total.
 */

/** Observations of a topic, oldest first. One bucket per hour. */
export interface TopicHistory {
  /** Documents mentioning the topic, per hour, oldest first. */
  readonly hourlyMentions: readonly number[];
  /** Distinct sources across the whole window. Syndication is not popularity. */
  readonly distinctSources: number;
  /** When the first document was seen. */
  readonly firstSeenAt: number;
}

export interface ScoreWeights {
  readonly momentum: number;
  readonly audienceFit: number;
  readonly saturation: number;
  readonly durability: number;
}

/**
 * Momentum leads because timing is the thing a small publisher can actually compete on;
 * audience fit is close behind, because a fast-moving topic nobody here cares about is
 * still worthless. Saturation is a smaller correction, and durability smaller still — it
 * is a tie-break between two otherwise equal topics, not a veto.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  momentum: 0.4,
  audienceFit: 0.3,
  saturation: 0.2,
  durability: 0.1,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, n) => sum + n, 0) / values.length;

/**
 * Normalisation reference for the mention rate.
 *
 * Against a fixed rate rather than against the corpus, because a corpus-relative measure
 * moves whenever the corpus does — a quiet night would promote everything in it.
 */
export const REFERENCE_MENTIONS_PER_HOUR = 12;

/** Mentions per hour over the recent window, saturating into [0, 1). */
export function velocity(history: TopicHistory, windowHours = 6): number {
  const perHour = mean(history.hourlyMentions.slice(-windowHours));
  // Saturating rather than linear: the difference between 12 and 24 mentions an hour
  // matters, the difference between 200 and 400 does not.
  return perHour / (perHour + REFERENCE_MENTIONS_PER_HOUR);
}

/**
 * Is the rate rising or falling?
 *
 * This is what separates a topic on the way up from one on the way down at the same
 * volume. Publishing into a decline is how a site ends up permanently three hours late.
 * Signed, in [-1, 1].
 */
export function acceleration(history: TopicHistory, windowHours = 6): number {
  const recent = history.hourlyMentions.slice(-windowHours * 2);
  if (recent.length < 2) return 0;

  const half = Math.floor(recent.length / 2);
  const earlierRate = mean(recent.slice(0, half));
  const laterRate = mean(recent.slice(half));

  // Dividing by the sum rather than by `earlierRate` bounds the result and avoids the
  // division by zero when a topic goes from nothing to something — which is the case
  // this signal most needs to handle, not the one it can afford to crash on.
  const total = earlierRate + laterRate;
  if (total === 0) return 0;
  return (laterRate - earlierRate) / total;
}

/**
 * Volume and direction together.
 *
 * A topic already at volume and still rising scores highest. A topic at volume but
 * falling is discounted, not eliminated — sometimes the decline is the story.
 */
export function momentum(history: TopicHistory, windowHours = 6): number {
  const v = velocity(history, windowHours);
  const a = acceleration(history, windowHours);
  // Acceleration modulates volume by at most ±50%, so it can never turn a topic nobody
  // is discussing into a candidate on the strength of going from one mention to two.
  return clamp01(v * (1 + a * 0.5));
}

/**
 * Does this resemble what the site's readers actually engage with?
 *
 * The audience vector is built from the embeddings of pages with above-median engagement,
 * so this is measured preference rather than assumed preference. Cosine similarity
 * arrives in [-1, 1] and is clamped: a negative fit and a zero fit are equally
 * uninteresting, and the difference between them is not worth carrying.
 */
export function audienceFit(similarity: number): number {
  return clamp01(similarity);
}

export const SATURATION_REFERENCE_SOURCES = 25;

/**
 * How thoroughly covered is this already? Inverted, so a crowded topic scores low.
 *
 * This is the component that keeps MORPH from writing the forty-first article about the
 * thing forty outlets covered this morning: there is no reader for it and no search
 * position available.
 */
export function saturation(distinctSources: number): number {
  const sources = Math.max(0, distinctSources);
  return clamp01(1 - sources / (sources + SATURATION_REFERENCE_SOURCES));
}

export const DURABILITY_REFERENCE_HOURS = 72;

/**
 * Will this still be worth reading next month?
 *
 * Estimated from how long the topic has stayed alive rather than from its content: a
 * topic sustaining mentions for days is more likely structural than incidental. This is
 * the weakest of the four signals and is weighted accordingly.
 */
export function durability(history: TopicHistory, now: number): number {
  const ageHours = Math.max(0, (now - history.firstSeenAt) / 3_600_000);
  return clamp01(ageHours / (ageHours + DURABILITY_REFERENCE_HOURS));
}

export interface ScoreComponents {
  readonly momentum: number;
  readonly audienceFit: number;
  readonly saturation: number;
  readonly durability: number;
}

export interface TopicScore {
  readonly total: number;
  readonly components: ScoreComponents;
  /** The plain-language reason, quoted verbatim in the hourly report. */
  readonly rationale: string;
}

/**
 * Combine components into one number.
 *
 * Separate from `scoreTopic` because the components are what gets *stored*
 * (`trend_signal` has a column each and no total), so anything reading a signal back has
 * to recompute the total. Two copies of this arithmetic would drift the moment a weight
 * changed, and the symptom would be a queue ordered differently from the report that
 * describes it.
 *
 * Renormalised by the weight sum, so dropping a component — an audience vector that does
 * not exist yet — reweights the rest rather than dragging the total towards zero.
 */
export function combine(
  components: ScoreComponents,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): number {
  const weightSum =
    weights.momentum + weights.audienceFit + weights.saturation + weights.durability;
  if (weightSum === 0) return 0;

  const weighted =
    components.momentum * weights.momentum +
    components.audienceFit * weights.audienceFit +
    components.saturation * weights.saturation +
    components.durability * weights.durability;

  return clamp01(weighted / weightSum);
}

export function scoreTopic(
  history: TopicHistory,
  audienceSimilarity: number,
  now: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): TopicScore {
  const components: ScoreComponents = {
    momentum: momentum(history),
    audienceFit: audienceFit(audienceSimilarity),
    saturation: saturation(history.distinctSources),
    durability: durability(history, now),
  };

  return {
    total: combine(components, weights),
    components,
    rationale: rationaleFor(components),
  };
}

/**
 * Name the dominant reasons, so a decision can be argued with.
 *
 * A score of 0.71 tells an operator nothing. "Rising fast, lightly covered" tells them
 * whether they agree.
 */
function rationaleFor(components: ScoreComponents): string {
  const parts: string[] = [];

  if (components.momentum >= 0.6) parts.push('rising fast');
  else if (components.momentum >= 0.35) parts.push('building');
  else parts.push('quiet');

  if (components.saturation >= 0.6) parts.push('lightly covered');
  else if (components.saturation <= 0.3) parts.push('already crowded');

  if (components.audienceFit >= 0.6) parts.push('close to what readers engage with');
  else if (components.audienceFit <= 0.3) parts.push('far from the usual audience');

  if (components.durability >= 0.6) parts.push('sustained for days');

  return parts.join(', ');
}

/**
 * The score below which a topic is not worth a generation job.
 *
 * Set from the cost asymmetry rather than from a distribution: generating and reviewing a
 * weak article costs the operator's attention, which is the scarcest resource in the
 * system. Missing one good topic costs one article among many.
 */
export const PUBLISH_THRESHOLD = 0.55;

export interface RankedTopic {
  readonly id: string;
  readonly score: TopicScore;
}

export function rank(topics: readonly RankedTopic[], limit: number): readonly RankedTopic[] {
  return (
    [...topics]
      .filter((t) => t.score.total >= PUBLISH_THRESHOLD)
      // Ties broken by id, so two identical scores order the same way on every run and a
      // re-run of the pipeline does not silently reshuffle the queue.
      .sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit))
  );
}
