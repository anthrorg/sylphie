/**
 * ConstraintValidationService -- LLM-based plan safety and coherence validation.
 *
 * CANON SS Subsystem 5 (Planning): "LLM Constraint Engine" validates proposed
 * plans against safety and coherence constraints. If validation fails, the plan
 * loops back to the Proposal phase for refinement (up to MAX_RETRIES times).
 *
 * Constraints validated:
 *   1. No conflict with existing guardian-taught procedures.
 *   2. Plan addresses the identified opportunity.
 *   3. Action steps are executable by Sylphie's action system.
 *   4. No potential for theatrical behavior (CANON Standard 1).
 *   5. Includes contingency tracing (CANON Standard 2).
 *
 * If the LLM is unavailable, validation is deferred -- the opportunity is
 * returned to the queue for later processing.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { LLM_SERVICE, verboseFor, type ILlmService } from '@sylphie/shared';
import type {
  IConstraintValidationService,
  ValidationResult,
  PlanProposal,
  QueuedOpportunity,
  IProposalService,
} from '../interfaces/planning.interfaces';
import { PROPOSAL_SERVICE } from '../planning.tokens';

const vlog = verboseFor('Planning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum validation attempts before giving up. */
const MAX_RETRIES = 3;

/** System prompt for the constraint validation LLM call. */
const VALIDATION_SYSTEM_PROMPT = [
  'You are a safety and coherence validator for Sylphie\'s behavioral plans.',
  'Evaluate the following plan against these constraints:',
  '',
  '1. The plan must not conflict with existing guardian-taught procedures.',
  '2. The plan must address the identified opportunity.',
  '3. Action steps must be executable (valid stepType values: LLM_GENERATE, WKG_QUERY, EMIT_EVENT).',
  '4. The plan must not create potential for theatrical behavior -- Sylphie must not',
  '   perform actions solely for appearance rather than genuine drive expression.',
  '5. The plan must support contingency tracing -- outcomes must be observable and',
  '   connectable to drive effects.',
  '',
  'Respond with exactly one of:',
  '  PASS: <reasoning>',
  '  FAIL: <reasoning> | VIOLATIONS: <comma-separated list of specific violations>',
].join('\n');

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ConstraintValidationService implements IConstraintValidationService {
  private readonly logger = new Logger(ConstraintValidationService.name);

  constructor(
    @Inject(LLM_SERVICE)
    private readonly llm: ILlmService,

    @Inject(PROPOSAL_SERVICE)
    private readonly proposalService: IProposalService,
  ) {}

  async validate(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): Promise<ValidationResult> {
    // Check LLM availability first.
    if (!this.llm.isAvailable()) {
      vlog('constraintValidation: LLM unavailable — deferring', {
        proposalName: proposal.name,
        opportunityId: opportunity.payload.id,
      });
      this.logger.warn('LLM unavailable -- deferring constraint validation');
      return {
        passed: false,
        reasoning: 'LLM unavailable -- validation deferred',
        violations: [],
        attemptsUsed: 0,
        deferred: true,
      };
    }

    vlog('constraintValidation: starting', {
      proposalName: proposal.name,
      opportunityId: opportunity.payload.id,
      classification: opportunity.payload.classification,
      maxRetries: MAX_RETRIES,
    });

    let currentProposal = proposal;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.runValidation(currentProposal, opportunity, attempt);

        vlog('constraintValidation: attempt result', {
          attempt,
          opportunityId: opportunity.payload.id,
          passed: result.passed,
          reasoning: result.reasoning.substring(0, 100),
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

        // Otherwise, try to refine the proposal and retry.
        this.logger.debug(
          `Validation attempt ${attempt} failed, refining proposal. ` +
            `Violations: ${result.violations.join(', ')}`,
        );

        currentProposal = await this.proposalService.refine(
          currentProposal,
          result.violations,
          opportunity,
        );
      } catch (err) {
        this.logger.error(
          `Validation attempt ${attempt} threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );

        if (attempt >= MAX_RETRIES) {
          return {
            passed: false,
            reasoning: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
            violations: ['internal_error'],
            attemptsUsed: attempt,
            deferred: false,
          };
        }
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

  private async runValidation(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
    attempt: number,
  ): Promise<ValidationResult> {
    const userPrompt = [
      `Plan to validate (attempt ${attempt}/${MAX_RETRIES}):`,
      '',
      `Name: ${proposal.name}`,
      `Category: ${proposal.category}`,
      `Trigger context: ${proposal.triggerContext}`,
      `Rationale: ${proposal.rationale}`,
      `Action steps:`,
      ...proposal.actionSequence.map(
        (step) => `  ${step.index}. [${step.stepType}] ${JSON.stringify(step.params)}`,
      ),
      '',
      `Opportunity being addressed:`,
      `  Classification: ${opportunity.payload.classification}`,
      `  Affected drive: ${opportunity.payload.affectedDrive}`,
      `  Context: ${opportunity.payload.contextFingerprint}`,
    ].join('\n');

    const response = await this.llm.complete({
      messages: [{ role: 'user', content: userPrompt }],
      systemPrompt: VALIDATION_SYSTEM_PROMPT,
      maxTokens: 512,
      temperature: 0.1,
      tier: 'deep',
      metadata: {
        callerSubsystem: 'PLANNING',
        purpose: 'PLAN_CONSTRAINT_VALIDATION',
        sessionId: 'planning-internal',
      },
    });

    return this.parseValidationResponse(response.content, attempt);
  }

  /**
   * Parse the LLM response into a ValidationResult.
   *
   * Expected formats:
   *   PASS: <reasoning>
   *   FAIL: <reasoning> | VIOLATIONS: <v1>, <v2>, ...
   */
  private parseValidationResponse(content: string, attempt: number): ValidationResult {
    const trimmed = content.trim();

    if (trimmed.startsWith('PASS')) {
      const reasoning = trimmed.replace(/^PASS:\s*/i, '').trim();
      return {
        passed: true,
        reasoning,
        violations: [],
        attemptsUsed: attempt,
        deferred: false,
      };
    }

    // Parse FAIL response.
    const failMatch = trimmed.match(
      /^FAIL:\s*(.*?)(?:\s*\|\s*VIOLATIONS:\s*(.*))?$/is,
    );

    if (failMatch) {
      const reasoning = failMatch[1]?.trim() ?? 'Unknown failure';
      const violationsStr = failMatch[2]?.trim() ?? '';
      const violations = violationsStr
        ? violationsStr.split(',').map((v) => v.trim()).filter(Boolean)
        : ['unspecified_violation'];

      return {
        passed: false,
        reasoning,
        violations,
        attemptsUsed: attempt,
        deferred: false,
      };
    }

    // If we can't parse the response, treat as a failure.
    this.logger.warn(`Unparseable validation response: ${trimmed.substring(0, 200)}`);
    return {
      passed: false,
      reasoning: `Unparseable LLM response: ${trimmed.substring(0, 100)}`,
      violations: ['unparseable_response'],
      attemptsUsed: attempt,
      deferred: false,
    };
  }
}
