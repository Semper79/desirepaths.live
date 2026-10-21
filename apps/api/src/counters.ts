/**
 * The exact per-variant counters, as a Durable Object (D33).
 *
 * One object per surface, addressed with `getByName(surfaceId)`. A surface is the right
 * coordination atom: every decision the engine makes is a comparison between the variants
 * of one surface, so that is the smallest unit that has to be internally consistent. One
 * global object would serialise the whole site through a single thread; one per variant
 * would make a comparison a distributed read.
 *
 * WHAT IT STORES, AND WHY NOT A REWARD
 * Components, not rewards — the same decision `infra/clickhouse/init/002_aggregates.sql`
 * made and for the same reason. The composite reward is a weighted sum, the weights live in
 * `engine_config` and change, and a stored reward computed under old weights is a number
 * that can never be compared with a new one. So the eight sufficient statistics are stored
 * and `packages/adaptive` applies the live weights at read time. Changing a weight
 * reinterprets history instead of invalidating it.
 *
 * WHY THE REWARD IS SESSION-SCOPED AND THIS IS NOT
 * A sign-up belongs to a session, not to the pageview that happened to precede it, so
 * components can only be counted once a session is complete. This object therefore does
 * **not** take events. It takes already-folded session components, and the folding is
 * somebody else's job — see `SessionFold` below for the contract.
 *
 * HOW EXACT "EXACT" ACTUALLY IS
 * D33 said these counters are exact, in contrast to Analytics Engine's sampled estimates.
 * That distinction is the important one and it holds, but "exact" overstated it and the
 * difference is worth stating precisely.
 *
 * Writes are coalesced in memory and flushed on a short alarm, because a write per fold
 * would be tens of millions of rows a day at the design target. An eviction between flushes
 * loses at most `FLUSH_INTERVAL_MS` of counts.
 *
 * That is a completely different kind of error from sampling, which is why it is acceptable
 * and sampling is not. Losing a random handful of observations lowers `n` honestly: the
 * posterior gets wider, the mSPRT crosses later, and the engine becomes slightly more
 * cautious. Reconstructing a count by multiplying a sample by its interval raises `n`
 * dishonestly: the posterior gets narrower than the evidence supports and the engine
 * retires a good variant with a confident reason attached. One direction costs a little
 * statistical power. The other produces confident fiction.
 */

import { DurableObject } from 'cloudflare:workers';

/**
 * How long counts may sit in memory before they are written.
 *
 * Ten seconds, chosen from the write budget rather than from taste. The flush rate is
 * bounded by `surfaces × 86400 / interval` regardless of traffic, which at eleven surfaces
 * and ten seconds is roughly 95,000 row writes a day — just inside the 100,000 the free
 * plan allows. Shortening it costs money linearly; lengthening it widens the eviction
 * window for no benefit, because nothing reads these more often than hourly.
 */
const FLUSH_INTERVAL_MS = 10_000;

/**
 * A completed session's contribution to one variant of one surface.
 *
 * `impressions` is a count rather than a flag because one session can see the same variant
 * across several pageviews, and the denominator the posteriors use is impressions.
 *
 * Every other field is derived from the whole session, and the thresholds are the ones
 * `002_aggregates.sql` used — repeated here as data rather than as logic so this object
 * never has to know what "engaged" means.
 */
export interface SessionFold {
  readonly variantId: string;
  readonly contextBucket: string;
  readonly isHoldout: boolean;

  readonly impressions: number;
  readonly signups: number;
  /** `engaged_ms >= 15000 OR pageviews >= 2`, decided by the folder. */
  readonly engagedSessions: number;
  /** Sum of `clamp(maxScrollPct / 100, 0, 1)`. A mean needs a sum and a count. */
  readonly scrollNormSum: number;
  readonly returns: number;
  readonly shares: number;
  /** `pageviews == 1 AND engaged_ms < 5000`, decided by the folder. */
  readonly bounces: number;
}

/** A fold, plus the hour it belongs to. */
export interface HourlyFold extends SessionFold {
  /**
   * Epoch milliseconds truncated to the hour.
   *
   * Supplied by the caller rather than read from the clock here, so this object holds no
   * timezone or clock policy and a replayed fold lands in the hour it actually belongs to.
   */
  readonly hourStart: number;
}

/** What the adapt cycle reads back. */
export interface CounterRow extends SessionFold {
  readonly hourStart: number;
}

interface Env {
  readonly COUNTERS: DurableObjectNamespace<SurfaceCounters>;
}

/** The composite key, as one string. SQLite has no tuple keys in a Map. */
function keyOf(fold: HourlyFold): string {
  return [fold.hourStart, fold.variantId, fold.contextBucket, fold.isHoldout ? 1 : 0].join(
    '\u0000',
  );
}

function emptyAt(hourStart: number, variantId: string, contextBucket: string, isHoldout: boolean) {
  return {
    hourStart,
    variantId,
    contextBucket,
    isHoldout,
    impressions: 0,
    signups: 0,
    engagedSessions: 0,
    scrollNormSum: 0,
    returns: 0,
    shares: 0,
    bounces: 0,
  };
}

export class SurfaceCounters extends DurableObject<Env> {
  /**
   * Counts awaiting a flush.
   *
   * In memory and therefore losable, which the header explains and accepts. Durable Objects
   * serialise their own requests, so this needs no locking — the thing that would otherwise
   * make a read-modify-write of a shared map unsafe does not exist here.
   */
  private pending = new Map<string, HourlyFold & { readonly hourStart: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Schema only, which is the one legitimate use of this: it blocks delivery until the
    // table exists, and holding it for anything else would serialise the object behind
    // whatever work was inside.
    // `void`, because a constructor cannot await. The runtime holds delivery until the
    // promise settles regardless — that is what `blockConcurrencyWhile` is for — so the
    // promise is genuinely not ours to handle, and marking it ignored says that rather
    // than leaving it to look forgotten.
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          hour_start       INTEGER NOT NULL,
          variant_id       TEXT    NOT NULL,
          context_bucket   TEXT    NOT NULL,
          is_holdout       INTEGER NOT NULL,
          impressions      INTEGER NOT NULL DEFAULT 0,
          signups          INTEGER NOT NULL DEFAULT 0,
          engaged_sessions INTEGER NOT NULL DEFAULT 0,
          scroll_norm_sum  REAL    NOT NULL DEFAULT 0,
          returns          INTEGER NOT NULL DEFAULT 0,
          shares           INTEGER NOT NULL DEFAULT 0,
          bounces          INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_start, variant_id, context_bucket, is_holdout)
        )
      `);
      // Read by hour range on every adapt cycle, and the PK's leading column is the hour,
      // so this exists for the retention delete rather than for the read.
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS counters_hour_idx ON counters (hour_start)`,
      );
      await Promise.resolve();
    });
  }

  /**
   * Add folded session components.
   *
   * Takes an array because a beacon's events fold into several surfaces at once and one RPC
   * per variant would multiply the request count by the width of the assignment vector.
   */
  async record(folds: readonly HourlyFold[]): Promise<void> {
    for (const fold of folds) {
      const key = keyOf(fold);
      const current =
        this.pending.get(key) ??
        emptyAt(fold.hourStart, fold.variantId, fold.contextBucket, fold.isHoldout);

      this.pending.set(key, {
        hourStart: fold.hourStart,
        variantId: fold.variantId,
        contextBucket: fold.contextBucket,
        isHoldout: fold.isHoldout,
        impressions: current.impressions + fold.impressions,
        signups: current.signups + fold.signups,
        engagedSessions: current.engagedSessions + fold.engagedSessions,
        scrollNormSum: current.scrollNormSum + fold.scrollNormSum,
        returns: current.returns + fold.returns,
        shares: current.shares + fold.shares,
        bounces: current.bounces + fold.bounces,
      });
    }

    // Only when there is not one already: `setAlarm` replaces, so calling it on every
    // record would push the flush further away on every write and a busy surface would
    // never flush at all.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  /** Write the pending counts and clear them. */
  override alarm(): void {
    this.flush();
  }

  /**
   * The counters for an hour range, inclusive of both ends.
   *
   * Not `async`, because nothing here awaits: `sql.exec` is synchronous. Durable Object
   * RPC wraps a plain return value in a promise for the caller either way, so the `async`
   * keyword would buy nothing and claim something untrue about what this does.
   *
   * Flushes first, so a reader never sees a count that is up to ten seconds stale. The
   * adapt cycle reads this to build its posteriors and a missing ten seconds would be a
   * silent, systematic under-count of whatever happened to be in flight — small, but
   * biased toward the busiest surfaces, which is the worst shape for a bias to have.
   */
  countersBetween(fromHour: number, throughHour: number): readonly CounterRow[] {
    this.flush();

    const rows = this.ctx.storage.sql
      .exec<{
        hour_start: number;
        variant_id: string;
        context_bucket: string;
        is_holdout: number;
        impressions: number;
        signups: number;
        engaged_sessions: number;
        scroll_norm_sum: number;
        returns: number;
        shares: number;
        bounces: number;
      }>(
        `SELECT * FROM counters
         WHERE hour_start >= ? AND hour_start <= ?
         ORDER BY hour_start, variant_id, context_bucket, is_holdout`,
        fromHour,
        throughHour,
      )
      .toArray();

    return rows.map((row) => ({
      hourStart: row.hour_start,
      variantId: row.variant_id,
      contextBucket: row.context_bucket,
      isHoldout: row.is_holdout === 1,
      impressions: row.impressions,
      signups: row.signups,
      engagedSessions: row.engaged_sessions,
      scrollNormSum: row.scroll_norm_sum,
      returns: row.returns,
      shares: row.shares,
      bounces: row.bounces,
    }));
  }

  /**
   * Drop counters older than an hour boundary.
   *
   * Called by the retention cron. Returns the number of rows removed so the hourly report
   * can show it: the obligation moved from a table definition to a job when Postgres's
   * partitioning went (D31), and a job that silently stops is the failure mode that
   * replaced it.
   */
  pruneBefore(hourStart: number): number {
    this.flush();
    const cursor = this.ctx.storage.sql.exec(
      `DELETE FROM counters WHERE hour_start < ?`,
      hourStart,
    );
    return cursor.rowsWritten;
  }

  /**
   * Write pending counts to SQLite.
   *
   * Synchronous from first statement to last. `sql.exec` does not yield, and a Durable
   * Object does not interleave its own requests, so the whole loop is atomic with respect
   * to every other caller — there is no window in which half the pending map has landed.
   * An `await` anywhere inside here would open exactly that window.
   *
   * `pending` is cleared only after the last write. If a statement throws, the counts stay
   * pending and the next flush retries them, which is the right direction: a duplicate
   * flush is impossible because the map is the only source, and a lost flush is not.
   */
  private flush(): void {
    if (this.pending.size === 0) return;

    for (const fold of this.pending.values()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO counters (
           hour_start, variant_id, context_bucket, is_holdout,
           impressions, signups, engaged_sessions, scroll_norm_sum, returns, shares, bounces
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour_start, variant_id, context_bucket, is_holdout) DO UPDATE SET
           impressions      = impressions + excluded.impressions,
           signups          = signups + excluded.signups,
           engaged_sessions = engaged_sessions + excluded.engaged_sessions,
           scroll_norm_sum  = scroll_norm_sum + excluded.scroll_norm_sum,
           returns          = returns + excluded.returns,
           shares           = shares + excluded.shares,
           bounces          = bounces + excluded.bounces`,
        fold.hourStart,
        fold.variantId,
        fold.contextBucket,
        fold.isHoldout ? 1 : 0,
        fold.impressions,
        fold.signups,
        fold.engagedSessions,
        fold.scrollNormSum,
        fold.returns,
        fold.shares,
        fold.bounces,
      );
    }

    this.pending.clear();
  }
}

/** Truncate a timestamp to its hour, which is the grain everything downstream uses. */
export function hourStartOf(at: number): number {
  return Math.floor(at / 3_600_000) * 3_600_000;
}
