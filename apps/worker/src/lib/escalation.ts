/**
 * Deciding what cannot wait for the next report.
 *
 * §5 asks for immediate escalation alongside the hourly report. The interesting question
 * is not how to send a message — it is what deserves one, and the answer that keeps an
 * operator reading them.
 *
 * ESCALATION IS ABOUT TRANSITIONS; THE REPORT IS ABOUT STATE
 * This fires when something *becomes* critical and again when it stops. It does not remind.
 * An operator who has been told ClickHouse is down does not need to be told every ten
 * minutes, and the hourly report carries the ongoing condition anyway — so a reminder here
 * would be a third copy of a fact they already have. That separation is the whole design:
 * two channels that say different things rather than the same thing at two cadences.
 *
 * ONLY CRITICAL
 * Warnings and information wait for the report. A push notification for "three drafts are
 * waiting" is how an operator learns that push notifications are not worth opening, and
 * then misses the one that was.
 *
 * RECOVERY IS ALSO NEWS
 * An alert that fires and never resolves teaches the reader that alerts do not resolve,
 * and the next outage looks identical to the last one still being open.
 */

import type { Alert } from '@morph/telegram';

export interface AlertState {
  readonly title: string;
  readonly firstSeenAt: number;
  readonly notifiedAt: number;
}

export interface EscalationDecision {
  /** Newly critical, in the order they were reported. */
  readonly toNotify: readonly Alert[];
  /** Titles that were critical and are not any more. */
  readonly resolved: readonly AlertState[];
  /**
   * What to remember, assuming everything in `toNotify` is delivered.
   *
   * Returned rather than applied, so the caller can record only what it actually managed
   * to send — a transition whose message failed must stay untold rather than being
   * remembered as told.
   */
  readonly next: ReadonlyMap<string, AlertState>;
}

/**
 * The title is the identity of an alert.
 *
 * It is generated from a template with the counts substituted in, so "2 hosts cut off" and
 * "3 hosts cut off" are different alerts — which is right: the second is news. What it
 * cannot distinguish is the same condition described differently, and the fix for that is
 * to keep the titles stable rather than to build a fuzzy matcher that would eventually
 * silence something real.
 */
export function escalationDecisions(
  active: readonly Alert[],
  known: ReadonlyMap<string, AlertState>,
  now: number,
): EscalationDecision {
  const critical = active.filter((alert) => alert.severity === 'critical');
  const activeTitles = new Set(critical.map((alert) => alert.title));

  const toNotify = critical.filter((alert) => !known.has(alert.title));
  const resolved = [...known.values()].filter((state) => !activeTitles.has(state.title));

  const next = new Map<string, AlertState>();

  for (const alert of critical) {
    const existing = known.get(alert.title);

    next.set(alert.title, {
      title: alert.title,
      // Kept from the first sighting, so a recovery message can say how long it lasted.
      firstSeenAt: existing?.firstSeenAt ?? now,
      notifiedAt: existing?.notifiedAt ?? now,
    });
  }

  return { toNotify, resolved, next };
}

/**
 * Record only the transitions that were actually delivered.
 *
 * The distinction matters on the one path where it is easy to get wrong: an escalation
 * whose send failed must be retried on the next run, and remembering it as sent would mean
 * an outage that was never reported to anybody.
 */
export function commit(
  decision: EscalationDecision,
  delivered: ReadonlySet<string>,
): ReadonlyMap<string, AlertState> {
  const committed = new Map<string, AlertState>();

  for (const [title, state] of decision.next) {
    const wasNew = decision.toNotify.some((alert) => alert.title === title);
    if (wasNew && !delivered.has(title)) continue;

    committed.set(title, state);
  }

  return committed;
}

/** How long a condition lasted, in the words a person would use. */
export function formatDuration(ms: number): string {
  // Checked before rounding: 30 seconds rounds to a minute, and "1 minute" for half of
  // one is a small lie in a message whose whole purpose is to be trusted.
  if (ms < 60_000) return 'under a minute';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (rest === 0) return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  return `${String(hours)}h ${String(rest)}m`;
}
