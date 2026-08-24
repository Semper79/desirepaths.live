import { describe, expect, it } from 'vitest';
import {
  TokenMap,
  TokenName,
  TokenValue,
  tokensToStyleAttribute,
  tokenValueIssues,
} from '../src/surfaces/tokens.js';

/**
 * This is the boundary a language-model-generated variant crosses on its way to a
 * visitor's browser. Every test here describes something a generated payload must
 * not be able to do.
 */

describe('token names', () => {
  it('accepts custom properties in kebab-case', () => {
    for (const name of ['--color-bg', '--space-unit', '--cta-pad-x', '--motion-duration']) {
      expect(TokenName.safeParse(name).success).toBe(true);
    }
  });

  it('rejects anything that is not a custom property', () => {
    for (const name of ['color-bg', '-color', '--Color', '--', '--1color', '--a b']) {
      expect(TokenName.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('token values', () => {
  it('accepts ordinary design-system values', () => {
    for (const value of [
      '#0b0b12',
      '8px',
      'oklch(0.62 0.15 250)',
      'var(--font-grotesk), system-ui, sans-serif',
      'cubic-bezier(0.2, 0, 0, 1)',
      'clamp(1rem, 2vw, 1.5rem)',
      'color-mix(in oklch, var(--color-accent) 40%, white)',
      'linear-gradient(180deg, #000, #fff)',
      '999px',
    ]) {
      expect(tokenValueIssues(value), value).toEqual([]);
      expect(TokenValue.safeParse(value).success, value).toBe(true);
    }
  });

  it('refuses to let a value escape its declaration', () => {
    expect(tokenValueIssues('red; background: url(https://evil.example)')).not.toEqual([]);
    expect(tokenValueIssues('red} .x { color: blue')).not.toEqual([]);
  });

  it('refuses markup', () => {
    expect(tokenValueIssues('</style><script>alert(1)</script>')).not.toEqual([]);
  });

  it('refuses comments, at-rules and escapes', () => {
    expect(tokenValueIssues('red /* comment */')).not.toEqual([]);
    expect(tokenValueIssues('@import "evil.css"')).not.toEqual([]);
    expect(tokenValueIssues('\\75 rl(x)')).not.toEqual([]);
  });

  it('refuses any function that can reach the network', () => {
    expect(tokenValueIssues('url(https://evil.example/pixel.png)')).toContain(
      'Token value may not call `url()`.',
    );
    expect(tokenValueIssues('image-set("a.png" 1x)')).not.toEqual([]);
    expect(tokenValueIssues('EXPRESSION(alert(1))')).not.toEqual([]);
  });

  it('refuses unbalanced parentheses, which is how an escape usually starts', () => {
    expect(tokenValueIssues('var(--x')).toContain('Token value has unbalanced parentheses.');
  });

  it('checks every value, not every other one', () => {
    // Regression guard: a module-level /g regex keeps `lastIndex` between calls and
    // would silently pass every second value.
    for (let i = 0; i < 6; i += 1) {
      expect(tokenValueIssues('url(x)'), `iteration ${String(i)}`).not.toEqual([]);
    }
  });

  it('bounds the length', () => {
    expect(TokenValue.safeParse('a'.repeat(200)).success).toBe(false);
    expect(TokenValue.safeParse('').success).toBe(false);
  });
});

describe('TokenMap', () => {
  it('accepts a well-formed bag', () => {
    expect(
      TokenMap.safeParse({ '--color-bg': '#0b0b12', '--space-unit': '8px' }).success,
    ).toBe(true);
  });

  it('rejects a bag with one bad entry', () => {
    expect(
      TokenMap.safeParse({ '--color-bg': '#0b0b12', '--evil': 'url(https://x)' }).success,
    ).toBe(false);
  });
});

describe('tokensToStyleAttribute', () => {
  it('renders a deterministic, sorted declaration list', () => {
    expect(
      tokensToStyleAttribute({ '--color-text': '#fff', '--color-bg': '#000' }),
    ).toBe('--color-bg:#000;--color-text:#fff');
  });

  it('renders an empty bag as an empty string', () => {
    expect(tokensToStyleAttribute({})).toBe('');
  });

  it('re-validates rather than trusting its caller', () => {
    expect(() => tokensToStyleAttribute({ '--bg': 'url(https://evil.example)' })).toThrow(
      /Refusing to render token/,
    );
    expect(() => tokensToStyleAttribute({ bad: '#fff' })).toThrow(
      /Refusing to render invalid token name/,
    );
  });
});
