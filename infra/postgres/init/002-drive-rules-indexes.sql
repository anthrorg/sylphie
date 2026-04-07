-- Index optimizations for drive_rules and proposed_drive_rules tables.
-- Runs as superuser during Docker init (after tables are created).
-- Safe to re-run: all statements are idempotent.

-- drive_rules: getActiveRules() queries WHERE enabled = true ORDER BY created_at DESC.
-- Partial index keeps only the enabled rows, which is the only set ever queried.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'drive_rules') THEN
    CREATE INDEX IF NOT EXISTS idx_drive_rules_enabled
      ON drive_rules (created_at DESC)
      WHERE enabled = true;
  END IF;
END $$;

-- proposed_drive_rules: dashboard approval workflow queries by status.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'proposed_drive_rules') THEN
    CREATE INDEX IF NOT EXISTS idx_proposed_rules_status
      ON proposed_drive_rules (status, created_at DESC);
  END IF;
END $$;
