# Benchmarks

Section 7 of the brief: "Load test with k6: sustain 5,000 req/s on the ingest endpoint and
1,000 req/s on page render; commit the results to `docs/BENCHMARKS.md`."

**Status: methodology defined, load-test numbers pending Phase 8.** The load test needs
`apps/api` and `apps/web`, which are Phases 1 and 3. Fabricating plausible numbers here
would be worse than an empty table — a benchmark nobody ran is a lie with a chart on it.

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
pnpm test:coverage    # 381 tests; 100% branches in packages/adaptive
```

---

## 2. Planned — the load test

### 2.1 Targets

| Path                        | Target throughput                | Latency budget    | Notes                                       |
| --------------------------- | -------------------------------- | ----------------- | ------------------------------------------- |
| `POST /i` (ingest)          | **5,000 req/s** sustained 30 min | p99 < 25 ms       | The number the architecture is built around |
| `GET /` (page render)       | **1,000 req/s** sustained 30 min | p95 TTFB < 150 ms | Cold assignment cache on 20% of requests    |
| `GET /` (cached assignment) | 3,000 req/s                      | p95 TTFB < 80 ms  | The steady state for returning visitors     |

### 2.2 Method

```bash
make load-test          # k6 run infra/k6/ingest.js
```

The scenarios that matter, in `infra/k6/`:

1. **`ingest.js`** — ramp to 5,000 req/s over 5 minutes, hold for 30, ramp down. Payloads
   drawn from a fixture of realistic event batches, with a realistic mix of event types
   and a 10% batch rate. Reports p50/p95/p99, error rate, and — separately — how much of
   the latency is Redpanda produce time.
2. **`render.js`** — 1,000 req/s against `/` with an 80/20 warm/cold assignment split, so
   the measurement includes the `decide()` path rather than only the cache.
3. **`spike.js`** — 500 → 8,000 req/s in 10 seconds. What is being measured here is not
   throughput but _behaviour_: the buffer should absorb it, lag should rise and drain, and
   nothing should be dropped. This is the scenario Redpanda exists for.
4. **`soak.js`** — 1,000 req/s for 4 hours. Looking for memory growth, connection-pool
   exhaustion, and ClickHouse part-count drift.

### 2.3 What each result would mean

A load test whose only output is "it passed" has told you nothing. Each scenario has a
diagnosis attached:

| Observation                                     | Diagnosis                                            | Reference                                      |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Ingest p99 climbs while throughput plateaus     | Collector CPU saturation                             | `infra/SCALING.md#first`                       |
| Ingest fine, ClickHouse lag grows monotonically | Merge pressure, not ingest                           | `infra/SCALING.md#second`                      |
| Render p95 fine, p99 spiky                      | GC pauses or a cold assignment path                  | Profile the render, not the engine             |
| Errors only above ~4,000 req/s                  | Almost certainly file descriptors or ephemeral ports | Tune before concluding anything about the code |
| Spike drops events                              | The buffer is not configured as intended             | Check `REDPANDA_LINGER_MS` and producer acks   |

### 2.4 Core Web Vitals

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

| Date       | Commit    | Scenario               | Result                           |
| ---------- | --------- | ---------------------- | -------------------------------- |
| 2026-08-24 | `40e58e5` | `sim` — stationary     | 97.5% best share, +148.6% lift   |
| 2026-08-24 | `40e58e5` | `sim` — non-stationary | 93.4% best share after the shift |
| —          | —         | `k6 ingest`            | pending Phase 1                  |
| —          | —         | `k6 render`            | pending Phase 3                  |
| —          | —         | `k6 spike`             | pending Phase 8                  |
| —          | —         | Lighthouse             | pending Phase 3                  |

Append, never overwrite. A benchmark's value is largely in its trend.
