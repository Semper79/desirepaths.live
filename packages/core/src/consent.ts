/**
 * Consent model.
 *
 * MORPH is operated from the EU. The consent gate is not a banner that unlocks
 * tracking; it is the switch that decides which of two genuinely different systems
 * runs. Read docs/PRIVACY.md for the legal reasoning - this file is the mechanism.
 *
 * TWO MODES, NOT ONE
 *  - Without consent beyond `necessary`, MORPH still adapts, but only from
 *    *aggregate anonymous* measurement: an anonymous, daily-rotating identifier,
 *    aggregate counters, and no profile of any kind. This runs under legitimate
 *    interest and is what makes the product work from day one.
 *  - With `personalisation` consent, a visitor's own history informs their own
 *    experience.
 *
 * A surface declares which tier it needs (`SurfaceConstraints.requiresConsent`), and
 * the assignment layer simply cannot reach a surface whose tier is not granted.
 */

export const CONSENT_CATEGORIES = ['necessary', 'analytics', 'personalisation', 'marketing'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/**
 * Bit positions. Stored as a single small integer on every event so that a consent
 * audit can be answered from the event stream itself, and so that a change of mind is
 * visible in the data rather than only in a cookie.
 */
export const CONSENT_BIT: Record<ConsentCategory, number> = {
  necessary: 1,
  analytics: 2,
  personalisation: 4,
  marketing: 8,
};

/** `necessary` is not optional and is not a choice; it is always set. */
export const CONSENT_DEFAULT = CONSENT_BIT.necessary;

export function maskOf(categories: readonly ConsentCategory[]): number {
  return categories.reduce((mask, c) => mask | CONSENT_BIT[c], CONSENT_DEFAULT);
}

export function hasConsent(mask: number, category: ConsentCategory): boolean {
  return (mask & CONSENT_BIT[category]) !== 0;
}

export function categoriesOf(mask: number): readonly ConsentCategory[] {
  return CONSENT_CATEGORIES.filter((c) => hasConsent(mask, c));
}

/**
 * Whether a surface may adapt at all under the given consent.
 *
 * Note the asymmetry: `analytics` is required for adaptation because measurement is
 * required for adaptation, but the measurement itself is anonymous and aggregate.
 * Refusing analytics does not break the site - it pins the visitor to the baseline
 * assignment, which is exactly what the 5% holdout cohort already sees, and which is
 * therefore a known-good experience rather than a degraded one.
 */
export function mayAdapt(
  mask: number,
  requires: 'necessary' | 'analytics' | 'personalisation',
): boolean {
  return hasConsent(mask, requires);
}
