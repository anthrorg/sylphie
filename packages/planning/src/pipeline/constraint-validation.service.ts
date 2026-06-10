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
 * FAIL-CLOSED on degraded WORLD: the PROCEDURE_CONFLICT check depends on the set
 * of existing trigger contexts fetched from Neo4j WORLD. If that fetch fails, the
 * conflict check would be blind -- silently writing a possibly-duplicate node and
 * resuming the exact graph corruption it exists to prevent. Instead, a fetch
 * failure returns a DEFERRED result so PlanningService re-enqueues the opportunity
 * and retries later. A deferred opportunity is recoverable; a phantom-twin
 * procedure is not.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { verboseFor, Neo4jService, Neo4jInstanceName } from '@sylphie/shared';
import type {
  IConstraintValidationService,
  ValidationResult,
  PlanProposal,
  QueuedOpportunity,
  IProposalService,
  IPlanningEventLogger,
} from '../interfaces/planning.interfaces';
import { PROPOSAL_SERVICE, PLANNING_EVENT_LOGGER } from '../planning.tokens';
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
    @Inject(PLANNING_EVENT_LOGGER)
    private readonly eventLogger: IPlanningEventLogger,
    private readonly neo4j: Neo4jService,
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
    // FAIL CLOSED: if the WORLD graph is unreachable we cannot run the
    // PROCEDURE_CONFLICT check, so we DEFER rather than write a possibly-duplicate
    // procedure. Returning an empty set here would silently re-open the
    // duplicate-procedure corruption on any transient DB blip.
    const fetch = await this.fetchExistingTriggerContexts();
    if (!fetch.ok) {
      const reasoning =
        'Procedure-conflict check could not run: WORLD graph unreachable while ' +
        `fetching existing trigger contexts (${fetch.error}). Deferring opportunity ` +
        `${opportunity.payload.id} to avoid writing a possibly-duplicate procedure.`;

      // Louder than warn: this is a degradation that suppresses a corruption guard.
      this.logger.error(reasoning);
      this.eventLogger.log('PLAN_VALIDATION_FAILED', {
        opportunityId: opportunity.payload.id,
        deferred: true,
        reason: 'world_unreachable_conflict_check_skipped',
        error: fetch.error,
      });

      return {
        passed: false,
        reasoning,
        violations: [],
        attemptsUsed: 0,
        deferred: true,
      };
    }

    const existingTriggerContexts = fetch.contexts;

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
   * Queries Neo4j WORLD for all existing ActionProcedure trigger contexts.
   * Prevents planning from writing duplicate procedures with the same trigger,
   * which would fragment confidence updates across phantom twin nodes.
   *
   * Returns a discriminated result so the caller can distinguish "no existing
   * procedures" (ok, empty set) from "could not check" (error). Those must NOT
   * be conflated: the latter requires deferral, not a blind pass.
   */
  private async fetchExistingTriggerContexts(): Promise<FetchTriggerContextsResult> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        'MATCH (p:ActionProcedure) WHERE p.trigger_context IS NOT NULL RETURN p.trigger_context AS ctx',
      );
      return {
        ok: true,
        contexts: new Set(result.records.map((r) => r.get('ctx') as string)),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await session.close();
    }
  }
}

/**
 * Result of fetching existing trigger contexts from the WORLD graph.
 * `ok: false` means the check could not be performed and the caller must defer.
 */
type FetchTriggerContextsResult =
  | { readonly ok: true; readonly contexts: ReadonlySet<string> }
  | { readonly ok: false; readonly error: string };
