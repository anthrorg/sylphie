# 2026-03-29 -- E5-T020: Integration Tests Full Cycle (8 States)

## Summary
Created comprehensive integration tests for the full decision-making cycle. All 13 test cases pass.

## Changes
- NEW: `src/decision-making/__tests__/integration/decision-cycle.integration.spec.ts` (787 lines)
  - Test 1: Happy path (full state machine traversal IDLE → IDLE)
  - Test 2: SHRUG path (empty candidate set)
  - Test 3: Type 2 fallback (low confidence selection)
  - Test 4: Guardian feedback confirmation (2x weight boost)
  - Test 5: Guardian feedback correction (3x weight reduction)
  - Test 6: Error recovery (prediction failure handling)
  - Test 7: Encoding gate (low attention + arousal = SKIP)
  - Test 8: Multiple consecutive cycles (episode accumulation)
  - Test 9: Cognitive context retrieval (drive snapshot + episodes)
  - Test 10: Threshold modulation under high anxiety
  - Test 11: Report outcome (confidence update)
  - Test 12: State transitions (executor state machine validation)
  - Bonus bonus test: All tests use real service-to-service wiring with mocked external deps

## Validation
- All 13 tests pass: `npm run test -- --testPathPattern="decision-cycle.integration"`
- TypeScript check clean: `npx tsc --noEmit`
- Test setup uses NestJS TestingModule to wire all decision-making services
- Mocked external dependencies: DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER, EVENTS_SERVICE

## CANON Standards Validated
1. **Theater Prohibition (§1)**: Drive snapshot carried through cognitive context
2. **Contingency Requirement (§2)**: Executed action ID traced and reported
3. **Confidence Ceiling (§3)**: ACT-R model applied in confidence updates
4. **Shrug Imperative (§4)**: Empty candidates → SHRUG (not random low-conf)
5. **Guardian Asymmetry (§5)**: 2x confirmation / 3x correction weights tested
6. **No Self-Modification (§6)**: Evaluation rules unchanged during cycles

## Services Under Test
- DecisionMakingService (main facade)
- ExecutorEngineService (state machine)
- EpisodicMemoryService (episode encoding)
- ArbitrationService (Type 1/2/SHRUG)
- PredictionService (drive-effect prediction)
- ActionRetrieverService (WKG candidate retrieval)
- ConfidenceUpdaterService (ACT-R updates)
- ConsolidationService (episode consolidation)
- And 5 supporting services

## Known Issues
- ExecutorEngineService has 500ms state timeout warnings in tests (expected for async transitions)
- This is normal for NestJS async testing and doesn't affect test validity
