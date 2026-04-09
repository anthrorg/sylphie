# Idea: Wire HALLUCINATED_KNOWLEDGE and DEPRESSIVE_ATTRACTOR Detectors

**Created:** 2026-04-09
**Status:** proposed

## Summary

Two of the five attractor state detectors in `AttractorMonitorService` (`packages/decision-making/src/monitoring/attractor-monitor.service.ts`) are hardcoded placeholders that always return `triggered: false, metric: 0`. The `HALLUCINATED_KNOWLEDGE` detector needs WKG provenance stats, and the `DEPRESSIVE_ATTRACTOR` detector needs KG(Self) self-evaluation stats. Additionally, the `emitAttractorAlert` method passes `null as never` for the DriveSnapshot parameter.

## Motivation

CANON §Known Attractor States defines five pathological equilibria. Three are actively monitored (TYPE_2_ADDICT, PLANNING_RUNAWAY, PREDICTION_PESSIMIST), but two are blind spots. Without the HALLUCINATED_KNOWLEDGE detector, the system cannot detect when WKG nodes lack trusted provenance (>20% threshold). Without the DEPRESSIVE_ATTRACTOR detector, it cannot detect when >80% of self-evaluations are negative. These are safety-critical monitors that prevent cognitive degradation.

## Subsystems Affected

- **decision-making** — `AttractorMonitorService` needs injection of IWkgService (for provenance stats) and ISelfKgService (for self-evaluation stats). The `emitAttractorAlert` also needs a real DriveSnapshot from IDriveStateReader.
- **shared** — May need `getProvenanceStats()` and `getSelfEvaluationStats()` added to service interfaces if they don't exist yet.

## Open Questions

- Do IWkgService and ISelfKgService interfaces already define the required methods, or do they need to be extended?
- Should the provenance and self-evaluation stats be queried on every `runDetectors()` call, or cached with a TTL?
- The DriveSnapshot null-cast in `emitAttractorAlert` — should IDriveStateReader be injected into this service, or should the snapshot be passed in from the caller?
