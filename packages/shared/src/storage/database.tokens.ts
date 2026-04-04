/**
 * Injection tokens for PostgreSQL pool providers.
 *
 * POSTGRES_ADMIN_POOL: Pool with admin credentials (DDL + DML permissions).
 *   Used only by initialization services for schema setup.
 *
 * POSTGRES_RUNTIME_POOL: Pool with runtime user credentials (SELECT via RLS).
 *   Injected by services that need read-only database access.
 *
 * CANON §Drive Isolation: The two-pool architecture enforces that
 * drive rules cannot be modified by the application.
 */

export const POSTGRES_ADMIN_POOL = Symbol('POSTGRES_ADMIN_POOL');
export const POSTGRES_RUNTIME_POOL = Symbol('POSTGRES_RUNTIME_POOL');
