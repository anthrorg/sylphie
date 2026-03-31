/**
 * Web module exceptions.
 *
 * All exceptions in the Web module extend WebException, which in turn
 * extends SylphieException. This ensures all domain errors carry consistent
 * metadata (subsystem, code, context) for logging and programmatic handling.
 *
 * CANON §Exception Hierarchy: exceptions preserve the original cause for
 * debugging while presenting a clean public interface.
 */

import { SylphieException } from '../../shared/exceptions/sylphie.exception';

/**
 * WebException — base class for all Web module errors.
 *
 * Extends SylphieException with subsystem = 'web'.
 * All specific web errors inherit from this class.
 */
export class WebException extends SylphieException {
  /**
   * @param message - Human-readable error description
   * @param code - Machine-readable error code (e.g., 'GRAPH_QUERY_TIMEOUT', 'INVALID_SESSION')
   * @param context - Diagnostic key-value pairs for logs
   * @param cause - Optional underlying error being wrapped
   */
  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'web', code, context, cause);
    this.name = this.constructor.name;
  }
}

/**
 * GraphQueryTimeoutError — raised when a WKG query exceeds the timeout.
 *
 * Occurs when:
 * - Neo4j query does not complete within WebConfig.graphQueryTimeoutMs
 * - BFS/DFS traversal on a large subgraph takes too long
 * - Database connection is slow or under high load
 *
 * CANON §Graph Query Limits: Large queries are limited by maxDepth and maxNodes.
 * If even these constraints result in timeouts, the client should retry with
 * smaller depth or offset pagination.
 */
export class GraphQueryTimeoutError extends WebException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'GRAPH_QUERY_TIMEOUT', context, cause);
  }
}

/**
 * InvalidSessionError — raised when a session ID is invalid or expired.
 *
 * Occurs when:
 * - WebSocket client references a non-existent sessionId
 * - HTTP endpoint receives a session parameter that doesn't match active session
 * - Session has been garbage-collected (TTL expired)
 *
 * CANON §Communication: Sessions correlate all events in a conversation turn
 * to a single TimescaleDB record. Invalid session references break event correlation.
 */
export class InvalidSessionError extends WebException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'INVALID_SESSION', context, cause);
  }
}

/**
 * WebSocketConnectionError — raised when a WebSocket connection fails.
 *
 * Occurs when:
 * - WebSocket handshake fails (protocol mismatch, auth failure)
 * - Client connects but immediately disconnects
 * - Connection manager cannot allocate resources for a new client
 * - Concurrent client limit (wsMaxClients) exceeded
 *
 * CANON §Architecture: WebSocket is the primary real-time transport.
 * Connection errors should be logged and the client should retry with backoff.
 */
export class WebSocketConnectionError extends WebException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'WS_CONNECTION_ERROR', context, cause);
  }
}
