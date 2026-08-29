/**
 * The prose pass, and the check that makes it safe.
 *
 * §5 asks for a report that reads "like a sharp analyst's briefing, not a metrics dump",
 * composed by an LLM. `types.ts` states the constraint that follows: the deterministic
 * render is the contract and the fallback, the model makes it read better, and **a number
 * that appears in the report always came from `ReportInput`**.
 *
 * A prompt cannot enforce that. This can.
 *
 * WHAT THE MODEL IS ACTUALLY ASKED FOR
 * Not a rewrite. A *lead* — two to four sentences at the top saying what happened and
 * what matters — with the nine deterministic sections following underneath, unchanged.
 * That is where the "sharp analyst" value is: nobody needs a model to reformat a table,
 * and a model that reformats a table is a model that can drop a row from it. Every failure
 * mode of this design is "the report arrives exactly as it does today".
 *
 * HOW A NUMBER IS CHECKED
 * Every numeric token in the lead is parsed with the precision it was written at, and must
 * match some value in the facts at that precision. "1.8k" is allowed if a fact rounds to
 * 1.8k; "1.9k" is not. "21.1%" is allowed if a fact times a hundred rounds to 21.1. A
 * token that matches nothing is a violation, the lead is discarded, and the operator gets
 * the report they would have got anyway.
 *
 * The failure direction is the whole point: a lead that cannot be verified is dropped
 * silently rather than sent with a caveat, because a caveat is something a reader learns
 * to skip.
 */

/** A lead longer than this is not a lead. Telegram's limit is far away; attention is not. */
export const MAX_LEAD_LENGTH = 600;

export interface ProseViolation {
  readonly token: string;
  readonly reason: string;
}

export type ProseVerdict =
  | { readonly ok: true; readonly lead: string }
  | { readonly ok: false; readonly violations: readonly ProseViolation[] };

/**
 * Every number anywhere in the facts, plus the same values as percentages.
 *
 * Recursive because `ReportInput` is nested and the interesting numbers are three levels
 * down — a funnel step's conversion, a source's delta. Array lengths are included because
 * "three sources" is a sentence an analyst writes and the count is genuinely a fact.
 *
 * Strings contribute too: the hour is an ISO timestamp, and a lead that says "13:00" is
 * quoting the report rather than inventing anything.
 */
export function factNumbers(value: unknown, into: Set<number> = new Set()): ReadonlySet<number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(value);
    // A fraction in the facts is a percentage in the prose. Both spellings are the same
    // fact, and rejecting one of them would reject most of what a reader would write.
    //
    // Rounded, because `0.211 * 100` is `21.099999999999998` and a set full of binary
    // dust is a set that is tedious to reason about — the tolerance would absorb it, but
    // only by accident.
    into.add(Math.round(value * 100 * 1e9) / 1e9);
    return into;
  }

  if (typeof value === 'string') {
    for (const match of value.matchAll(/\d+/g)) into.add(Number(match[0]));
    return into;
  }

  if (Array.isArray(value)) {
    into.add(value.length);
    for (const item of value) factNumbers(item, into);
    return into;
  }

  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) factNumbers(item, into);
  }

  return into;
}

export interface ProseNumber {
  /** As written, for the violation message. */
  readonly token: string;
  readonly value: number;
  /** Half the unit of the last written digit — the interval the token stands for. */
  readonly tolerance: number;
}

/**
 * Pull the numbers out of prose, keeping the precision each was written at.
 *
 * The precision is what makes the check fair rather than pedantic. "1.8k" does not claim
 * to be 1800, it claims to be something that rounds to 1.8k — so it is allowed if any fact
 * lies in [1750, 1850). Written as "1840" it claims to be exactly that, and is held to it.
 */
export function proseNumbers(text: string): readonly ProseNumber[] {
  const pattern = /([+\-−±]?)(\d[\d,]*)(?:\.(\d+))?\s*(k|m|%|pp|×)?/gi;
  const found: ProseNumber[] = [];

  for (const match of text.matchAll(pattern)) {
    const [token, sign = '', whole = '0', decimals, unit] = match;

    const magnitude =
      unit?.toLowerCase() === 'k' ? 1_000 : unit?.toLowerCase() === 'm' ? 1_000_000 : 1;
    const digits = decimals?.length ?? 0;

    const base = Number(`${whole.replaceAll(',', '')}.${decimals ?? '0'}`);
    if (!Number.isFinite(base)) continue;

    // `±` means "no change" and carries no magnitude to verify.
    const signed = sign === '-' || sign === '−' ? -base : base;

    found.push({
      token: token.trim(),
      value: signed * magnitude,
      // Half a unit of the last digit, scaled by the magnitude the suffix implies.
      tolerance: (0.5 / 10 ** digits) * magnitude,
    });
  }

  return found;
}

/**
 * Check a lead against the facts.
 *
 * Sign is deliberately ignored when matching: the deterministic render writes a fall as
 * `−7.7pp` and an analyst writes "down 7.7 points", and the two are the same claim. What
 * is checked is that the magnitude exists in the facts at the precision written — a model
 * that inverts a direction is a different failure, and one the reader can see for
 * themselves against the section below.
 */
export function verifyLead(lead: string, facts: unknown): ProseVerdict {
  const trimmed = lead.trim();

  if (trimmed === '') {
    return { ok: false, violations: [{ token: '', reason: 'The lead is empty.' }] };
  }

  if (trimmed.length > MAX_LEAD_LENGTH) {
    return {
      ok: false,
      violations: [
        {
          token: `${String(trimmed.length)} characters`,
          reason: `A lead may be at most ${String(MAX_LEAD_LENGTH)} characters.`,
        },
      ],
    };
  }

  const allowed = factNumbers(facts);
  const violations: ProseViolation[] = [];

  for (const number of proseNumbers(trimmed)) {
    const matches = [...allowed].some(
      (fact) => Math.abs(Math.abs(fact) - Math.abs(number.value)) <= number.tolerance,
    );

    if (!matches) {
      violations.push({
        token: number.token,
        reason: 'No figure in the report rounds to this at the precision it was written.',
      });
    }
  }

  return violations.length === 0 ? { ok: true, lead: trimmed } : { ok: false, violations };
}

/**
 * Put a verified lead on top of the composed report.
 *
 * Prepended to the first message rather than sent as its own, so the summary and the
 * detail arrive together — a lead that lands as a separate notification is a second buzz
 * saying the same thing.
 *
 * If it would push the first message past Telegram's limit, the report goes out without
 * it. The lead is the optional part by construction, and there is no version of this where
 * a nicety costs a section.
 */
export function withLead(
  messages: readonly string[],
  lead: string,
  limit = 4096,
): readonly string[] {
  const first = messages[0];
  if (first === undefined) return messages;

  const combined = `${lead}\n\n${first}`;
  if (combined.length > limit) return messages;

  return [combined, ...messages.slice(1)];
}
