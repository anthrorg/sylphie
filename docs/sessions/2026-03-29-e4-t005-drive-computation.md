# 2026-03-29 -- Core drive computation: 12-drive tick loop (E4-T005)

## Summary

Implemented the complete 12-drive computation engine for Sylphie's motivational system. This is the core of Subsystem 4 (Drive Engine) — the isolated child process that runs the tick loop 100Hz and manages all drive state updates.

## Changes

### NEW: Constants and Configuration
- **`src/drive-engine/constants/drives.ts`** -- Drive names, accumulation/decay rates, cross-modulation thresholds, tick configuration

### NEW: Drive State Management
- **`src/drive-engine/drive-process/drive-state.ts`** -- Mutable drive vector with accumulation, decay, outcome application, freezing to immutable PressureVector

### NEW: Accumulation and Decay
- **`src/drive-engine/drive-process/accumulation.ts`** -- Per-drive rates for pressure buildup and relief. Validates rates at startup.

### NEW: Clamping and Boundary Checks
- **`src/drive-engine/drive-process/clamping.ts`** -- Clamps all drives to [-10.0, 1.0], logs out-of-bounds diagnostics for tuning

### NEW: Cross-Modulation
- **`src/drive-engine/drive-process/cross-modulation.ts`** -- 6 inter-drive effects: anxiety suppresses curiosity, satisfaction reduces boredom, anxiety amplifies integrity, low systemHealth amplifies anxiety, boredom increases curiosity, guilt reduces satisfaction

### NEW: Drive Engine (Main Computation)
- **`src/drive-engine/drive-process/drive-engine.ts`** -- Core tick loop (10ms), outcome queue processing, IPC message handling (ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END), DRIVE_SNAPSHOT publishing, health checks

### NEW: Test Suite
- **`src/drive-engine/drive-process/__tests__/drive-engine.spec.ts`** -- 19 comprehensive tests covering state management, accumulation, decay, clamping, cross-modulation, and full tick sequences

## Wiring Changes

**IPC Message Flow:**
- Main NestJS ← Drive Engine child process: DRIVE_SNAPSHOT (every tick), DRIVE_EVENT (on relief), HEALTH_STATUS (health checks)
- Main NestJS → Drive Engine child process: ACTION_OUTCOME (from Decision Making), SOFTWARE_METRICS (from Communication), SESSION_START/END

**Per-Drive Configuration (CANON §A.14):**
```
Accumulation (toward 1.0):
  - systemHealth: +0.003/tick
  - moralValence: +0.002/tick
  - integrity: +0.002/tick
  - cognitiveAwareness: +0.002/tick
  - curiosity: +0.004/tick
  - boredom: +0.005/tick
  - anxiety: +0.001/tick
  - informationIntegrity: +0.001/tick
  - social: +0.003/tick

Decay (toward 0.0):
  - satisfaction: -0.003/tick
  - sadness: -0.002/tick

Event-only:
  - guilt: 0 (changes only via outcomes)
```

## Acceptance Criteria Met

- [x] 12-drive state vector maintained (4 core + 8 complement)
- [x] Tick loop runs at 100Hz (10ms ±2ms drift compensation)
- [x] DRIVE_SNAPSHOT published after each tick via IPC
- [x] All drives clamped to [-10.0, 1.0]
- [x] totalPressure = sum of positive drives (0.0–12.0)
- [x] Outcomes from IPC queue applied each tick
- [x] Tick survives malformed messages (logged, not fatal)
- [x] Memory footprint <10MB per process design
- [x] npx tsc --noEmit passes (no type errors in new files)

## Known Issues

None. All acceptance criteria satisfied.

## Gotchas for Next Session

1. **DriveEngine entry point**: The drive-engine.ts file can be executed directly as a child process. The parent (DriveProcessManagerService) will spawn it via Node.js child_process module and establish IPC.

2. **Rate validation**: validateRates() is called at DriveEngine startup. If accumulation/decay rates violate design assumptions (e.g., both positive and negative on same drive), startup fails. This is intentional — tuning errors should be caught early.

3. **Cross-modulation order**: Effects are applied in a specific sequence. Changing the order may produce different behavioral equilibria. Do not reorder without simulation.

4. **Outcome queue**: The queue is drained entirely each tick, then payloads are processed. If IPC messages arrive faster than ticks complete, the queue grows. Monitor via MAX_OUTCOME_QUEUE_LENGTH.

5. **Theater check**: ACTION_OUTCOME payloads with isTheatrical=true skip ALL reinforcement (zero-reinforcement principle). The Drive Engine does not apply driveEffects when theatrical.

6. **Guardian weighting**: Applied inside applyOutcome(). Confirmation=2x, Correction=3x, Algorithmic=1x. This happens BEFORE clamping and cross-modulation.

7. **Health status**: getHealthStatus() checks tick recency (>1s = unhealthy) and memory footprint (>10MB = unhealthy). The parent DriveProcessManagerService calls this periodically.
