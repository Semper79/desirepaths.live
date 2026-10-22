import { describe, expect, it } from 'vitest';
import {
  deduplicate,
  fromStorage,
  hammingDistance,
  hash64,
  isNearDuplicate,
  NEAR_DUPLICATE_DISTANCE,
  shingles,
  simhash,
  toStorage,
} from '../src/simhash';

const ARTICLE =
  'The regulator published new guidance on automated decision systems this morning, ' +
  'setting out how operators must document the logic behind any model that affects ' +
  'individuals. The document runs to forty pages and takes effect in January.';

describe('shingling', () => {
  it('produces overlapping windows of the requested size', () => {
    expect(shingles('a b c d', 3)).toEqual(['a b c', 'b c d']);
  });

  it('normalises case and punctuation, so formatting is not content', () => {
    expect(shingles('Hello, World! Again', 3)).toEqual(shingles('hello world again', 3));
  });

  /**
   * Without this, every short document hashes to zero and they all look identical to
   * each other — the worst possible failure for a deduplicator.
   */
  it('still fingerprints a document shorter than one shingle', () => {
    expect(shingles('two words', 3)).toEqual(['two words']);
    expect(simhash('two words')).not.toBe(0n);
  });

  it('returns nothing for a document with no words at all', () => {
    expect(shingles('   ...   ')).toEqual([]);
    expect(simhash('')).toBe(0n);
  });

  /**
   * A bag of words would hash these identically. That is the reason for shingles.
   */
  it('is order-sensitive', () => {
    expect(simhash('dog bites man today')).not.toBe(simhash('man bites dog today'));
  });
});

describe('the fingerprint', () => {
  it('is deterministic', () => {
    expect(simhash(ARTICLE)).toBe(simhash(ARTICLE));
  });

  it('fits in 64 bits', () => {
    expect(simhash(ARTICLE)).toBeLessThan(1n << 64n);
    expect(hash64('anything')).toBeLessThan(1n << 64n);
  });

  it('gives different documents different hashes', () => {
    expect(hash64('a')).not.toBe(hash64('b'));
  });
});

describe('locality sensitivity', () => {
  /**
   * The property the whole module exists for: a small edit must move the fingerprint a
   * small distance, not to somewhere unrelated.
   */
  it('moves a little for a small edit and a lot for a different story', () => {
    const edited = ARTICLE.replace('this morning', 'earlier today');
    const unrelated =
      'The football club confirmed the signing of a midfielder from the Portuguese league ' +
      'on a four-year deal, with the fee undisclosed and a medical scheduled for Thursday.';

    const editDistance = hammingDistance(simhash(ARTICLE), simhash(edited));
    const strangerDistance = hammingDistance(simhash(ARTICLE), simhash(unrelated));

    // The relation is the property; the absolute numbers depend on the hash function and
    // would make this a change-detector rather than a test.
    expect(editDistance).toBeLessThan(strangerDistance / 2);
  });

  /**
   * Worth being explicit about, because it is the module's real boundary: a distance of 3
   * catches reformatting and byte-level changes, not rewriting. Two changed words in a
   * paragraph already put a document past it, and catching *that* as the same story is
   * the clustering stage's job, not this one's.
   */
  it('does not claim a reworded paragraph is the same document', () => {
    const edited = ARTICLE.replace('this morning', 'earlier today');
    expect(isNearDuplicate(simhash(ARTICLE), simhash(edited))).toBe(false);
  });

  it('treats a reformatted copy as the same document', () => {
    const reformatted = ARTICLE.replace(/\s+/g, '  ').toUpperCase();
    expect(isNearDuplicate(simhash(ARTICLE), simhash(reformatted))).toBe(true);
  });

  it('keeps an unrelated document far away', () => {
    const unrelated =
      'The football club confirmed the signing of a midfielder from the Portuguese league ' +
      'on a four-year deal, with the fee undisclosed and a medical scheduled for Thursday.';
    expect(hammingDistance(simhash(ARTICLE), simhash(unrelated))).toBeGreaterThan(
      NEAR_DUPLICATE_DISTANCE,
    );
  });
});

describe('hamming distance', () => {
  it('counts differing bits', () => {
    expect(hammingDistance(0b0000n, 0b0000n)).toBe(0);
    expect(hammingDistance(0b0001n, 0b0000n)).toBe(1);
    expect(hammingDistance(0b1011n, 0b0010n)).toBe(2);
  });

  it('handles the full width', () => {
    expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64);
  });
});

describe('storage round-trip', () => {
  it('survives a decimal string', () => {
    const print = simhash(ARTICLE);
    expect(fromStorage(toStorage(print))).toBe(print);
  });

  it('masks a value wider than 64 bits rather than trusting it', () => {
    expect(fromStorage('340282366920938463463374607431768211455')).toBe((1n << 64n) - 1n);
  });
});

describe('deduplicating a batch', () => {
  const item = (id: string, text: string): { id: string; text: string } => ({ id, text });

  it('keeps the first occurrence and reports what it dropped', () => {
    const items = [
      item('original', ARTICLE),
      item('syndicated', ARTICLE.replace('this morning', 'this  morning')),
      item(
        'different',
        'An entirely separate story about rail timetables and winter engineering works.',
      ),
    ];

    const result = deduplicate(items, (i) => simhash(i.text));

    expect(result.kept.map((i) => i.id)).toEqual(['original', 'different']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.item.id).toBe('syndicated');
    expect(result.dropped[0]?.duplicateOf.id).toBe('original');
  });

  it('keeps everything when nothing repeats', () => {
    const items = [item('a', 'first'), item('b', 'second')];
    expect(deduplicate(items, (i) => simhash(i.text)).dropped).toEqual([]);
  });

  it('handles an empty batch', () => {
    expect(deduplicate([], () => 0n)).toEqual({ kept: [], dropped: [] });
  });

  /**
   * The caller controls which copy survives by controlling order. The pipeline sorts by
   * source preference so an original outranks its syndication.
   */
  it('respects the order it was given', () => {
    const items = [item('syndicated', ARTICLE), item('original', ARTICLE)];
    expect(deduplicate(items, (i) => simhash(i.text)).kept.map((i) => i.id)).toEqual([
      'syndicated',
    ]);
  });

  it('honours a wider threshold when asked', () => {
    const a = 0b0000n;
    const b = 0b1111n;
    expect(deduplicate([{ p: a }, { p: b }], (i) => i.p, 3).kept).toHaveLength(2);
    expect(deduplicate([{ p: a }, { p: b }], (i) => i.p, 4).kept).toHaveLength(1);
  });
});
