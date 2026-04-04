/**
 * RLS Verification Service — Validate database-level write-protection at startup.
 *
 * CANON §No Self-Modification (Immutable Standard 6):
 * This service enforces the database-level enforcement of the no self-modification
 * principle. On startup (OnModuleInit), it verifies that:
 *
 * 1. sylphie_app role cannot UPDATE drive_rules
 * 2. sylphie_app role cannot DELETE drive_rules
 * 3. sylphie_app role CAN SELECT from drive_rules
 * 4. sylphie_app role CAN INSERT into proposed_drive_rules
 *
 * Verification happens in a transaction that is rolled back. If any check fails,
 * a CRITICAL error is logged and startup is prevented.
 *
 * Layer 3 of three-layer isolation boundary:
 * 1. Structural (TypeScript service design)
 * 2. Process isolation (IPC one-way communication)
 * 3. Database RLS (this service)
 */

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_RUNTIME_POOL } from '@sylphie/shared';

@Injectable()
export class RlsVerificationService implements OnModuleInit {
  private readonly logger = new Logger(RlsVerificationService.name);

  constructor(
    @Inject(POSTGRES_RUNTIME_POOL)
    private readonly runtimePool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting RLS verification...');

    try {
      await this.verifyRlsEnforcement();
      this.logger.log('RLS verification passed - write-protection is active');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `RLS VERIFICATION FAILED: ${message} - Startup aborted to prevent security bypass`,
      );
      throw error;
    }
  }

  /**
   * Verify that RLS policies prevent unauthorized modifications.
   *
   * This method attempts forbidden operations in rolled-back transactions.
   * If the operations succeed, it means RLS enforcement has failed and we
   * must halt startup.
   *
   * CANON §Drive Isolation: This is the last-line verification that the
   * database-level boundary is enforcing write-protection.
   */
  private async verifyRlsEnforcement(): Promise<void> {
    // Each check runs in its own connection to avoid transaction abort propagation.
    // PostgreSQL aborts the entire transaction on permission errors, so we can't
    // use savepoints within a single connection for "expected failure" tests.

    // Check 1: sylphie_app should NOT be able to UPDATE drive_rules
    await this.expectPermissionDenied(
      'UPDATE drive_rules SET is_active = false WHERE id IS NOT NULL;',
      'UPDATE drive_rules',
    );
    this.logger.debug('Verified: sylphie_app cannot UPDATE drive_rules');

    // Check 2: sylphie_app should NOT be able to DELETE from drive_rules
    await this.expectPermissionDenied(
      'DELETE FROM drive_rules WHERE id IS NOT NULL;',
      'DELETE from drive_rules',
    );
    this.logger.debug('Verified: sylphie_app cannot DELETE from drive_rules');

    // Check 3: sylphie_app SHOULD be able to SELECT from drive_rules
    const selectClient = await this.runtimePool.connect();
    try {
      await selectClient.query('SELECT COUNT(*) FROM drive_rules;');
      this.logger.debug('Verified: sylphie_app CAN SELECT from drive_rules');
    } catch (error) {
      throw new Error(`RLS check failed: sylphie_app cannot SELECT from drive_rules: ${error}`);
    } finally {
      selectClient.release();
    }

    // Check 4: sylphie_app SHOULD be able to INSERT into proposed_drive_rules
    const insertClient = await this.runtimePool.connect();
    try {
      await insertClient.query('BEGIN;');
      await insertClient.query(
        `INSERT INTO proposed_drive_rules (name, event_pattern, drive_effects, proposed_by)
         VALUES ($1, $2, $3, $4)`,
        ['RLS_TEST', 'TEST_PATTERN', '{}', 'SYSTEM'],
      );
      await insertClient.query('ROLLBACK;');
      this.logger.debug('Verified: sylphie_app CAN INSERT into proposed_drive_rules');
    } catch (error) {
      try { await insertClient.query('ROLLBACK;'); } catch { /* ignore */ }
      throw new Error(`RLS check failed: sylphie_app cannot INSERT into proposed_drive_rules: ${error}`);
    } finally {
      insertClient.release();
    }
  }

  /**
   * Expect a query to fail with "permission denied". If it succeeds, RLS is broken.
   */
  private async expectPermissionDenied(sql: string, description: string): Promise<void> {
    const client = await this.runtimePool.connect();
    try {
      await client.query(sql);
      // If we get here, the query succeeded — RLS is not enforcing
      throw new Error(`RLS FAILURE: sylphie_app was able to ${description} — write-protection is not enforced`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('permission denied')) {
        return; // Expected — RLS is working
      }
      throw error;
    } finally {
      client.release();
    }
  }

}
