# 2026-03-29 -- E2-T006: queryEventFrequency() Implementation

## Changes
- MODIFIED: `src/events/events.service.ts` -- Replaced placeholder with full queryEventFrequency() implementation

## Implementation Details
- Validates eventTypes array; returns empty array if empty (no query needed)
- Calculates window start: now - windowMs (milliseconds)
- Parameterized COUNT(*) query with event_type = ANY($1) filter and timestamp >= $2
- Maps results to Map<EventType, number> for O(1) lookups
- Fills zero counts for event types in request but not in query results
- Returns EventFrequencyResult[] with one entry per requested type (complete signal vector)
- Performance-tuned: simple, index-backed aggregation suitable for high-frequency Drive Engine ticks (<5ms p99)

## Error Handling
- Catches connection timeouts/ECONNREFUSED separately with specific logging
- Generic query errors wrapped in EventQueryError with context
- Unknown error types logged and wrapped
- All errors logged with eventTypeCount and windowMs for debugging
- Client properly released in finally block

## Wiring Changes
- No new wiring; method replaces existing stub in IEventService contract

## Known Issues
- None; implementation complete and type-checked

## Gotchas for Next Session
- WindowStartTime is calculated as now - windowMs; ensure callers understand this is wall-clock time, not event creation time
- Zero counts are explicitly included in results (no sparse vectors); Drive Engine receives complete signal even for quiet event types
- EventType array ordering is preserved in results (matches input order)
