/**
 * Folding a session's events into the components the engine reasons from.
 *
 * The reward is session-scoped, not event-scoped: a sign-up belongs to the whole experience
 * the visitor was shown, not to the click that happened to precede it. So events fold into
 * a session first, and the session contributes to every surface it saw.
 *
 * Pure, and in `core` rather than in the Worker that calls it, for the same reason
 * `packages/adaptive` is pure — these rules decide what the engine believes, so they should
 * be exhaustively testable without a runtime, a binding or a clock.
 *
 * WHY THE FOLD NEEDS NO EVENT BUFFER
 * Every aggregation the ClickHouse original used is `min`, `max`, `sum` or `any`, all of
 * which are commutative and associative. So the fold is incremental: an arriving event
 * merges into a fixed-size state and the order it arrived in does not matter. A session
 * therefore costs a handful of scalars rather than a list of its events, which is what makes
 * one Durable Object per session affordable.
 *
 * WHERE THIS DIVERGES FROM THE CLICKHOUSE VERSION, ON PURPOSE
 * `mv_sessions` took `anyState(surfaces)` and `anyState(variants)` — one assignment per
 * session, picked arbitrarily. But the event schema sends the assignment on *every* event,
 * and says why in `events.ts`: a session can span an assignment change, and "attributing
 * later events to the earlier assignment would silently corrupt the reward attribution".
 *
 * Those two statements contradict each other. The schema preserves the distinction and the
 * fold discards it, so a session that saw variant A for two pageviews and B for three had
 * its whole reward credited to whichever one `any` happened to return.
 *
 * This resolves it the other way: a session whose assignment changed is **excluded from the
 * counters entirely**. It is un-attributable by construction — there is no honest answer to
 * which variant earned a sign-up that happened after the variant changed — and mid-session
 * reassignment is rare, because it takes a quarantine or an operator pin. The same judgement
 * `parseAssignment` already makes about a partial vector: discarding costs one session,
 * repairing corrupts a posterior.
 */

/** 60, matching `BOT_THRESHOLD` and the `bot_score < 60` in every aggregate. */
export const SESSION_BOT_THRESHOLD = 60;

/** `engaged_ms >= 15000 OR pageviews >= 2`, from `surface_rewards_hourly`. */
export const ENGAGED_MS = 15_000;
export const ENGAGED_PAGEVIEWS = 2;

/** `pageviews == 1 AND engaged_ms < 5000`. */
export const BOUNCE_MS = 5_000;

/**
 * The subset of an event this fold reads.
 *
 * Declared structurally rather than taking `IngestEvent`, so the fold can be driven from a
 * stored partial state as easily as from a live beacon — and so a test can express one case
 * in five fields instead of twenty.
 */
export interface FoldableEvent {
  readonly type: string;
  readonly ts: number;
  readonly value: number;
  readonly surfaces: readonly string[];
  readonly variants: readonly string[];
  readonly assignmentHash: string;
  readonly holdout: 0 | 1;
  readonly botScore: number;
  readonly contextBucket: string;
  readonly isReturning: boolean;
}

/** Everything a session is, once its events have been merged in. */
export interface SessionState {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly pageviews: number;
  readonly maxScrollPct: number;
  readonly engagedMs: number;
  readonly signedUp: boolean;
  readonly shared: boolean;
  readonly isReturning: boolean;
  readonly isHoldout: boolean;
  readonly contextBucket: string;
  readonly assignmentHash: string;
  /** True once a second distinct assignment hash has been seen. Makes the session unusable. */
  readonly assignmentChanged: boolean;
  readonly botScore: number;
  /**
   * Impressions per surface and variant, keyed `surface\u0000variant`.
   *
   * Counted from `page_view` events only. An engagement ping is not an impression, and
   * counting one would inflate the denominator of every posterior in proportion to how
   * chatty the client happens to be.
   */
  readonly impressions: Readonly<Record<string, number>>;
}

/** One surface's share of a folded session. */
export interface SurfaceComponents {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly contextBucket: string;
  readonly isHoldout: boolean;
  readonly impressions: number;
  readonly signups: number;
  readonly engagedSessions: number;
  readonly scrollNormSum: number;
  readonly returns: number;
  readonly shares: number;
  readonly bounces: number;
}

const IMPRESSION_SEPARATOR = '\u0000';

export function emptySession(): SessionState {
  return {
    startedAt: Number.POSITIVE_INFINITY,
    endedAt: Number.NEGATIVE_INFINITY,
    pageviews: 0,
    maxScrollPct: 0,
    engagedMs: 0,
    signedUp: false,
    shared: false,
    isReturning: false,
    isHoldout: false,
    contextBucket: '',
    assignmentHash: '',
    assignmentChanged: false,
    botScore: 0,
    impressions: {},
  };
}

/**
 * Merge one event into a session.
 *
 * `any`-style fields take the first value they see rather than the last. The distinction
 * matters for `contextBucket`: a session's device and referrer class are properties of how
 * it began, and letting a later event overwrite them would move a session between posterior
 * cells depending on which beacon arrived last.
 */
export function foldEvent(state: SessionState, event: FoldableEvent): SessionState {
  // One test for "nothing merged yet", rather than one per field. The first draft used
  // `contextBucket === ''` for some fields and `assignmentHash === ''` for others, which
  // happened to work and would have broken silently the moment either field could
  // legitimately be empty.
  const first = state.startedAt === Number.POSITIVE_INFINITY;
  const impressions = { ...state.impressions };

  if (event.type === 'page_view') {
    // `surfaces` and `variants` are parallel arrays, and `validateEvent` already refuses an
    // event where they differ in length — so the index is safe, and reading through a check
    // here would be dead code dressed as caution.
    for (const [index, surface] of event.surfaces.entries()) {
      const variant = event.variants[index];
      if (variant === undefined) continue;

      const key = `${surface}${IMPRESSION_SEPARATOR}${variant}`;
      impressions[key] = (impressions[key] ?? 0) + 1;
    }
  }

  return {
    startedAt: Math.min(state.startedAt, event.ts),
    endedAt: Math.max(state.endedAt, event.ts),
    pageviews: state.pageviews + (event.type === 'page_view' ? 1 : 0),
    maxScrollPct:
      event.type === 'scroll_depth'
        ? Math.max(state.maxScrollPct, event.value)
        : state.maxScrollPct,
    engagedMs: state.engagedMs + (event.type === 'engagement' ? Math.max(0, event.value) : 0),
    signedUp: state.signedUp || event.type === 'signup_complete',
    shared: state.shared || event.type === 'share',
    isReturning: first ? event.isReturning : state.isReturning,
    isHoldout: first ? event.holdout === 1 : state.isHoldout,
    contextBucket: first ? event.contextBucket : state.contextBucket,
    assignmentHash: first ? event.assignmentHash : state.assignmentHash,
    assignmentChanged:
      state.assignmentChanged || (!first && state.assignmentHash !== event.assignmentHash),
    // `max`, not first: a client that looks human on its first beacon and like a crawler on
    // its fifth is a crawler, and the cheap direction to be wrong in is exclusion.
    botScore: Math.max(state.botScore, event.botScore),
    impressions,
  };
}

/**
 * Whether this session may contribute to the posteriors.
 *
 * Exported because the caller needs to know the difference between "folded to nothing" and
 * "deliberately excluded" — the first is a session that saw no surface, the second is one
 * the engine must not learn from, and conflating them hides both.
 */
export function isAttributable(state: SessionState): boolean {
  if (state.botScore >= SESSION_BOT_THRESHOLD) return false;
  if (state.assignmentChanged) return false;
  if (state.pageviews === 0) return false;
  return true;
}

/**
 * The session's contribution to each surface it saw.
 *
 * Every surface receives the *same* session-level components — one sign-up counts once for
 * each surface the session was shown. That is not double-counting: the reward is attributed
 * to the whole experience, and a surface's posterior answers "did sessions that saw this
 * variant convert", which requires the session to appear in every surface it was part of.
 *
 * Returns nothing for a session that may not be attributed, rather than zeroed rows. A row
 * of zeroes would enter the posteriors as evidence of a session that converted nothing,
 * which is a claim about a bot rather than the absence of one.
 */
export function componentsFor(state: SessionState): readonly SurfaceComponents[] {
  if (!isAttributable(state)) return [];

  const engaged = state.engagedMs >= ENGAGED_MS || state.pageviews >= ENGAGED_PAGEVIEWS;
  const bounced = state.pageviews === 1 && state.engagedMs < BOUNCE_MS;
  const scrollNorm = Math.min(1, Math.max(0, state.maxScrollPct / 100));

  const rows: SurfaceComponents[] = [];

  for (const [key, impressions] of Object.entries(state.impressions)) {
    const separator = key.indexOf(IMPRESSION_SEPARATOR);
    if (separator <= 0) continue;

    rows.push({
      surfaceId: key.slice(0, separator),
      variantId: key.slice(separator + 1),
      contextBucket: state.contextBucket,
      isHoldout: state.isHoldout,
      impressions,
      signups: state.signedUp ? 1 : 0,
      engagedSessions: engaged ? 1 : 0,
      scrollNormSum: scrollNorm,
      returns: state.isReturning ? 1 : 0,
      shares: state.shared ? 1 : 0,
      bounces: bounced ? 1 : 0,
    });
  }

  return rows;
}
