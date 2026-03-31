/**
 * Typed database configuration interfaces for all four database backends.
 *
 * CANON §Architecture (Five Databases): Neo4j, TimescaleDB, PostgreSQL, and
 * Grafeo (Self KG + Other KGs) each have distinct connection semantics and
 * ownership contracts. This file provides explicit TypeScript interfaces for
 * each, plus a DatabaseConfig aggregate.
 *
 * These interfaces are concrete subtypes of the corresponding sections in
 * AppConfig. Services that work with a single database should inject the
 * specific config type (e.g., Neo4jConfig), not the full AppConfig.
 *
 * No cross-module imports. No process.env access here — that lives in
 * app.config.ts. This file is purely type declarations + the aggregate.
 */

// ---------------------------------------------------------------------------
// Neo4j Config
// ---------------------------------------------------------------------------

/**
 * Connection configuration for the Neo4j World Knowledge Graph.
 *
 * CANON §Architecture: The WKG is the architectural center of gravity.
 * Neo4j Community Edition — no clustering, single-instance.
 */
export interface Neo4jConfig {
  /** Bolt URI. E.g., 'bolt://localhost:7687' */
  readonly uri: string;
  /** Authentication user. */
  readonly user: string;
  /** Authentication password. */
  readonly password: string;
  /** Target Neo4j database. Default: 'neo4j' */
  readonly database: string;
  /**
   * Driver connection pool size.
   * Controls concurrent Bolt connections. Default: 50.
   * Tune based on query concurrency in production.
   */
  readonly maxConnectionPoolSize: number;
  /** Maximum time in milliseconds to wait for a connection. Default: 5000 */
  readonly connectionTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// TimescaleDB Config
// ---------------------------------------------------------------------------

/**
 * Connection configuration for TimescaleDB, Sylphie's event backbone.
 *
 * CANON §TimescaleDB (The Event Backbone): All five subsystems write here.
 * Partitioned hypertable with configurable raw retention and compression.
 *
 * Port intentionally 5433 to avoid conflict with the system Postgres on 5434.
 */
export interface TimescaleConfig {
  /** PostgreSQL hostname. Default: 'localhost' */
  readonly host: string;
  /** Port. Default: 5433 */
  readonly port: number;
  /** Database name. Default: 'sylphie_events' */
  readonly database: string;
  /** Database user. Default: 'sylphie' */
  readonly user: string;
  /** Database password. */
  readonly password: string;
  /** Pool maximum connection count. Default: 20 */
  readonly maxConnections: number;
  /** Milliseconds before an idle connection is released. Default: 30000 */
  readonly idleTimeoutMs: number;
  /** Milliseconds to wait when acquiring a connection. Default: 5000 */
  readonly connectionTimeoutMs: number;
  /**
   * Days to retain raw event data before automatic deletion.
   * Default: 90. Retention policy applied by TimescaleDB background job.
   */
  readonly retentionDays: number;
  /**
   * Days before data is compressed from raw to columnar format.
   * Default: 7. Events older than this are still queryable via decompression.
   */
  readonly compressionDays: number;
}

// ---------------------------------------------------------------------------
// PostgreSQL Config
// ---------------------------------------------------------------------------

/**
 * Connection configuration for the PostgreSQL system database.
 *
 * CANON §Architecture: Stores drive rules, settings, users, and meta — things
 * Sylphie should be unaware of. Three-pool architecture with role-based access
 * control enforces the No Self-Modification principle (CANON Immutable Standard 6):
 *
 * Admin pool (adminUser/adminPassword):
 *   Full DDL + DML. Used for schema migrations and guardian-approved rule changes.
 *   Never used in the runtime hot path.
 *
 * Runtime pool (runtimeUser/runtimePassword):
 *   SELECT on drive_rules + INSERT on proposed_drive_rules via RLS.
 *   The application can READ active rules and propose new ones, but cannot modify existing rules.
 *
 * Drive Engine pool (driveEngineUser/driveEnginePassword):
 *   SELECT-only on drive_rules and proposed_drive_rules via RLS.
 *   The isolated drive computation process can read state but cannot propose or modify.
 *
 * Guardian Admin pool (guardianAdminUser/guardianAdminPassword):
 *   Full permissions on both drive_rules and proposed_drive_rules.
 *   Used by guardians via dashboard to approve/reject proposals and modify active rules.
 *
 * Port 5434 intentionally separates from TimescaleDB on 5433.
 */
export interface PostgresConfig {
  /** Hostname. Default: 'localhost' */
  readonly host: string;
  /** Port. Default: 5434 */
  readonly port: number;
  /** Database name. Default: 'sylphie_system' */
  readonly database: string;
  /** Admin pool user (DDL + DML). */
  readonly adminUser: string;
  /** Admin pool password. */
  readonly adminPassword: string;
  /** Runtime pool user (SELECT on drive_rules, INSERT on proposed_drive_rules via RLS). */
  readonly runtimeUser: string;
  /** Runtime pool password. */
  readonly runtimePassword: string;
  /** Drive Engine pool user (SELECT-only on drive_rules via RLS). */
  readonly driveEngineUser: string;
  /** Drive Engine pool password. */
  readonly driveEnginePassword: string;
  /** Guardian admin user (full permissions for rule approvals). */
  readonly guardianAdminUser: string;
  /** Guardian admin password. */
  readonly guardianAdminPassword: string;
  /** Maximum connections across all pools. Default: 10 */
  readonly maxConnections: number;
  /** Milliseconds before idle connection is released. Default: 30000 */
  readonly idleTimeoutMs: number;
  /** Milliseconds to wait when acquiring a connection. Default: 5000 */
  readonly connectionTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Grafeo Config
// ---------------------------------------------------------------------------

/**
 * Configuration for the Grafeo embedded graph database.
 *
 * CANON §Architecture: Self KG (KG(Self)) and Other KGs are completely isolated
 * from each other and from the WKG. No shared edges. No cross-contamination.
 * Grafeo runs embedded inside the NestJS process — no separate container.
 *
 * Per-person Other KGs are subdirectories under otherKgPath, keyed by personId
 * (e.g., './data/other-kgs/person_jim'). The application manages this pathing.
 */
export interface GrafeoConfig {
  /** Filesystem path for the KG(Self) instance. Default: './data/self-kg' */
  readonly selfKgPath: string;
  /** Filesystem path root for per-person Other KG instances. Default: './data/other-kgs' */
  readonly otherKgPath: string;
  /**
   * Maximum node count per KG instance before write-protection triggers.
   * Guards against unbounded growth. Default: 10000.
   * When reached, writes fail with a capacity error until pruned.
   */
  readonly maxNodesPerKg: number;
}

// ---------------------------------------------------------------------------
// Aggregate DatabaseConfig
// ---------------------------------------------------------------------------

/**
 * Aggregate of all four database configuration sections.
 *
 * Services that need to work across multiple databases (e.g., a health check
 * that pings all four) inject this aggregate. Single-database services inject
 * their specific config type directly.
 */
export interface DatabaseConfig {
  /** Neo4j World Knowledge Graph configuration. */
  readonly neo4j: Neo4jConfig;
  /** TimescaleDB event backbone configuration. */
  readonly timescale: TimescaleConfig;
  /** PostgreSQL system database configuration. */
  readonly postgres: PostgresConfig;
  /** Grafeo Self KG and Other KGs configuration. */
  readonly grafeo: GrafeoConfig;
}
