# 2026-03-29 — TheaterValidatorService Implementation (E6-T006)

## Summary
Implemented the complete TheaterValidatorService with keyword-based emotion detection to enforce CANON Immutable Standard 1 (Theater Prohibition). The service validates that LLM-generated responses correlate with actual drive state before delivery.

## Changes

### NEW: TheaterValidatorService
- **File**: `src/communication/theater-validator/theater-validator.service.ts`
- **What**: Complete production implementation (no stubs)
- **Why**: Enforce Theater Prohibition — output must correlate with actual drive state

### Implementation Details
- **Emotion Detection**: Keyword-based scanning (rule-based, no LLM dependency)
  - 8 emotion categories: Satisfaction, Sadness, Anxiety, Guilt, Boredom, Curiosity, Social (positive/negative), Relief
  - All 12 drives covered through keyword mappings
  - Relief keywords modulate interpretation of pressure-based drives

- **Validation Logic**:
  - Pressure expressions: drive must be > 0.2 to authenticate (can't perform unmet needs you don't feel)
  - Relief expressions: drive must be < 0.3 to authenticate (can't claim relief you haven't earned)
  - Extended relief states supported: drives range [-10.0, 1.0] with negative values as genuine relief
  - Ambiguous zone (0.2-0.3): boundary conditions handled correctly

- **Correlation Computation**: Overall correlation score [0.0, 1.0]
  - Measures match between expressed emotions and actual drive state
  - Theater detected when correlation < 0.4 AND violations present

- **Event Logging**: Theater violations logged to TimescaleDB via EventsService
  - RESPONSE_GENERATED events emitted for audit trail
  - Graceful error handling: logging failures don't block validation

### NEW: Comprehensive Unit Tests
- **File**: `src/communication/theater-validator/__tests__/theater-validator.service.spec.ts`
- **Coverage**: 43 tests, 100% pass rate
  - Pressure expressions (8 drives tested)
  - Relief expressions (contentment/calm validation)
  - All 12 drives emotion mapping
  - Ambiguous zone (0.2-0.3) boundary conditions
  - Extended relief states (negative drive values down to -10.0)
  - Multiple violations reporting
  - Correlation computation
  - Theater detection threshold
  - Event logging (success, failure, error recovery)
  - Edge cases (empty text, no keywords, case-insensitivity, word boundaries, repeats)
  - Reinforcement implication (zero reinforcement on violation)

### MODIFIED: CommunicationModule
- **File**: `src/communication/communication.module.ts`
- **What**: Added EventsModule import
- **Why**: TheaterValidatorService injects IEventService to log violations

## Wiring Changes
- TheaterValidatorService now has IEventService injected via EVENTS_SERVICE token
- EventsModule provides EVENTS_SERVICE to Communication subsystem
- No circular dependencies introduced
- CommunicationModule maintains its exports (COMMUNICATION_SERVICE, INPUT_PARSER_SERVICE, LLM_SERVICE)

## Known Issues
None. All tests pass. TypeScript compilation clean (except pre-existing ws type issue).

## Gotchas for Next Session
1. **Relief Keyword Modulation**: Relief keywords (calm, peaceful) modulate interpretation of pressure-based drives. When both relief keywords AND pressure keywords are present, need to evaluate separately.
2. **Social Drive Complexity**: Social has both positive (connection) and negative (loneliness) expressions. Current impl: positive = relief (negative score), negative = pressure (positive score).
3. **Correlation Boundary**: Theater threshold is correlation < 0.4. This is relatively permissive — can be tuned based on observational data.
4. **Event Logging**: Theater events logged to TimescaleDB, but the event type is RESPONSE_GENERATED (reused from Communication events). Could benefit from a dedicated THEATER_VIOLATION event type in future epic.
5. **LLM Context Injection**: The motivatingDrive from ActionIntent should guide the LLM toward authentic expression. Theater validator catches failures but doesn't fix them. Future: RejectionStrategy when theater detected.

## Test Execution
```bash
npm test -- src/communication/theater-validator/__tests__/theater-validator.service.spec.ts
# Result: PASS (43/43 tests)

npx tsc --noEmit
# Result: CLEAN (no theater-validator errors)
```

## Verification Checklist
- [x] No stubs or fake work — all functions have real logic
- [x] Keyword-based emotion detection (no LLM dependency)
- [x] All 12 drives covered in emotion mapping
- [x] Pressure threshold: drive > 0.2
- [x] Relief threshold: drive < 0.3
- [x] Ambiguous zone (0.2-0.3) handled with flagging
- [x] Theater detected when correlation < 0.4
- [x] reinforcementMultiplier = 0.0 when Theater detected
- [x] Theater events logged to TimescaleDB
- [x] Comprehensive unit tests (43 tests)
- [x] TypeScript compilation clean
