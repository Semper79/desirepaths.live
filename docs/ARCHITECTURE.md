# Architecture

Target: **5M+ events/day**, p95 page TTFB **< 150 ms** at the edge, adaptive decision
latency **< 5 ms**. Every choice below is justified against those three numbers. Where a
simpler option would have worked at a tenth of the volume, that is said explicitly —
knowing what you are paying for is the difference between an architecture and a stack of
fashionable components.

---

## 1. The shape of a request

```
                    ┌──────────────────────────────────────────────┐
   visitor ────────▶│ Caddy — TLS, HTTP/3, immutable asset cache    │
                    └───────────────┬──────────────────────────────┘
                                    │
              ┌─────────────────────┴──────────────────────┐
              │                                            │
     GET /  (page render)                          POST /i  (beacon)
              │                                            │
    ┌─────────▼──────────┐                      ┌──────────▼─────────┐
    │ Next.js middleware │                      │ Fastify collector  │
    │  · read anon id    │                      │  · hash IP at edge │
    │  · read consent    │                      │  · parse with zod  │
    │  · assignment?     │─ hit ──┐             │  · bot score       │
    └─────────┬──────────┘        │             └──────────┬─────────┘
              │ miss              │                        │
    ┌─────────▼──────────┐   ┌────▼────┐          ┌────────▼────────┐
    │ @morph/adaptive    │   │  Redis  │          │    Redpanda     │
    │  decide() × 11     │◀──│ 30d TTL │          │ morph.events.v1 │
    │  pure, < 5 ms      │   └─────────┘          └────────┬────────┘
    └─────────┬──────────┘                                 │
              │                                    ┌───────▼────────┐
    ┌─────────▼──────────┐                         │  ClickHouse    │
    │ RSC render with    │                         │  Kafka engine  │
    │ tokens inlined on  │                         │  + MVs         │
    │ <html style=…>     │                         └───────┬────────┘
    └─────────┬──────────┘                                 │
              │                              ┌─────────────▼─────────────┐
        adapted HTML                         │ worker: aggregate → fold  │
        no client flash                      │ posteriors → Redis        │
                                             └───────────────────────────┘
```

Two properties matter here more than anything else.

**The HTML that leaves the origin is already adapted.** Variant assignment happens in
edge middleware, before render, and the chosen design tokens are written onto the
`<html>` element as CSS custom properties. There is no client-side re-render, no
hydration swap, and therefore no layout flash — which is not merely cosmetic: a flash is
a Cumulative Layout Shift, CLS is in the reward's guardrails, and an adaptive system
that degrades the metric it is judged on is worse than no adaptive system.

**The beacon path never touches the adaptive path.** A traffic spike on ingest cannot
slow a page render, because the two share nothing but the edge process. This is why
Redpanda is in front of ClickHouse rather than the collector writing directly: a
ClickHouse merge storm becomes broker lag, not a 500 on the site.

---

## 2. Why each datastore

### ClickHouse for behaviour

At 5M events/day, a year of raw behaviour is ~1.8 billion rows. Postgres can _store_
that; it cannot scan it at interactive speed without a purpose-built rollup pipeline
that would end up being a worse ClickHouse. The bandit needs `GROUP BY (surface,
variant, context_bucket)` over arbitrary windows — a columnar OLAP workload — and running
it on the OLTP box would put analytical scans in contention with the transactions that
serve page loads.

The partitioning and TTL reasoning lives in `infra/clickhouse/init/001_events.sql`
alongside the DDL, where it will still be read in a year.

**What we pay:** a second database to operate, no transactions, no joins worth the name,
and a mutation model where "delete this person's rows" is a bounded-partition operation
rather than a `DELETE`. The privacy design accommodates that deliberately — see
`docs/PRIVACY.md`.

### Postgres for everything else

Identity, content, configuration, the variant pool and the adaptation log. All small,
all needing transactions and foreign keys, none needing more than a few million rows.
`adaptation_log` and `outbound_post` are monthly RANGE partitions so retention is a
`DETACH`, not a `DELETE` that bloats the heap.

### Redis for the hot path

Variant assignments (30-day TTL), posterior cache, rate-limit token buckets, BullMQ
queues and sessions. `maxmemory-policy noeviction` is deliberate: assignments and
posteriors are reconstructible, but queue jobs are not, and an eviction policy that
silently drops a job is worse than an out-of-memory error somebody notices.

### Redpanda for the buffer

Kafka API without ZooKeeper or a JVM. Its job is to absorb the difference between
arrival rate and ClickHouse's preferred insert rate. Without it, a spike either drops
events or blocks a page render; with it, a spike becomes consumer lag that drains on its
own — visible in the hourly report as an anomaly rather than as a hole in the data.

---

## 3. The adaptive engine

`packages/adaptive` is pure: no I/O, no clock, no `Math.random()`, zero runtime
dependencies, 100% branch coverage. That is not aesthetic. It is what makes the decision
path fast enough for edge middleware, and what lets the convergence claims be tested
rather than asserted.

### Two layers, complementary

|           | Thompson sampling                                        | LinUCB                                      |
| --------- | -------------------------------------------------------- | ------------------------------------------- |
| State     | one Beta posterior per (surface, variant, coarse bucket) | one design matrix per (surface, variant)    |
| Context   | discretised: device × referrer class × day-part          | full 26-dimensional covariate vector        |
| Strengths | robust, needs little data, self-annealing                | shares strength across contexts, expressive |
| Weakness  | relearns every cell from scratch                         | linear model of a non-linear world          |

They are blended, with the contextual weight ramping from 0 to a cap of 0.6 as the
linear model accumulates evidence (`contextualWeight` in `assign.ts`). A cold LinUCB arm
returns a large confidence bonus for every context; blending that at full weight from
the first request would turn a careful Bayesian bandit into a random number generator
with extra steps.

### Order of precedence in `decide()`

1. Operator pin — a human said so.
2. Adaptation disabled (`/pause_adaptation`, `/kill`) — freeze on champions.
3. Consent not granted — baseline.
4. Holdout cohort — baseline.
5. Forced exploration — the floor.
6. Thompson + LinUCB.
7. Baseline fallback.

Ordered by authority, not convenience. Every rule above a line may ignore everything
below it.

### What the harness changed

The first version relied on the exploration floor alone to notice a change in the world.
The simulation showed it never did: after the best arm changed, terminal best share fell
to 2% and stayed there, because a posterior built from 20,000 observations cannot be
moved by 2% of traffic in any useful timeframe. Exponential forgetting on both the Beta
posteriors and the LinUCB design matrix brings recovery to 93% and cuts terminal regret
by an order of magnitude. Both behaviours are asserted in `test/sim.test.ts`.

This is the clearest example of why the harness exists: the bug was not in any function,
it was in the assembled system, and no unit test would have found it.

---

## 4. Latency budget

| Stage                               | Budget       | How it is met                                                    |
| ----------------------------------- | ------------ | ---------------------------------------------------------------- |
| TLS + edge routing                  | 15 ms        | Caddy, HTTP/3, session resumption                                |
| Assignment lookup                   | 2 ms         | Redis `GET` on a pipelined connection                            |
| Assignment computation (cache miss) | 5 ms         | 11 surfaces × pure `decide()`; no allocation beyond a scores Map |
| RSC render                          | 60 ms        | Partial prerendering; only the adaptive shell is dynamic         |
| Serialise + compress                | 15 ms        | zstd, precomputed token string                                   |
| **p95 TTFB**                        | **< 150 ms** | leaves ~50 ms of headroom                                        |

The 5 ms decision budget is for _all eleven surfaces together_, which is why the engine
is a pure function over plain data rather than something that reads from a store per
surface.

---

## 5. Observability

OpenTelemetry traces on every request, exported to a collector that tail-samples: every
error, everything over 500 ms, every trace carrying a `morph.surface` attribute, and 5%
of the rest. At 5M events/day, sampling is not an optimisation — a 100% trace store
would cost more than the rest of the infrastructure combined.

The collector also strips `http.client_ip`, `user_agent.original`, cookies and query
strings. It is the last place to catch an attribute somebody added to a span without
thinking, and that safety net belongs in configuration rather than in everyone's memory.

Prometheus for metrics with a 30-day retention, Grafana provisioned as code, alert rules
in `infra/prometheus/rules/morph.yml` that fire into Telegram rather than into a
dashboard nobody is watching.

---

## 6. The trend pipeline

Nine stages, each a module in `packages/crawler`, each pure except the one that touches
the network:

```
robots  →  politeness  →  fetch  →  feed / extract  →  simhash  →  cluster  →  score  →  safety
  what a     how fast      the only    a publisher's   the same     stories     which are   which never
  host       we may ask    outbound    words, not      story,       into        worth       are
  permits                  request     their nav       forty times  topics      writing
```

**Why purity is the design and not a preference.** Everything except `fetch` takes plain
data and returns plain data, which is what allows a one-minute crawl delay, a topic
peaking six hours ago and a near-duplicate to be asserted in a test suite that runs in
under a second. `fetch` itself takes `fetch`, the clock and `sleep` as injected
dependencies, so even the network stage is tested offline — the whole compliance
position is proven by 227 tests with no network and no sleeping.

**Where the cheap filter goes.** SimHash runs before embeddings, not after. It answers a
narrow question — is this the same text with a byte changed — in a 64-bit integer
comparison, and removes the overwhelming majority of duplicates before anything expensive
is computed on them. Clustering then answers the broader question SimHash cannot: are
these two different articles about the same thing.

**Why deduplication comes before scoring at all.** Without it, momentum measures
syndication rather than interest, and the topic that wins is whichever press release had
the widest distribution list.

**Ordering inside the fetcher.** Robots is checked before the rate limiter, so a
disallowed path never consumes a rate-limit slot and the audit trail records "we did not
ask" rather than "we waited, then did not ask". Host constraints always beat global ones:
being under the global QPS budget is never permission to hit one host twice at once.

### How the jobs are shaped

`apps/worker` runs five scheduled jobs over those stages — `crawl`, `embed`, `cluster`,
`generate`, `prune` — and every one of them is written against `src/ports.ts` and nothing
else. No database client, no queue, no HTTP client, no clock.

**Why a seam and not a mocked database.** A mocked query builder reproduces the _shape_ of
a query, not its meaning, so a test passes while the SQL is wrong. The ports are written
in the vocabulary of the pipeline — "documents that still need an embedding", "clusters
seen since" — so a fake implements the intent, and the real adapter is one query per
method with no branch in it.

**Why every job takes a batch size.** Not elegance: a job that runs for twenty minutes
loses twenty minutes of work when the worker is redeployed, and BullMQ eventually decides
it stalled and runs it again from the start. Small jobs that record progress as they go
are restartable at any point.

**Where the pipeline is honest about not knowing.** Audience fit needs an interest vector,
and before there is enough traffic to compute one there simply is not an answer. Rather
than substitute a plausible number — 0 suppresses every topic, 1 promotes every topic, and
neither announces itself — the component is dropped, the remaining three weights
renormalise, and the log records that the score came from three signals. The same instinct
governs the deterministic embedding provider: it exists so the pipeline runs on a laptop,
and the environment loader refuses to start with it in production.

### The loop the audience vector closes

```
   readers          ClickHouse                 Postgres                 the next topic
      │                  │                        │                          │
  engage with       content_engagement_daily   audience_vector          audienceFit =
  some pages   ──▶  per page-session      ──▶  centroid of the    ──▶   cos(topic, vector)
                    (the reward's own          above-median pages        in scoreTopic()
                     components)
```

`audienceFit` is the only term in the trend score that is about _this site_ rather than
about the web. Momentum, saturation and durability would produce the same ranking for
anybody; this is the term that makes the pipeline write for the readers it actually has.

**It runs on the same reward the bandit optimises.** Not a fresh definition of engagement:
`content_engagement_daily` holds the columns of `RewardComponents`, and the job runs
`compositeReward` over them with the live weights from `engine_config`. Two definitions of
a good page in one system is how an optimiser ends up pulling against its own content
pipeline — the bandit tuning layout for one notion of quality while the writer chases
another.

**A median split, not a top-N.** A top-N is a fixed appetite regardless of how much there
is to be confident about: with six published pages it takes half the site, with six
hundred it ignores most of what readers liked. The median splits whatever exists and means
the same thing at both sizes. Within the selected half, pages are weighted by their reward,
because the split decides _which_ pages count and the score decides _how much_.

**The feedback loop is real and is bounded on purpose.** Writing towards what readers
already engaged with narrows the site over time — every topic scored partly by its
resemblance to previous winners. Three things keep the circumference wide enough to be
useful: `audienceFit` is 30% of the composite, not all of it; the vector is a centroid of
the whole above-median half rather than of the best few; and it is recomputed from a
30-day window, so a topic that stops working stops counting. It is a feedback loop that is
meant to be one, with its gain turned down.

---

## 7. What this architecture is not good at

Stated plainly, because an architecture document that only lists strengths is marketing.

- **Multi-region.** Everything assumes one region. Serving Asia-Pacific well would need
  read replicas and a rethink of sticky assignment.
- **Strong consistency between the assignment and the posteriors.** A visitor can be
  assigned from a posterior that is up to five minutes stale. That is a deliberate
  trade — the alternative is a synchronous read on the render path — and it costs a
  negligible amount of regret.
- **Sub-second reaction.** The aggregation cycle is five minutes and the report is
  hourly. MORPH adapts over hours, not seconds, and nothing in the design pretends
  otherwise.
- **Operating without Docker.** `packages/core`, `packages/adaptive` and
  `packages/telegram` are pure and run anywhere Node runs; everything else needs the
  data plane.
