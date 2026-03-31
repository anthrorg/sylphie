# Drive Engine Integration (E4-T015)

## Overview

This document describes how the Drive Engine is integrated into all consuming subsystems: Decision Making, Communication, Learning, and Planning. Each subsystem reads drive state via `DRIVE_STATE_READER` and/or reports action outcomes via `ACTION_OUTCOME_REPORTER`.

## Token Imports

All subsystems import from the Drive Engine barrel export (`src/drive-engine/index.ts`):

```typescript
import { DriveEngineModule, DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER } from '../drive-engine';
import type { IDriveStateReader, IActionOutcomeReporter } from '../drive-engine/interfaces/drive-engine.interfaces';
```

## Subsystem Integration Details

### 1. Decision Making (`src/decision-making/`)

**Module:** `DecisionMakingModule`
- **Imports:** `DriveEngineModule`
- **Service:** `DecisionMakingService`

**Injected Tokens:**
- `DRIVE_STATE_READER` (reads drive state)
- `ACTION_OUTCOME_REPORTER` (reports outcomes)

**Integration Points:**

1. **`processInput()`**: Called by Communication when a new input arrives.
   - Calls `driveStateReader.getCurrentState()` **before** action selection
   - Uses drive snapshot to inform action retrieval (via Type 1/Type 2 arbitration)
   - Calls `actionOutcomeReporter.reportOutcome()` **after** action execution
   - Feeds observed outcome back to Drive Engine for behavior evaluation

2. **`reportOutcome()`**: Called after action execution.
   - Reports outcome to Drive Engine via `actionOutcomeReporter`
   - Triggers prediction evaluation, confidence updates, and Type 1 graduation checks
   - Drive Engine uses outcome to detect opportunities

3. **`getCognitiveContext()`**: Called by Communication for LLM context assembly.
   - Already uses `driveStateReader.getCurrentState()` to populate `CognitiveContext.driveSnapshot`
   - Ensures Communication always has real drive state for context injection

**Data Flow:**
```
DecisionMakingService.processInput()
  → driveStateReader.getCurrentState()
    → (use drive snapshot for Type 1/Type 2 arbitration)
  → (execute action)
  → actionOutcomeReporter.reportOutcome()
    → (Drive Engine evaluates outcome, detects opportunities)
```

---

### 2. Communication (`src/communication/`)

**Module:** `CommunicationModule`
- **Imports:** `ConfigModule`, `DriveEngineModule`
- **Service:** `CommunicationService`

**Injected Tokens:**
- `DRIVE_STATE_READER` (reads drive state before LLM calls)
- `ACTION_OUTCOME_REPORTER` (reports comment outcomes)

**Integration Points:**

1. **`handleGuardianInput()`**: Processes raw guardian input.
   - Calls `driveStateReader.getCurrentState()` **before** LLM response generation
   - Injects drive snapshot into LLM context to shape response
   - Reports Type 2 cost (latencyMs, tokensUsed) via `actionOutcomeReporter` after LLM call

2. **`generateResponse()`**: Generates response for Decision-Making-dispatched ActionIntent.
   - Retrieves drive state via `driveStateReader.getCurrentState()` for context injection
   - Tracks Type 2 cost (latency, tokens)
   - Reports outcome via `actionOutcomeReporter.reportOutcome()` with `SoftwareMetrics` payload
   - Drive Engine uses cost to inform drive pressure (cognitive load)

3. **`initiateComment()`**: Generates spontaneous comment driven by drive state.
   - Calls `driveStateReader.getCurrentState()` to get real-time drive snapshot
   - Generates LLM response with drive-motivated prompt
   - Passes response to `TheaterValidatorService.validate()` for authenticity check
   - If validation passes, reports outcome via `actionOutcomeReporter`
   - Returns null if validation fails (Shrug Imperative, Standard 4)

**Theater Prohibition Integration:**
- `TheaterValidatorService` enforces CANON Standard 1: output must correlate with actual drive state
- Pressure check: violation when drive < 0.2 and response expresses that need
- Relief check: violation when drive > 0.3 and response expresses relief
- Prevents "performing emotions she doesn't have"

**Data Flow:**
```
CommunicationService.generateResponse()
  → driveStateReader.getCurrentState()
    → (inject drive state into LLM prompt)
  → LlmServiceImpl.generate() [Type 2 cost tracked]
  → actionOutcomeReporter.reportOutcome()
    → (Drive Engine: cognitive load pressure update)

CommunicationService.initiateComment()
  → driveStateReader.getCurrentState()
  → LlmServiceImpl.generate()
  → TheaterValidatorService.validate(response, driveSnapshot)
  → if (passed) actionOutcomeReporter.reportOutcome()
  → return response || null
```

---

### 3. Learning (`src/learning/`)

**Module:** `LearningModule`
- **Imports:** `DriveEngineModule`
- **Service:** `LearningService`

**Injected Tokens:**
- `DRIVE_STATE_READER` (reads drive state for context)

**Integration Points:**

1. **`runMaintenanceCycle()`**: Executes consolidation pipeline.
   - Calls `driveStateReader.getCurrentState()` to access Integrity drive pressure
   - Uses drive state to inform contradiction severity scoring
   - Higher Integrity drive pressure → higher confidence in detected contradictions
   - Contradictions trigger learning cycle acceleration

2. **`shouldConsolidate()`**: Checks if consolidation threshold is exceeded.
   - Reads `driveStateReader.getCurrentState()` synchronously
   - Checks if Cognitive Awareness drive pressure > consolidation threshold
   - Returns true/false to gate Learning cycle triggering

**Event Subscription:**
- Future: Learning may subscribe to drive events (e.g., when Integrity increases)
- Trigger: When contradiction detected, Learning could auto-trigger maintenance cycle

**Data Flow:**
```
DecisionMakingService (via decision loop)
  → LearningService.shouldConsolidate()
    → driveStateReader.getCurrentState()
      → check Cognitive Awareness drive pressure
  → if (threshold exceeded) LearningService.runMaintenanceCycle()
    → driveStateReader.getCurrentState()
      → (use Integrity drive for contradiction severity)
    → (consolidation pipeline)
    → (WKG writes)
```

---

### 4. Planning (`src/planning/`)

**Module:** `PlanningModule`
- **Imports:** `DriveEngineModule`
- **Service:** `PlanningService`

**Injected Tokens:**
- `DRIVE_STATE_READER` (reads drive state for simulation context)

**Integration Points:**

1. **`processOpportunity()`**: Processes Opportunity from Drive Engine.
   - Receives `Opportunity` event (generated by Drive Engine when action outcome is evaluated)
   - Calls `driveStateReader.getCurrentState()` for outcome simulation context
   - Simulation uses current drive state to predict effect of candidate procedures
   - Uses `SimulationService` to evaluate whether procedure would improve drive state
   - Creates procedure nodes in WKG with `LLM_GENERATED` provenance at confidence 0.35

**Opportunity Reception:**
- Opportunities flow from `ACTION_OUTCOME_REPORTER.reportOutcome()` in Decision Making
- Drive Engine emits `OPPORTUNITY_CREATED` events when action outcome violates prediction
- Planning subscribes to these events and queues opportunities for processing

**Rate Limiting:**
- `PlanningRateLimiterService` gates opportunity processing to prevent resource exhaustion
- Prevents "Planning Runaway" attractor state

**Data Flow:**
```
DecisionMakingService.reportOutcome()
  → actionOutcomeReporter.reportOutcome()
    → (Drive Engine: outcome evaluation)
    → if (violation) emit OPPORTUNITY_CREATED
      → PlanningService.processOpportunity()
        → driveStateReader.getCurrentState()
          → (simulation context)
        → SimulationService.simulate(candidateProcedures, driveSnapshot)
        → (WKG procedure creation)
```

---

## Isolation and Write Protection

**CANON §Drive Isolation:**
- All subsystems **read-only** from Drive Engine via `DRIVE_STATE_READER`
- All subsystems **report outcomes** via `ACTION_OUTCOME_REPORTER` (one-way channel)
- **No subsystem writes to Drive Engine rules or state**
- Drive rules in PostgreSQL are write-protected; only guardian-approved changes permitted
- This prevents the system from optimizing its own reward signal

**One-Way Communication:**
```
Subsystems → (query drive state via DRIVE_STATE_READER)
Subsystems → (report outcomes via ACTION_OUTCOME_REPORTER)
Drive Engine → (internal only: rule evaluation, opportunity detection)
```

---

## Verification Checklist

- [x] Decision Making: Injects `DRIVE_STATE_READER` and `ACTION_OUTCOME_REPORTER`
- [x] Communication: Injects `DRIVE_STATE_READER` and `ACTION_OUTCOME_REPORTER`
- [x] Learning: Injects `DRIVE_STATE_READER`
- [x] Planning: Injects `DRIVE_STATE_READER`
- [x] All modules import `DriveEngineModule`
- [x] Theater Prohibition integration in Communication (pre-flight validation)
- [x] Type 2 cost reporting in Communication (SoftwareMetrics)
- [x] Prediction evaluation loop in Decision Making (report outcome → drive engine)
- [x] Opportunity processing in Planning (receives OPPORTUNITY_CREATED events)
- [x] npx tsc --noEmit passes (no TypeScript errors in subsystems)

---

## Related Documents

- **CANON:** `wiki/CANON.md` — Immutable architecture design, §Drive Isolation
- **Decision Making:** `src/decision-making/decision-making.module.ts`
- **Communication:** `src/communication/communication.module.ts`
- **Learning:** `src/learning/learning.module.ts`
- **Planning:** `src/planning/planning.module.ts`
- **Drive Engine:** `src/drive-engine/index.ts` (public API barrel)
