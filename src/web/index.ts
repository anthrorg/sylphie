/**
 * Web module public API — barrel re-export.
 *
 * Consumers import from 'src/web' (or a relative equivalent) rather than
 * from internal file paths. Epic 9 T002 added full DI wiring and exports
 * the module plus types and utilities.
 *
 * Controllers and gateways are implementation details of WebModule and are
 * never injected by other modules. Web interface types and utility functions
 * are exported for use by other subsystems that need to work with web DTOs
 * or pagination helpers.
 *
 * Usage:
 *   import { WebModule } from '../web';
 *   import { paginate, PaginatedResult } from '../web/utils';
 */

// Module class
export { WebModule } from './web.module';

// DI tokens
export { CONNECTION_MANAGER, SESSION_SERVICE } from './web.tokens';

// Service interfaces (for type checking)
export type { IConnectionManagerService, WebConfig } from './interfaces/web.interfaces';
export type { SessionRecord } from './services/session.service';

// Utilities
export * from './utils';

