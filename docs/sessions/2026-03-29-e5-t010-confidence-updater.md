# 2026-03-29 -- E5-T010: Confidence Updater ACT-R 3-Path Logic

## Changes
- NEW: `src/decision-making/confidence/confidence-updater.service.ts` -- Full implementation of IConfidenceUpdaterService with three update paths (reinforced, decayed, counter_indicated) and Type 1 graduation/demotion logic.

## Implementation Details
- **Reinforced path**: Increments count, updates lastRetrievalAt timestamp
- **Decayed path**: No-op on record; decay is computed naturally via ACT-R formula using lastRetrievalAt
- **Counter-indicated path**: Reduces base confidence by 0.15 (proportional to prediction error)
- **Guardian asymmetry**: Applies 2x/3x multiplier (CANON Standard 5) via applyGuardianWeight()
- **Type 1 graduation**: When confidence > 0.80 AND MAE < 0.10 over last 10 uses
- **Type 1 demotion**: When MAE > 0.15 for already-graduated behaviors
- **In-memory store**: Maps actionId → ActionConfidenceRecord (ACT-R params + Type 1 state + MAE history)

## Wiring Changes
- Service properly injects EVENTS_SERVICE and emits TYPE_1_GRADUATION/TYPE_1_DEMOTION events to TimescaleDB
- Uses createEmptyDriveSnapshot() stub for event context (placeholder until full decision cycle integration)
- No changes to interfaces; pure implementation of existing contract

## Known Issues
- Events emitted with stub DriveSnapshot (sessionId='unknown', all drives=0). Real implementation needs caller to pass actual DriveSnapshot.
- In-memory store is not persisted; actions reset on service restart (acceptable for MVP; WKG persistence would replace this)
- MAE history (recentMAEs) not yet populated by caller; would come from PredictionEvaluation events

## Gotchas for Next Session
- The Extract type narrowing in event builders has TypeScript issues; existing pattern uses `as any` cast
- INITIAL_DRIVE_STATE imported but unused; can be removed if desired
- Counter-indicated reduction is fixed (0.15); could be made proportional to error magnitude
