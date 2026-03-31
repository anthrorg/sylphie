/**
 * Web subsystem configuration using @nestjs/config's registerAs() factory pattern.
 *
 * Maps WEB_* environment variables to typed configuration for HTTP server,
 * WebSocket settings, knowledge graph visualization, and telemetry.
 *
 * CANON constraint: Environment is the only valid source of configuration.
 * No hardcoded values in service files. If the environment is malformed, the
 * application surfaces it through missing/undefined values at startup.
 */

import { registerAs } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Section Interfaces
// ---------------------------------------------------------------------------

/**
 * HTTP server configuration.
 * Controls the NestJS application server binding and basic HTTP settings.
 */
export interface HttpConfig {
  /** HTTP port the NestJS server listens on. Default: 3000 */
  readonly port: number;
  /** HTTP host/interface to bind to. Default: '0.0.0.0' (all interfaces) */
  readonly host: string;
}

/**
 * CORS (Cross-Origin Resource Sharing) configuration.
 * Controls browser security policy for frontend access to the API.
 */
export interface CorsConfig {
  /** CORS origin header. Default: 'http://localhost:5173' (vite dev server) */
  readonly origin: string;
  /** Whether credentials (cookies, auth headers) are allowed in CORS requests. Default: true */
  readonly credentials: boolean;
}

/**
 * WebSocket configuration.
 * Controls connection limits, heartbeat, and lifecycle for real-time communication.
 */
export interface WebSocketConfig {
  /** URL path prefix for WebSocket connections. Default: '/ws' */
  readonly pathPrefix: string;
  /** Maximum concurrent WebSocket client connections. Default: 100 */
  readonly maxClients: number;
  /** Heartbeat ping interval in milliseconds. Default: 30000 (30 seconds) */
  readonly heartbeatIntervalMs: number;
}

/**
 * Knowledge graph visualization configuration.
 * Controls query depth, node limits, and timeout for graph exploration in the UI.
 */
export interface GraphVisualizationConfig {
  /** Maximum depth of graph traversal from a root node. Default: 3 */
  readonly maxDepth: number;
  /** Maximum number of nodes to return in a single query. Default: 200 */
  readonly maxNodes: number;
  /** Query execution timeout in milliseconds. Default: 5000 */
  readonly queryTimeoutMs: number;
}

/**
 * Telemetry and observability configuration.
 * Controls batching and buffering of events sent from frontend to backend.
 */
export interface TelemetryConfig {
  /** Batch interval in milliseconds for telemetry buffering. Default: 500 */
  readonly batchIntervalMs: number;
  /** Maximum events per telemetry batch before flushing. Default: 50 */
  readonly maxBatchSize: number;
}

/**
 * Health check endpoint configuration.
 * Controls caching and timeouts for system health probes.
 */
export interface HealthCheckConfig {
  /** TTL for cached health check results in milliseconds. Default: 30000 (30 seconds) */
  readonly cacheTtlMs: number;
  /** Timeout per individual health check in milliseconds. Default: 500 */
  readonly checkTimeoutMs: number;
}

/**
 * Development mode flag and related settings.
 * Controls debugging, logging, and behavior tailored for development.
 */
export interface DevelopmentConfig {
  /** Whether the application is running in development mode. Default: true */
  readonly enabled: boolean;
}

/**
 * Top-level web subsystem configuration.
 */
export interface WebConfig {
  readonly http: HttpConfig;
  readonly cors: CorsConfig;
  readonly websocket: WebSocketConfig;
  readonly graphVisualization: GraphVisualizationConfig;
  readonly telemetry: TelemetryConfig;
  readonly healthCheck: HealthCheckConfig;
  readonly development: DevelopmentConfig;
}

// ---------------------------------------------------------------------------
// registerAs() Factory
// ---------------------------------------------------------------------------

/**
 * NestJS @nestjs/config factory for web subsystem configuration.
 *
 * Registered under the key 'web' in ConfigModule. All values are read from
 * process.env with defaults matching .env.example.
 *
 * Usage in services:
 *   constructor(private readonly config: ConfigService) {}
 *   const webConfig = this.config.get<WebConfig>('web');
 *   const httpPort = webConfig?.http.port;
 *
 * @returns Fully resolved WebConfig from environment variables
 */
export const webConfig = registerAs('web', (): WebConfig => ({
  http: {
    port: parseInt(process.env['WEB_HTTP_PORT'] ?? '3000', 10),
    host: process.env['WEB_HTTP_HOST'] ?? '0.0.0.0',
  },

  cors: {
    origin: process.env['WEB_CORS_ORIGIN'] ?? 'http://localhost:5173',
    credentials: (process.env['WEB_CORS_CREDENTIALS'] ?? 'true') === 'true',
  },

  websocket: {
    pathPrefix: process.env['WEB_WS_PATH_PREFIX'] ?? '/ws',
    maxClients: parseInt(process.env['WEB_WS_MAX_CLIENTS'] ?? '100', 10),
    heartbeatIntervalMs: parseInt(
      process.env['WEB_WS_HEARTBEAT_INTERVAL_MS'] ?? '30000',
      10,
    ),
  },

  graphVisualization: {
    maxDepth: parseInt(process.env['WEB_GRAPH_MAX_DEPTH'] ?? '3', 10),
    maxNodes: parseInt(process.env['WEB_GRAPH_MAX_NODES'] ?? '200', 10),
    queryTimeoutMs: parseInt(
      process.env['WEB_GRAPH_QUERY_TIMEOUT_MS'] ?? '5000',
      10,
    ),
  },

  telemetry: {
    batchIntervalMs: parseInt(
      process.env['WEB_TELEMETRY_BATCH_INTERVAL_MS'] ?? '500',
      10,
    ),
    maxBatchSize: parseInt(
      process.env['WEB_TELEMETRY_MAX_BATCH_SIZE'] ?? '50',
      10,
    ),
  },

  healthCheck: {
    cacheTtlMs: parseInt(process.env['WEB_HEALTH_CACHE_TTL_MS'] ?? '30000', 10),
    checkTimeoutMs: parseInt(
      process.env['WEB_HEALTH_CHECK_TIMEOUT_MS'] ?? '500',
      10,
    ),
  },

  development: {
    enabled: (process.env['WEB_DEVELOPMENT_MODE'] ?? 'true') === 'true',
  },
}));
