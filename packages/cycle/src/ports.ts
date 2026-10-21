/**
 * The ports the adaptive cycle is written against.
 *
 * Moved out of `apps/worker/src/ports.ts` by the Cloudflare port (D37). The cycle is domain
 * logic — it decides what the engine believes — and it had been sitting in an app, which
 * meant the Worker that now runs it could not import it: `CLAUDE.md` is explicit that apps
 * may depend on packages and never on each other.
 *
 * Nothing in here knows where the numbers come from. That was true when the implementations
 * were ClickHouse and Postgres and it is why they can now be Durable Objects, Analytics
 * Engine, D1 and KV without the cycle changing a line.
 */

import type { Arm, RewardComponents } from '@morph/adaptive';

// -----------------------------------------------------------------------------
// The adaptive loop
// -----------------------------------------------------------------------------

/**
 * One variant the engine is allowed to serve.
 *
 * `isBaseline` matters twice: the baseline can never be retired (there would be nothing
 * to fall back to), and it is what the holdout cohort is pinned to.
 */
export interface ActiveVariant {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly isBaseline: boolean;
  /** Optimistic prior for a freshly injected variant. §2.3. */
  readonly priorAlpha: number;
  readonly priorBeta: number;
}

/**
 * A cycle's worth of reward components for one (surface, variant).
 *
 * Already summed across context buckets. Thompson sampling wants one posterior per
 * variant; the un-bucketed covariate vector is LinUCB's problem, and splitting the Beta
 * posteriors by context as well would divide the evidence into cells too thin to sample
 * from — which is the note on `context_bucket` in `002_aggregates.sql`, honoured here.
 */
export interface VariantReward {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly components: RewardComponents;
}

/** A posterior as it was last written. */
export interface StoredPosterior {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly alpha: number;
  readonly beta: number;
  readonly impressions: number;
}

export interface PosteriorState {
  /**
   * The cycle these posteriors already include, as an hour-start epoch, or null when
   * none have ever been written.
   *
   * This is the idempotency key for the whole job. Re-running a cycle would add the same
   * evidence to the same posteriors a second time — silently, and in a way that looks
   * like unusually strong data rather than like a bug.
   */
  readonly throughHour: number | null;
  readonly posteriors: readonly StoredPosterior[];
}

/** Core Web Vitals and error rates per variant, for the rollback guardrail. */
export interface VariantHealth {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly samples: number;
  readonly p75LcpMs: number;
  readonly p75Cls: number;
  readonly p75InpMs: number;
  readonly clientErrorRate: number;
  readonly bounceRate: number;
}

/** What the adaptive loop reads out of ClickHouse. */
export interface RewardRepository {
  /** Reward components for one completed hour, holdout rows excluded. */
  rewards(hourStart: number): Promise<readonly VariantReward[]>;
  /** Vitals for the same hour, for `evaluateHealth`. */
  health(hourStart: number): Promise<readonly VariantHealth[]>;
}

export type AdaptationAction = 'retire' | 'quarantine';

/** One decision, ready for the immutable log. */
export interface AdaptationRecord {
  readonly action: AdaptationAction;
  readonly surfaceId: string;
  readonly variantId: string;
  readonly reason: string;
  readonly stats: Readonly<Record<string, unknown>>;
}

/**
 * The live decision set the renderer reads before it emits a byte.
 *
 * Deliberately the same shape `apps/web` already expects, so publishing is a write and
 * reading is a parse, with no translation layer in between where the two could drift.
 */
export interface PublishedSnapshot {
  readonly arms: Readonly<Record<string, readonly Arm[]>>;
  readonly adaptationEnabled: boolean;
  readonly generatedAt: number;
}

/** What the adaptive loop reads and writes in Postgres. */
export interface AdaptRepository {
  activeVariants(): Promise<readonly ActiveVariant[]>;
  posteriorState(): Promise<PosteriorState>;
  /** The reward weight version in force. Epochs must never be compared across it. */
  rewardVersion(): Promise<number>;
  /** The durable record. Written every cycle, whether or not anything changed. */
  writePosteriors(takenAt: number, posteriors: readonly StoredPosterior[]): Promise<void>;
  /** Status change plus its log entry, in one transaction or not at all. */
  applyDecisions(records: readonly AdaptationRecord[], rewardVersion: number): Promise<void>;
}

/** Where the renderer looks. */
export interface SnapshotPublisher {
  publish(snapshot: PublishedSnapshot): Promise<void>;
}

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type Clock = () => number;
