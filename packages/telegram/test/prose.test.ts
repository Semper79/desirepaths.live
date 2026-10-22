import { describe, expect, it } from 'vitest';
import { factNumbers, MAX_LEAD_LENGTH, proseNumbers, verifyLead, withLead } from '../src/prose';
import { SAMPLE_REPORT_INPUT } from '../src/sample';

/**
 * These tests are the reason the prose pass is allowed to exist. A prompt cannot enforce
 * "every number came from the facts"; this can, and if it stops working the honest thing
 * is for the whole pass to stop being used.
 */

const FACTS = {
  traffic: { sessions: 1840, sessionsDeltaVsLastWeek: 0.211 },
  conversion: { signups: 22, signupRate: 0.01196 },
  web: { published: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
  hourStart: '2026-08-24T13:00:00.000Z',
};

describe('what counts as a fact', () => {
  it('collects numbers from anywhere in the object', () => {
    const numbers = factNumbers(FACTS);
    expect(numbers.has(1840)).toBe(true);
    expect(numbers.has(22)).toBe(true);
  });

  /**
   * A fraction in the facts is a percentage in the prose. Both spellings are the same
   * fact, and rejecting one would reject most of what a reader would naturally write.
   */
  it('counts a fraction and its percentage as the same fact', () => {
    const numbers = factNumbers(FACTS);
    expect(numbers.has(0.211)).toBe(true);
    expect(numbers.has(21.1)).toBe(true);
  });

  /** "Three pieces published" is a sentence an analyst writes, and the count is a fact. */
  it('counts how many things there are', () => {
    expect(factNumbers(FACTS).has(3)).toBe(true);
  });

  it('reads the numbers out of a timestamp, so quoting the hour is not an invention', () => {
    const numbers = factNumbers(FACTS);
    expect(numbers.has(2026)).toBe(true);
    expect(numbers.has(13)).toBe(true);
  });

  it('ignores values that are not finite', () => {
    expect(factNumbers({ x: Number.NaN, y: Infinity }).size).toBe(0);
  });
});

describe('reading numbers out of prose', () => {
  it('keeps the precision each was written at', () => {
    const [thousands, exact] = proseNumbers('1.8k sessions, 1840 exactly');

    expect(thousands?.value).toBe(1800);
    expect(thousands?.tolerance).toBe(50);
    expect(exact?.value).toBe(1840);
    expect(exact?.tolerance).toBe(0.5);
  });

  it('handles thousands separators, percentages and points', () => {
    const numbers = proseNumbers('1,840 sessions, up 21.1%, conversion −7.7pp');

    expect(numbers.map((n) => n.value)).toEqual([1840, 21.1, -7.7]);
  });

  it('scales the tolerance with the suffix', () => {
    expect(proseNumbers('1.2M')[0]).toMatchObject({ value: 1_200_000, tolerance: 50_000 });
  });

  it('finds nothing in prose with no numbers', () => {
    expect(proseNumbers('A quiet hour with nothing worth reporting.')).toEqual([]);
  });
});

describe('verifying a lead', () => {
  /**
   * The case the whole design exists for: a plausible sentence with a number nobody
   * measured.
   */
  it('rejects a number that is not in the facts', () => {
    const verdict = verifyLead('Traffic reached 4,200 sessions this hour.', FACTS);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations[0]?.token).toContain('4,200');
  });

  it('accepts a number written exactly as it was measured', () => {
    expect(verifyLead('1840 sessions, 22 sign-ups.', FACTS).ok).toBe(true);
  });

  /**
   * "1.8k" does not claim to be 1800, it claims to be something that rounds to 1.8k.
   * Holding it to 1800 exactly would reject every compact figure the report itself prints.
   */
  it('accepts a compact figure that the facts round to', () => {
    expect(verifyLead('About 1.8k sessions.', FACTS).ok).toBe(true);
  });

  it('rejects a compact figure that the facts do not round to', () => {
    expect(verifyLead('About 1.9k sessions.', FACTS).ok).toBe(false);
  });

  it('accepts a fraction written as a percentage', () => {
    expect(verifyLead('Sessions are up 21.1% on the same hour last week.', FACTS).ok).toBe(true);
  });

  /**
   * The render writes a fall as `−7.7pp` and an analyst writes "down 7.7 points". The same
   * claim, and a model that inverts a direction is a different failure — one the reader can
   * see for themselves against the section below.
   */
  it('matches on magnitude, not on sign', () => {
    expect(verifyLead('Conversion is up 21.1%.', FACTS).ok).toBe(true);
    expect(verifyLead('Conversion is down 21.1%.', FACTS).ok).toBe(true);
  });

  it('accepts prose with no numbers at all', () => {
    expect(verifyLead('A quiet hour: nothing published, nothing decided.', FACTS).ok).toBe(true);
  });

  it('refuses an empty lead', () => {
    expect(verifyLead('   ', FACTS).ok).toBe(false);
  });

  /** A lead longer than this is not a lead. Telegram's limit is far away; attention is not. */
  it('refuses a lead that has stopped being a lead', () => {
    const verdict = verifyLead('word '.repeat(MAX_LEAD_LENGTH), FACTS);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations[0]?.reason).toMatch(/at most/);
  });

  it('reports every violation, not only the first', () => {
    const verdict = verifyLead('We saw 999 sessions and 777 sign-ups.', FACTS);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations).toHaveLength(2);
  });

  /**
   * Run against the worked example, which is the same shape a real hour produces: a lead
   * quoting its headline figures has to pass, or the pass would never add anything.
   */
  it('accepts a realistic lead over the sample report', () => {
    const lead = `Traffic held at ${String(SAMPLE_REPORT_INPUT.traffic.sessions)} sessions with ${String(SAMPLE_REPORT_INPUT.conversion.signups)} sign-ups.`;

    expect(verifyLead(lead, SAMPLE_REPORT_INPUT).ok).toBe(true);
  });
});

describe('attaching the lead', () => {
  it('goes on top of the first message, not into its own', () => {
    const messages = withLead(['section one', 'section two'], 'The lead.');

    expect(messages[0]).toBe('The lead.\n\nsection one');
    expect(messages).toHaveLength(2);
  });

  /**
   * The lead is the optional part by construction. There is no version of this where a
   * nicety costs a section.
   */
  it('is dropped rather than pushing the report past the limit', () => {
    const full = 'x'.repeat(4090);
    expect(withLead([full], 'a lead that will not fit')).toEqual([full]);
  });

  it('does nothing to an empty report', () => {
    expect(withLead([], 'The lead.')).toEqual([]);
  });
});
