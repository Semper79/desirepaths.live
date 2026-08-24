/**
 * Telegram MarkdownV2 formatting.
 *
 * MarkdownV2 is unforgiving: a single unescaped `.` or `-` anywhere in the message
 * makes the whole `sendMessage` call fail with a 400, and the report simply does not
 * arrive. Since almost every line of the hourly report contains a decimal point, a
 * hyphen or a percent-adjacent character, escaping cannot be an afterthought.
 *
 * The approach here: build the report as *structured lines*, and let this module be
 * the only place that produces MarkdownV2 text. Nothing upstream concatenates
 * markup by hand.
 */

/** Characters Telegram requires to be backslash-escaped in MarkdownV2. */
const RESERVED = new Set([
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
  '>',
  '#',
  '+',
  '-',
  '=',
  '|',
  '{',
  '}',
  '.',
  '!',
]);

/** Escape arbitrary text for MarkdownV2 body content. */
export function escape(text: string): string {
  let out = '';
  for (const ch of text) out += RESERVED.has(ch) ? `\\${ch}` : ch;
  return out;
}

/**
 * Escape text destined for inside a code span or code block.
 *
 * Telegram's rules differ inside code: only a backtick and a backslash need
 * escaping, and escaping a `.` there would render the backslash literally. Using
 * the wrong escaper produces a message that arrives looking corrupted, which is
 * worse than one that fails outright.
 */
export function escapeCode(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

export const bold = (text: string): string => `*${escape(text)}*`;
export const italic = (text: string): string => `_${escape(text)}_`;
export const code = (text: string): string => `\`${escapeCode(text)}\``;
export const link = (text: string, url: string): string =>
  `[${escape(text)}](${url.replace(/[)\\]/g, (m) => `\\${m}`)})`;

/** Telegram's hard limit on a single message. */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Split a composed report into sendable messages.
 *
 * Splits on line boundaries so a message never ends mid-escape-sequence, which
 * would break the markup of both halves. A single line longer than the limit is
 * hard-split as a last resort - it should never happen, and silently dropping it
 * would be worse than an ugly break.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): readonly string[] {
  if (text.length <= limit) return [text];

  const messages: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current.length > 0) {
        messages.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) messages.push(line.slice(i, i + limit));
      continue;
    }

    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > limit) {
      messages.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) messages.push(current);
  return messages;
}

/**
 * Format a signed delta the way an operator reads it: sign always present, so a
 * flat hour is visibly flat rather than ambiguously missing.
 */
export function delta(value: number, unit: '%' | 'pp' | '' = '%', digits = 1): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${Math.abs(value).toFixed(digits)}${unit}`;
}

/** Compact large counts: 1234 -> 1.2k, 1234567 -> 1.2M. */
export function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function percent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Pack whole sections into messages without ever splitting one across two.
 *
 * `splitMessage` breaks at the nearest line, which is correct for arbitrary text and
 * wrong for a report: it happily leaves a section heading alone at the bottom of one
 * message with its content at the top of the next, which reads like a bug. Sections
 * are the natural seam, so seams are what this splits on. A single section larger
 * than the limit still falls back to a line split - better an ugly break than a
 * dropped section.
 */
export function packSections(
  sections: readonly string[],
  limit = MAX_MESSAGE_LENGTH,
): readonly string[] {
  const messages: string[] = [];
  let current = '';

  for (const section of sections) {
    const candidate = current.length === 0 ? section : `${current}\n\n${section}`;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      messages.push(current);
      current = '';
    }

    if (section.length <= limit) {
      current = section;
    } else {
      for (const chunk of splitMessage(section, limit)) messages.push(chunk);
    }
  }

  if (current.length > 0) messages.push(current);
  return messages;
}
