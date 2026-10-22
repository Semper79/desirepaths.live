/**
 * `pnpm report:sample` - print the worked example of the hourly report.
 *
 * Two forms: the raw MarkdownV2 that would be sent, and a readable render with the
 * escapes stripped. The second is what section 5 of the specification asks for; the
 * first is what Telegram actually receives, and seeing both side by side is how you
 * catch an escaping bug before it becomes a 400 at 03:00.
 */

import { composeReport } from './compose';
import { SAMPLE_QUIET_INPUT, SAMPLE_REPORT_INPUT } from './sample';

/** Strip MarkdownV2 backslash escapes for human reading. Never used to send. */
const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

const full = composeReport(SAMPLE_REPORT_INPUT);
const quiet = composeReport(SAMPLE_QUIET_INPUT);

const rule = '='.repeat(72);

const out: string[] = [
  rule,
  `FULL REPORT — ${String(full.charCount)} characters, ${String(full.messages.length)} message(s)`,
  rule,
  '',
  full.messages.map(unescape).join('\n\n--- message break ---\n\n'),
  '',
  rule,
  `QUIET HOUR — ${String(quiet.charCount)} characters`,
  rule,
  '',
  quiet.messages.map(unescape).join('\n'),
  '',
];

process.stdout.write(`${out.join('\n')}\n`);
