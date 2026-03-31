# 2026-03-29 — E4-T009: Prediction Accuracy Evaluation (MAE, Classification, Graduation)

## Changes

- NEW: `src/drive-engine/constants/prediction-evaluation.ts` — Constants for MAE thresholds, windows, and graduation criteria
- NEW: `src/drive-engine/drive-process/prediction-evaluator.ts` — PredictionEvaluator class; tracks rolling window of 10 predictions per action type; computes MAE; classifies as ACCURATE/MODERATE/POOR
- NEW: `src/drive-engine/drive-process/graduation-criteria.ts` — checkGraduation() and checkDemotion() functions; enforces confidence > 0.80 AND MAE < 0.10 for graduation; MAE > 0.15 for demotion
- NEW: `src/drive-engine/drive-process/opportunity-signal.ts` — generatePredictionOpportunitySignal(); creates opportunity signals when MAE > 0.20; emits IPC messages for MEDIUM/HIGH severity
- MODIFIED: `src/shared/types/ipc.types.ts` — Added optional `predictionData` field to ActionOutcomePayload; carries predictionId, predictedValue, actualValue
- MODIFIED: `src/drive-engine/drive-process/drive-engine.ts` — Integrated PredictionEvaluator; calls recordPrediction() in applyOutcome(); generates and emits opportunity signals; added publishOpportunityCreated() method

## Wiring Changes

- DriveEngine now owns and initializes PredictionEvaluator singleton
- ACTION_OUTCOME messages now carry optional predictionData
- When MAE > 0.20 (POOR predictions), OPPORTUNITY_CREATED is emitted via IPC to Planning subsystem
- Decision Making can now call graduation/demotion functions to evaluate Type 1/Type 2 transitions

## Known Issues

- publishOpportunityCreated() uses empty sourceEventId (placeholder for event emitter to fill)
- recentFailures in opportunity signal is computed as empty array (could be enhanced to track actual recent prediction errors)

## Gotchas for Next Session

- Graduation/demotion functions live in `graduation-criteria.ts` but are not yet called by Decision Making — they are ready for integration in a later ticket
- Predictions must arrive with explicit predictionData in ACTION_OUTCOME; if omitted, no MAE computation occurs (by design)
- MAE window size is hard-coded at 10 predictions; full window required for stable MAE computation
