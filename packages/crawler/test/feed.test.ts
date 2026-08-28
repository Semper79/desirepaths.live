import { describe, expect, it } from 'vitest';
import { parseDate, parseFeed, toPlainText, usableItems } from '../src/feed.js';

const ok = (xml: string) => {
  const result = parseFeed(xml);
  if (result.kind !== 'ok') throw new Error(`Expected a parsed feed, got: ${result.message}`);
  return result.feed;
};

describe('RSS 2.0', () => {
  const RSS = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Example Journal</title>
        <link>https://example.com</link>
        <item>
          <title>A first post</title>
          <link>https://example.com/first</link>
          <guid isPermaLink="false">urn:example:1</guid>
          <description><![CDATA[<p>Some <b>marked up</b> summary.</p>]]></description>
          <pubDate>Tue, 03 Jun 2025 09:00:00 GMT</pubDate>
          <author>editor@example.com</author>
        </item>
        <item>
          <title>A second post</title>
          <link>https://example.com/second</link>
          <pubDate>Wed, 04 Jun 2025 09:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`;

  it('reads the channel and its items', () => {
    const feed = ok(RSS);
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Example Journal');
    expect(feed.siteUrl).toBe('https://example.com');
    expect(feed.items).toHaveLength(2);
  });

  it('unwraps CDATA and strips markup from the summary', () => {
    expect(ok(RSS).items[0]?.summary).toBe('Some marked up summary.');
  });

  /**
   * `guid` survives a URL change, so a republished item is not counted twice — which
   * would inflate the momentum of whatever it is about.
   */
  it('prefers the publisher-supplied guid as the identity', () => {
    expect(ok(RSS).items[0]?.id).toBe('urn:example:1');
  });

  it('falls back to the link when there is no guid', () => {
    expect(ok(RSS).items[1]?.id).toBe('https://example.com/second');
  });

  it('parses RFC 822 dates', () => {
    expect(ok(RSS).items[0]?.publishedAt).toBe(Date.parse('Tue, 03 Jun 2025 09:00:00 GMT'));
  });

  it('reports a missing author as null rather than an empty string', () => {
    expect(ok(RSS).items[1]?.author).toBeNull();
    expect(ok(RSS).items[0]?.author).toBe('editor@example.com');
  });

  it('handles a channel with a single item, which the parser sees as an object', () => {
    const feed = ok(`<rss><channel><title>One</title>
      <item><title>Only</title><link>https://example.com/only</link></item>
    </channel></rss>`);
    expect(feed.items).toHaveLength(1);
  });

  it('handles a channel with no items at all', () => {
    expect(ok('<rss><channel><title>Empty</title></channel></rss>').items).toEqual([]);
  });

  /**
   * An element carrying both attributes and text parses to `{ '@type': ..., '#text': ... }`
   * rather than a string. Common enough — `<title type="text">` — that missing it would
   * silently blank out titles from a whole class of feeds.
   */
  it('reads text from an element that also carries attributes', () => {
    const feed = ok(`<rss><channel><item>
      <title type="text">Titled</title>
      <link>https://example.com/x</link>
      <description type="html">Described</description>
    </item></channel></rss>`);

    expect(feed.items[0]?.title).toBe('Titled');
    expect(feed.items[0]?.summary).toBe('Described');
  });

  it('reads dc:creator and dc:date when a feed uses Dublin Core', () => {
    const feed = ok(`<rss><channel><item>
      <title>T</title><link>https://example.com/x</link>
      <dc:creator>A Writer</dc:creator><dc:date>2025-06-03T09:00:00Z</dc:date>
    </item></channel></rss>`);

    expect(feed.items[0]?.author).toBe('A Writer');
    expect(feed.items[0]?.publishedAt).toBe(Date.parse('2025-06-03T09:00:00Z'));
  });
});

describe('Atom 1.0', () => {
  const ATOM = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Example Notes</title>
      <link rel="self" href="https://example.com/feed.xml"/>
      <link rel="alternate" href="https://example.com/"/>
      <entry>
        <title>An entry</title>
        <id>tag:example.com,2025:1</id>
        <link rel="edit" href="https://example.com/edit/1"/>
        <link rel="alternate" href="https://example.com/entry-1"/>
        <summary>A short summary.</summary>
        <published>2025-06-03T09:00:00Z</published>
        <updated>2025-06-05T12:00:00Z</updated>
        <author><name>A Writer</name></author>
      </entry>
    </feed>`;

  it('reads the feed and its entries', () => {
    const feed = ok(ATOM);
    expect(feed.format).toBe('atom');
    expect(feed.title).toBe('Example Notes');
    expect(feed.items).toHaveLength(1);
  });

  /**
   * Atom offers several links with different `rel` values. Picking the wrong one gives an
   * edit endpoint or the feed itself instead of the article.
   */
  it('picks the alternate link, not the first one', () => {
    expect(ok(ATOM).items[0]?.link).toBe('https://example.com/entry-1');
    expect(ok(ATOM).siteUrl).toBe('https://example.com/');
  });

  it('reads the author name out of its element', () => {
    expect(ok(ATOM).items[0]?.author).toBe('A Writer');
  });

  /**
   * Preferring `published` keeps an edited old post from re-entering the pipeline looking
   * like news.
   */
  it('prefers published over updated', () => {
    expect(ok(ATOM).items[0]?.publishedAt).toBe(Date.parse('2025-06-03T09:00:00Z'));
  });

  it('falls back to updated, which Atom makes mandatory', () => {
    const feed = ok(`<feed><entry><title>T</title><id>x</id>
      <link href="https://example.com/x"/><updated>2025-06-05T12:00:00Z</updated>
    </entry></feed>`);
    expect(feed.items[0]?.publishedAt).toBe(Date.parse('2025-06-05T12:00:00Z'));
  });

  it('falls back to content when there is no summary', () => {
    const feed = ok(`<feed><entry><title>T</title><id>x</id>
      <link href="https://example.com/x"/><content type="html">&lt;p&gt;Body text.&lt;/p&gt;</content>
    </entry></feed>`);
    expect(feed.items[0]?.summary).toBe('Body text.');
  });

  it('handles an entry whose author has no name element', () => {
    const feed = ok(`<feed><entry><title>T</title><id>x</id>
      <link href="https://example.com/x"/><author></author></entry></feed>`);
    expect(feed.items[0]?.author).toBeNull();
  });
});

describe('RSS 1.0 / RDF', () => {
  const RDF = `<?xml version="1.0"?>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <channel><title>Old School</title><link>https://example.org</link></channel>
      <item rdf:about="https://example.org/a">
        <title>An item</title>
        <link>https://example.org/a</link>
        <description>Summary text.</description>
        <dc:date>2025-06-03T09:00:00Z</dc:date>
        <dc:creator>A Writer</dc:creator>
      </item>
    </rdf:RDF>`;

  /**
   * RDF puts items as siblings of the channel rather than children, which is the whole
   * reason it needs its own branch.
   */
  it('finds items that sit beside the channel rather than inside it', () => {
    const feed = ok(RDF);
    expect(feed.format).toBe('rdf');
    expect(feed.title).toBe('Old School');
    expect(feed.siteUrl).toBe('https://example.org');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.id).toBe('https://example.org/a');
    expect(feed.items[0]?.author).toBe('A Writer');
  });
});

describe('malformed input', () => {
  /**
   * One broken feed among several hundred sources is an expected condition, not an
   * exception. The crawl of the others must not depend on this one being valid.
   */
  it('reports an error instead of throwing', () => {
    const result = parseFeed('<html><body>404 Not Found</body></html>');
    expect(result.kind).toBe('error');
  });

  it('rejects an empty document', () => {
    expect(parseFeed('').kind).toBe('error');
  });

  it('recovers a feed whose dates are unparseable', () => {
    const feed = ok(`<rss><channel><item>
      <title>T</title><link>https://example.com/x</link><pubDate>whenever</pubDate>
    </item></channel></rss>`);

    // null, not Date.now(): a fabricated timestamp is indistinguishable from a real one
    // and would corrupt every momentum calculation this item takes part in.
    expect(feed.items[0]?.publishedAt).toBeNull();
  });
});

describe('usable items', () => {
  it('drops items with no link, which cannot be attributed', () => {
    const feed = ok(`<rss><channel>
      <item><title>Has link</title><link>https://example.com/a</link></item>
      <item><title>No link</title></item>
      <item><link>https://example.com/c</link></item>
    </channel></rss>`);

    expect(usableItems(feed).map((i) => i.title)).toEqual(['Has link']);
  });
});

describe('helpers', () => {
  it('strips scripts and styles along with tags', () => {
    expect(toPlainText('<style>p{color:red}</style><p>Kept</p><script>evil()</script>')).toBe(
      'Kept',
    );
  });

  it('decodes the common entities', () => {
    expect(toPlainText('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f')).toBe(
      'a & b <c> "d" \'e\' f',
    );
  });

  it('parses a date or reports that it could not', () => {
    expect(parseDate('2025-06-03T09:00:00Z')).toBe(Date.parse('2025-06-03T09:00:00Z'));
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
  });
});
