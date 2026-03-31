# 2026-03-29 -- E2-T002: EventsService skeleton + DI wiring + exception classes

## Changes
- NEW: `src/events/exceptions/events.exceptions.ts` -- EventsException (base), EventValidationError, EventStorageError, EventQueryError, EventNotFoundError
- MODIFIED: `src/events/events.service.ts` -- Replaced stub with real service implementing IEventService + OnModuleInit
- MODIFIED: `src/events/index.ts` -- Added exception exports and TIMESCALEDB_POOL token export
- Module unchanged: `src/events/events.module.ts` already provides and exports TIMESCALEDB_POOL correctly

## Wiring Changes
- EventsService now injects TIMESCALEDB_POOL via @Inject(TIMESCALEDB_POOL)
- EventsService implements OnModuleInit: health check + two critical index creation
- All seven interface methods throw EventValidationError with ticket references (E2-T003 through E2-T008)
- Exception classes inherit from SylphieException with subsystem='events'

## Known Issues
- All business methods are stubs (throw EventValidationError). Real implementation in E2-T003 through E2-T008.
- No method bodies yet; forward references only.

## Gotchas for Next Session
- The critical indexes (idx_has_learnable_processed, idx_subsystem_timestamp) are created by EventsService.onModuleInit(), not TimescaleInitService. They support queryLearnableEvents (E2-T005) and pattern queries (E2-T007).
- EventStorageError wraps original database errors to avoid leaking driver details. Callers should use context field to debug.
- ZERO TOLERANCE: all stub methods throw EventValidationError, not generic Error. This forces proper error handling upstream.
