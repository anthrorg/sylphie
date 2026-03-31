# 2026-03-29 -- E4-T015: Cross-Module Drive Engine Integration

## Summary
Integrated the Drive Engine with all four consuming subsystems (Decision Making, Communication, Learning, Planning). All modules now properly import DriveEngineModule and inject the required tokens for reading drive state and reporting action outcomes.

## Changes

### MODIFIED: Decision Making
- **File:** `src/decision-making/decision-making.service.ts`
- **What:** Added `ACTION_OUTCOME_REPORTER` injection to existing `DRIVE_STATE_READER`
- **Why:** Enables decision cycle to report outcomes back to Drive Engine after action execution
- **Methods Updated:**
  - `processInput()`: Now documents TODO for calling `driveStateReader.getCurrentState()` before selection and `actionOutcomeReporter.reportOutcome()` after execution
  - `reportOutcome()`: Documents outcome reporting integration point
  - `getCognitiveContext()`: Already uses drive state (no change needed)

### MODIFIED: Communication
- **File:** `src/communication/communication.module.ts`
- **What:** Added `DriveEngineModule` to imports
- **Why:** Provides `DRIVE_STATE_READER` and `ACTION_OUTCOME_REPORTER` tokens to CommunicationService

- **File:** `src/communication/communication.service.ts`
- **What:** Added injections of `DRIVE_STATE_READER` and `ACTION_OUTCOME_REPORTER`
- **Why:** Enables theater validation, context injection into LLM, and Type 2 cost reporting
- **Methods Updated:**
  - `handleGuardianInput()`: TODO for drive state retrieval before LLM generation
  - `generateResponse()`: TODO for drive state context injection and Type 2 cost reporting
  - `initiateComment()`: TODO for real-time drive snapshot retrieval, theater validation, and outcome reporting

### MODIFIED: Learning
- **File:** `src/learning/learning.module.ts`
- **What:** Added `DriveEngineModule` to imports
- **Why:** Provides `DRIVE_STATE_READER` token to LearningService

- **File:** `src/learning/consolidation/learning.service.ts`
- **What:** Added injection of `DRIVE_STATE_READER`
- **Why:** Enables Cognitive Awareness threshold checks and Integrity drive integration
- **Methods Updated:**
  - `runMaintenanceCycle()`: TODO for drive state access (Integrity pressure for contradiction severity)
  - `shouldConsolidate()`: TODO for drive state synchronous check against Cognitive Awareness threshold

### MODIFIED: Planning
- **File:** `src/planning/planning.module.ts`
- **What:** Added `DriveEngineModule` to imports
- **Why:** Provides `DRIVE_STATE_READER` token to PlanningService

- **File:** `src/planning/planning.service.ts`
- **What:** Added injection of `DRIVE_STATE_READER`
- **Why:** Enables simulation to use current drive state for outcome prediction
- **Methods Updated:**
  - `processOpportunity()`: TODO for drive state retrieval during simulation

### NEW: Integration Documentation
- **File:** `docs/architecture/drive-engine-integration.md`
- **What:** Comprehensive guide to how Drive Engine is consumed by all subsystems
- **Content:**
  - Token imports and injection strategy
  - Per-subsystem integration points with data flow diagrams
  - Theater Prohibition integration details
  - Type 2 cost reporting mechanism
  - Drive Isolation enforcement (read-only, one-way communication)
  - Verification checklist

## Wiring Changes

### Module Imports (DI Container)
- Decision Making: Already had `DriveEngineModule` (unchanged)
- Communication: Now imports `DriveEngineModule` + `ConfigModule`
- Learning: Now imports `DriveEngineModule`
- Planning: Now imports `DriveEngineModule`

### Token Injections

| Service | Tokens | Purpose |
|---------|--------|---------|
| DecisionMakingService | DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER | Read drive state before action selection; report outcome after execution |
| CommunicationService | DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER | Inject drive state into LLM context; report Type 2 costs |
| LearningService | DRIVE_STATE_READER | Check consolidation threshold; use Integrity drive for contradiction scoring |
| PlanningService | DRIVE_STATE_READER | Retrieve drive state for outcome simulation |

### Data Flow (Read-Only + One-Way Reporting)

```
Decision Cycle Loop:
  DecisionMakingService.processInput()
    → driveStateReader.getCurrentState() [READ]
    → (action selection + execution)
    → actionOutcomeReporter.reportOutcome() [WRITE]
      → Drive Engine (internal processing)
        → if (opportunity) → Planning
        → if (cost) → cognitive load pressure

Communication Pipeline:
  CommunicationService.generateResponse()
    → driveStateReader.getCurrentState() [READ] for LLM context
    → LlmServiceImpl.generate() [Type 2 cost tracking]
    → actionOutcomeReporter.reportOutcome() [WRITE] with SoftwareMetrics

Learning Threshold Gate:
  LearningService.shouldConsolidate()
    → driveStateReader.getCurrentState() [READ]
    → check Cognitive Awareness drive > threshold

Planning Opportunity Loop:
  PlanningService.processOpportunity()
    → driveStateReader.getCurrentState() [READ] for simulation
    → SimulationService.simulate() [with drive snapshot]
    → (WKG procedure creation)
```

## Known Issues

1. **Decorator Syntax Fixed:** Initial decorator placement on parameter definitions caused TypeScript errors. Corrected by ensuring proper spacing between constructor `{}` and method comments.

2. **Existing Test Errors:** `src/drive-engine/__tests__/test-utils.ts` contains pre-existing type mismatches unrelated to E4-T015 integration. These are separate from the subsystem wiring completed here.

## Gotchas for Next Session

1. **Theater Validator Implementation:** When implementing `TheaterValidatorService.validate()`, remember to check both pressure (drive < 0.2) and relief (drive > 0.3) violations against the response content emotional register.

2. **Drive State Snapshot Lifecycle:** `getCurrentState()` returns a snapshot at call time. For long-running operations, a new snapshot may be needed mid-operation. Consider whether to capture once or refresh for critical thresholds.

3. **Type 2 Cost Reporting:** When implementing SoftwareMetrics reporting in Communication, track both latencyMs and tokensUsed. Drive Engine uses these to compute cognitive load pressure (Standard constraint).

4. **Opportunity Queue Design:** Planning's rate limiter should prevent both per-window caps and active-plans caps. The queue structure needs to support priority sorting (see `PlanningService.getOpportunityQueue()` signature).

5. **Learning Cycle Triggers:** The decision loop must check `LearningService.shouldConsolidate()` at the right gate (likely before or after action execution). Confirm with Decision Making epic.

## Files Modified

- `src/decision-making/decision-making.service.ts` (TOKEN INJECTIONS + TODOS)
- `src/communication/communication.module.ts` (IMPORT ADDED)
- `src/communication/communication.service.ts` (TOKEN INJECTIONS + TODOS)
- `src/learning/learning.module.ts` (IMPORT ADDED)
- `src/learning/consolidation/learning.service.ts` (TOKEN INJECTION + TODOS)
- `src/planning/planning.module.ts` (IMPORT ADDED)
- `src/planning/planning.service.ts` (TOKEN INJECTION + TODOS)
- `docs/architecture/drive-engine-integration.md` (NEW DOCUMENTATION)
