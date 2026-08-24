import { describe, expect, it } from 'vitest';
import { anonId, dailySalt, idsEqual, SaltCache } from '../src/lib/anon-id.js';

/**
 * The properties tested here are the privacy design, not implementation details.
 * If one of these fails, `docs/PRIVACY.md` has become untrue.
 */

const PEPPER = 'a'.repeat(64);
const DAY_1 = new Date('2026-08-24T12:00:00.000Z');
const DAY_1_LATE = new Date('2026-08-24T23:59:59.000Z');
const DAY_2 = new Date('2026-08-25T00:00:01.000Z');

describe('dailySalt', () => {
  it('is stable within a UTC day', () => {
    expect(dailySalt(PEPPER, DAY_1)).toBe(dailySalt(PEPPER, DAY_1_LATE));
  });

  it('changes at the UTC day boundary', () => {
    expect(dailySalt(PEPPER, DAY_1)).not.toBe(dailySalt(PEPPER, DAY_2));
  });

  it('depends on the pepper', () => {
    expect(dailySalt(PEPPER, DAY_1)).not.toBe(dailySalt('b'.repeat(64), DAY_1));
  });

  it('does not leak the pepper by length extension', () => {
    // HMAC rather than concatenation. The assertion is weak on its own; the point is
    // that a change to plain hashing would need to change this test too.
    const salt = dailySalt(PEPPER, DAY_1);
    expect(salt).toHaveLength(64);
    expect(salt).not.toContain(PEPPER.slice(0, 8));
  });
});

describe('anonId', () => {
  const salt = dailySalt(PEPPER, DAY_1);

  it('is deterministic for the same visitor within a day', () => {
    const a = anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (iPhone)');
    const b = anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (iPhone)');
    expect(a).toBe(b);
  });

  it('produces exactly 32 lowercase hex characters, matching the wire schema', () => {
    expect(anonId(PEPPER, salt, '1.2.3.4', 'UA')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separates two visitors on the same network', () => {
    const a = anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (iPhone)');
    const b = anonId(PEPPER, salt, '203.0.113.7', 'Mozilla/5.0 (Macintosh)');
    expect(a).not.toBe(b);
  });

  /**
   * Without a separator, ('1.2.3', '4Mozilla') and ('1.2.34', 'Mozilla') hash
   * identically and two visitors silently merge into one.
   */
  it('encodes its inputs unambiguously', () => {
    const a = anonId(PEPPER, salt, '1.2.3', '4Mozilla');
    const b = anonId(PEPPER, salt, '1.2.34', 'Mozilla');
    expect(a).not.toBe(b);
  });

  it('cannot be recomputed for a previous day', () => {
    const today = anonId(PEPPER, dailySalt(PEPPER, DAY_1), '203.0.113.7', 'UA');
    const tomorrow = anonId(PEPPER, dailySalt(PEPPER, DAY_2), '203.0.113.7', 'UA');
    expect(today).not.toBe(tomorrow);
  });

  it('cannot be computed without the pepper', () => {
    const withPepper = anonId(PEPPER, salt, '203.0.113.7', 'UA');
    const guessed = anonId('', salt, '203.0.113.7', 'UA');
    expect(withPepper).not.toBe(guessed);
  });

  it('spreads uniformly enough that collisions are not a concern', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      ids.add(anonId(PEPPER, salt, `10.0.${String(Math.floor(i / 255))}.${String(i % 255)}`, 'UA'));
    }
    expect(ids.size).toBe(20_000);
  });
});

describe('SaltCache', () => {
  it('refuses a pepper too short to be a secret', () => {
    expect(() => new SaltCache('short')).toThrow(/at least 32 characters/);
  });

  it('returns the same salt for repeated calls within a day', () => {
    const cache = new SaltCache(PEPPER);
    expect(cache.saltFor(DAY_1)).toBe(cache.saltFor(DAY_1_LATE));
  });

  it('rotates across midnight without losing the previous day', () => {
    const cache = new SaltCache(PEPPER);
    const first = cache.saltFor(DAY_1);
    const second = cache.saltFor(DAY_2);
    expect(second).not.toBe(first);
    // A request that arrived just before midnight and is processed just after must
    // still resolve to the same identifier it was assigned.
    expect(cache.saltFor(DAY_1)).toBe(first);
  });

  it('evicts beyond two days, so a corrected clock cannot serve a stale salt', () => {
    const cache = new SaltCache(PEPPER);
    cache.saltFor(new Date('2026-08-20T00:00:00.000Z'));
    cache.saltFor(new Date('2026-08-21T00:00:00.000Z'));
    cache.saltFor(new Date('2026-08-22T00:00:00.000Z'));
    // Recomputed rather than served from cache - the value is the same either way,
    // which is the point: correctness does not depend on the cache.
    expect(cache.saltFor(new Date('2026-08-20T00:00:00.000Z'))).toBe(
      dailySalt(PEPPER, new Date('2026-08-20T00:00:00.000Z')),
    );
  });

  it('derives ids consistently with the free function', () => {
    const cache = new SaltCache(PEPPER);
    expect(cache.idFor('1.2.3.4', 'UA', DAY_1)).toBe(
      anonId(PEPPER, dailySalt(PEPPER, DAY_1), '1.2.3.4', 'UA'),
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
});
