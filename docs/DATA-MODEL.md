# Data model

Section 9.2 of the brief: "The Postgres schema and the ClickHouse schema, with your
reasoning on partitioning and TTL."

The schemas themselves are in the repository and are the source of truth:

- **ClickHouse** — `infra/clickhouse/init/001_events.sql` and `002_aggregates.sql`
- **Postgres** — `packages/core/src/db/schema.ts` (Drizzle), with extensions, roles and
  partition maintenance in `infra/postgres/init/001_bootstrap.sql`

This page holds the reasoning that would otherwise be lost between the two.

---

## 1. The split

|                           | Postgres                                                        | ClickHouse                                      |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| Holds                     | identity, content, config, the variant pool, the adaptation log | behaviour                                       |
| Row count at steady state | low millions                                                    | low billions                                    |
| Write pattern             | transactional, mixed read/write                                 | append-only, never updated                      |
| Read pattern              | point lookups and small joins                                   | wide aggregations over time ranges              |
| Consistency               | strict; foreign keys mean something                             | eventual; a five-minute-stale aggregate is fine |

The dividing question is simple: _does this need a transaction?_ A sign-up does. A scroll
event does not, and there are five million of them a day.

---

## 2. ClickHouse

### 2.1 `events` — the single raw fact table

```sql
PARTITION BY toDate(ts)
PRIMARY KEY (event_type, ts)
ORDER BY (event_type, ts, anon_id)
TTL toDateTime(event_date) + INTERVAL 90 DAY DELETE
SETTINGS ttl_only_drop_parts = 1
```

**Why daily partitions.** At 5M rows/day a partition is a few hundred megabytes
compressed — large enough that merges stay cheap, small enough that the 90-day retention
drops whole parts instead of rewriting them (`ttl_only_drop_parts = 1` makes that
explicit). Monthly partitions would turn retention into a rewrite. Hourly partitions
would produce 2,160 active partitions and overwhelm the merge scheduler. Daily is the
only sane choice at this volume, and it stops being so somewhere above 50M/day, where
the fix is tiered storage rather than finer partitions.

**Why this sorting key.** Every hot query filters on a time range first — the partition
prunes that — and then on an event type: "signups in the last hour", "impressions since
the posteriors were last refreshed". A low-cardinality `event_type` first gives
ClickHouse a tight granule range; `ts` second keeps the read sequential; `anon_id` last
makes per-visitor dedup local. The `PRIMARY KEY` is deliberately a shorter prefix than
`ORDER BY`, so the sparse index stays in memory while the extra key column still helps
compression.

**Why parallel arrays for the assignment.** `surfaces` and `variants` are two aligned
`Array(LowCardinality(String))` columns rather than a `Map`. `ARRAY JOIN` over aligned
arrays is the fastest way to explode an assignment into one row per surface — exactly
what the reward aggregation does — and a `Map` would force a `mapKeys`/`mapValues` pair
with worse codegen and no dictionary encoding.

**Why codecs are specified per column.** `DoubleDelta` on monotonic timestamps and
`ZSTD(3)` on the high-entropy `anon_id` are worth roughly 3× on the two widest columns.
`LowCardinality` handles the rest through dictionary encoding, which is also why the
context columns are typed that way rather than as plain `String`.

**The TTL is the privacy commitment.** 90 days of raw behaviour, enforced by the storage
engine rather than by a cron job somebody can forget. `RAW_EVENT_RETENTION_DAYS`
documents it; `docs/PRIVACY.md` promises it; changing one without the other is a
compliance bug.

### 2.2 Ingest

ClickHouse consumes Redpanda directly through a `Kafka` engine table plus a materialised
view. A hand-written consumer would have to reimplement offset management, batching and
back-pressure, and would do it worse. All enrichment needing request context — IP
hashing, geo, bot scoring, consent — already happened in the edge collector, so nothing
downstream of the buffer needs application logic.

Malformed messages are _parked_, not dropped: `kafka_handle_error_mode = 'stream'` routes
them to `events_dlq` with the parse error, retained for 14 days. An ingest schema
regression becomes a visible number in the hourly report rather than a silent hole in the
data.

### 2.3 Aggregates — and the one decision that matters most

The composite reward's weights are operator-configurable and hot-reloadable. Therefore
**ClickHouse does not store the reward.** It stores the sufficient statistics — signups,
engaged sessions, scroll sum, returns, shares, bounces — and `packages/adaptive` combines
them with whatever weights are live at decision time.

Baking the weights into a materialised view would mean every weight change silently
invalidates months of history, or forces a backfill nobody remembers to run. Storing
components costs six `UInt64` columns and buys permanent comparability.

| View                     | Engine               | Grain                                       | Feeds                  |
| ------------------------ | -------------------- | ------------------------------------------- | ---------------------- |
| `sessions`               | AggregatingMergeTree | one row per session                         | reward aggregation     |
| `surface_rewards_hourly` | SummingMergeTree     | hour × surface × variant × bucket × holdout | the bandit             |
| `traffic_hourly`         | AggregatingMergeTree | hour × page × source × country × device     | report §1              |
| `vitals_hourly`          | AggregatingMergeTree | hour × surface × variant × device × metric  | the rollback guardrail |
| `funnel_hourly`          | AggregatingMergeTree | hour × step × provider × device × holdout   | report §2              |
| `anomaly_profile_v`      | view                 | hour-of-week over the trailing 4 weeks      | report §7              |

**Why sessions come first.** The reward is session-scoped, not event-scoped: a sign-up
belongs to the whole experience the visitor was shown, not to the click that happened to
precede it. So events fold into sessions, and rewards aggregate from sessions.

**Why `surface_rewards_hourly` uses a refreshable MV.** Its source is `sessions`, whose
rows are only complete once the session ends. An insert-trigger MV would count a session
once per event. Refreshing every five minutes over a trailing two-hour window is
idempotent — the target's `SummingMergeTree` key absorbs a re-run — and keeps the
posteriors fresh enough for a bandit that adapts over hours.

**Why aggregate states rather than values.** `uniqState(anon_id)` and
`quantileTDigestState(0.75)(value)` merge, so "uniques this hour" and "uniques this week"
come from the same rows without double-counting a visitor who spanned two hours. Storing
values would make every window a separate table.

**Why 25 months.** The report compares each hour against the same hour last week;
anomaly detection needs a trailing four-week hour-of-week profile; year-over-year needs
thirteen-plus months. 25 gives a full year of year-over-year comparisons and then stops.

---

## 3. Postgres

### 3.1 Partitioning

Two tables grow without bound and are read almost exclusively by recent time range:
`adaptation_log` and `outbound_post`. Both are **RANGE partitioned by month**.

Monthly, not daily, because these see thousands of rows per month rather than millions
per day. Daily partitions would reach 700+ children in two years and the planner pays for
every child at plan time. Monthly keeps the count in the low dozens while still letting
retention `DETACH` a whole month rather than issue a `DELETE` that bloats the heap and
forces a `VACUUM FULL` nobody scheduled.

Partitions are created two months ahead by `morph_ensure_month_partitions`, so a missed
maintenance run is a warning rather than an outage. No `pg_partman`: one function and one
cron entry is less operational surface than an extension that must be version-matched to
the server on every upgrade.

### 3.2 Retention

| Table                  | Retention                     | Why                                                                                                          |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `adaptation_log`       | 25 months                     | Matches the ClickHouse aggregates: a decision must stay explainable as long as the metrics behind it exist   |
| `outbound_post`        | 25 months                     | Same, plus it is the evidence trail for platform compliance questions                                        |
| `crawl_document`       | 30 days                       | Raw fetched content is a cache; the extracted signal outlives it                                             |
| `auth_session`         | on expiry                     |                                                                                                              |
| `consent_record`       | 25 months after last activity |                                                                                                              |
| `data_subject_request` | indefinite                    | Holds no personal data; deleting the proof of deletion is how you fail an audit having done everything right |

Postgres holds no raw behavioural data, so the 90-day promise is a ClickHouse concern.
What Postgres does hold that is personal — a user row and its linked identities — is
deleted synchronously on erasure, with the ClickHouse rows following in the same job.

### 3.3 Constraints that encode product rules

The schema is where a rule goes when it must not be skippable by a future code path
written in a hurry:

```sql
-- Generated content cannot be published without sources and human review.
CHECK (status <> 'published' OR jsonb_array_length(sources) > 0)
CHECK (status <> 'published' OR generated_by IS NULL OR reviewed_at IS NOT NULL)

-- An outbound post reaches `approved` without a human ONLY under `auto` autonomy,
-- having passed the safety classifier, matching an approved template.
CHECK (status <> 'approved'
       OR approved_by IS NOT NULL
       OR (autonomy_at_creation = 'auto' AND safety_verdict = 'safe' AND template_id IS NOT NULL))

-- A consent record must have a subject: either a user or an anonymous hash.
CHECK (user_id IS NOT NULL OR anon_id_hash IS NOT NULL)

-- Denormalised counters must stay coherent.
CHECK (conversions <= impressions)
```

### 3.4 Least privilege

Four roles: `morph_migrator` (DDL), `morph_web` (read + session writes), `morph_api`
(insert/update), `morph_worker` (full DML). `ALTER DEFAULT PRIVILEGES` means a table
created by a future migration is automatically reachable by the runtime roles, without a
follow-up `GRANT` somebody forgets and only discovers in production.

`adaptation_log` is append-only **by permission**, not by convention: `morph_worker` has
`INSERT` and `SELECT` on it, and nothing else.

### 3.5 Extensions

`pgcrypto` for UUID generation, `vector` for the 768-dimensional trend embeddings,
`pg_trgm` for fuzzy title matching during deduplication, `btree_gin` for composite
indexes mixing scalars with `jsonb`, and `pg_stat_statements` because it is the only
honest way to find the query that is actually slow.

The embedding index is **HNSW over cosine distance**, not IVFFlat: the corpus turns over
daily, and IVFFlat's recall degrades without a retrain that nobody will schedule.
