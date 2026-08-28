/**
 * Naming a cluster.
 *
 * A cluster with no name is a row the operator cannot reason about: the hourly report
 * says "signal 4f2a-… is rising fast" and nobody can tell whether to agree. The label is
 * the only human-readable handle on a topic, and it appears in the report, the review
 * queue and the generated article's brief.
 *
 * WHY DOCUMENT FREQUENCY AND NOT TF-IDF
 * TF-IDF needs a corpus-wide document frequency table that changes every hour, which
 * means the same cluster gets a different label on different runs — and a label that
 * moves is worse than a label that is merely adequate, because the operator uses it to
 * recognise a topic they saw yesterday. Counting how many of *this cluster's* titles
 * contain a term needs nothing outside the cluster, and gives the same answer twice.
 *
 * The stopword list is short on purpose. A long one starts removing the words that
 * distinguish topics from each other, and there is no way to notice that has happened
 * except by reading bad labels for a week.
 */

const STOPWORDS = new Set([
  'a',
  'about',
  'after',
  'against',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'may',
  'might',
  'more',
  'most',
  'must',
  'new',
  'no',
  'not',
  'now',
  'of',
  'off',
  'on',
  'one',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  'own',
  'said',
  'says',
  'she',
  'should',
  'so',
  'some',
  'still',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** `trend_signal.label` is `varchar(120)`. Truncating at the boundary beats a write error. */
export const MAX_LABEL_LENGTH = 120;

/** Terms shorter than this are almost always noise once stopwords are gone. */
const MIN_TERM_LENGTH = 3;

export function tokenise(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length >= MIN_TERM_LENGTH && !STOPWORDS.has(word));
}

/**
 * Build a label from the titles of a cluster's documents.
 *
 * Terms are ranked by how many *distinct titles* contain them, not by raw count, so one
 * verbose headline repeating a word six times does not outvote six headlines that each
 * mention it once — which is the difference between naming the topic and naming the
 * loudest article about it.
 */
export function labelFor(titles: readonly string[], termCount = 4): string {
  const frequency = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  for (const title of titles) {
    const terms = new Set(tokenise(title));
    for (const term of terms) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
      // Ties break on the order the term first appeared across the cluster, so the label
      // reads in something close to natural order rather than alphabetically.
      if (!firstSeen.has(term)) firstSeen.set(term, firstSeen.size);
    }
  }

  const ranked = [...frequency.entries()]
    .sort(
      ([aTerm, aCount], [bTerm, bCount]) =>
        bCount - aCount || (firstSeen.get(aTerm) ?? 0) - (firstSeen.get(bTerm) ?? 0),
    )
    .slice(0, termCount)
    .map(([term]) => term);

  if (ranked.length === 0) {
    // A cluster whose titles are entirely stopwords, punctuation or empty. Rare, but the
    // alternative is a row with an empty label and no way to talk about it.
    return 'Unlabelled topic';
  }

  return capitalise(ranked.join(' ')).slice(0, MAX_LABEL_LENGTH);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A URL-safe slug.
 *
 * Deterministic, so re-running generation for the same topic collides on
 * `content_slug_unique` rather than quietly publishing the same article twice under two
 * URLs — which would also split its search authority between them.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    // Truncation can leave a trailing hyphen; a slug ending in one looks like a mistake
    // and is one more way for two near-identical titles to differ meaninglessly.
    .replace(/-+$/, '');

  return slug === '' ? 'untitled' : slug;
}
