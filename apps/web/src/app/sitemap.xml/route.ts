/**
 * `/sitemap.xml`
 *
 * A route handler rather than Next's `app/sitemap.ts` convention, deliberately: the
 * serialiser in `@morph/seo` is tested against hostile generated titles, and the
 * convention would route around it. Shipping the code that has the tests is worth
 * more than using the framework's sugar.
 */

import { renderSitemap, type SitemapEntry } from '@morph/seo';
import { STATIC_ROUTES, origin, publishedContent } from '../../lib/site';

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
  const entries: SitemapEntry[] = [
    ...STATIC_ROUTES.map((route) => ({
      path: route.path,
      priority: route.priority,
      changeFrequency: 'daily' as const,
    })),
    ...(await publishedContent()).map((item) => ({
      path: `/t/${item.slug}`,
      // From the content row, never from the clock. A sitemap that claims everything
      // changed today is ignored within weeks.
      lastModified: new Date(item.modifiedAt ?? item.publishedAt),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
  ];

  return new Response(renderSitemap(origin(), entries), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
