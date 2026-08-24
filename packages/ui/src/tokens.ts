/**
 * The design-token contract.
 *
 * Every visual property a surface can change is a CSS custom property listed here, and
 * every component reads tokens and nothing else. That constraint is what makes "the site
 * restyles itself" tractable: the optimiser composes token bags, never CSS, and a
 * component cannot be broken by a variant because it never sees one.
 *
 * The token names are also the contract with `packages/core/src/surfaces/registry.ts`.
 * `assertTokenContract` checks that a rendered bag actually covers what components need,
 * so a palette missing `--color-border` fails a test rather than rendering an invisible
 * divider that nobody notices for a month.
 */

/**
 * Tokens a page must always define, because some component reads each one unconditionally.
 * A generated palette that omits one produces an invalid CSS value, which browsers
 * silently resolve to `unset` — the worst possible failure mode, because it looks fine
 * on the reviewer's machine.
 */
export const REQUIRED_TOKENS = [
  // Colour
  '--color-bg',
  '--color-surface',
  '--color-text',
  '--color-text-muted',
  '--color-accent',
  '--color-on-accent',
  '--color-border',
  // Type
  '--font-display',
  '--font-body',
  '--scale-ratio',
  '--measure',
  '--tracking-display',
  // Space
  '--space-unit',
  '--section-gap',
  '--tap-min',
  // Motion
  '--motion-duration',
  '--motion-distance',
  '--motion-ease',
  // Call to action
  '--cta-radius',
  '--cta-pad-y',
  '--cta-pad-x',
  '--cta-bg',
  '--cta-fg',
] as const;

export type RequiredToken = (typeof REQUIRED_TOKENS)[number];

/**
 * Values used when a surface is quarantined and its baseline has not yet been resolved.
 *
 * Not a theme — a lifeboat. Every value is a defensible neutral that passes contrast, so
 * a page rendered entirely from these is plain but correct rather than broken. It is what
 * makes `decide()`'s `baseline_fallback` branch a real fallback and not a promise.
 */
export const FALLBACK_TOKENS: Readonly<Record<RequiredToken, string>> = {
  '--color-bg': '#0b0b12',
  '--color-surface': '#14141f',
  '--color-text': '#f4f4fa',
  '--color-text-muted': '#b4b4cc',
  '--color-accent': '#6ef3c8',
  '--color-on-accent': '#05130e',
  '--color-border': '#6a6a88',
  '--font-display': 'system-ui, sans-serif',
  '--font-body': 'system-ui, sans-serif',
  '--scale-ratio': '1.25',
  '--measure': '68ch',
  '--tracking-display': '-0.02em',
  '--space-unit': '8px',
  '--section-gap': '72px',
  '--tap-min': '48px',
  '--motion-duration': '180ms',
  '--motion-distance': '8px',
  '--motion-ease': 'cubic-bezier(0.2, 0, 0, 1)',
  '--cta-radius': '999px',
  '--cta-pad-y': '14px',
  '--cta-pad-x': '28px',
  '--cta-bg': '#6ef3c8',
  '--cta-fg': '#05130e',
};

export interface TokenContractResult {
  readonly complete: boolean;
  readonly missing: readonly RequiredToken[];
}

export function checkTokenContract(tokens: Readonly<Record<string, string>>): TokenContractResult {
  const missing = REQUIRED_TOKENS.filter((t) => tokens[t] === undefined);
  return { complete: missing.length === 0, missing };
}

/**
 * Merge variant token bags over the fallback, in declaration order.
 *
 * Later bags win, which is why the order in the caller matters: palette, then typography,
 * then density, then motion, then CTA style. A surface may only override what it owns,
 * and the fallback guarantees the result is always complete.
 */
export function composeTokens(
  ...bags: readonly Readonly<Record<string, string>>[]
): Readonly<Record<string, string>> {
  return Object.assign({}, FALLBACK_TOKENS, ...bags) as Record<string, string>;
}
