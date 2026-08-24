-- =============================================================================
-- MORPH - PostgreSQL bootstrap
-- =============================================================================
-- This file runs once, on an empty data directory, before any migration.
-- It owns the three things Drizzle migrations deliberately do NOT own:
--
--   1. Extensions      - require superuser, must exist before any migration runs.
--   2. Roles           - least-privilege split per service; a security boundary,
--                        not an application concern.
--   3. Partition upkeep - declarative partitioning needs a maintenance function;
--                        Drizzle has no vocabulary for it.
--
-- The tables themselves live in `packages/core/src/db/schema.ts` and are applied by
-- `drizzle-kit migrate`. One source of truth per object, always.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
-- pgcrypto   - gen_random_uuid() for primary keys, and digest() for the
--              server-side hashing used by the erasure-request lookup.
-- vector     - embeddings for the trend pipeline (section 3). 768-dim vectors from an
--              open embedding model; HNSW index defined in the migration.
-- pg_trgm    - fuzzy matching on content titles during deduplication.
-- btree_gin  - composite indexes mixing a scalar with a jsonb/array column.
-- pg_stat_statements - the only honest way to find the query that is actually slow.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- -----------------------------------------------------------------------------
-- Roles - least privilege per service
-- -----------------------------------------------------------------------------
-- A compromised web process must not be able to rewrite the adaptation log, and a
-- compromised worker must not be able to drop a table. Passwords come from the
-- environment at provisioning time; the literals below exist only so a fresh local
-- stack boots without manual steps.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'morph_migrator') THEN
        CREATE ROLE morph_migrator LOGIN PASSWORD 'morph';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'morph_web') THEN
        CREATE ROLE morph_web LOGIN PASSWORD 'morph';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'morph_api') THEN
        CREATE ROLE morph_api LOGIN PASSWORD 'morph';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'morph_worker') THEN
        CREATE ROLE morph_worker LOGIN PASSWORD 'morph';
    END IF;
END
$$;

GRANT ALL ON SCHEMA public TO morph_migrator;

-- Default privileges so that every table a future migration creates is
-- automatically reachable by the runtime roles, without a follow-up GRANT that
-- somebody will forget and only discover in production.
ALTER DEFAULT PRIVILEGES FOR ROLE morph_migrator IN SCHEMA public
    GRANT SELECT ON TABLES TO morph_web, morph_api, morph_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE morph_migrator IN SCHEMA public
    GRANT INSERT, UPDATE, DELETE ON TABLES TO morph_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE morph_migrator IN SCHEMA public
    GRANT INSERT, UPDATE ON TABLES TO morph_api;
ALTER DEFAULT PRIVILEGES FOR ROLE morph_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO morph_api, morph_worker;

-- -----------------------------------------------------------------------------
-- Partition maintenance
-- -----------------------------------------------------------------------------
-- Two tables in Postgres grow without bound and are queried almost exclusively by
-- recent time range: `adaptation_log` (every promotion, retirement, quarantine and
-- generation) and `outbound_post` (the social queue's history). Both are RANGE
-- partitioned by month.
--
-- WHY MONTHLY AND NOT DAILY
-- Unlike ClickHouse's event stream, these tables see thousands of rows per month,
-- not millions per day. Daily partitions would produce 700+ partitions in two
-- years, and the planner pays for every one of them at plan time. Monthly keeps the
-- partition count in the low dozens while still letting the retention job DETACH a
-- whole month instead of issuing a DELETE that bloats the heap.
--
-- WHY NOT pg_partman
-- One function and one cron entry is less operational surface than an extension
-- that must be version-matched to the server on every upgrade. Revisit if a third
-- table needs partitioning.
CREATE OR REPLACE FUNCTION morph_ensure_month_partitions(
    parent regclass,
    months_ahead int DEFAULT 2
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    i             int;
    range_start   date;
    range_end     date;
    part_name     text;
BEGIN
    FOR i IN 0..months_ahead LOOP
        range_start := date_trunc('month', CURRENT_DATE) + (i || ' month')::interval;
        range_end   := range_start + interval '1 month';
        part_name   := format('%s_%s', parent::text, to_char(range_start, 'YYYYMM'));

        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                part_name, parent::text, range_start, range_end
            );
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION morph_ensure_month_partitions IS
    'Idempotent. Called by the worker''s daily maintenance job. Creating partitions '
    'two months ahead means a missed run is a warning, not an outage.';

-- -----------------------------------------------------------------------------
-- Retention
-- -----------------------------------------------------------------------------
-- Postgres holds no raw behavioural data, so the 90-day promise in docs/PRIVACY.md
-- does not apply here. What it does hold is the adaptation log, which is an audit
-- trail and is kept for 25 months to match the ClickHouse aggregates - the report
-- must be able to explain a decision as long as the metrics behind it still exist.
CREATE OR REPLACE FUNCTION morph_drop_partitions_older_than(
    parent regclass,
    keep_months int
) RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff    date := date_trunc('month', CURRENT_DATE) - (keep_months || ' month')::interval;
    part      record;
    dropped   int := 0;
BEGIN
    FOR part IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = parent
    LOOP
        -- Partition names carry their month suffix; compare on that rather than
        -- parsing pg_get_expr, which is fragile across major versions.
        IF right(part.relname, 6) ~ '^[0-9]{6}$'
           AND to_date(right(part.relname, 6), 'YYYYMM') < cutoff THEN
            EXECUTE format('DROP TABLE IF EXISTS %I', part.relname);
            dropped := dropped + 1;
        END IF;
    END LOOP;
    RETURN dropped;
END;
$$;
