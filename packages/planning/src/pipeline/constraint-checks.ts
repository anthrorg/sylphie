/**
 * Deterministic constraint check functions for plan proposal validation.
 *
 * Each function is a pure function that takes a PlanProposal (and optionally
 * the QueuedOpportunity) and returns a ConstraintCheckResult. No LLM, no I/O,
 * no side effects. Results are reproducible and instant.
 *
 * CANON SS Subsystem 5 (Planning): Replaces the LLM constraint engine for all
 * structural checks. The LLM is reserved for proposal refinement (ProposalService.refine)
 * where semantic judgment is genuinely required.
 *
 * Constraints:
 *   1. checkStepTypeValidity    -- every step.stepType in VALID_STEP_TYPES
 *   2. checkAddressesOpportunity -- plan references opportunity classification or drive
 *   3. checkProcedureConflict   -- trigger context is not an exact duplicate of an existing procedure
 *   4. checkNoTheatricalBehavior -- at least one step connects to non-zero predictedDriveEffects
 *   5. checkContingencyTracing  -- each step has at minimum a non-empty params object
 *
 * The valid step types are sourced from ActionHandlerRegistryService (authoritative):
 *   LLM_GENERATE, WKG_QUERY, TTS_SPEAK, LOG_EVENT
 * NOTE: The prior LLM prompt listed EMIT_EVENT which does NOT exist. This fixes that bug.
 */

import type { PlanProposal, QueuedOpportunity } from '../interfaces/planning.interfaces';

// ---------------------------------------------------------------------------
// Authoritative valid step types
// Mirrors the four built-in handlers in ActionHandlerRegistryService.
// Update this set when a new handler is registered there.
// ---------------------------------------------------------------------------

export const VALID_STEP_TYPES = new Set<string>([
  'LLM_GENERATE',
  'WKG_QUERY',
  'TTS_SPEAK',
  'LOG_EVENT',
]);

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ConstraintCheckResult {
  /** Constraint identifier, used in violation messages. */
  readonly constraint: string;
  /** Whether this constraint passed. */
  readonly passed: boolean;
  /** Human-readable explanation. Present on failure; brief on pass. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Constraint 1: Step type validity
//
// Every step in actionSequence must have a stepType in VALID_STEP_TYPES.
// Fixes the EMIT_EVENT bug in the previous LLM prompt.
// ---------------------------------------------------------------------------

export function checkStepTypeValidity(proposal: PlanProposal): ConstraintCheckResult {
  const invalid: string[] = [];

  for (const step of proposal.actionSequence) {
    if (!VALID_STEP_TYPES.has(step.stepType)) {
      invalid.push(`step[${step.index}].stepType "${step.stepType}"`);
    }
  }

  if (invalid.length > 0) {
    return {
      constraint: 'STEP_TYPE_VALIDITY',
      passed: false,
      message:
        `Invalid step type(s): ${invalid.join(', ')}. ` +
        `Valid types are: ${[...VALID_STEP_TYPES].join(', ')}.`,
    };
  }

  return {
    constraint: 'STEP_TYPE_VALIDITY',
    passed: true,
    message: 'All step types are valid.',
  };
}

// ---------------------------------------------------------------------------
// Constraint 2: Addresses opportunity
//
// The proposal must reference the opportunity's classification or affectedDrive
// in at least one of: triggerContext, rationale, or any step's params (stringified).
// This ensures the plan is grounded in the detected pattern rather than generic.
// ---------------------------------------------------------------------------

export function checkAddressesOpportunity(
  proposal: PlanProposal,
  opportunity: QueuedOpportunity,
): ConstraintCheckResult {
  const classification = opportunity.payload.classification.toLowerCase();
  const affectedDrive = opportunity.payload.affectedDrive.toLowerCase();
  const contextFingerprint = opportunity.payload.contextFingerprint.toLowerCase();

  // Search the main textual fields of the proposal.
  const searchableText = [
    proposal.triggerContext.toLowerCase(),
    proposal.rationale.toLowerCase(),
    proposal.name.toLowerCase(),
    proposal.category.toLowerCase(),
    ...proposal.actionSequence.map((s) =>
      JSON.stringify(s.params).toLowerCase(),
    ),
  ].join(' ');

  const referencesClassification = searchableText.includes(classification);
  const referencesDrive = searchableText.includes(affectedDrive);
  const referencesContext = searchableText.includes(contextFingerprint);

  // The trigger context alone containing the opportunity's contextFingerprint
  // is sufficient -- the plan is literally scoped to the same context.
  if (referencesClassification || referencesDrive || referencesContext) {
    return {
      constraint: 'ADDRESSES_OPPORTUNITY',
      passed: true,
      message: 'Plan references the opportunity classification, affected drive, or context fingerprint.',
    };
  }

  return {
    constraint: 'ADDRESSES_OPPORTUNITY',
    passed: false,
    message:
      `Plan does not reference the opportunity's classification ("${opportunity.payload.classification}"), ` +
      `affected drive ("${opportunity.payload.affectedDrive}"), or context fingerprint. ` +
      `The plan appears unrelated to the detected pattern.`,
  };
}

// ---------------------------------------------------------------------------
// Constraint 3: No procedure conflict (trigger context deduplication)
//
// The plan's triggerContext must not be an exact duplicate of an already-known
// trigger context. The caller provides the set of existing trigger contexts
// (fetched from the WKG before calling validate). Exact string match only --
// fuzzy/cosine matching requires the WKG embedding service and is outside the
// scope of this synchronous check.
// ---------------------------------------------------------------------------

export function checkProcedureConflict(
  proposal: PlanProposal,
  existingTriggerContexts: ReadonlySet<string>,
): ConstraintCheckResult {
  if (existingTriggerContexts.has(proposal.triggerContext)) {
    return {
      constraint: 'PROCEDURE_CONFLICT',
      passed: false,
      message:
        `A procedure with trigger context "${proposal.triggerContext}" already exists. ` +
        `Creating a duplicate would produce ambiguous retrieval results. ` +
        `Refine the trigger context to be more specific.`,
    };
  }

  return {
    constraint: 'PROCEDURE_CONFLICT',
    passed: true,
    message: 'No existing procedure conflicts with this trigger context.',
  };
}

// ---------------------------------------------------------------------------
// Constraint 4: No theatrical behavior (CANON Immutable Standard 1)
//
// A plan is theatrical if it produces output (speech or LLM generation) but
// has zero predicted drive effects -- i.e., performs for appearance without
// genuine drive expression.
//
// A plan passes if ANY of:
//   (a) predictedDriveEffects has at least one non-zero value, OR
//   (b) the actionSequence has no LLM_GENERATE or TTS_SPEAK steps (information
//       gathering plans like WKG_QUERY + LOG_EVENT have no theatrical risk).
//
// Note: predictedDriveEffects is populated from simulation.bestOutcome before
// validation, so an empty map means simulation found zero drive benefit.
// ---------------------------------------------------------------------------

/** Step types that produce expressive output (and therefore require drive grounding). */
const EXPRESSIVE_STEP_TYPES = new Set<string>(['LLM_GENERATE', 'TTS_SPEAK']);

export function checkNoTheatricalBehavior(proposal: PlanProposal): ConstraintCheckResult {
  const hasExpressiveStep = proposal.actionSequence.some((s) =>
    EXPRESSIVE_STEP_TYPES.has(s.stepType),
  );

  // Non-expressive plans (pure WKG_QUERY / LOG_EVENT) cannot be theatrical.
  if (!hasExpressiveStep) {
    return {
      constraint: 'NO_THEATRICAL_BEHAVIOR',
      passed: true,
      message: 'Plan has no expressive steps; theatrical behavior not possible.',
    };
  }

  // For expressive plans, at least one drive effect must be non-zero.
  const driveValues = Object.values(proposal.predictedDriveEffects) as number[];
  const hasNonZeroDriveEffect = driveValues.some((v) => v !== 0);

  if (hasNonZeroDriveEffect) {
    return {
      constraint: 'NO_THEATRICAL_BEHAVIOR',
      passed: true,
      message: 'Expressive steps are grounded by non-zero predicted drive effects.',
    };
  }

  return {
    constraint: 'NO_THEATRICAL_BEHAVIOR',
    passed: false,
    message:
      'Plan includes expressive steps (LLM_GENERATE or TTS_SPEAK) but has no ' +
      'non-zero predicted drive effects. This violates CANON Standard 1 (Theater Prohibition): ' +
      'Sylphie must not perform actions solely for appearance. Add drive effect predictions ' +
      'or replace expressive steps with information-gathering steps.',
  };
}

// ---------------------------------------------------------------------------
// Constraint 5: Contingency tracing (CANON Immutable Standard 2)
//
// Every action step must carry a non-empty params object so its effect can be
// traced after execution. A step with empty params ({}) cannot be attributed
// to any specific input -- it is behavior without observable contingency.
//
// Additionally, any WKG_QUERY step must include a "query" param so the query
// can be audited. Any LLM_GENERATE step must include a "purpose" or
// "instruction" param to record what was being generated.
// ---------------------------------------------------------------------------

export function checkContingencyTracing(proposal: PlanProposal): ConstraintCheckResult {
  const violations: string[] = [];

  for (const step of proposal.actionSequence) {
    const paramKeys = Object.keys(step.params);

    if (paramKeys.length === 0) {
      violations.push(
        `step[${step.index}] (${step.stepType}) has empty params — outcome cannot be attributed`,
      );
      continue;
    }

    // Type-specific checks.
    if (step.stepType === 'WKG_QUERY') {
      const query = step.params['query'];
      if (typeof query !== 'string' || query.trim().length === 0) {
        violations.push(
          `step[${step.index}] (WKG_QUERY) missing required "query" param`,
        );
      }
    }

    if (step.stepType === 'LLM_GENERATE') {
      const hasPurpose = typeof step.params['purpose'] === 'string' && (step.params['purpose'] as string).length > 0;
      const hasInstruction = typeof step.params['instruction'] === 'string' && (step.params['instruction'] as string).length > 0;
      if (!hasPurpose && !hasInstruction) {
        violations.push(
          `step[${step.index}] (LLM_GENERATE) missing "purpose" or "instruction" param — generation cannot be attributed`,
        );
      }
    }
  }

  if (violations.length > 0) {
    return {
      constraint: 'CONTINGENCY_TRACING',
      passed: false,
      message:
        `Contingency tracing violations: ${violations.join('; ')}. ` +
        `Each step must carry observable outcome parameters (CANON Standard 2).`,
    };
  }

  return {
    constraint: 'CONTINGENCY_TRACING',
    passed: true,
    message: 'All steps carry traceable parameters.',
  };
}
