/**
 * The safety verdict, and the two names it goes by.
 *
 * There are two vocabularies for the same three states, and they exist for a reason that
 * is worth writing down rather than resolving by picking a favourite.
 *
 * **The stored one** — `safe` / `needs_review` / `rejected` — is the `safety_verdict`
 * Postgres enum. It predates the classifier, it is used by two tables, and the
 * `outbound_auto_requires_safe_template` CHECK constraint names `'safe'` in SQL. Changing
 * it is a migration that touches a constraint, not a rename.
 *
 * **The classifier one** — `allow` / `review` / `block` — is what
 * `packages/crawler/src/safety.ts` returns. It reads as a decision about an action, which
 * is what a classifier produces.
 *
 * Rather than have each consumer translate — which is how a `'safe'` ends up compared
 * against an `'allow'` and silently never matching — the mapping lives here, next to the
 * schema that owns one of the two names, and every crossing goes through it.
 *
 * §Conventions: if two packages need the same shape, it lives in `core`.
 */

/** What the classifier decides. */
export type SafetyVerdict = 'allow' | 'review' | 'block';

/** What the `safety_verdict` column holds. */
export type StoredSafetyVerdict = 'safe' | 'needs_review' | 'rejected';

const TO_STORED: Readonly<Record<SafetyVerdict, StoredSafetyVerdict>> = {
  allow: 'safe',
  review: 'needs_review',
  block: 'rejected',
};

const FROM_STORED: Readonly<Record<StoredSafetyVerdict, SafetyVerdict>> = {
  safe: 'allow',
  needs_review: 'review',
  rejected: 'block',
};

export function toStoredVerdict(verdict: SafetyVerdict): StoredSafetyVerdict {
  return TO_STORED[verdict];
}

export function fromStoredVerdict(verdict: StoredSafetyVerdict): SafetyVerdict {
  return FROM_STORED[verdict];
}

/**
 * Severity order, so "the worst verdict this topic has ever received" is expressible
 * without a chain of comparisons that has to be got right in each place it appears.
 */
const SEVERITY: Readonly<Record<SafetyVerdict, number>> = { allow: 0, review: 1, block: 2 };

export function worstVerdict(a: SafetyVerdict, b: SafetyVerdict): SafetyVerdict {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** The only verdict that permits automated publication. */
export function permitsAutomation(verdict: SafetyVerdict): boolean {
  return verdict === 'allow';
}
