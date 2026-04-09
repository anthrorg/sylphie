-- Create the events table used by DecisionEventLoggerService and
-- DriveProcessManagerService for the TimescaleDB event backbone.
--
-- Columns match the parameterised INSERT in
-- packages/decision-making/src/logging/decision-event-logger.service.ts

CREATE TABLE IF NOT EXISTS events (
    id              UUID        NOT NULL,
    type            TEXT        NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL,
    subsystem       TEXT        NOT NULL,
    session_id      TEXT        NOT NULL,
    drive_snapshot  JSONB,
    payload         JSONB,
    correlation_id  TEXT,
    schema_version  INTEGER     NOT NULL DEFAULT 1
);

-- Convert to TimescaleDB hypertable, partitioned by timestamp.
-- chunk_time_interval of 1 hour keeps chunk size manageable during
-- active development; can be widened in production.
SELECT create_hypertable(
    'events',
    'timestamp',
    chunk_time_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- Index for querying events by type within a session.
CREATE INDEX IF NOT EXISTS idx_events_session_type
    ON events (session_id, type, timestamp DESC);

-- Index for correlation chain lookups.
CREATE INDEX IF NOT EXISTS idx_events_correlation
    ON events (correlation_id, timestamp DESC)
    WHERE correlation_id IS NOT NULL;
