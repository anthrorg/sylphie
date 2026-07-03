/**
 * Injection tokens for PostgreSQL pool providers.
 *
 * POSTGRES_ADMIN_POOL: Pool with admin credentials (DDL + DML permissions).
 *   Used only by initialization services for schema setup.
 *
 * POSTGRES_RUNTIME_POOL: Pool with runtime user credentials (SELECT via RLS).
 *   Injected by services that need read-only database access.
 *
 * POSTGRES_GUARDIAN_POOL: Pool with guardian_admin credentials — the ONLY
 *   pool permitted to write drive_rules / proposed_drive_rules (TK-154
 *   REVOKEs those writes from sylphie_app; TK-155 wires this pool). Reads
 *   still go through POSTGRES_RUNTIME_POOL; only
 *   GuardianRulesService.approveRule/rejectRule use this pool, reachable
 *   solely through guardian-JWT-gated endpoints. If guardian credentials are
 *   unset/misconfigured the pool provider fails CLOSED on first use (a typed
 *   error) rather than crashing the app at boot or silently falling back to
 *   another pool — see apps/sylphie/src/services/guardian-pool.provider.ts.
 *
 * CANON §Drive Isolation / Immutable Standard 6 (No Self-Modification of
 * Evaluation): The three-pool split enforces that drive rules cannot be
 * modified by ordinary application code paths — only the guardian-approved
 * write path, running under its own privileged DB role, can promote or
 * reject a rule.
 */

export const POSTGRES_ADMIN_POOL = Symbol('POSTGRES_ADMIN_POOL');
export const POSTGRES_RUNTIME_POOL = Symbol('POSTGRES_RUNTIME_POOL');
export const POSTGRES_GUARDIAN_POOL = Symbol('POSTGRES_GUARDIAN_POOL');
