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
 *
 * Pool routing (TK-155): reads (getProposedRules/getActiveRules) run on
 * POSTGRES_RUNTIME_POOL — the `sylphie_app` role, which TK-154 restricts to
 * SELECT on drive_rules/proposed_drive_rules. The two guardian WRITE
 * transactions (approveRule/rejectRule) run on POSTGRES_GUARDIAN_POOL — the
 * privileged `guardian_admin` role that alone retains DML on those tables.
 * This split is what makes the DB enforce Standard 6 rather than trusting
 * application code alone: even if a bug bypassed the guardian-JWT guard on
 * RulesController, the runtime pool's DB role physically cannot write.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_RUNTIME_POOL, POSTGRES_GUARDIAN_POOL } from '@sylphie/shared';

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
    private readonly runtimePool: Pool,
    @Inject(POSTGRES_GUARDIAN_POOL)
    private readonly guardianPool: Pool,
  ) {}

  /**
   * List proposed drive rules (default: pending only).
   *
   * Read-only — runs on POSTGRES_RUNTIME_POOL.
   */
  async getProposedRules(status?: string): Promise<ProposedRuleDto[]> {
    const filterStatus = status || 'pending';
    const result = await this.runtimePool.query(
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

  /**
   * List active (enabled) drive rules.
   *
   * Read-only — runs on POSTGRES_RUNTIME_POOL.
   */
  async getActiveRules(): Promise<ActiveRuleDto[]> {
    const result = await this.runtimePool.query(
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
   * Runs inside a single transaction — including the pending-rule lookup —
   * so the read, active-rule insertion, and status update are atomic. The
   * entire transaction runs on POSTGRES_GUARDIAN_POOL (the `guardian_admin`
   * role), since TK-154 revokes DML on both tables from the runtime pool.
   *
   * @throws NotFoundException if the proposed rule does not exist or is not
   *   pending.
   * @throws GuardianCredentialsNotConfiguredError (via the guardian pool) if
   *   POSTGRES_GUARDIAN_USER/PASSWORD are unset — fails closed, no write
   *   is attempted on any other pool.
   */
  async approveRule(proposedRuleId: string): Promise<void> {
    const client = await this.guardianPool.connect();
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
   *
   * This is a write on proposed_drive_rules, so it runs on
   * POSTGRES_GUARDIAN_POOL, not the runtime pool.
   *
   * @throws NotFoundException if the proposed rule does not exist or is not
   *   pending.
   * @throws GuardianCredentialsNotConfiguredError (via the guardian pool) if
   *   POSTGRES_GUARDIAN_USER/PASSWORD are unset — fails closed.
   */
  async rejectRule(proposedRuleId: string): Promise<void> {
    const result = await this.guardianPool.query(
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
