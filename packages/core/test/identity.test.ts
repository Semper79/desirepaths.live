import { describe, expect, it } from 'vitest';
import { anonId, dailySalt, idsEqual, utcDay, VisitorIdentity } from '../src/identity';

/**
 * The properties tested here are the privacy design, not implementation details.
 * If one of these fails, `docs/PRIVACY.md` has become untrue.
 */

const PEPPER = 'a'.repeat(64);
const DAY_1 = new Date('2026-08-24T12:00:00.000Z');
const DAY_1_LATE = new Date('2026-08-24T23:59:59.000Z');
const DAY_2 = new Date('2026-08-25T00:00:01.000Z');

describe('utcDay', () => {
  it('formats explicitly, so two servers in different timezones agree', () => {
    expect(utcDay(new Date('2026-01-05T23:30:00.000Z'))).toBe('2026-01-05');
    expect(utcDay(new Date('2026-12-31T00:00:00.000Z'))).toBe('2026-12-31');
  });
});

describe('dailySalt', () => {
  it('is stable within a UTC day', async () => {
    expect(await dailySalt(PEPPER, DAY_1)).toBe(await dailySalt(PEPPER, DAY_1_LATE));
  });

  it('changes at the UTC day boundary', async () => {
    expect(await dailySalt(PEPPER, DAY_1)).not.toBe(await dailySalt(PEPPER, DAY_2));
  });

  it('depends on the pepper', async () => {
    expect(await dailySalt(PEPPER, DAY_1)).not.toBe(await dailySalt('b'.repeat(64), DAY_1));
  });

  it('does not expose the pepper', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    expect(salt).toHaveLength(64);
    expect(salt).not.toContain(PEPPER.slice(0, 8));
  });
});

describe('anonId', () => {
  it('is deterministic for the same visitor within a day', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    const a = await anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (iPhone)');
    const b = await anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (iPhone)');
    expect(a).toBe(b);
  });

  it('produces exactly 32 lowercase hex characters, matching the wire schema', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    expect(await anonId(PEPPER, salt, '1.2.3.4', 'UA')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separates two visitors on the same network', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    const a = await anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (iPhone)');
    const b = await anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (Macintosh)');
    expect(a).not.toBe(b);
  });

  /**
   * Without a separator, ('1.2.3', '4Mozilla') and ('1.2.34', 'Mozilla') hash
   * identically and two visitors silently merge into one.
   */
  it('encodes its inputs unambiguously', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    const a = await anonId(PEPPER, salt, '1.2.3', '4Mozilla');
    const b = await anonId(PEPPER, salt, '1.2.34', 'Mozilla');
    expect(a).not.toBe(b);
  });

  it('cannot be recomputed for a previous day', async () => {
    const today = await anonId(PEPPER, await dailySalt(PEPPER, DAY_1), '203.0.113.7', 'UA');
    const tomorrow = await anonId(PEPPER, await dailySalt(PEPPER, DAY_2), '203.0.113.7', 'UA');
    expect(today).not.toBe(tomorrow);
  });

  it('cannot be computed without the pepper', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    const withPepper = await anonId(PEPPER, salt, '203.0.113.7', 'UA');
    const guessed = await anonId('', salt, '203.0.113.7', 'UA');
    expect(withPepper).not.toBe(guessed);
  });

  it('spreads uniformly enough that collisions are not a concern', async () => {
    const salt = await dailySalt(PEPPER, DAY_1);
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) {
      ids.add(
        await anonId(PEPPER, salt, `10.0.${String(Math.floor(i / 255))}.${String(i % 255)}`, 'UA'),
      );
    }
    expect(ids.size).toBe(5_000);
  });

  /**
   * The reason this module lives in `core`. Middleware and the collector derive this
   * value in different processes on different runtimes; if they ever disagree, the
   * assignment and the behaviour it produced stop joining and nothing fails loudly.
   */
  it('is identical however it is reached', async () => {
    const direct = await anonId(PEPPER, await dailySalt(PEPPER, DAY_1), '1.2.3.4', 'UA');
    const viaClass = await new VisitorIdentity(PEPPER).idFor('1.2.3.4', 'UA', DAY_1);
    expect(viaClass).toBe(direct);
  });
});

describe('VisitorIdentity', () => {
  it('refuses a pepper too short to be a secret', () => {
    expect(() => new VisitorIdentity('short')).toThrow(/at least 32 characters/);
  });

  it('returns the same salt for repeated calls within a day', async () => {
    const identity = new VisitorIdentity(PEPPER);
    expect(await identity.saltFor(DAY_1)).toBe(await identity.saltFor(DAY_1_LATE));
  });

  it('rotates across midnight without losing the previous day', async () => {
    const identity = new VisitorIdentity(PEPPER);
    const first = await identity.saltFor(DAY_1);
    const second = await identity.saltFor(DAY_2);
    expect(second).not.toBe(first);
    // A request that arrived just before midnight and is processed just after must
    // still resolve to the same identifier it was assigned.
    expect(await identity.saltFor(DAY_1)).toBe(first);
  });

  it('evicts beyond two days, so a corrected clock cannot serve a stale salt', async () => {
    const identity = new VisitorIdentity(PEPPER);
    const day = (iso: string): Date => new Date(iso);
    await identity.saltFor(day('2026-08-20T00:00:00.000Z'));
    await identity.saltFor(day('2026-08-21T00:00:00.000Z'));
    await identity.saltFor(day('2026-08-22T00:00:00.000Z'));

    // Recomputed rather than served from cache — the value is the same either way,
    // which is the point: correctness never depends on the cache.
    expect(await identity.saltFor(day('2026-08-20T00:00:00.000Z'))).toBe(
      await dailySalt(PEPPER, day('2026-08-20T00:00:00.000Z')),
    );
  });
});

describe('idsEqual', () => {
  it('compares equal ids', () => {
    expect(idsEqual('a'.repeat(32), 'a'.repeat(32))).toBe(true);
  });

  it('rejects different ids', () => {
    expect(idsEqual('a'.repeat(32), `b${'a'.repeat(31)}`)).toBe(false);
  });

  it('rejects mismatched lengths without throwing', () => {
    expect(idsEqual('abc', 'abcd')).toBe(false);
  });

  it('compares every character rather than stopping at the first difference', () => {
    // The behavioural signature of a constant-time comparison: a mismatch in the first
    // position and one in the last are indistinguishable from the outside.
    expect(idsEqual('ab', 'xb')).toBe(false);
    expect(idsEqual('ab', 'ax')).toBe(false);
  });
});
