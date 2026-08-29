# Roadmap

> **Current phase: 5 — web intelligence.**
> Phases 0, 2 and 3 are complete and verified; 1 and 6 are complete apart from work that
> needs Docker or a deployed URL. Phase 4 (sign-up) is deferred by the operator, so 5 was
> taken out of order. The crawler package and the worker jobs that drive it are complete;
> what remains is two operator decisions (D7, D16) and traffic.

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

## Phase 5 — Web intelligence 🟡 _built and tested; the gate needs the stack running_

**Done — `packages/crawler`, 243 tests:**

- `robots.ts`: RFC 9309 parsing with longest-match precedence, `Allow` winning ties,
  wildcards and `$`, and metacharacters treated as literals because a `robots.txt` is
  attacker-controlled input. 404 means allowed; 5xx and 401/403 mean the whole host is
  off limits.
- `politeness.ts`: one concurrent request per host enforced by a lease rather than a
  counter, `Crawl-delay` honoured and clamped, a global QPS ceiling, and a per-host
  circuit breaker. Time is a parameter, so "waits 1.1 s then retries" is a test rather
  than a sleep.
- `fetch.ts`: the only outbound request in MORPH. Composes the two above, sends
  `ETag` / `If-Modified-Since`, re-checks robots on every redirect hop, caps body size
  and redirect count, and injects `fetch`, the clock and `sleep` so the whole thing is
  testable without a network.
- `feed.ts`: RSS 2.0, Atom 1.0 and RSS 1.0/RDF normalised into one `FeedItem`.
- `extract.ts`: Readability-style extraction — link density against text length, with
  class/id hints breaking the ties density cannot.
- `simhash.ts`: 64-bit SimHash over word shingles, Hamming distance, batch deduplication.
- `cluster.ts`: incremental nearest-centroid assignment with a running-mean update —
  **not HDBSCAN**, see D14.
- `score.ts`: momentum (velocity × direction), audience fit, saturation, durability,
  weighted into one number that always reports its components and a plain-language reason.
- `safety.ts`: nine categorical rules, `block` beating `review` beating `allow`, each
  firing rule named in the output.

**Done — `apps/worker`, 253 tests:**

Seven scheduled jobs and the bot, each written against `src/ports.ts` and nothing else — no database
client, no queue, no clock. That is what makes "a source is due, robots disallows the
path, so it is recorded as skipped rather than failed" a unit test instead of a
docker-compose and a fixture database.

- `crawl` — sources → fetch → parse → deduplicate → store. Pinned to one worker (D18).
- `embed` — documents → vectors, with the width and finiteness checked before writing,
  because a NaN in pgvector makes every cosine distance involving that row NaN and
  nothing errors.
- `cluster` — documents → topics → scores → safety. A stored verdict never improves on
  its own, and audience fit is a measurement or it is absent (the component is dropped
  and the remaining three renormalise, rather than a fabricated 0 or 1).
- `generate` — a topic → a **draft**, never a publication. Citations are intersected with
  the sources actually offered; anything else is discarded and logged as an invented
  citation.
- `prune` — the 30-day retention window, which until now was a comment in the schema.
- The Telegram bot: long polling, the command dispatcher, and the approval queue that
  moves a draft to `published`. Long polling rather than a webhook because a webhook
  needs the domain in D2; swapping to one changes the client and nothing above it.
- `report` — the hourly report. Gathers from ClickHouse and Postgres, derives every
  number in `lib/report-derive.ts`, composes with the Phase 6 composer, sends, and
  records the run. Idempotent on `report_run.hour_start`, so a retry or a redeploy
  cannot put a second copy in the operator's chat.
- `audience` — the interest vector: per-page engagement from ClickHouse, ranked by the
  same `compositeReward` the bandit optimises, centroid of the above-median half. This is
  the term that makes the trend score about _this site_ rather than about the web.

Adapters: Postgres repositories over Drizzle, an HTTP embedding client (Voyage or
OpenAI-compatible), the Anthropic generator using structured output, a JSON logger, and a
deterministic hashing embedder for development that `refineEnv` refuses to boot in
production.

**Remaining:** the source list (D7) and the embedding provider (D16) are both operator
decisions. The audience vector needs traffic before it can be computed at all — until a
run clears its floors, `cluster` scores on three signals and says so in its log.

**Gate:** a week of crawling with zero robots violations, and the classifier's rejection
list reviewed by hand for false negatives. Both need the stack running, which needs Docker.

---

## Phase 6 — The Telegram bot 🟡 _composer and commands complete; transport pending_

**Done:** the report composer with all nine sections, MarkdownV2 formatting with
section-boundary message packing, quiet-hour discipline, the command grammar and its
authorisation model, and a worked example that is generated from the same code path the
bot uses.

The transport now exists in `apps/worker`: the Bot API client (splitting at 4096
characters, honouring `retry_after`, treating `ok: false` as the failure it is), the
update loop, the command dispatcher, and `/queue` with inline keyboards that publish or
reject a draft.

**Remaining:** the hourly report _job_ — the composer has been ready since Phase 6 and
needs the ClickHouse queries that fill its nine sections. Also the LLM prose pass over the
same structured input, and immediate alert escalation.

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
