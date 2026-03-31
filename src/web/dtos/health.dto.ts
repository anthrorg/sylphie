/**
 * Health check DTOs for database and system status monitoring.
 *
 * CANON §Development Metrics: Health checks provide visibility into
 * system state for debugging and monitoring subsystem connectivity.
 */

// ---------------------------------------------------------------------------
// Database Health
// ---------------------------------------------------------------------------

/**
 * Result of a health check probe against a single database.
 *
 * status reflects the database connectivity and responsiveness:
 * - 'healthy': responds to queries within timeout, no errors
 * - 'degraded': responds but with elevated latency or partial failures
 * - 'unhealthy': unreachable, timeout, or persistent error state
 *
 * latencyMs is the measured round-trip time for the probe query.
 * details is an open-ended bag for database-specific status info
 * (e.g., connection pool state, pending transactions).
 */
export interface HealthCheckResult {
  /** Human-readable database name (e.g., 'Neo4j', 'PostgreSQL', 'TimescaleDB'). */
  readonly database: string;

  /** Overall health status. */
  readonly status: 'healthy' | 'degraded' | 'unhealthy';

  /** Measured latency in milliseconds for the health probe. */
  readonly latencyMs: number;

  /** Database-specific diagnostic details (optional). */
  readonly details?: Record<string, unknown>;

  /** Error message if status is 'unhealthy' (optional). */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// System Health Response
// ---------------------------------------------------------------------------

/**
 * HealthCheckResponse — comprehensive system health snapshot.
 *
 * CANON §Health Monitoring: Returned by the GET /health endpoint
 * and streamed to connected WebSocket clients on demand. Aggregates
 * health across all five subsystem databases.
 *
 * uptime is wall-clock seconds since process start (or last restart).
 * version is the application version string (e.g., '1.0.0-alpha').
 * timestamp is wall-clock milliseconds since epoch when this check ran.
 */
export interface HealthCheckResponse {
  /**
   * Overall system health status derived from all database checks.
   * - 'healthy': all databases healthy
   * - 'degraded': at least one database degraded but reachable
   * - 'unhealthy': at least one database unreachable
   */
  readonly status: 'healthy' | 'degraded' | 'unhealthy';

  /** Individual health check results for each database. */
  readonly databases: readonly HealthCheckResult[];

  /** Process uptime in seconds since start. */
  readonly uptime: number;

  /** Application semantic version string. */
  readonly version: string;

  /** Wall-clock timestamp in milliseconds when this check was performed. */
  readonly timestamp: number;
}
