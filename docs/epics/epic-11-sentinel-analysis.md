# Epic 11: Frontend Port & Media Integration -- Sentinel Infrastructure Analysis

**Status:** Planning
**Epic Scope:** Observatory Dashboard backend endpoints, session tracking, skills storage
**Analysis Date:** 2026-03-30
**Analyst:** Sentinel (Data Persistence & Infrastructure Engineer)
**Focus:** Query design per endpoint, schema additions, data volume, migration strategy

---

## 1. Preliminary: What the Existing Schema Actually Contains

Before designing anything, the actual state of the databases must be the starting point.

### 1.1 TimescaleDB Events Table (as implemented)

```sql
CREATE TABLE events (
  event_id        UUID        NOT NULL DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL,            -- hypertable partition key
  event_type      TEXT        NOT NULL,
  subsystem_source TEXT       NOT NULL,
  correlation_id  UUID,
  actor_id        TEXT        DEFAULT 'sylphie',
  drive_snapshot  JSONB,                           -- DriveSnapshot at event time
  tick_number     BIGINT,
  event_data      JSONB       NOT NULL,            -- subsystem-specific payload
  has_learnable   BOOLEAN     DEFAULT false,
  processed       BOOLEAN     DEFAULT false,
  schema_version  INTEGER     DEFAULT 1,
  PRIMARY KEY (event_id, timestamp)
);
```

Indexes: `event_type`, `subsystem_source`, `has_learnable` (partial), `correlation_id` (partial), `(timestamp, event_type)` composite.

Compression: 7-day threshold. Retention: 90-day default.

### 1.2 PostgreSQL System Database (as implemented)

Tables: `drive_rules`, `proposed_drive_rules`, `users`, `settings`, `sessions`.

The `sessions` table is already present:
```sql
CREATE TABLE sessions (
  id         TEXT        PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at   TIMESTAMPTZ,
  user_id    INTEGER     REFERENCES users(id),
  summary    TEXT
);
```

`sylphie_app` has `SELECT, INSERT, UPDATE` on `sessions`. Session tracking infrastructure exists; it has never been populated.

### 1.3 Neo4j WKG (as implemented)

Node labels: `Entity`, `Concept`, `Procedure`, `Utterance`, `SchemaType`, `SchemaRelType`, `MetaRule`.

Every node carries: `id`, `label`, `type`, `provenance`, `confidence`, `created_at`, plus label-specific properties. Indexes exist on `provenance`, `confidence`, `created_at` for each of the four data-bearing labels (`Entity`, `Concept`, `Procedure`, `Utterance`).

### 1.4 Established Metric Types

`src/shared/types/metrics.types.ts` already defines all seven CANON health metrics as TypeScript interfaces. This is the contract the Observatory endpoints must satisfy. The seven metrics are:

1. `Type1Type2Ratio` — type1Count, type2Count, ratio, windowSize
2. `PredictionMAEMetric` — mae, sampleCount, windowSize
3. `ProvenanceRatio` — sensor, guardian, llmGenerated, inference, total, experientialRatio
4. `BehavioralDiversityIndex` — uniqueActionTypes, windowSize, index
5. `GuardianResponseRate` — initiated, responded, rate
6. `InteroceptiveAccuracy` — selfReported, actual, accuracy
7. `MeanDriveResolutionTime` — drive, meanMs, sampleCount

The Observatory endpoints are NOT a new concept — they are the HTTP serialization of this already-defined type system.

---

## 2. Observatory Endpoint Query Designs

Each of the seven Observatory endpoints is mapped to its database source(s), the specific query, required indexes, and whether TimescaleDB continuous aggregates help.

---

### 2.1 Vocabulary Growth (Nodes Over Time)

**What the frontend wants:** A time-series of how many WKG nodes existed at successive points. Shows the graph growing as Sylphie learns.

**Database:** Neo4j (primary). This is a WKG query.

**Query pattern:**

```cypher
// Node count by creation date bucket (daily granularity)
MATCH (n)
WHERE n.created_at IS NOT NULL
  AND labels(n)[0] IN ['Entity', 'Concept', 'Procedure', 'Utterance']
WITH date(datetime({epochMillis: n.created_at})) AS day,
     labels(n)[0] AS label,
     n.provenance AS provenance
RETURN day, label, provenance, count(n) AS node_count
ORDER BY day ASC
```

**With cumulative totals (for a growth curve):**

```cypher
// Running total: all nodes created on or before each day
MATCH (n)
WHERE n.created_at IS NOT NULL
  AND labels(n)[0] IN ['Entity', 'Concept', 'Procedure', 'Utterance']
WITH datetime({epochMillis: n.created_at}) AS created
RETURN date(created) AS day, count(n) AS new_on_day
ORDER BY day ASC
```

The cumulative sum is computed in the NestJS service layer from the daily counts — Neo4j does not have a native window function equivalent that is idiomatic to use here.

**Index dependency:** `idx_entity_created_at`, `idx_concept_created_at`, `idx_procedure_created_at`, `idx_utterance_created_at` already exist.

**Cache recommendation:** This query is expensive on a large graph and the results change only when Learning runs (at most a few times per session). Cache in application memory with a 5-minute TTL or invalidate on `LEARNING` events.

**TimescaleDB involvement:** None. All data lives in Neo4j.

**Performance note:** On a graph with tens of thousands of nodes, a full MATCH scan is viable at early Phase 1 scale. If the WKG ever exceeds ~500k nodes, this query needs a dedicated Neo4j procedure or a denormalized daily-count table. That is a Phase 2 concern; log it as a known scaling risk.

---

### 2.2 Drive Evolution Heatmap (Drive Values Across Sessions)

**What the frontend wants:** A heatmap matrix of (session × drive) = value. Shows how each drive evolves over the system's lifetime. This is the primary behavioral health view.

**Database:** TimescaleDB (primary source). `drive_snapshot` JSONB column on `DRIVE_TICK` events.

**Query pattern:**

```sql
-- Mean drive values per session, per drive
-- drive_snapshot contains the PressureVector as a flat JSONB object
SELECT
  e.event_data->>'sessionId'    AS session_id,
  AVG((e.drive_snapshot->>'systemHealth')::float)        AS system_health,
  AVG((e.drive_snapshot->>'moralValence')::float)        AS moral_valence,
  AVG((e.drive_snapshot->>'integrity')::float)           AS integrity,
  AVG((e.drive_snapshot->>'cognitiveAwareness')::float)  AS cognitive_awareness,
  AVG((e.drive_snapshot->>'guilt')::float)               AS guilt,
  AVG((e.drive_snapshot->>'curiosity')::float)           AS curiosity,
  AVG((e.drive_snapshot->>'boredom')::float)             AS boredom,
  AVG((e.drive_snapshot->>'anxiety')::float)             AS anxiety,
  AVG((e.drive_snapshot->>'satisfaction')::float)        AS satisfaction,
  AVG((e.drive_snapshot->>'sadness')::float)             AS sadness,
  AVG((e.drive_snapshot->>'informationIntegrity')::float) AS information_integrity,
  AVG((e.drive_snapshot->>'social')::float)              AS social,
  COUNT(*)                                               AS tick_sample_count
FROM events e
WHERE e.event_type = 'DRIVE_TICK'
  AND e.drive_snapshot IS NOT NULL
  AND e.event_data->>'sessionId' IS NOT NULL
GROUP BY e.event_data->>'sessionId'
ORDER BY MIN(e.timestamp) ASC;
```

**Schema clarification:** The `drive_snapshot` column stores the `DriveSnapshot` object. The `PressureVector` is nested inside it under the `pressureVector` key. The query above must be adjusted:

```sql
-- Corrected: PressureVector is at drive_snapshot->'pressureVector'
AVG((e.drive_snapshot->'pressureVector'->>'systemHealth')::float) AS system_health,
-- ... and so on for all 12 drives
```

**Index dependency:** The composite index `idx_events_composite ON events(timestamp, event_type)` supports the `event_type = 'DRIVE_TICK'` filter. However, JSONB extraction without a dedicated JSON index means all matching rows must be scanned for the aggregation. This is acceptable at Phase 1 scale.

**TimescaleDB continuous aggregate recommendation:**

This is a strong candidate for a continuous aggregate. Drive tick data is high-frequency (~1 sampled tick/second), and sessions can span hours. Computing per-session averages in real time is wasteful.

```sql
-- Proposed continuous aggregate: hourly drive averages (denormalized)
-- Created via migration 001_observatory_drive_hourly_agg.sql
CREATE MATERIALIZED VIEW drive_evolution_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', timestamp)                              AS bucket,
  event_data->>'sessionId'                                       AS session_id,
  AVG((drive_snapshot->'pressureVector'->>'systemHealth')::float)       AS system_health,
  AVG((drive_snapshot->'pressureVector'->>'moralValence')::float)       AS moral_valence,
  AVG((drive_snapshot->'pressureVector'->>'integrity')::float)          AS integrity,
  AVG((drive_snapshot->'pressureVector'->>'cognitiveAwareness')::float) AS cognitive_awareness,
  AVG((drive_snapshot->'pressureVector'->>'guilt')::float)              AS guilt,
  AVG((drive_snapshot->'pressureVector'->>'curiosity')::float)          AS curiosity,
  AVG((drive_snapshot->'pressureVector'->>'boredom')::float)            AS boredom,
  AVG((drive_snapshot->'pressureVector'->>'anxiety')::float)            AS anxiety,
  AVG((drive_snapshot->'pressureVector'->>'satisfaction')::float)       AS satisfaction,
  AVG((drive_snapshot->'pressureVector'->>'sadness')::float)            AS sadness,
  AVG((drive_snapshot->'pressureVector'->>'informationIntegrity')::float) AS information_integrity,
  AVG((drive_snapshot->'pressureVector'->>'social')::float)             AS social,
  COUNT(*)                                                               AS sample_count
FROM events
WHERE event_type = 'DRIVE_TICK'
  AND drive_snapshot IS NOT NULL
GROUP BY bucket, event_data->>'sessionId'
WITH NO DATA;

SELECT add_continuous_aggregate_policy('drive_evolution_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
```

The Observatory endpoint then queries the aggregate, not the raw table. Per-session rollup joins the hourly buckets using the session boundaries in PostgreSQL.

**PostgreSQL involvement:** Session start/end timestamps from the `sessions` table are used to bound the time range when querying per-session drive averages. The join crosses database boundaries and must be handled in the service layer: fetch session timestamps from PostgreSQL, pass them as `startTime`/`endTime` parameters to the TimescaleDB query.

---

### 2.3 Action Diversity (Unique Action Types)

**What the frontend wants:** Count of unique action types per session or per rolling window. Maps directly to `BehavioralDiversityIndex`. Healthy range is 4-8 unique action types per 20-action window.

**Database:** TimescaleDB. Source events: `OUTCOME_PROCESSED` events written by the Drive Engine. The `event_data` JSONB contains `actionType`.

```sql
-- Unique action types per session
SELECT
  event_data->>'sessionId'     AS session_id,
  COUNT(DISTINCT event_data->>'actionType') AS unique_action_types,
  COUNT(*)                                  AS total_actions
FROM events
WHERE event_type = 'OUTCOME_PROCESSED'
  AND event_data->>'actionType' IS NOT NULL
GROUP BY event_data->>'sessionId'
ORDER BY MIN(timestamp) ASC;
```

**For a rolling 20-action diversity window (most recent 20 actions in a session):**

```sql
-- Rolling window: last 20 actions in a given session
SELECT COUNT(DISTINCT action_type) AS unique_action_types
FROM (
  SELECT event_data->>'actionType' AS action_type
  FROM events
  WHERE event_type = 'OUTCOME_PROCESSED'
    AND event_data->>'sessionId' = $1
  ORDER BY timestamp DESC
  LIMIT 20
) AS last_20;
```

**Index dependency:** No existing index covers `event_data->>'actionType'`. The `event_type` filter is covered. For Phase 1 data volumes this is acceptable. If action volume is high, add a generated column:

```sql
-- Migration (deferred): generated column for frequent JSONB extraction
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS action_type TEXT
  GENERATED ALWAYS AS (event_data->>'actionType') STORED;

CREATE INDEX IF NOT EXISTS idx_events_action_type
  ON events (action_type)
  WHERE action_type IS NOT NULL;
```

**TimescaleDB involvement:** No continuous aggregate needed — the action diversity query is fast at Phase 1 scale. Revisit if action event volume exceeds ~10k events/session.

---

### 2.4 Developmental Stage (Type 1/Type 2 Progression)

**What the frontend wants:** Per-session or per-time-bucket counts of Type 1 vs Type 2 decisions, and the graduation/demotion events. Shows the primary development metric trending over time.

**Database:** TimescaleDB. Source events: `OUTCOME_PROCESSED` events carry an `actionType` and outcome. Graduation/demotion events need a dedicated event type.

**Current gap:** There is no `TYPE_1_GRADUATION` or `TYPE_2_DEMOTION` event type in the events schema as implemented. The `DriveEngineEventType` enum in `src/drive-engine/constants/events.ts` does not include these. The graduation logic exists (`graduation-criteria.ts`) but does not emit an observable event to TimescaleDB.

**Required schema addition (see Section 5):** A `TYPE_1_GRADUATION` and `TYPE_2_DEMOTION` event type must be added to the events table constraint or the constraint must be relaxed. These events must be written to TimescaleDB by the Decision Making subsystem when graduation/demotion occurs.

**Query once those events exist:**

```sql
-- Type 1 vs Type 2 decisions per session
SELECT
  event_data->>'sessionId'    AS session_id,
  SUM(CASE WHEN event_type = 'TYPE_1_DECISION' THEN 1 ELSE 0 END) AS type1_count,
  SUM(CASE WHEN event_type = 'TYPE_2_DECISION' THEN 1 ELSE 0 END) AS type2_count,
  ROUND(
    SUM(CASE WHEN event_type = 'TYPE_1_DECISION' THEN 1 ELSE 0 END)::numeric /
    NULLIF(COUNT(*), 0), 4
  ) AS type1_ratio
FROM events
WHERE event_type IN ('TYPE_1_DECISION', 'TYPE_2_DECISION')
GROUP BY event_data->>'sessionId'
ORDER BY MIN(timestamp) ASC;

-- Graduation events over time
SELECT
  timestamp,
  event_data->>'actionType' AS action_type,
  event_type
FROM events
WHERE event_type IN ('TYPE_1_GRADUATION', 'TYPE_2_DEMOTION')
ORDER BY timestamp ASC;
```

**TimescaleDB involvement:** A continuous aggregate on decision type counts per hour is appropriate for long-running sessions. For Phase 1 where sessions may be short, a direct aggregate query is sufficient.

**Critical dependency:** This endpoint cannot return meaningful data until Decision Making subsystem writes `TYPE_1_DECISION` and `TYPE_2_DECISION` events to TimescaleDB on every arbitration cycle. This is an instrumentation gap, not just an Observatory issue. It must be filed as a separate prerequisite ticket.

---

### 2.5 Session Comparison (Metrics Per Session)

**What the frontend wants:** A table where each row is a session and each column is a metric value, allowing comparison across sessions. This is a direct rendering of the `HealthMetrics` aggregate type.

**Database:** PostgreSQL (session metadata) + TimescaleDB (computed per-session metrics) + Neo4j (provenance ratio per session).

**Session metadata query (PostgreSQL):**

```sql
SELECT id, started_at, ended_at,
  EXTRACT(EPOCH FROM (ended_at - started_at)) AS duration_seconds,
  summary
FROM sessions
ORDER BY started_at ASC;
```

**Per-session metric computation:** Rather than computing each metric from scratch on request, the `sessions` table should be extended to store computed metric snapshots. This avoids expensive cross-database joins on every page load.

**Recommended schema addition to PostgreSQL `sessions` table:**

```sql
-- Migration: add metrics_snapshot JSONB column to sessions
-- Description: Stores the HealthMetrics snapshot at session close.
-- Rollback: ALTER TABLE sessions DROP COLUMN metrics_snapshot;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS metrics_snapshot JSONB;

COMMENT ON COLUMN sessions.metrics_snapshot IS
  'HealthMetrics snapshot computed at session close. NULL until session ends.
   Shape: src/shared/types/metrics.types.ts HealthMetrics interface.
   Written by SessionService.closeSession(), read by ObservatoryController.';
```

At session close, the application computes `HealthMetrics` across all three databases (Neo4j for provenance, TimescaleDB for event counts, Drive Engine for resolution times) and writes the JSON blob to `sessions.metrics_snapshot`. The Observatory session comparison endpoint then reads only from the `sessions` table — one PostgreSQL query, zero cross-database joins.

**Why this is correct architecture:** Session comparison is a historical read. The data does not change after session close. Persisting the snapshot at close time separates the expensive computation (one-time, on session close) from the cheap read (N times, whenever the Observatory loads).

---

### 2.6 Comprehension Accuracy (Prediction MAE Over Time)

**What the frontend wants:** A time-series of mean absolute error across sessions or time buckets. Maps directly to `PredictionMAEMetric`. Shows the world model getting more accurate.

**Database:** TimescaleDB. Source events: `PREDICTION_EVALUATED` events must contain the absolute error for each prediction.

**Current gap:** `PREDICTION_EVALUATED` appears in the CANON system description but is not in the `DriveEngineEventType` enum. These events must be written by the Decision Making subsystem when prediction outcomes are evaluated.

**Assumed event_data shape for PREDICTION_EVALUATED:**

```typescript
interface PredictionEvaluatedEventData {
  sessionId: string;
  predictionId: string;
  actionType: string;
  predictedOutcome: number;    // [0.0, 1.0]
  actualOutcome: number;       // [0.0, 1.0]
  absoluteError: number;       // |predicted - actual|
  confidence: number;          // WKG confidence at prediction time
}
```

**Query:**

```sql
-- MAE per session
SELECT
  event_data->>'sessionId'   AS session_id,
  AVG((event_data->>'absoluteError')::float) AS mae,
  COUNT(*)                                    AS sample_count,
  MIN(timestamp)                              AS session_start
FROM events
WHERE event_type = 'PREDICTION_EVALUATED'
  AND event_data->>'absoluteError' IS NOT NULL
GROUP BY event_data->>'sessionId'
ORDER BY session_start ASC;

-- MAE in a rolling 10-prediction window (for Type 1 graduation check)
SELECT AVG(absolute_error) AS rolling_mae
FROM (
  SELECT (event_data->>'absoluteError')::float AS absolute_error
  FROM events
  WHERE event_type = 'PREDICTION_EVALUATED'
    AND event_data->>'actionType' = $1        -- specific action being evaluated
    AND event_data->>'sessionId' = $2
  ORDER BY timestamp DESC
  LIMIT 10
) AS last_10;
```

**TimescaleDB continuous aggregate:**

```sql
CREATE MATERIALIZED VIEW prediction_mae_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', timestamp)           AS bucket,
  event_data->>'sessionId'                    AS session_id,
  AVG((event_data->>'absoluteError')::float) AS mae,
  COUNT(*)                                    AS sample_count
FROM events
WHERE event_type = 'PREDICTION_EVALUATED'
GROUP BY bucket, event_data->>'sessionId'
WITH NO DATA;

SELECT add_continuous_aggregate_policy('prediction_mae_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
```

**Dependency:** Same instrumentation requirement as Section 2.4 — Decision Making subsystem must write `PREDICTION_EVALUATED` events. No Observatory endpoint can compute MAE from events that do not exist.

---

### 2.7 Phrase Recognition Ratio (Retrieval Success Rate)

**What the frontend wants:** What fraction of WKG retrievals succeed (return a node above threshold confidence) vs. fail (shrug). Maps to guardian response rate / information integrity health metrics. Also relates to the Shrug Imperative (CANON Standard 4).

**Database:** TimescaleDB. Source events: arbitration events from Decision Making. Need `RETRIEVAL_SUCCESS` and `RETRIEVAL_FAILURE` (or `SHRUG_ISSUED`) events, or a single event with a result flag.

**Assumed event type:** `ARBITRATION_COMPLETE` events with `event_data.retrievalResult = 'success' | 'shrug'`.

**Current gap:** As with Type 1/Type 2 and MAE, this requires Decision Making to instrument arbitration outcomes as TimescaleDB events.

**Query pattern once events exist:**

```sql
SELECT
  event_data->>'sessionId'    AS session_id,
  SUM(CASE WHEN event_data->>'retrievalResult' = 'success' THEN 1 ELSE 0 END) AS successes,
  SUM(CASE WHEN event_data->>'retrievalResult' = 'shrug'   THEN 1 ELSE 0 END) AS shrugs,
  COUNT(*)                                                                       AS total_retrievals,
  ROUND(
    SUM(CASE WHEN event_data->>'retrievalResult' = 'success' THEN 1 ELSE 0 END)::numeric /
    NULLIF(COUNT(*), 0), 4
  ) AS retrieval_success_rate
FROM events
WHERE event_type = 'ARBITRATION_COMPLETE'
GROUP BY event_data->>'sessionId'
ORDER BY MIN(timestamp) ASC;
```

**Alternative using Neo4j node-level tracking:** Each WKG node already has `useCount` and `lastRetrievedAt` properties (from the CANON ACT-R schema). The retrieval success ratio can be approximated from these:

```cypher
// Nodes with at least one successful retrieval vs never-retrieved
MATCH (n)
WHERE labels(n)[0] IN ['Entity', 'Concept', 'Procedure', 'Utterance']
RETURN
  COUNT(CASE WHEN n.useCount > 0 THEN 1 END)  AS ever_retrieved,
  COUNT(CASE WHEN n.useCount = 0 THEN 1 END)  AS never_retrieved,
  COUNT(n)                                      AS total_nodes,
  ROUND(
    toFloat(COUNT(CASE WHEN n.useCount > 0 THEN 1 END)) / COUNT(n), 4
  ) AS retrieval_ratio
```

This Neo4j approach gives a point-in-time ratio (not a time series) but requires no new event types. It is the pragmatic fallback until Decision Making adds the TimescaleDB instrumentation.

---

## 3. Session Management Analysis

### 3.1 Current State

The `sessions` table exists in PostgreSQL and is granted to `sylphie_app`. It has never been populated. There is no session lifecycle management service.

The `DriveSnapshot` type carries a `sessionId` field, and `event_data` blobs from the Drive Engine embed `sessionId` in their payloads. Sessions are referenced throughout the event data but the session boundary records themselves are never written.

### 3.2 What Marks Session Boundaries

Session start: When the NestJS application starts (or when the guardian initiates a new interaction). A UUID is generated and stored in PostgreSQL `sessions(id, started_at, user_id)`.

Session end: When the guardian explicitly ends a session, or when the application shuts down. `sessions.ended_at` is written, and `sessions.metrics_snapshot` (proposed in Section 2.5) is computed and stored.

The `sessionId` already flows through the Drive Engine and appears in all event payloads. The session boundary records are the missing link.

### 3.3 Session Service Requirements

A `SessionService` must be added to the NestJS application (or extended from an existing service) with these behaviors:

1. **On application start:** Check if an open session exists (no `ended_at`). If one exists and the gap since last event is > 30 minutes, close it as "interrupted" with a null `ended_at` filled in via estimation. Otherwise, resume it. If no open session, create one.

2. **On graceful shutdown:** Compute `HealthMetrics`, write to `sessions.metrics_snapshot`, set `ended_at = NOW()`.

3. **On demand (guardian action):** Guardian can explicitly start/close a session via a protected endpoint.

4. **Session ID propagation:** The active `sessionId` must be accessible to all subsystems. It is currently embedded in the Drive Engine snapshot, which means the main NestJS process must publish a session ID to the Drive Engine at startup via IPC.

### 3.4 Session Table Additions Needed

```sql
-- Migration: extend sessions table for Observatory use
-- Rollback: ALTER TABLE sessions DROP COLUMN metrics_snapshot;
--           ALTER TABLE sessions DROP COLUMN tick_count;
--           ALTER TABLE sessions DROP COLUMN event_count;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS metrics_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS tick_count       BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS event_count      BIGINT DEFAULT 0;

COMMENT ON COLUMN sessions.metrics_snapshot IS
  'HealthMetrics snapshot. Populated at session close. NULL until then.';
COMMENT ON COLUMN sessions.tick_count IS
  'Total Drive Engine ticks during this session. For duration normalization.';
COMMENT ON COLUMN sessions.event_count IS
  'Total events written to TimescaleDB during this session.';

CREATE INDEX IF NOT EXISTS idx_sessions_started_at
  ON sessions (started_at DESC);
```

---

## 4. Skills Storage Analysis

### 4.1 What the Skills Manager Needs

The Skills Manager (referenced in Epic 11 scope) needs to store skill packages — bundles of capability that can be loaded, activated, or deactivated. These are distinct from the WKG `Procedure` nodes (which are learned behaviors) and from drive rules (which are behavioral contingencies).

Skills are authored packages, not learned ones. They represent capabilities the guardian installs deliberately.

### 4.2 Storage Decision: PostgreSQL, Not Filesystem

**Filesystem storage is rejected.** Files do not participate in transactions, do not have row-level security, cannot be backed up atomically with the database, and are invisible to health checks. The data mandate requires that anything non-regenerable lives in a database with backup coverage.

**PostgreSQL is the correct store.** Skills are small, structured, guardian-controlled (like drive rules), and low-volume. They belong in the system database alongside drive rules and settings.

### 4.3 Proposed Skills Schema

```sql
-- Migration: skills persistence for Skills Manager
-- Description: Store skill packages in PostgreSQL with RLS
-- Rollback:
--   DROP TABLE IF EXISTS skill_activation_log;
--   DROP TABLE IF EXISTS skills;

CREATE TABLE IF NOT EXISTS skills (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL UNIQUE,
  version      TEXT        NOT NULL DEFAULT '1.0.0',
  description  TEXT,
  package_data JSONB       NOT NULL,     -- serialized skill capability bundle
  manifest     JSONB       NOT NULL DEFAULT '{}',
                                         -- dependencies, required drives, etc.
  status       TEXT        NOT NULL DEFAULT 'inactive'
               CHECK (status IN ('active', 'inactive', 'deprecated')),
  installed_by TEXT        NOT NULL DEFAULT 'guardian',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  is_system    BOOLEAN     NOT NULL DEFAULT false,
                                         -- true = cannot be deactivated by runtime
  CONSTRAINT skills_name_not_empty CHECK (length(trim(name)) > 0)
);

-- Audit log: tracks activation/deactivation history
CREATE TABLE IF NOT EXISTS skill_activation_log (
  id           SERIAL      PRIMARY KEY,
  skill_id     UUID        NOT NULL REFERENCES skills(id),
  operation    TEXT        NOT NULL CHECK (operation IN ('activate', 'deactivate', 'update', 'delete')),
  performed_by TEXT        NOT NULL,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_status TEXT,
  notes        TEXT
);

-- RLS: sylphie_app can read all skills, but cannot INSERT/UPDATE/DELETE active skills
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

-- Runtime can read all skills
CREATE POLICY skills_read ON skills
  FOR SELECT TO sylphie_app
  USING (true);

-- Runtime cannot modify system skills
CREATE POLICY skills_no_system_modify ON skills
  AS RESTRICTIVE
  FOR UPDATE TO sylphie_app
  USING (is_system = false)
  WITH CHECK (is_system = false);

-- Runtime cannot delete any skills (guardian only)
-- Achieved by not granting DELETE to sylphie_app

-- Grants
GRANT SELECT ON skills TO sylphie_app;
GRANT SELECT, INSERT ON skill_activation_log TO sylphie_app;
GRANT USAGE ON SEQUENCE skill_activation_log_id_seq TO sylphie_app;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills (status);
CREATE INDEX IF NOT EXISTS idx_skills_name   ON skills (name);
CREATE INDEX IF NOT EXISTS idx_skill_log_skill_id ON skill_activation_log (skill_id, performed_at DESC);
```

**Why `package_data` is JSONB:** Skills need to store structured capability definitions that evolve in schema. JSONB avoids needing a migration for every new skill field. The `manifest` column separates metadata (dependencies, required drives) from the capability payload for queryability.

**Why `is_system = true` for core skills:** Some skills are part of the application's base functionality (e.g., TTS, STT integration). These should not be deactivatable by guardian mistake. The RLS policy prevents the runtime user from modifying them, and the guardian-role-only modification path applies the same guardian review discipline used for drive rules.

---

## 5. Instrumentation Gaps: Events That Must Exist Before Observatory Works

Three of the seven Observatory endpoints depend on event types that are not currently being written to TimescaleDB. These are not Observatory implementation tickets — they are prerequisites in the Decision Making and Drive Engine subsystems.

| Missing Event | Produced By | Required For | Priority |
|--------------|-------------|--------------|----------|
| `TYPE_1_DECISION` | Decision Making | Developmental stage endpoint | High |
| `TYPE_2_DECISION` | Decision Making | Developmental stage endpoint | High |
| `TYPE_1_GRADUATION` | Decision Making / Drive Engine | Developmental stage endpoint | High |
| `TYPE_2_DEMOTION` | Decision Making / Drive Engine | Developmental stage endpoint | Medium |
| `PREDICTION_EVALUATED` | Decision Making | Comprehension accuracy endpoint | High |
| `ARBITRATION_COMPLETE` | Decision Making | Phrase recognition endpoint | Medium |

The graduation criteria logic is already implemented in `src/drive-engine/drive-process/graduation-criteria.ts`. Emitting events when those criteria fire is a small addition. The bigger gap is the per-arbitration-cycle instrumentation in Decision Making.

**Until those events exist**, these three endpoints should return empty datasets with a `data_available: false` flag rather than query errors. This is a graceful degradation design decision.

---

## 6. Database Impact Assessment

### 6.1 Read Load Added by Observatory

| Endpoint | Database | Query Frequency | Cost |
|----------|----------|-----------------|------|
| Vocabulary growth | Neo4j | On demand (not real-time) | Medium (full label scan) |
| Drive evolution | TimescaleDB | On demand | Low (continuous aggregate) |
| Action diversity | TimescaleDB | On demand | Low (event count query) |
| Developmental stage | TimescaleDB | On demand | Low (event count query) |
| Session comparison | PostgreSQL | On demand | Negligible (metrics_snapshot blob read) |
| Comprehension accuracy | TimescaleDB | On demand | Low (continuous aggregate) |
| Phrase recognition | Neo4j + TimescaleDB | On demand | Low-Medium |

Observatory endpoints are loaded when the dashboard is open and the user navigates to the Observatory tab. They are NOT real-time streams — they are point-in-time aggregations. This means the read load is user-driven, not continuous. The existing connection pools are sufficient.

### 6.2 Write Load Added by Observatory

The Observatory itself adds zero write load to any database. The session service additions (writing session boundaries and metrics snapshots) add a small number of writes: 1 on session start, 1 on session close, with size bounded by the `HealthMetrics` struct (< 5 KB per session).

### 6.3 Storage Estimates

**New continuous aggregates:**
- `drive_evolution_hourly`: ~100 rows/day (one row per session-hour, assuming 8 active hours). At ~500 bytes/row: ~18 MB/year. Negligible.
- `prediction_mae_hourly`: Similar scale. Negligible.

**Sessions table extensions:**
- `metrics_snapshot` per session: ~5 KB. At 3 sessions/day: ~5 MB/year. Negligible.

**Skills table:**
- Expected maximum: dozens of skill packages at ~10 KB each. Total: < 1 MB. Negligible.

No storage concerns. All additions are within the existing Phase 1 data model's capacity.

---

## 7. Migration Plan

All schema changes must follow the established migration discipline: additive only, documented rollback, transactional, tested against a copy before applying to live data.

### 7.1 TimescaleDB Migrations (New)

```
scripts/migrations/timescale/
  004_drive_evolution_hourly_aggregate.sql    -- continuous aggregate for drive heatmap
  005_prediction_mae_hourly_aggregate.sql     -- continuous aggregate for MAE
```

Both are `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)` statements with policies. Both are safe to add while the application is running (they populate from existing data on first refresh). Neither modifies the `events` table.

### 7.2 PostgreSQL Migrations (New)

```
scripts/migrations/postgres/
  004_extend_sessions_for_observatory.sql    -- metrics_snapshot, tick_count, event_count
  005_skills_table.sql                       -- skills + skill_activation_log + RLS + grants
```

Both are pure additions. No columns are dropped. No existing constraints change.

### 7.3 Neo4j Schema Changes

None required. The existing indexes on `provenance`, `confidence`, and `created_at` per label are sufficient for all Observatory queries against the WKG.

### 7.4 Migration Pre-Conditions

Per Sentinel immutable rule 3: before any migration runs, verify a current backup exists.

For `004_drive_evolution_hourly_aggregate.sql` and `005_prediction_mae_hourly_aggregate.sql`: these do not alter the `events` table, so the risk is low. A pg_dump confirmation is sufficient.

For `004_extend_sessions_for_observatory.sql` and `005_skills_table.sql`: these add columns and tables. A pg_dump of the system database before running is required.

---

## 8. Recommended Ticket Count

Based on this analysis, Epic 11's persistence and infrastructure work divides into the following tickets:

| # | Ticket | Type | Dependency |
|---|--------|------|------------|
| E11-S01 | SessionService: write session boundaries to PostgreSQL | Feature | Blocks all session-scoped Observatory endpoints |
| E11-S02 | Migration 004: drive_evolution_hourly continuous aggregate | Migration | Needs pg_dump backup pre-condition |
| E11-S03 | Migration 005: prediction_mae_hourly continuous aggregate | Migration | Needs pg_dump backup pre-condition |
| E11-S04 | Migration: extend sessions table (metrics_snapshot, tick/event counts) | Migration | Depends on E11-S01 |
| E11-S05 | Migration: skills + skill_activation_log tables + RLS + grants | Migration | Independent |
| E11-S06 | ObservatoryService: vocabulary growth endpoint (Neo4j) | Feature | Independent |
| E11-S07 | ObservatoryService: drive evolution endpoint (TimescaleDB aggregate) | Feature | Depends on E11-S02 |
| E11-S08 | ObservatoryService: action diversity endpoint (TimescaleDB) | Feature | Independent |
| E11-S09 | ObservatoryService: developmental stage endpoint (TimescaleDB) | Feature | Blocked by instrumentation gap (TYPE_1/TYPE_2 events) |
| E11-S10 | ObservatoryService: session comparison endpoint (PostgreSQL snapshot) | Feature | Depends on E11-S01, E11-S04 |
| E11-S11 | ObservatoryService: comprehension accuracy endpoint (TimescaleDB aggregate) | Feature | Depends on E11-S03, blocked by PREDICTION_EVALUATED gap |
| E11-S12 | ObservatoryService: phrase recognition endpoint (Neo4j + TimescaleDB) | Feature | Blocked by ARBITRATION_COMPLETE gap (Neo4j path available immediately) |
| E11-S13 | Prerequisites: Decision Making instrumentation (TYPE_1/2, PREDICTION_EVALUATED, ARBITRATION_COMPLETE events) | Feature | Must precede E11-S09, E11-S11, E11-S12 |
| E11-S14 | SkillsManagerService: CRUD against skills table | Feature | Depends on E11-S05 |
| E11-S15 | Backup verification before migration batch | Ops | Must precede E11-S02 through E11-S05 |

**Total: 15 tickets.** The critical path is: E11-S15 → E11-S02/S03/S04/S05 (migration batch) → E11-S07/S08/S10/S11. The Decision Making instrumentation (E11-S13) can proceed in parallel and is the gating item for E11-S09, E11-S11, and the TimescaleDB path of E11-S12.

---

## 9. Key Infrastructure Decisions

### 9.1 Observatory Is Read-Only by Design

No Observatory endpoint writes to any database. All writes that Observatory endpoints depend on (session boundaries, metric snapshots, DRIVE_TICK events, PREDICTION_EVALUATED events) are produced by the subsystems that generate them, not by the Observatory itself. This maintains the correct data flow and prevents the dashboard from becoming a write path.

### 9.2 Session Comparison Uses Persisted Snapshots, Not Live Queries

Computing `HealthMetrics` at request time requires three database queries (Neo4j, TimescaleDB, PostgreSQL). For historical sessions, this data never changes. The decision to persist `metrics_snapshot` at session close converts a multi-database join at read time into a single-column read. This is the correct architecture for a query-time-vs-write-time tradeoff.

### 9.3 Three Endpoints Are Blocked by Instrumentation, Not by Infrastructure

The Developmental Stage, Comprehension Accuracy, and Phrase Recognition endpoints are blocked by missing events in TimescaleDB — specifically the absence of `TYPE_1_DECISION`, `TYPE_2_DECISION`, `PREDICTION_EVALUATED`, and `ARBITRATION_COMPLETE` event writes from the Decision Making subsystem. The database infrastructure, schema, and query patterns are fully specified in this document. The dependency is behavioral, not persistence.

### 9.4 Drive Evolution Uses the Neo4j ACT-R Fallback for Phrase Recognition

Until TimescaleDB instrumentation is complete, the Phrase Recognition endpoint can return a meaningful (though non-time-series) value using the `useCount` property on WKG nodes. The endpoint should return both the live Neo4j point-in-time value and a `timeseries_available: false` flag so the frontend can render the best available data.

### 9.5 Skills Storage Is PostgreSQL, Not Filesystem or WKG

Skills are guardian-installed capability packages. They are not learned knowledge (not WKG), not behavioral contingencies (not drive rules), and not event data (not TimescaleDB). They are configuration, and configuration lives in PostgreSQL with the same RLS discipline applied to drive rules. System skills carry `is_system = true` and are protected from runtime modification by a RESTRICTIVE policy.

---

## 10. Backup Pre-Condition Statement

Before any of the migrations in Section 7 are executed, the following must be confirmed:

1. `pg_dump sylphie_system > /backups/postgres/sylphie_system_pre_epic11_$(date +%Y%m%d).sql` -- system database backup.
2. `pg_dump sylphie > /backups/timescale/sylphie_pre_epic11_$(date +%Y%m%d).sql` -- TimescaleDB backup (schema + data).
3. Neo4j dump (no schema changes needed, but dump before any migration run as standard practice): `neo4j-admin database dump --to-path=/backups/neo4j neo4j`.
4. Verify each backup is non-zero and the checksum matches a `pg_restore --list` dry-run.

This is non-negotiable per Sentinel Immutable Rule 3. The ticket E11-S15 exists specifically to enforce this verification step before the migration batch runs.
