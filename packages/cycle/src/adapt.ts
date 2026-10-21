/**
 * The adapt job: measured behaviour in, a decision set out.
 *
 * This is the job that makes the site adaptive. Without it `packages/adaptive` is an
 * engine nothing feeds and nothing reads: every surface resolves to its baseline for
 * ever, and the reading on the home page stays at zero not because the site is new but
 * because the wire was never connected.
 *
 * The loop, once an hour:
 *
 *   1. read the reward components the collector produced for the hour that just finished
 *   2. decay every posterior towards its prior, then add that hour's evidence
 *   3. ask the guardrails what to retire and what to quarantine
 *   4. write the durable record, apply the decisions, publish the live snapshot
 *
 * WHY IT REFUSES TO RUN AN HOUR TWICE
 * Re-applying a cycle adds the same evidence to the same posteriors again. Nothing errors
 * and nothing looks wrong — the posteriors simply become more confident than the data
 * warrants, which is the failure mode this whole system is built to avoid, arriving
 * through its own front door. `posteriorState().throughHour` is the guard, and it is the
 * `taken_at` of the last durable write rather than a new table, so the record of what was
 * applied and the mechanism preventing double-application cannot disagree.
 *
 * WHY THE HOLDOUT IS NOT IN THE INPUT
 * The holdout cohort is pinned to the baseline, so its rows would land entirely on one
 * variant and make that variant look far better sampled than the traffic it actually
 * competes for. Worse, the cohort exists to measure the system against itself; feeding it
 * back into the system it measures makes the comparison circular. The repository filters
 * it out, and `adapt.test.ts` asserts the filter rather than trusting the SQL.
 *
 * WHAT THIS JOB DELIBERATELY CANNOT DO
 * Create a variant. Generation is `jobs/generate.ts` and goes through the approval queue.
 * This job only ever *removes* — retire or quarantine — which means the worst outcome of
 * a bug here is a site that adapts less than it could, never one that starts serving
 * something nobody approved.
 */

import {
  advancePosteriors,
  buildSnapshot,
  decideAdaptations,
  explorationRateOf,
  targetHour,
  type CycleConfig,
} from './derive.js';
import type {
  AdaptRepository,
  Clock,
  Logger,
  RewardRepository,
  SnapshotPublisher,
} from './ports.js';

/**
 * What a cycle is asked to do.
 *
 * Was `AdaptRequest` from `queues.ts`, which tied the cycle to BullMQ for the sake of one
 * optional field. A Cron Trigger has no payload, so the shape it actually needed is this:
 * an optional hour to target, for a replay.
 */
export interface AdaptRequest {
  /** Epoch milliseconds inside the hour to fold. Defaults to the most recent settled one. */
  readonly hourStart?: number | undefined;
}

export interface AdaptDeps {
  readonly rewards: RewardRepository;
  readonly store: AdaptRepository;
  readonly publisher: SnapshotPublisher;
  /** Live from `engine_config`, so retuning the reward retunes the loop. */
  readonly config: CycleConfig;
  /**
   * The kill switch. When adaptation is off the cycle still runs and still writes the
   * durable record — the site keeps learning — but the published snapshot tells the
   * renderer to serve baselines. Stopping the measurement as well would mean the operator
   * turning adaptation back on faces a system that has forgotten the intervening days.
   */
  readonly adaptationEnabled: boolean;
  readonly now: Clock;
  readonly log: Logger;
}

export type AdaptOutcome =
  | {
      readonly kind: 'applied';
      readonly hour: number;
      readonly variants: number;
      readonly retired: number;
      readonly quarantined: number;
      /** Null when no contested surface saw traffic. See `explorationRateOf`. */
      readonly explorationRate: number | null;
    }
  | { readonly kind: 'already_applied'; readonly hour: number }
  | { readonly kind: 'no_variants' };

export async function runAdapt(deps: AdaptDeps, job: AdaptRequest): Promise<AdaptOutcome> {
  const hour = job.hourStart ?? targetHour(deps.now());

  const variants = await deps.store.activeVariants();
  if (variants.length === 0) {
    // Nothing seeded yet. Not an error: the registry is seeded at boot, and a worker that
    // wins the race against that seeding would otherwise fail its first cycle for a reason
    // nobody would connect to boot ordering.
    deps.log.warn('adapt.no_variants', { hour });
    return { kind: 'no_variants' };
  }

  const state = await deps.store.posteriorState();
  if (state.throughHour !== null && state.throughHour >= hour) {
    deps.log.info('adapt.already_applied', { hour, throughHour: state.throughHour });
    return { kind: 'already_applied', hour };
  }

  const [rewards, health, rewardVersion] = await Promise.all([
    deps.rewards.rewards(hour),
    deps.rewards.health(hour),
    deps.store.rewardVersion(),
  ]);

  const posteriors = advancePosteriors(variants, state.posteriors, rewards, deps.config);
  const decisions = decideAdaptations(variants, posteriors, health, deps.config);

  // The durable write first. If the process dies between here and the publish, the next
  // cycle sees this hour as applied and continues from it — the site serves a snapshot one
  // hour stale, which is a smaller wrong than a cycle applied twice.
  await deps.store.writePosteriors(hour, posteriors);

  if (decisions.length > 0) {
    await deps.store.applyDecisions(decisions, rewardVersion);
  }

  await deps.publisher.publish(
    buildSnapshot(posteriors, decisions, deps.now(), deps.adaptationEnabled),
  );

  const retired = decisions.filter((d) => d.action === 'retire').length;
  const quarantined = decisions.length - retired;

  deps.log.info('adapt.applied', {
    hour,
    variants: posteriors.length,
    rewardRows: rewards.length,
    retired,
    quarantined,
    adaptationEnabled: deps.adaptationEnabled,
  });

  return {
    kind: 'applied',
    hour,
    variants: posteriors.length,
    retired,
    quarantined,
    explorationRate: explorationRateOf(posteriors, rewards),
  };
}
