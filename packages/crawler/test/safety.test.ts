import { describe, expect, it } from 'vitest';
import {
  assessSafety,
  containsTerm,
  mayGenerateAutomatically,
  SAFETY_CATEGORIES,
} from '../src/safety';

/**
 * This is the gate between "a topic is trending" and "a page goes live with nobody having
 * read it". Every test here is a thing MORPH must not publish on its own.
 */

const topic = (title: string, text = ''): { title: string; text: string } => ({ title, text });

describe('term matching', () => {
  it('matches whole words, case-insensitively', () => {
    expect(containsTerm('The Election is close', 'election')).toBe(true);
    expect(containsTerm('ELECTION DAY', 'election')).toBe(true);
  });

  /**
   * The bug that makes a classifier useless: `war` inside `software`, `award` and `warm`.
   * A classifier that blocks every article containing "software" is one nobody keeps on.
   */
  it('does not match inside a longer word', () => {
    expect(containsTerm('a software release', 'war')).toBe(false);
    expect(containsTerm('she won an award', 'war')).toBe(false);
    expect(containsTerm('a warm evening', 'war')).toBe(false);
    expect(containsTerm('the war ended', 'war')).toBe(true);
  });

  it('matches multi-word phrases across any whitespace', () => {
    expect(containsTerm('sources say the deal is done', 'sources say')).toBe(true);
    expect(containsTerm('sources\n  say otherwise', 'sources say')).toBe(true);
    expect(containsTerm('sources close to the matter say', 'sources say')).toBe(false);
  });

  /**
   * Without normalisation the classifier is quietly English-only while claiming
   * otherwise.
   */
  it('ignores diacritics', () => {
    expect(containsTerm('les réfugiés arrivent', 'refugies')).toBe(true);
  });

  it('treats a term containing regex metacharacters literally', () => {
    expect(() => containsTerm('anything', 'c++ (again)')).not.toThrow();
    expect(containsTerm('a c++ (again) release', 'c++ (again)')).toBe(true);
  });

  it('respects word boundaries around punctuation', () => {
    expect(containsTerm('the trial, which ended', 'trial')).toBe(true);
    expect(containsTerm('a trial-and-error method', 'trial')).toBe(true);
  });
});

describe('blocking categories', () => {
  const blocked = [
    ['electoral', 'What the election result means for the coalition'],
    ['tragedy', 'Dozens killed as the earthquake hits'],
    ['medical', 'New treatment shows promise in a clinical trial'],
    ['financial', 'Why analysts think this crypto price target is realistic'],
    ['minors', 'What the new rules mean for children in care'],
    ['legal', 'The lawsuit alleging breach of contract'],
    ['adult', 'The platform tightened its rules on nudity'],
  ] as const;

  for (const [id, title] of blocked) {
    it(`blocks ${id}`, () => {
      const assessment = assessSafety(topic(title));
      expect(assessment.verdict).toBe('block');
      expect(assessment.matches.some((m) => m.categoryId === id)).toBe(true);
      expect(mayGenerateAutomatically(assessment)).toBe(false);
    });
  }

  it('reports the reason, so a block can be explained to the operator', () => {
    const assessment = assessSafety(topic('The election result'));
    expect(assessment.matches[0]?.reason).toMatch(/regulated/i);
    expect(assessment.summary).toContain('Blocked from automated publication');
  });

  it('names the exact terms that fired, so a bad rule is visible', () => {
    const assessment = assessSafety(topic('Election night', 'The ballot counting continues.'));
    const electoral = assessment.matches.find((m) => m.categoryId === 'electoral');
    expect(electoral?.terms).toContain('election');
    expect(electoral?.terms).toContain('ballot');
  });

  it('searches the body as well as the title', () => {
    const assessment = assessSafety(
      topic('An ordinary headline', 'Later, the indictment was filed.'),
    );
    expect(assessment.verdict).toBe('block');
  });
});

describe('review categories', () => {
  it('holds unverified breaking news rather than dropping it', () => {
    const assessment = assessSafety(topic('Breaking: reportedly a deal has been reached'));
    expect(assessment.verdict).toBe('review');
    expect(assessment.summary).toContain('Held for operator review');
    expect(mayGenerateAutomatically(assessment)).toBe(false);
  });

  it('holds topics framed around protected characteristics', () => {
    expect(assessSafety(topic('The immigration debate reopens')).verdict).toBe('review');
  });
});

describe('precedence', () => {
  /**
   * One blocking category is enough, however many others were clean. A topic being "only
   * slightly about" an ongoing trial is not a reason to publish about it.
   */
  it('block beats review', () => {
    const assessment = assessSafety(topic('Breaking: the indictment was unsealed'));
    expect(assessment.verdict).toBe('block');
    expect(assessment.matches.length).toBeGreaterThan(1);
  });

  it('reports every category that fired, not only the decisive one', () => {
    const assessment = assessSafety(topic('Breaking: election result disputed in court'));
    const ids = assessment.matches.map((m) => m.categoryId);
    expect(ids).toContain('electoral');
    expect(ids).toContain('breaking');
  });
});

describe('allowing', () => {
  it('lets an ordinary technical topic through', () => {
    const assessment = assessSafety(
      topic(
        'A new approach to incremental clustering',
        'The library adds an incremental mode that keeps identifiers stable across runs.',
      ),
    );

    expect(assessment.verdict).toBe('allow');
    expect(assessment.matches).toEqual([]);
    expect(assessment.summary).toBe('No safety category matched.');
    expect(mayGenerateAutomatically(assessment)).toBe(true);
  });

  it('allows an empty topic rather than failing on it', () => {
    expect(assessSafety(topic('', '')).verdict).toBe('allow');
  });
});

describe('the category list itself', () => {
  it('has a unique id, a label and a reason for every category', () => {
    const ids = SAFETY_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const category of SAFETY_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.reason.length).toBeGreaterThan(20);
      expect(category.terms.length).toBeGreaterThan(0);
    }
  });

  /**
   * Pinned so that changing the classifier forces a decision about `docs/COMPLIANCE.md`
   * §5, which describes this list to the outside world. "Naming a private individual" is
   * deliberately absent: term matching cannot detect it, and the header says so.
   */
  it('covers exactly the categories the compliance document claims', () => {
    expect(SAFETY_CATEGORIES.map((c) => c.id).sort()).toEqual([
      'adult',
      'breaking',
      'electoral',
      'financial',
      'identity',
      'legal',
      'medical',
      'minors',
      'tragedy',
    ]);
  });

  it('has no empty or duplicated terms within a category', () => {
    for (const category of SAFETY_CATEGORIES) {
      const terms = category.terms.map((t) => t.toLowerCase());
      expect(new Set(terms).size, `duplicates in ${category.id}`).toBe(terms.length);
      expect(terms.every((t) => t.trim() !== '')).toBe(true);
    }
  });
});
