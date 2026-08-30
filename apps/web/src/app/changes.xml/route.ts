/**
 * `/changes.xml` — the site's own changes, as RSS.
 *
 * The distinctive one. A conventional feed carries articles somebody wrote; this carries
 * decisions the engine made, and it is the only feed of its kind the site could publish —
 * "this website retired one of its own headlines this morning, here is the statistic that
 * killed it" is content produced by operating rather than by writing.
 *
 * It is also the retention mechanic. Somebody who reads `/proof` once has seen the
 * evidence; somebody subscribed here finds out every time it moves.
 */

import { renderRss, type FeedItem } from '@morph/seo';
import { changesFrom } from '../../lib/changes.js';
import { recentAdaptations } from '../../lib/db.js';
import { origin, siteIdentity } from '../../lib/site.js';

/** Same reasoning as `/feed.xml`: the origin is environmental, so this cannot be static. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const site = siteIdentity();

  const items: FeedItem[] = changesFrom(await recentAdaptations()).map((change) => ({
    title: change.title,
    // Every entry points at the page rather than at a per-change URL. There is no page
    // for a single adaptation and inventing one would create hundreds of thin URLs a
    // search engine would rightly ignore — the feed is the artefact, the page is the
    // index, and a reader following an item wants the surrounding context anyway.
    path: '/changes',
    summary: change.detail,
    publishedAt: new Date(change.occurredAt),
    categories: [change.action, change.surfaceId],
  }));

  return new Response(
    renderRss(
      {
        origin: origin(),
        title: `${site.name} — what it changed about itself`,
        description:
          'Every decision this site made about its own design, with the statistic behind it. Written by the engine, not by a person.',
        authorName: site.name,
        selfPath: '/changes.xml',
      },
      items,
      new Date(),
    ),
    {
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        // Shorter than the content feed's hour: the adapt job publishes hourly and a
        // subscriber refreshing just after a cycle should not be handed the previous one.
        'cache-control': 'public, max-age=900, stale-while-revalidate=3600',
      },
    },
  );
}
