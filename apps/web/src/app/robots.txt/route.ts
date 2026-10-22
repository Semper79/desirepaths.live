/**
 * `/robots.txt`
 *
 * AI crawlers are welcomed explicitly. The reasoning is in `@morph/seo`'s `aeo.ts`,
 * and it is a decision rather than an oversight: citation is worth more to this site
 * than the click it displaces.
 */

import { renderRobotsTxt } from '@morph/seo';
import { isIndexable, origin } from '../../lib/site';

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

export function GET(): Response {
  return new Response(
    renderRobotsTxt({
      origin: origin(),
      indexable: isIndexable(),
      sitemapPaths: ['/sitemap.xml'],
    }),
    {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    },
  );
}
