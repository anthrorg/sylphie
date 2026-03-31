/**
 * Injection tokens for the Database module.
 *
 * POSTGRES_ADMIN_POOL: Symbol('POSTGRES_ADMIN_POOL')
 *   - Pool with admin credentials (DDL + DML permissions)
 *   - NOT exported from DatabaseModule
 *   - Used only by PostgresInitService for schema initialization
 *
 * POSTGRES_RUNTIME_POOL: Symbol('POSTGRES_RUNTIME_POOL')
 *   - Pool with runtime user credentials (SELECT via RLS on drive_rules)
 *   - IS exported from DatabaseModule
 *   - Injected by services that need read-only database access
 *
 * CANON §Drive Isolation: The two-pool architecture enforces that
 * drive rules cannot be modified by the application. Admin pool is
 * restricted to schema initialization; application code only touches
 * the runtime pool.
 */

/** DI token for the admin pool (DDL/DML). Not exported. */
export const POSTGRES_ADMIN_POOL = Symbol('POSTGRES_ADMIN_POOL');

/** DI token for the runtime pool (SELECT via RLS). Exported for general use. */
export const POSTGRES_RUNTIME_POOL = Symbol('POSTGRES_RUNTIME_POOL');
