# 2026-03-29 -- E1-T004: PostgreSQL system database (DDL, RLS, pools)

## Changes
- NEW: `src/database/database.tokens.ts` -- DI tokens for admin and runtime pools
- NEW: `src/database/database.module.ts` -- NestJS module providing two pools from config
- NEW: `src/database/postgres-init.service.ts` -- OnModuleInit/OnModuleDestroy, schema DDL, RLS, permissions
- NEW: `src/database/index.ts` -- Barrel export (tokens and module only)
- MODIFIED: `src/app.module.ts` -- Imported DatabaseModule after SharedModule

## Wiring Changes
- DatabaseModule imports ConfigService and provides POSTGRES_ADMIN_POOL (internal) and POSTGRES_RUNTIME_POOL (exported)
- PostgresInitService injects POSTGRES_ADMIN_POOL for schema initialization
- AppModule imports DatabaseModule in import order (after SharedModule, before EventsModule)

## Schema Created
- `drive_rules`: Core drive evaluation rules (write-protected by RLS)
- `proposed_drive_rules`: Guardian-review queue for new rules
- `users`: Guardian and observer accounts
- `settings`: Application configuration key-value store
- `sessions`: Session records for audit trail

## RLS & Permissions
- RLS enabled on `drive_rules`: sylphie_app can SELECT only
- sylphie_app can INSERT into `proposed_drive_rules` (no UPDATE/DELETE)
- sylphie_app can SELECT/INSERT/UPDATE on users, settings, sessions
- DELETE explicitly revoked on all tables for sylphie_app
- Admin pool (2-pool architecture) restricted to initialization; runtime pool stays open

## Known Issues
- None. TypeScript compilation passes (`npx tsc --noEmit`).

## Gotchas for Next Session
- Admin pool is NOT exported; only runtime pool is available to other modules
- RLS verification is part of init; if RLS doesn't enable, the app fails fast
- DDL is fully idempotent (IF NOT EXISTS); safe to re-run on every startup
- Both pools are created at module init; only runtime pool survives (admin closes after init)
