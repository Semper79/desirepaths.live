/**
 * The published content index, read from Postgres.
 *
 * This is where the content pipeline stops being a pipeline and becomes a website. Until
 * now `apps/web` rendered a hand-written array: the worker could generate a draft, an
 * operator could approve it, and nothing would ever display it.
 *
 * WHY THERE IS A FALLBACK, AND WHY IT CANNOT HIDE AN OUTAGE
 * With no `DATABASE_URL` this returns the seed set from `content.ts`. That is a
 * development convenience — `next build` and `pnpm dev` work on a laptop without Docker,
 * and the sitemap, the feeds and `/llms.txt` are exercised by something real rather than
 * by an empty array, which is the one input that makes every serialisation bug invisible.
 *
 * But a *configured* database that fails is an error, not a reason to fall back. A site
 * quietly serving fixture content because Postgres is down would look healthy, would be
 * indexed by search engines, and would take somebody a long afternoon to notice. So the
 * query is allowed to throw, and only the absence of configuration is treated as a
 * development signal.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { adaptationLog, content } from '@morph/core/db';
import { SEED_CONTENT, toArticle, type PublishedArticle } from './content.js';
import type { AdaptationRow } from './changes.js';

/**
 * One connection pool for the process, created lazily.
 *
 * `max: 4` because this reads a handful of small rows on a cached path; the ingest
 * collector is the process that needs headroom, and it does not share this pool.
 */
let pool: ReturnType<typeof postgres> | null = null;

function database(): ReturnType<typeof drizzle> | null {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return null;

  pool ??= postgres(url, { max: 4 });
  return drizzle(pool);
}

let warned = false;

export async function publishedArticles(): Promise<readonly PublishedArticle[]> {
  const db = database();

  if (db === null) {
    if (!warned) {
      warned = true;
      // The web app has no logger, and a silent fallback to fixture content is exactly
      // what this warning exists to prevent.
      console.warn(
        '[morph] DATABASE_URL is not set; serving seed content. This is a development fallback and must not be the state in production.',
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
 * would be a page of fabricated evidence about how well the system works, which is the
 * one thing this site cannot publish even as a development convenience. With no database
 * the page says nothing has been recorded, which is true.
 */
export async function recentAdaptations(
  windowDays = 90,
  limit = 60,
): Promise<readonly AdaptationRow[]> {
  const db = database();
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
    // both would be dead code that reads as defensiveness. `next build` runs a
    // type-aware ESLint pass the root `pnpm lint` does not, and it caught exactly that.
    stats: row.stats,
  }));
}
