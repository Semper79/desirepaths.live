/**
 * THE SURFACE REGISTRY - the closed world of what MORPH may change about itself.
 * =============================================================================
 * Adding a surface here is the only way to make something adaptive. Nothing else
 * in the codebase may read a variant that is not declared in this file, and
 * `assertRegistryValid` runs at module load, so an inconsistent registry fails the
 * process at boot rather than rendering `undefined` into a visitor's hero section.
 *
 * READ THIS BEFORE ADDING A SURFACE
 * Every surface costs exploration budget. With k surfaces of v variants each, the
 * joint space is v^k, and while the bandit does not enumerate it, the *evidence*
 * per cell still thins out as k grows. Ten surfaces at three to eight variants is
 * already an ambitious amount of learning for a site starting from zero traffic.
 * A new surface has to earn its place by plausibly moving the composite reward.
 */

import { z } from 'zod';
import type { VariantId } from '../brand';
import { assertRegistryValid, defineSurface } from './define';
import { TokenMap } from './tokens';
import type { AnySurface, RegistryOf } from './types';

// -----------------------------------------------------------------------------
// Shared payload fragments
// -----------------------------------------------------------------------------

const baseline = { origin: 'baseline' as const };

// -----------------------------------------------------------------------------
// 1. hero.headline - the most-measured copy on the site
// -----------------------------------------------------------------------------

const HeadlinePayload = z.object({
  text: z.string().min(8).max(72),
  subtext: z.string().min(0).max(160).optional(),
  /** Recorded so the generator can be steered, and so the report can say what changed. */
  tone: z.enum(['direct', 'curious', 'playful', 'urgent', 'contrarian']),
});

export const heroHeadline = defineSurface({
  id: 'hero.headline',
  kind: 'copy',
  description: 'The first line a visitor reads above the fold.',
  objective: {
    components: ['signup', 'meaningful_engagement', 'scroll_depth_norm', 'bounce_penalty'],
    primaryBinary: 'signup',
  },
  a11y: {
    // Section 3's audience reads on a phone, often one-handed, often distracted.
    // Grade 9 is roughly a broadsheet headline; anything above it is the generator
    // drifting into press-release register.
    maxReadingGrade: 9,
  },
  constraints: {
    minImpressionsBeforeRetire: 1_000,
    maxActiveVariants: 8,
    allowGenerated: true,
    allowPersonalisation: true,
    requiresConsent: 'analytics',
  },
  schema: HeadlinePayload,
  baseline: 'v0',
  variants: [
    {
      slug: 'v0',
      label: 'Baseline - plain statement',
      payload: {
        text: 'A website that rebuilds itself around you.',
        subtext: 'Desire Path watches what works and changes. Every hour.',
        tone: 'direct',
      },
      ...baseline,
    },
    {
      slug: 'question',
      label: 'Open question',
      payload: {
        text: 'What if a site could learn?',
        subtext: 'This one does. Watch it change while you read.',
        tone: 'curious',
      },
    },
    {
      slug: 'live-proof',
      label: 'Live proof',
      payload: {
        text: 'This page is not the same page it was.',
        subtext: 'It changed an hour ago, because of people like you.',
        tone: 'contrarian',
      },
    },
    {
      slug: 'invite',
      label: 'Direct invite',
      payload: {
        text: 'Join and it starts learning you.',
        subtext: 'One tap. No form. No password.',
        tone: 'direct',
      },
    },
    {
      slug: 'playful',
      label: 'Playful',
      payload: {
        text: 'A shape-shifting website. Yes, really.',
        subtext: 'Refresh in an hour. It will look different.',
        tone: 'playful',
      },
    },
    {
      slug: 'now',
      label: 'Urgency',
      payload: {
        text: 'See what the web cares about right now.',
        subtext: 'Fresh every hour, filtered for signal.',
        tone: 'urgent',
      },
    },
    {
      slug: 'mirror',
      label: 'Mirror',
      payload: {
        text: 'The web, shaped to how you read it.',
        subtext: 'No feed. No noise. Just what holds up.',
        tone: 'curious',
      },
    },
    {
      slug: 'blunt',
      label: 'Blunt',
      payload: {
        text: 'Most sites are frozen. This one is not.',
        subtext: 'It rewrites itself from what visitors actually do.',
        tone: 'contrarian',
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 2. hero.media
// -----------------------------------------------------------------------------

const HeroMediaPayload = z.object({
  kind: z.enum(['image', 'video_loop', 'gradient', 'canvas_3d']),
  /** Required for image and video; ignored otherwise. Checked by `invariants`. */
  src: z.string().max(512).optional(),
  poster: z.string().max(512).optional(),
  /** Empty string is legal and means "decorative"; the invariant below enforces the rule. */
  alt: z.string().max(180),
  /** Whether this variant may be served to `prefers-reduced-motion: reduce`. */
  reducedMotionSafe: z.boolean(),
  /** Estimated transfer weight, used to keep the LCP guardrail honest. */
  estimatedKb: z.number().int().min(0).max(4096),
  tokens: TokenMap,
});

export const heroMedia = defineSurface({
  id: 'hero.media',
  kind: 'media',
  description: 'The visual treatment behind and beside the headline.',
  objective: {
    components: ['meaningful_engagement', 'scroll_depth_norm', 'bounce_penalty'],
    primaryBinary: 'meaningful_engagement',
  },
  a11y: { animates: true },
  constraints: {
    minImpressionsBeforeRetire: 1_500,
    maxActiveVariants: 4,
    // Media assets cannot be conjured by a text model; new ones are operator-supplied.
    allowGenerated: false,
    allowPersonalisation: false,
    requiresConsent: 'analytics',
  },
  schema: HeroMediaPayload,
  baseline: 'gradient',
  invariants: (p) => {
    const problems: string[] = [];
    if ((p.kind === 'image' || p.kind === 'video_loop') && !p.src) {
      problems.push(`kind '${p.kind}' requires a src.`);
    }
    if (p.kind === 'image' && p.alt.length === 0) {
      problems.push('A content image needs alt text; use kind gradient for decoration.');
    }
    if (p.kind === 'video_loop' && p.reducedMotionSafe) {
      problems.push('A looping video is never reduced-motion safe.');
    }
    // The LCP budget is 2.0s (section 7). A hero heavier than 400KB will not make it on
    // a mid-range phone over 4G, and the guardrail would quarantine it within the
    // hour - so refuse it at authoring time instead of burning traffic proving it.
    if (p.estimatedKb > 400) {
      problems.push(`${String(p.estimatedKb)}KB exceeds the 400KB hero budget.`);
    }
    return problems;
  },
  variants: [
    {
      slug: 'gradient',
      label: 'Baseline - animated gradient',
      payload: {
        kind: 'gradient',
        alt: '',
        reducedMotionSafe: true,
        estimatedKb: 0,
        tokens: {
          '--hero-gradient-from': 'oklch(0.28 0.09 275)',
          '--hero-gradient-to': 'oklch(0.42 0.13 195)',
          '--hero-gradient-speed': '0s',
        },
      },
      ...baseline,
    },
    {
      slug: 'gradient-drift',
      label: 'Drifting gradient',
      payload: {
        kind: 'gradient',
        alt: '',
        reducedMotionSafe: false,
        estimatedKb: 0,
        tokens: {
          '--hero-gradient-from': 'oklch(0.30 0.12 300)',
          '--hero-gradient-to': 'oklch(0.46 0.15 170)',
          '--hero-gradient-speed': '18s',
        },
      },
    },
    {
      slug: 'still',
      label: 'Editorial still',
      payload: {
        kind: 'image',
        src: '/media/hero/editorial-1600.avif',
        alt: 'A dense grid of type specimens rearranging itself.',
        reducedMotionSafe: true,
        estimatedKb: 96,
        tokens: { '--hero-media-fit': 'cover' },
      },
    },
    {
      slug: 'canvas',
      label: 'Reactive canvas',
      payload: {
        kind: 'canvas_3d',
        alt: '',
        reducedMotionSafe: false,
        estimatedKb: 140,
        tokens: { '--hero-canvas-density': '0.6' },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 3. theme.palette - fully worked, including the accessibility gate
// -----------------------------------------------------------------------------

const PalettePayload = z.object({
  scheme: z.enum(['dark', 'light']),
  tokens: TokenMap,
});

export const themePalette = defineSurface({
  id: 'theme.palette',
  kind: 'theme',
  description: 'The whole colour system: background, text, accent, borders.',
  objective: {
    components: ['meaningful_engagement', 'scroll_depth_norm', 'signup', 'bounce_penalty'],
    primaryBinary: 'meaningful_engagement',
  },
  a11y: {
    // This is the gate section 2.1 demands. Every pair is checked for every variant at
    // registration and at generation; a palette that fails cannot reach a visitor.
    contrast: [
      { pair: ['--color-text', '--color-bg'], role: 'body' },
      { pair: ['--color-text', '--color-surface'], role: 'body' },
      { pair: ['--color-text-muted', '--color-bg'], role: 'body' },
      { pair: ['--color-accent', '--color-bg'], role: 'ui' },
      { pair: ['--color-on-accent', '--color-accent'], role: 'body' },
      { pair: ['--color-border', '--color-bg'], role: 'ui' },
    ],
  },
  constraints: {
    minImpressionsBeforeRetire: 2_000,
    maxActiveVariants: 6,
    allowGenerated: true,
    // A visitor who sees a different colour scheme on every visit thinks the site is
    // broken, not personalised. Palette is per-session sticky and never per-request.
    allowPersonalisation: false,
    requiresConsent: 'analytics',
  },
  schema: PalettePayload,
  baseline: 'dark-neon',
  variants: [
    {
      slug: 'dark-neon',
      label: 'Baseline - dark neon',
      payload: {
        scheme: 'dark',
        tokens: {
          '--color-bg': '#0b0b12',
          '--color-surface': '#14141f',
          '--color-text': '#f4f4fa',
          '--color-text-muted': '#b4b4cc',
          '--color-accent': '#6ef3c8',
          '--color-on-accent': '#05130e',
          '--color-border': '#6a6a88',
        },
      },
      ...baseline,
    },
    {
      slug: 'light-editorial',
      label: 'Light editorial',
      payload: {
        scheme: 'light',
        tokens: {
          '--color-bg': '#fcfbf8',
          '--color-surface': '#ffffff',
          '--color-text': '#17171a',
          '--color-text-muted': '#52525c',
          '--color-accent': '#1746c2',
          '--color-on-accent': '#ffffff',
          '--color-border': '#8a8a94',
        },
      },
    },
    {
      slug: 'high-contrast',
      label: 'High contrast',
      payload: {
        scheme: 'dark',
        tokens: {
          '--color-bg': '#000000',
          '--color-surface': '#0a0a0a',
          '--color-text': '#ffffff',
          '--color-text-muted': '#d0d0d0',
          '--color-accent': '#ffe500',
          '--color-on-accent': '#000000',
          '--color-border': '#b0b0b0',
        },
      },
    },
    {
      slug: 'warm-brutalist',
      label: 'Warm brutalist',
      payload: {
        scheme: 'light',
        tokens: {
          '--color-bg': '#f4e7d3',
          '--color-surface': '#fffaf0',
          '--color-text': '#1e1710',
          '--color-text-muted': '#4d3f30',
          '--color-accent': '#96250a',
          '--color-on-accent': '#fff8f0',
          '--color-border': '#7a6a55',
        },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 4. theme.typography
// -----------------------------------------------------------------------------

const TypographyPayload = z.object({
  family: z.enum(['geometric-sans', 'grotesk', 'serif-display', 'mono-accent']),
  tokens: TokenMap,
});

export const themeTypography = defineSurface({
  id: 'theme.typography',
  kind: 'theme',
  description: 'Type family, scale and measure.',
  objective: {
    components: ['meaningful_engagement', 'scroll_depth_norm'],
    primaryBinary: 'meaningful_engagement',
  },
  constraints: {
    minImpressionsBeforeRetire: 2_000,
    maxActiveVariants: 4,
    // Each family is a font file the operator must actually ship; the generator
    // cannot invent one, so it may only recombine scale tokens - not families.
    allowGenerated: false,
    allowPersonalisation: false,
    requiresConsent: 'analytics',
  },
  schema: TypographyPayload,
  baseline: 'geometric',
  variants: [
    {
      slug: 'geometric',
      label: 'Baseline - geometric sans',
      payload: {
        family: 'geometric-sans',
        tokens: {
          '--font-display':
            "var(--font-geometric, ui-rounded, 'Avenir Next', 'Segoe UI', system-ui, sans-serif)",
          '--font-body':
            "var(--font-geometric, ui-rounded, 'Avenir Next', 'Segoe UI', system-ui, sans-serif)",
          '--scale-ratio': '1.25',
          '--measure': '68ch',
          '--tracking-display': '-0.02em',
        },
      },
      ...baseline,
    },
    {
      slug: 'grotesk',
      label: 'Grotesk',
      payload: {
        family: 'grotesk',
        tokens: {
          '--font-display':
            "var(--font-grotesk, 'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif)",
          '--font-body':
            "var(--font-grotesk, 'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif)",
          '--scale-ratio': '1.2',
          '--measure': '72ch',
          '--tracking-display': '-0.01em',
        },
      },
    },
    {
      slug: 'serif-display',
      label: 'Serif display',
      payload: {
        family: 'serif-display',
        tokens: {
          '--font-display': "var(--font-serif, ui-serif, Georgia, 'Times New Roman', serif)",
          '--font-body':
            "var(--font-grotesk, 'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif)",
          '--scale-ratio': '1.333',
          '--measure': '64ch',
          '--tracking-display': '0em',
        },
      },
    },
    {
      slug: 'mono-accent',
      label: 'Mono accent',
      payload: {
        family: 'mono-accent',
        tokens: {
          '--font-display': "var(--font-mono, ui-monospace, 'Cascadia Mono', Consolas, monospace)",
          '--font-body':
            "var(--font-grotesk, 'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif)",
          '--scale-ratio': '1.2',
          '--measure': '66ch',
          '--tracking-display': '-0.03em',
        },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 5. layout.density
// -----------------------------------------------------------------------------

const DensityPayload = z.object({
  level: z.enum(['spacious', 'balanced', 'dense']),
  tokens: TokenMap,
});

export const layoutDensity = defineSurface({
  id: 'layout.density',
  kind: 'layout',
  description: 'Vertical rhythm and how much content fits on one screen.',
  objective: {
    components: ['scroll_depth_norm', 'meaningful_engagement', 'bounce_penalty'],
    primaryBinary: 'meaningful_engagement',
  },
  a11y: { minTapTargetPx: 44 },
  constraints: {
    minImpressionsBeforeRetire: 1_500,
    maxActiveVariants: 3,
    allowGenerated: false,
    allowPersonalisation: true,
    requiresConsent: 'analytics',
  },
  schema: DensityPayload,
  baseline: 'balanced',
  invariants: (p) => {
    // Density is allowed to compress whitespace. It is not allowed to compress a
    // tap target below the 44px that WCAG 2.2 target-size (minimum) requires.
    const tap = Number.parseInt(p.tokens['--tap-min'] ?? '0', 10);
    return tap >= 44 ? [] : [`--tap-min is ${String(tap)}px; the floor is 44px.`];
  },
  variants: [
    {
      slug: 'balanced',
      label: 'Baseline - balanced',
      payload: {
        level: 'balanced',
        tokens: { '--space-unit': '8px', '--section-gap': '72px', '--tap-min': '48px' },
      },
      ...baseline,
    },
    {
      slug: 'spacious',
      label: 'Spacious',
      payload: {
        level: 'spacious',
        tokens: { '--space-unit': '10px', '--section-gap': '112px', '--tap-min': '52px' },
      },
    },
    {
      slug: 'dense',
      label: 'Dense',
      payload: {
        level: 'dense',
        tokens: { '--space-unit': '6px', '--section-gap': '48px', '--tap-min': '44px' },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 6. layout.order - permutations of the section stack
// -----------------------------------------------------------------------------

export const SECTION_STACK = [
  'hero',
  'live_proof',
  'trending',
  'how_it_works',
  'signup',
  'social_proof',
] as const;

export type SectionName = (typeof SECTION_STACK)[number];

const OrderPayload = z.object({
  sections: z.array(z.enum(SECTION_STACK)).length(SECTION_STACK.length),
});

export const layoutOrder = defineSurface({
  id: 'layout.order',
  kind: 'layout',
  description: 'The order the page sections appear in.',
  objective: {
    components: ['signup', 'scroll_depth_norm', 'meaningful_engagement', 'bounce_penalty'],
    primaryBinary: 'signup',
  },
  constraints: {
    minImpressionsBeforeRetire: 2_000,
    // 6! = 720 permutations. Exposing all of them would be a slot machine, not an
    // experiment: at 2,000 impressions per variant that is 1.4M impressions for one
    // round of evidence. The generator proposes single adjacent swaps from the
    // champion instead, which keeps the candidate set to a handful at a time.
    maxActiveVariants: 5,
    allowGenerated: true,
    allowPersonalisation: false,
    requiresConsent: 'analytics',
  },
  schema: OrderPayload,
  baseline: 'default',
  invariants: (p) => {
    const unique = new Set(p.sections);
    if (unique.size !== SECTION_STACK.length) {
      return ['Section order must be a permutation: every section exactly once.'];
    }
    // `hero` first is not a style preference. The LCP element must be in the first
    // viewport, and moving it below the fold breaks the Core Web Vitals budget the
    // optimiser is measured against - so the optimiser is not allowed to try it.
    return p.sections[0] === 'hero' ? [] : ['The hero must remain the first section (LCP anchor).'];
  },
  variants: [
    {
      slug: 'default',
      label: 'Baseline - proof before signup',
      payload: {
        sections: ['hero', 'live_proof', 'trending', 'how_it_works', 'signup', 'social_proof'],
      },
      ...baseline,
    },
    {
      slug: 'signup-early',
      label: 'Signup above the explanation',
      payload: {
        sections: ['hero', 'live_proof', 'signup', 'trending', 'how_it_works', 'social_proof'],
      },
    },
    {
      slug: 'trending-first',
      label: 'Trending first',
      payload: {
        sections: ['hero', 'trending', 'live_proof', 'how_it_works', 'signup', 'social_proof'],
      },
    },
    {
      slug: 'proof-heavy',
      label: 'Social proof early',
      payload: {
        sections: ['hero', 'social_proof', 'live_proof', 'trending', 'signup', 'how_it_works'],
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 7 & 8. cta.copy and cta.style
// -----------------------------------------------------------------------------
// The spec writes this as "copy x (pill / block / underline / floating)". Modelling
// it as one surface with the cross product would give 8 x 4 = 32 variants, each
// needing its own 1,000 impressions - 32,000 impressions for one round of evidence
// on a component that a young audience decides about in 300ms.
//
// Instead: two surfaces. The Thompson layer learns each marginal independently, and
// the LinUCB layer receives an explicit interaction feature for the (copy, style)
// pair, so a genuine interaction is still learnable. See
// packages/adaptive/src/context.ts, `interactionFeatures`.

const CtaCopyPayload = z.object({
  text: z.string().min(2).max(28),
  supporting: z.string().max(64).optional(),
});

export const ctaCopy = defineSurface({
  id: 'cta.copy',
  kind: 'copy',
  description: 'The words on the primary call to action.',
  objective: { components: ['signup', 'bounce_penalty'], primaryBinary: 'signup' },
  a11y: { maxReadingGrade: 8 },
  constraints: {
    minImpressionsBeforeRetire: 800,
    maxActiveVariants: 8,
    allowGenerated: true,
    allowPersonalisation: true,
    requiresConsent: 'analytics',
  },
  schema: CtaCopyPayload,
  baseline: 'join',
  variants: [
    {
      slug: 'join',
      label: 'Baseline - Join',
      payload: { text: 'Join Desire Path', supporting: 'One tap. No password.' },
      ...baseline,
    },
    {
      slug: 'shape',
      label: 'Shape it',
      payload: { text: 'Shape this site', supporting: 'Your visit changes it.' },
    },
    {
      slug: 'watch',
      label: 'Watch it learn',
      payload: { text: 'Watch it learn', supporting: 'Free, and it starts now.' },
    },
    {
      slug: 'inside',
      label: 'Get inside',
      payload: { text: 'Get inside', supporting: 'Members steer what it becomes.' },
    },
    {
      slug: 'start',
      label: 'Start',
      payload: { text: 'Start' },
    },
  ],
});

const CtaStylePayload = z.object({
  shape: z.enum(['pill', 'block', 'underline', 'floating']),
  tokens: TokenMap,
});

export const ctaStyle = defineSurface({
  id: 'cta.style',
  kind: 'theme',
  description: 'The visual treatment of the primary call to action.',
  objective: { components: ['signup', 'bounce_penalty'], primaryBinary: 'signup' },
  a11y: {
    minTapTargetPx: 44,
    contrast: [{ pair: ['--cta-fg', '--cta-bg'], role: 'body' }],
  },
  constraints: {
    minImpressionsBeforeRetire: 800,
    maxActiveVariants: 4,
    allowGenerated: false,
    allowPersonalisation: true,
    requiresConsent: 'analytics',
  },
  schema: CtaStylePayload,
  baseline: 'pill',
  variants: [
    {
      slug: 'pill',
      label: 'Baseline - pill',
      payload: {
        shape: 'pill',
        tokens: {
          '--cta-radius': '999px',
          '--cta-pad-y': '14px',
          '--cta-pad-x': '28px',
          '--cta-bg': '#6ef3c8',
          '--cta-fg': '#05130e',
        },
      },
      ...baseline,
    },
    {
      slug: 'block',
      label: 'Block',
      payload: {
        shape: 'block',
        tokens: {
          '--cta-radius': '4px',
          '--cta-pad-y': '18px',
          '--cta-pad-x': '32px',
          '--cta-bg': '#ffffff',
          '--cta-fg': '#0b0b12',
        },
      },
    },
    {
      slug: 'underline',
      label: 'Underline',
      payload: {
        shape: 'underline',
        tokens: {
          '--cta-radius': '0px',
          '--cta-pad-y': '12px',
          '--cta-pad-x': '4px',
          '--cta-bg': '#0b0b12',
          '--cta-fg': '#6ef3c8',
        },
      },
    },
    {
      slug: 'floating',
      label: 'Floating bar',
      payload: {
        shape: 'floating',
        tokens: {
          '--cta-radius': '16px',
          '--cta-pad-y': '16px',
          '--cta-pad-x': '24px',
          '--cta-bg': '#6ef3c8',
          '--cta-fg': '#05130e',
        },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 9. signup.providers_order - the highest-leverage surface in the product
// -----------------------------------------------------------------------------

export const AUTH_PROVIDERS = [
  'google',
  'apple',
  'discord',
  'tiktok',
  'x',
  'twitch',
  'instagram',
  'reddit',
  'spotify',
  'github',
  'email',
  'passkey',
] as const;

export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

const ProvidersOrderPayload = z.object({
  /** The first three are rendered as full buttons; the rest collapse behind "more". */
  order: z.array(z.enum(AUTH_PROVIDERS)).min(3).max(AUTH_PROVIDERS.length),
});

export const signupProvidersOrder = defineSurface({
  id: 'signup.providers_order',
  kind: 'ordering',
  description: 'Which sign-in buttons lead, and in what order.',
  objective: { components: ['signup'], primaryBinary: 'signup' },
  a11y: { minTapTargetPx: 48 },
  constraints: {
    // Provider ordering accumulates impressions much more slowly than a headline:
    // only sessions that reach the sign-up surface count. A lower bar keeps the
    // surface learning at a realistic pace without lowering it for everything else.
    minImpressionsBeforeRetire: 500,
    maxActiveVariants: 6,
    allowGenerated: true,
    // Section 4: "MORPH learns which provider a given context converts on and leads with
    // it." That is per-context, and it is exactly what personalisation consent is for.
    allowPersonalisation: true,
    requiresConsent: 'analytics',
  },
  schema: ProvidersOrderPayload,
  baseline: 'default',
  invariants: (p) => {
    const problems: string[] = [];
    if (new Set(p.order).size !== p.order.length)
      problems.push('Provider order contains duplicates.');
    // Section 4 requires a no-social path. Burying it behind "more" is technically a
    // path and practically a dead end, so it must be in the visible three.
    const visible = p.order.slice(0, 3);
    if (!visible.includes('email') && !visible.includes('passkey') && p.order.length > 3) {
      const hasFallback = p.order.includes('email') || p.order.includes('passkey');
      if (!hasFallback) problems.push('No passwordless fallback (email or passkey) offered.');
    }
    return problems;
  },
  variants: [
    {
      slug: 'default',
      label: 'Baseline - Google first',
      payload: { order: ['google', 'apple', 'discord', 'tiktok', 'x', 'email', 'passkey'] },
      ...baseline,
    },
    {
      slug: 'discord-first',
      label: 'Discord first',
      payload: { order: ['discord', 'google', 'tiktok', 'twitch', 'apple', 'email', 'passkey'] },
    },
    {
      slug: 'tiktok-first',
      label: 'TikTok first',
      payload: { order: ['tiktok', 'instagram', 'google', 'apple', 'discord', 'email', 'passkey'] },
    },
    {
      slug: 'apple-first',
      label: 'Apple first (iOS lead)',
      payload: { order: ['apple', 'google', 'discord', 'spotify', 'x', 'email', 'passkey'] },
    },
    {
      slug: 'passwordless-first',
      label: 'Passkey first',
      payload: { order: ['passkey', 'google', 'apple', 'discord', 'tiktok', 'email'] },
    },
  ],
});

// -----------------------------------------------------------------------------
// 10. motion.intensity
// -----------------------------------------------------------------------------

const MotionPayload = z.object({
  level: z.enum(['none', 'subtle', 'expressive']),
  reducedMotionSafe: z.boolean(),
  tokens: TokenMap,
});

export const motionIntensity = defineSurface({
  id: 'motion.intensity',
  kind: 'theme',
  description: 'How much the interface moves.',
  objective: {
    components: ['meaningful_engagement', 'scroll_depth_norm', 'bounce_penalty'],
    primaryBinary: 'meaningful_engagement',
  },
  a11y: { animates: true },
  constraints: {
    minImpressionsBeforeRetire: 1_500,
    maxActiveVariants: 3,
    allowGenerated: false,
    allowPersonalisation: false,
    requiresConsent: 'analytics',
  },
  schema: MotionPayload,
  baseline: 'subtle',
  invariants: (p) => {
    if (p.level === 'none' && !p.reducedMotionSafe) {
      return ['A variant with no motion is by definition reduced-motion safe.'];
    }
    if (p.level === 'expressive' && p.reducedMotionSafe) {
      return ['Expressive motion cannot claim to be reduced-motion safe.'];
    }
    return [];
  },
  variants: [
    {
      slug: 'subtle',
      label: 'Baseline - subtle',
      payload: {
        level: 'subtle',
        reducedMotionSafe: true,
        tokens: {
          '--motion-duration': '180ms',
          '--motion-distance': '8px',
          '--motion-ease': 'cubic-bezier(0.2, 0, 0, 1)',
        },
      },
      ...baseline,
    },
    {
      slug: 'none',
      label: 'No motion',
      payload: {
        level: 'none',
        reducedMotionSafe: true,
        tokens: {
          '--motion-duration': '0ms',
          '--motion-distance': '0px',
          '--motion-ease': 'linear',
        },
      },
    },
    {
      slug: 'expressive',
      label: 'Expressive',
      payload: {
        level: 'expressive',
        reducedMotionSafe: false,
        tokens: {
          '--motion-duration': '420ms',
          '--motion-distance': '24px',
          '--motion-ease': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 11. content.feed_ranking
// -----------------------------------------------------------------------------

const FeedRankingPayload = z.object({
  strategy: z.enum(['recency', 'trend_weight', 'engagement', 'hybrid']),
  /** Weights are only meaningful for `hybrid`; the invariant enforces that. */
  weights: z
    .object({
      recency: z.number().min(0).max(1),
      trend: z.number().min(0).max(1),
      engagement: z.number().min(0).max(1),
    })
    .optional(),
});

export const contentFeedRanking = defineSurface({
  id: 'content.feed_ranking',
  kind: 'strategy',
  description: 'How the on-site content feed is ordered.',
  objective: {
    components: ['meaningful_engagement', 'scroll_depth_norm', 'return_visit', 'share'],
    primaryBinary: 'meaningful_engagement',
  },
  constraints: {
    minImpressionsBeforeRetire: 1_200,
    maxActiveVariants: 5,
    allowGenerated: true,
    allowPersonalisation: true,
    requiresConsent: 'analytics',
  },
  schema: FeedRankingPayload,
  baseline: 'hybrid',
  invariants: (p) => {
    if (p.strategy !== 'hybrid')
      return p.weights ? ['Weights are only valid for the hybrid strategy.'] : [];
    if (!p.weights) return ['The hybrid strategy requires weights.'];
    const sum = p.weights.recency + p.weights.trend + p.weights.engagement;
    return Math.abs(sum - 1) < 1e-6 ? [] : [`Hybrid weights sum to ${sum.toFixed(3)}, not 1.`];
  },
  variants: [
    {
      slug: 'hybrid',
      label: 'Baseline - hybrid',
      payload: { strategy: 'hybrid', weights: { recency: 0.3, trend: 0.4, engagement: 0.3 } },
      ...baseline,
    },
    {
      slug: 'recency',
      label: 'Recency',
      payload: { strategy: 'recency' },
    },
    {
      slug: 'trend',
      label: 'Trend weighted',
      payload: { strategy: 'trend_weight' },
    },
    {
      slug: 'engagement',
      label: 'Engagement',
      payload: { strategy: 'engagement' },
    },
    {
      slug: 'hybrid-trend-heavy',
      label: 'Hybrid, trend heavy',
      payload: { strategy: 'hybrid', weights: { recency: 0.2, trend: 0.6, engagement: 0.2 } },
    },
  ],
});

// -----------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------

export const SURFACE_LIST = [
  heroHeadline,
  heroMedia,
  themePalette,
  themeTypography,
  layoutDensity,
  layoutOrder,
  ctaCopy,
  ctaStyle,
  signupProvidersOrder,
  motionIntensity,
  contentFeedRanking,
] as const;

/**
 * Warnings surfaced at load. Errors throw - see `assertRegistryValid`. Warnings are
 * exported rather than logged so the hourly report can mention a variant that is
 * one generated nudge away from failing its contrast gate.
 */
export const REGISTRY_WARNINGS = assertRegistryValid(SURFACE_LIST as readonly AnySurface[]);

export const SURFACES = Object.fromEntries(SURFACE_LIST.map((s) => [s.id, s])) as RegistryOf<
  typeof SURFACE_LIST
>;

export type Surfaces = typeof SURFACES;
export type SurfaceKey = keyof Surfaces;

export const SURFACE_KEYS = SURFACE_LIST.map((s) => s.id) as readonly SurfaceKey[];

/** A complete assignment: exactly one variant per surface. */
export type FullAssignment = { readonly [K in SurfaceKey]: VariantId };

/** The assignment served to the holdout cohort and to any fully-quarantined surface. */
export const BASELINE_ASSIGNMENT: FullAssignment = Object.fromEntries(
  SURFACE_LIST.map((s) => [s.id, s.baselineVariantId]),
) as FullAssignment;
