-- ==========================================
-- Sylphie PostgreSQL System DB Init Script
-- ==========================================
-- This script creates the runtime user (sylphie_app) with restricted permissions.
-- The admin user (sylphie_admin) is created automatically by docker-compose via
-- POSTGRES_USER and POSTGRES_PASSWORD env vars.
--
-- Full DDL and RLS setup happens in E1-T004 (schema migration).
-- This script focuses on role creation and basic grants.

-- Create the runtime user (sylphie_app) with LOGIN permission
-- The password comes from the POSTGRES_RUNTIME_PASSWORD env var
CREATE ROLE sylphie_app WITH LOGIN PASSWORD :'POSTGRES_RUNTIME_PASSWORD';

-- Grant connection permission to the sylphie_system database
GRANT CONNECT ON DATABASE sylphie_system TO sylphie_app;

-- Grant usage on the public schema
GRANT USAGE ON SCHEMA public TO sylphie_app;

-- ===========================================================================
-- Table-level grants (these tables will be created in E1-T004)
-- The actual tables are created during schema migration.
-- We set up grants here so they're ready when tables are created.
-- ===========================================================================

-- Grant SELECT on drive_rules (read-only for runtime user)
-- This will be protected by RLS in E1-T004
ALTER DEFAULT PRIVILEGES FOR ROLE sylphie_admin IN SCHEMA public GRANT SELECT ON TABLES TO sylphie_app;

-- Grant SELECT, INSERT, UPDATE on users, settings, sessions tables
-- (read-only on users/settings, read-write on sessions for session management)
ALTER DEFAULT PRIVILEGES FOR ROLE sylphie_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO sylphie_app;

-- Explicitly deny DELETE on all tables for runtime user
-- (only admin user can delete)
ALTER DEFAULT PRIVILEGES FOR ROLE sylphie_admin IN SCHEMA public REVOKE DELETE ON TABLES FROM sylphie_app;

-- ===========================================================================
-- Sequence and function grants for future table operations
-- ===========================================================================

-- Allow the runtime user to use sequences (for SERIAL columns)
ALTER DEFAULT PRIVILEGES FOR ROLE sylphie_admin IN SCHEMA public GRANT USAGE ON SEQUENCES TO sylphie_app;

-- Allow the runtime user to call functions (for E1-T005 stored procedures)
ALTER DEFAULT PRIVILEGES FOR ROLE sylphie_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO sylphie_app;

-- ===========================================================================
-- Notes for E1-T004 (Schema Creation)
-- ===========================================================================
-- When creating tables in E1-T004, apply these grants to the created tables:
--
-- 1. drive_rules table:
--    GRANT SELECT ON drive_rules TO sylphie_app;
--    ENABLE RLS on drive_rules;
--    CREATE POLICY drive_rules_read_only ON drive_rules
--      FOR SELECT TO sylphie_app USING (true);
--
-- 2. proposed_drive_rules table:
--    GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;
--
-- 3. users, settings, sessions:
--    GRANT SELECT, INSERT, UPDATE ON users TO sylphie_app;
--    GRANT SELECT, INSERT, UPDATE ON settings TO sylphie_app;
--    GRANT SELECT, INSERT, UPDATE ON sessions TO sylphie_app;
--
-- 4. Other tables (events, etc):
--    Apply appropriate DML grants based on access patterns
