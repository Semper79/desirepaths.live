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
import type { EngagementRepository, PageEngagement } from '../ports.js';

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

export function clickhouseEngagement(config: ClickHouseConfig): EngagementRepository {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  return {
    async byPage(windowDays: number): Promise<readonly PageEngagement[]> {
      const url = new URL(config.url);
      url.searchParams.set('database', config.database);
      url.searchParams.set('param_window', String(windowDays));

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
          body: ENGAGEMENT_QUERY,
          signal: controller.signal,
        });

        if (!response.ok) {
          // ClickHouse puts a genuinely useful message in the body — a missing table, a
          // type mismatch, a memory limit — and a bare status sends whoever is on call
          // to the wrong place.
          const detail = (await response.text()).slice(0, 500);
          throw new Error(`ClickHouse query failed: HTTP ${String(response.status)} — ${detail}`);
        }

        return parseRows(await response.text());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * JSONEachRow is one JSON object per line, not a JSON array.
 *
 * Exported because the parsing is the part with edge cases — a trailing newline, an empty
 * result — and those are worth testing without a database.
 */
export function parseRows(body: string): readonly PageEngagement[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const row = RowSchema.parse(JSON.parse(line));

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
    });
}
