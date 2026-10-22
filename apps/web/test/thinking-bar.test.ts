/**
 * The thinking bar, and the two claims it makes.
 *
 * First, that the figure on the page is the figure the engine produced — not a rounded
 * approximation of it, not a nicer one. Second, that the bandit cannot reach it. The
 * second is the one worth guarding hardest: an optimiser handed control of its own
 * scorecard optimises the scorecard, and that failure would be invisible from the outside
 * because the bar would keep looking excellent.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Arm, Sophistication } from '@morph/adaptive';
import { SURFACE_KEYS } from '@morph/core';
import { ThinkingBar } from '../src/components/thinking-bar';
import { siteSophistication } from '../src/lib/sophistication';
import type { PosteriorSnapshot } from '../src/lib/assignment';

function arms(separated: boolean, impressions = 40_000): readonly Arm[] {
  return [
    { variantId: 'a', alpha: 2_401, beta: 5_601, impressions },
    {
      variantId: 'b',
      alpha: separated ? 801 : 2_399,
      beta: separated ? 7_201 : 5_603,
      impressions,
    },
  ];
}

function snapshotOf(
  entries: Readonly<Record<string, readonly Arm[]>>,
  generatedAt: number,
): PosteriorSnapshot {
  return { arms: entries, adaptationEnabled: true, generatedAt };
}

const render = (reading: Sophistication): string =>
  renderToStaticMarkup(createElement(ThinkingBar, { reading }));

describe('siteSophistication', () => {
  it('counts every registered surface, including the ones with no data', () => {
    // Breadth is the fraction of the site under optimisation. If absent surfaces were
    // skipped, a site optimising one surface out of eleven would report a perfect score
    // on that term — the denominator has to be what the site could be optimising.
    const reading = siteSophistication(snapshotOf({ 'hero.headline': arms(true) }, 1_000), 1_000);

    expect(reading.surfacesTotal).toBe(SURFACE_KEYS.length);
    expect(reading.surfacesOptimising).toBe(1);
    expect(reading.components.breadth).toBeCloseTo(1 / SURFACE_KEYS.length, 10);
  });

  it('treats a never-published snapshot as unknown age, not as infinitely stale', () => {
    // `generatedAt: 0` is the placeholder the renderer ships with until the worker starts
    // publishing. A new site is new, not neglected, and the reading is zero anyway on the
    // terms that matter — inventing a staleness penalty on top would explain the same
    // number worse.
    const reading = siteSophistication(snapshotOf({}, 0), 1_700_000_000_000);

    expect(reading.components.freshness).toBeNull();
    expect(reading.level).toBe(0);
    expect(reading.label).toBe('cold start');
  });

  it('measures age from the snapshot stamp', () => {
    const stamped = 1_700_000_000_000;
    const fresh = siteSophistication(snapshotOf({ 'hero.headline': arms(true) }, stamped), stamped);
    const old = siteSophistication(
      snapshotOf({ 'hero.headline': arms(true) }, stamped),
      stamped + 12 * 60 * 60 * 1000,
    );

    expect(fresh.components.freshness).toBe(1);
    expect(old.components.freshness).toBe(0);
    expect(old.level).toBeLessThan(fresh.level);
  });

  it('survives a snapshot stamped in the future', () => {
    // Clock skew between the worker that stamped it and the renderer reading it is
    // ordinary in a cluster, and a negative age must not become a level above one.
    const stamped = 1_700_000_000_000;
    const reading = siteSophistication(
      snapshotOf({ 'hero.headline': arms(true) }, stamped + 60_000),
      stamped,
    );

    expect(reading.components.freshness).toBe(1);
    expect(reading.level).toBeLessThanOrEqual(1);
  });
});

describe('the bandit cannot reach the bar', () => {
  it('has no entry in the surface registry', () => {
    // The assertion the whole design rests on. If someone ever registers this as a
    // surface — to "test which framing converts better" — the number stops being a
    // measurement and becomes an output of the thing it is measuring.
    for (const key of SURFACE_KEYS) {
      expect(key).not.toMatch(/thinking|sophistication|knowledge/i);
    }
  });
});

describe('ThinkingBar markup', () => {
  it('prints the level the engine reported', () => {
    const reading = siteSophistication(
      snapshotOf({ 'hero.headline': arms(true), 'cta.copy': arms(true) }, 1_000),
      1_000,
    );
    const html = render(reading);
    const shown = Math.round(reading.level * 100);

    expect(html).toContain(`<strong>${String(shown)}%</strong>`);
    expect(html).toContain(reading.label);
    expect(html).toContain(`${String(shown)}%"`);
  });

  it('carries the engine’s own explanation, verbatim', () => {
    const reading = siteSophistication(snapshotOf({}, 1_000), 1_000);

    // Not a rewritten, friendlier version. The sentence on the page is the sentence the
    // engine produced, so a reader comparing them finds no gap.
    expect(render(reading)).toContain(reading.reason);
  });

  it('offers somewhere to check the number', () => {
    // A site claiming to rewrite itself and offering nowhere to verify is asking to be
    // taken on faith, which is the one thing this product cannot ask for. A reader who
    // has just met a number they did not expect is exactly the one who will follow it.
    const reading = siteSophistication(snapshotOf({}, 1_000), 1_000);

    expect(render(reading)).toContain('href="/proof"');
  });

  it('exposes a meter rather than a progressbar', () => {
    // A progressbar promises a task that finishes. This moves in both directions.
    const reading = siteSophistication(snapshotOf({ 'hero.headline': arms(true) }, 1_000), 1_000);
    const html = render(reading);

    expect(html).toContain('role="meter"');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain(`aria-valuenow="${String(Math.round(reading.level * 100))}"`);
    expect(html).toContain('aria-valuemax="100"');
  });

  it('shows a dash, not a zero, for a component that could not be measured', () => {
    // The difference between "this is bad" and "this is unknown". Collapsing the two is
    // how a dashboard starts lying.
    const html = render(siteSophistication(snapshotOf({}, 0), 5_000));

    expect(html).toContain('—');
    expect(html).toContain('not measurable right now');
  });

  it('needs no JavaScript to be correct', () => {
    // Same standard as the consent gate: a visitor with scripts blocked sees the real
    // number, and so does every crawler and answer engine that will never run one.
    const html = render(siteSophistication(snapshotOf({ 'cta.copy': arms(true) }, 1_000), 1_000));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
  });

  it('reports the observation count it was given', () => {
    const reading = siteSophistication(
      snapshotOf({ 'hero.headline': arms(true, 12_345) }, 1_000),
      1_000,
    );

    expect(reading.observations).toBe(24_690);
    expect(render(reading)).toContain('24,690');
  });
});
