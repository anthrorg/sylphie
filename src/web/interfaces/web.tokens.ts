/**
 * Dependency injection tokens for the Web module.
 *
 * Each token is a unique Symbol identifying a service or configuration
 * injectable via NestJS DependencyInjection container.
 *
 * CANON §Architecture: Services use these tokens to declare their
 * dependencies in constructor() signature.
 */

/**
 * Token for IConnectionManagerService — WebSocket connection lifecycle.
 *
 * Usage in a service constructor:
 * ```typescript
 * constructor(@Inject(CONNECTION_MANAGER) private connMgr: IConnectionManagerService) {}
 * ```
 */
export const CONNECTION_MANAGER = Symbol('CONNECTION_MANAGER');

/**
 * Token for WebConfig — all Web module configuration.
 *
 * Injected as a complete configuration object with all fields
 * (HTTP/WS settings, graph query limits, telemetry config, health check settings).
 *
 * Usage in a service constructor:
 * ```typescript
 * constructor(@Inject(WEB_CONFIG) private config: WebConfig) {}
 * ```
 */
export const WEB_CONFIG = Symbol('WEB_CONFIG');
