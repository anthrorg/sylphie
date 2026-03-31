# 2026-03-30 -- E11-T006: Decision Making event instrumentation

## Changes
- MODIFIED: `src/shared/types/event.types.ts` -- Added TYPE_1_DECISION, TYPE_2_DECISION, ARBITRATION_COMPLETE to EventType union and EVENT_BOUNDARY_MAP. Changed EVENT_BOUNDARY_MAP to use `as const satisfies Record<EventType, SubsystemSource>` so literal value types are preserved for the ExtractSubsystemEventType conditional type to work. Added Type1DecisionEvent, Type2DecisionEvent, ArbitrationCompleteEvent payload interfaces.
- MODIFIED: `src/events/builders/event-builders.ts` -- Fixed buildEvent() to spread opts.data onto the returned event object (was silently discarding all payload data). Exported all subsystem event type aliases (DecisionMakingEventType etc.) so call sites can use them without as-any casts.
- MODIFIED: `src/decision-making/arbitration/arbitration.service.ts` -- Replaced all (createDecisionMakingEvent as any) casts with direct typed calls. Added TYPE_1_DECISION, TYPE_2_DECISION, and ARBITRATION_COMPLETE emission at every arbitration outcome (TYPE_1, TYPE_2, SHRUG including empty-candidate-set SHRUG). Payloads carry actionType, confidence, llmLatencyMs, contextFingerprint, winner, dynamicThreshold.
- MODIFIED: `src/decision-making/prediction/prediction.service.ts` -- Added lastDriveSnapshot field captured during generatePredictions(). Fixed emitPredictionEvaluated() to accept real DriveSnapshot instead of fabricating a fake one. PREDICTION_EVALUATED events now carry full Observatory payload: predictionId, actionType, predictedOutcome, actualOutcome, absoluteError, confidence. Removed (createDecisionMakingEvent as any) cast from PREDICTION_CREATED emission.
- MODIFIED: `src/decision-making/executor/executor-engine.service.ts` -- Removed three (createDecisionMakingEvent as any) casts now that the builder accepts typed event types directly.
- MODIFIED: `src/decision-making/logging/decision-event-logger.service.ts` -- Updated flush() to pass cycleId, state, and payload through opts.data so buildEvent() spreads them onto the persisted record, eliminating the manual spread-then-cast pattern.

## Wiring Changes
- No new module imports or provider registrations required; EventsModule was already imported by DecisionMakingModule.

## Known Issues
- TYPE_2_DECISION.llmLatencyMs is emitted as 0 from the synchronous arbitration path because the LLM is not invoked synchronously here. Real latency measurement requires the executor to time the Type 2 call and update the event after the fact.

## Gotchas for Next Session
- The `as const satisfies` pattern on EVENT_BOUNDARY_MAP is load-bearing for all subsystem event type narrowing — do not add a wide Readonly<Record<>> annotation back on top of it.
- PREDICTION_EVALUATED now skips emission (with a warn log) if lastDriveSnapshot is null, which can happen if evaluatePrediction() is called without a prior generatePredictions() in the same service instance.
