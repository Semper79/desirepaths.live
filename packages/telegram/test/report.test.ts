import { describe, expect, it } from 'vitest';
import {
  bold,
  code,
  compact,
  delta,
  escape,
  escapeCode,
  italic,
  link,
  MAX_MESSAGE_LENGTH,
  packSections,
  percent,
  splitMessage,
} from '../src/markdown.js';
import { composeBrief, composeReport, isQuietHour } from '../src/compose.js';
import { SAMPLE_QUIET_INPUT, SAMPLE_REPORT_INPUT } from '../src/sample.js';
import type { ReportInput } from '../src/types.js';

/** Every character Telegram requires to be escaped in MarkdownV2 body text. */
const RESERVED = '_*[]()~`>#+-=|{}.!';

describe('MarkdownV2 escaping', () => {
  it('escapes every reserved character', () => {
    for (const ch of RESERVED) {
      expect(escape(ch), ch).toBe(`\\${ch}`);
    }
  });

  it('leaves ordinary text alone', () => {
    expect(escape('hello world')).toBe('hello world');
    expect(escape('100%')).toBe('100%');
  });

  it('escapes only backticks and backslashes inside code', () => {
    expect(escapeCode('a.b-c')).toBe('a.b-c');
    expect(escapeCode('`x`')).toBe('\\`x\\`');
    expect(escapeCode('a\\b')).toBe('a\\\\b');
  });

  it('wraps text in the right markers', () => {
    expect(bold('hi')).toBe('*hi*');
    expect(italic('hi')).toBe('_hi_');
    expect(code('hero.headline#v0')).toBe('`hero.headline#v0`');
    // Telegram escapes only `)` and `\` inside a link target - an opening bracket
    // is unambiguous there and escaping it would render the backslash literally.
    expect(link('docs', 'https://example.com/a(b)')).toBe('[docs](https://example.com/a(b\\))');
  });
});

describe('splitMessage', () => {
  it('leaves a short message alone', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits on line boundaries', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 60 }, () => line).join('\n');
    const parts = splitMessage(text, 1_000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1_000);
    // Nothing is lost: rejoining restores the original text.
    expect(parts.join('\n')).toBe(text);
  });

  it('hard-splits a single over-long line rather than dropping it', () => {
    const parts = splitMessage('y'.repeat(2_500), 1_000);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toBe('y'.repeat(2_500));
  });

  it('handles an over-long line following normal lines', () => {
    const parts = splitMessage(`short\n${'z'.repeat(1_500)}\ntail`, 1_000);
    expect(parts[0]).toBe('short');
    expect(parts.at(-1)).toBe('tail');
  });
});

describe('number formatting', () => {
  it('always shows the sign of a delta', () => {
    expect(delta(21.2)).toBe('+21.2%');
    expect(delta(-3.8)).toBe('−3.8%');
    expect(delta(0)).toBe('±0.0%');
    expect(delta(-3.8, 'pp')).toBe('−3.8pp');
    expect(delta(41, '', 0)).toBe('+41');
  });

  it('compacts large counts', () => {
    expect(compact(942)).toBe('942');
    expect(compact(18_432)).toBe('18.4k');
    expect(compact(2_400_000)).toBe('2.4M');
    expect(compact(-1_500)).toBe('-1.5k');
  });

  it('formats percentages', () => {
    expect(percent(0.0228, 2)).toBe('2.28%');
    expect(percent(0.612)).toBe('61.2%');
  });
});

describe('quiet-hour discipline', () => {
  it('recognises an hour with nothing in it', () => {
    expect(isQuietHour(SAMPLE_QUIET_INPUT)).toBe(true);
    expect(composeReport(SAMPLE_QUIET_INPUT).kind).toBe('brief');
  });

  it('sends the full report the moment anything happens', () => {
    const cases: readonly Partial<ReportInput>[] = [
      { alerts: [{ severity: 'critical', title: 'x', detail: 'y' }] },
      {
        adaptation: {
          ...SAMPLE_QUIET_INPUT.adaptation,
          entries: [
            {
              action: 'promoted',
              surfaceId: 's',
              variantId: 's#v',
              variantLabel: 'V',
              reason: 'because',
            },
          ],
        },
      },
      { conversion: { ...SAMPLE_QUIET_INPUT.conversion, signups: 1 } },
      { web: { ...SAMPLE_QUIET_INPUT.web, published: [{ title: 't', slug: 's' }] } },
      { social: { ...SAMPLE_QUIET_INPUT.social, awaitingApproval: 1 } },
      { traffic: { ...SAMPLE_QUIET_INPUT.traffic, sessions: 500 } },
    ];

    for (const patch of cases) {
      expect(isQuietHour({ ...SAMPLE_QUIET_INPUT, ...patch })).toBe(false);
    }
  });

  it('keeps the brief to one short line', () => {
    const brief = composeBrief(SAMPLE_QUIET_INPUT);
    expect(brief.split('\n')).toHaveLength(1);
    expect(brief.length).toBeLessThan(200);
  });
});

describe('the full hourly report', () => {
  const report = composeReport(SAMPLE_REPORT_INPUT);

  it('is a full report for a busy hour', () => {
    expect(report.kind).toBe('full');
  });

  it('fits Telegram message limits', () => {
    for (const m of report.messages) expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it('contains all nine sections from the specification', () => {
    const text = report.messages.join('\n');
    for (const heading of [
      'hourly report',
      'Traffic',
      'Conversion',
      'How MORPH reacted',
      'What the web is saying',
      'Social',
      'Holdout lift',
      'Anomalies',
      'Next hour',
    ]) {
      expect(text, heading).toContain(escape(heading).replace(/\\/g, '\\'));
    }
  });

  it('never leaves a reserved character unescaped outside code spans', () => {
    // The check that matters: an unescaped `.` or `-` is a 400 from Telegram and a
    // report that simply never arrives.
    for (const message of report.messages) {
      const withoutCode = message.replace(/`[^`]*`/g, '');
      for (let i = 0; i < withoutCode.length; i += 1) {
        const ch = withoutCode[i] as string;
        if (!RESERVED.includes(ch)) continue;
        // Emphasis markers we emit deliberately are the only exception.
        if (ch === '*' || ch === '_') continue;
        expect(withoutCode[i - 1], `unescaped ${ch} at ${String(i)} in: ${withoutCode.slice(Math.max(0, i - 40), i + 10)}`).toBe('\\');
      }
    }
  });

  it('compares against the same hour last week, never against last hour', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('same hour last week');
    expect(text).not.toContain('vs last hour');
  });

  it('names the largest funnel regression explicitly', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('Largest regression');
    expect(text).toContain('signup\\_start');
  });

  it('quotes the statistical justification for every adaptation', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('96% probability of being worse');
    expect(text).toContain('always\\-valid p');
    expect(text).toContain('rollback guardrail');
  });

  it('describes the live theme in words', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('dark\\-neon');
    expect(text).toContain('grotesk');
    expect(text).toContain('motion subtle');
  });

  it('reports holdout lift, which is the number that justifies the system', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('Holdout lift');
    expect(text).toContain('+18\\.4%');
    expect(text).toContain('+16\\.3%');
  });

  it('says what the safety classifier rejected, and why', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('political/electoral');
    expect(text).toContain('unverified breaking news');
  });

  it('surfaces what needs a human', () => {
    const text = report.messages.join('\n');
    expect(text).toContain('Needs you');
    expect(text).toContain('approval queue');
  });

  it('stamps the reward weight version, so epochs are never silently compared', () => {
    expect(report.messages.join('\n')).toContain('reward weights v3');
  });

  it('handles an hour with no alerts and no adaptations but real traffic', () => {
    const calm: ReportInput = {
      ...SAMPLE_REPORT_INPUT,
      alerts: [],
      adaptation: { ...SAMPLE_REPORT_INPUT.adaptation, entries: [] },
      next: { intentions: ['Keep learning.'], needsOperator: [] },
    };
    const text = composeReport(calm).messages.join('\n');
    expect(text).toContain('No adaptations this hour');
    expect(text).toContain('Nothing to report');
    expect(text).not.toContain('Needs you');
  });

  it('omits empty web-intelligence blocks rather than printing empty headings', () => {
    const bare: ReportInput = {
      ...SAMPLE_REPORT_INPUT,
      web: {
        documentsFetched: 12,
        hostsCrawled: 3,
        newClusters: [],
        published: [],
        queued: [],
        rejected: [],
      },
    };
    const text = composeReport(bare).messages.join('\n');
    expect(text).not.toContain('New clusters');
    expect(text).not.toContain('Rejected by the safety classifier');
  });

  it('is deterministic', () => {
    expect(composeReport(SAMPLE_REPORT_INPUT)).toEqual(composeReport(SAMPLE_REPORT_INPUT));
  });
});

describe('packSections', () => {
  it('keeps sections whole when they fit', () => {
    expect(packSections(['a', 'b', 'c'], 100)).toEqual(['a\n\nb\n\nc']);
  });

  it('starts a new message rather than splitting a section', () => {
    const section = 'x'.repeat(40);
    const packed = packSections([section, section, section], 90);
    expect(packed).toHaveLength(2);
    for (const m of packed) expect(m.length).toBeLessThanOrEqual(90);
  });

  it('falls back to a line split for a section larger than the limit', () => {
    const huge = Array.from({ length: 30 }, () => 'y'.repeat(20)).join('\n');
    const packed = packSections(['small', huge], 100);
    expect(packed[0]).toBe('small');
    for (const m of packed) expect(m.length).toBeLessThanOrEqual(100);
    expect(packed.slice(1).join('\n')).toBe(huge);
  });

  it('handles an empty section list', () => {
    expect(packSections([], 100)).toEqual([]);
  });

  it('never orphans a section heading at the end of a message', () => {
    const report = composeReport(SAMPLE_REPORT_INPUT);
    for (const message of report.messages) {
      const lastLine = message.trimEnd().split('\n').at(-1) ?? '';
      // A bold-only line is a heading. One at the very end means its content
      // landed in the next message, which reads like a rendering bug.
      expect(/^\*[^*]+\*$/.test(lastLine), lastLine).toBe(false);
    }
  });
});
