import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  cdata,
  escapeXml,
  isoDate,
  rfc822,
  stripInvalidXmlChars,
  xmlText,
} from '../src/xml';
import { escapeHtmlAttribute, escapeJsonLd, singleLine } from '../src/embed';

/**
 * MORPH generates its own titles and excerpts with a language model, so hostile-shaped
 * content is the normal case rather than the edge case. Every test here uses an input
 * a generator could plausibly produce.
 */

describe('escapeXml', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    // Reversing the order yields `&amp;lt;` and every consumer renders `&lt;`.
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeXml('Why your watch is becoming the interface')).toBe(
      'Why your watch is becoming the interface',
    );
  });

  it('handles a title a generator would actually produce', () => {
    expect(escapeXml('R&D, "ambient" computing & you')).toBe(
      'R&amp;D, &quot;ambient&quot; computing &amp; you',
    );
  });
});

describe('stripInvalidXmlChars', () => {
  it('removes control characters that XML cannot represent at all', () => {
    const withVerticalTab = `title${String.fromCharCode(0x0b)}here`;
    expect(stripInvalidXmlChars(withVerticalTab)).toBe('titlehere');
    expect(stripInvalidXmlChars(`a${String.fromCharCode(0x00)}b`)).toBe('ab');
    expect(stripInvalidXmlChars(`a${String.fromCharCode(0x1f)}b`)).toBe('ab');
  });

  it('keeps tab, newline and carriage return, which are legal', () => {
    expect(stripInvalidXmlChars('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('removes the non-characters U+FFFE and U+FFFF', () => {
    expect(stripInvalidXmlChars(`a${String.fromCharCode(0xfffe)}b`)).toBe('ab');
  });

  it('leaves ordinary unicode intact', () => {
    expect(stripInvalidXmlChars('caffè — 日本語 — 🎉')).toBe('caffè — 日本語 — 🎉');
  });
});

describe('xmlText', () => {
  it('sanitises then escapes', () => {
    expect(xmlText(`R&D${String.fromCharCode(0x0b)}`)).toBe('R&amp;D');
  });
});

describe('cdata', () => {
  it('wraps ordinary content', () => {
    expect(cdata('hello')).toBe('<![CDATA[hello]]>');
  });

  /**
   * The one that matters. `]]>` inside CDATA is not escapable; the only correct
   * handling is to split the section around it. Without this, a generated excerpt
   * containing that sequence closes the section early and injects raw markup into a
   * document thousands of aggregators parse.
   */
  it('defuses a sequence that would close the section early', () => {
    const hostile = 'before ]]> <script>alert(1)</script> after';
    const wrapped = cdata(hostile);

    // The dangerous sequence no longer appears followed by content outside a section.
    expect(wrapped).toContain(']]]]><![CDATA[>');
    // Reassembling every CDATA section recovers the original text exactly, which is
    // what a conforming parser does.
    const recovered = wrapped.split('<![CDATA[').join('').split(']]>').join('');
    expect(recovered).toBe(hostile);
  });

  it('handles repeated hostile sequences', () => {
    const hostile = ']]>]]>]]>';
    const recovered = cdata(hostile).split('<![CDATA[').join('').split(']]>').join('');
    expect(recovered).toBe(hostile);
  });

  it('strips invalid characters inside the section too', () => {
    expect(cdata(`a${String.fromCharCode(0x0c)}b`)).toBe('<![CDATA[ab]]>');
  });
});

describe('absoluteUrl', () => {
  it('resolves a path against an origin', () => {
    expect(absoluteUrl('https://morph.example', '/t/x')).toBe('https://morph.example/t/x');
    expect(absoluteUrl('https://morph.example/', '/t/x')).toBe('https://morph.example/t/x');
  });

  it('refuses a scheme that has no business in a feed', () => {
    expect(() => absoluteUrl('https://morph.example', 'javascript:alert(1)')).toThrow(
      /non-http\(s\) URL/,
    );
    expect(() => absoluteUrl('https://morph.example', 'data:text/html,x')).toThrow();
  });

  it('keeps an already-absolute URL', () => {
    expect(absoluteUrl('https://morph.example', 'https://other.example/a')).toBe(
      'https://other.example/a',
    );
  });
});

describe('date formats', () => {
  const at = new Date('2026-08-24T14:30:05.123Z');

  it('emits ISO without fractional seconds for sitemaps', () => {
    expect(isoDate(at)).toBe('2026-08-24T14:30:05Z');
  });

  it('emits RFC 822 for RSS', () => {
    expect(rfc822(at)).toBe('Mon, 24 Aug 2026 14:30:05 GMT');
  });

  it('pads single digits', () => {
    expect(rfc822(new Date('2026-01-05T04:03:02.000Z'))).toBe('Mon, 05 Jan 2026 04:03:02 GMT');
  });
});

describe('escapeJsonLd', () => {
  /**
   * HTML's tokeniser ends a script element at the first `</script`, wherever it
   * appears — including inside a JSON string literal. A generated title containing it
   * is an XSS vector, and "the model would not write that" is not a security control.
   */
  it('defuses a script-closing sequence in generated content', () => {
    const payload = JSON.stringify({ headline: '</script><img src=x onerror=alert(1)>' });
    const escaped = escapeJsonLd(payload);

    expect(escaped).not.toContain('</script');
    expect(escaped).not.toContain('<img');
    // Still valid JSON with the original value intact.
    expect(JSON.parse(escaped)).toEqual({ headline: '</script><img src=x onerror=alert(1)>' });
  });

  it('defuses comment delimiters', () => {
    const escaped = escapeJsonLd(JSON.stringify({ a: '<!--', b: '-->' }));
    expect(escaped).not.toContain('<!--');
    expect(escaped).not.toContain('-->');
    expect(JSON.parse(escaped)).toEqual({ a: '<!--', b: '-->' });
  });

  it('escapes JavaScript line terminators that are legal in JSON', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const escaped = escapeJsonLd(JSON.stringify({ a: `x${ls}y`, b: `x${ps}y` }));

    expect(escaped).not.toContain(ls);
    expect(escaped).not.toContain(ps);
    expect(JSON.parse(escaped)).toEqual({ a: `x${ls}y`, b: `x${ps}y` });
  });

  it('leaves ordinary structured data untouched', () => {
    const payload = JSON.stringify({ '@type': 'Article', headline: 'Ambient computing' });
    expect(JSON.parse(escapeJsonLd(payload))).toEqual(JSON.parse(payload));
  });
});

describe('escapeHtmlAttribute', () => {
  it('escapes both quote styles, because either may delimit an attribute', () => {
    expect(escapeHtmlAttribute(`a"b'c`)).toBe('a&quot;b&#39;c');
  });

  it('escapes the ampersand first', () => {
    expect(escapeHtmlAttribute('&amp;')).toBe('&amp;amp;');
  });

  it('defuses an attribute breakout', () => {
    const escaped = escapeHtmlAttribute('" onload="alert(1)');
    expect(escaped).not.toContain('"');
  });
});

describe('singleLine', () => {
  it('collapses whitespace', () => {
    expect(singleLine('a\n\n  b\tc', 100)).toBe('a b c');
  });

  it('returns short text unchanged', () => {
    expect(singleLine('short', 100)).toBe('short');
  });

  it('truncates on a word boundary with an ellipsis', () => {
    const result = singleLine('the quick brown fox jumps over the lazy dog', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toContain('fo…');
  });

  it('hard-cuts a token longer than the budget rather than returning nothing', () => {
    const result = singleLine(`x${'y'.repeat(200)}`, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles a zero or negative budget', () => {
    expect(singleLine('anything', 0)).toBe('');
    expect(singleLine('anything', -5)).toBe('');
  });
});
