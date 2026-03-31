# 2026-03-29 -- E2-T005: queryLearnableEvents() with FIFO ordering and concurrent access safety

## Changes

- MODIFIED: `src/events/events.service.ts` -- Implemented `queryLearnableEvents(limit?: number)` with full production implementation

## Implementation Details

Replaced stub that threw `EventValidationError` with complete implementation:

1. **Filtering**: `WHERE has_learnable = true AND processed = false`
2. **Ordering**: `ORDER BY timestamp ASC` for FIFO consolidation (oldest first)
3. **Limit normalization**: default 5 (CANON §Subsystem 3), hardcoded max 50, returns [] if limit < 1
4. **Concurrency control**: `SELECT FOR UPDATE SKIP LOCKED` prevents multiple Learning cycles from claiming same events
5. **Row mapping**: Reconstructs LearnableEvent from database columns + event_data JSONB:
   - Base SylphieEvent fields: id, type, timestamp, subsystem, sessionId, driveSnapshot, schemaVersion, correlationId, provenance
   - LearnableEvent fields: hasLearnable (literal true), content, guardianFeedbackType, source, salience
6. **Error handling**: Proper rollback on connection timeout or query error; throws EventQueryError
7. **Logging**: Debug log on successful query; error logs with context on failure

## Wiring Changes

- No new connections between components
- EventsService.queryLearnableEvents() now implements the IEventService contract
- Ready for Learning subsystem to call during consolidation cycles

## Known Issues

- None. Type-check passes: `npx tsc --noEmit` returns clean (no errors)

## Gotchas for Next Session

- Lock semantics: Locks release on COMMIT, but markProcessed() (E2-T008) must be called separately to set processed=true
- In single-process NestJS, Learning cycles are sequential async; SKIP LOCKED provides safety if concurrency is ever added
- Field defaults: content='', guardianFeedbackType='none', source='LLM_GENERATED', salience=0.5
- Empty result is valid; returns [] not error
