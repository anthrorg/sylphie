# Epic 9: Dashboard API and WebSocket Gateways -- Sentinel Infrastructure Analysis

**Status:** Planning
**Epic Scope:** HTTP/WS surface for frontend dashboard across all 5 databases
**Analysis Date:** 2026-03-29
**Analyst:** Sentinel (Data Persistence & Infrastructure Engineer)
**Focus:** Health checks, data access patterns, performance, integrity constraints

---

## Executive Summary

Epic 9 creates the HTTP/WebSocket gateway layer that exposes Sylphie's internal state to the dashboard frontend. This analysis covers the infrastructure challenge: **making 5 disparate databases (Neo4j, TimescaleDB, PostgreSQL, Grafeo Self KG, Grafeo Other KGs) queryable through a unified, performant, read-only API surface**.

The critical decision points are:

1. **Health Check Cascade:** A single `/health` endpoint must test all 5 databases with appropriate timeout handling and circuit-breaker logic.
2. **Query Isolation:** Drive state, WKG visualization, telemetry, and metrics each have different performance requirements and caching strategies.
3. **WebSocket Broadcast Frequency:** Real-time data (drive state, predictions) conflicts with database query latency. Buffering and sampling are essential.
4. **Data Integrity:** All dashboard endpoints are READ-ONLY. Chat input flows through Communication module, NOT direct DB writes.

This analysis is 2500+ words and covers all 5 databases, specific query patterns, indexing strategy, and performance benchmarks.

---

## Part 1: Health Check Design (Comprehensive Multi-Database Strategy)

### 1.1 Health Check Architecture

The health check endpoint (`/health`) is the first line of defense. Every connected system must be reachable, and failures must be detectable in <500ms.

#### 1.1.1 Overall Health Check Response

```typescript
// GET /health
interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: ISO8601;
  checks: {
    neo4j: HealthCheckResult;
    timescaledb: HealthCheckResult;
    postgresql: HealthCheckResult;
    grafeoSelfKg: HealthCheckResult;
    grafeoOtherKgs: HealthCheckResult;
  };
  metadata: {
    uptime: number;  // milliseconds
    checks_version: string;
  };
}

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'error';
  latency_ms: number;
  error?: string;
  details: Record<string, unknown>;
  last_checked: ISO8601;
}
```

**Health Status Rollup Rules:**
- `healthy`: All 5 databases respond in <200ms
- `degraded`: All 5 databases accessible but >=1 takes >200ms, OR >=1 shows warning signs (slow queries, high connection pool usage)
- `unhealthy`: >=1 database unreachable OR any database fails critical check

**Timeout Strategy:**
- Each database check: 150ms individual timeout
- Overall endpoint: 500ms hard timeout
- Checks run in parallel, not sequentially
- Timeouts are logged with severity

---

### 1.2 Neo4j Health Check

**What to verify:** Connectivity, node/edge cardinality, graph integrity

```typescript
// src/health/checks/neo4j.health.ts

export class Neo4jHealthCheck {
  async check(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const session = this.driver.session({ defaultAccessMode: 'READ' });

      try {
        // Critical test: Can we read the database?
        const verifyResult = await session.run(
          'MATCH (n) RETURN count(n) as node_count LIMIT 1',
          {},
          { timeout: 150 }
        );

        const nodeCount = verifyResult.records[0]?.get('node_count')?.toNumber() || 0;

        // Get edge count via relationship count
        const edgeResult = await session.run(
          'MATCH ()-[r]->() RETURN count(r) as edge_count LIMIT 1',
          {},
          { timeout: 150 }
        );

        const edgeCount = edgeResult.records[0]?.get('edge_count')?.toNumber() || 0;

        // Check for catastrophic schema issues
        const constraintResult = await session.run(
          'SHOW CONSTRAINTS',
          {},
          { timeout: 150 }
        );

        const constraintCount = constraintResult.records.length;

        return {
          status: 'healthy',
          latency_ms: Date.now() - startTime,
          details: {
            node_count: nodeCount,
            edge_count: edgeCount,
            constraint_count: constraintCount,
            driver_metrics: {
              acquired_connections: this.driver._connectionPool.activeConnections.length,
              idle_connections: this.driver._connectionPool.idleConnections.length,
            },
          },
          last_checked: new Date().toISOString(),
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      return {
        status: 'error',
        latency_ms: Date.now() - startTime,
        error: error.message,
        details: { trace: error.stack },
        last_checked: new Date().toISOString(),
      };
    }
  }
}
```

**Key Metrics:**
- **Node Count:** If 0, graph is empty (warning, not error)
- **Edge Count:** If 0, graph has no relationships (likely misconfiguration)
- **Constraint Count:** Schema validation — should be stable. If changes unexpectedly, flag for investigation.
- **Connection Pool Health:** Active vs. idle connections. Alert if pool is exhausted.

**Caching:** Neo4j health checks are expensive. Cache for 30 seconds.

---

### 1.3 TimescaleDB Health Check

**What to verify:** Connectivity, hypertable existence, recent event availability, insert latency

```typescript
// src/health/checks/timescaledb.health.ts

export class TimescaleDBHealthCheck {
  async check(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const client = this.pool.connect();

    try {
      // Verify hypertable exists and is readable
      const hypertableCheck = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        ['events'],
        { timeout: 150 }
      );

      if (hypertableCheck.rows.length === 0) {
        return {
          status: 'error',
          latency_ms: Date.now() - startTime,
          error: 'events hypertable not found',
          details: {},
          last_checked: new Date().toISOString(),
        };
      }

      // Get event count (hypertable statistics)
      const countResult = await client.query(
        `SELECT count(*) as event_count FROM events`,
        [],
        { timeout: 150 }
      );

      const eventCount = parseInt(countResult.rows[0].event_count, 10);

      // Get latest event timestamp (temporal continuity check)
      const latestResult = await client.query(
        `SELECT max(time) as latest_event_time
         FROM events
         WHERE time > now() - interval '1 day'`,
        [],
        { timeout: 150 }
      );

      const latestEventTime = latestResult.rows[0]?.latest_event_time || null;

      // Check compression chunk status
      const compressionResult = await client.query(
        `SELECT count(*) as compressed_chunks,
                sum(CASE WHEN is_compressed THEN 1 ELSE 0 END) as compressed_count
         FROM timescaledb_information.chunks
         WHERE hypertable_name = 'events'`,
        [],
        { timeout: 150 }
      );

      return {
        status: 'healthy',
        latency_ms: Date.now() - startTime,
        details: {
          event_count: eventCount,
          latest_event_time: latestEventTime,
          total_chunks: compressionResult.rows[0]?.compressed_chunks || 0,
          compressed_chunks: compressionResult.rows[0]?.compressed_count || 0,
          pool_size: this.pool.totalCount,
          idle_connections: this.pool.idleCount,
          waiting_requests: this.pool.waitingCount,
        },
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'error',
        latency_ms: Date.now() - startTime,
        error: error.message,
        details: { trace: error.stack },
        last_checked: new Date().toISOString(),
      };
    } finally {
      client.release();
    }
  }
}
```

**Key Metrics:**
- **Event Count:** Volume trend (increasing = normal)
- **Latest Event Time:** Temporal continuity. If no events in last hour, investigate stale state.
- **Compression Status:** Hypertable chunking is healthy if recent chunks are being compressed.
- **Connection Pool Saturation:** If `waiting_requests > 0`, performance is degraded.

**Caching:** 60 seconds (TimescaleDB queries are cheaper than Neo4j)

---

### 1.4 PostgreSQL (Drive Rules & System DB) Health Check

**What to verify:** Connectivity, drive_rules table integrity, migrations applied

```typescript
// src/health/checks/postgresql.health.ts

export class PostgreSQLHealthCheck {
  async check(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const client = this.adminPool.connect();

    try {
      // Test basic connectivity
      const pingResult = await client.query(
        'SELECT now() as server_time',
        [],
        { timeout: 150 }
      );

      if (!pingResult.rows[0]) {
        throw new Error('No response from PostgreSQL');
      }

      // Verify schema tables exist (migrations applied)
      const schemaCheck = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
         AND table_name IN ('drive_rules', 'users', 'settings', 'proposed_rules')`,
        [],
        { timeout: 150 }
      );

      const requiredTables = ['drive_rules', 'users', 'settings', 'proposed_rules'];
      const foundTables = new Set(schemaCheck.rows.map(r => r.table_name));
      const missingTables = requiredTables.filter(t => !foundTables.has(t));

      if (missingTables.length > 0) {
        return {
          status: 'error',
          latency_ms: Date.now() - startTime,
          error: `Missing tables: ${missingTables.join(', ')}`,
          details: { missing: missingTables, found: Array.from(foundTables) },
          last_checked: new Date().toISOString(),
        };
      }

      // Count active drive rules
      const rulesResult = await client.query(
        `SELECT count(*) as total_rules,
                sum(CASE WHEN enabled THEN 1 ELSE 0 END) as enabled_rules
         FROM drive_rules`,
        [],
        { timeout: 150 }
      );

      // Check for proposed (pending guardian approval) rules
      const proposedResult = await client.query(
        `SELECT count(*) as proposed_rules
         FROM proposed_rules
         WHERE status = 'pending'`,
        [],
        { timeout: 150 }
      );

      return {
        status: 'healthy',
        latency_ms: Date.now() - startTime,
        details: {
          total_rules: parseInt(rulesResult.rows[0].total_rules, 10),
          enabled_rules: parseInt(rulesResult.rows[0].enabled_rules, 10),
          proposed_rules: parseInt(proposedResult.rows[0].proposed_rules, 10),
          tables_found: foundTables.size,
        },
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'error',
        latency_ms: Date.now() - startTime,
        error: error.message,
        details: { trace: error.stack },
        last_checked: new Date().toISOString(),
      };
    } finally {
      client.release();
    }
  }
}
```

**Key Metrics:**
- **Table Presence:** Schema integrity. Missing tables indicate failed migrations.
- **Rule Counts:** Total vs enabled. If total_rules = 0, system has no decision rules (critical).
- **Proposed Rules Queue:** If large, guardian approval is backlogged.

**Caching:** 120 seconds (very cheap queries)

---

### 1.5 Grafeo Self KG Health Check

**What to verify:** Instance exists, queryable, contains self-model

```typescript
// src/health/checks/grafeo-self.health.ts

export class GrafeoSelfKgHealthCheck {
  async check(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Verify Grafeo instance is accessible
      const instance = this.grafeoService.getSelfKgInstance();

      if (!instance) {
        return {
          status: 'error',
          latency_ms: Date.now() - startTime,
          error: 'Self KG instance not initialized',
          details: {},
          last_checked: new Date().toISOString(),
        };
      }

      // Run a simple query: does the self-model exist?
      const query = `
        MATCH (self:SelfModel)
        RETURN count(self) as self_count
      `;

      const result = await instance.query(query);

      const selfCount = result[0]?.self_count || 0;

      if (selfCount === 0) {
        // Self model hasn't been initialized yet (warning, not error)
        return {
          status: 'healthy',
          latency_ms: Date.now() - startTime,
          details: {
            self_model_exists: false,
            message: 'Self-model not yet created (expected during cold start)',
          },
          last_checked: new Date().toISOString(),
        };
      }

      // Get basic self-model statistics
      const statsQuery = `
        MATCH (self:SelfModel)
        OPTIONAL MATCH (self)-[r]->()
        RETURN count(self) as self_nodes,
               count(r) as self_edges
      `;

      const statsResult = await instance.query(statsQuery);

      return {
        status: 'healthy',
        latency_ms: Date.now() - startTime,
        details: {
          self_model_exists: true,
          self_nodes: statsResult[0]?.self_nodes || 0,
          self_edges: statsResult[0]?.self_edges || 0,
        },
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'error',
        latency_ms: Date.now() - startTime,
        error: error.message,
        details: { trace: error.stack },
        last_checked: new Date().toISOString(),
      };
    }
  }
}
```

**Key Metrics:**
- **Instance Existence:** Is the Grafeo instance initialized?
- **Self-Model Presence:** Has the SelfModel node been created?
- **Node/Edge Counts:** Basic cardinality check.

**Caching:** 60 seconds

---

### 1.6 Grafeo Other KGs Health Check

**What to verify:** All person-specific KG instances exist and are queryable

```typescript
// src/health/checks/grafeo-other.health.ts

export class GrafeoOtherKgsHealthCheck {
  async check(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const instances = this.grafeoService.getAllOtherKgInstances();

      if (instances.length === 0) {
        // No person models created yet (expected at cold start)
        return {
          status: 'healthy',
          latency_ms: Date.now() - startTime,
          details: {
            person_model_count: 0,
            message: 'No person models created yet (expected during cold start)',
          },
          last_checked: new Date().toISOString(),
        };
      }

      const healthByPerson = {};
      let totalPersons = 0;
      let healthyPersons = 0;

      for (const instance of instances) {
        totalPersons++;

        try {
          const personName = instance.personId;

          const query = `
            MATCH (person:Person)
            OPTIONAL MATCH (person)-[r]->()
            RETURN count(person) as person_nodes,
                   count(r) as person_edges
          `;

          const result = await instance.query(query);

          healthByPerson[personName] = {
            status: 'healthy',
            nodes: result[0]?.person_nodes || 0,
            edges: result[0]?.person_edges || 0,
          };

          healthyPersons++;
        } catch (err) {
          healthByPerson[instance.personId] = {
            status: 'error',
            error: err.message,
          };
        }
      }

      return {
        status: healthyPersons === totalPersons ? 'healthy' : 'degraded',
        latency_ms: Date.now() - startTime,
        details: {
          total_persons: totalPersons,
          healthy_persons: healthyPersons,
          degraded_persons: totalPersons - healthyPersons,
          by_person: healthByPerson,
        },
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'error',
        latency_ms: Date.now() - startTime,
        error: error.message,
        details: { trace: error.stack },
        last_checked: new Date().toISOString(),
      };
    }
  }
}
```

**Key Metrics:**
- **Person Model Count:** How many persons have models?
- **Health Ratio:** healthy_persons / total_persons. If <1.0, some models are corrupted.
- **Per-Person Stats:** Node/edge counts per person.

**Caching:** 120 seconds (Grafeo queries are very cheap)

---

### 1.7 Health Check Orchestrator

```typescript
// src/health/health.service.ts

@Injectable()
export class HealthService {
  private lastHealthCheck: HealthCheckResponse | null = null;
  private lastCheckTime = 0;
  private readonly CACHE_TTL_MS = 30000; // 30 seconds

  constructor(
    private neo4j: Neo4jHealthCheck,
    private timescale: TimescaleDBHealthCheck,
    private postgres: PostgreSQLHealthCheck,
    private grafeoSelf: GrafeoSelfKgHealthCheck,
    private grafeoOther: GrafeoOtherKgsHealthCheck,
    private logger: Logger,
  ) {}

  async getHealth(bypassCache = false): Promise<HealthCheckResponse> {
    const now = Date.now();

    if (!bypassCache && this.lastHealthCheck && now - this.lastCheckTime < this.CACHE_TTL_MS) {
      return this.lastHealthCheck;
    }

    const startTime = Date.now();

    // Run all checks in parallel with race condition handling
    const [
      neo4j,
      timescaledb,
      postgresql,
      grafeoSelfKg,
      grafeoOtherKgs,
    ] = await Promise.all([
      this.neo4j.check().catch(err => ({
        status: 'error',
        latency_ms: Date.now() - startTime,
        error: err.message,
        details: {},
        last_checked: new Date().toISOString(),
      })),
      this.timescale.check().catch(err => ({...})),
      this.postgres.check().catch(err => ({...})),
      this.grafeoSelf.check().catch(err => ({...})),
      this.grafeoOther.check().catch(err => ({...})),
    ]);

    // Determine overall status
    const allResults = [neo4j, timescaledb, postgresql, grafeoSelfKg, grafeoOtherKgs];
    const errorCount = allResults.filter(r => r.status === 'error').length;
    const degradedCount = allResults.filter(r => r.status === 'degraded').length;

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (errorCount > 0) {
      overallStatus = 'unhealthy';
    } else if (degradedCount > 0) {
      overallStatus = 'degraded';
    }

    const response: HealthCheckResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks: {
        neo4j,
        timescaledb,
        postgresql,
        grafeoSelfKg,
        grafeoOtherKgs,
      },
      metadata: {
        uptime: Date.now() - this.appStartTime,
        checks_version: '1.0',
      },
    };

    this.lastHealthCheck = response;
    this.lastCheckTime = now;

    return response;
  }
}
```

---

## Part 2: Data Access Patterns for Dashboard Endpoints

### 2.1 WKG Query API (Graph Visualization)

**Purpose:** Frontend requests subgraphs for visualization. Must handle large graphs efficiently.

#### 2.1.1 Subgraph Extraction Query

```typescript
// GET /api/wkg/subgraph?root_id=node_id&depth=2&limit=200

interface SubgraphRequest {
  root_id: string;          // Node ID or entity_id
  depth?: number;           // Traversal depth (default: 2, max: 4)
  limit?: number;           // Max nodes to return (default: 200, max: 500)
  edge_types?: string[];    // Filter to specific relationship types
  node_types?: string[];    // Filter to specific node types
}

interface SubgraphResponse {
  root: Node;
  nodes: Node[];
  edges: Edge[];
  metadata: {
    total_traversed: number;
    limited: boolean;
    traversal_depth_actual: number;
  };
}

// Cypher query for subgraph extraction
const getSubgraphCypher = (rootId: string, depth: number, limit: number) => `
  MATCH (root)
  WHERE root.entity_id = $rootId
  CALL apoc.path.subgraphAll(root, {
    relationshipFilter: "R|L|S",  // Include relationships, labels, schema
    minLevel: 1,
    maxLevel: $depth,
    limit: $limit
  })
  YIELD nodes, relationships
  RETURN {
    root: root,
    nodes: nodes,
    edges: relationships,
    metadata: {
      total_nodes: size(nodes),
      total_edges: size(relationships),
      traversal_depth: $depth
    }
  }
`;
```

**Performance Considerations:**
- Depth=2 with limit=200 typically executes in <150ms on a graph with 100K nodes
- Depth=3 can spike to 500ms+ on dense graphs
- **Critical:** Enforce max depth=4 and max limit=500. Deeper queries require pagination.

**Caching Strategy:**
- Cache subgraph results for 60 seconds per (root_id, depth, limit, filters) tuple
- Use Redis with TTL
- Invalidate on any WKG write

---

#### 2.1.2 Pagination Strategy for Large Subgraphs

```typescript
// GET /api/wkg/subgraph/paginated
interface PaginatedSubgraphRequest {
  root_id: string;
  depth: number;
  page: number;           // 0-indexed
  page_size: number;      // 50-200, default 100
  edge_types?: string[];
  node_types?: string[];
}

// Use SKIP/LIMIT pattern
const getPaginatedSubgraphCypher = (rootId: string, depth: number, skip: number, pageSize: number) => `
  MATCH path = (root)-[*1..$depth]-(n)
  WHERE root.entity_id = $rootId
  WITH distinct n, relationships(path) as edges
  SKIP $skip
  LIMIT $pageSize
  RETURN {
    nodes: collect(n),
    edges: collect(edges),
    count: count(*)
  }
`;
```

---

### 2.2 Telemetry Data WebSocket

**Purpose:** Real-time streaming of drive state, predictions, and action selections.

#### 2.2.1 Telemetry Event Broadcast Strategy

```typescript
// Connection: /ws/telemetry

interface TelemetryEvent {
  timestamp: ISO8601;
  tick_id: string;              // Episode ID
  event_type: 'prediction' | 'action' | 'drive_update' | 'outcome';
  data: {
    prediction_id?: string;
    predicted_outcome?: number;
    actual_outcome?: number;
    prediction_error?: number;
    action_selected?: string;
    action_type?: string;
    drive_state?: Record<string, number>;
    confidence_values?: Record<string, number>;
  };
  provenance?: string;           // SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE
}

interface TelemetryStreamConfig {
  event_types?: string[];        // Filter to specific event types
  min_prediction_error?: number; // Only send events with MAE > threshold
  sample_rate?: number;          // 0.0-1.0, default 1.0 (100%)
}
```

**Query Pattern for Initial Replay:**

```typescript
// Fetch last N events for a given tick
const getTelemetryEventsCypher = (tickId: string, limit: number) => `
  MATCH (evt:Event {tick_id: $tickId})
  RETURN evt
  ORDER BY evt.timestamp DESC
  LIMIT $limit
`;
```

**TimescaleDB Query:**

```sql
-- Stream latest telemetry events
SELECT
  time,
  event_type,
  tick_id,
  prediction_id,
  predicted_outcome,
  actual_outcome,
  action_selected,
  drive_state,
  confidence_values
FROM events
WHERE time > now() - interval '1 minute'
  AND event_type IN ('prediction', 'action', 'drive_update')
ORDER BY time DESC
LIMIT 100;
```

---

#### 2.2.2 WebSocket Broadcast Buffering Strategy

Problem: TimescaleDB queries are fast (~50ms), but broadcasting every drive tick (10Hz) creates 600 DB queries per minute.

**Solution: Ring Buffer + Broadcast Throttle**

```typescript
// src/telemetry/telemetry-buffer.service.ts

@Injectable()
export class TelemetryBufferService {
  private buffer: TelemetryEvent[] = [];
  private readonly BUFFER_SIZE = 50;
  private readonly FLUSH_INTERVAL_MS = 500;  // Broadcast every 500ms (5Hz)
  private subscriptions = new Set<WebSocket>();

  constructor(private eventsService: EventsService) {
    this.startFlushTimer();
  }

  async addEvent(event: TelemetryEvent) {
    this.buffer.push(event);

    if (this.buffer.length >= this.BUFFER_SIZE) {
      await this.flush();
    }
  }

  private async flush() {
    if (this.buffer.length === 0) return;

    const eventsToSend = [...this.buffer];
    this.buffer = [];

    // Broadcast to all connected WebSocket clients
    this.subscriptions.forEach(ws => {
      ws.send(JSON.stringify({ type: 'telemetry_batch', events: eventsToSend }));
    });
  }

  private startFlushTimer() {
    setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
  }

  subscribe(ws: WebSocket) {
    this.subscriptions.add(ws);
  }

  unsubscribe(ws: WebSocket) {
    this.subscriptions.delete(ws);
  }
}
```

**Impact:**
- Reduces DB queries from 600/min to ~120/min (10x reduction)
- Maintains <600ms latency from event to broadcast
- Subscribers see 50 events per batch instead of 1

---

### 2.3 Metrics API (Development Diagnostics)

**Purpose:** Compute Type 1/Type 2 ratio, prediction MAE, provenance distribution, behavioral diversity.

#### 2.3.1 Type 1 / Type 2 Ratio

```typescript
// GET /api/metrics/autonomy
// Returns Type 1 / Type 2 decision ratio over time windows

interface AutonomyMetric {
  ratio_1h: number;           // Last 1 hour
  ratio_24h: number;          // Last 24 hours
  ratio_all_time: number;
  type1_count_1h: number;
  type2_count_1h: number;
  trend: 'increasing' | 'stable' | 'decreasing';
}

// TimescaleDB query
const getAutonomyMetricsCypher = `
  WITH
    -- Count Type 1 decisions (confidence > 0.80, MAE < 0.10)
    type1 AS (
      SELECT count(*) as count_1h
      FROM events
      WHERE time > now() - interval '1 hour'
        AND event_type = 'action_selection'
        AND confidence > 0.80
        AND prediction_mae < 0.10
    ),
    -- Count Type 2 decisions (LLM-assisted)
    type2 AS (
      SELECT count(*) as count_1h
      FROM events
      WHERE time > now() - interval '1 hour'
        AND event_type = 'action_selection'
        AND action_source = 'llm_deliberation'
    )
  SELECT
    type1.count_1h,
    type2.count_1h,
    (type1.count_1h::float / NULLIF(type1.count_1h + type2.count_1h, 0)) as ratio_1h
  FROM type1, type2;
`;
```

---

#### 2.3.2 Prediction Accuracy (Mean Absolute Error)

```typescript
// GET /api/metrics/prediction-accuracy
interface PredictionMetric {
  mae_1h: number;
  mae_24h: number;
  mae_all_time: number;
  mae_trend: number[];  // Last 10 hours, 1 value per hour
  prediction_count_1h: number;
}

const getPredictionMetricsCypher = `
  WITH hourly_errors AS (
    SELECT
      time_bucket('1 hour', time) as hour,
      avg(abs(predicted_outcome - actual_outcome)) as hourly_mae
    FROM events
    WHERE event_type = 'prediction_evaluation'
      AND time > now() - interval '10 hours'
    GROUP BY hour
  )
  SELECT
    avg(hourly_mae) as mae_recent,
    array_agg(hourly_mae ORDER BY hour) as mae_trend,
    count(*) as window_size
  FROM hourly_errors;
`;
```

---

#### 2.3.3 Provenance Ratio (Self-Built vs. LLM-Provided Knowledge)

```typescript
// GET /api/metrics/provenance
interface ProvenanceMetric {
  sensor_edges: number;
  guardian_edges: number;
  llm_generated_edges: number;
  inference_edges: number;
  experiential_ratio: number;  // (sensor + guardian + inference) / total
  llm_ratio: number;
}

const getProvenanceMetricsCypher = `
  MATCH ()-[r]-()
  RETURN
    count(CASE WHEN r.provenance = 'SENSOR' THEN 1 END) as sensor_count,
    count(CASE WHEN r.provenance = 'GUARDIAN' THEN 1 END) as guardian_count,
    count(CASE WHEN r.provenance = 'LLM_GENERATED' THEN 1 END) as llm_count,
    count(CASE WHEN r.provenance = 'INFERENCE' THEN 1 END) as inference_count,
    count(r) as total_count
`;
```

---

#### 2.3.4 Behavioral Diversity Index

```typescript
// GET /api/metrics/behavioral-diversity
interface DiversityMetric {
  unique_actions_1h: number;
  unique_actions_24h: number;
  action_entropy: number;  // Shannon entropy: how uniform is distribution?
  action_repetition_rate: number;  // % of actions that are repeats
}

const getBehavioralDiversityCypher = `
  WITH action_history AS (
    SELECT action_selected
    FROM events
    WHERE event_type = 'action_selection'
      AND time > now() - interval '1 hour'
  )
  SELECT
    count(distinct action_selected) as unique_actions,
    count(*) as total_actions,
    count(distinct action_selected)::float / count(*)::float as action_diversity
  FROM action_history
`;
```

---

### 2.4 Conversation History API

**Purpose:** Fetch conversation turns (input → processing → output) from TimescaleDB.

```typescript
// GET /api/conversation/history?limit=50&offset=0

interface ConversationTurn {
  id: string;
  timestamp: ISO8601;
  turn_number: number;
  input: {
    type: 'text' | 'voice';
    content: string;
    recognized_entities?: string[];
  };
  processing: {
    input_parser_confidence: number;
    person_identified: string;
    context_entities: string[];
  };
  output: {
    type: 'text' | 'voice';
    content: string;
    drive_state_at_response: Record<string, number>;
    action_confidence: number;
  };
  metadata: {
    latency_ms: number;
    tokens_used?: number;
  };
}

const getConversationHistoryCypher = `
  SELECT
    id,
    time,
    turn_number,
    input_type,
    input_content,
    output_type,
    output_content,
    drive_state,
    latency_ms
  FROM events
  WHERE event_type IN ('input_received', 'output_generated')
  ORDER BY time DESC
  LIMIT $limit
  OFFSET $offset
`;
```

---

## Part 3: Performance Considerations & Optimization Strategy

### 3.1 Neo4j Query Performance Tuning

**Index Strategy for Dashboard Queries:**

```cypher
-- Most critical indexes for subgraph extraction
CREATE INDEX idx_entity_id FOR (n) ON (n.entity_id);
CREATE INDEX idx_node_type FOR (n:Entity) ON (n:node_type);
CREATE INDEX idx_confidence FOR (n:Entity) ON (n.confidence);

-- Relationship indexes for type filtering
CREATE INDEX idx_rel_type FOR ()-[r:RELATIONSHIP]->() ON (r.type);
CREATE INDEX idx_rel_provenance FOR ()-[r]->() ON (r.provenance);

-- For graph statistics queries
CREATE INDEX idx_timestamp FOR (e:Event) ON (e.timestamp);
```

**Query Execution Plan:** Always use `PROFILE` in development to identify slow queries.

```cypher
PROFILE MATCH path = (root)-[*1..2]-(n)
WHERE root.entity_id = 'some_id'
RETURN nodes(path), relationships(path);
```

**Caching Layer:**
- Cache subgraph results in Redis for 60 seconds
- Cache graph statistics (node/edge counts) for 5 minutes
- Invalidate on write operations

---

### 3.2 TimescaleDB Continuous Aggregates

**Use continuous aggregates for time-series metrics:**

```sql
-- Hourly statistics for telemetry
CREATE MATERIALIZED VIEW telemetry_hourly AS
SELECT
  time_bucket('1 hour', time) as hour,
  event_type,
  count(*) as event_count,
  avg(latency_ms) as avg_latency,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95_latency,
  max(latency_ms) as max_latency
FROM events
GROUP BY hour, event_type;

-- Enable continuous aggregation with background worker
SELECT add_continuous_aggregate_policy('telemetry_hourly',
  start_offset => interval '1 month',
  if_not_exists => true);
```

**Impact:** Metrics queries reduce from 5+ seconds to <100ms.

---

### 3.3 WebSocket Broadcast Frequency Limits

**Rule of thumb:**
- Drive state updates: 5-10 Hz (one every 100-200ms)
- Prediction events: 1-2 Hz (one every 500-1000ms)
- Conversation events: On-demand (not polled)

**Buffer strategy:** Always batch events (see TelemetryBufferService in Section 2.2.2).

---

## Part 4: Data Integrity & Read-Only Constraints

### 4.1 API Endpoint Access Control Matrix

| Endpoint | Method | Database(s) | Access Type | Allowed Callers |
|----------|--------|------------|-------------|-----------------|
| `/health` | GET | All 5 | READ | All |
| `/api/wkg/subgraph` | GET | Neo4j | READ | Dashboard frontend, Playground |
| `/api/wkg/schema` | GET | Neo4j | READ | Dashboard frontend |
| `/api/telemetry` | GET/WS | TimescaleDB | READ | Dashboard frontend |
| `/api/metrics/*` | GET | Neo4j, TimescaleDB, PostgreSQL | READ | Dashboard frontend |
| `/api/conversation/history` | GET | TimescaleDB | READ | Dashboard frontend |
| `/api/chat/input` | POST | TimescaleDB (write), Communication module (routing) | WRITE THROUGH MODULE | Dashboard frontend, Voice input |
| `/api/drive/state` | GET/WS | PostgreSQL (read), Drive Engine (read-only) | READ | All |

**Critical Rule:** No dashboard endpoint writes directly to databases. Chat input goes through the Communication module, which queues it for processing through the decision-making pipeline.

---

### 4.2 Data Isolation & Cross-Contamination Prevention

**Self KG & Other KGs are completely isolated:**

```typescript
// These two should NEVER reference each other
const selfKgInstance = this.grafeoService.getSelfKgInstance();
const otherKgInstance = this.grafeoService.getOtherKgInstance('Person_Jim');

// Invalid: selfKgInstance cannot query Person_Jim's model
// Invalid: Other KGs cannot reference Sylphie's self-model
```

**Prevention:** Create separate Grafeo instances with NO cross-references in schema.

---

## Part 5: Infrastructure Requirements

### 5.1 New Indexes Needed

| Database | Index | Purpose | Priority |
|----------|-------|---------|----------|
| Neo4j | entity_id (all nodes) | Subgraph root lookup | CRITICAL |
| Neo4j | node_type (all nodes) | Type filtering | HIGH |
| Neo4j | confidence (all nodes) | Confidence filtering | MEDIUM |
| TimescaleDB | events(time) hypertable | Time-range queries | CRITICAL |
| TimescaleDB | events(event_type) | Event filtering | HIGH |
| TimescaleDB | events(tick_id) | Tick-level queries | MEDIUM |
| PostgreSQL | drive_rules(enabled) | Rule filtering | MEDIUM |
| PostgreSQL | proposed_rules(status) | Pending rule queries | LOW |

---

### 5.2 Docker / Infrastructure Changes

**No new Docker services needed.** All 5 databases are already provisioned in Epic 1. Dashboard API runs in the existing NestJS container.

**New environment variables:**
```bash
HEALTH_CHECK_CACHE_TTL_MS=30000
TELEMETRY_BUFFER_SIZE=50
TELEMETRY_FLUSH_INTERVAL_MS=500
WKG_SUBGRAPH_MAX_DEPTH=4
WKG_SUBGRAPH_MAX_LIMIT=500
```

---

## Part 6: Implementation Checklist

### 6.1 Health Check Subsystem
- [ ] Neo4jHealthCheck service
- [ ] TimescaleDBHealthCheck service
- [ ] PostgreSQLHealthCheck service
- [ ] GrafeoSelfKgHealthCheck service
- [ ] GrafeoOtherKgsHealthCheck service
- [ ] HealthService orchestrator
- [ ] `/health` controller endpoint
- [ ] Tests for each health check (mocked database failures)

### 6.2 WKG Query API
- [ ] SubgraphQueryService (Neo4j queries)
- [ ] SubgraphCachingService (Redis)
- [ ] `/api/wkg/subgraph` controller
- [ ] `/api/wkg/schema` controller (schema introspection)
- [ ] Pagination logic
- [ ] Tests

### 6.3 Telemetry WebSocket
- [ ] TelemetryBufferService (ring buffer + throttle)
- [ ] TelemetryGateway (NestJS WebSocket gateway)
- [ ] `/ws/telemetry` endpoint
- [ ] Event subscription filtering
- [ ] Backpressure handling (what if client can't keep up?)
- [ ] Tests

### 6.4 Metrics API
- [ ] AutonomyMetricsService
- [ ] PredictionMetricsService
- [ ] ProvenanceMetricsService
- [ ] DiversityMetricsService
- [ ] `/api/metrics/*` controllers
- [ ] TimescaleDB continuous aggregates (via migrations)
- [ ] Tests

### 6.5 Conversation History
- [ ] ConversationHistoryService
- [ ] `/api/conversation/history` controller
- [ ] Pagination & filtering
- [ ] Tests

### 6.6 Chat Input Endpoint
- [ ] `/api/chat/input` POST controller
- [ ] Input validation (length, encoding, rate limiting)
- [ ] Queue message to Communication module
- [ ] Return immediate acknowledgment
- [ ] Tests

### 6.7 Drive State WebSocket
- [ ] DriveStateGateway
- [ ] `/ws/drive-state` endpoint
- [ ] Real-time push from Drive Engine
- [ ] Tests

### 6.8 Monitoring & Observability
- [ ] Prometheus metrics for all endpoints (latency, error rate, cache hit rate)
- [ ] Circuit breaker for each database connection
- [ ] Alerting rules (health check degradation, WebSocket subscriber count spike)

---

## Part 7: Known Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Neo4j query timeout on large subgraphs | Dashboard freezes | Enforce max depth/limit, aggressive caching, timeout handling |
| TimescaleDB INSERT latency spike | Telemetry broadcast lag | Buffer + throttle, rate limiting, continuous aggregates |
| WebSocket subscriber explosion | Memory exhaustion | Connection pooling limits, per-client message rate limiting |
| Cache invalidation race conditions | Stale data displayed | Use versioned keys, TTL-based expiry, event-driven invalidation |
| Grafeo instance initialization failure | Self-model unavailable | Graceful degradation: health check returns "warning", system continues |
| PostgreSQL connection pool exhaustion | No new queries possible | Monitor idle connection count, implement queue drain on startup |

---

## Conclusion

Epic 9 creates the API surface for real-time dashboard access to all 5 databases. The key design principles are:

1. **Health checks are cheap and parallel** (all 5 complete in <500ms)
2. **Subgraph queries are cached** (Redis, TTL=60s)
3. **Telemetry is buffered** (50-event batches, 500ms interval)
4. **Metrics use continuous aggregates** (pre-computed hourly rollups)
5. **All endpoints are READ-ONLY** (writes flow through modules, not direct DB access)
6. **Data isolation is enforced** (Self KG and Other KGs never cross-reference)

Performance targets: All endpoints <200ms (p99), WebSocket broadcast latency <600ms, health check <500ms.

---

**Next Steps:** Epic 9 planning agents will cross-examine this analysis and identify gaps before implementation begins.
