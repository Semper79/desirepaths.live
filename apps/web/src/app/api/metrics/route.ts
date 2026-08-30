/**
 * The renderer's scrape endpoint.
 *
 * `infra/prometheus/prometheus.yml` has scraped `morph-web` at this path since Phase 0 and
 * has been getting a 404 for it ever since.
 *
 * WHY THIS PATH AND NOT A SEPARATE PORT
 * `apps/api` puts its exposition on 9464 so an internet-facing port never serves it. The
 * renderer cannot do that — Next owns its listener — so the protection has to come from
 * the edge instead: `infra/caddy/Caddyfile` must not proxy `/api/metrics`. That is a
 * configuration fact rather than a code one, which is exactly the kind that gets forgotten,
 * so it is stated here as well as there.
 *
 * The exposition is not secret in the sense of credentials, but it does describe traffic
 * shape, error rates and deploy topology — enough to be useful to somebody probing the
 * site, and of no use at all to a visitor.
 */

import { CONTENT_TYPE, collectRuntimeMetrics, renderMetrics } from '@morph/metrics';

/**
 * Node's own numbers, registered here rather than from a Next instrumentation hook.
 *
 * The hook was the obvious home and does not work: `@morph/metrics` is in
 * `transpilePackages`, so Next bundles it and its transitive `prom-client` import, and
 * `prom-client` reaches for the built-in `cluster` module that webpack cannot resolve.
 * Instrumentation runs before everything, so the result was a 500 on every page rather
 * than a warning. Route handlers get node built-ins externalised already, which is why
 * this position works and that one did not.
 *
 * The cost is that the collectors register on the first scrape rather than at boot, so
 * one scrape after a restart has no `process_resident_memory_bytes`. At the fifteen-second
 * interval in `prometheus.yml` that is a fifteen-second gap once per deploy.
 */
collectRuntimeMetrics('web');

/**
 * Never cached and never statically rendered.
 *
 * Without this Next would happily prerender the route at build time and serve every scrape
 * the same counters from the moment of the build — a flat line that looks like a healthy
 * idle system rather than like a broken endpoint.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  return new Response(await renderMetrics(), {
    status: 200,
    headers: { 'content-type': CONTENT_TYPE, 'cache-control': 'no-store' },
  });
}
