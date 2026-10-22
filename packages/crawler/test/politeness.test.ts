import { describe, expect, it } from 'vitest';
import { DEFAULT_POLITENESS, PolitenessScheduler } from '../src/politeness';

/**
 * Every constraint here protects somebody other than us. These tests are the reason
 * `docs/COMPLIANCE.md` can claim "one concurrent request per host" as a fact.
 */

const HOST = 'example.org';

describe('one concurrent request per host', () => {
  it('refuses a second request while one is in flight', () => {
    const scheduler = new PolitenessScheduler();
    expect(scheduler.check(HOST, 0).kind).toBe('go');

    scheduler.begin(HOST, 0);
    expect(scheduler.check(HOST, 0).kind).toBe('wait');
    // Still refused a long time later: it is concurrency, not a delay.
    expect(scheduler.check(HOST, 10_000).kind).toBe('wait');
  });

  it('permits the next request once the first completes and the delay has passed', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 500, 'success');

    expect(scheduler.check(HOST, 500).kind).toBe('wait');
    expect(scheduler.check(HOST, 500 + DEFAULT_POLITENESS.defaultCrawlDelayMs).kind).toBe('go');
  });

  it('keeps hosts independent', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.begin(HOST, 0);
    expect(scheduler.check('other.org', 0).kind).toBe('go');
  });

  /**
   * A scheduler whose contract can be violated silently eventually is.
   */
  it('throws rather than allowing a caller to skip the check', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.begin(HOST, 0);
    expect(() => {
      scheduler.begin(HOST, 0);
    }).toThrow(/Refused to start/);
  });
});

describe('the crawl delay', () => {
  /**
   * Measured from completion, not from the start. From the start, a host taking two
   * seconds to answer would be hit again immediately — the delay silently becomes zero
   * for exactly the hosts that are struggling most.
   */
  it('is measured from when the request finished', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 3_000, 'success'); // a slow response

    expect(scheduler.check(HOST, 3_500).kind).toBe('wait');
    expect(scheduler.check(HOST, 4_000).kind).toBe('go');
  });

  it('honours a longer delay the host asked for', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.setCrawlDelay(HOST, 10);
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'success');

    expect(scheduler.check(HOST, 9_000).kind).toBe('wait');
    expect(scheduler.check(HOST, 10_000).kind).toBe('go');
  });

  /**
   * A host asking for less than our default does not get to speed us up: their
   * `Crawl-delay` is a floor on their patience, not a licence for our impatience.
   */
  it('never goes below the default, however small a host asks for', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.setCrawlDelay(HOST, 0.01);
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'success');

    expect(scheduler.check(HOST, DEFAULT_POLITENESS.defaultCrawlDelayMs - 1).kind).toBe('wait');
  });

  it('caps an absurd delay, so one host cannot stall the queue for a day', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.setCrawlDelay(HOST, 86_400);
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'success');

    expect(scheduler.check(HOST, DEFAULT_POLITENESS.maxCrawlDelayMs).kind).toBe('go');
  });

  it('leaves the delay alone when a host does not specify one', () => {
    const scheduler = new PolitenessScheduler();
    scheduler.setCrawlDelay(HOST, undefined);
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'success');
    expect(scheduler.check(HOST, DEFAULT_POLITENESS.defaultCrawlDelayMs).kind).toBe('go');
  });
});

describe('the global rate limit', () => {
  const manyHosts = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `host-${String(i)}.example`);

  it('caps requests per second across every host', () => {
    const scheduler = new PolitenessScheduler({ ...DEFAULT_POLITENESS, globalQps: 3 });
    const hosts = manyHosts(5);

    for (const host of hosts.slice(0, 3)) scheduler.begin(host, 0);

    expect(scheduler.check(hosts[3] as string, 0).kind).toBe('wait');
    // The window rolls: a second later the earliest request has left it.
    expect(scheduler.check(hosts[3] as string, 1_001).kind).toBe('go');
  });

  /**
   * The ordering that matters: being under the global budget is not permission to hit
   * one host twice at once.
   */
  it('never lets spare global budget authorise a second concurrent host request', () => {
    const scheduler = new PolitenessScheduler({ ...DEFAULT_POLITENESS, globalQps: 100 });
    scheduler.begin(HOST, 0);
    expect(scheduler.globalHeadroom(0)).toBeGreaterThan(0);
    expect(scheduler.check(HOST, 0).kind).toBe('wait');
  });

  it('reports remaining headroom, which the hourly report quotes', () => {
    const scheduler = new PolitenessScheduler({ ...DEFAULT_POLITENESS, globalQps: 4 });
    expect(scheduler.globalHeadroom(0)).toBe(4);

    scheduler.begin(manyHosts(1)[0] as string, 0);
    expect(scheduler.globalHeadroom(0)).toBe(3);
    expect(scheduler.globalHeadroom(1_001)).toBe(4);
  });
});

describe('the circuit breaker', () => {
  it('opens after the configured run of failures', () => {
    const scheduler = new PolitenessScheduler({ ...DEFAULT_POLITENESS, breakerThreshold: 3 });

    let now = 0;
    for (let i = 0; i < 3; i += 1) {
      scheduler.begin(HOST, now);
      scheduler.end(HOST, now, 'failure');
      now += DEFAULT_POLITENESS.defaultCrawlDelayMs;
    }

    expect(scheduler.isBreakerOpen(HOST, now)).toBe(true);
    expect(scheduler.check(HOST, now).kind).toBe('circuit-open');
  });

  it('is reset by a success, so an intermittent host is not cut off', () => {
    const scheduler = new PolitenessScheduler({ ...DEFAULT_POLITENESS, breakerThreshold: 3 });

    let now = 0;
    const attempt = (outcome: 'success' | 'failure'): void => {
      scheduler.begin(HOST, now);
      scheduler.end(HOST, now, outcome);
      now += DEFAULT_POLITENESS.defaultCrawlDelayMs;
    };

    attempt('failure');
    attempt('failure');
    attempt('success');
    attempt('failure');
    attempt('failure');

    expect(scheduler.isBreakerOpen(HOST, now)).toBe(false);
  });

  it('closes again after the cooldown', () => {
    const scheduler = new PolitenessScheduler({
      ...DEFAULT_POLITENESS,
      breakerThreshold: 1,
      breakerCooldownMs: 5_000,
    });

    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'failure');

    expect(scheduler.check(HOST, 4_999).kind).toBe('circuit-open');
    expect(scheduler.check(HOST, 5_000).kind).toBe('go');
  });

  it('gives a host a fresh run of attempts after a cooldown, not one', () => {
    const scheduler = new PolitenessScheduler({
      ...DEFAULT_POLITENESS,
      breakerThreshold: 2,
      breakerCooldownMs: 5_000,
    });

    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'failure');
    scheduler.begin(HOST, 1_000);
    scheduler.end(HOST, 1_000, 'failure');
    expect(scheduler.isBreakerOpen(HOST, 1_000)).toBe(true);

    // After the cooldown, one more failure must not immediately re-open it.
    scheduler.begin(HOST, 6_001);
    scheduler.end(HOST, 6_001, 'failure');
    expect(scheduler.isBreakerOpen(HOST, 6_001)).toBe(false);
  });

  it('can be closed by hand, for /resume after a fix', () => {
    const scheduler = new PolitenessScheduler({ ...DEFAULT_POLITENESS, breakerThreshold: 1 });
    scheduler.begin(HOST, 0);
    scheduler.end(HOST, 0, 'failure');
    expect(scheduler.isBreakerOpen(HOST, 0)).toBe(true);

    scheduler.closeBreaker(HOST);
    expect(scheduler.isBreakerOpen(HOST, 0)).toBe(false);
  });

  it('reports a breaker as closed for a host it has never seen', () => {
    expect(new PolitenessScheduler().isBreakerOpen('unknown.example', 0)).toBe(false);
  });
});

describe('backing off when a host says no', () => {
  /** Deterministic "randomness", so the jitter window is asserted rather than hoped at. */
  const fixed = (value: number) => ({ ...DEFAULT_POLITENESS, random: () => value });

  it('waits longer than the ordinary crawl delay', () => {
    const scheduler = new PolitenessScheduler(fixed(1));
    scheduler.begin(HOST, 0);
    scheduler.backOff(HOST, 0);

    expect(scheduler.nextAllowedIn(HOST, 0)).toBeGreaterThan(
      DEFAULT_POLITENESS.defaultCrawlDelayMs,
    );
  });

  it('doubles the window with each consecutive rejection', () => {
    const scheduler = new PolitenessScheduler(fixed(1));

    scheduler.begin(HOST, 0);
    scheduler.backOff(HOST, 0);
    const first = scheduler.nextAllowedIn(HOST, 0);

    scheduler.begin(HOST, first);
    scheduler.backOff(HOST, first);
    const second = scheduler.nextAllowedIn(HOST, first);

    expect(second).toBe(first * 2);
  });

  it('caps the window rather than growing without bound', () => {
    const scheduler = new PolitenessScheduler({
      ...fixed(1),
      breakerThreshold: 1_000,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
    });

    let now = 0;
    for (let i = 0; i < 10; i += 1) {
      scheduler.begin(HOST, now);
      scheduler.backOff(HOST, now);
      now += scheduler.nextAllowedIn(HOST, now);
    }

    expect(scheduler.nextAllowedIn(HOST, now)).toBeLessThanOrEqual(4_000);
  });

  /**
   * Jitter spreads several queued jobs for one host, so a recovering host is not hit by
   * all of them in the same instant. It never shortens the wait below the base step.
   */
  it('jitters within the window but never below the base step', () => {
    const scheduler = new PolitenessScheduler({ ...fixed(0), backoffBaseMs: 2_000 });
    scheduler.begin(HOST, 0);
    scheduler.backOff(HOST, 0);

    expect(scheduler.nextAllowedIn(HOST, 0)).toBe(2_000);
  });

  /**
   * An explicit instruction from the host beats our estimate of what is polite.
   */
  it('honours a longer Retry-After', () => {
    const scheduler = new PolitenessScheduler(fixed(1));
    scheduler.begin(HOST, 0);
    scheduler.backOff(HOST, 0, 120_000);

    expect(scheduler.nextAllowedIn(HOST, 0)).toBe(120_000);
  });

  it('does not let a short Retry-After make us faster than our own backoff', () => {
    const scheduler = new PolitenessScheduler({ ...fixed(1), backoffBaseMs: 5_000 });
    scheduler.begin(HOST, 0);
    scheduler.backOff(HOST, 0, 10);

    expect(scheduler.nextAllowedIn(HOST, 0)).toBe(5_000);
  });

  /**
   * A host that keeps rejecting us should eventually be left alone entirely, rather than
   * retried on a slower loop forever.
   */
  it('still counts towards the circuit breaker', () => {
    const scheduler = new PolitenessScheduler({ ...fixed(1), breakerThreshold: 2 });

    let now = 0;
    for (let i = 0; i < 2; i += 1) {
      scheduler.begin(HOST, now);
      scheduler.backOff(HOST, now);
      now += scheduler.nextAllowedIn(HOST, now);
    }

    expect(scheduler.isBreakerOpen(HOST, 0)).toBe(true);
  });

  it('reports zero remaining wait for a host it has never seen', () => {
    expect(new PolitenessScheduler().nextAllowedIn('unknown.example', 5_000)).toBe(0);
  });
});
