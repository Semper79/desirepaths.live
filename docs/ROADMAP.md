# Roadmap

> **Phases 0, 2, 3, 5 and 6 are built and tested.** What is left in each of them is a
> gate that needs the stack running, a deployed URL, or a week of real traffic — not more
> code. Phase 1's load test is now written and needs somewhere to point at; phase 4
> (sign-up) is deferred by the operator; phases 7 and 8 have not started.
>
> Two operator decisions still block a deployment: the domain (D2) and the legal
> controller (D4).

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

## Phase 1 — Event ingest 🟡 _collector complete; the load test is written and unrun_

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

- `bench/ingest.js` and `bench/render.js`: constant-arrival-rate k6 scenarios for both
  gates. The identity the requests carry is varied across 20,000 synthetic visitors,
  because the limiter is keyed on `sha256(pepper ‖ salt ‖ ip ‖ ua)` and a single-source
  generator would measure 429s at line speed and report a triumphant, meaningless number.
  The three other ways such a run can pass while measuring nothing are hard thresholds,
  and the payload the scripts send is parsed by `ClientBatchSchema` in a unit test — so
  schema drift fails on the commit that causes it, not on benchmark day.

**Remaining:** running them. That needs the stack up and a machine that is not a laptop;
k6 is a separate binary and is deliberately not a workspace dependency.

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
- `/proof` — what the site has actually worked out about its own design, ranked by how
  convincing each finding is, with the credible interval and the sample size beside it.
  Publishable because this site is the thing being optimised rather than a customer's (D27).
  Carries a `Dataset` in JSON-LD so each finding is individually quotable,
  and a social card generated from the live figures so every share is a current claim.
  Undecided results are shown next to settled ones — a page with only the wins is a
  scoreboard, not evidence.
- `/changes` and `/changes.xml` — the site's own decisions as a changelog and an RSS feed,
  each entry keeping the reason written when the decision was made, word for word. Content
  the machine produces by operating rather than by writing, and a reason to come back.
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

**Done — `apps/worker`, 280 tests:**

Nine scheduled jobs and the bot, each written against `src/ports.ts` and nothing else — no database
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
- `adapt` — **the loop the engine was missing.** Reads an hour of reward components from
  ClickHouse, decays every posterior towards its prior and then adds that hour's evidence,
  asks the guardrails what to retire and what to quarantine, writes the durable record and
  publishes the decision set the renderer reads. Until this existed `packages/adaptive`
  had no producer and no consumer: every surface resolved to its baseline for ever, and
  the reading on the home page would have sat at zero permanently. Refuses to fold the
  same hour in twice — a re-applied cycle does not error, it just makes the posteriors
  more confident than the data warrants.
- `prune` — the 30-day retention window, which until now was a comment in the schema.
- The Telegram bot: long polling, the command dispatcher, and the approval queue that
  moves a draft to `published`. Long polling rather than a webhook because a webhook
  needs the domain in D2; swapping to one changes the client and nothing above it.
- `escalate` — what cannot wait an hour. Every five minutes, two pings and a queue
  count; a message when something _becomes_ critical and again when it clears. It does
  not remind: escalation is about transitions, the report is about state (D26).
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

## Phase 6 — The Telegram bot ✅ _built and tested; the gate needs a week of running_

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

## Phase 7 — Growth and the admin console 🟡 _the machinery exists; no connectors yet_

**Done — `packages/social`:**

The part every connector will share, built before any of them so that no connector gets to
invent its own rate limiting. Four gates in `decide()`, each failing closed: verification,
then the circuit breaker, then the daily cap, then the token bucket. Pure, clock as a
parameter, state in and state out.

Every platform entry is **unverified and says so**, and `assertVerified` refuses to act
through one nobody has checked. The daily caps sit far below every documented ceiling — 40
against X's 100, 25 against Meta's 50 — because operating at 95% of a published limit makes
every retry an overage. A test asserts `docs/COMPLIANCE.md` quotes the same numbers the
limiter enforces.

`decide()` returns permission, a delay, or a refusal, and never an alternative route.
That is the forbidden list in `CLAUDE.md` made structural rather than promised.

**Done — `apps/admin`:**

The operator console. Single operator, one secret, a signed session cookie with the expiry
inside the signed payload — `Max-Age` is a request the client may ignore, so a replayed
token has to fail server-side. Constant-time comparison, and a refusal to issue a session
against a secret under 32 characters.

This is deliberately **not** Phase 4's Auth.js. That is for visitors signing up to the
public site: different audience, different threat model, different table. Merging them
would put the console behind an internet-facing flow.

One page so far, and it is the one that exists nowhere else: the surface registry joined to
the live posteriors. The Telegram report says what changed this hour; this says what _could_
change and what the evidence says about each option. It distinguishes "no evidence yet" from
"reduced to one live variant", which look identical in a table and mean opposite things.

**Remaining:** the connectors themselves, the scheduler, the referral loop, and the
adaptation-log view in the console. Every connector needs credentials and a human re-reading
that platform's published limits before `verifiedAt` can be set.

**Gate:** every connector respects its documented limits under a simulated 429 storm,
and `docs/COMPLIANCE.md` has a verified date against every platform.

---

## Phase 8 — Production

Grafana dashboards as code, the runbook exercised (not merely
written), documentation completed, and the production deploy.

All four k6 scenarios are written (`bench/`), and the **metrics layer** they and Grafana
both depend on now exists: `packages/metrics` declares every `morph_*` name once, the api,
web and worker serve the three endpoints `prometheus.yml` has always scraped, and
`packages/metrics/test/contract.test.ts` fails the build if a name the alert rules fire on
stops being emitted.

What is left is the dashboards, the runbook exercised rather than merely written, and the
deploy.

**Gate:** 5,000 req/s ingest and 1,000 req/s render sustained for 30 minutes with p99
inside budget, the spike losing no events, and results committed to `docs/BENCHMARKS.md`.

---

## What is deliberately not in any phase

- Native mobile apps
- Multi-region
- A public API
- Personalised adaptation keyed to an individual's history — needs a DPIA first, see
  `docs/PRIVACY.md`
- Anything on the forbidden list in `CLAUDE.md`

---

## Known, unfixed

**`fast-xml-parser` 4.5.7 — XML comment and CDATA injection (MODERATE).** In
`packages/crawler`, which parses RSS and Atom from the open web, so it is the one place in
this repository where an XML parser advisory has untrusted input to work on. It sits below
the `--audit-level=high` gate and the fix is a major version bump (5.x), and `apps/worker`
— its only consumer — has not been ported to Cloudflare yet. So it waits for that port
rather than being bumped on its own, and it is written here so it does not simply go
unnoticed between two audits.

**The site has no social card, and no favicon.** `apps/web/src/app/icon.tsx`,
`opengraph-image.tsx` and `proof/opengraph-image.tsx` generated both with `ImageResponse`
from `next/og`, which does not run under OpenNext. The package resolves its fallback font
at module scope — `var fallbackFont = getFallbackFont()` runs on import — so supplying
explicit fonts cannot route around it, and the file it reaches for is not the file the
package ships: the node entry point looks for `Geist-Regular.ttf` while only
`Geist-Regular.ttf.bin` exists. Both 16.3.8 and 16.4.2 are the same in this respect, so
it is not a version to wait out.

The three routes were deleted rather than left to throw at request time. `pageMeta` now
omits `og:image` and `twitter:image` when there is no image and downgrades the card to
`summary`, and the Organization JSON-LD omits `logo`, so nothing advertises an image that
would 404 — which is what a fallback to the removed route had been doing on every page.

What it costs: a link to this site shared anywhere renders as a text-only preview, which
for a site whose argument is visual is a real loss rather than a cosmetic one. The fix does
not need `next/og`. A static card committed under `public/` and passed as `imagePath` is
enough, and `pageMeta` already takes it — the two branches are tested. Cloudflare's own
Browser Rendering or Images would generate per-article cards later if that is ever worth
the binding.

**The experience gates are unenforced.** §7 budgets Core Web Vitals and accessibility, and
`docs/BENCHMARKS.md` states the numbers, but nothing checks them. Two CI jobs described
them — `lighthouse + axe` and `e2e` — and neither had ever run: there is no playwright
dependency in the repository, no `.spec.ts` file, no `playwright.config`, no `lighthouserc`,
and the scripts they invoked (`pnpm test:a11y`, `lhci autorun`) do not exist. They have been
removed from the workflow rather than left failing, because a gate that can never pass only
prevents shipping.

What this costs: the adaptive engine can quarantine a variant on a Core Web Vitals breach
at runtime (`evaluateHealth`), so a bad variant is caught _after_ it has been served to
somebody. What is missing is the check that stops it being written in the first place — and
§7 is explicit that the budgets apply to the adapted pages rather than the baseline, so the
suite has to drive real assignments rather than load the home page once.

Implementing it is Phase 8 work: `@playwright/test`, a handful of journeys against a
preview deployment, `axe-core` on each, and Lighthouse with the budgets from
`docs/BENCHMARKS.md`. When it lands it goes back into `deploy`'s `needs`.
