# Benchmarks

Section 7 of the brief: "Load test with k6: sustain 5,000 req/s on the ingest endpoint and
1,000 req/s on page render; commit the results to `docs/BENCHMARKS.md`."

**Status: the adaptive engine is measured; the load tests are written and unrun.** The
scripts live in `bench/` and are exercised by the test suite (§2.5), but a number needs a
running stack and a machine that is not the one they were written on. Fabricating plausible
numbers here would be worse than an empty table — a benchmark nobody ran is a lie with a
chart on it.

What _is_ measured today is measured, and appears below with the command that produced it.

---

## 1. Measured today — the adaptive engine

`packages/adaptive` is pure and has no infrastructure dependency, so it can be measured
on any machine. These numbers are from the convergence harness (`pnpm sim`), which is
deterministic: the same seed produces the same numbers on every machine, so a change here
is a change in behaviour rather than in the weather.

**Environment:** Node 24.15, Windows 11, 8 logical cores. Single-threaded.

### 1.1 Convergence — stationary world

Three variants, two context buckets, a genuine context effect (B wins on phone, C wins on
desktop, A is mediocre everywhere), 20,000 decisions.

| Metric                   | Value                   | What it means                                                                                                                                           |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal best-arm share  | **97.5%**               | Of non-holdout traffic in the last 20%, the contextually best variant was served 97.5% of the time. The ceiling is ~98% given the 2% exploration floor. |
| Terminal regret rate     | **0.0043** / impression | A non-learning policy pays ~0.043. An order of magnitude lower.                                                                                         |
| Cumulative regret        | 138.2 over 20,000 steps | Sublinear, as a bandit must be.                                                                                                                         |
| Champion identified      | correct                 | Matches the true best variant.                                                                                                                          |
| Measured lift vs holdout | **+148.6%**             | 12.6% vs 5.1% reward per impression.                                                                                                                    |

### 1.2 Recovery — non-stationary world

Identical, except the reward vectors rotate at step 24,000: the winning variant becomes
mediocre. 40,000 decisions.

| Metric                   | With forgetting | Without forgetting |
| ------------------------ | --------------- | ------------------ |
| Terminal best-arm share  | **93.4%**       | **2.1%**           |
| Terminal regret rate     | 0.0068          | 0.0807             |
| Cumulative regret        | 413             | 1,440              |
| Champion identified      | correct         | **wrong**          |
| Measured lift vs holdout | +106.5%         | +62.0%             |

The second column is the engine as first written, relying on the exploration floor alone.
It never recovers: a posterior built from 20,000 observations cannot be moved by 2% of
traffic in any useful timeframe. Exponential forgetting on both the Beta posteriors and
the LinUCB design matrix is what closes the gap. Both columns are asserted in
`packages/adaptive/test/sim.test.ts`, so the mechanism cannot be removed without the test
explaining why it exists.

### 1.3 Statistical validity

| Property                              | Test                                                 | Result                                                                                          |
| ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Type-I error under continuous peeking | 200 trials × 400 sequential looks under the null     | **< 10%** false positives at α = 0.05. A fixed-horizon test peeked this way fires on most runs. |
| `probabilityGreater` accuracy         | Against an independent Monte-Carlo estimate          | agrees to 2 decimal places                                                                      |
| Beta sampler moments                  | 200,000 draws, Beta(3,7)                             | mean within 0.005, variance within 0.002 of analytic                                            |
| Gamma sampler moments                 | 120,000 draws, shapes 0.4 and 4                      | mean and variance within tolerance for both the boost and direct paths                          |
| Sherman-Morrison drift                | 200 rank-1 updates vs a fresh Gauss-Jordan inversion | agrees to 9 decimal places                                                                      |

### 1.4 Reproduce

```bash
pnpm sim              # the convergence harness, with its full output
pnpm test:coverage    # the whole suite; 100% branches in packages/adaptive
```

---

## 2. Written and unrun — the load test

### 2.1 Targets

| Path                        | Target throughput                | Latency budget    | Notes                                       |
| --------------------------- | -------------------------------- | ----------------- | ------------------------------------------- |
| `POST /i` (ingest)          | **5,000 req/s** sustained 30 min | p99 < 25 ms       | The number the architecture is built around |
| `GET /` (page render)       | **1,000 req/s** sustained 30 min | p95 TTFB < 150 ms | Cold assignment on every request by default |
| `GET /` (cached assignment) | 3,000 req/s                      | p95 TTFB < 80 ms  | The steady state for returning visitors     |

### 2.2 Method

```bash
pnpm bench:smoke     # ten seconds of each, to prove the scripts still work
pnpm bench           # the two gate runs
```

Both scripts take `-e TARGET=…` for a deployed origin, and default to the local ports
`pnpm dev` uses. k6 is not a workspace dependency — it is a single Go binary, installed
separately, and pinning it in `package.json` would imply an `npm install` that does not
exist.

Written, in `bench/`:

1. **`ingest.js`** — a constant arrival rate of 5,000 req/s for three minutes against
   `POST /i`. Thresholds: p99 under 25 ms, error rate under 0.1%, and 99.9% of responses a
   `202` specifically.
2. **`render.js`** — 1,000 req/s across four real pages. The threshold is on
   `http_req_waiting` (TTFB) rather than total duration, because the budget in
   `docs/ARCHITECTURE.md` is about how long the origin takes to _start_ answering; page
   weight is a separate concern with a separate budget. Every request is a first-time
   visitor by default — `-e RETURNING=0.8` mixes in the cheap path once there is a mix
   worth reproducing, but the honest default is the expensive one.
3. **`payload.js`** — the beacon bodies and the visitor identities, shared by both, and
   the reason §2.3 is possible at all.

4. **`spike.js`** — 500 → 8,000 req/s in ten seconds, held, then back to baseline. Not a
   throughput test: latency is _expected_ to degrade under an unannounced sixteen-fold
   burst, and asserting otherwise would be asserting that the buffer is never used. What
   must hold is that nothing is lost and that the system comes back. The two baseline
   phases bracket the burst so recovery is a number rather than an impression.
5. **`soak.js`** — 1,000 req/s for four hours (`-e HOURS=`). The gate here is **drift, not
   level**: the first and last tenth of the run are recorded separately and compared, so a
   system that is 40% slower after four hours fails even at a healthy absolute p99.
6. **`clickhouse.js`** — the delivery check the two above depend on, described next.

### 2.3 Counting what arrived, not what was accepted

`POST /i` answers `202` once `sink.publish` resolves — the broker took it. Everything after
that (Redpanda retention, the Kafka table engine, the materialised view into
`morph.events`) is invisible from the response, and is exactly what a burst stresses. A
spike test that counts 202s and concludes that nothing was dropped would pass with the
producer misconfigured to `acks=0`, which is among the bugs the scenario exists to catch.

So `spike.js` and `soak.js` stamp a run id into every event's `props` and, in teardown, ask
ClickHouse how many arrived — polling until the count stops rising, because the consumer is
deliberately behind and reading once would report a draining queue as a loss.

The verdict is three-valued, and that is the point:

| Verdict                    | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| complete                   | Every event sent was found in `morph.events`               |
| lost N                     | The count settled below what was sent. The scenario failed |
| not checked / inconclusive | No credentials, or still rising when patience ran out      |

The third is reported as `FAIL`, not as a pass with a caveat. A spike run that did not
verify delivery has not tested the thing it exists for.

### 2.4 What the soak cannot see, and says so

`docs/ROADMAP.md` names three soak failures: memory growth, connection-pool exhaustion, and
ClickHouse part-count drift. The script measures the third from `system.parts`, and adds
latency drift and delivery on top. It does **not** measure the first two, and prints that it
did not.

The reason is worth recording. `infra/prometheus/prometheus.yml` scrapes `/metrics` on the
api, web and worker services; `infra/prometheus/rules/morph.yml` alerts on nine `morph_*`
metric names — and **no service currently serves any of them**. `CountingMetrics` in
`apps/api/src/routes/ingest.ts` says as much: "good enough until Prometheus is wired in
Phase 8". Until that exists a soak needs a human watching `docker stats`, and the summary
says so rather than reporting two of three as though it were three of three.

### 2.5 The trap these scripts are built around

The ingest limiter is `{ capacity: 60, refillPerSecond: 2 }`, keyed on the derived
anonymous identifier — which is `sha256(pepper ‖ salt ‖ ip ‖ user-agent)`. A load generator
sending every request from one address with one user agent is therefore **one visitor**,
and after sixty requests it receives a `429` for everything else.

That is a worse failure than an error, because it looks like a triumph. A `429` is the
cheapest response the server can produce; a run that measures it will report something like
40,000 req/s at a p99 of two milliseconds. The number would be real and would be about
nothing.

So `bench/payload.js` varies `X-Real-IP` — the header Caddy sets, and the only lever a load
generator has over that hash. Sustaining 5,000 req/s needs at least 2,500 identities at two
tokens per second each; the ingest pool is eight times that, so no identity is ever near its
limit. It is bounded rather than unlimited because the limiter holds a bucket per identity,
and a run that invented a million of them would be measuring that map instead.

The render path needs the opposite of that. It does not rate-limit; it _caches_ the
assignment under the same derived identity for thirty days, so on that path a repeated
address is a cache hit. A dense pool would quietly turn a cold-assignment benchmark into a
Redis benchmark about twenty seconds in — so `render.js` draws from a pool larger than any
run can exhaust, and asks for a repeat visit explicitly by reusing a virtual user's
previous address. That, not a cookie, is what a returning visitor is to the origin.

Three ways the run could otherwise pass while measuring nothing, each a hard k6 threshold
rather than a note in this file:

| Threshold                      | The failure it makes impossible                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `rate_limited: count==0`       | Measuring the limiter instead of the collector, as above                            |
| `rejected_400: count==0`       | A payload the schema rejects: a 400 skips the broker entirely and is _faster_       |
| `dropped_iterations: count==0` | k6 quietly stops scheduling when the target cannot be met, so 2,000 req/s "passes"  |
| `adapted_html: rate>0.999`     | An error page that renders quickly, rather than the adaptive path under measurement |

The second of those is also a unit test: `apps/api/test/bench-payload.test.ts` parses what
the builder produces with the same `ClientBatchSchema` the collector uses, and asserts the
schema is strict enough for that to mean something. Schema drift fails on the commit that
causes it rather than on the afternoon somebody wanted a number.

### 2.6 What each result would mean

A load test whose only output is "it passed" has told you nothing. Each scenario has a
diagnosis attached:

| Observation                                     | Diagnosis                                            | Reference                                      |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Ingest p99 climbs while throughput plateaus     | Collector CPU saturation                             | `infra/SCALING.md#first`                       |
| Ingest fine, ClickHouse lag grows monotonically | Merge pressure, not ingest                           | `infra/SCALING.md#second`                      |
| Render p95 fine, p99 spiky                      | GC pauses or a cold assignment path                  | Profile the render, not the engine             |
| Errors only above ~4,000 req/s                  | Almost certainly file descriptors or ephemeral ports | Tune before concluding anything about the code |
| Spike drops events                              | The buffer is not configured as intended             | Check `REDPANDA_LINGER_MS` and producer acks   |

### 2.7 Core Web Vitals

Enforced in CI by Lighthouse against the **adapted** pages — every palette, density and
layout variant, not only the baseline. A budget that holds only for the variant nobody
sees is not a budget.

| Metric | Budget   |
| ------ | -------- |
| LCP    | < 2.0 s  |
| CLS    | < 0.05   |
| INP    | < 200 ms |

The same thresholds are the automatic-rollback triggers in `DEFAULT_ENGINE_CONFIG`, so a
variant that would fail CI is quarantined in production before a human sees the report.

---

## 3. Results log

| Date       | Commit    | Scenario               | Result                             |
| ---------- | --------- | ---------------------- | ---------------------------------- |
| 2026-08-24 | `40e58e5` | `sim` — stationary     | 97.5% best share, +148.6% lift     |
| 2026-08-24 | `40e58e5` | `sim` — non-stationary | 93.4% best share after the shift   |
| —          | —         | `k6 ingest`            | script written; needs a deployment |
| —          | —         | `k6 render`            | script written; needs a deployment |
| —          | —         | `k6 spike`             | script written; needs a deployment |
| —          | —         | `k6 soak`              | script written; needs a deployment |
| —          | —         | Lighthouse             | pending a URL (D2, D3)             |

Append, never overwrite. A benchmark's value is largely in its trend.
