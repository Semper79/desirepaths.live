# The surface registry

Section 9.3 of the brief: "The `SurfaceRegistry` type definition and three fully-worked
example surfaces."

The type lives in `packages/core/src/surfaces/types.ts` and the eleven surfaces in
`registry.ts`. Both are real, validated at module load, and covered by tests. This page
explains the design and works through three surfaces in detail.

---

## 1. What a surface is

A **surface** is any part of MORPH that is allowed to change itself. A **variant** is one
concrete way that surface can look or behave. The registry is the closed world of things
the optimiser may touch: if it is not declared, the bandit cannot reach it, and a
generated variant that does not fit a declared schema is rejected before it can be
served.

```ts
export interface SurfaceDefinition<TId extends string, TPayload> {
  readonly id: TId;
  readonly kind: SurfaceKind; // copy | media | theme | layout | ordering | strategy
  readonly description: string; // one sentence, shown in /surfaces
  readonly objective: ObjectiveSpec; // which reward components judge it
  readonly a11y: A11yContract; // contrast pairs, reading grade, motion, tap size
  readonly constraints: SurfaceConstraints; // min impressions, caps, consent tier
  readonly schema: z.ZodType<TPayload>; // runtime shape; the static type is inferred
  readonly variants: readonly Variant<TPayload>[];
  readonly baselineVariantId: VariantId; // served to the holdout cohort
  readonly invariants?: (payload: TPayload) => readonly string[];
}
```

Three properties do the heavy lifting.

**Typed end to end.** `SURFACES['theme.palette']` resolves to the palette surface with
its exact payload type, not to `unknown`. A renderer reading `tokens['--color-bg']` fails
to compile if the palette schema changes. Losing that would turn a model-generated
variant from a compile-time concern into a runtime hazard.

**Variants carry tokens, not CSS.** Every visual variant is a bag of CSS custom
properties validated against an allowlist (`tokens.ts`). The visual system can restyle
itself completely while staying inside a coherent token space, and a generated variant
cannot inject a selector, an `@import`, a `url()` that phones home, or a 400px margin
that breaks the layout.

**The accessibility gate is part of the type, not a lint step.** Every surface declares
an `a11y` contract, and `validateSurface` runs it at registration, at generation, and in
CI. There is no code path that admits a variant which failed it.

---

## 2. The eleven surfaces

| Surface                  | Kind     | Variants | Generated? | Personalised? |
| ------------------------ | -------- | -------- | ---------- | ------------- |
| `hero.headline`          | copy     | 8        | yes        | yes           |
| `hero.media`             | media    | 4        | no         | no            |
| `theme.palette`          | theme    | 4        | yes        | no            |
| `theme.typography`       | theme    | 4        | no         | no            |
| `layout.density`         | layout   | 3        | no         | yes           |
| `layout.order`           | layout   | 4        | yes        | no            |
| `cta.copy`               | copy     | 5        | yes        | yes           |
| `cta.style`              | theme    | 4        | no         | yes           |
| `signup.providers_order` | ordering | 5        | yes        | yes           |
| `motion.intensity`       | theme    | 3        | no         | no            |
| `content.feed_ranking`   | strategy | 5        | yes        | yes           |

**Why `cta.copy` and `cta.style` are two surfaces.** The brief writes this as
`copy × (pill / block / underline / floating)`. As one surface that is 32 variants, each
needing its own 800 impressions — 25,600 impressions for a single round of evidence about
a button a young audience decides on in 300 ms. As two surfaces, the marginals are
learned independently and a genuine interaction is still reachable through the contextual
layer, which sees both assignments in the same feature vector.

**Why generation is off for some surfaces.** A text model cannot conjure a font file or
a hero image. `theme.typography` and `hero.media` accept operator-supplied assets only;
the optimiser chooses among them but does not invent them.

---

## 3. Worked example one — `theme.palette`

The surface where the accessibility gate does the most work.

```ts
export const themePalette = defineSurface({
  id: 'theme.palette',
  kind: 'theme',
  description: 'The whole colour system: background, text, accent, borders.',
  objective: {
    components: ['meaningful_engagement', 'scroll_depth_norm', 'signup', 'bounce_penalty'],
    primaryBinary: 'meaningful_engagement',
  },
  a11y: {
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
    allowPersonalisation: false, // see below
    requiresConsent: 'analytics',
  },
  schema: PalettePayload,
  baseline: 'dark-neon',
  variants: [/* dark-neon · light-editorial · high-contrast · warm-brutalist */],
});
```

**The gate in practice.** Six pairs × four variants = 24 contrast checks, run at module
load. A palette that fails one of them throws at boot rather than rendering. The
threshold is the WCAG 2.2 AA ratio — 4.5:1 for body, 3:1 for UI — rounded to two decimals
first, the same convention every accessibility tool uses. A pair that passes with less
than 15% margin produces a _warning_, surfaced in the hourly report, because a variant
sitting 3% above the line will fail the moment a generated palette nudges a token.

The shipped palettes clear it with room:

| Variant         | text/bg | muted/bg | accent/bg | on-accent/accent | border/bg |
| --------------- | ------- | -------- | --------- | ---------------- | --------- |
| dark-neon       | 17.9    | 9.7      | 14.3      | 13.9             | 3.8       |
| light-editorial | 17.3    | 7.5      | 7.5       | 7.8              | 3.3       |
| high-contrast   | 21.0    | 13.6     | 16.5      | 16.5             | 9.7       |
| warm-brutalist  | 14.5    | 8.3      | 6.7       | 7.8              | 4.3       |

**Why `allowPersonalisation: false`.** A visitor who sees a different colour scheme on
every visit concludes the site is broken, not personalised. Palette is sticky per session
and never per request.

**Why palettes are authored in OKLCH where generated.** Holding lightness constant across
hues in OKLCH actually holds _apparent_ lightness constant, so a programmatically
generated palette stays coherent instead of having a muddy yellow next to a screaming
blue at the same nominal lightness. Out-of-gamut colours are resolved by reducing chroma
through a 24-iteration binary search — never by clamping channels, which shifts hue and
produces exactly the artefacts an automated palette generator must not ship.

---

## 4. Worked example two — `signup.providers_order`

The highest-leverage surface in the product, and the one whose constraints differ most
from the defaults.

```ts
constraints: {
  minImpressionsBeforeRetire: 500,   // not the global 1,000
  maxActiveVariants: 6,
  allowGenerated: true,
  allowPersonalisation: true,        // section 4 asks for exactly this
  requiresConsent: 'analytics',
},
invariants: (p) => {
  const problems: string[] = [];
  if (new Set(p.order).size !== p.order.length) problems.push('Provider order contains duplicates.');
  if (!p.order.includes('email') && !p.order.includes('passkey')) {
    problems.push('No passwordless fallback (email or passkey) offered.');
  }
  return problems;
},
```

**Why 500 rather than 1,000 impressions.** Provider ordering accumulates impressions far
more slowly than a headline: only sessions that _reach_ the sign-up surface count, which
on this site is around 40% of sessions. A single global threshold would either retire
headlines too slowly or retire provider orderings on noise. Per-surface thresholds are
the whole reason `SurfaceConstraints` exists.

**Why the passwordless invariant.** Section 4 requires a no-social path. The optimiser,
left alone, would learn that burying it lifts OAuth conversion — and it would be right,
and it would be a dark pattern. The invariant makes that variant impossible to construct
rather than merely discouraged.

**Why this surface is where personalisation earns its keep.** "Which provider converts in
this context" is a real, learnable, context-dependent effect: Discord wins on desktop
from a social referrer, Apple wins on iOS, TikTok wins on mobile from TikTok. The
contextual layer can express that; a global champion cannot.

---

## 5. Worked example three — `layout.order`

The surface that shows what a constraint on the optimiser looks like.

```ts
export const SECTION_STACK = ['hero','live_proof','trending','how_it_works','signup','social_proof'] as const;

invariants: (p) => {
  if (new Set(p.sections).size !== SECTION_STACK.length) {
    return ['Section order must be a permutation: every section exactly once.'];
  }
  return p.sections[0] === 'hero' ? [] : ['The hero must remain the first section (LCP anchor).'];
},
constraints: { maxActiveVariants: 5, /* … */ },
```

**Why only five active variants out of 720 permutations.** Exposing all of 6! would be a
slot machine, not an experiment: at 2,000 impressions per variant that is 1.4 million
impressions for one round of evidence. The generator proposes single adjacent swaps from
the current champion instead, which keeps the candidate set to a handful and makes the
search a hill climb rather than a lottery.

**Why the hero is pinned first.** Not a style preference. The LCP element must be in the
first viewport; moving it below the fold breaks the Core Web Vitals budget the optimiser
is itself judged against. Rather than let the engine discover that expensively through
the rollback guardrail, the move is made unrepresentable.

This is the general pattern in the registry: **where a constraint is known, encode it as
an invariant rather than letting the optimiser learn it from lost traffic.**

---

## 6. Where a generated variant is checked

`adapt.evolve` produces candidates every six hours. Each passes through, in order:

1. **Schema** — zod. Wrong shape, rejected.
2. **Token allowlist** — no `;`, `{`, `}`, `<`, `>`, backslash, comment, at-rule, or any
   CSS function outside the pure allowlist. `url()` is absent by design: a token that can
   fetch is a token that can exfiltrate.
3. **Surface invariants** — the rules above.
4. **Contrast** — every declared pair, at the declared role's threshold.
5. **Reading level** — Flesch-Kincaid against the surface's ceiling.
6. **Reduced motion** — an animating surface must keep a safe active variant.
7. **Safety classifier** — the same one that gates content and social posts.

A candidate failing any check is rejected with the reason logged, and the reason appears
in the hourly report. "Generation failed" is not a reviewable answer; "reading grade 11.4
exceeds the maximum of 9.0" is.

Survivors enter the pool with an **optimistic Beta prior** so they are actually explored;
a flat `Beta(1,1)` would let them starve behind an established champion. Their first 48
hours are down-weighted by the novelty decay, because a new variant gets a burst of
attention purely for being different, and promoting on the strength of that is how an
optimiser ends up chasing its own tail.
