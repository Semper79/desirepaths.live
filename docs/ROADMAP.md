# Roadmap

> **Current phase: 3 — the public site.**
> Phases 0, 1 (schema and contract), and 2 are complete and verified. Phase 3 is blocked
> on decisions D1–D4 in `docs/DECISIONS.md`.

Each phase ends with the gate green:

```bash
pnpm verify   # typecheck → lint → guardrails → coverage → build
```

Nothing moves to the next phase with the gate red, and every phase boundary is a commit.

---

## Phase 0 — Foundations ✅

Monorepo, toolchain, infrastructure topology, the working agreement.

- pnpm workspaces + Turborepo; TypeScript `strict` plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`
- Flat ESLint config enforcing no `any` and no unjustified non-null assertions
- Vitest with path-scoped coverage thresholds (100% branches in `packages/adaptive`,
  80% elsewhere)
- `infra/docker-compose.yml`: Postgres 16, ClickHouse, Redis 7, Redpanda, Caddy, OTel
  collector, Prometheus, Grafana — every service labelled with its scaling class
- `.env.example` with every variable documented and its failure mode named
- `CLAUDE.md`, `Makefile`, `scripts/bootstrap.mjs`, `scripts/check-guardrails.mjs`
- CI: typecheck, lint, format, test+coverage, convergence harness, build, integration,
  Lighthouse, axe, e2e, dependency audit, secret scan, guardrail check

**Deliverable met:** `pnpm bootstrap` brings the stack up on a machine with Docker.

---

## Phase 1 — Event ingest 🟡 _collector complete; load test pending_

**Done:**

- ClickHouse schema with partitioning, TTL and codec reasoning inline
  (`infra/clickhouse/init/`): raw `events`, the Kafka ingest path, the dead-letter
  table, `sessions`, `surface_rewards_hourly`, `traffic_hourly`, `vitals_hourly`,
  `funnel_hourly`, and the hour-of-week anomaly profile
- The event contract (`packages/core/src/events.ts`) — the same field names the
  materialised view reads, so the three cannot drift silently
- The anonymous identity scheme and the consent model, with tests
- Postgres bootstrap: extensions, least-privilege roles, monthly partition maintenance

- `apps/api`: the Fastify collector, its enrichment trust boundary, an in-process
  token-bucket limiter keyed on the derived identifier, heuristic bot scoring, the
  Redpanda sink behind an interface, and split liveness/readiness probes

**Remaining:** the k6 load test, and `docs/BENCHMARKS.md` filled with real numbers.

**Gate:** k6 sustains 5,000 req/s on `POST /i` with p99 under 25 ms.

---

## Phase 2 — The adaptive engine ✅

`packages/adaptive`: pure, zero runtime dependencies, **100% branch coverage**.

- Beta posterior arithmetic: closed-form CDF, quantiles, credible intervals, and
  `P(X > Y)` by restricted-range quadrature
- Thompson sampling with a seeded, reproducible sfc32 generator
- Disjoint LinUCB with Sherman-Morrison updates and exact exponential forgetting
- Always-valid sequential testing (mSPRT), with a type-I error test under continuous
  peeking
- Composite reward from stored components, novelty decay, holdout selection,
  exploration floor, automatic rollback on Core Web Vitals
- The decision function, with its order of precedence
- A deterministic convergence harness

**Gate met:** the harness converges on a known-truth world (97.5% terminal best share,
+149% lift over the non-adapting cohort) **and** recovers from a mid-run change in the
world (93.4%, versus 2.1% without forgetting).

That second number is why the phase took longer than planned — see D9 in
`docs/DECISIONS.md`.

---

## Phase 3 — The adaptive site ✅

**Done:**

- `apps/web`: Next.js 15 App Router, edge middleware deriving the visitor context, the
  assignment resolved server-side before render, and the token bag written into
  `<head>` so the first paint is already correct
- The crawler rule: every automated request gets the baseline, and is excluded from the
  posteriors
- `@morph/ui`: the token contract, its required set, and a fallback bag verified to
  pass WCAG AA on every pair the palette surface declares
- `@morph/seo`: JSON-LD (Organization, WebSite, Article, FAQPage) with generation
  provenance and `isBasedOn` attribution, RSS, Atom, sitemap, robots.txt welcoming AI
  crawlers, and `/llms.txt`
- Split `/api/health` and `/api/ready`

Verified by `next build` and by running the production server: the tokens are in the
initial HTML, the structured data parses, and a Googlebot user agent receives the
baseline while a browser does not.

- The consent gate: a form POST, no client JavaScript, so a refusal is recordable with
  scripts blocked. Refusing is the same element at the same weight as accepting, and the
  banner is two sentences rather than a viewport-filling modal.
- The client beacon: batched, persisted, `sendBeacon` on `pagehide`, chunked under the
  64 KB limit, and inert without consent or for a request the server marked unmeasurable.
- `/privacy`, `/how-it-works`, `/live` and `/t/[slug]`, so the sitemap stops advertising
  pages that do not exist. `/live` reports the variant of every surface this visitor was
  served and why, read from the same decision object the renderer used.
- Icon and social card generated from the design tokens, so the mark cannot drift from
  the palette and structured data never points at a 404.

**Gate:** LCP under 2.0 s on a mid-range phone and axe clean on every variant still need
the Lighthouse and axe CI jobs, which need a deployed URL (D2, D3). Everything else in
this phase is verified by `next build` and against a running server.

---

## Phase 4 — Sign-up

Auth.js v5 with the five launch providers (D5), passkeys, magic link, account linking
with merge-on-verified-email and an explicit confirmation step, Turnstile on the email
path, velocity limits, disposable-domain blocklist, shadow-ban queue, and the activation
loop.

The provider ordering is an adaptive surface and is already declared in the registry —
this phase makes it real.

**Gate:** Playwright covers every provider (mocked), consent-gate behaviour, variant
stickiness across reloads, and reduced-motion / keyboard-only / screen-reader paths.

---

## Phase 5 — Web intelligence

`packages/crawler` and the trend pipeline: polite fetcher, robots parser with cache,
Readability extraction, SimHash dedup, pgvector embeddings, HDBSCAN clustering,
momentum / audience-fit / saturation / durability scoring, the safety classifier, content
generation with mandatory attribution, and the approval queue.

**Gate:** a week of crawling with zero robots violations, and the classifier's rejection
list reviewed by hand for false negatives.

---

## Phase 6 — The Telegram bot 🟡 _composer and commands complete; transport pending_

**Done:** the report composer with all nine sections, MarkdownV2 formatting with
section-boundary message packing, quiet-hour discipline, the command grammar and its
authorisation model, and a worked example that is generated from the same code path the
bot uses.

**Remaining:** the bot transport in `apps/worker`, inline keyboards for `/queue`, the
LLM prose pass over the same structured input, and immediate alert escalation.

**Gate:** a report every hour for a week with no missed hours and no 400s from Telegram.

---

## Phase 7 — Growth and the admin console

`packages/social`: connectors, token-bucket limiters, circuit breakers, the scheduler
with per-platform timing optimisation, format optimisation through the same bandit
machinery, the referral loop, and SEO/AEO — JSON-LD, dynamic OG images, sitemap, RSS.

Then `apps/admin`.

**Gate:** every connector respects its documented limits under a simulated 429 storm,
and `docs/COMPLIANCE.md` has a verified date against every platform.

---

## Phase 8 — Production

Load testing with k6, Grafana dashboards as code, the runbook exercised (not merely
written), documentation completed, and the production deploy.

**Gate:** 5,000 req/s ingest and 1,000 req/s render sustained for 30 minutes with p99
inside budget, results committed to `docs/BENCHMARKS.md`.

---

## What is deliberately not in any phase

- Native mobile apps
- Multi-region
- A public API
- Personalised adaptation keyed to an individual's history — needs a DPIA first, see
  `docs/PRIVACY.md`
- Anything on the forbidden list in `CLAUDE.md`
