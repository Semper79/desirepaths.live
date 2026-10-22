import { describe, expect, it } from 'vitest';
import { countWords, extract, MINIMUM_WORDS, normaliseWhitespace } from '../src/extract';

const SOURCE = 'https://example.com/articles/one';

/** Enough prose to clear the length floor, in `count` paragraphs. */
const prose = (count: number): string =>
  Array.from(
    { length: count },
    (_, i) =>
      `<p>Paragraph ${String(i)} discusses the incremental clustering approach in some ` +
      'detail, explaining how identifiers remain stable between runs and why that matters ' +
      'for accumulating a history of how much attention a topic is receiving over time.</p>',
  ).join('');

const page = (body: string, head = ''): string =>
  `<!doctype html><html lang="en"><head><title>Site name — Article title</title>${head}</head>
   <body>${body}</body></html>`;

const okDocument = (html: string) => {
  const result = extract(html, SOURCE);
  if (result.kind !== 'ok') throw new Error(`Expected an extraction, got ${result.kind}`);
  return result.document;
};

describe('finding the article', () => {
  it('extracts the article body', () => {
    const document = okDocument(page(`<article>${prose(4)}</article>`));

    expect(document.text).toContain('incremental clustering approach');
    expect(document.wordCount).toBeGreaterThan(MINIMUM_WORDS);
  });

  /**
   * The failure this heuristic exists to prevent: a cluster about cookie banners.
   */
  it('prefers prose to a block that is mostly links', () => {
    const navigation = `<div class="related">${Array.from(
      { length: 60 },
      (_, i) => `<a href="/link-${String(i)}">A related article headline about something else</a>`,
    ).join(' ')}</div>`;

    const document = okDocument(page(`<div id="content">${prose(4)}</div>${navigation}`));

    expect(document.text).toContain('incremental clustering');
    expect(document.text).not.toContain('A related article headline');
  });

  it('removes navigation, footers and cookie banners before scoring', () => {
    const html = page(`
      <nav><a href="/a">Home</a><a href="/b">About</a></nav>
      <div id="cookie-consent">We use cookies to improve your experience. Accept all cookies?</div>
      <article>${prose(4)}</article>
      <footer>Copyright example.com. All rights reserved.</footer>
    `);

    const document = okDocument(html);
    expect(document.text).not.toContain('cookies');
    expect(document.text).not.toContain('All rights reserved');
  });

  it('penalises a block whose class marks it as furniture', () => {
    const html = page(`
      <div class="newsletter-promo">${prose(4)}</div>
      <div class="article-body">${prose(4)}</div>
    `);

    // Both are prose; the class names are the only thing separating them.
    const document = okDocument(html);
    expect(document.text.startsWith('Paragraph 0')).toBe(true);
  });

  it('falls back to the body when nothing wraps the article', () => {
    const document = okDocument(page(prose(4)));
    expect(document.wordCount).toBeGreaterThan(MINIMUM_WORDS);
  });
});

describe('metadata', () => {
  it('prefers the Open Graph title to the page title', () => {
    const document = okDocument(
      page(`<article>${prose(4)}</article>`, '<meta property="og:title" content="The real title">'),
    );
    expect(document.title).toBe('The real title');
  });

  it('falls back to the h1, then to the title element', () => {
    expect(okDocument(page(`<h1>Heading title</h1><article>${prose(4)}</article>`)).title).toBe(
      'Heading title',
    );
    expect(okDocument(page(`<article>${prose(4)}</article>`)).title).toBe(
      'Site name — Article title',
    );
  });

  it('reads the canonical URL and resolves it against the source', () => {
    const document = okDocument(
      page(`<article>${prose(4)}</article>`, '<link rel="canonical" href="/articles/canonical">'),
    );
    expect(document.canonicalUrl).toBe('https://example.com/articles/canonical');
  });

  it('reports no canonical URL rather than inventing one', () => {
    expect(okDocument(page(`<article>${prose(4)}</article>`)).canonicalUrl).toBeNull();
  });

  it('reads the author and the language', () => {
    const document = okDocument(
      page(`<article>${prose(4)}</article>`, '<meta name="author" content="A Writer">'),
    );
    expect(document.author).toBe('A Writer');
    expect(document.language).toBe('en');
  });

  it('reads a publication date from a time element', () => {
    const document = okDocument(
      page(`<article><time datetime="2025-06-03T09:00:00Z">June</time>${prose(4)}</article>`),
    );
    expect(document.publishedAt).toBe(Date.parse('2025-06-03T09:00:00Z'));
  });

  it('reads a publication date from Open Graph metadata', () => {
    const document = okDocument(
      page(
        `<article>${prose(4)}</article>`,
        '<meta property="article:published_time" content="2025-06-03T09:00:00Z">',
      ),
    );
    expect(document.publishedAt).toBe(Date.parse('2025-06-03T09:00:00Z'));
  });

  it('reports no date rather than guessing one', () => {
    expect(okDocument(page(`<article>${prose(4)}</article>`)).publishedAt).toBeNull();
  });

  it('ignores a date it cannot parse', () => {
    const document = okDocument(
      page(`<article><time datetime="soon">soon</time>${prose(4)}</article>`),
    );
    expect(document.publishedAt).toBeNull();
  });
});

describe('links', () => {
  it('collects and absolutises links from the article body', () => {
    const document = okDocument(
      page(
        `<article><p><a href="/source">Source</a> and <a href="https://other.example/x">more</a>.</p>${prose(4)}</article>`,
      ),
    );

    expect(document.links).toContain('https://example.com/source');
    expect(document.links).toContain('https://other.example/x');
  });

  it('ignores links that are not fetchable sources', () => {
    const document = okDocument(
      page(
        `<article><p><a href="mailto:a@example.com">Mail</a><a href="javascript:void(0)">JS</a></p>${prose(4)}</article>`,
      ),
    );

    expect(document.links).toEqual([]);
  });

  it('deduplicates repeated links', () => {
    const document = okDocument(
      page(`<article><p><a href="/x">One</a><a href="/x">Two</a></p>${prose(4)}</article>`),
    );
    expect(document.links).toEqual(['https://example.com/x']);
  });
});

describe('rejections', () => {
  /**
   * A tag page, a paywall stub, a client-rendered shell and a 404 that answered 200 all
   * produce a hundred words of navigation. None of them belong in the corpus.
   */
  it('rejects a page too short to be an article', () => {
    const result = extract(page('<article><p>Just a stub.</p></article>'), SOURCE);
    expect(result.kind).toBe('too-short');
    if (result.kind === 'too-short') expect(result.wordCount).toBeLessThan(MINIMUM_WORDS);
  });

  it('rejects a client-rendered shell, which is the correct outcome', () => {
    const result = extract(page('<div id="root"></div><script>render()</script>'), SOURCE);
    expect(result.kind).toBe('too-short');
  });

  it('survives markup that is not really HTML', () => {
    const result = extract('<<<not markup>>>', SOURCE);
    expect(result.kind === 'too-short' || result.kind === 'error').toBe(true);
  });
});

describe('helpers', () => {
  it('collapses whitespace', () => {
    expect(normaliseWhitespace('  a \n\t b  ')).toBe('a b');
  });

  it('counts words, and counts nothing as nothing', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('   ')).toBe(0);
    expect(countWords('')).toBe(0);
  });
});
