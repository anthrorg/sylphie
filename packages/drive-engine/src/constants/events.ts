/**
 * Drive Engine event constants.
 *
 * Configuration for event batching, retry logic, and TimescaleDB writes
 * from the Drive Engine child process.
 *
 * CANON §Drive Isolation: The Drive Engine child process emits events
 * to TimescaleDB via a dedicated batching pipeline. Events are queued,
 * batch-written on timeout or size threshold, and retried on failure.
 */

/**
 * Drive Engine-specific event types.
 *
 * These are subtypes of EventType that are emitted by the Drive Engine
 * and handled by the event emission pipeline in this process.
 */
export enum DriveEngineEventType {
  DRIVE_TICK = 'DRIVE_TICK',
  OUTCOME_PROCESSED = 'OUTCOME_PROCESSED',
  OPPORTUNITY_CREATED = 'OPPORTUNITY_CREATED',
  CONTINGENCY_APPLIED = 'CONTINGENCY_APPLIED',
  SELF_EVALUATION_RUN = 'SELF_EVALUATION_RUN',
  RULE_APPLIED = 'RULE_APPLIED',
  HEALTH_STATUS = 'HEALTH_STATUS',
}

// ---------------------------------------------------------------------------
// Batching Configuration
// ---------------------------------------------------------------------------

/**
 * Maximum number of events to accumulate before flushing the batch.
 *
 * When the event queue reaches this size, a batch write is triggered
 * immediately, even if the timeout has not elapsed.
 */
export const BATCH_SIZE = 50;

/**
 * Batch timeout in milliseconds.
 *
 * Events are flushed to TimescaleDB after this interval, even if fewer
 * than BATCH_SIZE events have accumulated. This ensures events are
 * persisted within a bounded time.
 */
export const BATCH_TIMEOUT_MS = 100;

/**
 * Maximum event queue size before dropping oldest events.
 *
 * If the Drive Engine produces events faster than TimescaleDB can ingest
 * them, the queue grows. Once it exceeds this limit, the oldest events are
 * discarded (logged) to prevent unbounded memory growth.
 *
 * At 100Hz ticks (10ms per tick), and with BATCH_SIZE = 50, this queue
 * can hold ~200 ticks worth of events. If TimescaleDB is slower than that,
 * we have bigger problems and should fail over gracefully.
 */
export const MAX_QUEUE_SIZE = 10000;

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

/**
 * Maximum number of retry attempts for a failed TimescaleDB write.
 *
 * If a batch insert fails, it will be retried up to this many times before
 * being logged and discarded. Each retry includes exponential backoff.
 */
export const RETRY_COUNT = 3;

/**
 * Base delay in milliseconds for exponential backoff.
 *
 * Retry delay = RETRY_BASE_DELAY_MS * (2 ^ attempt_number)
 * - Attempt 1: 50ms
 * - Attempt 2: 100ms
 * - Attempt 3: 200ms
 *
 * This keeps latency reasonable while giving TimescaleDB time to recover.
 */
export const RETRY_BASE_DELAY_MS = 50;

// ---------------------------------------------------------------------------
// Sampling Configuration
// ---------------------------------------------------------------------------

/**
 * Sampling rate for DRIVE_TICK events.
 *
 * At 1Hz, every tick is already 1 second. Sample every tick to persist
 * per-second drive state to TimescaleDB.
 */
export const DRIVE_TICK_SAMPLE_INTERVAL = 1;

/**
 * Interval for HEALTH_STATUS events in ticks.
 *
 * Health status is emitted periodically for heartbeat and monitoring.
 * At 1Hz, interval = 60 fires every 60 seconds.
 */
export const HEALTH_STATUS_INTERVAL_TICKS = 60;
