/**
 * XML serialisation for sitemaps and feeds.
 *
 * Written by hand rather than pulled from a library, and the reason is not
 * minimalism. A feed builder is a dependency that decides how *your* content is
 * escaped, and every one of the bugs that matters here is an escaping bug: a title
 * containing `&` that breaks a feed reader, or a generated title containing `]]>`
 * that closes a CDATA section early and lets arbitrary markup into a document
 * thousands of aggregators will parse. MORPH generates its own titles with a
 * language model, so hostile-shaped content is the normal case, not the edge case.
 *
 * Everything here is pure and exhaustively tested against exactly those inputs.
 */

/**
 * Escape text for an XML text node or attribute value.
 *
 * All five predefined entities, in an order that cannot double-escape: `&` first,
 * always. Reversing that turns `<` into `&amp;lt;` and every consumer renders the
 * literal string `&lt;`.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Characters that are illegal in XML 1.0 at any level of escaping.
 *
 * Built from escape sequences rather than written literally: a literal control
 * character in source is invisible in review, survives a copy-paste, and is exactly
 * the kind of thing this pattern exists to remove.
 */
const INVALID_XML_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex -- matching control characters is the entire purpose of this pattern
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]',
  'g',
);

/**
 * Strip characters that are illegal in XML 1.0 at any level of escaping.
 *
 * Control characters below 0x20 (other than tab, newline and carriage return) cannot
 * be represented in XML *at all* — not even as a numeric entity. A single stray 0x0B
 * in a generated excerpt makes the whole document unparseable, and the failure is
 * reported by the consumer, days later, as "your feed is broken".
 */
export function stripInvalidXmlChars(value: string): string {
  return value.replace(INVALID_XML_CHARS, '');
}

/** Escape and sanitise in the order that is safe. */
export function xmlText(value: string): string {
  return escapeXml(stripInvalidXmlChars(value));
}

/**
 * Wrap content in CDATA, defusing any sequence that would close the section early.
 *
 * `]]>` inside CDATA is not escapable; the only correct handling is to split the
 * section around it. Feed readers concatenate adjacent CDATA sections, so the result
 * is identical text with no way to escape the container.
 */
export function cdata(value: string): string {
  const safe = stripInvalidXmlChars(value).split(']]>').join(']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/**
 * Absolute URL for a feed or sitemap entry.
 *
 * Both formats require absolute URLs, and a relative one is accepted by most parsers
 * and resolved against the wrong base by the rest. Failing loudly here is better than
 * discovering it in a search console six weeks later.
 */
export function absoluteUrl(base: string, path: string): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Refusing to emit a non-http(s) URL: ${url.protocol}`);
  }
  return url.toString();
}

/** ISO-8601 with no fractional seconds, which is what sitemap consumers expect. */
export function isoDate(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** RFC 822, required by RSS 2.0. Deliberately not `toUTCString`, which differs subtly. */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function rfc822(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    `${DAYS[date.getUTCDay()] ?? 'Sun'},`,
    pad(date.getUTCDate()),
    MONTHS[date.getUTCMonth()] ?? 'Jan',
    String(date.getUTCFullYear()),
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
    'GMT',
  ].join(' ');
}
