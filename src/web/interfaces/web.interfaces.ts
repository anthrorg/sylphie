/**
 * Web module service interfaces and configuration types.
 *
 * CANON §Subsystem Web: Telemetry collection, WebSocket communication,
 * health monitoring, and knowledge graph visualization over HTTP.
 *
 * All services are stateless facades over shared stores (WKG, TimescaleDB, Self KG).
 * No service owns persistent state — all state lives in the databases.
 */

// WebSocket client type — abstracted over Socket.io or ws implementation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebSocketClient = any;

// ---------------------------------------------------------------------------
// Connection Manager Service
// ---------------------------------------------------------------------------

/**
 * IConnectionManagerService — manages WebSocket client lifecycle.
 *
 * Tracks active WebSocket connections, broadcasts events to channels,
 * and provides connection metrics for health monitoring.
 *
 * CANON §Architecture: WebSocket is the real-time transport for:
 * - Telemetry events (TYPE_2_TELEMETRY, DRIVE_SNAPSHOT, WKG updates)
 * - Graph updates (node/edge creation and confidence changes)
 * - Conversation messages (bidirectional)
 * - Health check results
 */
export interface IConnectionManagerService {
  /**
   * Register a WebSocket client on a named channel.
   *
   * Called when a client connects. The channel name typically identifies
   * a logical broadcast group (e.g., "telemetry", "graph", "conversation").
   *
   * @param client - The WebSocket connection to register.
   * @param channel - The broadcast channel to join.
   */
  register(client: WebSocketClient, channel: string): void;

  /**
   * Unregister a WebSocket client from a named channel.
   *
   * Called when a client disconnects or explicitly leaves a channel.
   * Safe to call multiple times on the same client/channel pair.
   *
   * @param client - The WebSocket connection to unregister.
   * @param channel - The broadcast channel to leave.
   */
  unregister(client: WebSocketClient, channel: string): void;

  /**
   * Broadcast a message to all clients subscribed to a channel.
   *
   * Serializes the message to JSON and sends to all connected clients
   * on the given channel. Handles client disconnections gracefully
   * (removes clients that fail to send).
   *
   * @param channel - The broadcast channel.
   * @param message - Object to be JSON-serialized and sent.
   */
  broadcast(channel: string, message: unknown): void;

  /**
   * Send a message to a specific client with optional timeout.
   *
   * Used for request-response patterns (e.g., requesting a health check
   * or querying for specific data). The promise resolves when the message
   * is sent or rejects on timeout.
   *
   * @param client - The target WebSocket connection.
   * @param message - Object to be JSON-serialized and sent.
   * @param timeoutMs - Optional timeout in milliseconds (default: no timeout).
   * @returns Promise that resolves when send completes or rejects on timeout/error.
   */
  sendToClient(
    client: WebSocketClient,
    message: unknown,
    timeoutMs?: number,
  ): Promise<void>;

  /**
   * Get the total number of connected clients.
   *
   * When channel is omitted, returns all clients across all channels.
   * When channel is provided, returns only clients on that channel.
   *
   * @param channel - Optional channel name to filter by.
   * @returns Count of connected clients.
   */
  getConnectionCount(channel?: string): number;

  /**
   * Get all active channel names.
   *
   * Returns a snapshot of channel names that currently have at least
   * one connected client.
   *
   * @returns Array of active channel names.
   */
  getChannels(): string[];
}

// ---------------------------------------------------------------------------
// Web Configuration
// ---------------------------------------------------------------------------

/**
 * WebConfig — all configuration settings for the Web module.
 *
 * CANON §Architecture: Injected via WEB_CONFIG token. Contains all
 * HTTP server, WebSocket, graph query, and telemetry settings.
 *
 * All fields are required. Defaults are applied at configuration build time,
 * never inside this interface.
 */
export interface WebConfig {
  // HTTP Server Settings
  /** Port for the HTTP server. Range [1, 65535]. */
  readonly httpPort: number;

  /** Host to bind the HTTP server to. Typically '0.0.0.0' or 'localhost'. */
  readonly httpHost: string;

  // CORS Configuration
  /**
   * CORS origin(s) allowed to access the HTTP API.
   * Examples: 'http://localhost:3000', 'https://example.com', '*'
   */
  readonly corsOrigin: string | string[];

  /** Whether to allow credentials (cookies, auth headers) in CORS requests. */
  readonly corsCredentials: boolean;

  // WebSocket Settings
  /** URL path prefix for WebSocket upgrades. Example: '/ws'. */
  readonly wsPathPrefix: string;

  /** Maximum number of concurrent WebSocket clients. */
  readonly wsMaxClients: number;

  /** Interval in milliseconds between WebSocket heartbeat pings. */
  readonly wsHeartbeatIntervalMs: number;

  // Graph Query Settings
  /**
   * Maximum depth for graph traversal queries (BFS/DFS).
   * Limits computational complexity of neighborhood queries.
   * Default: 3. Range [1, 10].
   */
  readonly graphMaxDepth: number;

  /**
   * Maximum number of nodes returned from a single graph query.
   * Prevents memory exhaustion from large result sets.
   * Default: 200. Range [10, 10000].
   */
  readonly graphMaxNodes: number;

  /** Query timeout in milliseconds for graph operations. Range [1000, 60000]. */
  readonly graphQueryTimeoutMs: number;

  // Telemetry Settings
  /** Batch interval in milliseconds for telemetry event collection. */
  readonly telemetryBatchIntervalMs: number;

  /** Maximum batch size before forcing a flush of pending telemetry events. */
  readonly telemetryMaxBatchSize: number;

  // Health Check Settings
  /** TTL in milliseconds for cached health check results. */
  readonly healthCacheTtlMs: number;

  /** Timeout in milliseconds for individual health check probes. */
  readonly healthCheckTimeoutMs: number;

  // Development Mode
  /**
   * When true, enables verbose logging and relaxes some constraints
   * (e.g., allows larger result sets, longer timeouts for debugging).
   */
  readonly developmentMode: boolean;
}
