/**
 * Web module DI tokens.
 *
 * All symbols defined here match the Symbol pattern used throughout Sylphie.
 * Consumers inject these tokens into their dependencies to receive the
 * corresponding service instance.
 */

/**
 * CONNECTION_MANAGER — WebSocket connection lifecycle manager.
 *
 * Token: Symbol('web.ConnectionManager')
 * Type: IConnectionManagerService
 * Provided by: WebModule
 * Usage: Inject where WebSocket broadcast/client management is needed
 */
export const CONNECTION_MANAGER = Symbol('web.ConnectionManager');

/**
 * SESSION_SERVICE — Session lifecycle management.
 *
 * Token: Symbol('web.SessionService')
 * Type: ISessionService
 * Provided by: WebModule
 * Usage: Inject where session start/close or session history is needed.
 * Writes to the PostgreSQL sessions table via the POSTGRES_RUNTIME_POOL.
 * Computes a HealthMetrics snapshot at session close.
 */
export const SESSION_SERVICE = Symbol('web.SessionService');
