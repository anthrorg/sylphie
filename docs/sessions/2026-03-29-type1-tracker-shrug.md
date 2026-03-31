# 2026-03-29 -- E5-T012 (Shrug Imperative) & E5-T011 (Type 1 Tracker)

## Changes

### NEW: src/decision-making/shrug/shrug-imperative.service.ts
- Enforces CANON Immutable Standard 4 (Shrug Imperative)
- IShruggableActionService interface: shouldShrug(), createShrugAction(), logShrugEvent(), getMetrics()
- In-memory accumulation of shrug history for metrics computation
- Detects when all candidates are below threshold and signals incomprehension

### NEW: src/decision-making/shrug/index.ts
- Barrel export for ShruggableActionService and related types

### NEW: src/decision-making/graduation/type1-tracker.service.ts
- Tracks action lifecycle: UNCLASSIFIED → TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED → TYPE_1_DEMOTED
- IType1TrackerService interface: getState(), recordUse(), evaluateGraduation(), getMetrics()
- Graduation logic: confidence > 0.80 AND avg MAE (last 10) < 0.10
- Demotion logic: avg MAE > 0.15 (for graduated actions only)
- Emits TYPE_1_GRADUATION and TYPE_1_DEMOTION events to TimescaleDB
- Maintains transition history with reasons for audit trail

### NEW: src/decision-making/graduation/index.ts
- Barrel export for Type1TrackerService and related types

### MODIFIED: src/decision-making/decision-making.tokens.ts
- Added SHRUGGABLE_ACTION_SERVICE token (INTERNAL)
- Added TYPE_1_TRACKER_SERVICE token (INTERNAL)
- Both are internal tokens used by DecisionMakingModule only

## Wiring Changes
- Both services are injectable via NestJS DI with EVENTS_SERVICE dependency
- Ready for integration into arbitration.service (calls shrug detection)
- Ready for integration into confidence-updater.service (tracks graduation/demotion)

## Known Issues
- Event builder type narrowing requires `as any` cast for TYPE_1_GRADUATION, TYPE_1_DEMOTION, SHRUG_SELECTED (matches existing confidence-updater pattern)
- Both services maintain in-memory state only (no persistence to WKG yet — per spec, this is deferred)

## Gotchas for Next Session
- Type 1 Tracker's `recordUse()` requires sessionId and driveSnapshot for event logging — callers must provide these
- Shrug imperative's `logShrugEvent()` requires a reason string to be passed from arbitration logic
- Neither service modifies WKG nodes — they only track state and log events. Graph updates (confidence, Type 1 flags) are the responsibility of other subsystems
- The Shrug service tracks decision count but does not filter by subsystem; it will double-count if called from both Type 1 and Type 2 paths
