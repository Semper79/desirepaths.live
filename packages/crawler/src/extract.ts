/**
 * Pulling the article out of a page.
 *
 * A fetched HTML document is mostly not the article: navigation, cookie banners, related
 * links, three newsletter prompts and a footer. Everything downstream — the SimHash, the
 * embedding, the topic clustering, the momentum count — is computed on this function's
 * output, so a bad extraction does not produce a slightly worse result, it produces a
 * cluster about cookie banners.
 *
 * WHY A DENSITY HEURISTIC AND NOT A PARSER FOR EACH SITE
 * Per-site extraction rules are more accurate and break every time a site redesigns. At a
 * few hundred sources, maintaining them is the whole job. The Readability-style heuristic
 * below — score candidate blocks by text against link density, take the best subtree — is
 * less accurate on any single site and roughly as accurate on all of them, forever.
 *
 * WHAT IT DOES NOT DO
 * No JavaScript execution. A site that renders its article client-side extracts as an
 * empty page and is dropped by the length floor. That is the correct outcome: a headless
 * browser per document is a different cost class, and a publisher who renders text only
 * in the browser has effectively declined machine readers.
 */

import { parseHTML } from 'linkedom';

export interface ExtractedDocument {
  readonly title: string;
  readonly text: string;
  /** The canonical URL the page names for itself, which may differ from where we found it. */
  readonly canonicalUrl: string | null;
  readonly author: string | null;
  readonly publishedAt: number | null;
  readonly language: string | null;
  /** Outbound links from within the article body, for attribution and source discovery. */
  readonly links: readonly string[];
  readonly wordCount: number;
}

/**
 * Below this, whatever was extracted is not an article.
 *
 * A tag page, a paywall stub, a client-rendered shell and a 404 that answered 200 all
 * produce a hundred words of navigation. Dropping them here keeps them out of the corpus
 * entirely rather than letting them dilute a cluster.
 */
export const MINIMUM_WORDS = 120;

/** Never the article, whatever their text density says. */
const STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
];

/**
 * Class and id fragments that mark a block as furniture.
 *
 * Matched as substrings, deliberately: `related-articles`, `article-related` and
 * `relatedPosts` should all lose. The risk of catching a real article container is what
 * the scoring below is for — this is a penalty, not a deletion.
 */
const NEGATIVE_HINTS =
  /comment|share|social|related|promo|banner|advert|sponsor|newsletter|subscribe|cookie|consent|sidebar|footer|nav|menu|breadcrumb|pagination|tag-list|widget/i;

const POSITIVE_HINTS = /article|content|post|story|entry|body|main|text|prose/i;

export type ExtractResult =
  | { readonly kind: 'ok'; readonly document: ExtractedDocument }
  | { readonly kind: 'too-short'; readonly wordCount: number }
  | { readonly kind: 'error'; readonly message: string };

export function extract(html: string, sourceUrl: string): ExtractResult {
  let window: ReturnType<typeof parseHTML>;
  try {
    window = parseHTML(html);
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  const { document } = window;

  for (const selector of STRIP_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) element.remove();
  }

  const body = document.querySelector('body');
  if (body === null) return { kind: 'error', message: 'Document has no body.' };

  const candidates = Array.from(body.querySelectorAll('article, main, section, div, td'));
  // The body itself is the fallback candidate, for pages whose article is not wrapped in
  // anything at all. Rare, but the alternative is extracting nothing from them.
  const best = pickBest([...candidates, body]);

  const text = normaliseWhitespace(best?.textContent ?? '');
  const wordCount = countWords(text);

  if (wordCount < MINIMUM_WORDS) return { kind: 'too-short', wordCount };

  return {
    kind: 'ok',
    document: {
      title: extractTitle(document),
      text,
      canonicalUrl: absolute(attribute(document, 'link[rel="canonical"]', 'href'), sourceUrl),
      author: metaContent(document, ['author', 'article:author', 'og:article:author']),
      publishedAt: extractDate(document),
      language: document.querySelector('html')?.getAttribute('lang') ?? null,
      links: collectLinks(best ?? body, sourceUrl),
      wordCount,
    },
  };
}

/**
 * Score a candidate block and take the highest.
 *
 * The core signal is link density: navigation and related-links blocks are almost all
 * anchor text, articles are almost none. Paragraph count rewards real prose over a wall
 * of one long string, and the class/id hints break ties the density cannot.
 */
function pickBest(candidates: readonly Element[]): Element | null {
  let best: Element | null = null;
  let bestScore = -Infinity;

  for (const element of candidates) {
    const score = scoreElement(element);
    if (score > bestScore) {
      bestScore = score;
      best = element;
    }
  }

  return best;
}

export function scoreElement(element: Element): number {
  const text = normaliseWhitespace(element.textContent);
  const length = text.length;
  if (length < 200) return -Infinity;

  const linkLength = Array.from(element.querySelectorAll('a')).reduce(
    (sum, anchor) => sum + normaliseWhitespace(anchor.textContent).length,
    0,
  );

  const linkDensity = linkLength / length;
  // Above half link text, this is a list of links whatever it is called. The cliff is
  // deliberate: a smooth penalty lets a large enough navigation block outscore a short
  // article on raw length alone.
  if (linkDensity > 0.5) return -Infinity;

  const paragraphs = element.querySelectorAll('p').length;
  const identifier = `${element.getAttribute('class') ?? ''} ${element.getAttribute('id') ?? ''}`;

  let score = Math.sqrt(length) * (1 - linkDensity) + paragraphs * 3;
  if (POSITIVE_HINTS.test(identifier)) score *= 1.25;
  if (NEGATIVE_HINTS.test(identifier)) score *= 0.4;
  // A semantic <article> is the publisher telling us directly. Weaker than the density
  // signal because plenty of templates wrap the whole page in one.
  if (element.tagName.toLowerCase() === 'article') score *= 1.3;

  return score;
}

function extractTitle(document: Document): string {
  // In order of how much the publisher meant it: the Open Graph title is written for
  // sharing, the <h1> is written for readers, the <title> often carries the site name.
  const og = metaContent(document, ['og:title', 'twitter:title']);
  if (og !== null && og !== '') return og;

  const h1 = document.querySelector('h1')?.textContent;
  if (h1 !== undefined && h1.trim() !== '') return normaliseWhitespace(h1);

  return normaliseWhitespace(document.querySelector('title')?.textContent ?? '');
}

function extractDate(document: Document): number | null {
  const candidates = [
    attribute(document, 'time[datetime]', 'datetime'),
    metaContent(document, ['article:published_time', 'datePublished', 'og:published_time']),
    attribute(document, '[itemprop="datePublished"]', 'content'),
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === '') continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function metaContent(document: Document, names: readonly string[]): string | null {
  for (const name of names) {
    const element =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`);
    const content = element?.getAttribute('content');
    if (content !== undefined && content !== null && content.trim() !== '') return content.trim();
  }
  return null;
}

function attribute(document: Document, selector: string, name: string): string | null {
  return document.querySelector(selector)?.getAttribute(name) ?? null;
}

function collectLinks(root: Element, sourceUrl: string): readonly string[] {
  const seen = new Set<string>();

  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const resolved = absolute(anchor.getAttribute('href'), sourceUrl);
    // Only http(s): `mailto:`, `tel:` and `javascript:` are not sources.
    if (resolved !== null && /^https?:/.test(resolved)) seen.add(resolved);
  }

  return [...seen];
}

function absolute(href: string | null, base: string): string | null {
  if (href === null || href.trim() === '') return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}
