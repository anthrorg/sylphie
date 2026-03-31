# 2026-03-30 -- Testing and Metrics Modules DI Wiring (E10-T002)

## Changes

- NEW: `src/testing/testing.module.ts` -- TestingModule with complete DI wiring (dev/test only)
- NEW: `src/testing/test-environment.service.ts` -- ITestEnvironment stub (E10-T003 deferred)
- NEW: `src/testing/database-fixtures.service.ts` -- DatabaseFixturesService stub (E10-T003 deferred)
- NEW: `src/testing/lesion-modes/lesion-no-llm.service.ts` -- LesionNoLlmService stub (E10-T008 deferred)
- NEW: `src/testing/lesion-modes/lesion-no-wkg.service.ts` -- LesionNoWkgService stub (E10-T008 deferred)
- NEW: `src/testing/lesion-modes/lesion-no-drives.service.ts` -- LesionNoDrivesService stub (E10-T008 deferred)
- NEW: `src/testing/index.ts` -- Barrel export for testing module
- NEW: `src/metrics/metrics.module.ts` -- MetricsModule with complete DI wiring (production-ready)
- NEW: `src/metrics/metrics-computation.service.ts` -- IMetricsComputation stub (E10-T007 deferred)
- NEW: `src/metrics/drift-detection.service.ts` -- IDriftDetection stub (E10-T007 deferred)
- NEW: `src/metrics/attractor-detection.service.ts` -- IAttractorDetection stub (E10-T007 deferred)
- NEW: `src/metrics/index.ts` -- Barrel export for metrics module
- MODIFIED: `src/app.module.ts` -- Added MetricsModule (always) and TestingModule (dev/test only)

## Wiring Changes

- TestingModule: Imports all five subsystems + Events/Knowledge/DriveEngine for test bootstrapping
- TestingModule exports: TEST_ENVIRONMENT token (ITestEnvironment interface)
- MetricsModule: Imports Events, Knowledge, DriveEngine for event log analysis and drive integration
- MetricsModule exports: METRICS_COMPUTATION, DRIFT_DETECTION, ATTRACTOR_DETECTION tokens
- AppModule: MetricsModule always imported; TestingModule conditionally imported when NODE_ENV !== 'production'

## Known Issues

- All service implementations are stubs throwing "Not implemented" errors
- TestEnvironmentService deferred to E10-T003
- DatabaseFixturesService deferred to E10-T003
- LesionMode services (three) deferred to E10-T008
- MetricsComputation, DriftDetection, AttractorDetection deferred to E10-T007

## Gotchas for Next Session

- TestingModule must be imported AFTER all subsystem modules so that their exports are available
- DI tokens (TEST_ENVIRONMENT, METRICS_COMPUTATION, etc.) use Symbol() for collision prevention
- TestingModule conditionally registers via spread operator in AppModule imports array
- All stub implementations reference their deferred tickets (E10-T003, E10-T007, E10-T008)
- TypeScript compilation succeeds; all imports are wired correctly
