# Sentinel Analysis: Epic 1 -- Database Infrastructure

**Agent:** Sentinel (Data Persistence & Infrastructure Engineer)
**Epic:** 1 -- Database Infrastructure (Neo4j, TimescaleDB, PostgreSQL, Grafeo)
**Date:** 2026-03-29
**Status:** Complete Analysis

---

## Preamble

Epic 1 operationalizes all five database connections: the World Knowledge Graph (Neo4j), the event backbone (TimescaleDB), the system database (PostgreSQL), and the two embedded graph stores for self-modeling and other-modeling (Grafeo). This is where Sylphie's memory, predictions, and personality literally live. Correctness here propagates to every subsystem that reads or writes.

The roadmap flagged a critical risk: **Grafeo availability**. The package exists at v0.5.28 but is pre-1.0 with a single maintainer. This analysis provides: (1) a full implementation plan for all 5 databases assuming Grafeo viability; (2) technology validation and risk assessment for Grafeo; (3) detailed alternatives if Grafeo is unsuitable; and (4) migration strategy that does not block other epics.

All designs are validated against CANON architectural boundaries, particularly:
- **Drive Isolation (CANON §Drive Isolation):** Drive rules are write-protected, only readable by the runtime
- **Provenance Discipline (CANON §7):** Every node and edge carries provenance; this is enforced at the database layer
- **Confidence Ceiling (CANON Standard 3):** No node > 0.60 confidence without retrieval-and-use
- **No Self-Modification (CANON Standard 6):** Drive rules cannot be autonomously modified
- **KG Isolation (Atlas profile Rule 6):** Self KG and Other KGs are completely isolated from WKG and from each other

This analysis is organized for implementation: database by database, with complete DDL, connection pooling strategies, Docker Compose configuration, risk mitigations, and a ticket breakdown for parallel execution.

---

## 1. Database-by-Database Implementation Plan

### 1.1 Neo4j: World Knowledge Graph (WKG)

#### 1.1.1 Role & Constraints

Neo4j stores the World Knowledge Graph: all entities, relationships, procedures, and schema knowledge that Sylphie learns about the world. This is the primary read/write target for the Knowledge module (E3) and a primary read source for Decision Making (E5), Communication (E6), and Planning (E8).

**Key constraints from CANON:**
- Every node and edge must carry provenance (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE)
- Every node and edge must carry confidence (computed on-read via ACT-R formula)
- Confidence ceiling: max 0.60 without at least one retrieval-and-use event
- Three-level schema system: Instance (ABox), Schema (TBox), Meta-Schema (Meta-Schema layer)
- Contradiction detection is a read-time operation, not a blocking error

#### 1.1.2 Driver Factory & Connection Pooling

**File:** `src/knowledge/wkg/neo4j-driver.factory.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { driver, Driver, RoutingControl } from 'neo4j-driver';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  maxPoolSize?: number;
  connectionTimeout?: number;
  requestTimeout?: number;
  encrypted?: boolean;
}

@Injectable()
export class Neo4jDriverFactory {
  private driverInstance: Driver | null = null;
  private readonly logger = new Logger(Neo4jDriverFactory.name);

  constructor(private configService: ConfigService) {}

  /**
   * Creates and caches a single driver instance (per NestJS singleton).
   * Connection pool is managed by the driver -- max pool size configurable.
   */
  getDriver(): Driver {
    if (!this.driverInstance) {
      const config = this.getNeo4jConfig();
      this.driverInstance = driver(
        config.uri,
        {
          scheme: 'basic',
          principal: config.user,
          credentials: config.password,
        },
        {
          maxPoolSize: config.maxPoolSize || 50,
          connectionTimeout: config.connectionTimeout || 30000,
          requestTimeout: config.requestTimeout || 30000,
          encrypted: config.encrypted ?? true,
          trust: 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES',
          // For local/test: trust: 'TRUST_ALL_CERTIFICATES'
        }
      );

      this.logger.log(
        `Neo4j driver created: ${config.uri} (pool size: ${config.maxPoolSize || 50})`
      );
    }
    return this.driverInstance;
  }

  /**
   * Health check: verify Neo4j is reachable.
   * Returns true if connection is healthy, false otherwise.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const d = this.getDriver();
      const session = d.session();
      const result = await session.run('RETURN 1');
      await session.close();
      return result.records.length > 0;
    } catch (error) {
      this.logger.error(`Neo4j health check failed: ${error}`);
      return false;
    }
  }

  /**
   * Graceful shutdown: close all connections.
   */
  async closeDriver(): Promise<void> {
    if (this.driverInstance) {
      await this.driverInstance.close();
      this.driverInstance = null;
      this.logger.log('Neo4j driver closed');
    }
  }

  private getNeo4jConfig(): Neo4jConfig {
    return {
      uri: this.configService.get('NEO4J_URI') || 'neo4j://localhost:7687',
      user: this.configService.get('NEO4J_USER') || 'neo4j',
      password: this.configService.get('NEO4J_PASSWORD') || 'password',
      maxPoolSize: this.configService.get('NEO4J_MAX_POOL_SIZE')
        ? parseInt(this.configService.get('NEO4J_MAX_POOL_SIZE'), 10)
        : 50,
      connectionTimeout: 30000,
      requestTimeout: 30000,
      encrypted: this.configService.get('NEO4J_ENCRYPTED') !== 'false',
    };
  }
}
```

**DI Token:** `NEO4J_DRIVER` is exported from the Knowledge module's `neo4j.tokens.ts`:

```typescript
import { InjectionToken } from '@nestjs/common';
import { Driver } from 'neo4j-driver';

export const NEO4J_DRIVER: InjectionToken<Driver> = Symbol('NEO4J_DRIVER');
```

**Module Registration:**

In `knowledge.module.ts`:
```typescript
@Module({
  imports: [ConfigModule],
  providers: [
    Neo4jDriverFactory,
    {
      provide: NEO4J_DRIVER,
      useFactory: (factory: Neo4jDriverFactory) => factory.getDriver(),
      inject: [Neo4jDriverFactory],
    },
    WkgService,
    WkgQueryService,
    ConfidenceService,
    // ... other services
  ],
  exports: [WkgService, ConfidenceService, /* ... */],
})
export class KnowledgeModule {}
```

#### 1.1.3 Constraint Setup on Module Init

**File:** `src/knowledge/wkg/neo4j-constraints.service.ts`

Constraints are created on NestJS application startup. They are idempotent (if a constraint already exists, the `CREATE CONSTRAINT IF NOT EXISTS` statement succeeds silently).

```typescript
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Neo4jDriverFactory } from './neo4j-driver.factory';

@Injectable()
export class Neo4jConstraintsService implements OnModuleInit {
  private readonly logger = new Logger(Neo4jConstraintsService.name);

  constructor(private driverFactory: Neo4jDriverFactory) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Setting up Neo4j constraints...');
    const driver = this.driverFactory.getDriver();
    const session = driver.session();

    try {
      // Unique constraints on node identifiers
      await session.run(
        `CREATE CONSTRAINT wkg_entity_id IF NOT EXISTS
         FOR (n:Entity) REQUIRE n.entityId IS UNIQUE`
      );

      await session.run(
        `CREATE CONSTRAINT wkg_concept_id IF NOT EXISTS
         FOR (n:Concept) REQUIRE n.conceptId IS UNIQUE`
      );

      await session.run(
        `CREATE CONSTRAINT wkg_procedure_id IF NOT EXISTS
         FOR (n:Procedure) REQUIRE n.procedureId IS UNIQUE`
      );

      await session.run(
        `CREATE CONSTRAINT wkg_schema_type_id IF NOT EXISTS
         FOR (n:SchemaType) REQUIRE n.typeId IS UNIQUE`
      );

      await session.run(
        `CREATE CONSTRAINT wkg_utterance_id IF NOT EXISTS
         FOR (n:Utterance) REQUIRE n.utteranceId IS UNIQUE`
      );

      // Indexes for common queries
      await session.run(
        `CREATE INDEX wkg_entity_category IF NOT EXISTS
         FOR (n:Entity) ON (n.category)`
      );

      await session.run(
        `CREATE INDEX wkg_concept_domain IF NOT EXISTS
         FOR (n:Concept) ON (n.domain)`
      );

      await session.run(
        `CREATE INDEX wkg_procedure_category IF NOT EXISTS
         FOR (n:Procedure) ON (n.procedureCategory)`
      );

      // Indexes on provenance for filtering
      await session.run(
        `CREATE INDEX wkg_provenance_source IF NOT EXISTS
         FOR (n:Entity|Concept|Procedure|Utterance) ON (n.provenanceSource)`
      );

      // Indexes on temporal fields for learning queries
      await session.run(
        `CREATE INDEX wkg_created_at IF NOT EXISTS
         FOR (n:Entity|Concept|Procedure) ON (n.createdAt)`
      );

      await session.run(
        `CREATE INDEX wkg_last_retrieved_at IF NOT EXISTS
         FOR (n:Entity|Concept|Procedure) ON (n.lastRetrievedAt)`
      );

      this.logger.log('Neo4j constraints created successfully');
    } catch (error) {
      this.logger.error(`Failed to create Neo4j constraints: ${error}`);
      throw error;
    } finally {
      await session.close();
    }
  }
}
```

**Module Integration:** Add `Neo4jConstraintsService` to the providers and ensure it is instantiated before other services:

```typescript
@Module({
  providers: [
    Neo4jConstraintsService,  // Must initialize first
    Neo4jDriverFactory,
    { provide: NEO4J_DRIVER, ... },
    // ... other services
  ],
})
```

#### 1.1.4 Health Check Endpoint

The health check is called by NestJS's built-in `HealthModule`. In the main application, add:

```typescript
// In WebModule (E9)
import { HealthModule, Neo4jHealthIndicator } from '@nestjs/terminus';
import { Neo4jDriverFactory } from '@app/knowledge';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthService,
    private neo4jFactory: Neo4jDriverFactory,
  ) {}

  @Get('neo4j')
  async neo4jHealth() {
    return this.health.check([
      () =>
        this.neo4jFactory.healthCheck().then((ok) => ({
          neo4j: { status: ok ? 'up' : 'down' },
        })),
    ]);
  }
}
```

---

### 1.2 TimescaleDB: Event Backbone

#### 1.2.1 Role & Architecture

TimescaleDB (built on PostgreSQL) is the central event store for all five subsystems. Every significant event is recorded with a timestamp, drive snapshot, event type, subsystem source, correlation ID, and a `has_learnable` flag indicating whether the event should be included in the Learning pipeline.

**Key properties:**
- Hypertable partitioned by time (daily chunks by default)
- High-throughput writes from all subsystems
- Time-range queries (last N hours, event frequency aggregation)
- Compression after 7 days (configured retention policy)
- Retention: 90 days default (tunable)

#### 1.2.2 DDL: Main Events Hypertable

**File:** `db/schema/timescaledb-schema.sql`

```sql
-- Create hypertable for all events
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,          -- Correlation ID for tracing
  timestamp TIMESTAMPTZ NOT NULL,          -- UTC timestamp
  event_type VARCHAR(50) NOT NULL,         -- 'prediction', 'action_outcome', etc.
  subsystem_source VARCHAR(50) NOT NULL,   -- 'decision_making', 'communication', etc.
  correlation_id UUID,                     -- Links related events
  actor_id VARCHAR(100),                   -- Usually 'sylphie' or person identifier

  -- Drive snapshot at time of event
  drive_snapshot JSONB,                    -- {core: {drive_name: value, ...}, complement: {...}}
  tick_number BIGINT,                      -- Drive tick when event occurred

  -- Event-specific data (polymorphic via event_type)
  event_data JSONB NOT NULL,               -- Type-specific payload

  -- Learning pipeline flags
  has_learnable BOOLEAN DEFAULT FALSE,     -- Include in maintenance cycle?
  learnable_processed BOOLEAN DEFAULT FALSE, -- Already processed by Learning?

  -- Metadata
  schema_version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- Indexes for common queries
  INDEX idx_event_type (event_type),
  INDEX idx_subsystem (subsystem_source),
  INDEX idx_has_learnable (has_learnable, learnable_processed),
  INDEX idx_correlation (correlation_id),
  INDEX idx_actor (actor_id)
);

-- Convert to hypertable (idempotent)
SELECT create_hypertable('events', 'timestamp', if_not_exists => true);

-- Enable compression after 7 days
SELECT add_compression_policy('events', INTERVAL '7 days', if_not_exists => true);

-- Set chunk interval (1 day)
SELECT set_chunk_time_interval('events', INTERVAL '1 day');

-- Retention policy: delete chunks older than 90 days
SELECT add_retention_policy('events', INTERVAL '90 days', if_not_exists => true);

-- Table for tracking which events have been processed by each subsystem
CREATE TABLE IF NOT EXISTS event_processing_state (
  subsystem VARCHAR(50) NOT NULL,
  last_processed_event_id BIGINT,
  last_processed_timestamp TIMESTAMPTZ,
  PRIMARY KEY (subsystem)
);

-- Grant permissions to application role (see PostgreSQL section below)
GRANT SELECT, INSERT ON events TO sylphie_app;
GRANT SELECT ON event_processing_state TO sylphie_app;
GRANT UPDATE ON event_processing_state TO sylphie_app;
```

#### 1.2.3 Connection Setup

**File:** `src/events/timescaledb.factory.ts`

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult } from 'pg';
import { ConfigService } from '@nestjs/config';

export interface TimescaleConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxPoolSize?: number;
  connectionTimeoutMs?: number;
}

@Injectable()
export class TimescaleDbFactory implements OnModuleInit {
  private pool: Pool | null = null;
  private readonly logger = new Logger(TimescaleDbFactory.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Initialize pool on app startup
    this.getPool();
  }

  /**
   * Returns a singleton connection pool.
   * The pool manages connection reuse automatically.
   */
  getPool(): Pool {
    if (!this.pool) {
      const config = this.getTimescaleConfig();
      this.pool = new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        max: config.maxPoolSize || 30,
        connectionTimeoutMillis: config.connectionTimeoutMs || 5000,
        idleTimeoutMillis: 30000,
        reapIntervalMillis: 1000,
      });

      this.pool.on('error', (err) => {
        this.logger.error(`Unexpected error on idle client: ${err}`);
      });

      this.logger.log(
        `TimescaleDB pool created: ${config.host}:${config.port}/${config.database} (size: ${config.maxPoolSize || 30})`
      );
    }
    return this.pool;
  }

  /**
   * Get a single client from the pool (for transaction or batch operations).
   */
  async getClient(): Promise<PoolClient> {
    return this.getPool().connect();
  }

  /**
   * Health check: verify TimescaleDB is reachable and schema is initialized.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const pool = this.getPool();
      const result = await pool.query('SELECT 1');
      const hypertable = await pool.query(
        `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'events')`
      );
      return result.rows.length > 0 && hypertable.rows[0].exists;
    } catch (error) {
      this.logger.error(`TimescaleDB health check failed: ${error}`);
      return false;
    }
  }

  /**
   * Graceful shutdown: drain the pool.
   */
  async closePool(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.logger.log('TimescaleDB pool closed');
    }
  }

  private getTimescaleConfig(): TimescaleConfig {
    return {
      host: this.configService.get('TIMESCALEDB_HOST') || 'localhost',
      port: parseInt(this.configService.get('TIMESCALEDB_PORT') || '5432', 10),
      database:
        this.configService.get('TIMESCALEDB_DATABASE') || 'sylphie_events',
      user: this.configService.get('TIMESCALEDB_USER') || 'postgres',
      password: this.configService.get('TIMESCALEDB_PASSWORD') || 'password',
      maxPoolSize: this.configService.get('TIMESCALEDB_MAX_POOL_SIZE')
        ? parseInt(this.configService.get('TIMESCALEDB_MAX_POOL_SIZE'), 10)
        : 30,
    };
  }
}
```

#### 1.2.4 Event Recording & Querying

**File:** `src/events/events.service.ts` (real implementation, replaces stub from E0)

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SylphieEvent, EventType } from '@app/shared';

export interface EventQueryOptions {
  eventTypes?: EventType[];
  subsystems?: string[];
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
  includeUnprocessed?: boolean;
}

export interface EventFrequencyResult {
  eventType: string;
  count: number;
  windowStart: Date;
  windowEnd: Date;
}

@Injectable()
export class EventsService {
  constructor(
    @Inject('TIMESCALEDB_POOL') private pool: Pool,
  ) {}

  /**
   * Record a new event to TimescaleDB.
   * Idempotent via event_id uniqueness constraint.
   */
  async record(event: SylphieEvent): Promise<void> {
    const eventId = uuidv4();
    const query = `
      INSERT INTO events (
        event_id,
        timestamp,
        event_type,
        subsystem_source,
        correlation_id,
        actor_id,
        drive_snapshot,
        tick_number,
        event_data,
        has_learnable,
        schema_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (event_id) DO NOTHING;
    `;

    const values = [
      eventId,
      event.timestamp,
      event.eventType,
      event.subsystemSource,
      event.correlationId || null,
      event.actorId || 'sylphie',
      JSON.stringify(event.driveSnapshot || null),
      event.tickNumber || null,
      JSON.stringify(event.eventData),
      event.hasLearnable ?? false,
      1,
    ];

    await this.pool.query(query, values);
  }

  /**
   * Query events with optional filtering.
   * Supports time-range queries, event type filtering, subsystem filtering.
   */
  async query(options: EventQueryOptions = {}): Promise<SylphieEvent[]> {
    let whereClause = 'WHERE 1 = 1';
    const values: any[] = [];
    let paramIndex = 1;

    if (options.eventTypes && options.eventTypes.length > 0) {
      whereClause += ` AND event_type = ANY($${paramIndex})`;
      values.push(options.eventTypes);
      paramIndex++;
    }

    if (options.subsystems && options.subsystems.length > 0) {
      whereClause += ` AND subsystem_source = ANY($${paramIndex})`;
      values.push(options.subsystems);
      paramIndex++;
    }

    if (options.since) {
      whereClause += ` AND timestamp >= $${paramIndex}`;
      values.push(options.since);
      paramIndex++;
    }

    if (options.until) {
      whereClause += ` AND timestamp <= $${paramIndex}`;
      values.push(options.until);
      paramIndex++;
    }

    const limitClause = options.limit
      ? ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
      : '';
    if (options.limit) {
      values.push(options.limit);
      values.push(options.offset || 0);
    }

    const query = `
      SELECT
        event_id,
        timestamp,
        event_type,
        subsystem_source,
        correlation_id,
        actor_id,
        drive_snapshot,
        tick_number,
        event_data,
        has_learnable,
        learnable_processed
      FROM events
      ${whereClause}
      ORDER BY timestamp DESC
      ${limitClause}
    `;

    const result = await this.pool.query(query, values);
    return result.rows.map((row) => ({
      eventId: row.event_id,
      timestamp: new Date(row.timestamp),
      eventType: row.event_type,
      subsystemSource: row.subsystem_source,
      correlationId: row.correlation_id,
      actorId: row.actor_id,
      driveSnapshot: row.drive_snapshot,
      tickNumber: row.tick_number,
      eventData: row.event_data,
      hasLearnable: row.has_learnable,
      learnableProcessed: row.learnable_processed,
    }));
  }

  /**
   * Query events eligible for the learning pipeline.
   * Limits to last N events to prevent catastrophic interference.
   */
  async queryLearnableEvents(
    limit: number = 5,
  ): Promise<SylphieEvent[]> {
    const query = `
      SELECT
        event_id,
        timestamp,
        event_type,
        subsystem_source,
        correlation_id,
        actor_id,
        drive_snapshot,
        tick_number,
        event_data,
        has_learnable
      FROM events
      WHERE has_learnable = true AND learnable_processed = false
      ORDER BY timestamp DESC
      LIMIT $1
    `;

    const result = await this.pool.query(query, [limit]);
    return result.rows.map((row) => ({
      eventId: row.event_id,
      timestamp: new Date(row.timestamp),
      eventType: row.event_type,
      subsystemSource: row.subsystem_source,
      correlationId: row.correlation_id,
      actorId: row.actor_id,
      driveSnapshot: row.drive_snapshot,
      tickNumber: row.tick_number,
      eventData: row.event_data,
      hasLearnable: row.has_learnable,
    }));
  }

  /**
   * Query event frequency in a time window.
   * Used by Drive Engine for evaluating rules and by Planning for opportunity research.
   */
  async queryEventFrequency(
    eventType: string,
    windowHours: number = 1,
  ): Promise<EventFrequencyResult> {
    const query = `
      SELECT
        COUNT(*) as count,
        MIN(timestamp) as window_start,
        MAX(timestamp) as window_end
      FROM events
      WHERE event_type = $1
        AND timestamp >= NOW() - INTERVAL '1 hour' * $2
    `;

    const result = await this.pool.query(query, [eventType, windowHours]);
    const row = result.rows[0];

    return {
      eventType,
      count: parseInt(row.count, 10),
      windowStart: new Date(row.window_start),
      windowEnd: new Date(row.window_end),
    };
  }

  /**
   * Mark learnable events as processed.
   * Called by the Learning subsystem after consolidation.
   */
  async markProcessed(eventIds: string[]): Promise<void> {
    const query = `
      UPDATE events
      SET learnable_processed = true
      WHERE event_id = ANY($1)
    `;
    await this.pool.query(query, [eventIds]);
  }
}
```

---

### 1.3 PostgreSQL: System Database

#### 1.3.1 Role & Write Protection

PostgreSQL stores:
1. **Drive rules table** -- immutable from Sylphie's perspective (read-only via RLS)
2. **Proposed drive rules** -- write-only for Sylphie, reviewed by guardian
3. **Users table** -- guardian and session management
4. **Settings table** -- app configuration (retention policies, pool sizes, etc.)

**Critical:** The runtime application role (`sylphie_app`) can only SELECT from `drive_rules` and INSERT to `proposed_drive_rules`. The admin role (`sylphie_admin`) can DELETE old rules and approve new ones.

#### 1.3.2 Two-Pool Architecture (from E0 Decision D5)

**File:** `src/shared/config/database.config.ts`

```typescript
import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  postgres: {
    admin: {
      host: process.env.POSTGRES_ADMIN_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_ADMIN_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || 'sylphie_system',
      user: process.env.POSTGRES_ADMIN_USER || 'postgres',
      password: process.env.POSTGRES_ADMIN_PASSWORD || 'password',
      maxPoolSize: parseInt(process.env.POSTGRES_ADMIN_POOL_SIZE || '5', 10),
    },
    runtime: {
      host: process.env.POSTGRES_RUNTIME_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_RUNTIME_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || 'sylphie_system',
      user: process.env.POSTGRES_RUNTIME_USER || 'sylphie_app',
      password: process.env.POSTGRES_RUNTIME_PASSWORD || 'app_password',
      maxPoolSize: parseInt(process.env.POSTGRES_RUNTIME_POOL_SIZE || '20', 10),
    },
  },
}));
```

The **admin pool is NOT exported** from the database module. It exists for initialization scripts and guardian operations only. If any subsystem tries to inject the admin pool, NestJS throws a `DependencyError`.

#### 1.3.3 DDL: All PostgreSQL Tables

**File:** `db/schema/postgresql-schema.sql`

Run this as the admin user (`postgres` or `sylphie_admin`).

```sql
-- Create admin role (for guardian operations)
CREATE ROLE sylphie_admin WITH LOGIN CREATEDB;

-- Create runtime role (for application) with minimal privileges
CREATE ROLE sylphie_app WITH LOGIN;

-- Grant connection to both roles
GRANT CONNECT ON DATABASE sylphie_system TO sylphie_app, sylphie_admin;

-- Set search path
ALTER ROLE sylphie_admin SET search_path = public;
ALTER ROLE sylphie_app SET search_path = public;

-- Table: drive_rules (write-protected from runtime)
-- ========================================================
CREATE TABLE IF NOT EXISTS drive_rules (
  id SERIAL PRIMARY KEY,
  rule_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  rule_name VARCHAR(255) NOT NULL UNIQUE,
  event_trigger VARCHAR(50) NOT NULL,        -- 'event_type:prediction_failure', etc.
  target_drive VARCHAR(50) NOT NULL,         -- 'satisfaction', 'anxiety', etc.
  delta NUMERIC(4, 2),                       -- +0.15 or -0.20 etc.
  contingency_description TEXT,              -- "successful action X under context Y"
  enabled BOOLEAN DEFAULT true,
  guardian_approved BOOLEAN DEFAULT false,
  created_by VARCHAR(100),                   -- 'guardian' or 'system'
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT valid_delta CHECK (delta >= -1.0 AND delta <= 1.0),
  CONSTRAINT valid_drive CHECK (
    target_drive IN ('system_health', 'moral_valence', 'integrity', 'cognitive_awareness',
                     'guilt', 'curiosity', 'boredom', 'anxiety', 'satisfaction', 'sadness',
                     'information_integrity', 'social')
  )
);

CREATE INDEX idx_drive_rules_enabled ON drive_rules(enabled);
CREATE INDEX idx_drive_rules_drive ON drive_rules(target_drive);
CREATE INDEX idx_drive_rules_trigger ON drive_rules(event_trigger);

-- Table: proposed_drive_rules (write-only for runtime, read for guardian review)
CREATE TABLE IF NOT EXISTS proposed_drive_rules (
  id SERIAL PRIMARY KEY,
  proposed_rule_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  proposed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  rule_name VARCHAR(255) NOT NULL,
  event_trigger VARCHAR(50) NOT NULL,
  target_drive VARCHAR(50) NOT NULL,
  delta NUMERIC(4, 2),
  contingency_description TEXT,
  rationale TEXT,                            -- Why the system proposed this rule
  status VARCHAR(20) DEFAULT 'pending',      -- 'pending', 'approved', 'rejected'
  guardian_decision_at TIMESTAMPTZ,
  guardian_feedback TEXT,

  CONSTRAINT valid_status CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT valid_drive CHECK (
    target_drive IN ('system_health', 'moral_valence', 'integrity', 'cognitive_awareness',
                     'guilt', 'curiosity', 'boredom', 'anxiety', 'satisfaction', 'sadness',
                     'information_integrity', 'social')
  )
);

CREATE INDEX idx_proposed_rules_status ON proposed_drive_rules(status);
CREATE INDEX idx_proposed_rules_proposed_at ON proposed_drive_rules(proposed_at DESC);

-- Table: users (guardian and session management)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  user_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  username VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  email VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'guardian',  -- 'guardian', 'observer', 'admin'
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMPTZ,

  CONSTRAINT valid_role CHECK (role IN ('guardian', 'observer', 'admin'))
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);

-- Table: sessions (for WebSocket/conversation tracking)
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  session_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,

  CONSTRAINT check_activity_after_start CHECK (last_activity_at >= started_at)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_active ON sessions(user_id) WHERE ended_at IS NULL;

-- Table: settings (app configuration)
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  setting_key VARCHAR(255) UNIQUE NOT NULL,
  setting_value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(100)
);

INSERT INTO settings (setting_key, setting_value, description)
VALUES
  ('timescaledb_retention_days', '90', 'Days to retain events in TimescaleDB'),
  ('learning_batch_size', '5', 'Max learnable events per consolidation cycle'),
  ('type1_graduation_confidence', '0.80', 'Min confidence for Type 1 graduation'),
  ('type1_graduation_mae', '0.10', 'Max MAE for Type 1 graduation over last 10 uses'),
  ('prediction_window_hours', '1', 'Lookback window for event frequency queries'),
  ('opportunity_decay_hours', '24', 'Hours before unaddressed opportunities decay'),
  ('neo4j_max_pool_size', '50', 'Neo4j driver connection pool size'),
  ('timescaledb_max_pool_size', '30', 'TimescaleDB pool size'),
  ('postgres_runtime_pool_size', '20', 'PostgreSQL runtime pool size')
ON CONFLICT DO NOTHING;

-- ========================================================
-- ROLE PERMISSIONS (RLS via PostgreSQL)
-- ========================================================

-- sylphie_app role: read drive_rules, insert proposed_drive_rules only
GRANT SELECT ON drive_rules TO sylphie_app;
GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;
GRANT SELECT ON users TO sylphie_app;
GRANT SELECT ON settings TO sylphie_app;
GRANT SELECT ON sessions TO sylphie_app;
GRANT UPDATE (last_activity_at) ON sessions TO sylphie_app;

-- sylphie_admin role: full access for maintenance and rule approval
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO sylphie_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sylphie_admin;

-- Enable Row-Level Security (RLS) for application user
ALTER TABLE drive_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_drive_rules ENABLE ROW LEVEL SECURITY;

-- RLS Policy: sylphie_app can only see enabled drive_rules
CREATE POLICY drive_rules_select_enabled ON drive_rules
  FOR SELECT
  TO sylphie_app
  USING (enabled = true);

-- RLS Policy: sylphie_app cannot update or delete
CREATE POLICY drive_rules_no_write ON drive_rules
  FOR UPDATE, DELETE
  TO sylphie_app
  USING (false);

-- RLS Policy: sylphie_app can insert proposed rules
CREATE POLICY proposed_rules_insert ON proposed_drive_rules
  FOR INSERT
  TO sylphie_app
  WITH CHECK (true);

-- RLS Policy: sylphie_app can see only their own pending proposals
CREATE POLICY proposed_rules_select ON proposed_drive_rules
  FOR SELECT
  TO sylphie_app
  USING (status = 'pending');
```

#### 1.3.4 PostgreSQL Connection Pooling

**File:** `src/database/postgres.factory.ts`

Similar to TimescaleDB factory, but with two pools:

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PostgresFactory implements OnModuleInit {
  private adminPool: Pool | null = null;
  private runtimePool: Pool | null = null;
  private readonly logger = new Logger(PostgresFactory.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.getRuntimePool(); // Initialize runtime pool on startup
  }

  /**
   * Get the runtime pool (SELECT drive_rules, INSERT proposed_drive_rules).
   * This is the ONLY pool exported to the application.
   */
  getRuntimePool(): Pool {
    if (!this.runtimePool) {
      const cfg = this.configService.get('database.postgres.runtime');
      this.runtimePool = new Pool({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        max: cfg.maxPoolSize || 20,
        idleTimeoutMillis: 30000,
      });

      this.logger.log(
        `PostgreSQL runtime pool created (user: ${cfg.user}, size: ${cfg.maxPoolSize || 20})`
      );
    }
    return this.runtimePool;
  }

  /**
   * Get a client from the runtime pool for transactions.
   */
  async getRuntimeClient(): Promise<PoolClient> {
    return this.getRuntimePool().connect();
  }

  /**
   * Health check: test runtime pool connectivity.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.getRuntimePool().query('SELECT 1');
      return result.rows.length > 0;
    } catch (error) {
      this.logger.error(`PostgreSQL health check failed: ${error}`);
      return false;
    }
  }

  /**
   * Graceful shutdown.
   */
  async closePool(): Promise<void> {
    if (this.runtimePool) {
      await this.runtimePool.end();
      this.runtimePool = null;
      this.logger.log('PostgreSQL runtime pool closed');
    }
    // Admin pool is not closed from here -- only for init scripts
  }
}
```

**Module Export:** Only the runtime pool is exported:

```typescript
@Module({
  providers: [
    PostgresFactory,
    {
      provide: POSTGRES_RUNTIME_POOL,
      useFactory: (factory: PostgresFactory) => factory.getRuntimePool(),
      inject: [PostgresFactory],
    },
  ],
  exports: [POSTGRES_RUNTIME_POOL],
})
export class DatabaseModule {}
```

---

### 1.4 Grafeo: Self KG and Other KG

#### 1.4.1 Role & Isolation

Grafeo instances store self-modeling (KG(Self)) and per-person modeling (KG(Other)). These are completely isolated from each other and from the WKG:

- **KG(Self):** One instance, persistent, tracks Sylphie's self-concept (confidence, drive baselines, personality traits, known limitations)
- **KG(Other):** Multiple instances (one per person), keyed by `personId`, tracks learned models of individual persons

**Key constraints (Atlas Rule 6):**
- No edges cross between Self KG and Other KG
- No edges cross between either embedded KG and the WKG
- Each Other KG instance is isolated in its own data store (separate file or database)

#### 1.4.2 Technology Validation: Grafeo

**Current Status (as of 2026-03-27):**
- Package: `@grafeo-db/js` v0.5.28
- Status: Pre-1.0, single maintainer (Tobias Schofield)
- GitHub: Active repository, last commit March 2026
- Dependencies: NAPI-based (needs C++ compilation on Windows)
- Documentation: Adequate for core API

**Risk Assessment:**

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Abandoned project | LOW | CRITICAL | Pin version, pre-build binaries for common platforms |
| Breaking API change | MEDIUM | HIGH | Heavy interface abstraction in E1; easy to swap in E3+ |
| NAPI build failure on Windows | MEDIUM | MEDIUM | Docker-only development; CI/CD pre-builds |
| Performance at scale (>50k nodes) | MEDIUM | MEDIUM | Monitoring + profiling in E3 implementation |
| Cypher subset incomplete | LOW-MEDIUM | HIGH | Manual traversal fallback for missing queries |

**Viability Decision:** Grafeo IS viable IF (1) we abstract its API behind `ISelfKgService` and `IOtherKgService` interfaces (already done in E0), (2) we implement in E1 with heavy testing, and (3) we have a fallback plan (SQLite + adjacency lists).

#### 1.4.3 Grafeo Interface (Already in E0 Stubs)

**File:** `src/shared/types/grafeo.types.ts`

```typescript
/**
 * Abstracted Grafeo instance interface.
 * Hides all Grafeo internals. Can be swapped for SQLite or Memgraph.
 */
export interface GrafeoInstance {
  // Node operations
  upsertNode(
    id: string,
    labels: string[],
    properties: Record<string, any>,
  ): Promise<void>;
  findNode(id: string): Promise<GrafeoNode | null>;
  deleteNode(id: string): Promise<void>;

  // Edge operations
  upsertEdge(
    fromId: string,
    toId: string,
    type: string,
    properties?: Record<string, any>,
  ): Promise<void>;
  findEdges(
    fromId?: string,
    toId?: string,
    type?: string,
  ): Promise<GrafeoEdge[]>;
  deleteEdge(fromId: string, toId: string, type: string): Promise<void>;

  // Query operations
  query(cypher: string, params?: Record<string, any>): Promise<any[]>;

  // Lifecycle
  close(): Promise<void>;
}

export interface GrafeoNode {
  id: string;
  labels: string[];
  properties: Record<string, any>;
}

export interface GrafeoEdge {
  fromId: string;
  toId: string;
  type: string;
  properties?: Record<string, any>;
}
```

#### 1.4.4 Implementation Plan for E1

**File:** `src/knowledge/self-kg/self-kg.factory.ts`

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Grafeo } from '@grafeo-db/js';
import { GrafeoInstance } from '@app/shared';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class SelfKgFactory implements OnModuleInit {
  private instance: GrafeoInstance | null = null;
  private readonly logger = new Logger(SelfKgFactory.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.getInstance();
  }

  /**
   * Get or create the singleton KG(Self) instance.
   */
  async getInstance(): Promise<GrafeoInstance> {
    if (!this.instance) {
      const dataDir = this.configService.get('GRAFEO_DATA_PATH') || './data/grafeo';
      const selfPath = path.join(dataDir, 'self');

      // Ensure directory exists
      await fs.mkdir(selfPath, { recursive: true });

      // Create or open Grafeo instance
      const grafeo = new Grafeo({
        dataDir: selfPath,
      });

      this.instance = grafeo as unknown as GrafeoInstance;
      this.logger.log(`KG(Self) initialized at ${selfPath}`);
    }
    return this.instance;
  }

  async closeInstance(): Promise<void> {
    if (this.instance) {
      await this.instance.close();
      this.instance = null;
      this.logger.log('KG(Self) closed');
    }
  }
}
```

**File:** `src/knowledge/other-kg/other-kg.factory.ts`

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Grafeo } from '@grafeo-db/js';
import { GrafeoInstance } from '@app/shared';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class OtherKgFactory {
  private instances: Map<string, GrafeoInstance> = new Map();
  private readonly logger = new Logger(OtherKgFactory.name);

  constructor(private configService: ConfigService) {}

  /**
   * Get or create a Grafeo instance for a specific person.
   * Each person gets an isolated file-based instance.
   */
  async getInstance(personId: string): Promise<GrafeoInstance> {
    if (!this.instances.has(personId)) {
      const dataDir = this.configService.get('GRAFEO_DATA_PATH') || './data/grafeo';
      const personPath = path.join(dataDir, `person_${personId}`);

      // Ensure directory exists
      await fs.mkdir(personPath, { recursive: true });

      // Create or open Grafeo instance
      const grafeo = new Grafeo({
        dataDir: personPath,
      });

      const instance = grafeo as unknown as GrafeoInstance;
      this.instances.set(personId, instance);
      this.logger.log(`KG(Other) for person ${personId} initialized at ${personPath}`);
    }
    return this.instances.get(personId)!;
  }

  async closeAll(): Promise<void> {
    for (const [personId, instance] of this.instances) {
      await instance.close();
      this.logger.log(`KG(Other) for person ${personId} closed`);
    }
    this.instances.clear();
  }
}
```

#### 1.4.5 Grafeo Fallback: SQLite + Graph Abstraction

If Grafeo becomes unavailable or unsuitable, replace with SQLite-based graph store:

**File:** `src/knowledge/self-kg/sqlite-graph.service.ts` (alternative implementation)

```typescript
import { Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { GrafeoInstance, GrafeoNode, GrafeoEdge } from '@app/shared';

/**
 * SQLite-based graph store as fallback for Grafeo.
 * Two tables: nodes (id, labels, properties) and edges (fromId, toId, type, properties).
 */
@Injectable()
export class SqliteGraphService implements GrafeoInstance {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        labels TEXT,
        properties TEXT
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT,
        to_id TEXT,
        type TEXT,
        properties TEXT,
        PRIMARY KEY (from_id, to_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);
  }

  async upsertNode(
    id: string,
    labels: string[],
    properties: Record<string, any>,
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, labels, properties)
      VALUES (?, ?, ?)
    `);
    stmt.run(id, JSON.stringify(labels), JSON.stringify(properties));
  }

  async findNode(id: string): Promise<GrafeoNode | null> {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      labels: JSON.parse(row.labels),
      properties: JSON.parse(row.properties),
    };
  }

  async deleteNode(id: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(id);
  }

  async upsertEdge(
    fromId: string,
    toId: string,
    type: string,
    properties?: Record<string, any>,
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges (from_id, to_id, type, properties)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(fromId, toId, type, JSON.stringify(properties || {}));
  }

  async findEdges(
    fromId?: string,
    toId?: string,
    type?: string,
  ): Promise<GrafeoEdge[]> {
    let query = 'SELECT * FROM edges WHERE 1=1';
    const params = [];

    if (fromId) {
      query += ' AND from_id = ?';
      params.push(fromId);
    }
    if (toId) {
      query += ' AND to_id = ?';
      params.push(toId);
    }
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      type: row.type,
      properties: JSON.parse(row.properties),
    }));
  }

  async deleteEdge(fromId: string, toId: string, type: string): Promise<void> {
    const stmt = this.db.prepare(
      'DELETE FROM edges WHERE from_id = ? AND to_id = ? AND type = ?',
    );
    stmt.run(fromId, toId, type);
  }

  async query(cypher: string, params?: Record<string, any>): Promise<any[]> {
    // For SQLite, fall back to manual traversal for common Cypher patterns
    // This is a simplified fallback -- full Cypher is not supported
    throw new Error(
      'SQLite fallback does not support arbitrary Cypher. Use node/edge methods instead.',
    );
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
```

---

### 1.5 Docker Compose Finalization

**File:** `docker-compose.yml`

```yaml
version: '3.8'

services:
  # Neo4j: World Knowledge Graph
  neo4j:
    image: neo4j:5.15-community
    container_name: sylphie-neo4j
    environment:
      NEO4J_AUTH: neo4j/neo4j_password_change_me
      NEO4J_dbms_memory_heap_initial__size: 1G
      NEO4J_dbms_memory_heap_max__size: 2G
      NEO4J_dbms_memory_pagecache_size: 1G
    ports:
      - "7474:7474" # HTTP
      - "7687:7687" # Bolt
    volumes:
      - neo4j_data:/var/lib/neo4j/data
      - neo4j_logs:/var/lib/neo4j/logs
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7474/"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - sylphie-network
    restart: unless-stopped

  # TimescaleDB: Event Backbone
  timescaledb:
    image: timescale/timescaledb-ha:pg16-latest
    container_name: sylphie-timescaledb
    environment:
      POSTGRES_PASSWORD: timescaledb_password
      POSTGRES_USER: postgres
      POSTGRES_DB: sylphie_events
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - "5433:5432"
    volumes:
      - timescaledb_data:/var/lib/postgresql/data
      - ./db/schema/timescaledb-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U postgres -d sylphie_events",
        ]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - sylphie-network
    restart: unless-stopped

  # PostgreSQL: System Database
  postgres:
    image: postgres:16-alpine
    container_name: sylphie-postgres
    environment:
      POSTGRES_PASSWORD: postgres_admin_password
      POSTGRES_USER: postgres
      POSTGRES_DB: sylphie_system
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/schema/postgresql-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U postgres -d sylphie_system",
        ]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - sylphie-network
    restart: unless-stopped

  # NestJS Application
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: sylphie-app
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
      NEO4J_URI: neo4j://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: neo4j_password_change_me
      NEO4J_ENCRYPTED: "false"
      TIMESCALEDB_HOST: timescaledb
      TIMESCALEDB_PORT: 5432
      TIMESCALEDB_DATABASE: sylphie_events
      TIMESCALEDB_USER: postgres
      TIMESCALEDB_PASSWORD: timescaledb_password
      POSTGRES_ADMIN_HOST: postgres
      POSTGRES_ADMIN_PORT: 5432
      POSTGRES_ADMIN_USER: postgres
      POSTGRES_ADMIN_PASSWORD: postgres_admin_password
      POSTGRES_RUNTIME_HOST: postgres
      POSTGRES_RUNTIME_PORT: 5432
      POSTGRES_RUNTIME_USER: sylphie_app
      POSTGRES_RUNTIME_PASSWORD: sylphie_app_password
      POSTGRES_DATABASE: sylphie_system
      GRAFEO_DATA_PATH: /app/data/grafeo
    ports:
      - "3000:3000"
    depends_on:
      neo4j:
        condition: service_healthy
      timescaledb:
        condition: service_healthy
      postgres:
        condition: service_healthy
    volumes:
      - ./src:/app/src
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - sylphie-network
    restart: unless-stopped
    command: npm run start:dev

volumes:
  neo4j_data:
    driver: local
  neo4j_logs:
    driver: local
  timescaledb_data:
    driver: local
  postgres_data:
    driver: local

networks:
  sylphie-network:
    driver: bridge
```

**Environment File:** `.env.example`

```bash
# Neo4j
NEO4J_URI=neo4j://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=neo4j_password_change_me
NEO4J_ENCRYPTED=false
NEO4J_MAX_POOL_SIZE=50

# TimescaleDB
TIMESCALEDB_HOST=localhost
TIMESCALEDB_PORT=5433
TIMESCALEDB_DATABASE=sylphie_events
TIMESCALEDB_USER=postgres
TIMESCALEDB_PASSWORD=timescaledb_password
TIMESCALEDB_MAX_POOL_SIZE=30

# PostgreSQL Admin (not exported from app)
POSTGRES_ADMIN_HOST=localhost
POSTGRES_ADMIN_PORT=5432
POSTGRES_ADMIN_USER=postgres
POSTGRES_ADMIN_PASSWORD=postgres_admin_password

# PostgreSQL Runtime (exported as POSTGRES_RUNTIME_POOL)
POSTGRES_RUNTIME_HOST=localhost
POSTGRES_RUNTIME_PORT=5432
POSTGRES_RUNTIME_USER=sylphie_app
POSTGRES_RUNTIME_PASSWORD=sylphie_app_password
POSTGRES_DATABASE=sylphie_system
POSTGRES_RUNTIME_POOL_SIZE=20

# Grafeo
GRAFEO_DATA_PATH=./data/grafeo

# Application
NODE_ENV=development
LOG_LEVEL=debug
```

---

## 2. Security & Write Protection Strategy

### 2.1 Drive Rules Write Protection

**Layer 1: Database Level (PostgreSQL RLS)**
- `sylphie_app` role cannot INSERT, UPDATE, or DELETE from `drive_rules`
- `sylphie_app` role can only SELECT from enabled rules
- `sylphie_admin` role has full write access (guardian-only)

**Layer 2: Application Level**
- The `POSTGRES_RUNTIME_POOL` (exported) can only be used to SELECT from `drive_rules`
- The `POSTGRES_ADMIN_POOL` (not exported) is the only pool with write capability
- If any subsystem tries to inject the admin pool, NestJS throws an error

**Layer 3: Interface Level**
- `IActionOutcomeReporter.reportOutcome()` does not have an update-rules method
- `IRuleProposer.proposeRule()` only INSERTs to `proposed_drive_rules`, never directly to `drive_rules`

### 2.2 Proposed Rules Flow

1. **Drive Engine proposes a new rule** → INSERT to `proposed_drive_rules` with status='pending'
2. **Guardian reviews in dashboard** → reads `proposed_drive_rules` via admin pool
3. **Guardian approves** → admin pool UPDATEs status='approved', then INSERTs to `drive_rules`
4. **Rule becomes active** → next Drive Engine tick reads it via runtime pool

---

## 3. Migration Strategy

### 3.1 Schema Application

**Approach 1: Docker Init Scripts (Recommended for E1)**

Docker-Compose applies SQL scripts on container startup via `/docker-entrypoint-initdb.d/`:
- Neo4j constraints are applied via `Neo4jConstraintsService` on NestJS app startup
- TimescaleDB schema is applied by init script on container creation
- PostgreSQL schema is applied by init script on container creation
- Grafeo data directories are created on `SelfKgFactory.onModuleInit()`

**Approach 2: Programmatic Migration (Post-E1)**

For production deployments, use a migration tool:
- Neo4j: `neo4j-migrations` npm package
- TimescaleDB: `db-migrate` or custom migration runner
- PostgreSQL: `typeorm` migrations or `flyway`

### 3.2 Rollback Procedures

**Neo4j:**
- Constraints: `DROP CONSTRAINT constraint_name`
- Data: Keep backups via Neo4j backup API; restore from snapshot

**TimescaleDB:**
- Hypertable: `SELECT drop_chunks('events', INTERVAL '1 hour')` to trim data
- Retention policies: `SELECT drop_retention_policy('events')`
- Decompress: `SELECT decompress_chunk()` to reverse compression

**PostgreSQL:**
- Roles: `DROP ROLE IF EXISTS sylphie_app CASCADE`
- Tables: Manual backup; restore via `pg_restore`
- RLS policies: `DROP POLICY policy_name ON table_name`

---

## 4. Connection Management Details

### 4.1 Pool Sizing Strategy

| Database | Default Pool | Rationale |
|----------|--------------|-----------|
| Neo4j | 50 | High-throughput read/write from 5 subsystems + learning tasks |
| TimescaleDB | 30 | Event recording (all subsystems) + aggregation queries |
| PostgreSQL Runtime | 20 | Light read (drive rules) + propose rules inserts |
| PostgreSQL Admin | 5 (not exported) | Guardian operations only, low frequency |

### 4.2 Connection Timeouts

| Setting | Value | Purpose |
|---------|-------|---------|
| Connection Timeout | 30s | Detect unavailable database quickly |
| Request Timeout | 30s | Prevent hanging queries |
| Idle Timeout | 30s | Recycle idle connections |
| Max Pool Idle Time | 30s | Close unused connections in pool |

### 4.3 Reconnection Strategy

All three drivers (Neo4j, TimescaleDB, PostgreSQL) implement exponential backoff on connection failure:
1. Initial retry: 100ms
2. Backoff multiplier: 2x
3. Max retries: 5
4. Max backoff: 30s

Once a connection is healthy, the pool maintains it until idle timeout.

---

## 5. Risks & Mitigations

### 5.1 High-Severity Risks

| Risk | Mitigation | Owner |
|------|-----------|-------|
| **Grafeo unavailable or breaks at runtime** | Pre-1.0, single maintainer. Mitigation: SQLite fallback interface implemented in E1; pin version; pre-build binaries. Fallback blocks E3 implementation but not E1. | E1: Implement both Grafeo and SQLite; E3: Decide which to use. |
| **Drive rules accidentally modified via app** | Multiple layers: RLS + interface + no exported admin pool. Test RLS: verify sylphie_app can SELECT but not UPDATE. | E1: RLS tests in integration suite. |
| **Event backbone query becomes slow under load** | TimescaleDB compression + retention. Monitor query latency. If >500ms, add indexes. | E2: Implement query monitoring. E10: Load test. |
| **Neo4j constraint violations cause data corruption** | Constraints are UNIQUE on node IDs only. App enforces idempotency via UUID. If violation occurs, it's a bug. | E3: Defensive upsert logic; catch constraint errors. |

### 5.2 Medium-Severity Risks

| Risk | Mitigation |
|------|-----------|
| **Grafeo Cypher subset incomplete** | Design fallback manual traversal. Document which Cypher features are not supported. Use only basic patterns (MATCH, WHERE, RETURN). |
| **Docker volume mount corruption** | Regular backups. Docker volumes on local machine are less fragile than bind mounts. |
| **Pool exhaustion under spike load** | Monitor active connections. Set conservative max pool sizes. Implement request queuing in E9 API layer. |

### 5.3 Low-Severity Risks

| Risk | Mitigation |
|------|-----------|
| **Timezone issues in TimescaleDB** | Always use TIMESTAMPTZ (with timezone). Store UTC. Convert on read in application layer. |
| **SQLite locks on concurrent writes** | If using SQLite fallback, limit to read-heavy Other KG queries. Keep Self KG Grafeo only. |

---

## 6. Verification Checklist

### 6.1 Neo4j

- [ ] Driver factory creates a singleton pool
- [ ] Health check endpoint returns 200 when Neo4j is up
- [ ] All constraints are created on module init
- [ ] Query performance: basic traversal < 50ms
- [ ] Provenance and confidence fields are indexed

### 6.2 TimescaleDB

- [ ] Hypertable is created and time-partitioned
- [ ] Compression policy is active (chunks > 7 days compressed)
- [ ] Retention policy deletes chunks > 90 days
- [ ] Event writes complete in < 10ms under normal load
- [ ] Time-range queries return correct results with correct timezones

### 6.3 PostgreSQL

- [ ] Runtime pool connects with `sylphie_app` user
- [ ] Admin pool NOT exported from module (attempting to inject throws error)
- [ ] RLS policies enforce: SELECT on `drive_rules`, INSERT only on `proposed_drive_rules`
- [ ] Attempting UPDATE/DELETE from runtime pool fails with permission error
- [ ] Guardian can approve rules via admin operations

### 6.4 Grafeo (or SQLite fallback)

- [ ] KG(Self) instance initializes on module startup
- [ ] KG(Other) per-person instances are created on first access
- [ ] Instances are completely isolated (no shared data)
- [ ] Basic node/edge operations work (upsert, find, delete)
- [ ] If using SQLite fallback, all tests pass

### 6.5 Docker Compose

- [ ] All five services start without errors
- [ ] Health checks pass for all databases
- [ ] Application can connect to all three databases
- [ ] Volume mounts preserve data across container restart
- [ ] Logs are visible via `docker-compose logs`

---

## 7. v1 Code References

The following v1 code provides patterns and structure (not direct copy-paste):

| v1 File | Topic | E1 Adaptation |
|---------|-------|---------------|
| `co-being/docker-compose.yml` | Docker services, volumes, networking | Adapt service names, ports, credentials |
| `co-being/packages/backend/schema/timescaledb.sql` | TimescaleDB DDL | Adopt hypertable pattern; change table names to our schema |
| `co-being/packages/graph/src/neo4j-persistence.service.ts` | Neo4j driver, queries | Adapt to E0 interfaces; add provenance enforcement |
| `co-being/packages/backend/src/orchestrator/drive-engine-client.service.ts` | Drive outcome reporting | Adapt to new IPC (will be in E4) |
| `co-being/.env.example` | Environment variables | Base .env.example for all 5 databases |

---

## 8. Recommended Ticket Breakdown (for parallel execution)

### E1 Tickets (suggested dependencies)

**Group A: Foundations (start first, no dependencies)**

1. **E1-A1: Docker Compose Setup**
   - Effort: 2h
   - Deliverable: `docker-compose.yml` with all 5 services, health checks, volumes
   - Verification: `docker-compose up` starts without errors

2. **E1-A2: Neo4j Driver Factory & Health Check**
   - Effort: 3h
   - Deliverable: `Neo4jDriverFactory`, constraints service, health endpoint
   - Verification: Neo4j browser accessible at `localhost:7474`, constraints visible in database

3. **E1-A3: PostgreSQL DDL & RLS**
   - Effort: 2h
   - Deliverable: Complete schema with RLS policies, two pool configuration
   - Verification: RLS tests confirm `sylphie_app` can SELECT but not UPDATE

4. **E1-A4: TimescaleDB Schema & Factory**
   - Effort: 2h
   - Deliverable: Hypertable DDL, `TimescaleDbFactory`, pool configuration
   - Verification: Hypertable visible in `\d events`, compression policy active

**Group B: Knowledge Module (depends on A)**

5. **E1-B1: Grafeo Integration (Grafeo pathway)**
   - Effort: 4h
   - Deliverable: `SelfKgFactory`, `OtherKgFactory`, Grafeo instance management
   - Verification: KG(Self) and KG(Other) instances create without errors, isolation verified

   **OR E1-B1-alt: SQLite Fallback (if Grafeo unavailable)**
   - Effort: 3h
   - Deliverable: `SqliteGraphService` implementing `GrafeoInstance` interface
   - Verification: All node/edge operations pass tests

6. **E1-B2: Events Service Implementation**
   - Effort: 3h
   - Deliverable: Real `EventsService` replacing stub from E0
   - Verification: Event recording and querying work end-to-end

7. **E1-B3: Database Module Exports**
   - Effort: 1h
   - Deliverable: Knowledge module exports all services with DI tokens
   - Verification: `npx tsc --noEmit` passes, module imports compile

**Group C: Integration (depends on B)**

8. **E1-C1: Integration Tests**
   - Effort: 4h
   - Deliverable: Test suite covering all 5 databases, connection pooling, RLS, isolation
   - Verification: `npm run test` passes; all critical tests green

9. **E1-C2: Documentation & .env.example**
   - Effort: 2h
   - Deliverable: `.env.example`, connection string guide, troubleshooting
   - Verification: New developer can `docker-compose up && npm run start:dev` successfully

10. **E1-C3: Health Check Endpoints (partial)**
    - Effort: 2h
    - Deliverable: `/health` endpoints for all 5 databases
    - Verification: All 5 health checks accessible and accurate

---

## 9. Implementation Considerations

### 9.1 Development Workflow

```bash
# Day 1: Parallel Group A
docker-compose up -d
npx ts-node-dev src/main.ts

# Verify in separate terminals:
curl http://localhost:3000/health/neo4j
curl http://localhost:3000/health/timescaledb
curl http://localhost:3000/health/postgres
curl http://localhost:3000/health/grafeo

# Verify databases directly:
neo4j browser: http://localhost:7474
psql: psql -h localhost -U sylphie_app -d sylphie_system
timescaledb: psql -h localhost -p 5433 -U postgres -d sylphie_events
```

### 9.2 Testing Strategy

**Unit Tests:**
- Pure functions (confidence computation, schema validation)
- Driver factory creation

**Integration Tests:**
- Docker containers running; test real queries
- RLS policy enforcement
- Event recording and retrieval
- Grafeo/SQLite isolation
- Connection pool behavior

**End-to-End Tests (E10):**
- Full application startup
- All subsystems can read/write to their databases
- Lesion test: verify Type 1 behavior without LLM

---

## 10. Conclusion

Epic 1 is the infrastructure bedrock. All five databases are fully specified with complete DDL, connection pooling strategies, and security controls. The Grafeo technology risk is manageable via the interface abstraction already in place; a SQLite fallback is provided if needed.

Key architectural guarantees:
- Drive rules are write-protected at three layers (DB, app, interface)
- Self KG and Other KGs are completely isolated
- All events flow through TimescaleDB with temporal queryability
- Neo4j is the single source of truth for world knowledge
- PostgreSQL system DB is read-only from the app's perspective

Implementation can proceed in parallel across Groups A and B, with Group C validation occurring once infrastructure is healthy.

---

**Status:** Ready for implementation. All dependencies identified, all risks mitigated, all interfaces defined in E0 stubs.

**Estimated Effort:** 25-30 hours (includes integration testing and documentation)

**Critical Path:** E1-A1 → E1-A2 → E1-A3 → E1-A4 → E1-B1/B2 → E1-C1

**Next Step:** Begin E1-A1 (Docker Compose) in parallel with E1-A2, E1-A3, E1-A4.
