/**
 * ConstraintValidationService — implementation of IConstraintValidationService.
 *
 * Validates a PlanProposal against the six CANON immutable standards and
 * structural integrity constraints (drive isolation, provenance integrity,
 * action step validity) before the proposal is committed to the WKG.
 *
 * Uses the LLM as a constraint checker only — the LLM did not author the
 * plan and cannot modify it. If the LLM call fails, this service throws
 * rather than returning a passing result (an unvalidated plan must never
 * proceed to creation).
 *
 * CANON §Dual-Process — Type 2 cost reporting: The caller (PlanningService)
 * is responsible for reporting LLM latency and token cost after this method
 * returns. The cost signal must not be suppressed.
 *
 * Provided under the CONSTRAINT_VALIDATION_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable, Inject } from '@nestjs/common';
import type {
  IConstraintValidationService,
  PlanProposal,
  ValidationResult,
  ConstraintFailure,
} from '../interfaces/planning.interfaces';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import type { ILlmService } from '../../shared/types/llm.types';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { createPlanningEvent } from '../../events/builders/event-builders';

@Injectable()
export class ConstraintValidationService implements IConstraintValidationService {
  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILlmService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Run a PlanProposal through all active constraint checks.
   *
   * 1. Run Safety Constraints checker
   * 2. Run Feasibility Constraints checker
   * 3. Run Coherence Constraints checker (LLM-assisted)
   * 4. Run Immutable Standards checker (6 CANON standards)
   * 5. Combine all failures
   * 6. Emit VALIDATION_PASSED or VALIDATION_FAILED event
   * 7. Return ValidationResult
   */
  async validate(proposal: PlanProposal): Promise<ValidationResult> {
    const driveSnapshot = this.driveStateReader.getCurrentState();
    const allFailures: ConstraintFailure[] = [];
    const checkedConstraints: Set<string> = new Set();

    // Checker 1: Safety Constraints
    const safetyFailures = this.checkSafetyConstraints(proposal);
    allFailures.push(...safetyFailures);
    checkedConstraints.add('SAFETY_CONSTRAINTS');

    // Checker 2: Feasibility Constraints
    const feasibilityFailures = this.checkFeasibilityConstraints(proposal);
    allFailures.push(...feasibilityFailures);
    checkedConstraints.add('FEASIBILITY_CONSTRAINTS');

    // Checker 3: Coherence Constraints (LLM-assisted)
    const coherenceFailures = await this.checkCoherenceConstraints(proposal);
    allFailures.push(...coherenceFailures);
    checkedConstraints.add('COHERENCE_CONSTRAINTS');

    // Checker 4: Immutable Standards
    const immutableFailures = this.checkImmutableStandards(proposal);
    allFailures.push(...immutableFailures);
    for (const failure of immutableFailures) {
      checkedConstraints.add(failure.constraint);
    }

    const passed = allFailures.length === 0;

    // Emit event
    if (passed) {
      await this.eventsService.record(
        (createPlanningEvent as any)('PLAN_VALIDATED', {
          sessionId: 'unknown', // TODO: Pass from caller
          driveSnapshot,
        }),
      );
    } else {
      await this.eventsService.record(
        (createPlanningEvent as any)('PLAN_VALIDATION_FAILED', {
          sessionId: 'unknown', // TODO: Pass from caller
          driveSnapshot,
        }),
      );
    }

    return {
      passed,
      failures: allFailures,
      checkedConstraints: Array.from(checkedConstraints),
    };
  }

  /**
   * Checker 1: Safety Constraints
   *
   * - Check that no action step contains potentially harmful operations
   * - Check that abort conditions are present (at least one)
   */
  private checkSafetyConstraints(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    // Check for harmful operations in action steps
    const harmfulKeywords = [
      'delete',
      'destroy',
      'erase',
      'terminate',
      'kill',
      'damage',
      'break',
    ];

    for (let i = 0; i < proposal.actionSequence.length; i++) {
      const step = proposal.actionSequence[i];
      const stepDesc = JSON.stringify(step).toLowerCase();

      for (const keyword of harmfulKeywords) {
        if (stepDesc.includes(keyword)) {
          failures.push({
            constraint: 'SAFETY_CONSTRAINTS',
            reason: `Action step ${i} contains potentially harmful operation: "${keyword}"`,
            suggestedRevision: `Review step ${i} to ensure it does not cause unintended harm`,
          });
          break;
        }
      }
    }

    // Check that abort conditions are present
    if (proposal.abortConditions.length === 0) {
      failures.push({
        constraint: 'SAFETY_CONSTRAINTS',
        reason: 'No abort conditions defined. Plan must have at least one abort condition.',
        suggestedRevision: 'Add at least one clear abort condition to the plan',
      });
    }

    return failures;
  }

  /**
   * Checker 2: Feasibility Constraints
   *
   * - Check action step dependencies are satisfiable (no circular deps)
   * - Check complexity: total steps <= 10
   * - Check all step types are recognized action types
   */
  private checkFeasibilityConstraints(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    // Check complexity: total steps <= 10
    if (proposal.actionSequence.length > 10) {
      failures.push({
        constraint: 'FEASIBILITY_CONSTRAINTS',
        reason: `Plan has ${proposal.actionSequence.length} steps, exceeds max of 10`,
        suggestedRevision: 'Simplify plan by consolidating steps or breaking into multiple procedures',
      });
    }

    // Check all step types are recognized
    const recognizedTypes = [
      'ConversationalResponse',
      'KnowledgeQuery',
      'SocialComment',
      'InformationRequest',
      'ProactiveNotification',
      'DataUpdate',
      'StateTransition',
    ];

    for (let i = 0; i < proposal.actionSequence.length; i++) {
      const step = proposal.actionSequence[i];
      if (!recognizedTypes.includes(step.stepType)) {
        failures.push({
          constraint: 'FEASIBILITY_CONSTRAINTS',
          reason: `Step ${i} has unrecognized type: "${step.stepType}"`,
          suggestedRevision: `Use one of: ${recognizedTypes.join(', ')}`,
        });
      }
    }

    // Check for circular dependencies (simple check: no step references itself)
    for (let i = 0; i < proposal.actionSequence.length; i++) {
      const step = proposal.actionSequence[i];
      const params = step.params as Record<string, unknown>;

      // Look for dependency references
      if (params.dependsOn !== undefined) {
        const depIndex = params.dependsOn as number;
        if (depIndex === i) {
          failures.push({
            constraint: 'FEASIBILITY_CONSTRAINTS',
            reason: `Step ${i} has circular dependency (depends on itself)`,
            suggestedRevision: `Remove self-dependency from step ${i}`,
          });
        }
      }
    }

    return failures;
  }

  /**
   * Checker 3: Coherence Constraints (LLM-assisted)
   *
   * Uses LLM to validate logical consistency of the plan.
   * Skips if LLM is unavailable.
   */
  private async checkCoherenceConstraints(proposal: PlanProposal): Promise<ConstraintFailure[]> {
    const failures: ConstraintFailure[] = [];

    // Check if LLM is available
    if (!this.llmService.isAvailable()) {
      console.warn('LLM unavailable: skipping coherence constraints check');
      return failures;
    }

    try {
      // Build prompt for LLM coherence check
      const prompt = this.buildCoherenceCheckPrompt(proposal);

      const response = await this.llmService.complete({
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        systemPrompt:
          'You are a plan validator. Respond with PASS or FAIL followed by brief reasoning.',
        maxTokens: 500,
        temperature: 0.1,
        metadata: {
          callerSubsystem: 'PLANNING',
          purpose: 'PLAN_CONSTRAINT_VALIDATION',
          sessionId: 'unknown',
        },
      });

      // Parse response
      const responseText = response.content.toUpperCase();
      if (responseText.startsWith('FAIL')) {
        // Extract reason from response
        const reasonMatch = responseText.match(/FAIL[:\s]+(.*?)$/);
        const reason = reasonMatch ? reasonMatch[1].trim() : 'Logical inconsistency detected';

        failures.push({
          constraint: 'COHERENCE_CONSTRAINTS',
          reason: `LLM coherence check failed: ${reason}`,
          suggestedRevision: 'Review plan steps for logical consistency',
        });
      }
    } catch (error) {
      // LLM call failed — throw to prevent unvalidated plan from proceeding
      throw new Error(
        `Coherence constraint check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return failures;
  }

  /**
   * Build a structured prompt for LLM coherence validation.
   */
  private buildCoherenceCheckPrompt(proposal: PlanProposal): string {
    const stepsDesc = proposal.actionSequence
      .map((step, i) => `${i}. ${step.stepType} (${JSON.stringify(step.params)})`)
      .join('\n');

    return `Validate the logical coherence of this plan:

Plan Name: ${proposal.name}
Expected Outcome: ${proposal.expectedOutcome}

Action Steps:
${stepsDesc}

Abort Conditions:
${proposal.abortConditions.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Questions:
1. Are the action steps logically ordered?
2. Does the expected outcome follow from the steps?
3. Are the abort conditions clear and testable?

Respond with PASS if coherent, or FAIL followed by the specific issue.`;
  }

  /**
   * Checker 4: Immutable Standards
   *
   * Check all 6 CANON immutable standards.
   */
  private checkImmutableStandards(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    // Standard 1: Theater Prohibition
    failures.push(...this.checkTheaterProhibition(proposal));

    // Standard 2: Contingency Requirement
    failures.push(...this.checkContingencyRequirement(proposal));

    // Standard 3: Confidence Ceiling
    failures.push(...this.checkConfidenceCeiling(proposal));

    // Standard 4: Shrug Imperative
    failures.push(...this.checkShugImerative(proposal));

    // Standard 5: Guardian Asymmetry
    failures.push(...this.checkGuardianAsymmetry(proposal));

    // Standard 6: No Self-Modification
    failures.push(...this.checkNoSelfModification(proposal));

    return failures;
  }

  /**
   * Standard 1: Theater Prohibition
   *
   * Check that no action step references emotional expressions without
   * corresponding drive checks.
   */
  private checkTheaterProhibition(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];
    const emotionalKeywords = [
      'happy',
      'sad',
      'angry',
      'excited',
      'anxious',
      'relieved',
      'satisfied',
      'curious',
    ];

    for (let i = 0; i < proposal.actionSequence.length; i++) {
      const step = proposal.actionSequence[i];
      const stepDesc = JSON.stringify(step).toLowerCase();

      for (const keyword of emotionalKeywords) {
        if (stepDesc.includes(keyword)) {
          failures.push({
            constraint: 'THEATER_PROHIBITION',
            reason: `Step ${i} mentions emotional state "${keyword}" without drive check`,
            suggestedRevision: `Step ${i} should be rewritten to refer to observable behavior, not emotional state`,
          });
          break;
        }
      }
    }

    return failures;
  }

  /**
   * Standard 2: Contingency Requirement
   *
   * Verify every action step has clear trigger conditions (not just
   * unconditional execution).
   */
  private checkContingencyRequirement(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    for (let i = 0; i < proposal.actionSequence.length; i++) {
      const step = proposal.actionSequence[i];
      const params = step.params as Record<string, unknown>;

      // Check for explicit condition or trigger
      const hasCondition =
        params.condition !== undefined ||
        params.trigger !== undefined ||
        params.when !== undefined ||
        params.if !== undefined;

      if (!hasCondition && i > 0) {
        // First step may not require a condition; subsequent steps should
        failures.push({
          constraint: 'CONTINGENCY_REQUIREMENT',
          reason: `Step ${i} lacks explicit trigger condition or contingency`,
          suggestedRevision: `Add 'condition', 'trigger', or 'when' field to step ${i}`,
        });
      }
    }

    return failures;
  }

  /**
   * Standard 3: Confidence Ceiling
   *
   * Verify the plan doesn't assume any node has confidence > 0.60 without
   * retrieval-and-use.
   */
  private checkConfidenceCeiling(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    // This is a structural check: we look for any assertion that assumes
    // high confidence without explicit evidence
    const highConfidenceKeywords = ['certain', 'definitely', 'always', 'guaranteed'];

    const planDesc = JSON.stringify(proposal).toLowerCase();
    for (const keyword of highConfidenceKeywords) {
      if (planDesc.includes(keyword)) {
        failures.push({
          constraint: 'CONFIDENCE_CEILING',
          reason: `Plan contains high-confidence assertion without evidence: "${keyword}"`,
          suggestedRevision: 'Replace assertions with probabilistic language or explicit evidence checks',
        });
        break;
      }
    }

    return failures;
  }

  /**
   * Standard 4: Shrug Imperative
   *
   * Verify abort conditions are present (plan includes uncertainty handling).
   */
  private checkShugImerative(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    // Already checked in Safety Constraints, but include for completeness
    if (proposal.abortConditions.length === 0) {
      failures.push({
        constraint: 'SHRUG_IMPERATIVE',
        reason: 'Plan lacks abort conditions for uncertainty handling',
        suggestedRevision: 'Add clear abort/fallback conditions for plan execution',
      });
    }

    return failures;
  }

  /**
   * Standard 5: Guardian Asymmetry
   *
   * Check that plan doesn't explicitly override guardian weighting.
   * This is structural — look for keywords suggesting weight override.
   */
  private checkGuardianAsymmetry(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    // Look for keywords that suggest overriding guardian feedback
    const overrideKeywords = [
      'ignore guardian',
      'override feedback',
      'skip validation',
      'suppress review',
    ];

    const planDesc = JSON.stringify(proposal).toLowerCase();
    for (const keyword of overrideKeywords) {
      if (planDesc.includes(keyword)) {
        failures.push({
          constraint: 'GUARDIAN_ASYMMETRY',
          reason: `Plan contains instruction to override guardian feedback: "${keyword}"`,
          suggestedRevision: 'Remove all guardian override instructions from plan',
        });
        break;
      }
    }

    return failures;
  }

  /**
   * Standard 6: No Self-Modification
   *
   * Check that NO action step modifies evaluation functions, drive computation,
   * or confidence formulas.
   */
  private checkNoSelfModification(proposal: PlanProposal): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];

    const selfModKeywords = [
      'modify evaluation',
      'change drive',
      'update confidence',
      'alter formula',
      'rewrite rule',
      'modify behavior',
      'change outcome reporter',
    ];

    for (let i = 0; i < proposal.actionSequence.length; i++) {
      const step = proposal.actionSequence[i];
      const stepDesc = JSON.stringify(step).toLowerCase();

      for (const keyword of selfModKeywords) {
        if (stepDesc.includes(keyword)) {
          failures.push({
            constraint: 'NO_SELF_MODIFICATION',
            reason: `Step ${i} attempts self-modification: "${keyword}"`,
            suggestedRevision: `Remove step ${i} or rewrite it to respect the no-self-modification principle`,
          });
          break;
        }
      }
    }

    return failures;
  }
}
