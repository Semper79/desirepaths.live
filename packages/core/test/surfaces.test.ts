import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertRegistryValid,
  BASELINE_ASSIGNMENT,
  defineSurface,
  REGISTRY_WARNINGS,
  SURFACE_KEYS,
  SURFACE_LIST,
  SURFACES,
  validateSurface,
  type AnySurface,
} from '../src/surfaces/index.js';
import { checkContrast } from '../src/color.js';

describe('the shipped registry', () => {
  it('loads without a single error', () => {
    // `registry.ts` calls assertRegistryValid at module load, so importing it at all
    // is already the assertion. This makes the guarantee explicit and re-runnable.
    expect(() => assertRegistryValid(SURFACE_LIST as readonly AnySurface[])).not.toThrow();
    expect(REGISTRY_WARNINGS.every((w) => w.severity === 'warning')).toBe(true);
  });

  it('covers every surface named in the specification', () => {
    expect([...SURFACE_KEYS].sort()).toEqual(
      [
        'content.feed_ranking',
        'cta.copy',
        'cta.style',
        'hero.headline',
        'hero.media',
        'layout.density',
        'layout.order',
        'motion.intensity',
        'signup.providers_order',
        'theme.palette',
        'theme.typography',
      ].sort(),
    );
  });

  it('gives every surface exactly one baseline variant, and that variant is active', () => {
    for (const surface of SURFACE_LIST) {
      const baselines = surface.variants.filter((v) => v.provenance.origin === 'baseline');
      expect(baselines).toHaveLength(1);
      expect(baselines[0]?.id).toBe(surface.baselineVariantId);
      expect(baselines[0]?.status).toBe('active');
    }
  });

  it('exposes a complete baseline assignment', () => {
    expect(Object.keys(BASELINE_ASSIGNMENT).sort()).toEqual([...SURFACE_KEYS].sort());
    for (const key of SURFACE_KEYS) {
      expect(BASELINE_ASSIGNMENT[key]).toBe(SURFACES[key].baselineVariantId);
    }
  });

  it('scopes every variant id to its surface', () => {
    for (const surface of SURFACE_LIST) {
      for (const v of surface.variants) expect(v.id.startsWith(`${surface.id}#`)).toBe(true);
    }
  });

  it('stays within its own active-variant caps', () => {
    for (const surface of SURFACE_LIST) {
      const active = surface.variants.filter((v) => v.status === 'active');
      expect(active.length).toBeLessThanOrEqual(surface.constraints.maxActiveVariants);
    }
  });
});

describe('the accessibility gate', () => {
  it('proves every shipped palette clears WCAG AA on every declared pair', () => {
    const palette = SURFACES['theme.palette'];
    for (const variant of palette.variants) {
      const tokens = (variant.payload as { tokens: Record<string, string> }).tokens;
      for (const requirement of palette.a11y.contrast ?? []) {
        const [fg, bg] = requirement.pair;
        const result = checkContrast(
          tokens[fg] as string,
          tokens[bg] as string,
          requirement.role,
        );
        expect(
          result.passes,
          `${variant.id}: ${fg} on ${bg} is ${String(result.ratio)}:1`,
        ).toBe(true);
      }
    }
  });

  it('rejects a palette that fails contrast, before it can ever be served', () => {
    const bad = defineSurface({
      id: 'test.palette',
      kind: 'theme',
      description: 'A palette with a contrast failure.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      a11y: { contrast: [{ pair: ['--fg', '--bg'], role: 'body' }] },
      schema: z.object({ tokens: z.record(z.string(), z.string()) }),
      baseline: 'ok',
      variants: [
        {
          slug: 'ok',
          label: 'Fine',
          origin: 'baseline',
          payload: { tokens: { '--fg': '#000000', '--bg': '#ffffff' } },
        },
        {
          slug: 'bad',
          label: 'Illegible',
          payload: { tokens: { '--fg': '#777777', '--bg': '#ffffff' } },
        },
      ],
    });

    const issues = validateSurface(bad);
    const failures = issues.filter((i) => i.rule === 'a11y/contrast');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.variant).toBe('test.palette#bad');
    expect(failures[0]?.message).toContain('below the 4.5:1 required');
    expect(() => assertRegistryValid([bad])).toThrow(/Surface registry is invalid/);
  });

  it('warns when a passing pair has almost no margin', () => {
    const thin = defineSurface({
      id: 'test.margin',
      kind: 'theme',
      description: 'A palette that barely passes.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      a11y: { contrast: [{ pair: ['--fg', '--bg'], role: 'body' }] },
      schema: z.object({ tokens: z.record(z.string(), z.string()) }),
      baseline: 'thin',
      variants: [
        {
          slug: 'thin',
          label: 'Only just',
          origin: 'baseline',
          payload: { tokens: { '--fg': '#767676', '--bg': '#ffffff' } },
        },
      ],
    });
    const warnings = validateSurface(thin).filter((i) => i.severity === 'warning');
    expect(warnings.map((w) => w.rule)).toContain('a11y/contrast-margin');
  });

  it('flags a contrast requirement whose token the variant never defines', () => {
    const missing = defineSurface({
      id: 'test.missing',
      kind: 'theme',
      description: 'A palette missing a token.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      a11y: { contrast: [{ pair: ['--fg', '--nope'], role: 'body' }] },
      schema: z.object({ tokens: z.record(z.string(), z.string()) }),
      baseline: 'x',
      variants: [
        { slug: 'x', label: 'X', origin: 'baseline', payload: { tokens: { '--fg': '#000000' } } },
      ],
    });
    expect(validateSurface(missing).map((i) => i.rule)).toContain('a11y/contrast-missing-token');
  });

  it('flags a surface that declares contrast but has no token bag at all', () => {
    const wrong = defineSurface({
      id: 'test.notokens',
      kind: 'theme',
      description: 'Declares contrast without tokens.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      a11y: { contrast: [{ pair: ['--fg', '--bg'], role: 'body' }] },
      schema: z.object({ label: z.string() }),
      baseline: 'x',
      variants: [{ slug: 'x', label: 'X', origin: 'baseline', payload: { label: 'hello' } }],
    });
    expect(validateSurface(wrong).map((i) => i.rule)).toContain('a11y/contrast-tokens');
  });

  it('rejects copy above the surface reading-level ceiling', () => {
    const dense = defineSurface({
      id: 'test.copy',
      kind: 'copy',
      description: 'Copy with a reading ceiling.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      a11y: { maxReadingGrade: 6 },
      schema: z.object({ text: z.string() }),
      baseline: 'plain',
      variants: [
        { slug: 'plain', label: 'Plain', origin: 'baseline', payload: { text: 'We help you.' } },
        {
          slug: 'corporate',
          label: 'Corporate',
          payload: {
            text: 'Leveraging synergistic infrastructural transformation methodologies, our organisation systematically operationalises unprecedented multidimensional optimisation paradigms.',
          },
        },
      ],
    });
    const issues = validateSurface(dense).filter((i) => i.rule === 'a11y/reading-level');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.variant).toBe('test.copy#corporate');
  });

  it('requires an animating surface to keep a reduced-motion-safe option', () => {
    const motion = defineSurface({
      id: 'test.motion',
      kind: 'theme',
      description: 'Animates without a safe fallback.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      a11y: { animates: true },
      schema: z.object({ reducedMotionSafe: z.boolean() }),
      baseline: 'wild',
      variants: [{ slug: 'wild', label: 'Wild', origin: 'baseline', payload: { reducedMotionSafe: false } }],
    });
    expect(validateSurface(motion).map((i) => i.rule)).toContain('a11y/reduced-motion-fallback');
  });
});

describe('structural validation', () => {
  const minimal = (over: Partial<Parameters<typeof defineSurface>[0]> = {}): AnySurface =>
    defineSurface({
      id: 'test.minimal',
      kind: 'copy',
      description: 'Minimal surface.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      schema: z.object({ text: z.string().min(1) }),
      baseline: 'a',
      variants: [{ slug: 'a', label: 'A', origin: 'baseline', payload: { text: 'hi' } }],
      ...over,
    } as Parameters<typeof defineSurface>[0]);

  it('accepts a well-formed surface', () => {
    expect(validateSurface(minimal()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('rejects a duplicate variant id', () => {
    const surface = minimal({
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', payload: { text: 'hi' } },
        { slug: 'a', label: 'A again', payload: { text: 'ho' } },
      ],
    });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('variant/unique-id');
  });

  it('rejects a missing baseline', () => {
    const surface = minimal({ baseline: 'nope' });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('surface/baseline-exists');
  });

  it('rejects a baseline that is not marked as one', () => {
    const surface = minimal({
      variants: [{ slug: 'a', label: 'A', payload: { text: 'hi' } }],
    });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('surface/baseline-origin');
  });

  it('rejects a quarantined baseline', () => {
    const surface = minimal({
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', status: 'quarantined', payload: { text: 'hi' } },
        { slug: 'b', label: 'B', payload: { text: 'ho' } },
      ],
    });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('surface/baseline-active');
  });

  it('rejects a surface with nothing left to render', () => {
    const surface = minimal({
      variants: [{ slug: 'a', label: 'A', origin: 'baseline', status: 'retired', payload: { text: 'hi' } }],
    });
    const rules = validateSurface(surface).map((i) => i.rule);
    expect(rules).toContain('surface/has-active');
  });

  it('rejects more active variants than the cap allows', () => {
    const surface = minimal({
      constraints: { maxActiveVariants: 1 },
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', payload: { text: 'hi' } },
        { slug: 'b', label: 'B', payload: { text: 'ho' } },
      ],
    });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('surface/max-active');
  });

  it('rejects two pinned variants', () => {
    const surface = minimal({
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', payload: { text: 'hi' } },
        { slug: 'b', label: 'B', status: 'pinned', payload: { text: 'ho' } },
        { slug: 'c', label: 'C', status: 'pinned', payload: { text: 'he' } },
      ],
    });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('surface/single-pin');
  });

  it('rejects a payload that fails its schema', () => {
    const surface = minimal({
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', payload: { text: 'hi' } },
        { slug: 'b', label: 'B', payload: { text: '' } },
      ],
    });
    const issues = validateSurface(surface).filter((i) => i.rule === 'variant/schema');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.variant).toBe('test.minimal#b');
  });

  it('rejects a non-positive Beta prior', () => {
    const surface = minimal({
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', payload: { text: 'hi' } },
        { slug: 'b', label: 'B', payload: { text: 'ho' }, prior: { alpha: 0, beta: 1 } },
      ],
    });
    expect(validateSurface(surface).map((i) => i.rule)).toContain('variant/prior');
  });

  it('runs surface-specific invariants', () => {
    const surface = defineSurface({
      id: 'test.invariant',
      kind: 'strategy',
      description: 'Has an invariant.',
      objective: { components: ['signup'], primaryBinary: 'signup' },
      schema: z.object({ n: z.number() }),
      baseline: 'a',
      invariants: (p) => (p.n % 2 === 0 ? [] : ['n must be even.']),
      variants: [
        { slug: 'a', label: 'A', origin: 'baseline', payload: { n: 2 } },
        { slug: 'b', label: 'B', payload: { n: 3 } },
      ],
    });
    const issues = validateSurface(surface).filter((i) => i.rule === 'variant/invariant');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('n must be even.');
  });
});

describe('registry invariants that encode product rules', () => {
  it('keeps the hero first in every section ordering, so the LCP anchor never moves', () => {
    for (const v of SURFACES['layout.order'].variants) {
      expect((v.payload as { sections: string[] }).sections[0]).toBe('hero');
    }
  });

  it('offers a passwordless path in every provider ordering', () => {
    for (const v of SURFACES['signup.providers_order'].variants) {
      const order = (v.payload as { order: string[] }).order;
      expect(order.includes('email') || order.includes('passkey')).toBe(true);
    }
  });

  it('keeps every density variant above the 44px tap-target floor', () => {
    for (const v of SURFACES['layout.density'].variants) {
      const tap = Number.parseInt((v.payload as { tokens: Record<string, string> }).tokens['--tap-min'] ?? '0', 10);
      expect(tap).toBeGreaterThanOrEqual(44);
    }
  });

  it('keeps every hero media variant inside the 400KB budget', () => {
    for (const v of SURFACES['hero.media'].variants) {
      expect((v.payload as { estimatedKb: number }).estimatedKb).toBeLessThanOrEqual(400);
    }
  });

  it('makes hybrid feed weights sum to one', () => {
    for (const v of SURFACES['content.feed_ranking'].variants) {
      const p = v.payload as { strategy: string; weights?: { recency: number; trend: number; engagement: number } };
      if (p.strategy === 'hybrid' && p.weights) {
        expect(p.weights.recency + p.weights.trend + p.weights.engagement).toBeCloseTo(1, 10);
      }
    }
  });
});
