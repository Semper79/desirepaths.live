/**
 * The reading shown on the home page.
 *
 * The tests that matter here are not the arithmetic ones. They are the ones asserting the
 * number can go *down*, that it cannot be inflated by removing variants, and that an
 * unmeasurable component is dropped rather than guessed — because this is the one number
 * in the system a stranger will judge the whole product by, and a bar that only climbs is
 * a progress animation.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOPHISTICATION_CONFIG,
  type Arm,
  type SophisticationConfig,
  type SurfaceEvidence,
  labelFor,
  sophistication,
} from '../src/index';

/**
 * Posterior mass, held apart from the impression count on purpose.
 *
 * `Arm.impressions` is the raw count; `alpha`/`beta` are the posterior *after* exponential
 * forgetting has pulled it back towards the prior. They are decoupled by construction —
 * forgetting caps the pseudo-count at roughly `observations_per_cycle / (1 - gamma)` while
 * impressions keep accumulating — so fixtures that tie one to the other describe a system
 * with the forgetting switched off, which is not the one being shipped.
 */
const POSTERIOR_MASS = 8_000;

/** A settled surface: the leader is clearly ahead, on however many impressions. */
function decided(key: string, impressions = 20_000): SurfaceEvidence {
  return {
    surfaceKey: key,
    arms: [
      {
        variantId: `${key}#a`,
        alpha: 1 + POSTERIOR_MASS * 0.3,
        beta: 1 + POSTERIOR_MASS * 0.7,
        impressions,
      },
      {
        variantId: `${key}#b`,
        alpha: 1 + POSTERIOR_MASS * 0.1,
        beta: 1 + POSTERIOR_MASS * 0.9,
        impressions,
      },
    ],
  };
}

/** A surface where the two arms are indistinguishable. */
function undecided(key: string, impressions = 20_000): SurfaceEvidence {
  const arm = (id: string): Arm => ({
    variantId: id,
    alpha: 1 + POSTERIOR_MASS * 0.2,
    beta: 1 + POSTERIOR_MASS * 0.8,
    impressions,
  });
  return { surfaceKey: key, arms: [arm(`${key}#a`), arm(`${key}#b`)] };
}

const FRESH = 60_000;

describe('sophistication', () => {
  it('reads zero when nothing has been measured', () => {
    const result = sophistication([decided('hero.headline', 0)], FRESH);

    expect(result.observations).toBe(0);
    expect(result.components.evidence).toBe(0);
    expect(result.label).toBe('cold start');
    expect(result.reason).toContain('No visits measured yet');
  });

  it('reads zero, and says why, when no surfaces are registered at all', () => {
    const result = sophistication([], FRESH);

    expect(result.level).toBe(0);
    expect(result.components.breadth).toBe(0);
    expect(result.components.certainty).toBe(0);
    expect(result.surfacesTotal).toBe(0);
    expect(result.reason).toContain('nothing to learn about');
  });

  it('rises with evidence, all else equal', () => {
    const small = sophistication([decided('a', 2_000)], FRESH);
    const large = sophistication([decided('a', 400_000)], FRESH);

    expect(large.level).toBeGreaterThan(small.level);
    expect(large.components.evidence).toBeGreaterThan(small.components.evidence);
  });

  it('goes down when evidence is lost', () => {
    // The property the whole thing rests on. A retirement, a rollback or a purge reduces
    // what the site knows, and the bar has to admit it.
    const before = sophistication([decided('a'), decided('b')], FRESH);
    const after = sophistication([decided('a'), decided('b', 200)], FRESH);

    expect(after.level).toBeLessThan(before.level);
  });

  it('scores a coin-flip surface at zero certainty rather than at fifty per cent', () => {
    // Two variants and no idea which is better is not "half sure". It is no knowledge,
    // and a bar reading 50% there would be flattering itself.
    const result = sophistication([undecided('a')], FRESH);

    expect(result.components.certainty).toBeLessThan(0.05);
  });

  it('cannot be inflated by deleting the competition', () => {
    // A single-arm surface has no question to answer, so it is excluded from certainty
    // rather than counted as certain. Otherwise the cheapest way to raise the reading
    // would be to remove variants, which is precisely backwards.
    const contested = sophistication([undecided('a')], FRESH);
    const stripped = sophistication(
      [
        {
          surfaceKey: 'a',
          arms: [{ variantId: 'a#a', alpha: 4_001, beta: 16_001, impressions: 20_000 }],
        },
      ],
      FRESH,
    );

    expect(stripped.components.certainty).toBe(0);
    expect(stripped.level).toBeLessThanOrEqual(contested.level);
  });

  it('counts only surfaces with enough evidence towards breadth', () => {
    const result = sophistication([decided('a', 20_000), decided('b', 50)], FRESH);

    expect(result.surfacesOptimising).toBe(1);
    expect(result.surfacesTotal).toBe(2);
    expect(result.components.breadth).toBe(0.5);
    expect(result.reason).toContain('1 of 2 surfaces');
  });

  it('collapses when the snapshot goes stale', () => {
    // Age zero on the fresh side, so the comparison is against an undecayed reading
    // rather than one already a hair below it.
    const fresh = sophistication([decided('a')], 0);
    const stale = sophistication([decided('a')], DEFAULT_SOPHISTICATION_CONFIG.staleAfterMs * 2);

    expect(stale.components.freshness).toBe(0);
    // Halved, not zeroed: old conclusions are suspect, not absent.
    expect(stale.level).toBeCloseTo(fresh.level * 0.5, 6);
    expect(stale.level).toBeLessThan(fresh.level);
    expect(stale.reason).toContain('stale');
  });

  it('drops the freshness term rather than guessing when the age is unknown', () => {
    // Passing null is a different statement from passing a large number, and the
    // difference has to survive into the components a reader can inspect.
    const unknown = sophistication([decided('a')], null);
    const known = sophistication([decided('a')], FRESH);

    expect(unknown.components.freshness).toBeNull();
    // Renormalised over the remaining three weights, so dropping a term the site would
    // have scored well on does not silently punish it.
    expect(unknown.level).toBeGreaterThan(0);
    expect(Math.abs(unknown.level - known.level)).toBeLessThan(0.2);
  });

  it('reports every component alongside the total', () => {
    const result = sophistication([decided('a'), decided('b')], FRESH);

    expect(result.components.evidence).toBeGreaterThan(0);
    expect(result.components.certainty).toBeGreaterThan(0);
    expect(result.components.breadth).toBe(1);
    expect(result.components.freshness).toBeGreaterThan(0);
    expect(result.level).toBeGreaterThan(0);
    expect(result.level).toBeLessThanOrEqual(1);
  });

  it('explains a run where evidence exists but no surface has enough of it', () => {
    const result = sophistication([decided('a', 200), decided('b', 300)], FRESH);

    expect(result.surfacesOptimising).toBe(0);
    expect(result.reason).toContain('none of them on a surface with enough evidence');
  });

  it('distinguishes a fully optimising site that is still contested from one that has settled', () => {
    const contested = sophistication([undecided('a'), undecided('b')], FRESH);
    const settled = sophistication([decided('a', 200_000), decided('b', 200_000)], 0);

    expect(contested.reason).toContain('still have credible challengers');
    expect(settled.reason).toContain('settled on a champion');
    expect(settled.level).toBeGreaterThan(contested.level);
  });

  it('stays inside the unit interval at the extremes', () => {
    // Evidence past the horizon and a negative age — a clock skew between the worker that
    // stamped the snapshot and the renderer reading it, which is ordinary in a cluster.
    const beyond = sophistication([decided('a', 4_000_000)], -1_000);

    expect(beyond.components.evidence).toBe(1);
    expect(beyond.components.freshness).toBe(1);
    expect(beyond.level).toBeLessThanOrEqual(1);
  });

  it('measures a surface far past what the incomplete beta could handle', () => {
    // This case used to be *dropped*. `probabilityGreater` threw above roughly half a
    // million pseudo-counts, so the reading degraded rather than crashed — conservative,
    // and the best available answer while the bug stood. D28 replaced that with a normal
    // approximation for the concentrated regime, so the surface is now measured.
    //
    // It matters at exactly the scale the system is designed for: forgetting caps the
    // pseudo-count at observations_per_cycle / (1 - gamma), which at the 5M events/day
    // target lands a busy surface right here.
    const extreme: SurfaceEvidence = {
      surfaceKey: 'a',
      arms: [
        { variantId: 'a#a', alpha: 3_000_001, beta: 7_000_001, impressions: 10_000_000 },
        { variantId: 'a#b', alpha: 3_100_001, beta: 6_900_001, impressions: 10_000_000 },
      ],
    };

    const result = sophistication([extreme], FRESH);

    // The leader is a full percentage point ahead on ten million impressions. That is not
    // a close contest, and the site is entitled to be certain about it.
    expect(result.components.certainty).toBeGreaterThan(0.99);
    expect(result.surfacesOptimising).toBe(1);
  });

  it('returns zero rather than dividing by zero when every weight is zero', () => {
    const config: SophisticationConfig = {
      ...DEFAULT_SOPHISTICATION_CONFIG,
      weights: { evidence: 0, certainty: 0, breadth: 0 },
    };

    expect(sophistication([decided('a')], null, config).level).toBe(0);
  });

  it('returns zero evidence when the config leaves no range to score across', () => {
    const config: SophisticationConfig = {
      ...DEFAULT_SOPHISTICATION_CONFIG,
      evidenceFloor: 1_000,
      evidenceHorizon: 100,
    };

    expect(sophistication([decided('a')], FRESH, config).components.evidence).toBe(0);
  });

  it('picks the leader regardless of the order the arms arrive in', () => {
    const ascending: SurfaceEvidence = {
      surfaceKey: 'a',
      arms: [
        { variantId: 'a#weak', alpha: 101, beta: 9_901, impressions: 10_000 },
        { variantId: 'a#strong', alpha: 3_001, beta: 7_001, impressions: 10_000 },
      ],
    };
    const descending: SurfaceEvidence = { surfaceKey: 'a', arms: [...ascending.arms].reverse() };

    expect(sophistication([ascending], FRESH).components.certainty).toBeCloseTo(
      sophistication([descending], FRESH).components.certainty,
      10,
    );
  });

  it('takes the strongest challenger, not the last one listed', () => {
    const surface: SurfaceEvidence = {
      surfaceKey: 'a',
      arms: [
        { variantId: 'a#leader', alpha: 2_001, beta: 8_001, impressions: 10_000 },
        { variantId: 'a#close', alpha: 1_951, beta: 8_051, impressions: 10_000 },
        { variantId: 'a#hopeless', alpha: 11, beta: 9_991, impressions: 10_000 },
      ],
    };

    // The hopeless arm is listed last; if it were the one measured, certainty would read
    // as near-total and the close challenger would be invisible.
    expect(sophistication([surface], FRESH).components.certainty).toBeLessThan(0.9);
  });
});

describe('labelFor', () => {
  it('names every band', () => {
    expect(labelFor(0)).toBe('cold start');
    expect(labelFor(0.1)).toBe('observing');
    expect(labelFor(0.3)).toBe('learning');
    expect(labelFor(0.5)).toBe('deciding');
    expect(labelFor(0.7)).toBe('confident');
    expect(labelFor(1)).toBe('converged');
  });

  it('never claims convergence below the top band', () => {
    // "Converged" is a strong claim to put in front of a stranger, and the bands are
    // uneven precisely so it is rare.
    expect(labelFor(0.849)).not.toBe('converged');
    expect(labelFor(0.85)).toBe('converged');
  });
});
