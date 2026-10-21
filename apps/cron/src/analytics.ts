/**
 * Reading Analytics Engine back, over its SQL API.
 *
 * Writing to a dataset is a binding. Reading one is not: there is no query binding, so this
 * goes out over HTTPS to `/accounts/{id}/analytics_engine/sql` with an API token. That is
 * the one place in the whole port where a Worker leaves Cloudflare's network to talk to
 * Cloudflare, and it is why the token exists.
 *
 * WHAT COMES BACK IS SAMPLED, ALWAYS
 * Every count here is an estimate weighted by `_sample_interval`, and D33 forbids an
 * estimate from entering a Beta. Nothing in this file is allowed near a posterior. It feeds
 * the health guardrail — Core Web Vitals, error rates, bounce — where a few percent of
 * sampling error moves a p75 by less than the thresholds are spaced apart.
 *
 * `quantileExactWeighted(q, column, _sample_interval)` is the function that makes that true:
 * Analytics Engine stores the observations rather than pre-aggregating them, so a p75 is read
 * off the real distribution rather than interpolated from buckets chosen in advance. It is
 * strictly better than the `quantileState` columns `vitals_hourly` used.
 */

export interface AnalyticsQueryConfig {
  readonly accountId: string;
  readonly apiToken: string;
  /** Injected so a test can answer without a network. Defaults to global `fetch`. */
  readonly fetcher?: typeof fetch;
}

/** The shape the SQL API returns. `meta` is ignored; only `data` is read. */
interface SqlResponse<Row> {
  readonly data?: readonly Row[];
}

export class AnalyticsQueryError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    // The body is included because the API reports a bad query as a 400 with the reason in
    // the text, and a bare "400" sends somebody to the dashboard to guess.
    super(`Analytics Engine SQL API returned ${String(status)}: ${body.slice(0, 500)}`);
    this.name = 'AnalyticsQueryError';
  }
}

/**
 * Run one query and return its rows.
 *
 * No parameter binding: the SQL API takes a plain string, so every value this file
 * interpolates is a number produced by our own clock or a name from the surface registry.
 * Nothing a visitor can influence reaches a query, and `sqlNumber` below is what keeps that
 * from becoming an assumption.
 */
export async function analyticsQuery<Row>(
  config: AnalyticsQueryConfig,
  sql: string,
): Promise<readonly Row[]> {
  const fetcher = config.fetcher ?? fetch;

  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'text/plain',
      },
      body: sql,
    },
  );

  if (!response.ok) {
    throw new AnalyticsQueryError(response.status, await response.text());
  }

  // `response.json()` is already generic here, so an assertion would be noise — but the
  // type it produces is a claim about somebody else's API, not a fact. The rows are only
  // ever read field by field into `VariantHealth`, where a missing number becomes `NaN` and
  // `evaluateHealth` compares it against a threshold — and `NaN` fails every comparison, so
  // a shape change degrades to "no verdict" rather than to a wrong one.
  const payload = await response.json<SqlResponse<Row>>();
  return payload.data ?? [];
}

/**
 * A number, safe to interpolate into SQL.
 *
 * The API has no parameter binding, so this is the boundary. Every value that reaches a
 * query goes through here, which turns "no untrusted input reaches a query" from a property
 * somebody has to keep checking into one the compiler enforces by type.
 */
export function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('refusing to interpolate a non-finite number');
  return String(Math.trunc(value));
}
