# Batch INSERT for DecisionEventLoggerService.flush()

**Area:** `packages/decision-making/src/logging/decision-event-logger.service.ts`
**Date:** 2026-04-09
**Priority:** Medium
**Type:** Performance

## Problem

`DecisionEventLoggerService.flush()` iterates over buffered events and issues a separate `await this.timescale.query(INSERT ...)` for each one. With the buffer capped at `BATCH_SIZE = 10` and a `FLUSH_INTERVAL_MS = 100ms` timer, this means up to 10 sequential round-trips to TimescaleDB per flush cycle.

```ts
// Current implementation (simplified)
for (const event of events) {
  try {
    await this.timescale.query(`INSERT INTO events (...) VALUES ($1,$2,...)`, [...]);
  } catch (err) {
    this.logger.error(`Failed to record decision event (type: ${event.eventType}): ${err}`);
  }
}
```

Each INSERT pays for a full network round-trip, query parse, and transaction commit. During high-activity decision cycles (e.g. rapid deliberation under drive pressure), flushes can overlap and compete for the database connection.

## Proposed Improvement

Replace the per-event INSERT loop with a single multi-row INSERT statement. PostgreSQL (and TimescaleDB) natively supports `INSERT INTO ... VALUES (...), (...), (...)` syntax, which collapses all events into one round-trip.

```ts
// Proposed implementation (simplified)
const placeholders: string[] = [];
const values: unknown[] = [];
const COLS = 9; // number of columns

for (let i = 0; i < events.length; i++) {
  const offset = i * COLS;
  placeholders.push(
    `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9})`
  );
  values.push(
    event.id, event.eventType, event.timestamp,
    'DECISION_MAKING', event.sessionId,
    JSON.stringify(event.driveSnapshot),
    JSON.stringify(event.payload),
    event.correlationId ?? null, 1
  );
}

await this.timescale.query(
  `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, correlation_id, schema_version)
   VALUES ${placeholders.join(', ')}`,
  values,
);
```

## Error Handling Consideration

The current per-event try/catch means a single bad event doesn't block the rest. The batched version would fail atomically. Two options to preserve partial-failure resilience:

1. **Wrap in a savepoint loop** (complex, probably overkill for logging).
2. **Accept atomic failure** for the batch, and log all event types in the error message so nothing is silently lost. Given these are observability events (not critical state), atomic failure is the pragmatic choice.

## Expected Impact

- **~5-10x fewer DB round-trips** during flush (1 query instead of up to 10).
- Reduced connection contention, especially when `SensoryStreamLoggerService.logFrame()` is also writing concurrently.
- Marginal latency improvement per flush cycle, which matters because `flush()` is also called from `onModuleDestroy` during shutdown.

## Related

- `SensoryStreamLoggerService.logFrame()` already uses fire-and-forget single INSERTs, but that's one row per call and is intentionally non-blocking. A different pattern (not this ticket).
- If `BATCH_SIZE` is ever increased beyond 10, the payoff of batching grows further.
