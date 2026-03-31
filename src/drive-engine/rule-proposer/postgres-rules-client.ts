/**
 * PostgreSQL Rules Client — Manage drive rule database operations.
 *
 * CANON §No Self-Modification (Immutable Standard 6):
 * This client provides type-safe access to the proposed_drive_rules table
 * for rule proposal, and read-only access to active drive_rules.
 *
 * RLS enforcement at the database level prevents any UPDATE or DELETE
 * operations on drive_rules, even if the application code attempted them.
 *
 * Methods:
 * - getActiveRules(): Retrieve all enabled drive rules
 * - insertProposedRule(): Submit a new rule for guardian review
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_RUNTIME_POOL } from '../../database/database.tokens';

/**
 * Active drive rule from the database.
 *
 * Corresponds to a row in the drive_rules table.
 */
export interface DriveRule {
  readonly id: string;
  readonly triggerPattern: string;
  readonly effect: string;
  readonly enabled: boolean;
  readonly confidence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Proposed drive rule to be submitted for guardian review.
 *
 * This is the shape of a row being inserted into proposed_drive_rules.
 */
export interface ProposedRuleInput {
  readonly triggerPattern: string;
  readonly effect: string;
  readonly confidence: number;
  readonly proposedBy: string;
  readonly reasoning?: string;
}

@Injectable()
export class PostgresRulesClient {
  private readonly logger = new Logger(PostgresRulesClient.name);

  constructor(
    @Inject(POSTGRES_RUNTIME_POOL)
    private readonly pool: Pool,
  ) {}

  /**
   * Retrieve all enabled drive rules from the database.
   *
   * CANON §Drive Isolation: This is a read-only operation via RLS.
   * The database guarantees that only enabled rules are returned.
   *
   * @returns Array of active drive rules, or empty array if none exist
   * @throws Error if the database query fails
   */
  async getActiveRules(): Promise<DriveRule[]> {
    try {
      const result = await this.pool.query(
        `SELECT
          id,
          trigger_pattern AS "triggerPattern",
          effect,
          enabled,
          confidence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
         FROM drive_rules
         WHERE enabled = true
         ORDER BY created_at DESC`,
      );

      return result.rows.map((row) => ({
        id: row.id,
        triggerPattern: row.triggerPattern,
        effect: row.effect,
        enabled: row.enabled,
        confidence: row.confidence,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    } catch (error) {
      this.logger.error(
        `Failed to retrieve active drive rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Insert a new proposed drive rule for guardian review.
   *
   * CANON §No Self-Modification (Immutable Standard 6):
   * This is the only path for the system to propose changes to drive rules.
   * The proposed rule enters a review queue; only the guardian can approve
   * it into the active rule set via the dashboard.
   *
   * @param rule - The proposed rule data
   * @throws Error if the database insert fails
   */
  async insertProposedRule(rule: ProposedRuleInput): Promise<void> {
    try {
      const result = await this.pool.query(
        `INSERT INTO proposed_drive_rules
          (trigger_pattern, effect, confidence, proposed_by, reasoning, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING id`,
        [
          rule.triggerPattern,
          rule.effect,
          rule.confidence,
          rule.proposedBy,
          rule.reasoning || null,
          'pending',
        ],
      );

      if (result.rows.length === 0) {
        throw new Error('Failed to insert proposed rule - no row returned');
      }

      const insertedId = result.rows[0].id;
      this.logger.debug(
        `Proposed drive rule inserted with id=${insertedId}, status=pending, proposed_by=${rule.proposedBy}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to insert proposed drive rule: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
