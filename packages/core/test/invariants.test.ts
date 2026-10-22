import { describe, expect, it } from 'vitest';
import { SURFACES } from '../src/surfaces/registry';
import { validateSurface } from '../src/surfaces/define';
import { oklchToRgb, rgbToHex } from '../src/color';
import { syllablesIn } from '../src/text';
import { tokensToStyleAttribute } from '../src/surfaces/tokens';
import { variantId } from '../src/brand';
import type { AnySurface } from '../src/surfaces/types';

/**
 * Each surface's `invariants` function encodes a product rule that the zod schema
 * cannot express. These are the rules, tested directly: a rule that is never
 * exercised is a rule nobody can rely on.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shapes differ per surface; each call site is checked by the surface itself
const run = (surface: AnySurface, payload: any): readonly string[] =>
  surface.invariants?.(payload) ?? [];

describe('hero.media invariants', () => {
  const surface = SURFACES['hero.media'];
  const ok = {
    kind: 'gradient' as const,
    alt: '',
    reducedMotionSafe: true,
    estimatedKb: 0,
    tokens: {},
  };

  it('accepts a valid payload', () => {
    expect(run(surface, ok)).toEqual([]);
  });

  it('requires a source for image and video variants', () => {
    expect(run(surface, { ...ok, kind: 'image', alt: 'x' })[0]).toContain('requires a src');
    expect(run(surface, { ...ok, kind: 'video_loop', reducedMotionSafe: false })[0]).toContain(
      'requires a src',
    );
  });

  it('requires alt text on a content image', () => {
    expect(run(surface, { ...ok, kind: 'image', src: '/a.avif', alt: '' })).toContain(
      'A content image needs alt text; use kind gradient for decoration.',
    );
  });

  it('refuses to call a looping video reduced-motion safe', () => {
    expect(
      run(surface, { ...ok, kind: 'video_loop', src: '/a.mp4', reducedMotionSafe: true }),
    ).toContain('A looping video is never reduced-motion safe.');
  });

  it('enforces the 400KB hero budget at authoring time', () => {
    expect(run(surface, { ...ok, estimatedKb: 900 })[0]).toContain('exceeds the 400KB hero budget');
  });
});

describe('layout.density invariants', () => {
  const surface = SURFACES['layout.density'];

  it('accepts a compliant tap target', () => {
    expect(run(surface, { level: 'dense', tokens: { '--tap-min': '44px' } })).toEqual([]);
  });

  it('refuses to compress a tap target below the WCAG floor', () => {
    expect(run(surface, { level: 'dense', tokens: { '--tap-min': '32px' } })[0]).toContain(
      'the floor is 44px',
    );
  });

  it('treats a missing tap token as a violation rather than a pass', () => {
    expect(run(surface, { level: 'dense', tokens: {} })[0]).toContain('the floor is 44px');
  });
});

describe('layout.order invariants', () => {
  const surface = SURFACES['layout.order'];
  const valid = ['hero', 'live_proof', 'trending', 'how_it_works', 'signup', 'social_proof'];

  it('accepts a permutation that keeps the hero first', () => {
    expect(run(surface, { sections: valid })).toEqual([]);
  });

  it('rejects a list that is not a permutation', () => {
    expect(
      run(surface, { sections: ['hero', 'hero', 'trending', 'how_it_works', 'signup', 'signup'] }),
    ).toContain('Section order must be a permutation: every section exactly once.');
  });

  it('refuses to move the hero, which is the LCP anchor', () => {
    const moved = ['trending', 'hero', 'live_proof', 'how_it_works', 'signup', 'social_proof'];
    expect(run(surface, { sections: moved })).toContain(
      'The hero must remain the first section (LCP anchor).',
    );
  });
});

describe('signup.providers_order invariants', () => {
  const surface = SURFACES['signup.providers_order'];

  it('accepts an ordering with a passwordless fallback', () => {
    expect(run(surface, { order: ['discord', 'google', 'apple', 'email'] })).toEqual([]);
  });

  it('rejects duplicates', () => {
    expect(run(surface, { order: ['google', 'google', 'email'] })).toContain(
      'Provider order contains duplicates.',
    );
  });

  it('requires a passwordless path to exist at all', () => {
    expect(run(surface, { order: ['google', 'apple', 'discord', 'tiktok'] })).toContain(
      'No passwordless fallback (email or passkey) offered.',
    );
  });

  it('accepts a three-button ordering without complaint', () => {
    expect(run(surface, { order: ['google', 'apple', 'discord'] })).toEqual([]);
  });
});

describe('motion.intensity invariants', () => {
  const surface = SURFACES['motion.intensity'];

  it('accepts coherent declarations', () => {
    expect(run(surface, { level: 'subtle', reducedMotionSafe: true, tokens: {} })).toEqual([]);
    expect(run(surface, { level: 'none', reducedMotionSafe: true, tokens: {} })).toEqual([]);
    expect(run(surface, { level: 'expressive', reducedMotionSafe: false, tokens: {} })).toEqual([]);
  });

  it('rejects a no-motion variant that claims not to be reduced-motion safe', () => {
    expect(run(surface, { level: 'none', reducedMotionSafe: false, tokens: {} })).toContain(
      'A variant with no motion is by definition reduced-motion safe.',
    );
  });

  it('rejects expressive motion that claims to be safe', () => {
    expect(run(surface, { level: 'expressive', reducedMotionSafe: true, tokens: {} })).toContain(
      'Expressive motion cannot claim to be reduced-motion safe.',
    );
  });
});

describe('content.feed_ranking invariants', () => {
  const surface = SURFACES['content.feed_ranking'];

  it('accepts a simple strategy with no weights', () => {
    expect(run(surface, { strategy: 'recency' })).toEqual([]);
  });

  it('rejects weights on a strategy that does not use them', () => {
    expect(
      run(surface, { strategy: 'recency', weights: { recency: 1, trend: 0, engagement: 0 } }),
    ).toContain('Weights are only valid for the hybrid strategy.');
  });

  it('requires weights for the hybrid strategy', () => {
    expect(run(surface, { strategy: 'hybrid' })).toContain('The hybrid strategy requires weights.');
  });

  it('requires hybrid weights to sum to one', () => {
    expect(
      run(surface, {
        strategy: 'hybrid',
        weights: { recency: 0.5, trend: 0.5, engagement: 0.5 },
      })[0],
    ).toContain('sum to 1.500');
  });

  it('accepts weights that do sum to one', () => {
    expect(
      run(surface, { strategy: 'hybrid', weights: { recency: 0.3, trend: 0.4, engagement: 0.3 } }),
    ).toEqual([]);
  });
});

describe('validation of a hand-built surface', () => {
  it('catches a variant id that is not scoped to its surface', () => {
    // Unreachable through `defineSurface`, which always prefixes. Reachable through
    // the database seed path, which is exactly why the check exists.
    const smuggled = {
      ...SURFACES['cta.copy'],
      variants: [
        ...SURFACES['cta.copy'].variants,
        {
          id: variantId('other.surface#sneaky'),
          label: 'Sneaky',
          payload: { text: 'Hello' },
          status: 'active' as const,
          provenance: { origin: 'generated' as const, createdAt: '2026-08-24T00:00:00.000Z' },
        },
      ],
    };
    expect(validateSurface(smuggled).map((i) => i.rule)).toContain('variant/id-prefix');
  });
});

describe('numeric and text edges reached only by odd inputs', () => {
  it('counts a vowel-less word as one syllable', () => {
    expect(syllablesIn('pfffft')).toBe(1);
  });

  it('clamps a lightness above the sRGB ceiling to white', () => {
    expect(rgbToHex(oklchToRgb({ l: 1.4, c: 0, h: 0 }))).toBe('#ffffff');
  });

  it('sorts token declarations regardless of insertion order', () => {
    expect(tokensToStyleAttribute({ '--zz': '1px', '--aa': '2px' })).toBe('--aa:2px;--zz:1px');
    expect(tokensToStyleAttribute({ '--aa': '2px', '--zz': '1px' })).toBe('--aa:2px;--zz:1px');
  });
});
