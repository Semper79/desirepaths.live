/**
 * Safe embedding of generated data into HTML.
 *
 * MORPH puts model-generated strings — article titles, excerpts, headline variants —
 * inside `<script>` elements. HTML's tokeniser does not care that it is looking at
 * JSON: it ends a script element at the first `</script`, wherever that appears, even
 * inside a string literal. A generated title containing that sequence is therefore an
 * XSS vector, and "the model would not write that" is not a security control.
 *
 * The sequences handled below are the complete set that can break out of a script
 * element or break a JSON parser. Each is replaced with a unicode escape, which is
 * byte-for-byte equivalent after `JSON.parse` and inert to the HTML tokeniser.
 */

/**
 * The two JavaScript line terminators that are legal inside a JSON string.
 *
 * Constructed from code points rather than written literally: a literal U+2028 in
 * source is invisible in every editor and every diff, which is exactly why it is
 * dangerous enough in output to be worth escaping in the first place.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LINE_TERMINATORS = new RegExp(`[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g');

/**
 * Escape a JSON string for embedding in a `<script>` element.
 *
 * - `<` defuses `</script>` and `<!--`
 * - `>` defuses `-->`
 * - U+2028 and U+2029 are line terminators in JavaScript but not in JSON; an
 *   unescaped one turns a valid document into a syntax error in older parsers.
 */
export function escapeJsonLd(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(LINE_TERMINATORS, (ch) => (ch === LINE_SEPARATOR ? '\\u2028' : '\\u2029'));
}

/**
 * Escape text for an HTML attribute value.
 *
 * Used for meta tag content, which carries generated descriptions. Quotes are escaped
 * both ways because an attribute may be delimited by either, and a serialiser that
 * assumes double quotes is one template change away from being wrong.
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Collapse a generated string to a single line of bounded length.
 *
 * Meta descriptions and OG titles are single-line by specification, and a newline in
 * one is silently truncated by some crawlers and passed through by others. Truncation
 * happens on a word boundary with an ellipsis, because a description cut mid-word
 * reads as broken rather than as abridged.
 */
export function singleLine(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';

  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;

  const cut = flat.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // A "word" longer than most of the budget is not a word — a URL, a hash, a token.
  // Hard-cut those rather than return almost nothing.
  const body = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
