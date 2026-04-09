# Idea: Replace Constraint Validation LLM Call with Deterministic Rule Checks

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `ConstraintValidationService` uses a `deep`-tier LLM call (the most expensive tier) to validate plan proposals against 5 safety/coherence constraints. All 5 constraints are structural checks that can be expressed as deterministic rules, eliminating the LLM call entirely.

## Motivation

The constraint validation LLM call at `packages/planning/src/pipeline/constraint-validation.service.ts:195` asks the model to check:

1. **No conflict with existing procedures** — Can be checked by querying existing procedures from WKG and comparing trigger contexts / fingerprints for overlap.
2. **Plan addresses the opportunity** — Can verify that the plan's `affectedDrive` or `triggerContext` references the opportunity's classification.
3. **Action steps are executable** — Trivial set-membership check: `stepType ∈ {LLM_GENERATE, WKG_QUERY, EMIT_EVENT}`.
4. **No theatrical behavior** — Check that at least one action step connects to a drive effect (has a non-cosmetic observable outcome). A plan that only emits text with no drive connection is theatrical.
5. **Contingency tracing** — Verify action steps include contingency parameters or observable outcome fields.

The LLM adds no value here — it's checking structural properties of a JSON object against a known schema. Temperature is already 0.1, confirming the intent is deterministic. Moving to rules makes validation instant, free, and perfectly reproducible.

## Proposed Approach

```typescript
function validateConstraints(
  proposal: PlanProposal,
  opportunity: QueuedOpportunity,
  existingProcedures: WkgEntity[],
): ValidationResult {
  const violations: string[] = [];

  // Constraint 3: valid step types
  const VALID_STEP_TYPES = new Set(['LLM_GENERATE', 'WKG_QUERY', 'EMIT_EVENT']);
  for (const step of proposal.actionSequence) {
    if (!VALID_STEP_TYPES.has(step.stepType)) {
      violations.push(`invalid_step_type: ${step.stepType}`);
    }
  }

  // Constraint 2: addresses opportunity
  const addressesOpportunity =
    proposal.triggerContext.includes(opportunity.payload.classification) ||
    proposal.rationale.includes(opportunity.payload.affectedDrive);
  if (!addressesOpportunity) {
    violations.push('plan_does_not_address_opportunity');
  }

  // Constraint 1: no procedure conflict (fingerprint overlap)
  // Constraint 4: no theatrical behavior (drive connection check)
  // Constraint 5: contingency tracing (observable outcome fields)
  // ... (implementation details to be designed)

  return {
    passed: violations.length === 0,
    reasoning: violations.length === 0
      ? 'All constraints passed'
      : `Failed: ${violations.join(', ')}`,
    violations,
    attemptsUsed: 1,
    deferred: false,
  };
}
```

## Subsystems Affected

- Planning (constraint-validation.service.ts, planning.service.ts)

## Open Questions

- For constraint 4 (theater detection), what constitutes a "drive-connected side effect"? Need to define the structural test precisely.
- Should the refinement loop (proposal → validate → refine → re-validate) still exist, or does deterministic validation make single-pass sufficient?
- The current system defers validation when LLM is unavailable. With deterministic rules, validation is always available — does this change the queue behavior?
- Should there be a fallback to LLM for edge cases where rule-based validation is uncertain?
