# Idea: Simulation Cross-Drive Effect Aggregation

**Created:** 2026-04-09
**Status:** proposed

## Summary

Extend `SimulationService.evaluateCategory` to aggregate historical drive effects across all drives (not just the single `affectedDrive`), and factor multi-drive impact into outcome ranking and viability scoring.

## Motivation

Currently, `evaluateCategory` queries historical `ACTION_OUTCOME_EVALUATED` events and extracts drive effects, but only reads the effect for the single `affectedDrive` from each historical payload. The rest of the `driveEffects` map is discarded. This creates two blind spots:

1. **Collateral harm goes undetected.** An action category might reliably relieve the target drive but consistently spike another drive (e.g., `SocialEngagement` relieves `Affiliation` but raises `CognitiveLoad`). The simulation currently rates that category highly because it only sees the positive signal.

2. **Collateral benefit is invisible.** An action category that provides modest relief on the target drive but also helps two other stressed drives would rank below a narrowly-better single-drive option, even though the system-wide outcome is superior.

The `SimulatedOutcome.estimatedDriveEffect` type already supports `Partial<Record<DriveName, number>>`, and the guardian-teaching fallback already sets two drives. The regular aggregation path just doesn't populate the full map. Filling it in would give downstream consumers (proposal generation, outcome ranking) a richer signal with minimal extra query cost since the data is already in the rows being iterated.

## Subsystems Affected

- **Planning** (SimulationService) -- primary change site; aggregation loop and ranking logic
- **Planning** (interfaces) -- no interface changes needed; `SimulatedOutcome` already supports multi-drive
- **Decision Making** -- indirect beneficiary; proposals built from richer simulation data carry better predicted drive effects into execution

## Open Questions

- Should multi-drive effects influence the viability threshold, or only the ranking order? (e.g., an outcome with a below-threshold primary relief but strong secondary relief -- viable or not?)
- Should cross-drive effects be weighted by current drive intensity (requires reading live drive state from the drive-server IPC), or is historical average sufficient?
- Does the `MIN_RELIEF_THRESHOLD` need to become per-drive or remain a single global constant?
