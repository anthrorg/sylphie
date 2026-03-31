/**
 * Database module public API.
 *
 * Consumers import exclusively from this barrel. Internal file paths
 * (postgres-init.service.ts, database.module.ts) are implementation
 * details and must not be imported directly from outside the database/
 * directory.
 *
 * Usage:
 *   import { DatabaseModule, POSTGRES_RUNTIME_POOL } from '../database';
 */

// Module
export { DatabaseModule } from './database.module';

// Injection tokens (only runtime pool is exported)
export { POSTGRES_RUNTIME_POOL } from './database.tokens';
