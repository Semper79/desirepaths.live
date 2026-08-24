/**
 * Token-bucket rate limiting for the ingest path.
 *
 * Pure and in-memory by design. This is the *first* line, running per process with no
 * network call, because the whole point is to reject an abusive client before it costs
 * anything. A distributed limiter in Redis sits behind it for the cases that matter
 * across processes (sign-up velocity, provider abuse), where the extra round-trip is
 * affordable because the request rate is four orders of magnitude lower.
 *
 * WHY A TOKEN BUCKET AND NOT A FIXED WINDOW
 * A fixed window lets a client send its entire budget in the last millisecond of one
 * window and again in the first millisecond of the next — twice the intended rate, at
 * the worst possible moment. A token bucket has no edges: it permits a burst up to the
 * bucket size and then exactly the refill rate, which is the shape of real browser
 * traffic (a burst on page load, a trickle thereafter).
 *
 * Time is a parameter, never read from the clock inside. That is what makes the
 * behaviour testable at a chosen moment rather than by sleeping.
 */

export interface BucketConfig {
  /** Maximum tokens, and therefore the largest burst permitted. */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Tokens left after the decision, for the `X-RateLimit-Remaining` header. */
  readonly remaining: number;
  /** Milliseconds until one token is available. Zero when allowed. */
  readonly retryAfterMs: number;
}

/**
 * A bounded map of buckets.
 *
 * The bound matters more than it looks: an unbounded map keyed by client identifier is
 * a memory-exhaustion vector, and the attacker controls the key. When the map is full,
 * the least-recently-used entries are evicted — an evicted client gets a fresh bucket,
 * which is the safe failure direction (permissive) rather than locking out real users.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(
    private readonly config: BucketConfig,
    private readonly maxKeys = 100_000,
  ) {
    if (config.capacity <= 0) throw new RangeError('capacity must be positive');
    if (config.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be positive');
  }

  /** Number of tracked clients. Exposed as a metric; a plateau at `maxKeys` means eviction is active. */
  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, nowMs: number, cost = 1): RateLimitDecision {
    const bucket = this.bucketFor(key, nowMs);

    // Refill for the elapsed time, capped at capacity.
    const elapsedMs = nowMs - bucket.lastRefillMs;
    if (elapsedMs > 0) {
      const refilled = (elapsedMs / 1000) * this.config.refillPerSecond;
      bucket.tokens = Math.min(this.config.capacity, bucket.tokens + refilled);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      // Re-insert so the Map's insertion order tracks recency for the LRU eviction.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((deficit / this.config.refillPerSecond) * 1000),
    };
  }

  private bucketFor(key: string, nowMs: number): BucketState {
    const existing = this.buckets.get(key);
    if (existing !== undefined) return existing;

    if (this.buckets.size >= this.maxKeys) {
      // Map iteration order is insertion order, so the first key is the least recently
      // touched. Evicting a batch amortises the cost across many requests.
      const evictCount = Math.max(1, Math.floor(this.maxKeys / 100));
      let evicted = 0;
      for (const oldest of this.buckets.keys()) {
        this.buckets.delete(oldest);
        evicted += 1;
        if (evicted >= evictCount) break;
      }
    }

    const fresh: BucketState = { tokens: this.config.capacity, lastRefillMs: nowMs };
    this.buckets.set(key, fresh);
    return fresh;
  }
}

/**
 * Ingest defaults.
 *
 * A real session sends a burst of a handful of events on load, then a trickle. 60 tokens
 * with a 2/s refill accommodates an energetic session — scroll depth, engagement pings,
 * web vitals, a few clicks — and still caps a runaway client at 2 events per second
 * sustained, which is two orders of magnitude below what it would take to matter.
 */
export const INGEST_BUCKET: BucketConfig = { capacity: 60, refillPerSecond: 2 };
