/**
 * How long each table keeps its rows.
 *
 * WHY THIS IS A MODULE AND NOT A COMMENT
 * Postgres enforced retention through declarative partitioning: `adaptation_log` was RANGE
 * partitioned by month and dropping a month was a DETACH. The obligation lived in the
 * schema, where it could not be forgotten. D1 has no partitioning (D31), so retention
 * became a job — and a job can stop while a table definition cannot.
 *
 * Writing the policy down as data is what replaces the lost enforcement. It does two things
 * a comment could not: the cron reads the cutoffs from here rather than restating them, and
 * `test/retention.test.ts` reads the generated migration off disk and fails the build if a
 * table exists with no policy. A new table now forces a retention decision at the moment it
 * is added, which is the only moment anybody is thinking about it.
 *
 * WHY `posterior_snapshot` IS HERE AT ALL
 * It had no retention rule in either schema — not in the Postgres original and not in the
 * D1 port. On Postgres that was a line item on a disk bill. On D1 it is a wall: the context
 * bucket is (device, referrer class, day-part), up to 160 cells, and eleven surfaces times a
 * handful of variants times live buckets times the holdout flag is thousands of rows an
 * hour. At the realistic end that is about 2 GB a year against a 10 GB cap; at the worst
 * case it exceeds the cap inside a year.
 *
 * The move to D1 did not cause that. It exposed it — the table would have grown without
 * bound on Postgres too, just more quietly.
 */

/**
 * Retention in days, by table.
 *
 * `null` means kept permanently, and every one of those is a deliberate decision rather
 * than an omission — which is the distinction this file exists to make visible.
 */
export const RETENTION_DAYS: Readonly<Record<string, number | null>> = {
  /**
   * 25 months, matching the aggregate window that explains each decision. A decision has
   * to stay explainable for as long as the metrics behind it exist.
   */
  adaptation_log: 760,

  /**
   * 90 days, and shorter than `adaptation_log` on purpose.
   *
   * This table is not the record of a decision — `adaptation_log` is, and it stores the
   * statistics verbatim for 25 months. This is the surrounding context: it lets the report
   * draw a trajectory rather than a point, and it survives a Durable Object being reset.
   * Neither of those needs a year of hourly rows. Ninety days covers every window anything
   * actually reads: the hourly report compares against the same hour last week, `/proof`
   * shows current beliefs, `/changes` shows decisions.
   */
  posterior_snapshot: 90,

  /**
   * Permanent, and deliberately so: proof that an erasure was honoured must outlive the
   * data it erased. It holds no personal data beyond an opaque id that resolves to nothing
   * once the erasure completes. Deleting the proof of deletion is how an operator fails an
   * audit having done everything right.
   */
  data_subject_request: null,

  /**
   * Permanent. A consent record is the evidence that processing had a basis, and it is
   * append-only — a withdrawal is a new row, not an edit. Discarding old ones would leave
   * the current state with nothing behind it.
   */
  consent_record: null,

  /** The variant pool is the live population, not a history. Retirement is a status. */
  variant: null,

  /** One row. */
  engine_config: null,

  /**
   * Permanent, because unpublishing is a status change rather than a delete. An erasure
   * request touches personal data and there is none here.
   */
  content: null,
};

/** The column each table's retention is measured against. */
export const RETENTION_COLUMN: Readonly<Record<string, string>> = {
  adaptation_log: 'occurred_at',
  posterior_snapshot: 'taken_at',
};

/**
 * `crawl_document` is deliberately absent, and the absence was caught rather than chosen.
 *
 * It had a 30-day entry in the first version of this file — correct as a policy and wrong as
 * a fact, because the crawl tables have not been ported to D1 yet. The orphan check in
 * `test/retention.test.ts` failed on it immediately: a retention entry for a table that does
 * not exist is a delete the cron runs against nothing, which succeeds and means nothing.
 *
 * It comes back with the table. The coverage check will insist on it then, which is the
 * whole arrangement working in the other direction.
 */

export interface RetentionTask {
  readonly table: string;
  readonly column: string;
  /** Epoch milliseconds. Rows strictly older than this are removed. */
  readonly cutoff: number;
}

/**
 * Every delete the retention cron should run, given a clock.
 *
 * Pure, and returns the work rather than doing it — the same reason `packages/adaptive`
 * takes plain data and returns plain data. The cron supplies `now` and executes the result,
 * so a test can assert the cutoffs without a database and a replay of yesterday's run
 * produces yesterday's cutoffs rather than today's.
 */
export function retentionTasks(now: number): readonly RetentionTask[] {
  const tasks: RetentionTask[] = [];

  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    if (days === null) continue;

    const column = RETENTION_COLUMN[table];
    // A table with a finite retention and no column to measure it against is a policy that
    // cannot be executed. Throwing beats skipping: a silently skipped delete is how a table
    // grows past a cap while the cron reports success.
    if (column === undefined) {
      throw new Error(`${table} has a retention period but no column to apply it to`);
    }

    tasks.push({ table, column, cutoff: now - days * 86_400_000 });
  }

  return tasks;
}
