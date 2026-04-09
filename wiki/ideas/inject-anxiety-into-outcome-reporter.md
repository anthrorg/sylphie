# Idea: Inject Live Anxiety Value into ActionOutcomeReporterService

**Created:** 2026-04-09
**Status:** proposed

## Summary

`ActionOutcomeReporterService.reportOutcome()` hardcodes `anxietyAtExecution: 0`, bypassing CANON §A.15 (Anxiety Amplification). The service should accept the current drive snapshot (or at minimum the anxiety scalar) so outcomes reported through this path can trigger anxiety amplification when anxiety exceeds 0.7.

## Motivation

CANON §A.15 states that if `anxietyAtExecution > 0.7` and the outcome is negative, drive effects should be amplified — the field is explicitly called "load-bearing." Other call sites (`communication.service.ts` lines 557/832, `decision-making.service.ts` line 640) correctly read `driveSnapshot.pressureVector[DriveName.Anxiety]`, but the generic `ActionOutcomeReporterService` always sends 0. This means any outcome routed through the reporter service will never trigger anxiety amplification, silently undermining the contingency system for those code paths.

Additionally, the same file contains two other hardcoded TODOs worth addressing in the same pass:
- `estimatedCostUsd: 0` in `reportMetrics()` — could be computed from token count and a model pricing lookup.
- `windowStartAt` / `windowEndAt` both set to `now` — caller should supply actual window boundaries.

There is also a dead ternary on lines 97-99 where both branches produce the identical expression (`outcome.theaterCheck.driveValue ?? 0`), suggesting an unfinished refactor.

## Subsystems Affected

- **drive-engine** — `ActionOutcomeReporterService` needs a way to receive the current anxiety value (inject `DriveStateAccessor` or accept it as a parameter on `reportOutcome`).
- **shared** — The `IActionOutcomeReporter` interface may need an optional `anxietyAtExecution` field added to the outcome parameter type.
- **decision-making / communication** — Callers that already supply anxiety can remain unchanged; only the reporter's own signature and wiring need updating.

## Open Questions

- Should the reporter service hold a reference to a read-only drive state accessor, or should each caller pass `anxietyAtExecution` explicitly? The accessor approach is cleaner but adds a dependency edge from the reporter back to drive state, which may tension with CANON §Drive Isolation (the service is described as "sole write path" and currently has no read dependency on drive state).
- Is there a risk of stale anxiety values if the reporter reads from a cached snapshot rather than the live child process state?
- Should the dead ternary (lines 97-99) be cleaned up in the same PR, or tracked separately?
