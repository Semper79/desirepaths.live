/**
 * `@morph/crawler` — how MORPH learns what the world is talking about.
 *
 * The pipeline, in order, and each stage is a module:
 *
 *   robots     what a host permits            (RFC 9309)
 *   politeness how fast we may ask            (§4.1)
 *   fetch      the only outbound request      (composes the two above)
 *   feed       RSS / Atom / RDF into items    (§4.1 source hierarchy)
 *   extract    the article out of the page    (§4.2)
 *   simhash    the same story, forty times    (§4.3)
 *   cluster    stories into topics            (§4.3)
 *   score      which topics are worth writing (§4.4)
 *   safety     which topics never are         (§6.4)
 *
 * Everything except `fetch` is pure. That is why the interesting behaviour — a crawl
 * delay, a near-duplicate, a topic peaking, a blocked category — is tested by passing
 * values rather than by standing up a network.
 *
 * There is deliberately no raw fetch wrapper exported. `PoliteFetcher` is the only way
 * out of this package to the network, so the compliance guarantees cannot be bypassed by
 * a caller who did not read the docs.
 */

export {
  parseRobots,
  groupFor,
  patternMatches,
  isAllowed,
  policyFrom,
  isExpired,
  ROBOTS_TTL_MS,
  ROBOTS_ERROR_TTL_MS,
  type RobotsRule,
  type RobotsGroup,
  type RobotsTxt,
  type RobotsDecision,
  type RobotsFetchOutcome,
  type RobotsPolicy,
} from './robots.js';

export {
  PolitenessScheduler,
  DEFAULT_POLITENESS,
  type PolitenessConfig,
  type Verdict,
} from './politeness.js';

export {
  PoliteFetcher,
  DEFAULT_FETCHER_CONFIG,
  type FetcherConfig,
  type FetchDeps,
  type FetchOutcome,
  type ConditionalHeaders,
  retryAfterMs,
} from './fetch.js';

export {
  parseFeed,
  usableItems,
  parseDate,
  toPlainText,
  type FeedItem,
  type ParsedFeed,
  type FeedParseResult,
} from './feed.js';

export {
  extract,
  scoreElement,
  normaliseWhitespace,
  countWords,
  MINIMUM_WORDS,
  type ExtractedDocument,
  type ExtractResult,
} from './extract.js';

export {
  simhash,
  shingles,
  hash64,
  hammingDistance,
  isNearDuplicate,
  deduplicate,
  toStorage,
  fromStorage,
  NEAR_DUPLICATE_DISTANCE,
  type Deduplicated,
} from './simhash.js';

export {
  cosineSimilarity,
  centroidOf,
  assignToClusters,
  recentroid,
  cohesion,
  JOIN_THRESHOLD,
  type Cluster,
  type ClusterMember,
  type AssignResult,
} from './cluster.js';

export {
  scoreTopic,
  momentum,
  velocity,
  acceleration,
  audienceFit,
  saturation,
  durability,
  rank,
  DEFAULT_WEIGHTS,
  PUBLISH_THRESHOLD,
  REFERENCE_MENTIONS_PER_HOUR,
  SATURATION_REFERENCE_SOURCES,
  DURABILITY_REFERENCE_HOURS,
  type TopicHistory,
  type TopicScore,
  type ScoreComponents,
  type ScoreWeights,
  type RankedTopic,
} from './score.js';

export {
  assessSafety,
  mayGenerateAutomatically,
  containsTerm,
  SAFETY_CATEGORIES,
  type SafetyVerdict,
  type SafetyCategory,
  type SafetyAssessment,
} from './safety.js';
