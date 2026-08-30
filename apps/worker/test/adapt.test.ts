/**
 * The adaptive cycle.
 *
 * The tests that matter here are not the arithmetic ones. They are the ones asserting
 * that an hour cannot be folded in twice, that the pseudo-count stays bounded so the
 * bandit can still change its mind, that the baseline and the leader are never removed,
 * and that a missing health sample is not read as a clean bill of health. Each of those
 * failures is silent in production: the site would keep serving pages and keep reporting
 * confidence it had not earned.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG } from '@morph/core';
import {
  advancePosteriors,
  buildSnapshot,
  cycleConfigFrom,
  decideAdaptations,
  explorationRateOf,
  targetHour,
} from '../src/lib/adapt-derive.js';
import { runAdapt } from '../src/jobs/adapt.js';
import type {
  ActiveVariant,
  AdaptRepository,
  AdaptationRecord,
  PosteriorState,
  RewardRepository,
  SnapshotPublisher,
  StoredPosterior,
  VariantHealth,
  VariantReward,
} from '../src/ports.js';

const CONFIG = cycleConfigFrom(DEFAULT_ENGINE_CONFIG);
const HOUR = 3_600_000;

function variantOf(surfaceId: string, variantId: string, isBaseline = false): ActiveVariant {
  return { surfaceId, variantId, isBaseline, priorAlpha: 1, priorBeta: 1 };
}

/** A cycle's evidence at a chosen conversion rate. */
function rewardOf(
  surfaceId: string,
  variantId: string,
  impressions: number,
  signupRate: number,
): VariantReward {
  return {
    surfaceId,
    variantId,
    components: {
      impressions,
      signups: Math.round(impressions * signupRate),
      engagedSessions: 0,
      scrollNormSum: 0,
      returns: 0,
      shares: 0,
      bounces: 0,
    },
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('advancePosteriors', () => {
  it('starts an unseen variant from its own prior', () => {
    // §2.3: a freshly injected variant gets an optimistic prior so Thompson sampling
    // gives it traffic rather than ignoring it into irrelevance.
    const optimistic: ActiveVariant = {
      surfaceId: 'hero.headline',
      variantId: 'hero.headline#new',
      isBaseline: false,
      priorAlpha: 3,
      priorBeta: 1,
    };

    const [posterior] = advancePosteriors([optimistic], [], [], CONFIG);

    expect(posterior?.alpha).toBeCloseTo(3, 6);
    expect(posterior?.beta).toBeCloseTo(1, 6);
    expect(posterior?.impressions).toBe(0);
  });

  it('adds an hour of evidence to the posterior', () => {
    const variants = [variantOf('s', 's#a')];
    const rewards = [rewardOf('s', 's#a', 1_000, 0.5)];

    const [posterior] = advancePosteriors(variants, [], rewards, CONFIG);

    // 500 signups at weight 0.4 is 200 reward-units of the 1,000 trials.
    expect(posterior?.alpha).toBeCloseTo(1 + 200, 4);
    expect(posterior?.beta).toBeCloseTo(1 + 800, 4);
    expect(posterior?.impressions).toBe(1_000);
  });

  it('decays a variant nobody saw this hour', () => {
    // Not an oversight. A variant with no traffic is a variant with no *current*
    // evidence, and a posterior frozen at last month's confidence is how a champion
    // that has stopped working stays champion for ever.
    const held: StoredPosterior = {
      surfaceId: 's',
      variantId: 's#a',
      alpha: 401,
      beta: 601,
      impressions: 1_000,
    };

    const [posterior] = advancePosteriors([variantOf('s', 's#a')], [held], [], CONFIG);

    expect(posterior?.alpha).toBeLessThan(held.alpha);
    expect(posterior?.beta).toBeLessThan(held.beta);
    expect(posterior?.impressions).toBe(1_000);
  });

  it('keeps the pseudo-count bounded, which is what lets the bandit change its mind', () => {
    // The property the whole forgetting mechanism exists for. Without the bound, after
    // enough hours a posterior becomes immovable and the 2% exploration floor can never
    // dislodge it — measured at 2.1% terminal best-arm share in `sim.test.ts`.
    let posteriors: readonly StoredPosterior[] = [];
    const variants = [variantOf('s', 's#a')];
    const rewards = [rewardOf('s', 's#a', 1_000, 0.5)];

    for (let cycle = 0; cycle < 500; cycle += 1) {
      posteriors = advancePosteriors(variants, posteriors, rewards, CONFIG);
    }

    const mass = (posteriors[0]?.alpha ?? 0) + (posteriors[0]?.beta ?? 0);

    // The documented cap is evidence_per_cycle / (1 - gamma) — 1,000 / 0.02 = 50,000.
    // Five hundred cycles of unbroken traffic is three weeks, and it must not exceed it.
    expect(mass).toBeLessThan(51_000);
    expect(mass).toBeGreaterThan(45_000);
  });

  it('never lets a posterior parameter go negative', () => {
    // A reward exceeding its own impression count would hand beta a negative increment,
    // and a Beta with a negative parameter is not a distribution — it is a crash three
    // layers away with nothing pointing back here.
    const impossible: VariantReward = {
      surfaceId: 's',
      variantId: 's#a',
      components: {
        impressions: 10,
        signups: 10,
        engagedSessions: 10,
        scrollNormSum: 10,
        returns: 10,
        shares: 10,
        bounces: 0,
      },
    };

    const [posterior] = advancePosteriors([variantOf('s', 's#a')], [], [impossible], CONFIG);

    expect(posterior?.alpha).toBeGreaterThan(0);
    expect(posterior?.beta).toBeGreaterThan(0);
  });
});

describe('decideAdaptations', () => {
  const loser: StoredPosterior = {
    surfaceId: 's',
    variantId: 's#loser',
    alpha: 21,
    beta: 4_981,
    impressions: 5_000,
  };
  const leader: StoredPosterior = {
    surfaceId: 's',
    variantId: 's#leader',
    alpha: 1_501,
    beta: 3_501,
    impressions: 5_000,
  };

  it('retires a variant the evidence has settled against', () => {
    const records = decideAdaptations(
      [variantOf('s', 's#leader'), variantOf('s', 's#loser')],
      [leader, loser],
      [],
      CONFIG,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe('retire');
    expect(records[0]?.variantId).toBe('s#loser');
    expect(records[0]?.reason).toContain('probability of being worse');
    expect(records[0]?.stats['probabilityWorseThanLeader']).toBeGreaterThan(0.9);
  });

  it('never retires the baseline', () => {
    // There would be nothing left to fall back to, and the holdout cohort is pinned to
    // it — retiring it would take the measurement down with the variant.
    const records = decideAdaptations(
      [variantOf('s', 's#leader'), variantOf('s', 's#loser', true)],
      [leader, loser],
      [],
      CONFIG,
    );

    expect(records).toHaveLength(0);
  });

  it('never retires the leader', () => {
    const records = decideAdaptations(
      [variantOf('s', 's#leader'), variantOf('s', 's#loser')],
      [leader, loser],
      [],
      CONFIG,
    );

    expect(records.every((r) => r.variantId !== 's#leader')).toBe(true);
  });

  it('leaves a surface with one variant alone', () => {
    const records = decideAdaptations([variantOf('s', 's#only')], [leader], [], CONFIG);

    expect(records).toHaveLength(0);
  });

  it('waits for enough evidence before retiring anything', () => {
    const thin = { ...loser, impressions: 40, alpha: 1.2, beta: 40 };
    const thinLeader = { ...leader, impressions: 40, alpha: 13, beta: 28 };

    const records = decideAdaptations(
      [variantOf('s', 's#leader'), variantOf('s', 's#loser')],
      [thinLeader, thin],
      [],
      CONFIG,
    );

    expect(records).toHaveLength(0);
  });

  it('quarantines a variant that is harming the experience, ahead of the reward test', () => {
    // The separation that matters: a variant can convert well in the window before
    // anyone notices it has wrecked LCP, and the reward would happily keep it.
    const harmful: VariantHealth = {
      surfaceId: 's',
      variantId: 's#loser',
      samples: 5_000,
      p75LcpMs: 6_000,
      p75Cls: 0.01,
      p75InpMs: 90,
      clientErrorRate: 0,
      bounceRate: 0.2,
    };

    const records = decideAdaptations(
      [variantOf('s', 's#leader'), variantOf('s', 's#loser')],
      [leader, loser],
      [harmful],
      CONFIG,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe('quarantine');
    expect(records[0]?.reason).toContain('LCP');
  });

  it('does not read a missing health sample as a clean bill of health', () => {
    // A variant with no vitals rows has not been shown to be safe; it has not been
    // measured. The retirement path still applies, and the health path simply has
    // nothing to say — which is different from saying it is fine.
    const records = decideAdaptations(
      [variantOf('s', 's#leader'), variantOf('s', 's#loser')],
      [leader, loser],
      [],
      CONFIG,
    );

    expect(records[0]?.action).toBe('retire');
  });
});

describe('explorationRateOf', () => {
  const leader: StoredPosterior = {
    surfaceId: 's',
    variantId: 's#leader',
    alpha: 400,
    beta: 600,
    impressions: 1_000,
  };
  const challenger: StoredPosterior = {
    surfaceId: 's',
    variantId: 's#other',
    alpha: 100,
    beta: 900,
    impressions: 1_000,
  };

  it('measures the share of traffic that did not go to the leader', () => {
    const rate = explorationRateOf(
      [leader, challenger],
      [rewardOf('s', 's#leader', 900, 0.1), rewardOf('s', 's#other', 100, 0.1)],
    );

    expect(rate).toBeCloseTo(0.1, 6);
  });

  it('reports nothing rather than zero when no contested surface saw traffic', () => {
    // The distinction the alert depends on. A quiet night has not measured an exploration
    // rate of zero — it has not measured one — and reporting zero would fire
    // ExplorationCollapsed every night until somebody stopped reading the alerts.
    expect(explorationRateOf([leader, challenger], [])).toBeNull();
  });

  it('ignores surfaces with nothing to explore', () => {
    // A surface reduced to one variant has no exploration to do. Counting its traffic as
    // exploitation would drag the measured rate down every time a variant was retired —
    // making a healthy retirement look like a collapsing bandit.
    const only: StoredPosterior = {
      surfaceId: 'solo',
      variantId: 'solo#a',
      alpha: 2,
      beta: 2,
      impressions: 50_000,
    };

    const rate = explorationRateOf(
      [leader, challenger, only],
      [
        rewardOf('s', 's#leader', 900, 0.1),
        rewardOf('s', 's#other', 100, 0.1),
        rewardOf('solo', 'solo#a', 50_000, 0.1),
      ],
    );

    expect(rate).toBeCloseTo(0.1, 6);
  });

  it('counts a variant with no reward row as having had no traffic', () => {
    const rate = explorationRateOf([leader, challenger], [rewardOf('s', 's#leader', 500, 0.1)]);

    expect(rate).toBe(0);
  });
});

describe('buildSnapshot', () => {
  const posteriors: readonly StoredPosterior[] = [
    { surfaceId: 's', variantId: 's#a', alpha: 2, beta: 2, impressions: 10 },
    { surfaceId: 's', variantId: 's#b', alpha: 3, beta: 2, impressions: 10 },
  ];

  it('drops what the guardrails just removed', () => {
    // Removed here rather than left for the renderer, so a variant the guardrails took
    // out cannot be served in the window before the next cycle.
    const removed: readonly AdaptationRecord[] = [
      { action: 'retire', surfaceId: 's', variantId: 's#b', reason: 'x', stats: {} },
    ];

    const snapshot = buildSnapshot(posteriors, removed, 1_000, true);

    expect(snapshot.arms['s']).toHaveLength(1);
    expect(snapshot.arms['s']?.[0]?.variantId).toBe('s#a');
  });

  it('carries the kill switch through to the renderer', () => {
    const snapshot = buildSnapshot(posteriors, [], 1_000, false);

    expect(snapshot.adaptationEnabled).toBe(false);
    // Still populated: the site keeps learning while it serves baselines, so turning
    // adaptation back on does not face a system that forgot the intervening days.
    expect(snapshot.arms['s']).toHaveLength(2);
  });
});

describe('targetHour', () => {
  it('takes the hour that has finished, never the one in progress', () => {
    const now = 1_700_000_000_000;
    const target = targetHour(now);

    expect(target % HOUR).toBe(0);
    expect(target).toBeLessThan(Math.floor(now / HOUR) * HOUR);
  });
});

describe('runAdapt', () => {
  function harness(overrides: {
    variants?: readonly ActiveVariant[];
    state?: PosteriorState;
    rewards?: readonly VariantReward[];
    adaptationEnabled?: boolean;
  }) {
    const written: { hour: number; posteriors: readonly StoredPosterior[] }[] = [];
    const applied: readonly AdaptationRecord[][] = [];
    const published: unknown[] = [];

    const store: AdaptRepository = {
      activeVariants: () => Promise.resolve(overrides.variants ?? [variantOf('s', 's#a')]),
      posteriorState: () =>
        Promise.resolve(overrides.state ?? { throughHour: null, posteriors: [] }),
      rewardVersion: () => Promise.resolve(7),
      writePosteriors: (hour, posteriors) => {
        written.push({ hour, posteriors });
        return Promise.resolve();
      },
      applyDecisions: (records) => {
        (applied as AdaptationRecord[][]).push([...records]);
        return Promise.resolve();
      },
    };

    const rewards: RewardRepository = {
      rewards: () => Promise.resolve(overrides.rewards ?? []),
      health: () => Promise.resolve([]),
    };

    const publisher: SnapshotPublisher = {
      publish: (snapshot) => {
        published.push(snapshot);
        return Promise.resolve();
      },
    };

    return {
      written,
      applied,
      published,
      deps: {
        rewards,
        store,
        publisher,
        config: CONFIG,
        adaptationEnabled: overrides.adaptationEnabled ?? true,
        now: () => 1_700_000_000_000,
        log: silent,
      },
    };
  }

  it('folds an hour in and publishes the result', async () => {
    const h = harness({ rewards: [rewardOf('s', 's#a', 500, 0.2)] });

    const outcome = await runAdapt(h.deps, {});

    expect(outcome.kind).toBe('applied');
    expect(h.written).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });

  it('refuses to fold the same hour in twice', async () => {
    // The failure this prevents is silent: the posteriors simply become more confident
    // than the data warrants, which looks like unusually strong evidence rather than
    // like a bug, and every decision downstream inherits it.
    const hour = targetHour(1_700_000_000_000);
    const h = harness({ state: { throughHour: hour, posteriors: [] } });

    const outcome = await runAdapt(h.deps, {});

    expect(outcome.kind).toBe('already_applied');
    expect(h.written).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });

  it('writes the durable record before publishing', async () => {
    // If the process dies between the two, the next cycle continues from the record and
    // the site serves a snapshot one hour stale — a smaller wrong than a double-applied
    // cycle, which cannot be undone.
    const order: string[] = [];
    const h = harness({});
    const deps = {
      ...h.deps,
      store: {
        ...h.deps.store,
        writePosteriors: () => {
          order.push('write');
          return Promise.resolve();
        },
      },
      publisher: {
        publish: () => {
          order.push('publish');
          return Promise.resolve();
        },
      },
    };

    await runAdapt(deps, {});

    expect(order).toEqual(['write', 'publish']);
  });

  it('keeps measuring while adaptation is switched off', async () => {
    const h = harness({ adaptationEnabled: false, rewards: [rewardOf('s', 's#a', 500, 0.2)] });

    await runAdapt(h.deps, {});

    expect(h.written).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ adaptationEnabled: false });
  });

  it('reports an empty variant pool rather than failing', async () => {
    const h = harness({ variants: [] });

    expect((await runAdapt(h.deps, {})).kind).toBe('no_variants');
    expect(h.written).toHaveLength(0);
  });

  it('takes an explicit hour when one is given, for replaying a missed cycle', async () => {
    const h = harness({});

    const outcome = await runAdapt(h.deps, { hourStart: 1_600_000_000_000 });

    expect(outcome).toMatchObject({ kind: 'applied', hour: 1_600_000_000_000 });
    expect(h.written[0]?.hour).toBe(1_600_000_000_000);
  });
});
