/**
 * PostgresInitService — Schema initialization and RLS setup.
 *
 * Runs during NestJS module initialization (OnModuleInit) to:
 * 1. Create all required tables idempotently
 * 2. Enable Row-Level Security (RLS) on drive_rules
 * 3. Grant appropriate permissions to sylphie_app runtime user
 * 4. Verify RLS is active
 *
 * Cleanup happens during module destruction (OnModuleDestroy).
 *
 * CANON §Architecture: The admin pool is used ONLY during initialization.
 * Runtime application code never touches it.
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { Inject } from '@nestjs/common';
import { POSTGRES_ADMIN_POOL } from './database.tokens';
import { AppConfig } from '../shared/config/app.config';

@Injectable()
export class PostgresInitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresInitService.name);

  constructor(
    @Inject(POSTGRES_ADMIN_POOL)
    private readonly adminPool: Pool,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing PostgreSQL schema and RLS...');

    let client: PoolClient | null = null;
    try {
      client = await this.adminPool.connect();
      this.logger.debug('Admin pool connection established');

      // Apply DDL: Create all tables idempotently
      await this.createTables(client);
      this.logger.debug('All tables created/verified');

      // Apply RLS on drive_rules
      await this.enableRls(client);
      this.logger.debug('RLS enabled on drive_rules');

      // Grant permissions to sylphie_app
      await this.grantPermissions(client);
      this.logger.debug('Permissions granted to sylphie_app');

      // Verify RLS is active
      await this.verifyRlsActive(client);
      this.logger.log('PostgreSQL schema initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize PostgreSQL schema: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing PostgreSQL pools');
    try {
      // Admin pool is injected, so we close it
      await this.adminPool.end();
      this.logger.debug('Admin pool closed');
    } catch (error) {
      this.logger.error(
        `Error closing admin pool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create all required tables idempotently.
   */
  private async createTables(client: PoolClient): Promise<void> {
    const ddl = `
      -- drive_rules: Core drive evaluation rules (write-protected by RLS)
      CREATE TABLE IF NOT EXISTS drive_rules (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        event_pattern TEXT NOT NULL,
        drive_effects JSONB NOT NULL,
        priority INTEGER DEFAULT 0,
        provenance TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        is_active BOOLEAN DEFAULT true
      );

      -- proposed_drive_rules: Guardian-review queue for new rules
      CREATE TABLE IF NOT EXISTS proposed_drive_rules (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        event_pattern TEXT NOT NULL,
        drive_effects JSONB NOT NULL,
        proposed_by TEXT NOT NULL,
        proposed_at TIMESTAMPTZ DEFAULT NOW(),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        reviewed_by TEXT,
        reviewed_at TIMESTAMPTZ,
        review_notes TEXT
      );

      -- users: Guardian and observer accounts
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('guardian','observer')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- settings: Application configuration (key-value store)
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT
      );

      -- sessions: Session records for audit trail
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        user_id INTEGER REFERENCES users(id),
        summary TEXT,
        metrics_snapshot JSONB
      );

      -- Migration: add metrics_snapshot if the column does not yet exist.
      -- Rollback: ALTER TABLE sessions DROP COLUMN metrics_snapshot;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'metrics_snapshot'
        ) THEN
          ALTER TABLE sessions ADD COLUMN metrics_snapshot JSONB;
        END IF;
      END
      $$;
    `;

    await client.query(ddl);
  }

  /**
   * Enable Row-Level Security on drive_rules table.
   *
   * Policy: sylphie_app can SELECT all rows (read-only).
   * No INSERT, UPDATE, or DELETE allowed via runtime pool.
   */
  private async enableRls(client: PoolClient): Promise<void> {
    const rls = `
      -- Enable RLS on drive_rules
      ALTER TABLE drive_rules ENABLE ROW LEVEL SECURITY;

      -- Policy: sylphie_app can read all rows
      DROP POLICY IF EXISTS drive_rules_read_only ON drive_rules;
      CREATE POLICY drive_rules_read_only ON drive_rules
        FOR SELECT
        TO sylphie_app
        USING (true);
    `;

    await client.query(rls);
  }

  /**
   * Grant permissions to sylphie_app runtime user.
   *
   * - drive_rules: SELECT only (RLS enforced)
   * - proposed_drive_rules: SELECT, INSERT (guardian review queue)
   * - users: SELECT, INSERT, UPDATE (user management)
   * - settings: SELECT, INSERT, UPDATE (config management)
   * - sessions: SELECT, INSERT, UPDATE (session audit trail)
   * - All sequences: USAGE (for SERIAL columns)
   */
  private async grantPermissions(client: PoolClient): Promise<void> {
    const grants = `
      -- Grants to drive_rules (RLS enforced)
      GRANT SELECT ON drive_rules TO sylphie_app;

      -- Grants to proposed_drive_rules (INSERT for proposals)
      GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;

      -- Grants to users, settings, sessions (full DML)
      GRANT SELECT, INSERT, UPDATE ON users TO sylphie_app;
      GRANT SELECT, INSERT, UPDATE ON settings TO sylphie_app;
      GRANT SELECT, INSERT, UPDATE ON sessions TO sylphie_app;

      -- Grants on sequences (for SERIAL columns)
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sylphie_app;

      -- Explicit deny DELETE on all tables
      REVOKE DELETE ON drive_rules FROM sylphie_app;
      REVOKE DELETE ON proposed_drive_rules FROM sylphie_app;
      REVOKE DELETE ON users FROM sylphie_app;
      REVOKE DELETE ON settings FROM sylphie_app;
      REVOKE DELETE ON sessions FROM sylphie_app;
    `;

    await client.query(grants);
  }

  /**
   * Verify that RLS is active on drive_rules.
   *
   * Queries pg_class to check relrowsecurity flag.
   * Throws if RLS is not enabled (fail-fast).
   */
  private async verifyRlsActive(client: PoolClient): Promise<void> {
    const query = `
      SELECT relrowsecurity
      FROM pg_class
      WHERE relname = 'drive_rules'
    `;

    const result = await client.query(query);

    if (result.rows.length === 0) {
      throw new Error('drive_rules table not found after creation');
    }

    const { relrowsecurity } = result.rows[0];
    if (!relrowsecurity) {
      throw new Error('RLS not enabled on drive_rules');
    }

    this.logger.debug('RLS verified active on drive_rules');
  }
}
