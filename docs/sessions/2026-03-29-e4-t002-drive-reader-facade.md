# 2026-03-29 — E4-T002: DriveReaderService Read-Only Facade, Observable, Defensive Copies

## Changes

- NEW: `src/drive-engine/drive-reader/drive-state-snapshot.ts` — Snapshot coherence validation utility
  - validateDriveSnapshotCoherence(): validates incoming snapshots for drive value bounds, crash detection, hang detection, and total pressure consistency
  - defensiveCopySnapshot(): returns JSON deep copy to prevent external mutation

- NEW: `src/shared/exceptions/specific.exceptions.ts` — Added DriveCoherenceError class
  - Thrown on snapshot validation failure (bounds, consistency, staleness)
  - Extends DriveException with code 'DRIVE_COHERENCE_ERROR'

- MODIFIED: `src/drive-engine/drive-reader.service.ts` — Completed IDriveStateReader implementation
  - getCurrentState(): returns defensive JSON copy (JSON.parse/stringify)
  - driveState$: Observable emits on each snapshot update via BehaviorSubject
  - getTotalPressure(): delegates to current snapshot's totalPressure field
  - isDriveHealthy(): checks if last snapshot is recent (within 2s)
  - updateSnapshot(): validates coherence before caching, throws DriveCoherenceError on failure
  - Tracks lastValidSnapshotTimestamp for staleness detection
  - Multiple subscribers receive same snapshot via Observable (no reference sharing)

## Wiring Changes

- DriveReaderService injection token DRIVE_STATE_READER continues to provide IDriveStateReader
- DriveProcessManagerService will call updateSnapshot() when DRIVE_SNAPSHOT messages arrive
- Coherence validation catches child crashes (all-zero), hangs (stale >1s), and bounds violations

## Known Issues

- None. All acceptance criteria met.

## Gotchas for Next Session

- The defensive copy uses JSON.parse/stringify — works for Date serialization (ISO format) but ensure callers don't rely on Date reference identity
- isDriveHealthy() check uses 2s threshold (twice target tick interval) to allow for IPC latency
- Staleness check only compares with lastValidSnapshotTimestamp, not wall-clock time, to detect trends
