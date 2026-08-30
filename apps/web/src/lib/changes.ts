/**
 * The site's own changes, as something a stranger would read.
 *
 * `/proof` says what the site currently believes. This says *when it changed its mind*,
 * which is the part with a narrative in it — and narrative is what people subscribe to.
 * A feed of "this website just retired one of its own headlines, here is the statistic
 * that killed it" is content the machine generates by operating, with no model and no
 * editorial calendar behind it.
 *
 * WHY THIS IS PUBLISHABLE AT ALL
 * The adaptation log holds surface ids, variant ids and statistics. No personal data, no
 * visitor-level anything — the reward figures are aggregates over thousands of sessions.
 * Publishing it costs nothing and is the most direct evidence available that the system
 * does what the home page claims.
 *
 * Pure. The rows come in and the sentences come out, so the wording of every entry is a
 * test rather than something checked by loading the page and squinting.
 */

export type ChangeAction = 'retired' | 'quarantined' | 'promoted' | 'generated' | 'other';

export interface AdaptationRow {
  readonly occurredAt: number;
  readonly action: string;
  readonly surfaceId: string | null;
  readonly variantId: string | null;
  /** Written for the operator when the decision was made, and stored verbatim. */
  readonly reason: string;
  readonly stats: Readonly<Record<string, unknown>>;
}

export interface Change {
  readonly id: string;
  readonly occurredAt: number;
  readonly action: ChangeAction;
  readonly surfaceId: string;
  /** A headline a person would read, not a log line. */
  readonly title: string;
  /** The operator-facing reason, which is already a sentence. */
  readonly detail: string;
  /** Impressions behind the decision, when the log recorded them. */
  readonly impressions: number | null;
}

const ACTIONS: Readonly<Record<string, ChangeAction>> = {
  retired: 'retired',
  quarantined: 'quarantined',
  promoted: 'promoted',
  generated: 'generated',
};

/**
 * What happened, in the words of somebody who does not work here.
 *
 * The log's own `reason` is written for an operator and is kept as the detail line. This
 * is the part above it — and it deliberately says what the site *did to itself* rather
 * than naming a variant id, because "retired hero.headline#7" is a sentence for a person
 * who already knows what hero.headline is.
 */
function titleFor(action: ChangeAction, surfaceId: string): string {
  const subject = SUBJECTS[surfaceId] ?? 'one of its own settings';

  switch (action) {
    case 'retired':
      return `Stopped using one version of ${subject}`;
    case 'quarantined':
      return `Pulled a version of ${subject} for harming the experience`;
    case 'promoted':
      return `Settled on a version of ${subject}`;
    case 'generated':
      return `Wrote itself a new version of ${subject}`;
    case 'other':
      return `Changed ${subject}`;
  }
}

/**
 * Surfaces in plain English.
 *
 * Keyed on the registry's ids but written for a reader who has never seen them. An unknown
 * id falls back to something vague rather than leaking the identifier — a surface added
 * after this map was written should read as slightly imprecise, never as a stack trace.
 */
const SUBJECTS: Readonly<Record<string, string>> = {
  'hero.headline': 'its opening line',
  'hero.media': 'the image at the top',
  'theme.palette': 'its colours',
  'theme.typography': 'its typefaces',
  'layout.density': 'how tightly it packs the page',
  'layout.order': 'the order of the sections',
  'cta.copy': 'the words on its main button',
  'cta.style': 'the look of its main button',
  'signup.providers_order': 'which sign-in option it offers first',
  'motion.intensity': 'how much it animates',
  'content.feed_ranking': 'how it ranks what it has written',
};

export function changesFrom(rows: readonly AdaptationRow[]): readonly Change[] {
  return rows
    .filter((row) => row.surfaceId !== null)
    .map((row) => {
      const action = ACTIONS[row.action] ?? 'other';
      const surfaceId = row.surfaceId as string;
      const impressions = row.stats['impressions'];

      return {
        // Stable across renders, so a feed reader does not re-announce an entry it has
        // already shown. Derived from the facts rather than from a row id, because the
        // log is partitioned and its ids are not stable across a partition detach.
        id: `${String(row.occurredAt)}-${surfaceId}-${row.variantId ?? action}`,
        occurredAt: row.occurredAt,
        action,
        surfaceId,
        title: titleFor(action, surfaceId),
        detail: row.reason,
        impressions:
          typeof impressions === 'number' && Number.isFinite(impressions) ? impressions : null,
      };
    })
    .sort((a, b) => b.occurredAt - a.occurredAt);
}

/**
 * The sentence at the top of the page and in the feed's description.
 *
 * Counted rather than asserted: a site claiming to change constantly, on a page listing
 * three changes in a month, has undermined itself more effectively than any critic could.
 */
export function summarise(changes: readonly Change[], now: number): string {
  if (changes.length === 0) {
    return 'This site has not changed anything about itself yet.';
  }

  const lastWeek = changes.filter((change) => now - change.occurredAt < 7 * 86_400_000).length;
  const newest = changes[0] as Change;
  const hours = Math.max(1, Math.round((now - newest.occurredAt) / 3_600_000));

  const recency =
    hours < 48 ? `${String(hours)} hours ago` : `${String(Math.round(hours / 24))} days ago`;

  return lastWeek === 0
    ? `${String(changes.length)} changes on record. The most recent was ${recency}.`
    : `${String(lastWeek)} changes in the last seven days, the most recent ${recency}.`;
}
