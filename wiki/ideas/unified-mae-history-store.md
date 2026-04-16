# Idea: Unified MAE History Store

**Created:** 2026-04-13
**Status:** proposed

## Summary

Consolidate the three independent per-action MAE rolling-window stores (`ConfidenceUpdaterService.maeHistory`, `Type1TrackerService.MutableRecord.maeHistory`, and `PredictionService.maeHistory`) into a single shared service so that graduation, demotion, and confidence decisions always operate on the same MAE data.

## Motivation

Today, `PredictionService`, `ConfidenceUpdaterService`, and `Type1TrackerService` each maintain their own `Map<string, number[]>` of per-procedure MAE observations, all capped at a 10-entry FIFO window. These stores are populated at different points in the decision cycle and can drift apart: `PredictionService` records MAE at evaluation time, `ConfidenceUpdaterService` accepts MAE via `recordPredictionMAE()`, and `Type1TrackerService` receives MAE via `recordObservation()`. If a caller feeds one service but not all three (or feeds them in different order due to an error path), the three windows diverge silently. This means the same procedure could appear graduation-eligible in the tracker while the confidence updater sees different MAE data and makes a different graduation call — a subtle inconsistency that would be very hard to diagnose.

A single `MaeHistoryStore` (or similar) injected into all three services would guarantee a single source of truth: one append, one window, one mean. Each consuming service reads from the shared store rather than maintaining its own copy.

## Subsystems Affected

- Decision Making (`prediction/prediction.service.ts` — currently the MAE producer)
- Decision Making (`confidence/confidence-updater.service.ts` — duplicate consumer store)
- Decision Making (`graduation/type1-tracker.service.ts` — duplicate consumer store)

## Open Questions

- Should the shared store be a standalone injectable service, or a lightweight class owned by the decision-making module?
- Does the store need to emit events when a new observation is appended (so consumers can react), or is polling at decision-time sufficient?
- Should the window size (currently hardcoded as `MAX_MAE_WINDOW = 10` in two places) be configurable per procedure, or remain a global constant?
- Is there any advantage to keeping separate windows (e.g., different window sizes for graduation vs. confidence decay)? If so, a shared store with configurable per-consumer window sizes might be the right abstraction.
