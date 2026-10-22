/**
 * Reading engagement out of ClickHouse.
 *
 * Over HTTP with `FORMAT JSONEachRow` rather than a driver: this is one read, issued four
 * times a day, against a view whose SQL lives in
 * `infra/clickhouse/init/003_audience.sql` next to the table it depends on. A client
 * library would add a dependency, a connection pool and a query builder to send one
 * string.
 *
 * The aggregation, the `FINAL`, and the 30-day window are all in the view. What is left
 * here is the request, and parsing what comes back — which is done with zod, because a
 * database over HTTP is a process boundary like any other and ClickHouse returns every
 * numeric as a JSON number or a string depending on its width.
 */

import { z } from 'zod';
import type { EngagementRepository, PageEngagement } from '../ports';

/**
 * UInt64 arrives as a string in JSON, because it does not fit a double.
 *
 * Coercing rather than rejecting: a count that is genuinely too large for a double is a
 * count we would be happy to be approximately right about, and refusing the whole row
 * would lose the page entirely.
 */
const count = z.coerce.number().nonnegative();

const RowSchema = z.object({
  page_path: z.string(),
  impressions: count,
  signups: count,
  engaged_sessions: count,
  scroll_norm_sum: z.coerce.number(),
  returns: count,
  shares: count,
  bounces: count,
});

export interface ClickHouseConfig {
  readonly url: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The query.
 *
 * The window is a parameter rather than the view's fixed 30 days, so the job's
 * `windowDays` means something. Passed as a ClickHouse query parameter, not interpolated:
 * it arrives from a queue payload, and a queue payload is not trusted input even when the
 * schema has already bounded it.
 */
const ENGAGEMENT_QUERY = `
  SELECT
      page_path,
      sum(impressions)      AS impressions,
      sum(signups)          AS signups,
      sum(engaged_sessions) AS engaged_sessions,
      sum(scroll_norm_sum)  AS scroll_norm_sum,
      sum(returns)          AS returns,
      sum(shares)           AS shares,
      sum(bounces)          AS bounces
  FROM content_engagement_daily FINAL
  WHERE day >= today() - {window:UInt16}
  GROUP BY page_path
  FORMAT JSONEachRow
`;

/**
 * One query, over HTTP.
 *
 * Extracted because the report reads from ClickHouse too, and two copies of the
 * request-and-check-the-body mechanics would be two places for the `response.ok` mistake
 * to be made — the one where a ClickHouse error, which arrives as a 4xx with the reason in
 * the body, is treated as an empty result set.
 *
 * Parameters go through `param_*` rather than into the SQL text: the values arrive from
 * queue payloads and computed timestamps, and interpolation would be the one place in the
 * system where untrusted input reaches a query.
 */
export function clickhouseQuery(config: ClickHouseConfig) {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  return async function query<T>(
    sql: string,
    params: Readonly<Record<string, string | number>>,
    schema: { parse: (value: unknown) => T },
  ): Promise<readonly T[]> {
    const url = new URL(config.url);
    url.searchParams.set('database', config.database);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(`param_${name}`, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: {
          'x-clickhouse-user': config.username,
          'x-clickhouse-key': config.password,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: sql,
        signal: controller.signal,
      });

      if (!response.ok) {
        // ClickHouse puts a genuinely useful message in the body — a missing table, a
        // type mismatch, a memory limit — and a bare status sends whoever is on call
        // to the wrong place.
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`ClickHouse query failed: HTTP ${String(response.status)} — ${detail}`);
      }

      return splitJsonEachRow(await response.text()).map((line) => schema.parse(line));
    } finally {
      clearTimeout(timer);
    }
  };
}

export function clickhouseEngagement(config: ClickHouseConfig): EngagementRepository {
  const query = clickhouseQuery(config);

  return {
    async byPage(windowDays: number): Promise<readonly PageEngagement[]> {
      const rows = await query(ENGAGEMENT_QUERY, { window: windowDays }, RowSchema);
      return rows.map(toPageEngagement);
    },
  };
}

/** JSONEachRow is one JSON object per line, not a JSON array. */
function splitJsonEachRow(body: string): readonly unknown[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

function toPageEngagement(row: z.infer<typeof RowSchema>): PageEngagement {
  return {
    path: row.page_path,
    impressions: row.impressions,
    signups: row.signups,
    engagedSessions: row.engaged_sessions,
    scrollNormSum: row.scroll_norm_sum,
    returns: row.returns,
    shares: row.shares,
    bounces: row.bounces,
  };
}

/**
 * Parse a JSONEachRow body of engagement rows.
 *
 * Exported because the parsing is the part with edge cases — a trailing newline, an empty
 * result, a UInt64 that arrived as a string — and those are worth testing without a
 * database.
 */
export function parseRows(body: string): readonly PageEngagement[] {
  return splitJsonEachRow(body).map((line) => toPageEngagement(RowSchema.parse(line)));
}
