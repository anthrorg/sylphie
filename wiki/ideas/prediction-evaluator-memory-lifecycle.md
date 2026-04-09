# Idea: Add TTL-Based Cleanup to PredictionEvaluator's Global Predictions Map

**Created:** 2026-04-09
**Status:** proposed

## Summary

`PredictionEvaluator` maintains a global `predictions: Map<string, PredictionRecord>` that grows unboundedly over a session's lifetime. While `predictionsByType` is windowed to the last 10 entries per type (via `MAE_WINDOW_SIZE`), the global map is never pruned — every prediction ever recorded stays in memory indefinitely.

## Motivation

In a long-running session with many action cycles, the global `predictions` map accumulates one entry per prediction ID with no eviction. If the drive engine processes hundreds or thousands of outcomes over a multi-hour session, this map grows without bound. Since the map is only used for lookup-by-ID during outcome resolution (to match an outcome back to its original prediction), entries that are older than a reasonable resolution window serve no purpose and waste memory.

A related concern exists in `OpportunityDetector.registry`, which also uses an unbounded `Map<string, Opportunity>`. Decay-based cleanup runs on tick but may not fire fast enough under high-throughput conditions. Together these two maps represent the primary memory leak vectors in the drive engine's long-lived process.

## Subsystems Affected

- **drive-engine** — `PredictionEvaluator` needs a `pruneStale(maxAgeMs: number)` method called periodically (e.g., every N ticks), and `OpportunityDetector` needs a `MAX_REGISTRY_SIZE` cap with LRU or oldest-first eviction.
- **shared** — New constants: `PREDICTION_TTL_MS` (e.g., 300000 for 5 minutes), `MAX_OPPORTUNITY_REGISTRY_SIZE` (e.g., 200).

## Open Questions

- What is a reasonable TTL for unresolved predictions? If an outcome never arrives for a prediction, how long should the engine wait before assuming it's orphaned?
- Should eviction be time-based (TTL) or count-based (max map size), or both?
- Is there telemetry value in tracking how many predictions expire without resolution? A high orphan rate might indicate an upstream bug in outcome reporting.
- Should the cleanup run on a tick multiple (e.g., every 60 ticks) or be triggered by map size crossing a threshold?
