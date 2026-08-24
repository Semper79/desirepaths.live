/**
 * @morph/seo - structured data, sitemaps, feeds and AEO surfaces.
 *
 * Pure and dependency-free, for the same reason `packages/adaptive` is: everything
 * here is a serialisation whose bugs are invisible until a third party parses the
 * output, so it has to be testable without a browser, a server or a network.
 *
 * The one architectural rule this package encodes: **the adaptive layer never reaches
 * the canonical URL.** A page is one page regardless of which hero headline a visitor
 * was shown, and there is deliberately no way to put a variant id into a canonical,
 * a sitemap entry or a feed item. See the note at the top of `meta.ts`.
 */

export * from './xml.js';
export * from './embed.js';
export * from './jsonld.js';
export * from './sitemap.js';
export * from './feed.js';
export * from './aeo.js';
export * from './meta.js';
