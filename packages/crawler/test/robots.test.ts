import { describe, expect, it } from 'vitest';
import {
  groupFor,
  isAllowed,
  isExpired,
  parseRobots,
  patternMatches,
  policyFrom,
  ROBOTS_ERROR_TTL_MS,
  ROBOTS_TTL_MS,
} from '../src/robots.js';

/**
 * These tests are the compliance position in `docs/COMPLIANCE.md`. If one of them fails,
 * MORPH is crawling somewhere it said it would not.
 */

const UA = 'MorphBot/0.1 (+https://example.com/bot)';

describe('parsing', () => {
  it('reads groups, rules and sitemaps', () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
      Crawl-delay: 2

      Sitemap: https://example.com/sitemap.xml
    `);

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['*']);
    expect(robots.groups[0]?.rules).toHaveLength(2);
    expect(robots.groups[0]?.crawlDelaySeconds).toBe(2);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('shares one rule set between consecutive user-agent lines', () => {
    const robots = parseRobots(`
      User-agent: morphbot
      User-agent: otherbot
      Disallow: /private
    `);

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['morphbot', 'otherbot']);
  });

  it('starts a new group when a user-agent follows a rule', () => {
    const robots = parseRobots(`
      User-agent: morphbot
      Disallow: /a
      User-agent: *
      Disallow: /b
    `);

    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[1]?.agents).toEqual(['*']);
  });

  it('strips comments and a UTF-8 BOM', () => {
    const robots = parseRobots('﻿User-agent: *  # everyone\nDisallow: /x  # not this');
    expect(robots.groups[0]?.rules[0]?.pattern).toBe('/x');
  });

  /**
   * One character apart, opposite meanings. `Disallow:` with an empty value is the
   * conventional way to say "everything is permitted".
   */
  it('treats an empty Disallow as no rule at all', () => {
    const robots = parseRobots('User-agent: *\nDisallow:');
    expect(robots.groups[0]?.rules).toEqual([]);
    expect(isAllowed(robots, UA, '/anything').allowed).toBe(true);
  });

  it('treats Disallow: / as blocking everything', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /');
    expect(isAllowed(robots, UA, '/').allowed).toBe(false);
    expect(isAllowed(robots, UA, '/anything').allowed).toBe(false);
  });

  it('skips lines it cannot understand rather than abandoning the file', () => {
    // Real files contain typos, HTML error pages and occasionally a stack trace.
    // Refusing to read line 40 must not mean ignoring the line that said /admin.
    const robots = parseRobots(`
      <html><body>500 Internal Server Error</body></html>
      User-agent: *
      this line has no colon
      Disallow: /admin
      Crawl-delay: not-a-number
    `);

    expect(isAllowed(robots, UA, '/admin').allowed).toBe(false);
    expect(robots.groups[0]?.crawlDelaySeconds).toBeUndefined();
  });

  it('handles an empty file', () => {
    expect(parseRobots('')).toEqual({ groups: [], sitemaps: [] });
    expect(isAllowed(parseRobots(''), UA, '/x').allowed).toBe(true);
  });
});

describe('choosing the group', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /

    User-agent: morphbot
    Disallow: /private

    User-agent: morphbot-news
    Disallow: /
  `);

  it('prefers the longest matching agent token', () => {
    expect(groupFor(robots, 'MorphBot/0.1')?.agents).toEqual(['morphbot']);
    expect(groupFor(robots, 'MorphBot-News/0.1')?.agents).toEqual(['morphbot-news']);
  });

  it('falls back to the wildcard for an unknown agent', () => {
    expect(groupFor(robots, 'SomeOtherBot/1.0')?.agents).toEqual(['*']);
  });

  it('returns null when there is no group at all', () => {
    expect(groupFor(parseRobots('Sitemap: https://x/y.xml'), UA)).toBeNull();
  });

  it('gives a specific agent its own rules rather than the wildcard block', () => {
    // The wildcard here blocks everything; the specific group does not.
    expect(isAllowed(robots, 'MorphBot/0.1', '/public').allowed).toBe(true);
    expect(isAllowed(robots, 'RandomBot/1', '/public').allowed).toBe(false);
  });
});

describe('pattern matching', () => {
  it('matches on a prefix', () => {
    expect(patternMatches('/admin', '/admin')).toBe(true);
    expect(patternMatches('/admin', '/admin/users')).toBe(true);
    expect(patternMatches('/admin', '/administrator')).toBe(true);
    expect(patternMatches('/admin', '/public')).toBe(false);
  });

  it('supports the wildcard', () => {
    expect(patternMatches('/*.pdf', '/docs/a.pdf')).toBe(true);
    expect(patternMatches('/a/*/c', '/a/b/c')).toBe(true);
    expect(patternMatches('/a/*/c', '/a/c')).toBe(false);
  });

  it('anchors on a terminating dollar', () => {
    expect(patternMatches('/x$', '/x')).toBe(true);
    expect(patternMatches('/x$', '/x/y')).toBe(false);
    expect(patternMatches('/*.pdf$', '/a.pdf')).toBe(true);
    expect(patternMatches('/*.pdf$', '/a.pdf?x=1')).toBe(false);
  });

  /**
   * A `robots.txt` is attacker-controlled input from our point of view. An unescaped
   * metacharacter would be a parse error at best.
   */
  it('treats regex metacharacters as literals', () => {
    expect(patternMatches('/a(b)', '/a(b)')).toBe(true);
    expect(patternMatches('/a(b)', '/ab')).toBe(false);
    expect(patternMatches('/a+b', '/a+b')).toBe(true);
    expect(patternMatches('/a.b', '/axb')).toBe(false);
    expect(() => patternMatches('/[', '/[')).not.toThrow();
  });

  it('never matches an empty pattern', () => {
    expect(patternMatches('', '/anything')).toBe(false);
  });
});

describe('the allow/disallow decision', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /admin
    Allow: /admin/public
    Disallow: /admin/public/secret
  `);

  it('lets the longest match win', () => {
    expect(isAllowed(robots, UA, '/admin/users').allowed).toBe(false);
    expect(isAllowed(robots, UA, '/admin/public/page').allowed).toBe(true);
    expect(isAllowed(robots, UA, '/admin/public/secret/x').allowed).toBe(false);
  });

  /**
   * The tie-break that makes `Disallow: /x` + `Allow: /x` mean what a host intends.
   */
  it('lets Allow win at equal length', () => {
    const tie = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x');
    expect(isAllowed(tie, UA, '/x').allowed).toBe(true);
  });

  it('allows anything no rule matches', () => {
    const decision = isAllowed(robots, UA, '/blog/post');
    expect(decision.allowed).toBe(true);
    expect(decision.rule).toBeNull();
  });

  it('reports the deciding rule, for the audit trail', () => {
    expect(isAllowed(robots, UA, '/admin/users').rule?.pattern).toBe('/admin');
  });

  it('carries the crawl delay through', () => {
    const delayed = parseRobots('User-agent: *\nCrawl-delay: 5\nDisallow: /x');
    expect(isAllowed(delayed, UA, '/y').crawlDelaySeconds).toBe(5);
  });
});

describe('turning a fetch into a policy', () => {
  const now = 1_000_000;

  it('trusts a fetched file for a day', () => {
    const policy = policyFrom({ kind: 'ok', body: 'User-agent: *\nDisallow: /x' }, now);
    expect(policy.hostBlocked).toBe(false);
    expect(policy.expiresAt).toBe(now + ROBOTS_TTL_MS);
    expect(isAllowed(policy.robots, UA, '/x').allowed).toBe(false);
  });

  it('treats a missing file as no restrictions', () => {
    const policy = policyFrom({ kind: 'absent' }, now);
    expect(policy.hostBlocked).toBe(false);
    expect(isAllowed(policy.robots, UA, '/anything').allowed).toBe(true);
  });

  /**
   * The decision most crawlers get backwards, and the one that matters most: a server
   * having a bad day has not consented to anything, and hammering it is precisely the
   * behaviour a polite crawler exists to avoid.
   */
  it('blocks a host whose robots.txt could not be read', () => {
    const policy = policyFrom({ kind: 'unavailable' }, now);
    expect(policy.hostBlocked).toBe(true);
    // Retried sooner than a day, so a transient 500 is not a day-long lockout.
    expect(policy.expiresAt).toBe(now + ROBOTS_ERROR_TTL_MS);
    expect(ROBOTS_ERROR_TTL_MS).toBeLessThan(ROBOTS_TTL_MS);
  });

  it('blocks a host that requires authentication to read its rules', () => {
    expect(policyFrom({ kind: 'forbidden' }, now).hostBlocked).toBe(true);
  });

  it('expires exactly at its deadline', () => {
    const policy = policyFrom({ kind: 'absent' }, now);
    expect(isExpired(policy, policy.expiresAt - 1)).toBe(false);
    expect(isExpired(policy, policy.expiresAt)).toBe(true);
  });
});
