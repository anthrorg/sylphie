/**
 * RuleProposerService — Submit drive rules for guardian review.
 *
 * CANON §No Self-Modification (Immutable Standard 6):
 * This service submits proposed drive rules to the PostgreSQL review queue
 * (proposed_drive_rules table). The system can only INSERT into this table;
 * active rules (drive_rules) are write-protected by RLS and can only be
 * modified by guardians through the dashboard.
 *
 * All rule proposals are stored with:
 * - The proposed rule data (trigger_pattern, effect, confidence)
 * - The rationale (required for guardian review)
 * - The proposer identity (SYSTEM or GUARDIAN)
 * - Status set to 'pending' (awaiting guardian approval)
 *
 * Logging: All proposals are logged to the application audit trail. External
 * event emission (to TimescaleDB) would require drive state context that is
 * not available in this service; the Drive Engine or Planning subsystem should
 * emit RULE_PROPOSED events when they detect proposal patterns.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  IRuleProposer,
  ProposedDriveRule,
} from './interfaces/drive-engine.interfaces';
import { PostgresRulesClient } from './rule-proposer/postgres-rules-client';

@Injectable()
export class RuleProposerService implements IRuleProposer {
  private readonly logger = new Logger(RuleProposerService.name);

  constructor(private readonly rulesClient: PostgresRulesClient) {}

  /**
   * Submit a new drive rule for guardian review.
   *
   * Converts the IRuleProposer interface format to the database format and
   * inserts into the proposed_drive_rules table. The rule remains in 'pending'
   * status until the guardian reviews and approves it via the dashboard.
   *
   * CANON §No Self-Modification: This is the only mechanism by which the
   * system can propose changes to its own evaluation rules. Actual rule changes
   * are gated by the guardian.
   *
   * Logging: All rule proposals are logged for the audit trail. Callers should
   * monitor application logs for successful and failed proposals.
   *
   * @param rule - The proposed rule, including rationale for guardian review.
   * @throws {Error} If the database insert fails
   */
  async proposeRule(rule: ProposedDriveRule): Promise<void> {
    try {
      // Map IRuleProposer format to database format
      // driveEffects is a partial record of drive names to deltas
      // We serialize this as the effect string for now
      const effectString = JSON.stringify(rule.driveEffects);

      await this.rulesClient.insertProposedRule({
        triggerPattern: rule.eventType,
        effect: effectString,
        confidence: 0.5, // Base confidence for new proposals
        proposedBy: rule.proposedBy,
        reasoning: rule.rationale,
      });

      this.logger.log(
        `Rule proposed successfully: trigger=${rule.eventType}, proposed_by=${rule.proposedBy}, condition=${rule.condition}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to propose rule: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
