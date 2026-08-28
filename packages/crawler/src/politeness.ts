/**
 * Politeness: how fast MORPH is allowed to ask, and when it must stop asking.
 *
 * Pure. Time is a parameter, never read from a clock, so "wait 1.1 seconds" is tested
 * by passing 1.1 seconds rather than by sleeping — which is what makes it possible to
 * test the behaviour at all rather than hoping.
 *
 * FOUR CONSTRAINTS, IN ORDER OF WHO THEY PROTECT
 *
 *  1. **One concurrent request per host.** Protects the host. Not negotiable, not
 *     configurable, and enforced by a lease rather than by a counter somebody can
 *     forget to decrement.
 *  2. **The host's own `Crawl-delay`, or a default.** Protects the host. A site that
 *     asks for ten seconds gets ten seconds.
 *  3. **A global request rate.** Protects everyone else — our own egress, and any host
 *     sharing an IP with a target.
 *  4. **A per-host circuit breaker.** Protects a host that is already failing. Repeated
 *     errors mean stop, not retry harder.
 *
 * The ordering matters when they disagree: a host constraint always wins over a global
 * one. Being globally under budget is not permission to hit one host twice at once.
 */

export interface PolitenessConfig {
  /** Applied when a host does not specify one. */
  readonly defaultCrawlDelayMs: number;
  /** Ceiling on what a host can ask for, so one `Crawl-delay: 86400` cannot stall a queue. */
  readonly maxCrawlDelayMs: number;
  /** Requests per second across every host. */
  readonly globalQps: number;
  /** Consecutive failures before a host is cut off. */
  readonly breakerThreshold: number;
  /** How long the breaker stays open. */
  readonly breakerCooldownMs: number;
  /** First backoff step after a rejection. Doubles with each consecutive failure. */
  readonly backoffBaseMs: number;
  /** Ceiling on a backoff step, before any `Retry-After` the host asked for. */
  readonly backoffMaxMs: number;
  /**
   * Randomness for backoff jitter.
   *
   * Injected so the behaviour is testable, and — worth stating explicitly against the
   * §1 rule 8 guardrail — this jitter exists to stop several queued jobs returning to a
   * recovering host in the same instant. It is not "humanisation": it makes the traffic
   * gentler on the host, not less detectable, and it applies only after a host has
   * already told us to slow down.
   */
  readonly random: () => number;
}

export const DEFAULT_POLITENESS: PolitenessConfig = {
  defaultCrawlDelayMs: 1_000,
  // A host asking for more than a minute is either misconfigured or telling us to go
  // away. We honour the cap and let the scheduler drop the host rather than block on it.
  maxCrawlDelayMs: 60_000,
  globalQps: 8,
  breakerThreshold: 5,
  breakerCooldownMs: 15 * 60 * 1000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 5 * 60 * 1000,
  random: Math.random,
};

interface HostState {
  /** Set while a request is in flight. The lease that enforces single concurrency. */
  inFlight: boolean;
  /** When the next request to this host is permitted. */
  nextAllowedAt: number;
  consecutiveFailures: number;
  /** While in the future, the breaker is open. */
  breakerOpenUntil: number;
  crawlDelayMs: number;
}

export type Verdict =
  | { readonly kind: 'go' }
  /** Not yet — try again after `waitMs`. */
  | { readonly kind: 'wait'; readonly waitMs: number }
  /** The breaker is open; this host is not being asked again for a while. */
  | { readonly kind: 'circuit-open'; readonly until: number };

export class PolitenessScheduler {
  private readonly hosts = new Map<string, HostState>();
  /** Timestamps of recent requests, for the global rate limit. */
  private recent: number[] = [];

  constructor(private readonly config: PolitenessConfig = DEFAULT_POLITENESS) {}

  /** Record the delay a host asked for. Clamped, and never below the default. */
  setCrawlDelay(host: string, seconds: number | undefined): void {
    const state = this.stateFor(host);
    if (seconds === undefined) return;

    state.crawlDelayMs = Math.min(
      this.config.maxCrawlDelayMs,
      // A host asking for *less* than our default does not get to speed us up. Their
      // `Crawl-delay` is a floor on their patience, not a licence for our impatience.
      Math.max(this.config.defaultCrawlDelayMs, seconds * 1000),
    );
  }

  /**
   * May a request to this host start now?
   *
   * Checks in order of who they protect: breaker, then host concurrency, then host
   * delay, then the global rate. The order is the reason a global budget can never
   * authorise a second concurrent request to one host.
   */
  check(host: string, now: number): Verdict {
    const state = this.stateFor(host);

    if (now < state.breakerOpenUntil) {
      return { kind: 'circuit-open', until: state.breakerOpenUntil };
    }

    if (state.inFlight) {
      // No useful estimate of when the in-flight request finishes, so ask again after
      // the host's own delay rather than spinning.
      return { kind: 'wait', waitMs: state.crawlDelayMs };
    }

    if (now < state.nextAllowedAt) {
      return { kind: 'wait', waitMs: state.nextAllowedAt - now };
    }

    const globalWait = this.globalWaitMs(now);
    if (globalWait > 0) return { kind: 'wait', waitMs: globalWait };

    return { kind: 'go' };
  }

  /**
   * Take the lease for a host.
   *
   * Throws if the caller did not check first. A scheduler whose contract can be
   * violated silently is a scheduler that eventually is.
   */
  begin(host: string, now: number): void {
    const verdict = this.check(host, now);
    if (verdict.kind !== 'go') {
      throw new Error(`Refused to start a request to ${host}: ${verdict.kind}`);
    }

    const state = this.stateFor(host);
    state.inFlight = true;
    this.recent.push(now);
    this.trimRecent(now);
  }

  /**
   * Release the lease.
   *
   * The next-allowed time is measured from *completion*, not from the start. Measuring
   * from the start means a host that takes two seconds to respond gets hit again
   * immediately — the delay silently becomes zero for exactly the hosts that are
   * struggling most.
   */
  end(host: string, now: number, outcome: 'success' | 'failure'): void {
    const state = this.stateFor(host);
    state.inFlight = false;
    state.nextAllowedAt = now + state.crawlDelayMs;

    if (outcome === 'success') {
      state.consecutiveFailures = 0;
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.config.breakerThreshold) {
      state.breakerOpenUntil = now + this.config.breakerCooldownMs;
      // Reset, so that after the cooldown the host gets a fresh set of attempts rather
      // than tripping again on the next single failure.
      state.consecutiveFailures = 0;
    }
  }

  /**
   * A host said "not now" — 429 or 503. Back off before asking again.
   *
   * Call this *instead of* `end(..., 'failure')`: it does everything `end` does, then
   * pushes the next-allowed time out further. The failure still counts towards the
   * breaker, because a host that keeps rejecting us should eventually be left alone
   * entirely rather than retried on a slower loop forever.
   *
   * `retryAfterMs` is whatever the host asked for in `Retry-After`. It always wins when
   * it is longer than our own backoff: an explicit instruction from the host beats our
   * estimate of what is polite. It is not allowed to make us *faster*, for the same
   * reason a short `Crawl-delay` is not.
   */
  backOff(host: string, now: number, retryAfterMs?: number): void {
    const state = this.stateFor(host);
    const attempt = state.consecutiveFailures;

    this.end(host, now, 'failure');

    // Full jitter over an exponentially growing window: the expected wait still doubles
    // each time, but two jobs queued for the same host do not return in lockstep.
    const window = Math.min(this.config.backoffMaxMs, this.config.backoffBaseMs * 2 ** attempt);
    const backoff = Math.max(this.config.backoffBaseMs, this.config.random() * window);

    state.nextAllowedAt = Math.max(state.nextAllowedAt, now + Math.max(backoff, retryAfterMs ?? 0));
  }

  /** For the report: how much of the global budget is unused right now. */
  globalHeadroom(now: number): number {
    this.trimRecent(now);
    return Math.max(0, this.config.globalQps - this.recent.length);
  }

  /** How long until this host may be asked again. Zero if it may be asked now. */
  nextAllowedIn(host: string, now: number): number {
    return Math.max(0, this.stateFor(host).nextAllowedAt - now);
  }

  isBreakerOpen(host: string, now: number): boolean {
    return now < this.stateFor(host).breakerOpenUntil;
  }

  /** Manual reset, for `/resume` after an operator has fixed whatever was wrong. */
  closeBreaker(host: string): void {
    const state = this.stateFor(host);
    state.breakerOpenUntil = 0;
    state.consecutiveFailures = 0;
  }

  private globalWaitMs(now: number): number {
    this.trimRecent(now);
    if (this.recent.length < this.config.globalQps) return 0;

    // The oldest request in the window leaves it in `1000 - age` milliseconds.
    const oldest = this.recent[0];
    if (oldest === undefined) return 0;
    return Math.max(1, 1_000 - (now - oldest));
  }

  private trimRecent(now: number): void {
    const cutoff = now - 1_000;
    // The window is at most `globalQps` entries wide, so this stays cheap.
    this.recent = this.recent.filter((at) => at > cutoff);
  }

  private stateFor(host: string): HostState {
    const existing = this.hosts.get(host);
    if (existing !== undefined) return existing;

    const fresh: HostState = {
      inFlight: false,
      nextAllowedAt: 0,
      consecutiveFailures: 0,
      breakerOpenUntil: 0,
      crawlDelayMs: this.config.defaultCrawlDelayMs,
    };
    this.hosts.set(host, fresh);
    return fresh;
  }
}
