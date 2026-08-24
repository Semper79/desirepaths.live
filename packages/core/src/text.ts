/**
 * Readability scoring for generated copy.
 *
 * Section 2.3 requires generated variants to be validated for "reading level" before
 * they can enter the variant pool. This is that check.
 *
 * WHY FLESCH-KINCAID AND NOT SOMETHING SMARTER
 * A neural readability model would score better on academic benchmarks and would
 * also be a network call in the middle of a validation gate, which turns a
 * deterministic reject into a flaky one. Flesch-Kincaid is crude, but it is
 * deterministic, instant, and catches the failure mode that actually happens:
 * a model drifting into 40-word sentences of corporate abstraction. For headline
 * copy - the only copy this gate sees - crude is sufficient.
 *
 * The syllable counter is heuristic and will mis-count irregular words. That is
 * acceptable: the gate is a threshold on an aggregate over a whole string, not a
 * per-word claim, and it is applied with a comfortable margin.
 */

const SENTENCE_SPLIT = /[.!?]+(?:\s|$)/;
const WORD_SPLIT = /[\s—–-]+/;
const NON_ALPHA = /[^a-z]/g;

/**
 * Heuristic English syllable count for a single word.
 *
 * Rules, in order: strip non-letters, count vowel groups, drop a silent trailing
 * `e` unless it follows a consonant + `l`, drop a non-syllabic `-ed`, and never
 * return less than one for a non-empty word.
 */
export function syllablesIn(word: string): number {
  const w = word.toLowerCase().replace(NON_ALPHA, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;

  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 0;

  // A terminal `e` is usually silent ("shape" is one syllable, not two) - except
  // after a consonant + `l`, where it carries its own syllable ("subtle", "gentle").
  // Words of three letters or fewer never reach here, so "the" and "be" are safe.
  if (w.endsWith('e') && !/[^aeiouy]le$/.test(w) && n > 1) n -= 1;

  // `-ed` is usually not syllabic unless preceded by t or d ("shaped" vs "wanted").
  if (/[^aeiouytd]ed$/.test(w) && n > 1) n -= 1;

  return Math.max(1, n);
}

export interface ReadabilityScore {
  readonly words: number;
  readonly sentences: number;
  readonly syllables: number;
  /** Flesch-Kincaid Grade Level. ~8 is mainstream web copy; >12 is a red flag. */
  readonly grade: number;
  /** Flesch Reading Ease, 0-100. Higher is easier. */
  readonly ease: number;
}

/**
 * Score a string. An empty or punctuation-only string returns grade 0, which
 * passes every threshold - an empty headline is caught by the schema's `min(1)`,
 * not by the readability gate. Each check should fail for exactly one reason.
 */
export function readability(text: string): ReadabilityScore {
  const words = text
    .split(WORD_SPLIT)
    .map((w) => w.replace(NON_ALPHA, ''))
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return { words: 0, sentences: 0, syllables: 0, grade: 0, ease: 100 };
  }

  // A headline with no terminal punctuation is still one sentence.
  const sentences = Math.max(
    1,
    text.split(SENTENCE_SPLIT).filter((s) => s.trim().length > 0).length,
  );
  const syllables = words.reduce((sum, w) => sum + syllablesIn(w), 0);

  const wordsPerSentence = words.length / sentences;
  const syllablesPerWord = syllables / words.length;

  const grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
  const ease = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;

  return {
    words: words.length,
    sentences,
    syllables,
    grade: Math.round(Math.max(0, grade) * 10) / 10,
    ease: Math.round(Math.min(100, Math.max(0, ease)) * 10) / 10,
  };
}
