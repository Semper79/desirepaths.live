/**
 * The published content index, read from D1.
 *
 * This is where the content pipeline stops being a pipeline and becomes a website. The
 * Postgres version this replaces (D31) held a lazily-created connection pool; a Worker has
 * neither a pool nor a process to hold one in, so the binding is fetched per call and
 * Drizzle is constructed around it. That is cheap — `drizzle(binding)` wraps an object, it
 * does not open anything — and it is the only shape that is correct, because `env` belongs
 * to the request rather than to the isolate.
 *
 * WHY THERE IS A FALLBACK, AND WHY IT CANNOT HIDE AN OUTAGE
 * With no D1 binding this returns the seed set from `content.ts`. That is a development
 * convenience — `next build` and `pnpm dev` work on a laptop with no Cloudflare account,
 * and the sitemap, the feeds and `/llms.txt` are exercised by something real rather than
 * by an empty array, which is the one input that makes every serialisation bug invisible.
 *
 * But a *bound* database that fails is an error, not a reason to fall back. A site quietly
 * serving fixture content because D1 is unreachable would look healthy, would be indexed
 * by search engines, and would take somebody a long afternoon to notice. So the query is
 * allowed to throw, and only the absence of a binding is treated as a development signal.
 *
 * That distinction is worth more here than it was under Postgres. A missing `DATABASE_URL`
 * was almost always a laptop; a missing D1 binding can also be a deployment whose
 * `wrangler.jsonc` is wrong, which is a production fault wearing a development costume.
 * `/api/ready` is what tells those apart, via `bindingReport()` — this module deliberately
 * does not try, because the answer it would guess at is one a readiness probe knows.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { adaptationLog, content } from '@morph/core/db/sqlite';
import { SEED_CONTENT, toArticle, type PublishedArticle } from './content';
import { d1 } from './bindings';
import type { AdaptationRow } from './changes';

/** `null` when there is no D1 binding, which is a supported state, not a broken one. */
async function database(): Promise<ReturnType<typeof drizzle> | null> {
  const binding = await d1();
  return binding === null ? null : drizzle(binding);
}

let warned = false;

export async function publishedArticles(): Promise<readonly PublishedArticle[]> {
  const db = await database();

  if (db === null) {
    if (!warned) {
      warned = true;
      // The web app has no logger, and a silent fallback to fixture content is exactly
      // what this warning exists to prevent.
      console.warn(
        '[morph] No D1 binding; serving seed content. This is a development fallback and must not be the state in production.',
      );
    }
    return SEED_CONTENT;
  }

  const rows = await db
    .select({
      slug: content.slug,
      title: content.title,
      summary: content.summary,
      body: content.body,
      sources: content.sources,
      generatedBy: content.generatedBy,
      reviewedBy: content.reviewedBy,
      publishedAt: content.publishedAt,
      updatedAt: content.updatedAt,
    })
    .from(content)
    .where(eq(content.status, 'published'))
    .orderBy(desc(content.publishedAt));

  return rows.map(toArticle);
}

/**
 * The site's own changes, for `/changes` and its feed.
 *
 * Only the four actions a reader could make sense of. The log also records config changes,
 * pins and pauses, which are operator bookkeeping rather than the site changing itself —
 * publishing them would pad the feed with entries that read as noise and make the
 * interesting ones harder to find.
 *
 * WHY THE FALLBACK IS AN EMPTY LIST AND NOT FIXTURES
 * `publishedArticles` falls back to seed content so the feeds and the sitemap are
 * exercised by something real during development. This must not: invented adaptations
 * would be a page of fabricated evidence about how well the system works, which is the one
 * thing this site cannot publish even as a development convenience. With no binding the
 * page says nothing has been recorded, which is true.
 */
export async function recentAdaptations(
  windowDays = 90,
  limit = 60,
): Promise<readonly AdaptationRow[]> {
  const db = await database();
  if (db === null) return [];

  const since = new Date(Date.now() - windowDays * 86_400_000);

  const rows = await db
    .select({
      occurredAt: adaptationLog.occurredAt,
      action: adaptationLog.action,
      surfaceId: adaptationLog.surfaceId,
      variantId: adaptationLog.variantId,
      reason: adaptationLog.reason,
      stats: adaptationLog.stats,
    })
    .from(adaptationLog)
    .where(
      and(
        gte(adaptationLog.occurredAt, since),
        inArray(adaptationLog.action, ['retired', 'quarantined', 'promoted', 'generated']),
      ),
    )
    .orderBy(desc(adaptationLog.occurredAt))
    .limit(limit);

  return rows.map((row) => ({
    occurredAt: row.occurredAt.getTime(),
    action: row.action,
    surfaceId: row.surfaceId,
    variantId: row.variantId,
    reason: row.reason,
    // No fallback and no cast: the column is `notNull` and Drizzle already types it, so
    // both would be dead code that reads as defensiveness. `next build` runs a type-aware
    // ESLint pass the root `pnpm lint` does not, and it caught exactly that.
    stats: row.stats,
  }));
}
