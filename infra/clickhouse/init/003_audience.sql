-- -----------------------------------------------------------------------------
-- content_engagement_daily - what readers actually engage with, per page
-- -----------------------------------------------------------------------------
-- Feeds the audience interest vector (section 3.4): the trend scorer's
-- `audienceFit` term is the cosine similarity between a candidate topic and the
-- centroid of the pages readers engage with most. Without this table that term has
-- no input, the worker drops it, and topics are scored on three signals instead of
-- four - which is what it does today and says so in its log.
--
-- WHY THE SAME COMPONENTS AS surface_rewards_hourly
-- The column names here are `RewardComponents` from packages/adaptive, deliberately.
-- The worker runs the *same* `compositeReward` with the *same* live weights over
-- these rows, so "a page readers engage with" means exactly what "a variant that
-- performs" means. Two definitions of good in one system is how an optimiser ends up
-- pulling against its own content pipeline.
--
-- WHY page_path AND NOT content_id
-- `events.content_id` exists in the contract and the collector forwards it, but the
-- site does not emit it yet, so an aggregate keyed on it would be empty. The path is
-- what the beacon actually sends, and `/t/{slug}` maps to `content.slug`, which is
-- unique. When pages start carrying their content id, this key stays correct.
--
-- WHY A PAGE-SESSION IS THE UNIT
-- The denominator has to be "someone looked at this page", not "an event happened".
-- Counting events would rank a page by how many scroll ticks it emitted, which is a
-- function of its length. Counting page-sessions makes every row below a rate per
-- reader, which is what a preference is.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS morph.content_engagement_daily
(
    `day`               Date,
    `page_path`         LowCardinality(String),

    -- Page-sessions: distinct (session, page) pairs. The denominator for the rest.
    `impressions`       UInt64,
    `signups`           UInt64,
    `engaged_sessions`  UInt64,   -- >= 15s engaged time on this page
    `scroll_norm_sum`   Float64,  -- sum of clamp(max_scroll_pct / 100, 0, 1)
    `returns`           UInt64,
    `shares`            UInt64,
    `bounces`           UInt64,   -- one pageview in the session AND under 5s here

    -- Refresh generation. See the ReplacingMergeTree note below.
    `version`           DateTime
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (day, page_path)
TTL day + INTERVAL 25 MONTH DELETE;

-- -----------------------------------------------------------------------------
-- ReplacingMergeTree, not SummingMergeTree, and this is the whole reason:
--
-- The refresh below recomputes a trailing window every hour, so the same (day,
-- page_path) is written repeatedly. Under SummingMergeTree those writes would ADD,
-- and a page's engagement would climb every hour whether or not anybody visited it -
-- a metric that only ever goes up, feeding a scorer that is supposed to detect
-- preference. ReplacingMergeTree keeps the highest `version` per key instead, so a
-- re-run of a window is idempotent by construction.
--
-- Readers must use FINAL (or argMax by version). The table is one row per path per
-- day, so FINAL is cheap here in a way it would not be on `events`.
--
-- The nested SELECT is required: the outer aggregate counts page-SESSIONS, so the
-- inner one has to collapse events to one row per (page, session) first. That is
-- also why this cannot be an insert-trigger MV - a trigger sees one block at a time
-- and would count a session once per block it happened to be split across.
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS morph.mv_content_engagement_daily
REFRESH EVERY 1 HOUR APPEND
TO morph.content_engagement_daily AS
SELECT
    day,
    page_path,
    count()                                             AS impressions,
    sum(signed_up)                                      AS signups,
    sum(engaged_ms >= 15000)                            AS engaged_sessions,
    sum(scroll_norm)                                    AS scroll_norm_sum,
    sum(is_returning)                                   AS returns,
    sum(shared)                                         AS shares,
    sum(session_pageviews <= 1 AND engaged_ms < 5000)   AS bounces,
    now()                                               AS version
FROM
(
    SELECT
        toDate(ts)                                                              AS day,
        page_path,
        session_id,
        -- Max, not sum: a scroll_depth event fires repeatedly as the reader
        -- descends, and summing them would reward a long page for being long.
        maxIf(least(greatest(value / 100, 0), 1), event_type = 'scroll_depth')   AS scroll_norm,
        sumIf(toUInt64(greatest(value, 0)), event_type = 'engagement')           AS engaged_ms,
        maxIf(toUInt8(1), event_type = 'share')                                  AS shared,
        maxIf(toUInt8(1), event_type = 'signup_complete')                        AS signed_up,
        any(is_returning)                                                        AS is_returning,
        any(session_depth)                                                       AS session_pageviews
    FROM morph.events
    -- Automated traffic must never shape what the site writes about next. Same
    -- threshold as everywhere else: 60 is where the heuristic scorer is confident
    -- enough to exclude without losing real readers.
    WHERE bot_score < 60
      -- A trailing window rather than the whole table: yesterday's rows are settled,
      -- and rewriting three days an hour keeps late-arriving events correct without
      -- rescanning a quarter.
      AND ts >= now() - INTERVAL 3 DAY
      -- Only pages that could plausibly be content. The home page and the privacy
      -- policy are engaged with for reasons that say nothing about topic interest.
      AND startsWith(page_path, '/t/')
    GROUP BY day, page_path, session_id
)
GROUP BY day, page_path;

-- -----------------------------------------------------------------------------
-- The read the worker actually issues, kept here rather than in TypeScript so the
-- FINAL and the window are visible next to the table they depend on.
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS morph.content_engagement_30d_v AS
SELECT
    page_path,
    sum(impressions)      AS impressions,
    sum(signups)          AS signups,
    sum(engaged_sessions) AS engaged_sessions,
    sum(scroll_norm_sum)  AS scroll_norm_sum,
    sum(returns)          AS returns,
    sum(shares)           AS shares,
    sum(bounces)          AS bounces
FROM morph.content_engagement_daily FINAL
WHERE day >= today() - 30
GROUP BY page_path;
