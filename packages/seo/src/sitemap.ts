/**
 * Sitemaps.
 *
 * A sitemap is a discovery hint, not an index. Search engines treat it as a list of
 * URLs worth looking at and a claim about when each last changed — nothing more. Two
 * consequences shape everything below:
 *
 *  1. **`lastmod` must be true.** A sitemap that reports every page as modified today
 *     is ignored within weeks, and the whole file stops working. MORPH regenerates
 *     content constantly, so the temptation to stamp `now` is real and must be
 *     resisted: `lastModified` comes from the content row, never from the clock.
 *  2. **`priority` and `changefreq` are almost worthless.** Google has said publicly
 *     that it ignores both. They are emitted because other crawlers still read them
 *     and they cost nothing, but no decision here rests on them.
 *
 * The adaptive layer does not appear in the sitemap at all. A URL is a URL regardless
 * of which hero headline a visitor sees; emitting per-variant URLs would split ranking
 * signals across variants and produce duplicate content at exactly the scale that
 * causes trouble.
 */

import { absoluteUrl, isoDate, xmlText } from './xml';

export type ChangeFrequency =
  'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

export interface SitemapEntry {
  /** Path relative to the origin, e.g. `/t/ambient-computing`. */
  readonly path: string;
  /** When the *content* last changed. Never the current time. */
  readonly lastModified?: Date;
  readonly changeFrequency?: ChangeFrequency;
  /** 0.0–1.0. Relative within this site only; it says nothing to a crawler about others. */
  readonly priority?: number;
}

/** Protocol limits. Exceeding either makes the whole file invalid, not merely truncated. */
export const MAX_URLS_PER_SITEMAP = 50_000;
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

export function renderSitemap(origin: string, entries: readonly SitemapEntry[]): string {
  if (entries.length > MAX_URLS_PER_SITEMAP) {
    throw new RangeError(
      `A sitemap may hold at most ${String(MAX_URLS_PER_SITEMAP)} URLs; got ${String(entries.length)}. Use chunkEntries and a sitemap index.`,
    );
  }

  const urls = entries.map((entry) => {
    const parts = [`    <loc>${xmlText(absoluteUrl(origin, entry.path))}</loc>`];
    if (entry.lastModified) parts.push(`    <lastmod>${isoDate(entry.lastModified)}</lastmod>`);
    if (entry.changeFrequency) parts.push(`    <changefreq>${entry.changeFrequency}</changefreq>`);
    if (entry.priority !== undefined) {
      parts.push(`    <priority>${clampPriority(entry.priority).toFixed(1)}</priority>`);
    }
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

export interface SitemapIndexEntry {
  readonly path: string;
  readonly lastModified?: Date;
}

export function renderSitemapIndex(origin: string, sitemaps: readonly SitemapIndexEntry[]): string {
  const items = sitemaps.map((entry) => {
    const parts = [`    <loc>${xmlText(absoluteUrl(origin, entry.path))}</loc>`];
    if (entry.lastModified) parts.push(`    <lastmod>${isoDate(entry.lastModified)}</lastmod>`);
    return `  <sitemap>\n${parts.join('\n')}\n  </sitemap>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...items,
    '</sitemapindex>',
    '',
  ].join('\n');
}

/** Split a large entry list into protocol-legal chunks. */
export function chunkEntries(
  entries: readonly SitemapEntry[],
  size = MAX_URLS_PER_SITEMAP,
): readonly (readonly SitemapEntry[])[] {
  if (size <= 0) throw new RangeError('chunk size must be positive');
  const chunks: SitemapEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) chunks.push([...entries.slice(i, i + size)]);
  return chunks;
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
