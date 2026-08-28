/**
 * `robots.txt` — parsing and matching.
 *
 * This is the file that makes the compliance position in `docs/COMPLIANCE.md` real
 * rather than aspirational, so it is pure, has no I/O, and is tested against the cases
 * that actually occur in the wild rather than only the ones in the specification.
 *
 * THE DECISIONS THAT ARE NOT OBVIOUS
 *
 *  - **A missing file means allowed; a 5xx means disallowed.** A 404 is a site saying
 *    it has no restrictions. A 500 is a server having a bad day, and a bad day is not
 *    consent. Most crawlers get this backwards and hammer a struggling host.
 *  - **Longest match wins, and `Allow` beats `Disallow` on a tie.** This is the
 *    de-facto standard (RFC 9309), not the 1994 draft, which had no `Allow` at all.
 *  - **`Crawl-delay` is honoured** even though RFC 9309 omits it. A host that asks for
 *    a delay gets one. Ignoring a request because it is not normative is the kind of
 *    technically-correct that gets a crawler blocked.
 *  - **An empty `Disallow:` means allow everything**, and `Disallow: /` means nothing.
 *    One character apart, opposite meanings.
 *  - **Group selection is by longest matching user-agent token**, so a rule written for
 *    `MorphBot` beats a rule written for `*`, and a rule for `MorphBot-News` does not
 *    accidentally capture `MorphBot`.
 */

export interface RobotsRule {
  readonly allow: boolean;
  /** The path pattern, which may contain `*` and a terminating `$`. */
  readonly pattern: string;
}

export interface RobotsGroup {
  /** Lower-cased user-agent tokens this group applies to. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** Seconds. Absent when the host did not ask for one. */
  readonly crawlDelaySeconds?: number;
}

export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
}

const EMPTY: RobotsTxt = { groups: [], sitemaps: [] };

/**
 * Parse a `robots.txt`.
 *
 * Deliberately forgiving: an unparseable line is skipped rather than aborting the file.
 * Real `robots.txt` files contain typos, BOMs, HTML error pages and occasionally an
 * entire stack trace, and refusing to read a file because line 40 is malformed means
 * ignoring the 39 lines that told you to stay out of `/admin`.
 */
/** The UTF-8 byte order mark, which a surprising number of robots.txt files begin with. */
const BOM = /^\uFEFF/;

export function parseRobots(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelay: number | undefined;
  // A blank line does not end a group, but a `User-agent` line after a rule does.
  let collectingAgents = false;

  const flush = (): void => {
    if (agents.length > 0) {
      groups.push({
        agents,
        rules,
        ...(crawlDelay === undefined ? {} : { crawlDelaySeconds: crawlDelay }),
      });
    }
    agents = [];
    rules = [];
    crawlDelay = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip a UTF-8 BOM on the first line, and everything after a `#`.
    const line = rawLine.replace(BOM, '').split('#')[0]?.trim() ?? '';
    if (line.length === 0) continue;

    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        // Consecutive `User-agent` lines share one group of rules.
        if (!collectingAgents) flush();
        collectingAgents = true;
        if (value.length > 0) agents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        collectingAgents = false;
        // `Disallow:` with no value means "allow everything" and is not a rule.
        if (field === 'disallow' && value.length === 0) break;
        if (field === 'allow' && value.length === 0) break;
        rules.push({ allow: field === 'allow', pattern: value });
        break;
      }
      case 'crawl-delay': {
        collectingAgents = false;
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds) && seconds >= 0) crawlDelay = seconds;
        break;
      }
      case 'sitemap': {
        // Sitemap is a global directive: it belongs to the file, not to a group.
        if (value.length > 0) sitemaps.push(value);
        break;
      }
      default:
        break;
    }
  }

  flush();
  return { groups, sitemaps };
}

/**
 * Select the group that applies to a user agent.
 *
 * Longest matching token wins, `*` is the fallback, and matching is on a prefix of the
 * product token rather than on the full User-Agent string — which is what hosts
 * actually write. A file with rules for both `morphbot` and `*` gives us the former.
 */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();

  let best: RobotsGroup | null = null;
  let bestLength = -1;
  let wildcard: RobotsGroup | null = null;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        wildcard ??= group;
        continue;
      }
      if (ua.includes(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }

  return best ?? wildcard;
}

/**
 * Does a `robots.txt` pattern match a path?
 *
 * `*` matches any sequence; a trailing `$` anchors the end. Everything else is a
 * literal prefix. The pattern is compiled to a regular expression with every other
 * metacharacter escaped — a `robots.txt` is attacker-controlled input from our point
 * of view, and an unescaped `(` would otherwise be a parse error or worse.
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern.length === 0) return false;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export interface RobotsDecision {
  readonly allowed: boolean;
  /** The rule that decided it, for the audit trail. Null when nothing matched. */
  readonly rule: RobotsRule | null;
  readonly crawlDelaySeconds: number | undefined;
}

/**
 * May this user agent fetch this path?
 *
 * Longest match wins; `Allow` beats `Disallow` at equal length. That tie-break is the
 * whole reason a host can write `Disallow: /admin` followed by `Allow: /admin/public`
 * and have it mean what they intended.
 */
export function isAllowed(robots: RobotsTxt, userAgent: string, path: string): RobotsDecision {
  const group = groupFor(robots, userAgent);
  if (group === null) return { allowed: true, rule: null, crawlDelaySeconds: undefined };

  let winner: RobotsRule | null = null;
  let winnerLength = -1;

  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, path)) continue;

    const length = rule.pattern.length;
    if (length > winnerLength || (length === winnerLength && rule.allow)) {
      winner = rule;
      winnerLength = length;
    }
  }

  return {
    allowed: winner === null ? true : winner.allow,
    rule: winner,
    crawlDelaySeconds: group.crawlDelaySeconds,
  };
}

// -----------------------------------------------------------------------------
// Fetch outcomes
// -----------------------------------------------------------------------------

export type RobotsFetchOutcome =
  /** 2xx with a body. */
  | { readonly kind: 'ok'; readonly body: string }
  /** 404 or 410 — the host has no restrictions. */
  | { readonly kind: 'absent' }
  /** 5xx, a timeout, or a network error. */
  | { readonly kind: 'unavailable' }
  /** 401 or 403 on `robots.txt` itself. */
  | { readonly kind: 'forbidden' };

export interface RobotsPolicy {
  readonly robots: RobotsTxt;
  /**
   * Whether the whole host is off limits regardless of the rules, because we could not
   * establish what the rules are.
   */
  readonly hostBlocked: boolean;
  /** When this policy stops being trusted. */
  readonly expiresAt: number;
}

/** How long a fetched policy is trusted before it must be re-read. */
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A shorter TTL for an unavailable host, so a transient 500 does not lock us out for a
 * day — but long enough that we are not retrying a struggling server every minute.
 */
export const ROBOTS_ERROR_TTL_MS = 30 * 60 * 1000;

/**
 * Turn a fetch outcome into a policy.
 *
 * The two interesting cases:
 *
 *  - **`unavailable`** blocks the host. A 5xx means we do not know what the rules are,
 *    and crawling a host whose rules are unknown is exactly what the policy forbids.
 *    Most crawlers treat this as "allowed", which is how a struggling server gets
 *    hammered by the crawler that should have backed off.
 *  - **`forbidden`** also blocks. A host that requires authentication to read its
 *    `robots.txt` is a host that has not invited us.
 */
export function policyFrom(outcome: RobotsFetchOutcome, now: number): RobotsPolicy {
  switch (outcome.kind) {
    case 'ok':
      return {
        robots: parseRobots(outcome.body),
        hostBlocked: false,
        expiresAt: now + ROBOTS_TTL_MS,
      };
    case 'absent':
      return { robots: EMPTY, hostBlocked: false, expiresAt: now + ROBOTS_TTL_MS };
    case 'unavailable':
      return { robots: EMPTY, hostBlocked: true, expiresAt: now + ROBOTS_ERROR_TTL_MS };
    case 'forbidden':
      return { robots: EMPTY, hostBlocked: true, expiresAt: now + ROBOTS_TTL_MS };
  }
}

/** Has a cached policy aged out? A stale policy blocks rather than permits. */
export function isExpired(policy: RobotsPolicy, now: number): boolean {
  return now >= policy.expiresAt;
}
