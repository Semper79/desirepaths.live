# Runbook

For the person on call at 03:00, which is the same person who wrote it. Written in the
order things actually go wrong, with the diagnosis before the fix.

**Before anything else:** if the site is serving and only the adaptive layer is
misbehaving, `/pause_adaptation` freezes assignment on current champions. The site keeps
working; it just stops learning. That buys time and costs almost nothing. Use it early.

---

## 0. Emergency controls

| Command                    | Effect                                                                         | Reversible            |
| -------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| `/pause_adaptation`        | Freeze on champions. Site unaffected.                                          | `/resume`             |
| `/pin <surface> <variant>` | Force one variant, suspend learning on that surface                            | `/rollback <surface>` |
| `/rollback <surface>`      | Revert a surface to its baseline                                               | `/resume`             |
| `/autonomy manual`         | Nothing is drafted or posted automatically                                     | `/autonomy review`    |
| `/kill`                    | Freeze **all** autonomous behaviour: adaptation, generation, crawling, posting | `/resume`             |

`/kill` is the one to reach for when you do not yet know what is wrong. It is designed to
be used by someone who has not read the rest of this document.

---

## 1. Service down

**Alert:** `ServiceDown`

```bash
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs --tail=200 <service>
```

| Symptom                                      | Likely cause                               | Fix                                                    |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Container restarting in a loop               | Bad env or a failed migration              | Read the first 50 log lines, not the last              |
| OOM-killed                                   | `maxmemory` on Redis, or a Node heap limit | Check `docker stats`; raise the limit or find the leak |
| Healthcheck failing but the process is alive | Dependency not ready                       | Check the dependency, not the service                  |

Web, API and worker are stateless: `docker compose restart <service>` is safe and loses
nothing. Postgres, ClickHouse, Redis and Redpanda are not — restarting them is safe but
disconnects clients, so restart the app services afterwards.

---

## 2. Ingest errors

**Alert:** `IngestErrorRate` (>1% of beacons failing)

Work down this list; each step takes under a minute.

1. **Is Redpanda healthy?** `docker compose exec redpanda rpk cluster health`. If not,
   the collector is failing to produce and events are being dropped at the edge.
2. **Is it a schema problem?** `SELECT count(), any(error) FROM morph.events_dlq WHERE
ingested_at > now() - INTERVAL 10 MINUTE`. A non-zero count with a consistent error
   means the client and the schema disagree — check whether a deploy shipped a new event
   field without bumping `morph.events.v1`.
3. **Is it one client?** Group the DLQ by `JSONExtractString(raw, 'ctx', 'device')`. A
   single browser version failing is a client bug, not a server one.
4. **Is it load?** `morph_ingest_requests_total` plateauing while Caddy connections rise
   is CPU saturation — see `infra/SCALING.md#first`.

**Data loss assessment:** events in the DLQ are _not_ lost; they are parked for 14 days
and can be replayed once the parser is fixed. Events rejected at the collector before
reaching Redpanda are lost, and the counter `morph_ingest_errors_total` is the only
record of how many.

---

## 3. Ingest lag

**Alert:** `ClickHouseIngestLag` (p95 above 5 s)

This is usually benign — the buffer doing its job during a spike. It becomes a problem
when it does not drain.

```sql
-- Is the consumer keeping up?
SELECT * FROM system.kafka_consumers FORMAT Vertical;

-- Is the merge scheduler saturated?
SELECT count() FROM system.merges;
SELECT table, count() FROM system.parts WHERE active GROUP BY table ORDER BY 2 DESC;
```

| Reading                  | Meaning                    | Fix                                               |
| ------------------------ | -------------------------- | ------------------------------------------------- |
| Lag rising, merges empty | Consumer under-provisioned | Raise `kafka_num_consumers`, add topic partitions |
| Lag rising, merges busy  | Too many small parts       | Raise `async_insert_busy_timeout_ms`              |
| Lag flat and high        | A consumer is stuck        | `DETACH`/`ATTACH` the `events_queue` table        |

Nothing here loses data. Redpanda retains the topic; ClickHouse catches up.

---

## 4. Negative holdout lift

**Alert:** `NegativeHoldoutLift` (below −2% sustained for 6 hours)

**The most important alert in the system.** It says the adaptive engine is making the
site measurably worse than doing nothing.

1. `/pause_adaptation`. Immediately. Do not investigate first.
2. Confirm it is real, not a reward-version artefact:
   ```sql
   SELECT DISTINCT reward_version FROM adaptation_log
   WHERE occurred_at > now() - INTERVAL '7 days';
   ```
   More than one value means two incomparable epochs are being compared and the number is
   meaningless. Fix the comparison window, not the engine.
3. Confirm the holdout is intact: it should be within 0.5 pp of `HOLDOUT_FRACTION`. A
   drifting share means the hash namespace changed, which invalidates the comparison.
4. Look at `adaptation_log` for the window. A single bad promotion is usually visible.
5. If a specific surface is responsible, `/rollback <surface>` and `/resume`. If not,
   stay paused and investigate with time you now have.

**Do not** respond by tuning weights. A negative lift means the system is optimising
something other than what you want, and adjusting the coefficients of a wrong objective
gets you a more confident wrong answer.

---

## 5. A variant was quarantined

**Alert:** `VariantQuarantined`

Usually working as intended. The report names the variant and the breach.

```sql
SELECT variant_id, reason, stats FROM adaptation_log
WHERE action = 'quarantined' AND occurred_at > now() - INTERVAL '1 hour';
```

- **LCP or INP breach** — an expensive variant met real devices. Correct outcome. Either
  make it cheaper or leave it retired.
- **Bounce-rate breach** — the variant is worse in a way the reward had not yet caught.
  Correct outcome.
- **Client-error breach** — a genuine bug in that variant's render path. Fix the bug,
  then `/resume`.
- **Several variants of one surface at once** — this is not the variants. Something
  shared broke: a font failing to load, a CDN issue, a bad deploy. Look there.

---

## 6. Core Web Vitals regression

**Alert:** `LcpBudgetBreach`

```sql
SELECT variant, device_class, quantileTDigestMerge(0.75)(p75) AS lcp_p75, countMerge(samples) AS n
FROM morph.vitals_hourly
WHERE metric = 'lcp' AND hour_start > now() - INTERVAL 6 HOUR
GROUP BY variant, device_class ORDER BY lcp_p75 DESC LIMIT 20;
```

If one variant dominates, the guardrail should already have quarantined it — if it has
not, check that `rollback.minSamples` is not set higher than the traffic that variant
receives. If _every_ variant regressed together, it is infrastructure: origin latency,
a font, an image pipeline, or a deploy.

---

## 7. Exploration collapsed

**Alert:** `ExplorationCollapsed`

The engine has stopped learning. Either `EXPLORATION_FLOOR` was set to zero, or every
surface has one active variant left, or adaptation is paused and nobody noticed.

```sql
SELECT surface_id, count(*) FILTER (WHERE status = 'active') AS active
FROM variant GROUP BY surface_id ORDER BY active;
```

A surface down to one active variant needs new candidates: check whether `adapt.evolve`
is running and whether its generations are being rejected — the rejection reasons are in
the hourly report.

---

## 8. Queue backlog

**Alert:** `QueueBacklog`

```bash
docker compose exec redis redis-cli --scan --pattern 'bull:*:wait' | head
```

- **One queue backed up** — that job type is failing or slow. Check its logs.
- **Every queue backed up** — no worker holds the scheduler lease, or workers are dead.
- **Backlog with idle workers** — the lease holder died without releasing. It expires on
  its TTL; if it does not, delete the lease key and a worker will take over.

---

## 9. A platform circuit breaker opened

The report shows rate-limit headroom per platform. A breaker opens after repeated 429s
or a 403.

```sql
SELECT platform, circuit_open_until, consecutive_failures FROM social_account;
```

**Do not** work around it. The daily cap is deliberately well below the platform's
documented ceiling, so hitting a limit means something is wrong with our pacing, not with
their limit. Check whether the scheduler fired a backlog all at once after downtime — the
usual cause — and whether `SOCIAL_DAILY_ACTION_CAP` is being respected.

A 403 rather than a 429 may mean an app-review or terms issue. That is an email, not a
retry.

---

## 10. Security incident

1. **Contain.** `/kill`. Rotate the affected credential immediately. If the database may
   be involved, rotate `ANON_ID_PEPPER` last — it changes every anonymous identifier and
   breaks the erasure reach for existing data.
2. **Assess.** What data, how many subjects, what window. `adaptation_log` and the
   Postgres audit trail are append-only and are the evidence.
3. **Notify.** Supervisory authority within **72 hours** where there is a risk to rights
   and freedoms. Affected individuals without undue delay where the risk is high.
4. **Record.** Every breach goes in the register, including ones not notified, with the
   reasoning for not notifying.
5. **Only then** fix the root cause and write the post-mortem.

See `docs/PRIVACY.md#9-breach-procedure`.

---

## 11. Restore from backup

**Postgres**

```bash
docker compose exec postgres pg_dump -U morph -Fc morph > morph-$(date +%F).dump
docker compose exec -T postgres pg_restore -U morph -d morph --clean --if-exists < morph.dump
```

**ClickHouse** — `BACKUP DATABASE morph TO Disk('backups', 'morph-YYYY-MM-DD')`.

**Redis** — deliberately _not_ restored. Assignments and posteriors are reconstructible
from ClickHouse within one aggregation cycle, and restoring a stale posterior set is
worse than rebuilding it. Queue jobs are the only genuine loss, and they are idempotent
by design.

**Order after a full restore:** Postgres → ClickHouse → apps → let the worker rebuild
Redis. Do not `/resume` until the first aggregation cycle has completed, or the engine
will make decisions from empty posteriors.

---

## 12. Deploy

```bash
pnpm verify                       # nothing ships red
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d --wait
```

Migrations run before the new containers take traffic. They are expand-only: add a column
now, drop it two deploys later, so a rollback never meets a schema it cannot read.

**Rollback:** redeploy the previous image tag. Because migrations are expand-only, no
schema rollback is needed. If one ever is, that migration was wrong.

**After every deploy:** watch `morph_decision_duration_ms` and the Core Web Vitals for
one hour. A regression there is the fastest signal that something in the adaptive path
got slower.
