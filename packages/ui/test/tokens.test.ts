import { describe, expect, it } from 'vitest';
import { SURFACES, checkContrast, tokensToStyleAttribute } from '@morph/core';
import {
  composeTokens,
  checkTokenContract,
  FALLBACK_TOKENS,
  REQUIRED_TOKENS,
} from '../src/tokens.js';

/**
 * The token contract is the seam between the optimiser and the rendering. These tests
 * are what stop a variant from producing a page that looks fine on the reviewer's
 * machine and is broken everywhere else.
 */

describe('the required token set', () => {
  it('has no duplicates', () => {
    expect(new Set(REQUIRED_TOKENS).size).toBe(REQUIRED_TOKENS.length);
  });

  it('is fully covered by the fallback', () => {
    const result = checkTokenContract(FALLBACK_TOKENS);
    expect(result.missing).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('names every token that is missing, not just the first', () => {
    const partial = { ...FALLBACK_TOKENS } as Record<string, string>;
    delete partial['--color-border'];
    delete partial['--tap-min'];

    const result = checkTokenContract(partial);
    expect(result.complete).toBe(false);
    expect([...result.missing].sort()).toEqual(['--color-border', '--tap-min']);
  });
});

describe('the fallback is a lifeboat, not a theme', () => {
  /**
   * `decide()` has a `baseline_fallback` branch for the case where every variant of a
   * surface is quarantined. These values are what that branch renders, so they have to
   * be legible on their own — otherwise the fallback is a promise rather than a
   * fallback.
   */
  it('passes WCAG AA on every pair the palette surface declares', () => {
    for (const requirement of SURFACES['theme.palette'].a11y.contrast ?? []) {
      const [fg, bg] = requirement.pair;
      const result = checkContrast(
        FALLBACK_TOKENS[fg as keyof typeof FALLBACK_TOKENS],
        FALLBACK_TOKENS[bg as keyof typeof FALLBACK_TOKENS],
        requirement.role,
      );
      expect(result.passes, `${fg} on ${bg} is ${String(result.ratio)}:1`).toBe(true);
    }
  });

  it('keeps the CTA legible', () => {
    const result = checkContrast(FALLBACK_TOKENS['--cta-fg'], FALLBACK_TOKENS['--cta-bg'], 'body');
    expect(result.passes).toBe(true);
  });

  it('keeps the tap target above the WCAG 2.2 floor', () => {
    expect(Number.parseInt(FALLBACK_TOKENS['--tap-min'], 10)).toBeGreaterThanOrEqual(44);
  });

  it('renders as a valid style attribute', () => {
    expect(() => tokensToStyleAttribute(FALLBACK_TOKENS)).not.toThrow();
  });
});

describe('composeTokens', () => {
  it('always produces a complete bag, whatever it is given', () => {
    expect(checkTokenContract(composeTokens()).complete).toBe(true);
    expect(checkTokenContract(composeTokens({ '--color-bg': '#fff' })).complete).toBe(true);
  });

  it('lets later bags win, in declaration order', () => {
    const composed = composeTokens(
      { '--color-bg': '#111111' },
      { '--color-bg': '#222222', '--space-unit': '4px' },
    );
    expect(composed['--color-bg']).toBe('#222222');
    expect(composed['--space-unit']).toBe('4px');
  });

  it('keeps the fallback for anything a surface did not override', () => {
    const composed = composeTokens({ '--color-bg': '#111111' });
    expect(composed['--motion-ease']).toBe(FALLBACK_TOKENS['--motion-ease']);
  });

  it('does not mutate the fallback', () => {
    const before = FALLBACK_TOKENS['--color-bg'];
    composeTokens({ '--color-bg': '#000000' });
    expect(FALLBACK_TOKENS['--color-bg']).toBe(before);
  });

  /**
   * The real composition the renderer performs: palette, typography, density, motion,
   * CTA style. Every shipped combination must produce a complete, renderable bag.
   */
  it('produces a complete bag for every shipped variant combination', () => {
    const bagsOf = (
      surfaceId:
        'theme.palette' | 'theme.typography' | 'layout.density' | 'motion.intensity' | 'cta.style',
    ) =>
      SURFACES[surfaceId].variants.map(
        (v) => (v.payload as { tokens?: Record<string, string> }).tokens ?? {},
      );

    for (const palette of bagsOf('theme.palette')) {
      for (const typography of bagsOf('theme.typography')) {
        for (const density of bagsOf('layout.density')) {
          for (const motion of bagsOf('motion.intensity')) {
            for (const cta of bagsOf('cta.style')) {
              const composed = composeTokens(palette, typography, density, motion, cta);
              expect(checkTokenContract(composed).missing).toEqual([]);
              expect(() => tokensToStyleAttribute(composed)).not.toThrow();
            }
          }
        }
      }
    }
  });
});
