/**
 * GuardianRulesService — Dashboard API for guardian rule management.
 *
 * Provides read access to both proposed and active drive rules, plus
 * guardian-only approve/reject operations on proposed rules.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation):
 * Only the guardian (via the dashboard) can promote a proposed rule to
 * the active rule set. The system never calls approve/reject — those
 * code paths are only reachable through guardian-authenticated endpoints.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_RUNTIME_POOL } from '@sylphie/shared';

export interface ProposedRuleDto {
  readonly id: string;
  readonly triggerPattern: string;
  readonly effect: string;
  readonly confidence: number;
  readonly proposedBy: string;
  readonly reasoning: string | null;
  readonly status: string;
  readonly createdAt: string;
}

export interface ActiveRuleDto {
  readonly id: string;
  readonly triggerPattern: string;
  readonly effect: string;
  readonly enabled: boolean;
  readonly confidence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Injectable()
export class GuardianRulesService {
  private readonly logger = new Logger(GuardianRulesService.name);

  constructor(
    @Inject(POSTGRES_RUNTIME_POOL)
    private readonly pool: Pool,
  ) {}

  async getProposedRules(status?: string): Promise<ProposedRuleDto[]> {
    const filterStatus = status || 'pending';
    const result = await this.pool.query(
      `SELECT
        id,
        trigger_pattern AS "triggerPattern",
        effect,
        confidence,
        proposed_by AS "proposedBy",
        reasoning,
        status,
        created_at AS "createdAt"
       FROM proposed_drive_rules
       WHERE status = $1
       ORDER BY created_at DESC`,
      [filterStatus],
    );

    return result.rows.map((row) => ({
      id: row.id,
      triggerPattern: row.triggerPattern,
      effect: row.effect,
      confidence: row.confidence,
      proposedBy: row.proposedBy,
      reasoning: row.reasoning,
      status: row.status,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  async getActiveRules(): Promise<ActiveRuleDto[]> {
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
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }

  /**
   * Approve a proposed rule: copy it to drive_rules, mark as approved.
   *
   * Runs inside a transaction so the active rule insertion and status
   * update are atomic.
   */
  async approveRule(proposedRuleId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch the proposed rule
      const proposed = await client.query(
        `SELECT id, trigger_pattern, effect, confidence
         FROM proposed_drive_rules
         WHERE id = $1 AND status = 'pending'`,
        [proposedRuleId],
      );

      if (proposed.rows.length === 0) {
        throw new NotFoundException(
          `Proposed rule ${proposedRuleId} not found or not pending`,
        );
      }

      const rule = proposed.rows[0];

      // Insert into active rules
      await client.query(
        `INSERT INTO drive_rules (trigger_pattern, effect, confidence, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, true, now(), now())`,
        [rule.trigger_pattern, rule.effect, rule.confidence],
      );

      // Mark proposed rule as approved
      await client.query(
        `UPDATE proposed_drive_rules SET status = 'approved' WHERE id = $1`,
        [proposedRuleId],
      );

      await client.query('COMMIT');

      this.logger.log(
        `Guardian approved rule ${proposedRuleId}: trigger=${rule.trigger_pattern}`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reject a proposed rule: mark status as rejected, no active rule created.
   */
  async rejectRule(proposedRuleId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE proposed_drive_rules
       SET status = 'rejected'
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [proposedRuleId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException(
        `Proposed rule ${proposedRuleId} not found or not pending`,
      );
    }

    this.logger.log(`Guardian rejected rule ${proposedRuleId}`);
  }
}
