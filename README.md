# MORPH

A public website whose **content, layout, visual design and copy continuously reshape
themselves** based on measured visitor behaviour. It monitors the open web for emerging
topics, turns safe ones into on-site content, opens itself to sign-ups from the social
platforms a young audience actually uses, and reports every hour to its operator over
Telegram — what visitors did, what the system changed in response, and what it will try
next.

Designed for **5M+ events/day**, p95 page TTFB **under 150 ms**, adaptive decision latency
**under 5 ms**.

---

## Status

| Phase                   |     |                                                     |
| ----------------------- | --- | --------------------------------------------------- |
| 0 — Foundations         | ✅  | monorepo, infrastructure, CI, the quality gate      |
| 1 — Event ingest        | 🟡  | schema, contract and the collector done; k6 pending |
| 2 — The adaptive engine | ✅  | pure, zero dependencies, 100% branch coverage       |
| 3 — The adaptive site   | 🟡  | site, SEO/AEO and the crawler rule; auth is Phase 4 |
| 4–8                     | 🔜  | see `docs/ROADMAP.md`                               |

**595 tests passing.** Typecheck, lint, guardrail, format and coverage gates green.

---

## Quick start

```bash
pnpm install
pnpm test          # 595 tests — no Docker needed
pnpm sim           # watch the bandit converge on a known-truth world
pnpm report:sample # print a worked example of the hourly Telegram report
```

The three built packages are pure — no database, no network, no clock — so all of the
above runs anywhere Node 22+ runs. For the full stack:

```bash
pnpm bootstrap     # or: make bootstrap
```

> On a machine where `corepack enable` was refused (Windows without admin rights), prefix
> commands with `corepack pnpm` instead of `pnpm`, and use `pnpm typecheck:direct` in
> place of the Turborepo-driven `pnpm typecheck`.

---

## What is actually built

### `packages/adaptive` — the engine

Pure, zero runtime dependencies, no I/O, no clock, no `Math.random()`, **100% branch
coverage**. That is not an aesthetic choice: it is what makes the decision path fast
enough to run in edge middleware, and what makes the statistical claims testable rather
than asserted.

- Thompson sampling over Beta posteriors, with a seeded reproducible generator
- Disjoint LinUCB with Sherman-Morrison updates and exact exponential forgetting
- Always-valid sequential testing (mSPRT) — no peeking bias, verified by a type-I error
  test under continuous peeking
- Composite reward computed from stored components, so a weight change needs no backfill
- Guardrails: minimum sample size, novelty decay, a pinned 5% holdout, an exploration
  floor, and automatic rollback on Core Web Vitals
- A deterministic convergence harness

**The harness changed the design.** Relying on the exploration floor alone, the engine
never recovered when the best variant changed — terminal best-arm share fell to 2% and
stayed there. Exponential forgetting brings it to 93%. Both cases are asserted in
`packages/adaptive/test/sim.test.ts` so the mechanism cannot be quietly removed. See
`docs/BENCHMARKS.md`.

### `packages/core` — the shared vocabulary

The typed `SurfaceRegistry` with eleven surfaces and forty-nine variants; WCAG 2.2
contrast maths over OKLCH with gamut-preserving chroma reduction; the design-token
boundary that stops a model-generated variant injecting CSS; the consent model; the
event contract; the Postgres schema.

### `apps/api` — the collector

The 5,000 req/s path. Its trust boundary is the interesting part: a client may report
what it _observed_ — viewport, scroll depth, session depth — and never what it _is_. The
anonymous identifier, bot score, consent mask, device class, country and referrer class
are all derived server-side from the request, so a hostile payload cannot choose its own
identity. It answers 202 as soon as the batch reaches the broker, 503 with a retry hint
when it cannot, and 429 from an in-process token bucket keyed on the derived identifier.

### `apps/web` and `@morph/seo` — the adaptive site, and staying findable

The HTML that leaves the origin is already adapted: the chosen variants' design tokens
are written into a single declaration block in `<head>`, so the first paint is correct
and the adaptive layer contributes no layout shift. A site that adapted by re-rendering
on the client would fail the very CLS budget the optimiser is judged against.

Making that indexable needs one rule, and it is the most important decision in Phase 3:
**every automated request receives the baseline** — byte for byte what the 5% holdout
cohort sees. Otherwise the indexed version of a page is whichever variant the bandit drew
for the crawler that day, and the site is serving search engines systematically different
content from humans. Crawler traffic is also excluded from the posteriors, because a
crawler never converts and counting it would teach the optimiser that every variant is bad.

On top of that: JSON-LD with machine generation stated rather than hidden and sources
carried in `isBasedOn`, RSS and Atom, a sitemap whose `lastmod` comes from the content
row and never from the clock, and `/llms.txt` — with a notes section that states the
things a model would otherwise keep guessing wrong. AI crawlers are welcomed explicitly.

### `packages/telegram` — the operator's window

The hourly report composer, MarkdownV2 formatting that splits at section boundaries
rather than orphaning headings, quiet-hour discipline, and the command grammar with its
authorisation model. `docs/HOURLY-REPORT.md` is generated from the same code path the bot
uses.

---

## The guardrails

MORPH does not build, and will not build:

1. Automated creation of social media accounts
2. Anything whose purpose is evading platform detection, rate limits or enforcement
3. Follow/unfollow churn, mass DMs, engagement pods, comment spraying
4. Scraping in violation of `robots.txt`, Terms of Service, or behind an auth wall
5. Storage of social platform passwords

These are enforced mechanically. `scripts/check-guardrails.mjs` runs in CI and fails the
build on any of them; removing the check means deleting a file, which is visible in
review. `docs/COMPLIANCE.md` records what is done instead.

Privacy is designed in, not bolted on: first-party cookieless measurement through a
daily-rotating salted hash, a consent gate that is a real gate, 90-day raw retention
enforced by the storage engine, and full data-subject rights. The consent banner is
deliberately **not** an adaptive surface — an optimiser pointed at a consent rate
produces a dark pattern by construction. `docs/PRIVACY.md`.

---

## Documentation

|                                                  |                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)   | How a request flows, why each datastore, the latency budget, and what this design is bad at |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md)       | Both schemas, with the partitioning and TTL reasoning                                       |
| [`docs/SURFACES.md`](docs/SURFACES.md)           | The registry type and three fully-worked surfaces                                           |
| [`docs/HOURLY-REPORT.md`](docs/HOURLY-REPORT.md) | A real hourly report, generated                                                             |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)         | Every open decision, with a recommendation                                                  |
| [`docs/PRIVACY.md`](docs/PRIVACY.md)             | The privacy design and where each claim is enforced                                         |
| [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md)       | Rate limits, robots policy, the approval queue                                              |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)             | Phases, gates, and what is deliberately excluded                                            |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md)             | For 03:00                                                                                   |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)       | What is measured, and what is not yet                                                       |
| [`infra/SCALING.md`](infra/SCALING.md)           | Which service scales how, and what breaks first                                             |
| [`docs/FILE-TREE.md`](docs/FILE-TREE.md)         | What exists, and what each phase adds                                                       |
| [`CLAUDE.md`](CLAUDE.md)                         | The working agreement                                                                       |

---

## The gate

Nothing is done until this passes:

```bash
pnpm verify   # typecheck → lint → guardrails → coverage → build
```

Coverage thresholds are enforced per path in `vitest.config.ts`: **100% branches** in
`packages/adaptive`, 80% elsewhere. They are not advisory.

---

## Stack

Next.js 15 (App Router, RSC, partial prerendering) · Fastify · BullMQ · PostgreSQL 16 with
Drizzle and pgvector · ClickHouse · Redis 7 · Redpanda · Caddy · OpenTelemetry ·
Prometheus · Grafana · TypeScript strict throughout.
