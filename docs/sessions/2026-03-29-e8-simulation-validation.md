# 2026-03-29 -- Implement SimulationService & ConstraintValidationService (E8-T006, E8-T008)

## Changes

- NEW: `src/planning/simulation/simulation.service.ts` -- Full implementation of ISimulationService
  - Generates 3-5 candidate action types from research context knowledge
  - Evaluates each candidate via WKG historical action queries
  - Predicts drive effects by averaging similar past actions (conservative estimate if <3 similar)
  - Estimates success probability from historical frequency + evidence strength
  - Estimates information gain from WKG knowledge gap (1.0 - normalized node count)
  - Computes expected value = 0.4 * driveReliefScore + 0.35 * successProbability + 0.25 * informationGain
  - Emits SIMULATION_COMPLETED or SIMULATION_NO_VIABLE events
  - Grounded in current drive state (CANON Standard 1 Theater Prohibition)

- NEW: `src/planning/validation/constraint-validation.service.ts` -- Full implementation of IConstraintValidationService
  - Checker 1: Safety Constraints (no harmful keywords, abort conditions required)
  - Checker 2: Feasibility Constraints (no circular deps, <=10 steps, recognized action types)
  - Checker 3: Coherence Constraints (LLM-assisted with fallback if unavailable)
  - Checker 4: Immutable Standards (6 CANON standards: Theater Prohibition, Contingency Requirement, Confidence Ceiling, Shrug Imperative, Guardian Asymmetry, No Self-Modification)
  - Combines all failures and emits PLAN_VALIDATED or PLAN_VALIDATION_FAILED events
  - LLM call skipped gracefully if isAvailable() === false

## Wiring Changes

- Both services depend on: ConfigService, EVENTS_SERVICE, WKG_SERVICE, DRIVE_STATE_READER (for SimulationService)
- ConstraintValidationService additionally depends on: LLM_SERVICE
- Events emitted via createPlanningEvent builder (Planning subsystem boundary enforced)

## Known Issues

- SimulationService.querySubgraph uses basic label/level filter; could be enriched to parse contextKnowledge for semantic matching
- ConstraintValidationService coherence check LLM prompt could be more sophisticated (currently checks PASS/FAIL)
- sessionId in validation service hardcoded to 'unknown' (TODO: pass from caller)
- event data fields stripped due to TypeScript Event boundary narrowing (can be re-added when buildEvent is enhanced)

## Gotchas for Next Session

- createPlanningEvent type narrowing requires `as any` workaround (see procedure-creation.service.ts line 126 pattern)
- Drive effects averaging needs refinement: currently sums `${driveName}Effect` properties; real procedure nodes may use different naming
- Information gain calculation assumes max 20 contextual knowledge nodes (conservative estimate)
- Immutable Standards checks use keyword matching; sophisticated attacks might evade simple string matching
