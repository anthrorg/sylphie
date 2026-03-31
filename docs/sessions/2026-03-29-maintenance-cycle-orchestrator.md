# 2026-03-29 -- Maintenance Cycle Orchestrator (E7-T003)

## Changes
- NEW: MaintenanceCycleService (src/learning/consolidation/maintenance-cycle.service.ts) -- Full implementation of cycle orchestration with rate limiting, concurrency prevention, adaptive batch sizing, and comprehensive metrics tracking.

## Wiring Changes
- Injected dependencies: CONSOLIDATION_SERVICE, LEARNING_JOB_REGISTRY, EVENTS_SERVICE, DRIVE_STATE_READER, PROVENANCE_HEALTH_SERVICE
- Implements IMaintenanceCycleService and OnModuleDestroy for lifecycle management
- Emits CONSOLIDATION_CYCLE_STARTED and CONSOLIDATION_CYCLE_COMPLETED events to TimescaleDB

## Implementation Details
- Rate limit: 30s minimum between cycles (CANON constraint)
- Timeout: 60s per cycle (hard ceiling)
- Batch sizing: 5 events normal, 3 when contradictions >= 2 (adaptive)
- State machine: prevents concurrent execution, tracks lastCycleTime
- Periodic fallback: 5-minute timer triggers when Cognitive Awareness > 0.6
- Provenance health tracking after each cycle
- Learning jobs execution via JobRegistryService
- Comprehensive metrics: events processed, entities extracted, edges refined, contradictions found, jobs executed/failed

## Known Issues
- SessionId hardcoded as 'session-id' (TODO: obtain from context)
- ProvenanceHealthService and JobRegistryService are stubs (will throw 'Not implemented' at runtime)
- EventsService and ConsolidationService are stubs with similar limitation

## Gotchas for Next Session
- The service initializes a 5-minute timer in the constructor; ensure onModuleDestroy is called
- Rate limiting is strict -- rapid consecutive calls will fail with "Rate limit" error
- Adaptive batch sizing depends on lastContradictionCount from previous cycle (starts at 0)
- Promise.race timeout may complete before the timeout fires if consolidation is very slow
