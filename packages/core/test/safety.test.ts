import { describe, expect, it } from 'vitest';
import { safetyVerdictEnum } from '../src/db/schema.js';
import {
  fromStoredVerdict,
  permitsAutomation,
  toStoredVerdict,
  worstVerdict,
  type SafetyVerdict,
  type StoredSafetyVerdict,
} from '../src/safety.js';

const CLASSIFIER: readonly SafetyVerdict[] = ['allow', 'review', 'block'];

describe('the two vocabularies', () => {
  /**
   * The reason this module exists: a `'safe'` compared against an `'allow'` never matches,
   * and nothing errors. The mapping has to be in exactly one place, and this is the test
   * that says the place is correct.
   */
  it('maps each classifier verdict onto a stored one', () => {
    expect(toStoredVerdict('allow')).toBe('safe');
    expect(toStoredVerdict('review')).toBe('needs_review');
    expect(toStoredVerdict('block')).toBe('rejected');
  });

  it('round-trips in both directions', () => {
    for (const verdict of CLASSIFIER) {
      expect(fromStoredVerdict(toStoredVerdict(verdict))).toBe(verdict);
    }
  });

  /**
   * The mapping is only useful if its right-hand side is what the column actually accepts.
   * Asserting against the enum declaration means adding a fourth state to the database
   * without extending the mapping fails here rather than at an INSERT.
   */
  it('covers exactly the values the Postgres enum declares', () => {
    const declared = [...safetyVerdictEnum.enumValues].sort();
    const mapped = CLASSIFIER.map(toStoredVerdict).sort();

    expect(mapped).toEqual(declared);
  });

  it('reads back every value the enum can hold', () => {
    for (const stored of safetyVerdictEnum.enumValues as readonly StoredSafetyVerdict[]) {
      expect(CLASSIFIER).toContain(fromStoredVerdict(stored));
    }
  });
});

describe('severity', () => {
  it('orders block above review above allow', () => {
    expect(worstVerdict('allow', 'review')).toBe('review');
    expect(worstVerdict('review', 'block')).toBe('block');
    expect(worstVerdict('block', 'allow')).toBe('block');
  });

  it('is symmetric', () => {
    for (const a of CLASSIFIER) {
      for (const b of CLASSIFIER) {
        expect(worstVerdict(a, b)).toBe(worstVerdict(b, a));
      }
    }
  });

  it('returns the value itself when both are equal', () => {
    for (const verdict of CLASSIFIER) {
      expect(worstVerdict(verdict, verdict)).toBe(verdict);
    }
  });
});

describe('what permits automation', () => {
  it('is allow, and only allow', () => {
    expect(permitsAutomation('allow')).toBe(true);
    expect(permitsAutomation('review')).toBe(false);
    expect(permitsAutomation('block')).toBe(false);
  });
});
