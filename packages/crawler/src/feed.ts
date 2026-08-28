/**
 * RSS and Atom parsing.
 *
 * Feeds come second in the source hierarchy (§4.1): official APIs first, then feeds and
 * sitemaps, and only then polite HTML fetching. A feed is a publisher explicitly saying
 * "here is my content, in a machine-readable form" — the cheapest and least intrusive way
 * to learn what a site published, and the one that stays correct when their markup
 * changes.
 *
 * WHAT MAKES THIS ANNOYING
 * Three formats claim to be two. RSS 2.0, RSS 1.0/RDF and Atom 1.0 all describe the same
 * thing with different element names, different date formats and different ideas about
 * where a link lives. Rather than three parsers, this normalises all of them into one
 * `FeedItem` at the boundary, and everything downstream sees only that.
 *
 * XML entities and CDATA are handled by `fast-xml-parser`; what is left here is the
 * mapping, the date parsing, and the decision about what to do when a field is missing.
 */

import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  /** The canonical identifier the publisher gave it, or its link if it gave none. */
  readonly id: string;
  readonly title: string;
  readonly link: string;
  /** Summary or description, plain text with tags stripped. */
  readonly summary: string;
  /** Milliseconds since the epoch, or null when the feed gave no usable date. */
  readonly publishedAt: number | null;
  readonly author: string | null;
}

export interface ParsedFeed {
  readonly title: string;
  readonly siteUrl: string | null;
  readonly items: readonly FeedItem[];
  /** Which dialect this turned out to be. Reported, because it explains oddities. */
  readonly format: 'rss' | 'atom' | 'rdf';
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Feeds in the wild are not well-formed. Recovering what we can beats rejecting the
  // whole file because one publisher emitted an unescaped ampersand in 2011.
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

/** Anything that might be a value, might be an array of them, might be absent. */
type Node = unknown;

function first(node: Node): Node {
  return Array.isArray(node) ? node[0] : node;
}

function asArray(node: Node): readonly Node[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

/**
 * Read a text value out of a node that might be a string, might be `{ '#text': ... }`,
 * and might be a number because the parser guessed.
 */
function text(node: Node): string {
  const value = first(node);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value === 'object' && '#text' in value) {
    const inner = (value as Record<string, unknown>)['#text'];
    if (typeof inner === 'string') return inner;
    if (typeof inner === 'number' || typeof inner === 'boolean') return String(inner);
    return '';
  }
  return '';
}

/** Strip tags and collapse whitespace. Summaries arrive full of markup. */
export function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a date from any of the formats feeds use.
 *
 * RFC 822 (RSS) and RFC 3339 (Atom) are both handled by `Date`, which is the one place
 * its permissiveness is an advantage. A date that will not parse becomes `null` rather
 * than `Date.now()` — a fabricated timestamp would be indistinguishable from a real one
 * and would corrupt every momentum calculation the item takes part in.
 */
export function parseDate(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Atom puts the URL in an attribute, and often offers several `link` elements with
 * different `rel` values. The one we want is `alternate`, or the first one without a
 * `rel` at all, which is `alternate` by default.
 */
function atomLink(node: Node): string {
  const links = asArray(node);

  const alternate = links.find((link) => {
    if (typeof link !== 'object' || link === null) return false;
    const rel = (link as Record<string, unknown>)['@rel'];
    return rel === 'alternate' || rel === undefined;
  });

  const chosen = alternate ?? links[0];
  if (typeof chosen === 'object' && chosen !== null) {
    const href = (chosen as Record<string, unknown>)['@href'];
    if (typeof href === 'string') return href;
  }
  return typeof chosen === 'string' ? chosen : '';
}

export type FeedParseResult =
  | { readonly kind: 'ok'; readonly feed: ParsedFeed }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Parse a feed document.
 *
 * Returns a result rather than throwing: a malformed feed from one of several hundred
 * sources is an expected condition, not an exception, and the crawl of the other sources
 * must not depend on this one being valid.
 */
export function parseFeed(xml: string): FeedParseResult {
  let document: Record<string, unknown>;
  try {
    document = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  const rss = document['rss'];
  if (rss !== undefined) return { kind: 'ok', feed: fromRss(rss) };

  const feed = document['feed'];
  if (feed !== undefined) return { kind: 'ok', feed: fromAtom(feed) };

  // RSS 1.0 is RDF, with items as siblings of the channel rather than children of it.
  const rdf = document['rdf:RDF'] ?? document['RDF'];
  if (rdf !== undefined) return { kind: 'ok', feed: fromRdf(rdf) };

  return { kind: 'error', message: 'Not a recognised feed: no rss, feed or RDF root element.' };
}

function fromRss(rss: Node): ParsedFeed {
  const channel = first((first(rss) as Record<string, unknown> | undefined)?.['channel']);
  const record = (channel ?? {}) as Record<string, unknown>;

  const items = asArray(record['item']).map((node): FeedItem => {
    const item = (node ?? {}) as Record<string, unknown>;
    const link = text(item['link']);

    return {
      // `guid` is the publisher's own identity for the item and survives a URL change;
      // falling back to the link means a republished item is not counted twice.
      id: text(item['guid']) || link,
      title: toPlainText(text(item['title'])),
      link,
      summary: toPlainText(text(item['description'])),
      publishedAt: parseDate(text(item['pubDate']) || text(item['dc:date'])),
      author: text(item['author']) || text(item['dc:creator']) || null,
    };
  });

  return {
    title: toPlainText(text(record['title'])),
    siteUrl: text(record['link']) || null,
    items,
    format: 'rss',
  };
}

function fromAtom(node: Node): ParsedFeed {
  const record = (first(node) ?? {}) as Record<string, unknown>;

  const items = asArray(record['entry']).map((entryNode): FeedItem => {
    const entry = (entryNode ?? {}) as Record<string, unknown>;
    const link = atomLink(entry['link']);
    const authorNode = first(entry['author']);
    const author =
      typeof authorNode === 'object' && authorNode !== null
        ? text((authorNode as Record<string, unknown>)['name'])
        : '';

    return {
      id: text(entry['id']) || link,
      title: toPlainText(text(entry['title'])),
      link,
      summary: toPlainText(text(entry['summary']) || text(entry['content'])),
      // `published` is when it appeared; `updated` is mandatory in Atom and is the
      // fallback. Preferring `published` keeps an edited old post from looking new.
      publishedAt: parseDate(text(entry['published']) || text(entry['updated'])),
      author: author === '' ? null : author,
    };
  });

  return {
    title: toPlainText(text(record['title'])),
    siteUrl: atomLink(record['link']) || null,
    items,
    format: 'atom',
  };
}

function fromRdf(node: Node): ParsedFeed {
  const record = (first(node) ?? {}) as Record<string, unknown>;
  const channel = (first(record['channel']) ?? {}) as Record<string, unknown>;

  const items = asArray(record['item']).map((itemNode): FeedItem => {
    const item = (itemNode ?? {}) as Record<string, unknown>;
    const link = text(item['link']);

    return {
      id: text(item['@rdf:about']) || link,
      title: toPlainText(text(item['title'])),
      link,
      summary: toPlainText(text(item['description'])),
      publishedAt: parseDate(text(item['dc:date'])),
      author: text(item['dc:creator']) || null,
    };
  });

  return {
    title: toPlainText(text(channel['title'])),
    siteUrl: text(channel['link']) || null,
    items,
    format: 'rdf',
  };
}

/**
 * Discard items that carry nothing usable.
 *
 * An item with no link cannot be fetched, attributed or linked back to, and §7.3 requires
 * attribution on every generated page. An item with no title is almost always a parse
 * artefact. Both are dropped here rather than surviving to fail somewhere less obvious.
 */
export function usableItems(feed: ParsedFeed): readonly FeedItem[] {
  return feed.items.filter((item) => item.link !== '' && item.title !== '');
}
