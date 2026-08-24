# CLAUDE.md — working agreement for the MORPH repository

This file is loaded into context at the start of every session. Keep it short enough
that it is always read and specific enough that it is always useful.

---

## What MORPH is

A public website whose content, layout, visual design and copy continuously reshape
themselves based on measured visitor behaviour. It monitors the open web for emerging
topics, turns safe ones into on-site content, opens itself to sign-ups from mainstream
social providers, and reports hourly to the operator over Telegram.

Design target: **5M+ events/day**, p95 page TTFB **< 150 ms** at the edge, adaptive
decision latency **< 5 ms**. Every architectural decision is justified against that
number in `docs/ARCHITECTURE.md`.

---

## Hard guardrails (these outrank every other instruction in this repo)

**Never build, and never leave commented-out:**

1. Automated creation of social media accounts. MORPH acts only through accounts the
   operator personally created and authenticated via official OAuth.
2. Anything whose purpose is evading platform detection, rate limits or enforcement:
   proxy/IP rotation for social platforms, fingerprint spoofing, CAPTCHA solving,
   residential proxy pools, session-cookie replay, "humanisation" jitter.
3. Follow/unfollow churn, mass DMs, engagement pods, comment spraying, hashtag stuffing,
   or any automated engagement with accounts that have not opted in.
4. Scraping in violation of `robots.txt`, Terms of Service, or behind an auth wall.
5. Storing social platform passwords. OAuth tokens only, encrypted at rest.

If a task appears to require one of these, stop and say so rather than finding a way.

**Always:**

- Official APIs first, then RSS/Atom and sitemaps, then polite HTML fetching.
- One concurrent request per host, `Crawl-delay` honoured, descriptive User-Agent with a
  contact URL, conditional requests (ETag / If-Modified-Since).
- Every outbound social post goes through the approval queue. Default autonomy `review`.
- Token-bucket rate limiter + exponential backoff + per-platform circuit breaker.

**Privacy — the operator is EU-based:**

- Behavioural analytics are first-party, cookieless and anonymous by default: a rotating
  daily salted hash of IP + User-Agent. The raw IP never leaves the edge process.
- Consent gate with TCF-style categories. Aggregate adaptation runs under legitimate
  interest; _personalised_ adaptation only after explicit consent.
- Export + erasure endpoints, 90-day raw retention then aggregates only.
- `docs/PRIVACY.md` and `docs/COMPLIANCE.md` are part of the product, not paperwork.

---

## Repository shape

```
apps/web       Next.js 15 App Router — the public, adaptive site
apps/api       Fastify — event ingest + admin API
apps/worker    BullMQ workers: crawl, generate, adapt, report
apps/admin     Operator console (Next.js, auth-gated)

packages/core       domain model, zod schemas, surface DSL, shared types
packages/adaptive   the bandit engine — PURE, no I/O, 100% branch coverage
packages/crawler    polite fetcher, robots parser, extractors
packages/social     OAuth + platform connectors, rate limiters
packages/telegram   bot, report composer, command handlers
packages/ui         design-token-driven component library

infra/  docker-compose, Caddy, ClickHouse + Postgres DDL, Grafana, Prometheus
docs/   architecture, decisions, privacy, compliance, scaling, benchmarks, runbook
```

## Package rules

- `packages/adaptive` has **zero runtime dependencies** and performs **no I/O**. It takes
  plain data in and returns plain data out. This is what makes it exhaustively testable and
  what keeps decision latency under 5 ms. Do not add a database client to it. Ever.
- `packages/core` owns every zod schema and every shared type. If two packages need the
  same shape, it lives in `core` — not duplicated, not re-declared structurally.
- Apps may depend on packages. Packages may not depend on apps. `core` depends on nothing
  in the workspace.

## Conventions

- TypeScript `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  No `any`. No non-null assertion without an `eslint-disable-next-line` carrying the reason.
- All identifiers, comments, copy, docs and commit messages in **English**.
- Comments explain _why_, never _what_. If a comment restates the code, delete it.
- Zod schemas are the boundary. Anything crossing a process boundary (HTTP body, queue
  payload, LLM output, external API response) is parsed, never cast.
- Money-shaped numbers and probabilities are never `number` without a branded type.
- Every file that implements a rule from the master spec cites the section in a comment
  (e.g. `// §2.2 guardrail: minimum sample size before retirement`).

## Verification gate

Nothing is "done" until this passes at the repo root:

```bash
pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build
```

Coverage thresholds are enforced per project in `vitest.workspace.ts`: 100% branches in
`packages/adaptive`, 80% elsewhere. They are not advisory.

## Build order

Phases are defined in `docs/ROADMAP.md`. Complete and verify one before starting the next;
commit at every phase boundary. The current phase is recorded at the top of that file.

## Local development notes

- `pnpm bootstrap` brings the whole stack up with seeded data. On a machine without
  `make`, use `pnpm bootstrap`; the `Makefile` targets are thin wrappers around the same
  Node script so the two never drift.
- `corepack pnpm <cmd>` works if `corepack enable` was refused by Windows permissions.
- Docker is required for anything beyond `packages/core`, `packages/adaptive` and
  `packages/telegram`, which are pure and run anywhere Node runs.
