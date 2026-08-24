-- =============================================================================
-- MORPH - ClickHouse schema, part 1: raw event store
-- =============================================================================
-- Design target: 5M+ events/day sustained, bursting to ~5k inserts/s, with the
-- adaptive aggregation query returning in well under a second so the engine can
-- refresh posteriors on a tight loop.
--
-- WHY CLICKHOUSE AND NOT POSTGRES
-- At 5M events/day a year of raw behaviour is ~1.8B rows. Postgres can store that
-- but cannot scan it at interactive speed without a purpose-built rollup pipeline
-- that would end up being a worse ClickHouse. The bandit needs GROUP BY over
-- (surface, variant, context bucket) across arbitrary time windows; that is a
-- columnar OLAP workload, and mixing it into the OLTP box would put analytical
-- scans in contention with the transactions that serve page loads.
--
-- WHAT LIVES WHERE
--   Postgres   - identity, content, config, variant definitions, adaptation log.
--                Anything that must be transactional or foreign-keyed.
--   ClickHouse - behaviour. Append-only, never updated, aggregated relentlessly.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS morph;

-- -----------------------------------------------------------------------------
-- events - the single raw fact table
-- -----------------------------------------------------------------------------
-- PARTITIONING
--   toDate(ts): one part per day. At 5M rows/day each partition is a few hundred
--   MB compressed - large enough that merges stay cheap, small enough that the
--   90-day TTL drops whole partitions instead of rewriting them. Monthly
--   partitions would make the retention delete a rewrite; hourly partitions would
--   produce 2,160 active partitions and murder the merge scheduler. Daily is the
--   only sane choice at this volume.
--
-- SORTING KEY
--   (event_type, ts, anon_id)
--   Every hot query filters on a time range first (the partition prunes that) and
--   then on an event type - "signups in the last hour", "impressions since the
--   posterior was last refreshed". Putting the low-cardinality event_type first
--   gives ClickHouse a tight granule range to read; ts second keeps the read
--   sequential; anon_id last makes the per-visitor dedup scan local.
--
--   PRIMARY KEY is deliberately a shorter prefix than ORDER BY: the sparse index
--   stays in memory and the extra key column still contributes to compression.
--
-- IDENTITY
--   anon_id is a truncated sha256 of (pepper + daily_salt + ip + user_agent),
--   computed in the edge process. The raw IP is never written here, never logged,
--   and the daily salt rotation makes cross-day re-identification infeasible.
--   See docs/PRIVACY.md.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.events
(
    -- --- time -----------------------------------------------------------------
    `ts`                DateTime64(3, 'UTC')    CODEC(DoubleDelta, ZSTD(1)),
    `ingested_at`       DateTime64(3, 'UTC')    CODEC(DoubleDelta, ZSTD(1)),
    `event_date`        Date MATERIALIZED toDate(ts),
    `hour_start`        DateTime MATERIALIZED toStartOfHour(ts),

    -- --- what happened --------------------------------------------------------
    `event_id`          UUID,
    `event_type`        LowCardinality(String),
    `event_version`     UInt8                   DEFAULT 1,

    -- --- who (pseudonymous) ---------------------------------------------------
    `anon_id`           FixedString(16)         CODEC(ZSTD(3)),
    `session_id`        UUID,
    `user_id`           Nullable(UUID),
    -- Bitmask of granted consent categories: 1 necessary, 2 analytics,
    -- 4 personalisation, 8 marketing. Stored so a later erasure request or a
    -- consent-scope audit can be answered from the data itself.
    `consent_mask`      UInt8                   DEFAULT 1,

    -- --- context features (the bandit's covariates) ---------------------------
    `device_class`      LowCardinality(String),      -- phone | tablet | desktop | tv | bot
    `viewport_bucket`   LowCardinality(String),      -- xs | sm | md | lg | xl
    `referrer_class`    LowCardinality(String),      -- direct | search | social | referral | internal | ai_agent
    `traffic_source`    LowCardinality(String),      -- normalised utm_source / referrer host
    `country`           LowCardinality(FixedString(2)),
    `hour_of_week`      UInt8,                       -- 0..167, local to MORPH_TIMEZONE
    `session_depth`     UInt16,
    `is_returning`      UInt8,
    `locale`            LowCardinality(String),

    -- --- where ----------------------------------------------------------------
    `page_path`         LowCardinality(String),
    `content_id`        Nullable(UUID),

    -- --- what the visitor was shown -------------------------------------------
    -- Parallel arrays rather than a Map: ARRAY JOIN over two aligned arrays is the
    -- fastest way to explode an assignment vector into one row per surface, which
    -- is exactly what the reward aggregation needs. A Map would force a
    -- mapKeys/mapValues pair with worse codegen and no LowCardinality dictionary.
    `surfaces`          Array(LowCardinality(String)),
    `variants`          Array(LowCardinality(String)),
    -- Stable hash of the whole assignment vector. Lets us ask "how did THIS exact
    -- combination perform" without exploding the arrays.
    `assignment_hash`   UInt64,
    -- 1 = this visitor is in the pinned baseline cohort (section 2.2 holdout).
    `is_holdout`        UInt8                   DEFAULT 0,

    -- --- payload --------------------------------------------------------------
    -- One generic numeric slot covers the overwhelming majority of events
    -- (scroll depth %, dwell ms, LCP ms, CLS x1000, engagement score). Typed
    -- columns for the rest would be a wide sparse table; a Map holds the tail.
    `value`             Float64                 DEFAULT 0,
    `props`             Map(LowCardinality(String), String),

    -- --- hygiene --------------------------------------------------------------
    `bot_score`         UInt8                   DEFAULT 0,   -- 0..100, 100 = certainly automated
    `ingest_lag_ms`     Int32 MATERIALIZED toInt32(dateDiff('millisecond', ts, ingested_at))
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
PRIMARY KEY (event_type, ts)
ORDER BY (event_type, ts, anon_id)
-- Raw behaviour is deleted after 90 days; the materialised aggregates below keep
-- the analytical history. This is the retention promise in docs/PRIVACY.md and it
-- is enforced by the storage engine rather than by a cron job somebody can forget.
TTL toDateTime(event_date) + INTERVAL 90 DAY DELETE
SETTINGS
    index_granularity = 8192,
    -- Sub-second visibility of newly inserted rows without paying for a merge.
    min_bytes_for_wide_part = 10485760,
    ttl_only_drop_parts = 1;

-- Skip indexes. These are cheap to maintain and turn three common report queries
-- from full-partition scans into granule lookups.
ALTER TABLE morph.events ADD INDEX IF NOT EXISTS idx_session   session_id      TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE morph.events ADD INDEX IF NOT EXISTS idx_anon      anon_id         TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE morph.events ADD INDEX IF NOT EXISTS idx_variants  variants        TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE morph.events ADD INDEX IF NOT EXISTS idx_country   country         TYPE set(64)            GRANULARITY 4;

-- -----------------------------------------------------------------------------
-- Kafka ingest path
-- -----------------------------------------------------------------------------
-- ClickHouse consumes Redpanda directly. This is deliberate: a hand-written
-- consumer would have to reimplement offset management, batching and back-pressure,
-- and would do it worse. The edge collector has already done the enrichment that
-- needs request context (IP hashing, geo, bot scoring, consent), so nothing
-- downstream of the buffer needs application logic.
--
-- If enrichment ever needs to happen after the buffer, drop this pair and point
-- apps/worker's consumer at the same topic - the events table is unchanged either way.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.events_queue
(
    `payload` String
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'redpanda:9092',
    kafka_topic_list = 'morph.events.v1',
    kafka_group_name = 'clickhouse-events-v1',
    kafka_format = 'JSONAsString',
    -- 4 consumers x 2 threads keeps up with 5k/s with headroom; raise with partitions.
    kafka_num_consumers = 4,
    kafka_thread_per_consumer = 1,
    kafka_max_block_size = 65536,
    kafka_poll_max_batch_size = 65536,
    -- A malformed row must never stall the pipeline. Bad rows are counted in
    -- system.kafka_consumers and surfaced as an alert, not silently ignored.
    kafka_handle_error_mode = 'stream',
    kafka_skip_broken_messages = 100;

CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_events_from_queue TO morph.events AS
SELECT
    parseDateTime64BestEffortOrZero(JSONExtractString(payload, 'ts'), 3, 'UTC')        AS ts,
    now64(3, 'UTC')                                                                     AS ingested_at,
    toUUIDOrZero(JSONExtractString(payload, 'eventId'))                                 AS event_id,
    JSONExtractString(payload, 'type')                                                  AS event_type,
    toUInt8OrZero(JSONExtractString(payload, 'v'))                                      AS event_version,
    reinterpretAsFixedString(unhex(JSONExtractString(payload, 'anonId')))               AS anon_id,
    toUUIDOrZero(JSONExtractString(payload, 'sessionId'))                               AS session_id,
    if(JSONHas(payload, 'userId'), toUUIDOrZero(JSONExtractString(payload, 'userId')), NULL) AS user_id,
    toUInt8OrZero(JSONExtractString(payload, 'consentMask'))                            AS consent_mask,
    JSONExtractString(payload, 'ctx', 'device')                                         AS device_class,
    JSONExtractString(payload, 'ctx', 'viewport')                                       AS viewport_bucket,
    JSONExtractString(payload, 'ctx', 'referrerClass')                                  AS referrer_class,
    JSONExtractString(payload, 'ctx', 'source')                                         AS traffic_source,
    toFixedString(JSONExtractString(payload, 'ctx', 'country'), 2)                      AS country,
    toUInt8OrZero(JSONExtractString(payload, 'ctx', 'hourOfWeek'))                      AS hour_of_week,
    toUInt16OrZero(JSONExtractString(payload, 'ctx', 'depth'))                          AS session_depth,
    toUInt8OrZero(JSONExtractString(payload, 'ctx', 'returning'))                       AS is_returning,
    JSONExtractString(payload, 'ctx', 'locale')                                         AS locale,
    JSONExtractString(payload, 'path')                                                  AS page_path,
    if(JSONHas(payload, 'contentId'), toUUIDOrZero(JSONExtractString(payload, 'contentId')), NULL) AS content_id,
    JSONExtractArrayRaw(payload, 'surfaces')                                            AS surfaces_raw,
    arrayMap(x -> JSONExtractString(x), surfaces_raw)                                   AS surfaces,
    arrayMap(x -> JSONExtractString(x), JSONExtractArrayRaw(payload, 'variants'))       AS variants,
    toUInt64OrZero(JSONExtractString(payload, 'assignmentHash'))                        AS assignment_hash,
    toUInt8OrZero(JSONExtractString(payload, 'holdout'))                                AS is_holdout,
    JSONExtractFloat(payload, 'value')                                                  AS value,
    CAST(JSONExtractKeysAndValues(payload, 'props', 'String'), 'Map(LowCardinality(String), String)') AS props,
    toUInt8OrZero(JSONExtractString(payload, 'botScore'))                               AS bot_score
FROM morph.events_queue
WHERE length(_error) = 0;

-- Broken messages are parked, not dropped, so an ingest schema regression is
-- visible in the hourly report instead of becoming a silent hole in the data.
CREATE TABLE IF NOT EXISTS morph.events_dlq
(
    `ingested_at` DateTime64(3, 'UTC') DEFAULT now64(3),
    `raw`         String,
    `error`       String
)
ENGINE = MergeTree
PARTITION BY toDate(ingested_at)
ORDER BY ingested_at
TTL toDateTime(toDate(ingested_at)) + INTERVAL 14 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_events_dlq TO morph.events_dlq AS
SELECT now64(3, 'UTC') AS ingested_at, _raw_message AS raw, _error AS error
FROM morph.events_queue
WHERE length(_error) > 0;
