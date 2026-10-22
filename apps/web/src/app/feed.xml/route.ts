/** `/feed.xml` — RSS 2.0. */

import { renderRss, type FeedItem } from '@morph/seo';
import { origin, publishedContent, siteIdentity } from '../../lib/site';

/**
 * Dynamic, cached at the edge rather than at build time.
 *
 * These documents embed the public origin, which comes from the environment. Static
 * generation would bake in whatever the *build* environment had — so a preview build
 * promoted to production would serve production a sitemap pointing at the preview
 * host. Rendering per request and letting the cache-control header do the caching
 * costs one cheap render an hour and removes that whole class of mistake.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const site = siteIdentity();
  const items: FeedItem[] = (await publishedContent()).map((item) => ({
    title: item.title,
    path: `/t/${item.slug}`,
    summary: item.summary,
    publishedAt: new Date(item.publishedAt),
    ...(item.modifiedAt === undefined ? {} : { updatedAt: new Date(item.modifiedAt) }),
    categories: [...item.keywords],
  }));

  return new Response(
    renderRss(
      { origin: origin(), title: site.name, description: site.description, authorName: site.name },
      items,
      new Date(),
    ),
    {
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    },
  );
}
