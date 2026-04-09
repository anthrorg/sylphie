/**
 * ConstraintValidationService -- Deterministic plan safety and coherence validation.
 *
 * CANON SS Subsystem 5 (Planning): "Constraint Engine" validates proposed
 * plans against safety and coherence constraints. If validation fails, the plan
 * loops back to the Proposal phase for LLM-assisted refinement (up to MAX_RETRIES
 * times via ProposalService.refine).
 *
 * Constraints are evaluated as pure deterministic functions (no LLM, no I/O):
 *   1. STEP_TYPE_VALIDITY        -- every step type in VALID_STEP_TYPES
 *   2. ADDRESSES_OPPORTUNITY     -- plan references opportunity classification or drive
 *   3. PROCEDURE_CONFLICT        -- trigger context not an exact duplicate
 *   4. NO_THEATRICAL_BEHAVIOR    -- expressive steps grounded in drive effects (Standard 1)
 *   5. CONTINGENCY_TRACING       -- all steps carry traceable params (Standard 2)
 *
 * The LLM is NOT used for validation. It is still used in ProposalService.refine()
 * when a validation failure requires semantic revision of the proposal.
 *
 * Replaces prior LLM-based validation that: (a) used an expensive deep-tier call
 * at temperature 0.1 for purely structural checks, and (b) listed EMIT_EVENT as a
 * valid step type, which does not exist in ActionHandlerRegistryService.
 *
 * The deferred field is always false -- deterministic validation is always available.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { verboseFor } from '@sylphie/shared';
import type {
  IConstraintValidationService,
  ValidationResult,
  PlanProposal,
  QueuedOpportunity,
  IProposalService,
} from '../interfaces/planning.interfaces';
import { PROPOSAL_SERVICE } from '../planning.tokens';
import {
  checkStepTypeValidity,
  checkAddressesOpportunity,
  checkProcedureConflict,
  checkNoTheatricalBehavior,
  checkContingencyTracing,
  type ConstraintCheckResult,
} from './constraint-checks';

const vlog = verboseFor('Planning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum validation + refinement attempts before giving up. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ConstraintValidationService implements IConstraintValidationService {
  private readonly logger = new Logger(ConstraintValidationService.name);

  constructor(
    @Inject(PROPOSAL_SERVICE)
    private readonly proposalService: IProposalService,
  ) {}

  async validate(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): Promise<ValidationResult> {
    vlog('constraintValidation: starting', {
      proposalName: proposal.name,
      opportunityId: opportunity.payload.id,
      classification: opportunity.payload.classification,
      maxRetries: MAX_RETRIES,
    });

    // Fetch the set of existing trigger contexts once, before the retry loop.
    // Currently returns an empty set (no WKG query implemented yet).
    // When WKG integration is available, inject the WKG service here and
    // call it to populate this set.
    const existingTriggerContexts = this.fetchExistingTriggerContexts();

    let currentProposal = proposal;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = this.runValidation(
        currentProposal,
        opportunity,
        existingTriggerContexts,
        attempt,
      );

      vlog('constraintValidation: attempt result', {
        attempt,
        opportunityId: opportunity.payload.id,
        passed: result.passed,
        reasoning: result.reasoning.substring(0, 120),
        violations: result.violations,
      });

      if (result.passed) {
        return result;
      }

      // If this was the last attempt, return the failure.
      if (attempt >= MAX_RETRIES) {
        vlog('constraintValidation: all attempts exhausted', {
          opportunityId: opportunity.payload.id,
          attemptsUsed: attempt,
          violations: result.violations,
        });
        return result;
      }

      // Refine the proposal via LLM and retry.
      this.logger.debug(
        `Validation attempt ${attempt} failed, refining proposal. ` +
          `Violations: ${result.violations.join(', ')}`,
      );

      try {
        currentProposal = await this.proposalService.refine(
          currentProposal,
          result.violations,
          opportunity,
        );
      } catch (err) {
        this.logger.error(
          `Proposal refinement attempt ${attempt} threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Return the last validation failure rather than propagating the error.
        return result;
      }
    }

    // Should not reach here, but satisfy TypeScript.
    return {
      passed: false,
      reasoning: 'Max retries exhausted',
      violations: [],
      attemptsUsed: MAX_RETRIES,
      deferred: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Run all 5 deterministic constraint checks against the proposal.
   * Synchronous -- no I/O.
   */
  private runValidation(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
    existingTriggerContexts: ReadonlySet<string>,
    attempt: number,
  ): ValidationResult {
    const checks: ConstraintCheckResult[] = [
      checkStepTypeValidity(proposal),
      checkAddressesOpportunity(proposal, opportunity),
      checkProcedureConflict(proposal, existingTriggerContexts),
      checkNoTheatricalBehavior(proposal),
      checkContingencyTracing(proposal),
    ];

    const failures = checks.filter((c) => !c.passed);

    if (failures.length === 0) {
      const summary = checks.map((c) => c.constraint).join(', ');
      return {
        passed: true,
        reasoning: `All constraints passed: ${summary}.`,
        violations: [],
        attemptsUsed: attempt,
        deferred: false,
      };
    }

    const violations = failures.map((f) => f.constraint.toLowerCase());
    const reasoning = failures.map((f) => f.message).join(' | ');

    return {
      passed: false,
      reasoning,
      violations,
      attemptsUsed: attempt,
      deferred: false,
    };
  }

  /**
   * Returns the set of trigger contexts that already exist in the WKG.
   *
   * TODO: Inject IWkgService and query for existing ActionProcedure trigger
   * contexts. For now returns an empty set so constraint 3 never fires a false
   * positive during the bootstrap phase. The WKG integration task will wire this.
   */
  private fetchExistingTriggerContexts(): ReadonlySet<string> {
    return new Set<string>();
  }
}
