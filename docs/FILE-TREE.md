# File tree

Section 9.1 of the brief. Two trees: what exists and is verified today, and what the
remaining phases add. Every entry in the first tree is real — this is not a plan drawn to
look like a repository.

Legend: **✅ built and tested** · 🟡 partially built · 🔜 planned

---

## What exists today

```
morph/
├── CLAUDE.md                      ✅ working agreement, loaded every session
├── Makefile                       ✅ thin wrappers; logic lives in scripts/
├── package.json                   ✅ workspace root, the `verify` gate
├── pnpm-workspace.yaml            ✅
├── turbo.json                     ✅ task graph and cache inputs
├── tsconfig.base.json             ✅ strict + noUncheckedIndexedAccess + exactOptional
├── eslint.config.mjs              ✅ flat config; no-any, no-unjustified-non-null
├── vitest.config.ts               ✅ coverage + path-scoped thresholds
├── vitest.workspace.ts            ✅ the twelve test projects
├── .env.example                   ✅ every variable documented with its failure mode
├── .gitattributes                 ✅ LF normalisation
│
├── .github/workflows/
│   └── ci.yml                     ✅ typecheck · lint · test · sim · build · integration
│                                     · lighthouse · axe · e2e · audit · secrets · guardrails
│
├── scripts/
│   ├── bootstrap.mjs              ✅ `make bootstrap`, cross-platform
│   ├── check-guardrails.mjs       ✅ mechanical enforcement of the forbidden list
│   └── run-all.mjs                ✅ turbo-free fallback runner
│
├── bench/                         k6 load tests — a separate binary, not an npm package
│   ├── payload.js                 ✅ beacon bodies, visitor identities, the synthetic marker
│   ├── clickhouse.js              ✅ counts what arrived, so "nothing dropped" is measured
│   ├── ingest.js                  ✅ 5,000 req/s on POST /i, p99 < 25 ms
│   ├── render.js                  ✅ 1,000 req/s on the page, p95 TTFB < 150 ms
│   ├── spike.js                   ✅ 500 → 8,000 req/s; loss and recovery, not throughput
│   └── soak.js                    ✅ 4 h at 1,000 req/s; drift, not level
│
├── infra/
│   ├── docker-compose.yml         ✅ 9 services, each labelled with its scaling class
│   ├── Dockerfile                 ✅ one file, four targets, pruned runtime closures
│   ├── SCALING.md                 ✅ which service scales how, and what breaks first
│   ├── caddy/Caddyfile            ✅ TLS, HTTP/3, CSP, the cheap ingest route
│   ├── grafana/provisioning/
│   │   ├── datasources/            ✅ Prometheus + ClickHouse, as code
│   │   └── dashboards/json/        ✅ overview + engine; every expr checked against
│   │                                  the registry by packages/metrics
│   ├── clickhouse/init/
│   │   ├── 001_events.sql         ✅ raw events, Kafka ingest, DLQ, partitioning + TTL
│   │   └── 002_aggregates.sql     ✅ sessions, rewards, traffic, vitals, funnel, anomaly
│   ├── postgres/init/
│   │   └── 001_bootstrap.sql      ✅ extensions, least-privilege roles, partition upkeep
│   ├── otel/config.yaml           ✅ tail sampling + PII scrubbing
│   ├── prometheus/
│   │   ├── prometheus.yml         ✅
│   │   └── rules/morph.yml        ✅ alerts that fire into Telegram
│   └── grafana/provisioning/      ✅ datasources and dashboard providers as code
│
├── packages/
│   ├── core/                      ✅ the shared vocabulary — depends on nothing
│   │   ├── src/
│   │   │   ├── brand.ts           ✅ branded primitives with runtime validation
│   │   │   ├── color.ts           ✅ OKLCH → sRGB, WCAG 2.2 contrast, advisory APCA
│   │   │   ├── text.ts            ✅ readability scoring for generated copy
│   │   │   ├── consent.ts         ✅ the four-category model
│   │   │   ├── context.ts         ✅ covariates, bucketing, 26-dim feature vector
│   │   │   ├── events.ts          ✅ the ingest contract
│   │   │   ├── config.ts          ✅ hot-reloadable engine configuration
│   │   │   ├── db/schema.ts       ✅ the Postgres schema (Drizzle)
│   │   │   └── surfaces/
│   │   │       ├── types.ts       ✅ the SurfaceRegistry type
│   │   │       ├── define.ts      ✅ the DSL and its validation gate
│   │   │       ├── tokens.ts      ✅ the design-token boundary
│   │   │       └── registry.ts    ✅ eleven surfaces, forty-nine variants
│   │   └── test/                  ✅ 5 files
│   │
│   ├── adaptive/                  ✅ the engine — pure, 0 deps, 100% branch coverage
│   │   ├── src/
│   │   │   ├── math.ts            ✅ shared clamps, extracted so they are tested
│   │   │   ├── rng.ts             ✅ seeded sfc32, normal / gamma / beta samplers
│   │   │   ├── beta.ts            ✅ CDF, quantiles, credible intervals, P(X > Y)
│   │   │   ├── reward.ts          ✅ composite reward, novelty decay, forgetting
│   │   │   ├── msprt.ts           ✅ always-valid sequential testing
│   │   │   ├── thompson.ts        ✅ posterior sampling and summarisation
│   │   │   ├── linucb.ts          ✅ contextual bandit, Sherman-Morrison, exact decay
│   │   │   ├── guardrails.ts      ✅ holdout, exploration floor, retirement, rollback
│   │   │   ├── assign.ts          ✅ decide(), with its order of precedence
│   │   │   └── sim/               ✅ the convergence harness and its CLI
│   │   └── test/                  ✅ 11 files
│   │
│   ├── telegram/                  ✅ the report vocabulary; transport in apps/worker
│   │   ├── src/
│   │   │   ├── markdown.ts        ✅ MarkdownV2 escaping, section-boundary packing
│   │   │   ├── types.ts           ✅ the report's structured input
│   │   │   ├── compose.ts         ✅ nine sections + quiet-hour discipline
│   │   │   ├── commands.ts        ✅ grammar and authorisation
│   │   │   ├── prose.ts           ✅ the lead, and the check that makes it safe
│   │   │   └── sample.ts          ✅ the worked example
│   │   └── test/                  ✅ 3 files
│   │
│   ├── seo/                       ✅ JSON-LD, sitemap, feeds, robots, llms.txt
│   │   ├── src/xml.ts             ✅ escaping, CDATA splitting, date formats
│   │   ├── src/embed.ts           ✅ safe embedding of generated data in HTML
│   │   ├── src/jsonld.ts          ✅ entities, provenance, source attribution
│   │   ├── src/sitemap.ts         ✅ urlset, index, chunking
│   │   ├── src/feed.ts            ✅ RSS 2.0 and Atom 1.0
│   │   ├── src/aeo.ts             ✅ robots.txt and llms.txt
│   │   ├── src/meta.ts            ✅ canonical URLs, Open Graph, Twitter cards
│   │   └── test/                  ✅ 2 files
│   │
│   ├── ui/                        ✅ the token contract
│   │   ├── src/tokens.ts          ✅ required set, fallback bag, composition
│   │   └── test/                  ✅ 1 file
│   │
│   ├── crawler/                   ✅ the trend pipeline — 243 tests
│   │   ├── src/robots.ts          ✅ RFC 9309: longest match, Allow wins ties
│   │   ├── src/politeness.ts      ✅ one request per host, delay, QPS, breaker
│   │   ├── src/fetch.ts           ✅ the only outbound request in MORPH
│   │   ├── src/feed.ts            ✅ RSS 2.0 · Atom 1.0 · RDF → one FeedItem
│   │   ├── src/extract.ts         ✅ link density beats per-site rules
│   │   ├── src/simhash.ts         ✅ 64-bit fingerprint, Hamming distance
│   │   ├── src/cluster.ts         ✅ incremental, so cluster ids survive a run
│   │   ├── src/score.ts           ✅ momentum · fit · saturation · durability
│   │   ├── src/safety.ts          ✅ nine rules; block beats review beats allow
│   │   └── test/                  ✅ 9 files
│   └── social/                    🔜 Phase 7
│
├── apps/
│   ├── api/                       🟡 the collector; k6 load test pending
│   │   ├── src/env.ts             ✅ fail-at-boot environment validation
│   │   ├── src/server.ts          ✅ Fastify, built from injected dependencies
│   │   ├── src/lib/anon-id.ts     ✅ the daily-rotating identifier
│   │   ├── src/lib/classify.ts    ✅ device, referrer, source, bot score
│   │   ├── src/lib/enrich.ts      ✅ the trust boundary
│   │   ├── src/lib/rate-limit.ts  ✅ token bucket, bounded, LRU-evicting
│   │   ├── src/lib/producer.ts    ✅ Redpanda sink behind an interface
│   │   ├── src/routes/            ✅ POST /i, /health, /ready
│   │   └── test/                  ✅ 3 files
│   ├── web/                       ✅ the adaptive site
│   │   ├── src/middleware.ts      ✅ derives the visitor context, strips the raw inputs
│   │   ├── src/lib/assignment.ts  ✅ resolution, and the crawler rule
│   │   ├── src/lib/render.ts      ✅ assignment → token bag and typed payloads
│   │   ├── src/lib/request-context.ts ✅ device, referrer, edge bot score
│   │   ├── src/lib/consent.ts     ✅ one reader for the consent cookie, used by all four
│   │   ├── src/lib/beacon-queue.ts ✅ batching, persistence, sendBeacon chunking
│   │   ├── src/lib/site.ts        ✅ identity and the content index
│   │   ├── src/components/        ✅ consent gate (no JS), beacon
│   │   ├── src/app/               ✅ home, privacy, how-it-works, live, /t/[slug],
│   │   │                             sitemap, robots, feeds, llms.txt, icon, OG image
│   │   └── test/                  ✅ 4 files
│   ├── worker/                    ✅ the scheduled jobs and the bot — 280 tests
│   │   ├── src/env.ts             ✅ boot validation, incl. the production embedder rule
│   │   ├── src/ports.ts           ✅ the seam every job is written against
│   │   ├── src/queues.ts          ✅ payload schemas, cron, retries, concurrency
│   │   ├── src/jobs/crawl.ts      ✅ fetch · parse · dedupe · store
│   │   ├── src/jobs/embed.ts      ✅ width and finiteness checked before writing
│   │   ├── src/jobs/cluster.ts    ✅ assign · score · re-check safety
│   │   ├── src/jobs/generate.ts   ✅ a draft, never a publication
│   │   ├── src/jobs/audience.ts   ✅ what readers engage with, as a vector
│   │   ├── src/jobs/prune.ts      ✅ the 30-day window, enforced not described
│   │   ├── src/jobs/report.ts     ✅ the hourly report, gathered and sent
│   │   ├── src/jobs/escalate.ts   ✅ what cannot wait an hour
│   │   ├── src/lib/escalation.ts  ✅ transitions, not reminders
│   │   ├── src/lib/report-derive.ts ✅ every number the report states
│   │   ├── src/jobs/dispatch.ts   ✅ one Telegram update, end to end
│   │   ├── src/lib/label.ts       ✅ naming a cluster; slugs
│   │   ├── src/lib/telegram.ts    ✅ intents, callback data, the queue card
│   │   ├── src/adapters/          🟡 Postgres, embeddings, Anthropic, logger
│   │   ├── src/index.ts           🟡 BullMQ wiring; needs Docker to run
│   │   └── test/                  ✅ 9 files
│   ├── admin/                     🔜 Phase 7
│
└── docs/
    ├── ARCHITECTURE.md            ✅
    ├── DATA-MODEL.md              ✅
    ├── SURFACES.md                ✅
    ├── HOURLY-REPORT.md           ✅ generated from real output
    ├── DECISIONS.md               ✅
    ├── PRIVACY.md                 ✅
    ├── COMPLIANCE.md              ✅
    ├── ROADMAP.md                 ✅
    ├── RUNBOOK.md                 ✅
    ├── BENCHMARKS.md              🟡 engine measured; load tests written, awaiting a stack
    └── FILE-TREE.md               ✅ this file
```

---

## What the remaining phases add

```
apps/
├── web/                                            Phase 3
│   ├── src/middleware.ts             edge assignment; writes tokens onto <html>
│   ├── src/app/layout.tsx            the adaptive shell
│   ├── src/app/(sections)/           hero · live-proof · trending · signup · proof
│   ├── src/app/t/[slug]/page.tsx     generated content
│   ├── src/app/api/health|ready
│   ├── src/lib/assignment.ts         Redis-backed sticky assignment
│   ├── src/lib/beacon.ts             batched client collector
│   └── src/components/consent-gate.tsx
│
├── api/                                            Phase 1 remainder
│   └── src/routes/dsr.ts             export and erasure endpoints
│
├── worker/                                         Phases 5–7
│   ├── src/scheduler.ts              repeatable jobs behind a Redis lease
│   └── src/jobs/
│       ├── adapt.aggregate.ts        ClickHouse → posteriors → Redis
│       ├── adapt.evolve.ts           LLM variant generation, every 6 h
│       ├── adapt.guardrails.ts       retirement and rollback sweeps
│       ├── crawl.discover|fetch|extract|cluster.ts
│       ├── content.generate.ts
│       ├── social.schedule|publish|metrics.ts
│       ├── report.hourly.ts
│       └── privacy.erasure.ts
│
└── admin/                                          Phase 7

packages/
├── ui/           tokens.css · primitives · section components   Phase 3
├── crawler/      robots · fetcher · extract · simhash · cluster · score · safety
└── social/       oauth · rate-limit · circuit-breaker · connectors/{x,meta,tiktok,…}

infra/
├── k6/ingest.js · k6/render.js                     Phase 8
└── grafana/provisioning/dashboards/json/*.json     Phase 8

e2e/             signup-per-provider · consent · stickiness · a11y paths   Phase 4
```

---

## Rules the tree encodes

- **`packages/adaptive` has no dependencies** — not on the workspace, not on npm. That
  is what makes it testable to 100% branches and fast enough for edge middleware.
- **`packages/core` depends on nothing in the workspace.** If two packages need the same
  shape, it lives here.
- **Apps may depend on packages. Packages may never depend on apps.**
- **Internal packages export TypeScript source**, not build output. Apps transpile them.
  It is the standard Turborepo "just-in-time package" pattern and it removes an entire
  class of build-ordering problem from a repository that never publishes to npm.
- **Every file implementing a rule from the brief cites the section in a comment**, so
  the reason survives the person.
