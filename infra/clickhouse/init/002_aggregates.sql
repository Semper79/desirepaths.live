-- =============================================================================
-- MORPH - ClickHouse schema, part 2: aggregates the engine and the report read
-- =============================================================================
-- A NOTE ON THE MOST IMPORTANT DESIGN DECISION IN THIS FILE
--
-- The composite reward is
--     0.40*signup + 0.25*engagement + 0.20*scroll_norm + 0.10*return + 0.05*share
--     - bounce_penalty
-- and its weights are operator-configurable and hot-reloadable (section 2.2).
--
-- Therefore ClickHouse must NOT store the reward. It stores the *sufficient
-- statistics* - the individual components - and `packages/adaptive` combines them
-- with whatever weights are live at decision time. Baking the weights into a
-- materialised view would mean every weight change silently invalidates months of
-- history, or forces a backfill nobody will remember to run.
--
-- RETENTION
-- Raw events live 90 days (part 1). These aggregates live 25 months, because the
-- report compares each hour against the same hour last week, anomaly detection
-- needs a trailing 4-week hour-of-week profile, and year-over-year needs 13+
-- months. 25 gives a full year of year-over-year comparisons.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sessions - one row per session, folded from its events
-- -----------------------------------------------------------------------------
-- The reward is session-scoped, not event-scoped: a sign-up belongs to the whole
-- experience the visitor was shown, not to the click that happened to precede it.
-- So we fold events into sessions first and aggregate rewards from sessions.
--
-- AggregatingMergeTree with -State columns means the fold is incremental: each
-- arriving event merges into the existing partial state without a read-modify-write.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.sessions
(
    `session_date`      Date,
    `session_id`        UUID,
    `anon_id`           AggregateFunction(any, FixedString(16)),
    `started_at`        AggregateFunction(min, DateTime64(3, 'UTC')),
    `ended_at`          AggregateFunction(max, DateTime64(3, 'UTC')),
    `pageviews`         AggregateFunction(sum, UInt32),
    `max_scroll_pct`    AggregateFunction(max, Float32),
    `engaged_ms`        AggregateFunction(sum, UInt32),
    `signed_up`         AggregateFunction(max, UInt8),
    `shared`            AggregateFunction(max, UInt8),
    `is_returning`      AggregateFunction(any, UInt8),
    `is_holdout`        AggregateFunction(any, UInt8),
    `device_class`      AggregateFunction(any, LowCardinality(String)),
    `viewport_bucket`   AggregateFunction(any, LowCardinality(String)),
    `referrer_class`    AggregateFunction(any, LowCardinality(String)),
    `traffic_source`    AggregateFunction(any, LowCardinality(String)),
    `country`           AggregateFunction(any, LowCardinality(FixedString(2))),
    `hour_of_week`      AggregateFunction(any, UInt8),
    `consent_mask`      AggregateFunction(max, UInt8),
    `surfaces`          AggregateFunction(any, Array(LowCardinality(String))),
    `variants`          AggregateFunction(any, Array(LowCardinality(String))),
    `assignment_hash`   AggregateFunction(any, UInt64),
    `bot_score`         AggregateFunction(max, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(session_date)
ORDER BY (session_date, session_id)
TTL toDateTime(session_date) + INTERVAL 25 MONTH DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_sessions TO morph.sessions AS
SELECT
    toDate(ts)                                                          AS session_date,
    session_id,
    anyState(anon_id)                                                   AS anon_id,
    minState(ts)                                                        AS started_at,
    maxState(ts)                                                        AS ended_at,
    sumState(toUInt32(event_type = 'page_view'))                        AS pageviews,
    maxState(if(event_type = 'scroll_depth', toFloat32(value), toFloat32(0))) AS max_scroll_pct,
    sumState(if(event_type = 'engagement', toUInt32(value), toUInt32(0)))     AS engaged_ms,
    maxState(toUInt8(event_type = 'signup_complete'))                   AS signed_up,
    maxState(toUInt8(event_type = 'share'))                             AS shared,
    anyState(is_returning)                                              AS is_returning,
    anyState(is_holdout)                                                AS is_holdout,
    anyState(device_class)                                              AS device_class,
    anyState(viewport_bucket)                                           AS viewport_bucket,
    anyState(referrer_class)                                            AS referrer_class,
    anyState(traffic_source)                                            AS traffic_source,
    anyState(country)                                                   AS country,
    anyState(hour_of_week)                                              AS hour_of_week,
    maxState(consent_mask)                                              AS consent_mask,
    anyState(surfaces)                                                  AS surfaces,
    anyState(variants)                                                  AS variants,
    anyState(assignment_hash)                                           AS assignment_hash,
    maxState(bot_score)                                                 AS bot_score
FROM morph.events
GROUP BY session_date, session_id;

-- Convenience view so report queries never have to remember the -Merge suffixes.
CREATE VIEW IF NOT EXISTS morph.sessions_v AS
SELECT
    session_date,
    session_id,
    anyMerge(anon_id)               AS anon_id,
    minMerge(started_at)            AS started_at,
    maxMerge(ended_at)              AS ended_at,
    sumMerge(pageviews)             AS pageviews,
    maxMerge(max_scroll_pct)        AS max_scroll_pct,
    sumMerge(engaged_ms)            AS engaged_ms,
    maxMerge(signed_up)             AS signed_up,
    maxMerge(shared)                AS shared,
    anyMerge(is_returning)          AS is_returning,
    anyMerge(is_holdout)            AS is_holdout,
    anyMerge(device_class)          AS device_class,
    anyMerge(viewport_bucket)       AS viewport_bucket,
    anyMerge(referrer_class)        AS referrer_class,
    anyMerge(traffic_source)        AS traffic_source,
    anyMerge(country)               AS country,
    anyMerge(hour_of_week)          AS hour_of_week,
    maxMerge(consent_mask)          AS consent_mask,
    anyMerge(surfaces)              AS surfaces,
    anyMerge(variants)              AS variants,
    anyMerge(assignment_hash)       AS assignment_hash,
    maxMerge(bot_score)             AS bot_score
FROM morph.sessions
GROUP BY session_date, session_id;

-- -----------------------------------------------------------------------------
-- surface_rewards_hourly - the bandit's food
-- -----------------------------------------------------------------------------
-- One row per (hour, surface, variant, context bucket, holdout flag), holding the
-- reward COMPONENTS. `packages/adaptive` reads this, applies the live weights, and
-- updates the Beta posteriors and the LinUCB design matrices.
--
-- The context bucket is a coarse discretisation of the covariate vector. It exists
-- so Thompson sampling has enough data per cell to be meaningful; the full,
-- un-bucketed covariate vector goes to LinUCB, which does not need discretisation.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.surface_rewards_hourly
(
    `hour_start`        DateTime,
    `surface`           LowCardinality(String),
    `variant`           LowCardinality(String),
    `context_bucket`    LowCardinality(String),
    `is_holdout`        UInt8,

    `impressions`       UInt64,
    `signups`           UInt64,
    `engaged_sessions`  UInt64,   -- engaged_ms >= 15000 OR pageviews >= 2
    `scroll_norm_sum`   Float64,  -- sum of clamp(max_scroll_pct / 100, 0, 1)
    `returns`           UInt64,
    `shares`            UInt64,
    `bounces`           UInt64    -- single pageview AND engaged_ms < 5000
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour_start)
ORDER BY (hour_start, surface, variant, context_bucket, is_holdout)
TTL hour_start + INTERVAL 25 MONTH DELETE;

-- Refreshable MV rather than an insert-trigger MV: the source is `sessions`, whose
-- rows are only complete once the session ends, so a trigger would count a session
-- once per event. Refreshing every 5 minutes over a 2-hour trailing window keeps
-- the posteriors fresh enough for a bandit while being idempotent (the target's
-- SummingMergeTree key means a re-run of the same window is absorbed by REPLACE).
--
-- Requires: SET allow_experimental_refreshable_materialized_view = 1 (24.x).
CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_surface_rewards_hourly
REFRESH EVERY 5 MINUTE APPEND
TO morph.surface_rewards_hourly AS
SELECT
    toStartOfHour(started_at)                                       AS hour_start,
    surface,
    variant,
    concat(device_class, '|', referrer_class, '|', toString(intDiv(hour_of_week, 24))) AS context_bucket,
    is_holdout,
    count()                                                         AS impressions,
    sum(signed_up)                                                  AS signups,
    sum(engaged_ms >= 15000 OR pageviews >= 2)                      AS engaged_sessions,
    sum(least(greatest(max_scroll_pct / 100, 0), 1))                AS scroll_norm_sum,
    sum(is_returning)                                               AS returns,
    sum(shared)                                                     AS shares,
    sum(pageviews <= 1 AND engaged_ms < 5000)                       AS bounces
FROM morph.sessions_v
ARRAY JOIN surfaces AS surface, variants AS variant
WHERE started_at >= now() - INTERVAL 2 HOUR
  -- Automated traffic must never move a posterior. 60 is the threshold at which
  -- the heuristic scorer is confident enough to exclude without losing real users.
  AND bot_score < 60
GROUP BY hour_start, surface, variant, context_bucket, is_holdout;

-- -----------------------------------------------------------------------------
-- traffic_hourly - section 5.2 of the report
-- -----------------------------------------------------------------------------
-- uniqState over anon_id rather than a plain count: HyperLogLog states merge, so
-- "uniques this hour" and "uniques this week" come from the same rows without
-- double counting a visitor who spanned two hours.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.traffic_hourly
(
    `hour_start`        DateTime,
    `page_path`         LowCardinality(String),
    `traffic_source`    LowCardinality(String),
    `referrer_class`    LowCardinality(String),
    `country`           LowCardinality(FixedString(2)),
    `device_class`      LowCardinality(String),
    `is_returning`      UInt8,
    `pageviews`         AggregateFunction(sum, UInt64),
    `uniques`           AggregateFunction(uniq, FixedString(16)),
    `sessions`          AggregateFunction(uniq, UUID)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour_start)
ORDER BY (hour_start, page_path, traffic_source, referrer_class, country, device_class, is_returning)
TTL hour_start + INTERVAL 25 MONTH DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_traffic_hourly TO morph.traffic_hourly AS
SELECT
    toStartOfHour(ts)                       AS hour_start,
    page_path,
    traffic_source,
    referrer_class,
    country,
    device_class,
    is_returning,
    sumState(toUInt64(event_type = 'page_view')) AS pageviews,
    uniqState(anon_id)                      AS uniques,
    uniqState(session_id)                   AS sessions
FROM morph.events
WHERE bot_score < 60
GROUP BY hour_start, page_path, traffic_source, referrer_class, country, device_class, is_returning;

-- -----------------------------------------------------------------------------
-- vitals_hourly - feeds the automatic rollback guardrail (section 2.2)
-- -----------------------------------------------------------------------------
-- Quantile STATES, not values: the guardrail asks "is p75 LCP for variant X worse
-- than the champion by more than the threshold", and that comparison must be
-- computable across arbitrary time windows without re-scanning raw events.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.vitals_hourly
(
    `hour_start`    DateTime,
    `surface`       LowCardinality(String),
    `variant`       LowCardinality(String),
    `device_class`  LowCardinality(String),
    `metric`        LowCardinality(String),   -- lcp | cls | inp | ttfb
    `samples`       AggregateFunction(count),
    `p75`           AggregateFunction(quantileTDigest(0.75), Float64),
    `p95`           AggregateFunction(quantileTDigest(0.95), Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour_start)
ORDER BY (hour_start, surface, variant, device_class, metric)
TTL hour_start + INTERVAL 25 MONTH DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_vitals_hourly TO morph.vitals_hourly AS
SELECT
    toStartOfHour(ts)                   AS hour_start,
    surface,
    variant,
    device_class,
    props['metric']                     AS metric,
    countState()                        AS samples,
    quantileTDigestState(0.75)(value)   AS p75,
    quantileTDigestState(0.95)(value)   AS p95
FROM morph.events
ARRAY JOIN surfaces AS surface, variants AS variant
WHERE event_type = 'web_vital' AND bot_score < 60
GROUP BY hour_start, surface, variant, device_class, metric;

-- -----------------------------------------------------------------------------
-- funnel_hourly - section 5.3 of the report
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS morph.funnel_hourly
(
    `hour_start`    DateTime,
    `step`          LowCardinality(String),  -- land | signup_view | signup_start | signup_complete | activated
    `provider`      LowCardinality(String),  -- '' for non-provider steps
    `device_class`  LowCardinality(String),
    `is_holdout`    UInt8,
    `sessions`      AggregateFunction(uniq, UUID)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour_start)
ORDER BY (hour_start, step, provider, device_class, is_holdout)
TTL hour_start + INTERVAL 25 MONTH DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_funnel_hourly TO morph.funnel_hourly AS
SELECT
    toStartOfHour(ts)       AS hour_start,
    event_type              AS step,
    props['provider']       AS provider,
    device_class,
    is_holdout,
    uniqState(session_id)   AS sessions
FROM morph.events
WHERE event_type IN ('land', 'signup_view', 'signup_start', 'signup_complete', 'activated')
  AND bot_score < 60
GROUP BY hour_start, step, provider, device_class, is_holdout;

-- -----------------------------------------------------------------------------
-- anomaly_profile - trailing hour-of-week baseline for the z-score alert
-- -----------------------------------------------------------------------------
-- Comparing this hour to last hour is meaningless on a site with daily and weekly
-- seasonality: 03:00 is always quiet and Sunday is not Tuesday. The alert compares
-- against the same hour-of-week over the trailing 4 weeks, which is what this holds.
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS morph.anomaly_profile_v AS
SELECT
    toHour(hour_start) + 24 * toDayOfWeek(hour_start)   AS hour_of_week,
    avg(pv)                                             AS mean_pageviews,
    stddevPop(pv)                                       AS sd_pageviews,
    count()                                             AS weeks_observed
FROM (
    SELECT hour_start, sumMerge(pageviews) AS pv
    FROM morph.traffic_hourly
    WHERE hour_start >= now() - INTERVAL 28 DAY AND hour_start < toStartOfHour(now())
    GROUP BY hour_start
)
GROUP BY hour_of_week;

-- -----------------------------------------------------------------------------
-- Data-subject erasure support (GDPR Art. 17)
-- -----------------------------------------------------------------------------
-- ClickHouse cannot do a cheap point delete, so erasure is implemented as a
-- lightweight delete against a bounded partition set, driven from Postgres's
-- `erasure_request` table by a worker job. The index below is what makes that
-- delete touch a handful of granules instead of the whole partition.
--
-- Because anon_id rotates daily, an erasure request can only reach the last 90
-- days of raw events - which is exactly the raw retention window, and exactly what
-- docs/PRIVACY.md promises. Aggregates contain no identifier and are out of scope.
-- -----------------------------------------------------------------------------
ALTER TABLE morph.events ADD INDEX IF NOT EXISTS idx_user user_id TYPE bloom_filter(0.01) GRANULARITY 4;
