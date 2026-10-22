/**
 * RSS and Atom feeds.
 *
 * Both, not one. RSS is what most readers and most aggregators consume; Atom is what
 * most *programmatic* consumers prefer, because its date format is unambiguous and its
 * content model actually specifies whether a payload is text or markup. Emitting both
 * costs one extra function and removes an argument nobody wins.
 *
 * Feeds matter more here than on a typical site. They are how an answer engine, an
 * aggregator, or another developer subscribes to MORPH without scraping it — which is
 * exactly the behaviour the crawler policy in `docs/COMPLIANCE.md` asks of *us*, and it
 * would be incoherent to ask for it and not offer it.
 */

import { absoluteUrl, cdata, isoDate, rfc822, xmlText } from './xml';

export interface FeedSite {
  readonly origin: string;
  readonly title: string;
  readonly description: string;
  /** Contact address published in the feed. Optional; omit rather than invent one. */
  readonly authorEmail?: string;
  readonly authorName?: string;
  readonly language?: string;
  /**
   * Path of this feed, for the `rel="self"` link.
   *
   * Defaults to `/feed.xml`, which was hard-coded until a second feed existed. A feed
   * declaring itself to be a different feed is not a cosmetic error: readers use the self
   * link to deduplicate and to follow redirects, so two feeds claiming the same identity
   * can silently collapse into one subscription.
   */
  readonly selfPath?: string;
}

export interface FeedItem {
  readonly title: string;
  readonly path: string;
  readonly summary: string;
  readonly publishedAt: Date;
  readonly updatedAt?: Date;
  /** Full HTML body, when the feed carries content rather than only a summary. */
  readonly contentHtml?: string;
  readonly categories?: readonly string[];
}

/**
 * RSS 2.0.
 *
 * `guid` is `isPermaLink="true"` and equal to the item URL. The alternative — an opaque
 * id — is technically more correct and practically worse: readers that have already
 * seen an item keyed by URL will re-show every item the day the scheme changes, which
 * looks to a subscriber exactly like a compromised feed.
 */
export function renderRss(site: FeedSite, items: readonly FeedItem[], now: Date): string {
  const selfUrl = absoluteUrl(site.origin, site.selfPath ?? '/feed.xml');

  const entries = items.map((item) => {
    const url = absoluteUrl(site.origin, item.path);
    const parts = [
      `      <title>${xmlText(item.title)}</title>`,
      `      <link>${xmlText(url)}</link>`,
      `      <guid isPermaLink="true">${xmlText(url)}</guid>`,
      `      <pubDate>${rfc822(item.publishedAt)}</pubDate>`,
      `      <description>${cdata(item.summary)}</description>`,
    ];
    if (item.contentHtml !== undefined) {
      parts.push(`      <content:encoded>${cdata(item.contentHtml)}</content:encoded>`);
    }
    for (const category of item.categories ?? []) {
      parts.push(`      <category>${xmlText(category)}</category>`);
    }
    return `    <item>\n${parts.join('\n')}\n    </item>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${xmlText(site.title)}</title>`,
    `    <link>${xmlText(absoluteUrl(site.origin, '/'))}</link>`,
    `    <description>${xmlText(site.description)}</description>`,
    `    <language>${xmlText(site.language ?? 'en')}</language>`,
    `    <lastBuildDate>${rfc822(now)}</lastBuildDate>`,
    `    <atom:link href="${xmlText(selfUrl)}" rel="self" type="application/rss+xml" />`,
    ...entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/**
 * Atom 1.0.
 *
 * The feed `id` is the site origin and each entry `id` is its URL: both are required to
 * be permanent and globally unique, and a URL that will not change satisfies both
 * without inventing a UUID scheme that has to be stored somewhere forever.
 */
export function renderAtom(site: FeedSite, items: readonly FeedItem[], now: Date): string {
  const selfUrl = absoluteUrl(site.origin, site.selfPath ?? '/atom.xml');
  const homeUrl = absoluteUrl(site.origin, '/');

  const entries = items.map((item) => {
    const url = absoluteUrl(site.origin, item.path);
    const parts = [
      `    <title>${xmlText(item.title)}</title>`,
      `    <id>${xmlText(url)}</id>`,
      `    <link rel="alternate" type="text/html" href="${xmlText(url)}" />`,
      `    <published>${isoDate(item.publishedAt)}</published>`,
      `    <updated>${isoDate(item.updatedAt ?? item.publishedAt)}</updated>`,
      `    <summary type="text">${xmlText(item.summary)}</summary>`,
    ];
    if (item.contentHtml !== undefined) {
      parts.push(`    <content type="html">${xmlText(item.contentHtml)}</content>`);
    }
    for (const category of item.categories ?? []) {
      parts.push(`    <category term="${xmlText(category)}" />`);
    }
    return `  <entry>\n${parts.join('\n')}\n  </entry>`;
  });

  const author =
    site.authorName === undefined
      ? []
      : [
          '  <author>',
          `    <name>${xmlText(site.authorName)}</name>`,
          ...(site.authorEmail === undefined
            ? []
            : [`    <email>${xmlText(site.authorEmail)}</email>`]),
          '  </author>',
        ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlText(site.language ?? 'en')}">`,
    `  <title>${xmlText(site.title)}</title>`,
    `  <subtitle>${xmlText(site.description)}</subtitle>`,
    `  <id>${xmlText(homeUrl)}</id>`,
    `  <updated>${isoDate(now)}</updated>`,
    `  <link rel="alternate" type="text/html" href="${xmlText(homeUrl)}" />`,
    `  <link rel="self" type="application/atom+xml" href="${xmlText(selfUrl)}" />`,
    ...author,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
