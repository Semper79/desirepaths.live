import { describe, expect, it } from 'vitest';
import {
  article,
  breadcrumbs,
  faq,
  graph,
  organisation,
  serialiseJsonLd,
  website,
  type SiteIdentity,
} from '../src/jsonld';
import {
  chunkEntries,
  MAX_URLS_PER_SITEMAP,
  renderSitemap,
  renderSitemapIndex,
} from '../src/sitemap';
import { renderAtom, renderRss, type FeedItem, type FeedSite } from '../src/feed';
import { renderLlmsTxt, renderRobotsTxt, WELCOMED_AI_AGENTS } from '../src/aeo';
import { canonicalUrl, pageMeta, renderMetaTags } from '../src/meta';

const SITE: SiteIdentity = {
  origin: 'https://morph.example',
  name: 'MORPH',
  description: 'A website that rebuilds itself around its visitors.',
  logoUrl: 'https://morph.example/logo.png',
  sameAs: ['https://github.com/morph'],
};

describe('JSON-LD', () => {
  it('links entities by @id rather than repeating them', () => {
    const doc = graph([organisation(SITE), website(SITE)]);
    const json = JSON.stringify(doc);
    expect(json).toContain('https://morph.example/#organisation');
    // The website references the organisation by id, not by inlining it again.
    expect(doc['@graph']).toHaveLength(2);
    const site = (doc['@graph'] as Record<string, unknown>[])[1];
    expect(site?.['publisher']).toEqual({ '@id': 'https://morph.example/#organisation' });
  });

  it('states machine generation rather than hiding it', () => {
    const node = article(SITE, {
      headline: 'Why your watch is becoming the interface',
      description: 'Ambient computing is arriving through the smallest screen you own.',
      slug: 'ambient-computing',
      publishedAt: '2026-08-24T14:00:00.000Z',
      generatedBy: 'claude-opus-5',
      reviewedBy: 'M. Semperboni',
      sources: [
        { url: 'https://example.org/a', title: 'A', publisher: 'Example' },
        { url: 'https://example.org/b', title: 'B', publisher: 'Example' },
      ],
    });

    expect(node['author']).toMatchObject({ '@type': 'SoftwareApplication', name: 'claude-opus-5' });
    expect(node['creativeWorkStatus']).toBe('Published');
    expect(node['reviewedBy']).toMatchObject({ name: 'M. Semperboni' });
  });

  it('marks an unreviewed generated piece as a draft', () => {
    const node = article(SITE, {
      headline: 'Draft',
      description: 'x',
      slug: 'd',
      publishedAt: '2026-08-24T14:00:00.000Z',
      generatedBy: 'claude-opus-5',
      sources: [{ url: 'https://example.org/a', title: 'A', publisher: 'Example' }],
    });
    expect(node['creativeWorkStatus']).toBe('Draft');
    expect(node['reviewedBy']).toBeUndefined();
  });

  /**
   * `isBasedOn` is where the mandatory source attribution from section 3 becomes
   * machine-readable. A citation an answer engine can follow is worth more than a
   * sentence of prose it may drop.
   */
  it('makes source attribution machine-readable', () => {
    const node = article(SITE, {
      headline: 'x',
      description: 'y',
      slug: 'z',
      publishedAt: '2026-08-24T14:00:00.000Z',
      sources: [{ url: 'https://example.org/a', title: 'Original', publisher: 'Example Press' }],
    });

    expect(node['isBasedOn']).toEqual([
      {
        '@type': 'CreativeWork',
        url: 'https://example.org/a',
        name: 'Original',
        publisher: { '@type': 'Organization', name: 'Example Press' },
      },
    ]);
  });

  it('attributes a hand-written piece to the organisation', () => {
    const node = article(SITE, {
      headline: 'x',
      description: 'y',
      slug: 'z',
      publishedAt: '2026-08-24T14:00:00.000Z',
      sources: [],
    });
    expect(node['author']).toEqual({ '@id': 'https://morph.example/#organisation' });
    expect(node['creativeWorkStatus']).toBeUndefined();
  });

  it('numbers breadcrumb positions from one', () => {
    const node = breadcrumbs([
      { name: 'Home', url: 'https://morph.example/' },
      { name: 'Trending', url: 'https://morph.example/t' },
    ]);
    const items = node['itemListElement'] as Record<string, unknown>[];
    expect(items[0]?.['position']).toBe(1);
    expect(items[1]?.['position']).toBe(2);
  });

  it('builds FAQ markup, the highest-leverage AEO surface', () => {
    const node = faq([{ question: 'What is MORPH?', answer: 'A site that rebuilds itself.' }]);
    const entity = (node['mainEntity'] as Record<string, unknown>[])[0];
    expect(entity?.['@type']).toBe('Question');
    expect((entity?.['acceptedAnswer'] as Record<string, unknown>)['text']).toBe(
      'A site that rebuilds itself.',
    );
  });

  it('serialises safely for a script element', () => {
    const doc = graph([
      article(SITE, {
        headline: '</script><img src=x onerror=alert(1)>',
        description: 'x',
        slug: 'z',
        publishedAt: '2026-08-24T14:00:00.000Z',
        sources: [],
      }),
    ]);
    const serialised = serialiseJsonLd(doc);
    expect(serialised).not.toContain('</script');

    // Still valid JSON, and the headline survives the escaping unchanged.
    const parsed = JSON.parse(serialised) as { '@graph': { headline: string }[] };
    expect(parsed['@graph'][0]?.headline).toBe('</script><img src=x onerror=alert(1)>');
  });
});

describe('sitemap', () => {
  it('renders a well-formed urlset', () => {
    const xml = renderSitemap('https://morph.example', [
      { path: '/', lastModified: new Date('2026-08-24T14:00:00Z'), priority: 1 },
      { path: '/t/ambient-computing', changeFrequency: 'daily' },
    ]);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<loc>https://morph.example/</loc>');
    expect(xml).toContain('<lastmod>2026-08-24T14:00:00Z</lastmod>');
    expect(xml).toContain('<changefreq>daily</changefreq>');
    expect(xml).toContain('<priority>1.0</priority>');
  });

  it('omits optional fields rather than inventing them', () => {
    const xml = renderSitemap('https://morph.example', [{ path: '/x' }]);
    expect(xml).not.toContain('<lastmod>');
    expect(xml).not.toContain('<changefreq>');
    expect(xml).not.toContain('<priority>');
  });

  it('clamps a nonsensical priority instead of emitting an invalid document', () => {
    const xml = renderSitemap('https://morph.example', [
      { path: '/a', priority: 5 },
      { path: '/b', priority: -1 },
      { path: '/c', priority: Number.NaN },
    ]);
    expect(xml).toContain('<priority>1.0</priority>');
    expect(xml).toContain('<priority>0.0</priority>');
    expect(xml).toContain('<priority>0.5</priority>');
  });

  it('escapes a path that needs it', () => {
    const xml = renderSitemap('https://morph.example', [{ path: '/t/a?b=1&c=2' }]);
    expect(xml).toContain('&amp;');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('refuses to emit an over-length sitemap silently', () => {
    const entries = Array.from({ length: MAX_URLS_PER_SITEMAP + 1 }, (_, i) => ({
      path: `/p/${String(i)}`,
    }));
    expect(() => renderSitemap('https://morph.example', entries)).toThrow(/at most/);
  });

  it('chunks a large list into legal sitemaps', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ path: `/p/${String(i)}` }));
    const chunks = chunkEntries(entries, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toHaveLength(5);
    expect(chunks.flat()).toHaveLength(25);
  });

  it('rejects a nonsensical chunk size', () => {
    expect(() => chunkEntries([], 0)).toThrow(RangeError);
  });

  it('renders a sitemap index', () => {
    const xml = renderSitemapIndex('https://morph.example', [
      { path: '/sitemap-1.xml', lastModified: new Date('2026-08-24T00:00:00Z') },
      { path: '/sitemap-2.xml' },
    ]);
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('<loc>https://morph.example/sitemap-1.xml</loc>');
    expect(xml).toContain('<lastmod>2026-08-24T00:00:00Z</lastmod>');
  });
});

describe('feeds', () => {
  const feedSite: FeedSite = {
    origin: 'https://morph.example',
    title: 'MORPH',
    description: 'A website that rebuilds itself.',
    authorName: 'MORPH',
  };

  const items: readonly FeedItem[] = [
    {
      title: 'R&D: "ambient" computing',
      path: '/t/ambient-computing',
      summary: 'A summary with an ampersand & a quote.',
      publishedAt: new Date('2026-08-24T14:00:00Z'),
      categories: ['technology'],
    },
  ];

  const now = new Date('2026-08-24T15:00:00Z');

  it('renders RSS with a self link and permalink guids', () => {
    const xml = renderRss(feedSite, items, now);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('rel="self"');
    expect(xml).toContain(
      '<guid isPermaLink="true">https://morph.example/t/ambient-computing</guid>',
    );
    expect(xml).toContain('<pubDate>Mon, 24 Aug 2026 14:00:00 GMT</pubDate>');
  });

  it('renders Atom with permanent ids', () => {
    const xml = renderAtom(feedSite, items, now);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain('<id>https://morph.example/t/ambient-computing</id>');
    expect(xml).toContain('<updated>2026-08-24T14:00:00Z</updated>');
    expect(xml).toContain('<name>MORPH</name>');
  });

  it('escapes titles in both formats', () => {
    for (const xml of [renderRss(feedSite, items, now), renderAtom(feedSite, items, now)]) {
      expect(xml).toContain('R&amp;D');
      expect(xml).not.toMatch(/<title>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
    }
  });

  it('wraps a hostile summary so it cannot escape its container', () => {
    const hostile: FeedItem[] = [
      {
        title: 'x',
        path: '/x',
        summary: 'before ]]> <script>alert(1)</script>',
        publishedAt: now,
      },
    ];
    const xml = renderRss(feedSite, hostile, now);
    expect(xml).toContain(']]]]><![CDATA[>');
  });

  it('omits an author block when there is no author to name', () => {
    // Built by omission rather than by assigning `undefined`: with
    // `exactOptionalPropertyTypes`, "absent" and "present but undefined" are different
    // things, and the feed cares about the difference.
    const anonymous: FeedSite = {
      origin: feedSite.origin,
      title: feedSite.title,
      description: feedSite.description,
    };
    expect(renderAtom(anonymous, items, now)).not.toContain('<author>');
  });

  it('carries full content when supplied', () => {
    const withBody: FeedItem[] = [{ ...(items[0] as FeedItem), contentHtml: '<p>Body</p>' }];
    expect(renderRss(feedSite, withBody, now)).toContain('content:encoded');
    expect(renderAtom(feedSite, withBody, now)).toContain('<content type="html">');
  });
});

describe('robots.txt', () => {
  it('welcomes every AI crawler explicitly', () => {
    const txt = renderRobotsTxt({ origin: 'https://morph.example', indexable: true });
    for (const agent of WELCOMED_AI_AGENTS) {
      expect(txt, agent).toContain(`User-agent: ${agent}`);
    }
    expect(txt).toContain('Sitemap: https://morph.example/sitemap.xml');
  });

  it('keeps crawlers off paths that waste their budget', () => {
    const txt = renderRobotsTxt({ origin: 'https://morph.example', indexable: true });
    expect(txt).toContain('Disallow: /i');
    expect(txt).toContain('Disallow: /admin/');
  });

  it('closes everything on a non-indexable deployment', () => {
    const txt = renderRobotsTxt({ origin: 'https://preview.morph.example', indexable: false });
    expect(txt).toBe('User-agent: *\nDisallow: /\n');
  });

  it('accepts multiple sitemaps', () => {
    const txt = renderRobotsTxt({
      origin: 'https://morph.example',
      indexable: true,
      sitemapPaths: ['/sitemap-1.xml', '/sitemap-2.xml'],
    });
    expect(txt).toContain('/sitemap-1.xml');
    expect(txt).toContain('/sitemap-2.xml');
  });
});

describe('llms.txt', () => {
  it('states what the site is, and corrects what a model would otherwise guess', () => {
    const txt = renderLlmsTxt({
      origin: 'https://morph.example',
      name: 'MORPH',
      summary: 'A website that rebuilds itself around measured visitor behaviour.',
      notes: [
        'MORPH is not an A/B testing tool; it adapts itself rather than testing a client site.',
        'MORPH does not create social accounts and does not track visitors across sites.',
      ],
      sections: [
        {
          title: 'Start here',
          links: [
            { title: 'How it works', path: '/how-it-works', note: 'The adaptive engine, plainly.' },
            { title: 'Trending', path: '/t' },
          ],
        },
      ],
    });

    expect(txt.startsWith('# MORPH')).toBe(true);
    expect(txt).toContain('> A website that rebuilds itself');
    expect(txt).toContain('## Notes');
    expect(txt).toContain('not an A/B testing tool');
    expect(txt).toContain(
      '[How it works](https://morph.example/how-it-works): The adaptive engine',
    );
    expect(txt).toContain('[Trending](https://morph.example/t)');
  });

  it('omits the notes heading when there is nothing to correct', () => {
    const txt = renderLlmsTxt({
      origin: 'https://morph.example',
      name: 'MORPH',
      summary: 'x',
      sections: [],
    });
    expect(txt).not.toContain('## Notes');
  });
});

describe('canonical URLs and metadata', () => {
  /**
   * The rule that keeps an adaptive site indexable: one canonical per piece of
   * content, never varied. There is deliberately no way to put a variant into one.
   */
  it('strips query strings, fragments, case and trailing slashes', () => {
    const origin = 'https://morph.example';
    expect(canonicalUrl(origin, '/T/Foo?utm_source=tiktok#top')).toBe(
      'https://morph.example/t/foo',
    );
    expect(canonicalUrl(origin, '/t/foo/')).toBe('https://morph.example/t/foo');
    expect(canonicalUrl(origin, '/')).toBe('https://morph.example/');
  });

  it('produces the same canonical regardless of the variant a visitor was shown', () => {
    const a = canonicalUrl('https://morph.example', '/t/x?variant=hero.headline%23v0');
    const b = canonicalUrl('https://morph.example', '/t/x?variant=hero.headline%23blunt');
    expect(a).toBe(b);
  });

  it('builds the meta set a rich result and a quotable answer need', () => {
    const meta = pageMeta({
      origin: 'https://morph.example',
      siteName: 'MORPH',
      path: '/t/ambient-computing',
      title: 'Why your watch is becoming the interface',
      description: 'Ambient computing is arriving through the smallest screen you own.',
      type: 'article',
      publishedAt: '2026-08-24T14:00:00.000Z',
    });

    const byKey = new Map(meta.tags.map((t) => [t.property ?? t.name, t.content]));
    expect(meta.canonical).toBe('https://morph.example/t/ambient-computing');
    expect(byKey.get('og:type')).toBe('article');
    expect(byKey.get('article:published_time')).toBe('2026-08-24T14:00:00.000Z');
    expect(byKey.get('robots')).toContain('max-snippet:-1');
    expect(byKey.get('robots')).toContain('max-image-preview:large');
  });

  /**
   * The two image branches, because the wrong one is invisible from the page.
   *
   * `og:image` used to default to `/opengraph-image`, a route that no longer exists, so
   * every page advertised a card that resolved to a 404. Nothing on the page changes when
   * that happens and nothing fails — the preview is just broken everywhere the site is
   * shared, which is the one place it is least likely to be noticed.
   */
  it('omits the image tags, and the large card, when there is no image to point at', () => {
    const meta = pageMeta({
      origin: 'https://morph.example',
      siteName: 'MORPH',
      path: '/how-it-works',
      title: 'How it works',
      description: 'What the site measures, and what it changes in response.',
    });

    const keys = meta.tags.map((t) => t.property ?? t.name);
    expect(keys).not.toContain('og:image');
    expect(keys).not.toContain('twitter:image');

    const byKey = new Map(meta.tags.map((t) => [t.property ?? t.name, t.content]));
    // Not `summary_large_image`: declaring a large card without an image renders as an
    // empty block rather than as no card at all.
    expect(byKey.get('twitter:card')).toBe('summary');
  });

  it('uses the large card, and both image tags, when given an image path', () => {
    const meta = pageMeta({
      origin: 'https://morph.example',
      siteName: 'MORPH',
      path: '/how-it-works',
      title: 'How it works',
      description: 'What the site measures, and what it changes in response.',
      imagePath: '/cards/how-it-works.png',
    });

    const byKey = new Map(meta.tags.map((t) => [t.property ?? t.name, t.content]));
    expect(byKey.get('og:image')).toBe('https://morph.example/cards/how-it-works.png');
    expect(byKey.get('twitter:image')).toBe('https://morph.example/cards/how-it-works.png');
    expect(byKey.get('twitter:card')).toBe('summary_large_image');
  });

  it('honours noindex for pages that exist but should not rank', () => {
    const meta = pageMeta({
      origin: 'https://morph.example',
      siteName: 'MORPH',
      path: '/preview/x',
      title: 'Preview',
      description: 'x',
      noindex: true,
    });
    const robots = meta.tags.find((t) => t.name === 'robots');
    expect(robots?.content).toBe('noindex, follow');
  });

  it('truncates an over-long generated title on a word boundary', () => {
    const meta = pageMeta({
      origin: 'https://morph.example',
      siteName: 'MORPH',
      path: '/x',
      title:
        'A very long generated headline that keeps going well past what any search engine will ever display to a human being',
      description: 'x',
      type: 'website',
    });
    expect(meta.title.length).toBeLessThanOrEqual(60);
    expect(meta.title.endsWith('…')).toBe(true);
  });

  it('renders escaped HTML for the rare caller that needs a string', () => {
    const meta = pageMeta({
      origin: 'https://morph.example',
      siteName: 'MORPH',
      path: '/x',
      title: 'Quote " and & ampersand',
      description: '<script>alert(1)</script>',
    });
    const html = renderMetaTags(meta);
    expect(html).toContain('<link rel="canonical"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the feed self link', () => {
  const site: FeedSite = {
    origin: 'https://desirepath.live',
    title: 'Desire Path',
    description: 'A site that changes itself.',
  };

  it('names the feed it is actually in', () => {
    // Hard-coded to /feed.xml until a second feed existed. A feed declaring itself to be a
    // different feed is not a cosmetic error: readers use the self link to deduplicate and
    // to follow redirects, so two feeds claiming one identity can collapse into a single
    // subscription and the subscriber silently stops receiving half of what they asked for.
    const xml = renderRss({ ...site, selfPath: '/changes.xml' }, [], new Date(0));

    expect(xml).toContain('https://desirepath.live/changes.xml" rel="self"');
    expect(xml).not.toContain('/feed.xml');
  });

  it('still defaults to /feed.xml for the content feed', () => {
    expect(renderRss(site, [], new Date(0))).toContain('/feed.xml" rel="self"');
  });

  it('applies to Atom as well, which had the same hard-coded path', () => {
    const xml = renderAtom({ ...site, selfPath: '/changes.atom' }, [], new Date(0));

    expect(xml).toContain('https://desirepath.live/changes.atom');
  });
});
