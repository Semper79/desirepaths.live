/**
 * The hourly report.
 *
 * Section 5 of the specification, rendered deterministically. Everything printed here
 * comes from `ReportInput`; nothing is inferred, rounded twice, or invented.
 *
 * DELIVERY DISCIPLINE (section 5, "Delivery discipline")
 * "If nothing meaningful happened in an hour, send a single-line summary instead of
 * the full report - a report that is always long is a report nobody reads." That is
 * implemented by `isQuietHour` and honoured by `composeReport`, not left to the
 * operator's judgement at 04:00.
 */

import { bold, code, compact, delta, escape, italic, packSections, percent } from './markdown.js';
import type { Alert, ReportInput, ServiceHealth } from './types.js';

const STATUS_ICON: Record<ServiceHealth['status'], string> = {
  up: '🟢',
  degraded: '🟡',
  down: '🔴',
};

const SEVERITY_ICON: Record<Alert['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

const ACTION_ICON: Record<string, string> = {
  generated: '🌱',
  promoted: '⬆️',
  retired: '⬇️',
  quarantined: '🚧',
  released: '🔓',
  pinned: '📌',
  rolled_back: '↩️',
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

function formatHour(iso: string, timezone: string): string {
  // The input is already in the operator's local time; this only reformats it.
  // Doing timezone conversion here would mean two places could disagree about what
  // "this hour" means, and the report is the one place that must not.
  const [date = '', rest = ''] = iso.split('T');
  const hh = rest.slice(0, 5);
  const endHour = String((Number.parseInt(hh.slice(0, 2), 10) + 1) % 24).padStart(2, '0');
  return `${date} ${hh}–${endHour}:00 ${timezone}`;
}

/**
 * Did anything happen worth a full report?
 *
 * The threshold is deliberately generous: an hour with real traffic, any sign-up,
 * any adaptation, any published content or any alert is a full report. What this
 * filters out is the 04:00 hour on a Tuesday with eleven sessions and no decisions -
 * which on a young-audience site is most of the night.
 */
export function isQuietHour(input: ReportInput): boolean {
  if (input.alerts.length > 0) return false;
  if (input.adaptation.entries.length > 0) return false;
  if (input.conversion.signups > 0) return false;
  if (input.web.published.length > 0) return false;
  if (input.social.awaitingApproval > 0) return false;
  if (input.traffic.sessions >= 50) return false;
  return true;
}

/** The one-line form. */
export function composeBrief(input: ReportInput): string {
  const parts = [
    `${bold('MORPH')} ${escape(formatHour(input.hourStart, input.timezone))}`,
    `${escape(compact(input.traffic.sessions))} sessions, ${escape(String(input.conversion.signups))} sign\\-ups, no adaptations, all green\\.`,
  ];
  return parts.join(' · ');
}

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

function header(input: ReportInput): string {
  const health = input.services.map((s) => `${STATUS_ICON[s.status]} ${escape(s.name)}`).join('  ');
  return [
    bold('MORPH · hourly report'),
    `${escape(formatHour(input.hourStart, input.timezone))} · uptime ${escape(formatUptime(input.uptimeSeconds))}`,
    health,
  ].join('\n');
}

function traffic(input: ReportInput): string {
  const t = input.traffic;
  const rows = (
    label: string,
    items: readonly { label: string; value: number; deltaVsLastWeek: number }[],
  ): string =>
    [
      italic(label),
      ...items.map(
        (r) =>
          `  ${escape(r.label)} — ${escape(compact(r.value))} ${escape(`(${delta(r.deltaVsLastWeek * 100)})`)}`,
      ),
    ].join('\n');

  return [
    bold('1 · Traffic'),
    `${escape(compact(t.sessions))} sessions ${escape(`(${delta(t.sessionsDeltaVsLastWeek * 100)} vs same hour last week)`)}`,
    `${escape(compact(t.uniques))} uniques · ${escape(compact(t.pageviews))} pageviews · ${escape(`${compact(t.newVisitors)} new / ${compact(t.returningVisitors)} returning`)}`,
    '',
    rows('Sources', t.topSources),
    '',
    rows('Countries', t.topCountries),
    '',
    rows('Pages', t.topPages),
  ].join('\n');
}

function conversion(input: ReportInput): string {
  const c = input.conversion;

  // Name the largest regression explicitly. An operator scanning on a phone should
  // not have to compare five numbers to find the one that moved.
  const worst = [...c.funnel].sort((a, b) => a.deltaVsLastWeek - b.deltaVsLastWeek)[0];

  const lines = [
    bold('2 · Conversion'),
    `${escape(String(c.signups))} sign\\-ups · rate ${escape(percent(c.signupRate, 2))} · activation ${escape(percent(c.activationRate))}`,
    '',
    italic('By provider'),
    ...c.byProvider.map(
      (p) =>
        `  ${escape(p.provider)} — ${escape(String(p.signups))} ${escape(`(${percent(p.conversionRate, 1)} of views)`)}`,
    ),
    '',
    italic('Funnel'),
    ...c.funnel.map(
      (f) =>
        `  ${escape(f.step)} — ${escape(compact(f.sessions))} ${escape(`(${percent(f.stepConversion)}, ${delta(f.deltaVsLastWeek * 100, 'pp')})`)}`,
    ),
  ];

  if (worst && worst.deltaVsLastWeek < -0.01) {
    lines.push(
      '',
      `⚠️ Largest regression: ${bold(worst.step)} at ${escape(delta(worst.deltaVsLastWeek * 100, 'pp'))} versus the same hour last week\\.`,
    );
  }

  return lines.join('\n');
}

function adaptation(input: ReportInput): string {
  const a = input.adaptation;
  const lines = [bold('3 · How MORPH reacted')];

  if (a.entries.length === 0) {
    lines.push(
      italic('No adaptations this hour — every surface is inside its decision thresholds.'),
    );
  } else {
    for (const e of a.entries) {
      const icon = ACTION_ICON[e.action] ?? '•';
      lines.push(
        `${icon} ${bold(e.action)} ${code(e.variantId)} ${escape(`(${e.variantLabel})`)}`,
        `   ${escape(e.reason)}`,
      );
    }
  }

  lines.push('', italic('Current champions'));
  for (const champion of a.champions) {
    lines.push(
      `  ${escape(champion.surfaceId)} → ${code(champion.variantId)}`,
      `     ${escape(`${percent(champion.posteriorMean, 2)} [${percent(champion.credibleInterval[0], 2)}–${percent(champion.credibleInterval[1], 2)}]`)} over ${escape(compact(champion.impressions))} impressions · ${escape(String(champion.activeVariants))} active`,
    );
  }

  lines.push(
    '',
    italic('Live look right now'),
    `  ${escape(`${a.liveTheme.palette} · ${a.liveTheme.typography} · ${a.liveTheme.density} · motion ${a.liveTheme.motion}`)}`,
  );

  return lines.join('\n');
}

function web(input: ReportInput): string {
  const w = input.web;
  const lines = [
    bold('4 · What the web is saying'),
    `${escape(compact(w.documentsFetched))} documents from ${escape(String(w.hostsCrawled))} hosts\\.`,
  ];

  if (w.newClusters.length > 0) {
    lines.push('', italic('New clusters'));
    for (const c of w.newClusters) {
      lines.push(
        `  ${escape(c.label)}`,
        `     momentum ${escape(c.momentum.toFixed(2))} · fit ${escape(c.audienceFit.toFixed(2))} · saturation ${escape(c.saturation.toFixed(2))} · ${escape(String(c.documentCount))} docs`,
      );
    }
  }

  if (w.published.length > 0) {
    lines.push('', italic('Published'));
    for (const p of w.published) lines.push(`  ${escape(p.title)} ${code(`/${p.slug}`)}`);
  }

  if (w.queued.length > 0) {
    lines.push('', italic('Queued for review'));
    for (const q of w.queued) lines.push(`  ${escape(q.title)}`);
  }

  if (w.rejected.length > 0) {
    lines.push('', italic('Rejected by the safety classifier'));
    for (const r of w.rejected) lines.push(`  ${escape(r.label)} — ${escape(r.reason)}`);
  }

  return lines.join('\n');
}

function social(input: ReportInput): string {
  const s = input.social;
  const lines = [
    bold('5 · Social'),
    `Autonomy: ${code(s.autonomy)} · ${escape(String(s.awaitingApproval))} awaiting approval`,
  ];
  for (const p of s.platforms) {
    lines.push(
      `  ${escape(p.platform)} — ${escape(String(p.posted))} posts · ${escape(compact(p.impressions))} impressions · ${escape(compact(p.engagements))} engagements · followers ${escape(delta(p.followerDelta, '', 0))}`,
      `     rate\\-limit headroom ${escape(percent(p.rateLimitHeadroom, 0))}`,
    );
  }
  if (s.awaitingApproval > 0) {
    lines.push('', `👉 ${escape('/queue to approve or reject')}`);
  }
  return lines.join('\n');
}

function holdout(input: ReportInput): string {
  const h = input.holdout;
  const verdict = h.conclusive
    ? `conclusive at p \\= ${escape(h.cumulativePValue.toFixed(4))}`
    : `not yet conclusive \\(p \\= ${escape(h.cumulativePValue.toFixed(3))}\\)`;

  return [
    bold('6 · Holdout lift'),
    `This hour ${escape(delta(h.hourLiftRelative * 100))} · cumulative ${escape(delta(h.cumulativeLiftRelative * 100))} — ${verdict}`,
    escape(
      `Adaptive ${percent(h.adaptiveRewardPerImpression, 3)} vs baseline ${percent(h.holdoutRewardPerImpression, 3)} reward per impression, over a ${percent(h.holdoutFraction, 0)} holdout.`,
    ),
  ].join('\n');
}

function alerts(input: ReportInput): string {
  if (input.alerts.length === 0) {
    return [bold('7 · Anomalies & alerts'), italic('Nothing to report.')].join('\n');
  }
  return [
    bold('7 · Anomalies & alerts'),
    ...input.alerts.map(
      (a) => `${SEVERITY_ICON[a.severity]} ${bold(a.title)}\n   ${escape(a.detail)}`,
    ),
  ].join('\n');
}

function nextHour(input: ReportInput): string {
  const lines = [bold('8 · Next hour')];
  for (const i of input.next.intentions) lines.push(`  • ${escape(i)}`);
  if (input.next.needsOperator.length > 0) {
    lines.push('', bold('Needs you'));
    for (const n of input.next.needsOperator) lines.push(`  ❓ ${escape(n)}`);
  }
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Composition
// -----------------------------------------------------------------------------

export interface ComposedReport {
  readonly kind: 'full' | 'brief';
  /** Ready-to-send MarkdownV2 messages, each within Telegram's 4,096-char limit. */
  readonly messages: readonly string[];
  readonly charCount: number;
}

export function composeReport(input: ReportInput): ComposedReport {
  if (isQuietHour(input)) {
    const brief = composeBrief(input);
    return { kind: 'brief', messages: [brief], charCount: brief.length };
  }

  const sections = [
    header(input),
    traffic(input),
    conversion(input),
    adaptation(input),
    web(input),
    social(input),
    holdout(input),
    alerts(input),
    // The footer rides along with the last section so a version stamp never arrives
    // as a lonely second message.
    `${nextHour(input)}

${italic(`reward weights v${String(input.rewardVersion)}`)}`,
  ];

  const messages = packSections(sections);
  const charCount = sections.join('\n\n').length;

  return { kind: 'full', messages, charCount };
}
