# Scaling

Section 1 of the brief: "Write `infra/SCALING.md` explaining exactly which services scale
horizontally and what the first bottleneck will be."

The honest headline: **at 5M events/day a single CCX23 is not close to saturated.** The
interesting question is not how to scale, it is which thing breaks first and how you
would know — because the wrong answer to that is a rewrite, and the right one is usually
a config change.

---

## 1. Per-service classification

Every service in `infra/docker-compose.yml` carries a `morph.scaling` label.

| Service      | Class           | Replicas > 1 safe?                           | Notes                                                     |
| ------------ | --------------- | -------------------------------------------- | --------------------------------------------------------- |
| `caddy`      | stateless       | Yes, behind a load balancer                  | Certificate storage must be shared or issued per instance |
| `web`        | stateless       | **Yes**                                      | No local state; assignment cache is in Redis              |
| `api`        | stateless       | **Yes**                                      | The first service that will need replicas                 |
| `worker`     | stateless       | **Yes, with a caveat**                       | See §2                                                    |
| `admin`      | stateless       | Yes                                          | Low traffic; one is enough for years                      |
| `postgres`   | stateful-single | No — scaling means replication, not replicas | §4                                                        |
| `clickhouse` | stateful-single | No — scaling means a cluster                 | §5                                                        |
| `redis`      | stateful-single | No — scaling means Cluster or Sentinel       | §6                                                        |
| `redpanda`   | stateful-single | No — scaling means partitions and brokers    | §7                                                        |
| `prometheus` | stateful-single | No                                           | Federate or remote-write if it outgrows the node          |
| `grafana`    | stateless       | Yes                                          | Stateless once provisioned from files                     |

---

## 2. The worker caveat

BullMQ workers are horizontally scalable — that is the point of a queue. But the
_repeatable-job scheduler_ (`report.hourly`, `adapt.evolve`, the daily maintenance jobs)
must be owned by exactly one process, or the operator receives four identical reports at
the top of every hour and the evolve job races itself.

Ownership is taken through a Redis lock with a TTL, renewed by the holder
(`apps/worker/src/scheduler.ts`), **not** by running a single replica. The distinction
matters: a single replica is a single point of failure that nobody notices until the
reports stop. A lease means any worker can take over within one TTL when the holder dies.

---

## 3. Which bottleneck arrives first

In order, with the traffic level at which each becomes real. These are estimates from
first principles and from the load-test methodology in `docs/BENCHMARKS.md`, not
measurements from production — they should be replaced with measurements as soon as
there are any.

### First: ingest CPU on the `api` service — around 8–12k req/s

Each beacon costs a JSON parse, a zod validation, a sha256, a bot score and a Kafka
produce. Call it ~120 μs of CPU. On 8 vCPU with 6 available to the API, that is roughly
40k req/s theoretical, and realistically 8–12k with the event loop, TLS and GC.

**Symptom:** p95 on `POST /i` climbs above 20 ms; `morph_ingest_requests_total` plateaus
while Caddy's connection count keeps rising.

**Fix, in order of preference:**

1. Raise `REDPANDA_LINGER_MS` from 5 to 20 — fewer, larger produce calls. Costs 15 ms of
   invisible latency.
2. Run `api` with `--max-old-space-size` tuned and `UV_THREADPOOL_SIZE` raised.
3. Add API replicas. It is stateless; this is a `--scale api=3` away.
4. Move the collector to the edge (Cloudflare Worker or similar) and have it produce to
   Redpanda over HTTP.

### Second: ClickHouse merge pressure — around 25–40M events/day

The `events` table is `MergeTree` with daily partitions. Insert rate drives part
creation; part count drives merge work; merge work competes with query work. With
`async_insert` enabled (already configured) the server batches small inserts, which is
what keeps this from being the _first_ bottleneck.

**Symptom:** `system.merges` consistently non-empty; `system.parts` count per partition
climbing past a few hundred; the five-minute refreshable MV starting to overlap itself.

**Fix, in order:**

1. Raise `async_insert_busy_timeout_ms` — larger batches, fewer parts.
2. Move the aggregate MVs from five-minute to fifteen-minute refresh. The bandit does not
   need five-minute freshness; that number was chosen for comfort, not necessity.
3. Add a second disk and a tiered storage policy: hot NVMe for the last 7 days, cheaper
   storage for the tail.
4. Shard. This is the point where ClickHouse stops being a single node, and it is a real
   project — do not reach for it before steps 1–3.

### Third: Postgres connection saturation — around 5–8 app replicas

Postgres handles a few hundred connections badly regardless of how many the config
allows. Each app replica holds a pool.

**Symptom:** `pg_stat_activity` full of idle-in-transaction; latency climbing on queries
that were fast yesterday.

**Fix:** PgBouncer in transaction mode in front of Postgres. Roughly an hour of work and
it removes the problem for a long time. Do this _before_ adding the fifth replica, not
after.

### Fourth: Redis memory — around 3–5M monthly visitors

The assignment cache is one key per (visitor, surface) with a 30-day TTL. At 11 surfaces
and ~200 bytes per key, one million monthly visitors is roughly 2.2 GB. `maxmemory` is
set to 4 GB and the policy is `noeviction`, so this fails loudly rather than silently
dropping queue jobs.

**Fix, in order:**

1. Pack the whole assignment into **one** key per visitor rather than one per surface —
   an 11× reduction, and it is a serialisation change in one module.
2. Shorten `ASSIGNMENT_TTL_SECONDS` from 30 days to 7. Costs some stickiness for
   long-absent visitors.
3. Split queues onto a second Redis instance; queues and cache have completely different
   durability needs and do not belong together at scale.
4. Redis Cluster.

### Fifth: Redpanda partitions — around 50k events/s

The topic starts with a modest partition count. Throughput is bounded by
partitions × per-partition throughput, and ClickHouse's Kafka engine consumes with
`kafka_num_consumers = 4`.

**Symptom:** consumer lag that grows during peaks and does not fully drain between them.

**Fix:** increase partitions (forwards-compatible), raise `kafka_num_consumers` to match,
then add brokers. Note that increasing partitions changes key-based ordering — the event
schema does not depend on cross-partition ordering, which is why this is a safe knob here
and would not be everywhere.

---

## 4–7. Data-plane scaling paths

**Postgres.** Streaming replication for read replicas (the admin console and the report
composer are pure readers and should move there first), then partition the two large
tables further if a month becomes unwieldy. Sharding is not on the path: nothing in this
schema needs it.

**ClickHouse.** Single node → single node with tiered storage → sharded cluster with
`Distributed` tables. The schema is already shard-ready: the sorting keys do not assume
locality, and the aggregate MVs are per-shard-safe because every aggregate function used
is mergeable.

**Redis.** Single → Sentinel for failover → Cluster. Splitting queues from cache is a
better first move than any of those.

**Redpanda.** Single broker → three brokers with `replication_factor=3`. The single-broker
launch configuration accepts that a broker failure loses in-flight events, which is
acceptable for behavioural analytics and would not be for anything transactional.

---

## 8. The Kubernetes migration

Every service in the compose file maps 1:1:

| Compose                  | Kubernetes                                                    |
| ------------------------ | ------------------------------------------------------------- |
| stateless services       | `Deployment` + `Service` + `HorizontalPodAutoscaler`          |
| stateful-single services | `StatefulSet` + `PersistentVolumeClaim`                       |
| `caddy`                  | `Ingress` (nginx or Traefik), or keep Caddy as a Deployment   |
| the scheduler lease      | unchanged — it is a Redis lease, not a replica count          |
| `.env`                   | `Secret` + `ConfigMap`                                        |
| healthchecks             | `livenessProbe` / `readinessProbe` against the same endpoints |

The migration is mostly mechanical _because_ the compose file was written with it in
mind: no service writes to a local path outside a named volume, no service assumes a
fixed hostname other than through environment variables, and no service assumes it is
the only instance except where the label says so.

**Do not do this before there is a reason.** Kubernetes replaces a `docker compose up`
you can debug at 3am with a control plane you also have to operate. The reason will be
one of: needing more than one node, needing zero-downtime deploys that Caddy cannot
give, or needing an on-call rotation with more than one person in it.

---

## 9. Cost at each stage

| Stage  | Traffic            | Infrastructure                 | Approx. monthly |
| ------ | ------------------ | ------------------------------ | --------------- |
| Launch | < 5M events/day    | 1 × CCX23 (8 vCPU / 32 GB)     | €49             |
| Growth | 5–25M events/day   | 1 × CCX33 (16 vCPU / 64 GB)    | €100            |
| Scale  | 25–100M events/day | 2 × CCX33 (app + data split)   | €200            |
| Large  | > 100M events/day  | Kubernetes, sharded ClickHouse | €800+           |

Excludes the Anthropic API (capped by `ANTHROPIC_MONTHLY_BUDGET_USD`, default $200) and
any paid platform API. At launch the LLM budget is the largest single line item, which is
worth knowing before optimising the €49 one.
