/**
 * The two joints that have no compiler behind them.
 *
 * Most of this app is adapters over typed ports, and the types carry them. Two things are
 * not covered by any type, and both fail silently and totally:
 *
 *   1. The snapshot key is a string duplicated between this app and `apps/web`, because apps
 *      may not import each other. Diverge them and the renderer reads a key nobody writes,
 *      resolves every surface to its baseline, and reports a snapshot age of zero — which
 *      the thinking bar shows as "cold start". A brand new site and a totally broken one
 *      look identical.
 *
 *   2. The rewards adapter sums across context buckets and drops the holdout. Both are the
 *      port's contract, neither is expressible in its types, and getting the second wrong
 *      would fold the control group into the treatment's evidence — measuring the
 *      adaptation against itself and reporting a lift of roughly zero for ever.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SURFACE_KEYS } from '@morph/core';
import { SNAPSHOT_KEY, kvSnapshotPublisher } from '../src/adapters/snapshot.js';
import { cloudflareRewards, type CounterReader } from '../src/adapters/rewards.js';
import { sqlNumber } from '../src/analytics.js';

const WEB_SNAPSHOT = join(import.meta.dirname, '..', '..', 'web', 'src', 'lib', 'snapshot.ts');

describe('the snapshot key', () => {
  it('matches the one the renderer reads', () => {
    // Read out of the renderer's source rather than imported, because an app may not import
    // another app — which is exactly why the duplication exists and exactly why it needs a
    // test instead of a type.
    const source = readFileSync(WEB_SNAPSHOT, 'utf8');
    const match = /const SNAPSHOT_KEY = '([^']+)'/.exec(source);

    expect(
      match,
      'apps/web/src/lib/snapshot.ts no longer declares SNAPSHOT_KEY the same way',
    ).not.toBeNull();
    expect(match?.[1]).toBe(SNAPSHOT_KEY);
  });

  it('publishes under it', async () => {
    const written = new Map<string, string>();
    const publisher = kvSnapshotPublisher({
      put: (key, value) => {
        written.set(key, value);
        return Promise.resolve();
      },
    });

    await publisher.publish({ arms: {}, adaptationEnabled: true, generatedAt: 1234 });

    expect([...written.keys()]).toEqual([SNAPSHOT_KEY]);
    expect(JSON.parse(written.get(SNAPSHOT_KEY) ?? '{}')).toEqual({
      arms: {},
      adaptationEnabled: true,
      generatedAt: 1234,
    });
  });

  it('does not expire, because a late cron must not un-adapt the site', async () => {
    // An expiring key would fall back to baselines exactly when the adaptation matters most
    // — the renderer handles staleness itself and shows the age on the page.
    // `SnapshotWriter` takes only a key and a value, so a TTL is now unexpressible rather
    // than merely unused — which is a better guarantee than this test could give. What is
    // left to check is that nothing smuggles one in as a third argument.
    const calls: number[] = [];
    const publisher = kvSnapshotPublisher({
      put: (...args) => {
        calls.push(args.length);
        return Promise.resolve();
      },
    });

    await publisher.publish({ arms: {}, adaptationEnabled: true, generatedAt: 1 });

    expect(calls).toEqual([2]);
  });
});

describe('the rewards adapter', () => {
  const HOUR = 1_780_000_000_000 - (1_780_000_000_000 % 3_600_000);

  type Row = Awaited<ReturnType<ReturnType<CounterReader['get']>['countersBetween']>>[number];

  /** A reader that answers for one surface and returns nothing for the others. */
  function readerFor(surfaceId: string, rows: readonly Row[]): CounterReader {
    return {
      idFromName: (name) => ({ toString: () => name, equals: (o) => o.toString() === name }),
      get: (id) => ({
        countersBetween: () => Promise.resolve(String(id) === surfaceId ? rows : []),
      }),
    };
  }

  function row(over: Partial<Row> = {}): Row {
    return {
      variantId: 'v0',
      isHoldout: false,
      impressions: 1,
      signups: 0,
      engagedSessions: 0,
      scrollNormSum: 0,
      returns: 0,
      shares: 0,
      bounces: 0,
      ...over,
    };
  }

  const analytics = { accountId: 'acct', apiToken: 'token' };

  it('sums across context buckets, because Thompson wants one posterior per variant', async () => {
    // Splitting the Beta posteriors by context as well would divide the evidence into cells
    // too thin to sample from — the note on `context_bucket` in `002_aggregates.sql`, and D29.
    const surfaceId = SURFACE_KEYS[0] ?? 'hero.headline';
    const repo = cloudflareRewards(
      readerFor(surfaceId, [
        row({ impressions: 3, signups: 1 }),
        row({ impressions: 4, signups: 2 }),
      ]),
      analytics,
      'morph_events',
    );

    const rewards = await repo.rewards(HOUR);
    const mine = rewards.filter((r) => r.surfaceId === surfaceId);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.components.impressions).toBe(7);
    expect(mine[0]?.components.signups).toBe(3);
  });

  it('excludes the holdout, which is the control group', async () => {
    // Folding it into the adaptive cohort's evidence would mean measuring the adaptation
    // against itself — and the holdout lift, the one number that says whether any of this
    // works, would sit at zero no matter what the engine did.
    const surfaceId = SURFACE_KEYS[0] ?? 'hero.headline';
    const repo = cloudflareRewards(
      readerFor(surfaceId, [row({ impressions: 5 }), row({ impressions: 100, isHoldout: true })]),
      analytics,
      'morph_events',
    );

    const mine = (await repo.rewards(HOUR)).filter((r) => r.surfaceId === surfaceId);

    expect(mine[0]?.components.impressions).toBe(5);
  });

  it('keeps variants apart', async () => {
    const surfaceId = SURFACE_KEYS[0] ?? 'hero.headline';
    const repo = cloudflareRewards(
      readerFor(surfaceId, [
        row({ variantId: 'a', impressions: 1 }),
        row({ variantId: 'b', impressions: 2 }),
      ]),
      analytics,
      'morph_events',
    );

    const mine = (await repo.rewards(HOUR)).filter((r) => r.surfaceId === surfaceId);

    expect(mine).toHaveLength(2);
    expect(mine.map((r) => r.variantId).sort()).toEqual(['a', 'b']);
  });

  it('asks every surface, not just the ones with traffic', async () => {
    // A surface the cycle never hears about keeps its old posterior for ever, which looks
    // like a variant nobody is testing rather than a surface nobody is reading.
    const asked: string[] = [];
    const repo = cloudflareRewards(
      {
        idFromName: (name) => {
          asked.push(name);
          return { toString: () => name, equals: () => false };
        },
        get: () => ({ countersBetween: () => Promise.resolve([]) }),
      },
      analytics,
      'morph_events',
    );

    await repo.rewards(HOUR);

    expect(asked.sort()).toEqual([...SURFACE_KEYS].sort());
  });
});

describe('sqlNumber', () => {
  it('is the only way a value reaches a query', () => {
    // The SQL API has no parameter binding, so this is the boundary. Truncating rather than
    // rounding keeps an hour start an hour start.
    expect(sqlNumber(1_780_000_000)).toBe('1780000000');
    expect(sqlNumber(12.9)).toBe('12');
  });

  it('refuses a non-finite number rather than interpolating "NaN"', () => {
    // `NaN` in a WHERE clause is a query that silently matches nothing, which reads as an
    // hour with no traffic.
    expect(() => sqlNumber(Number.NaN)).toThrow(RangeError);
    expect(() => sqlNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
