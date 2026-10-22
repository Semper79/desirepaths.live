import { describe, expect, it } from 'vitest';
import {
  acceleration,
  audienceFit,
  DEFAULT_WEIGHTS,
  DURABILITY_REFERENCE_HOURS,
  durability,
  momentum,
  PUBLISH_THRESHOLD,
  rank,
  saturation,
  SATURATION_REFERENCE_SOURCES,
  scoreTopic,
  velocity,
  type TopicHistory,
} from '../src/score';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const history = (overrides: Partial<TopicHistory> = {}): TopicHistory => ({
  hourlyMentions: [1, 1, 1, 1, 1, 1],
  distinctSources: 5,
  firstSeenAt: NOW - 6 * HOUR,
  ...overrides,
});

describe('velocity', () => {
  it('rises with the mention rate and saturates below 1', () => {
    const quiet = velocity(history({ hourlyMentions: [1, 1, 1] }));
    const busy = velocity(history({ hourlyMentions: [50, 50, 50] }));

    expect(busy).toBeGreaterThan(quiet);
    expect(busy).toBeLessThan(1);
  });

  it('is 0 for a topic with no mentions', () => {
    expect(velocity(history({ hourlyMentions: [] }))).toBe(0);
    expect(velocity(history({ hourlyMentions: [0, 0, 0] }))).toBe(0);
  });

  it('only looks at the recent window', () => {
    const spikeThenSilence = history({ hourlyMentions: [500, 500, 0, 0, 0, 0, 0, 0] });
    expect(velocity(spikeThenSilence, 6)).toBe(0);
  });
});

describe('acceleration', () => {
  it('is positive while a topic is rising', () => {
    expect(acceleration(history({ hourlyMentions: [1, 1, 1, 10, 10, 10] }))).toBeGreaterThan(0);
  });

  it('is negative while a topic is fading', () => {
    expect(acceleration(history({ hourlyMentions: [10, 10, 10, 1, 1, 1] }))).toBeLessThan(0);
  });

  it('is 0 for a flat topic', () => {
    expect(acceleration(history({ hourlyMentions: [5, 5, 5, 5] }))).toBe(0);
  });

  /**
   * Zero-to-something is the case this signal most needs to handle, and the one a naive
   * ratio would crash on.
   */
  it('handles a topic appearing from nothing', () => {
    expect(acceleration(history({ hourlyMentions: [0, 0, 8, 8] }))).toBe(1);
  });

  it('is 0 when there is nothing to compare', () => {
    expect(acceleration(history({ hourlyMentions: [] }))).toBe(0);
    expect(acceleration(history({ hourlyMentions: [3] }))).toBe(0);
    expect(acceleration(history({ hourlyMentions: [0, 0, 0, 0] }))).toBe(0);
  });

  it('is bounded', () => {
    expect(acceleration(history({ hourlyMentions: [0, 0, 900, 900] }))).toBeLessThanOrEqual(1);
    expect(acceleration(history({ hourlyMentions: [900, 900, 0, 0] }))).toBeGreaterThanOrEqual(-1);
  });
});

describe('momentum', () => {
  it('prefers a rising topic to a falling one at the same volume', () => {
    const rising = momentum(history({ hourlyMentions: [4, 4, 4, 20, 20, 20] }));
    const falling = momentum(history({ hourlyMentions: [20, 20, 20, 4, 4, 4] }));

    expect(rising).toBeGreaterThan(falling);
  });

  /**
   * The guard that stops a topic going from one mention to two from outscoring a topic
   * with real volume purely on the strength of its acceleration.
   */
  it('does not let acceleration promote a topic nobody is discussing', () => {
    const tiny = momentum(history({ hourlyMentions: [0, 0, 1, 2] }));
    const substantial = momentum(history({ hourlyMentions: [30, 30, 30, 30] }));

    expect(tiny).toBeLessThan(substantial);
  });

  it('stays inside [0, 1]', () => {
    expect(momentum(history({ hourlyMentions: [0, 0, 9_999, 9_999] }))).toBeLessThanOrEqual(1);
    expect(momentum(history({ hourlyMentions: [9_999, 9_999, 0, 0] }))).toBeGreaterThanOrEqual(0);
  });
});

describe('audience fit', () => {
  it('passes a positive similarity through', () => {
    expect(audienceFit(0.7)).toBe(0.7);
  });

  it('treats a negative fit as no fit', () => {
    expect(audienceFit(-0.9)).toBe(0);
  });

  it('clamps above 1, in case a caller passes an unnormalised score', () => {
    expect(audienceFit(1.4)).toBe(1);
  });
});

describe('saturation', () => {
  it('is high when few outlets have covered it', () => {
    expect(saturation(1)).toBeGreaterThan(0.9);
  });

  it('falls as coverage grows', () => {
    expect(saturation(100)).toBeLessThan(saturation(10));
  });

  it('is exactly half at the reference point', () => {
    expect(saturation(SATURATION_REFERENCE_SOURCES)).toBeCloseTo(0.5);
  });

  it('is 1 when nothing has covered it', () => {
    expect(saturation(0)).toBe(1);
  });

  it('treats a negative count as zero rather than producing nonsense', () => {
    expect(saturation(-5)).toBe(1);
  });
});

describe('durability', () => {
  it('grows with age and saturates', () => {
    const young = durability(history({ firstSeenAt: NOW - HOUR }), NOW);
    const old = durability(history({ firstSeenAt: NOW - 1000 * HOUR }), NOW);

    expect(old).toBeGreaterThan(young);
    expect(old).toBeLessThan(1);
  });

  it('is half at the reference age', () => {
    const at72 = durability(history({ firstSeenAt: NOW - DURABILITY_REFERENCE_HOURS * HOUR }), NOW);
    expect(at72).toBeCloseTo(0.5);
  });

  it('is 0 for a topic first seen right now', () => {
    expect(durability(history({ firstSeenAt: NOW }), NOW)).toBe(0);
  });

  it('treats a future timestamp as age zero rather than a negative score', () => {
    expect(durability(history({ firstSeenAt: NOW + HOUR }), NOW)).toBe(0);
  });
});

describe('the composite score', () => {
  it('reports every component alongside the total', () => {
    const score = scoreTopic(history(), 0.5, NOW);

    expect(Object.keys(score.components).sort()).toEqual([
      'audienceFit',
      'durability',
      'momentum',
      'saturation',
    ]);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(1);
  });

  it('scores a rising, uncrowded, well-fitting topic highly', () => {
    const strong = scoreTopic(
      history({
        hourlyMentions: [5, 5, 5, 40, 45, 50],
        distinctSources: 3,
        firstSeenAt: NOW - 200 * HOUR,
      }),
      0.9,
      NOW,
    );

    expect(strong.total).toBeGreaterThan(PUBLISH_THRESHOLD);
  });

  it('scores a quiet, crowded, ill-fitting topic low', () => {
    const weak = scoreTopic(
      history({ hourlyMentions: [0, 0, 0, 0], distinctSources: 400, firstSeenAt: NOW }),
      -0.2,
      NOW,
    );

    expect(weak.total).toBeLessThan(PUBLISH_THRESHOLD);
  });

  it('respects weights it is given', () => {
    const topic = history({ hourlyMentions: [50, 50, 50, 50], distinctSources: 400 });

    const momentumOnly = scoreTopic(topic, 0, NOW, {
      momentum: 1,
      audienceFit: 0,
      saturation: 0,
      durability: 0,
    });
    const saturationOnly = scoreTopic(topic, 0, NOW, {
      momentum: 0,
      audienceFit: 0,
      saturation: 1,
      durability: 0,
    });

    expect(momentumOnly.total).toBeGreaterThan(saturationOnly.total);
  });

  it('returns 0 rather than NaN when every weight is zero', () => {
    const score = scoreTopic(history(), 0.5, NOW, {
      momentum: 0,
      audienceFit: 0,
      saturation: 0,
      durability: 0,
    });

    expect(score.total).toBe(0);
  });

  it('weights sum to one by default, so the total reads as a fraction', () => {
    const sum =
      DEFAULT_WEIGHTS.momentum +
      DEFAULT_WEIGHTS.audienceFit +
      DEFAULT_WEIGHTS.saturation +
      DEFAULT_WEIGHTS.durability;
    expect(sum).toBeCloseTo(1);
  });
});

describe('the rationale', () => {
  it('says when a topic is rising and lightly covered', () => {
    const score = scoreTopic(
      history({ hourlyMentions: [5, 5, 60, 70, 80, 90], distinctSources: 2 }),
      0.8,
      NOW,
    );

    expect(score.rationale).toContain('rising fast');
    expect(score.rationale).toContain('lightly covered');
    expect(score.rationale).toContain('close to what readers engage with');
  });

  it('says when a topic is quiet, crowded and off-target', () => {
    const score = scoreTopic(
      history({ hourlyMentions: [0, 0, 0, 0], distinctSources: 500 }),
      0.05,
      NOW,
    );

    expect(score.rationale).toContain('quiet');
    expect(score.rationale).toContain('already crowded');
    expect(score.rationale).toContain('far from the usual audience');
  });

  it('describes the middle ground without overclaiming', () => {
    const score = scoreTopic(
      history({ hourlyMentions: [8, 8, 8, 8], distinctSources: 30 }),
      0.45,
      NOW,
    );
    expect(score.rationale).toContain('building');
  });

  it('mentions sustained topics', () => {
    const score = scoreTopic(history({ firstSeenAt: NOW - 500 * HOUR }), 0.5, NOW);
    expect(score.rationale).toContain('sustained for days');
  });
});

describe('ranking', () => {
  const topic = (
    id: string,
    total: number,
  ): { id: string; score: ReturnType<typeof scoreTopic> } => ({
    id,
    score: {
      total,
      components: { momentum: 0, audienceFit: 0, saturation: 0, durability: 0 },
      rationale: '',
    },
  });

  it('orders by score and applies the limit', () => {
    const ranked = rank([topic('a', 0.6), topic('b', 0.9), topic('c', 0.7)], 2);
    expect(ranked.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('drops everything below the publish threshold', () => {
    expect(rank([topic('a', PUBLISH_THRESHOLD - 0.01)], 10)).toEqual([]);
    expect(rank([topic('a', PUBLISH_THRESHOLD)], 10)).toHaveLength(1);
  });

  /**
   * A re-run of the pipeline must not silently reshuffle the queue.
   */
  it('breaks ties deterministically', () => {
    const ranked = rank([topic('z', 0.8), topic('a', 0.8)], 2);
    expect(ranked.map((t) => t.id)).toEqual(['a', 'z']);
  });

  it('handles a limit of zero or less', () => {
    expect(rank([topic('a', 0.9)], 0)).toEqual([]);
    expect(rank([topic('a', 0.9)], -3)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const topics = [topic('a', 0.6), topic('b', 0.9)];
    rank(topics, 2);
    expect(topics.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
