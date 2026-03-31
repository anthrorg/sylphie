/**
 * Migration: 004-drive-engine-rls.sql
 *
 * Purpose: Enforce write-protection at the PostgreSQL database level using
 * role-based access control (RLS). This is Layer 3 of the three-layer
 * isolation boundary (structural TypeScript, process isolation, database RLS).
 *
 * CANON §No Self-Modification (Immutable Standard 6):
 * - sylphie_app role: SELECT on drive_rules, SELECT+INSERT on proposed_drive_rules
 * - drive_engine role: SELECT on both tables (read-only)
 * - guardian_admin role: ALL permissions on both tables
 *
 * Idempotent: Uses IF NOT EXISTS and DO $$ blocks for safe re-execution.
 */

-- ============================================================================
-- Create roles if they do not exist
-- ============================================================================

DO $$ BEGIN
  CREATE ROLE sylphie_app LOGIN;
EXCEPTION WHEN DUPLICATE_OBJECT THEN
  NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE drive_engine LOGIN;
EXCEPTION WHEN DUPLICATE_OBJECT THEN
  NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE guardian_admin LOGIN;
EXCEPTION WHEN DUPLICATE_OBJECT THEN
  NULL;
END $$;

-- ============================================================================
-- Create drive_rules table (write-protected)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drive_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_pattern TEXT NOT NULL,
  effect TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  confidence FLOAT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create index on enabled for common query patterns
CREATE INDEX IF NOT EXISTS idx_drive_rules_enabled ON drive_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_drive_rules_created_at ON drive_rules(created_at);

-- ============================================================================
-- Create proposed_drive_rules table (review queue)
-- ============================================================================

CREATE TABLE IF NOT EXISTS proposed_drive_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_pattern TEXT NOT NULL,
  effect TEXT NOT NULL,
  confidence FLOAT NOT NULL,
  proposed_by TEXT NOT NULL,
  reasoning TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create index on status for common query patterns
CREATE INDEX IF NOT EXISTS idx_proposed_drive_rules_status ON proposed_drive_rules(status);
CREATE INDEX IF NOT EXISTS idx_proposed_drive_rules_created_at ON proposed_drive_rules(created_at);

-- ============================================================================
-- Enable Row-Level Security on drive_rules
-- ============================================================================

ALTER TABLE drive_rules ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to ensure idempotency
DROP POLICY IF EXISTS drive_rules_sylphie_app_select ON drive_rules;
DROP POLICY IF EXISTS drive_rules_drive_engine_select ON drive_rules;
DROP POLICY IF EXISTS drive_rules_guardian_admin_all ON drive_rules;

-- Policy: sylphie_app can only SELECT (read-only)
CREATE POLICY drive_rules_sylphie_app_select ON drive_rules
  FOR SELECT
  USING (current_user = 'sylphie_app');

-- Policy: drive_engine can only SELECT (read-only)
CREATE POLICY drive_rules_drive_engine_select ON drive_rules
  FOR SELECT
  USING (current_user = 'drive_engine');

-- Policy: guardian_admin has full access
CREATE POLICY drive_rules_guardian_admin_all ON drive_rules
  FOR ALL
  USING (current_user = 'guardian_admin');

-- ============================================================================
-- Enable Row-Level Security on proposed_drive_rules
-- ============================================================================

ALTER TABLE proposed_drive_rules ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to ensure idempotency
DROP POLICY IF EXISTS proposed_rules_sylphie_app_select ON proposed_drive_rules;
DROP POLICY IF EXISTS proposed_rules_sylphie_app_insert ON proposed_drive_rules;
DROP POLICY IF EXISTS proposed_rules_drive_engine_select ON proposed_drive_rules;
DROP POLICY IF EXISTS proposed_rules_guardian_admin_all ON proposed_drive_rules;

-- Policy: sylphie_app can SELECT and INSERT
CREATE POLICY proposed_rules_sylphie_app_select ON proposed_drive_rules
  FOR SELECT
  USING (current_user = 'sylphie_app');

CREATE POLICY proposed_rules_sylphie_app_insert ON proposed_drive_rules
  FOR INSERT
  WITH CHECK (current_user = 'sylphie_app');

-- Policy: drive_engine can only SELECT (read-only)
CREATE POLICY proposed_rules_drive_engine_select ON proposed_drive_rules
  FOR SELECT
  USING (current_user = 'drive_engine');

-- Policy: guardian_admin has full access
CREATE POLICY proposed_rules_guardian_admin_all ON proposed_drive_rules
  FOR ALL
  USING (current_user = 'guardian_admin');

-- ============================================================================
-- Grant permissions: sylphie_app role
-- ============================================================================

-- SELECT on drive_rules (protected by RLS)
GRANT SELECT ON drive_rules TO sylphie_app;

-- SELECT and INSERT on proposed_drive_rules (protected by RLS)
GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;

-- Generate UUIDs for default values
GRANT EXECUTE ON FUNCTION gen_random_uuid TO sylphie_app;

-- Use sequences (not applicable here since we use UUIDs, but included for completeness)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sylphie_app;

-- ============================================================================
-- Grant permissions: drive_engine role
-- ============================================================================

-- SELECT on drive_rules (protected by RLS)
GRANT SELECT ON drive_rules TO drive_engine;

-- SELECT on proposed_drive_rules (protected by RLS)
GRANT SELECT ON proposed_drive_rules TO drive_engine;

-- Generate UUIDs
GRANT EXECUTE ON FUNCTION gen_random_uuid TO drive_engine;

-- ============================================================================
-- Grant permissions: guardian_admin role
-- ============================================================================

-- All permissions on both tables (guardian-only modifications)
GRANT ALL PRIVILEGES ON drive_rules TO guardian_admin;
GRANT ALL PRIVILEGES ON proposed_drive_rules TO guardian_admin;

-- Explicit grants for standard operations
GRANT SELECT, INSERT, UPDATE, DELETE ON drive_rules TO guardian_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON proposed_drive_rules TO guardian_admin;

-- Generate UUIDs
GRANT EXECUTE ON FUNCTION gen_random_uuid TO guardian_admin;

-- ============================================================================
-- Revoke dangerous permissions to enforce write-protection
-- ============================================================================

-- Explicitly revoke UPDATE and DELETE from sylphie_app on drive_rules
REVOKE UPDATE, DELETE ON drive_rules FROM sylphie_app;

-- Explicitly revoke UPDATE and DELETE from drive_engine on both tables
REVOKE UPDATE, DELETE ON drive_rules FROM drive_engine;
REVOKE UPDATE, DELETE ON proposed_drive_rules FROM drive_engine;

-- ============================================================================
-- Final verification (informational only)
-- ============================================================================

-- These checks are informational and will be validated by the RLS Verification Service
-- No schema modifications should happen after this point
