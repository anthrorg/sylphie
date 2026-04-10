# Research: Dead-Letter Tracking for Failed Learning Pipeline Events

**Date:** 2026-04-09
**Status:** researched
**Verdict:** yes
**Source:** wiki/ideas/learning-pipeline-dead-letter-tracking.md

## Idea

Add a dead-letter tracking table so that events which fail during the learning pipeline's `processEvent` step are recorded with their error context, rather than being silently marked as learned and lost forever. This would enable failure auditing, retry paths for transient errors, and alerting on failure-rate spikes.

## Key Questions

- How does `LearningService.processEvent()` currently handle failures, and what context is available at the catch site?
- What TimescaleDB schema patterns exist in the codebase, and how would a dead-letter table fit?
- What are industry best practices for dead-letter queues in event processing pipelines?
- Should failed events be retried automatically or only via manual trigger?
- Could failure-rate metrics feed into the Cognitive Awareness drive as pressure?

## Findings

### Prior Art

Dead-letter queue (DLQ) patterns are industry-standard across all major event processing platforms:

- **Kafka**: DLQ implemented via dedicated topics; Confluent and community frameworks provide well-documented patterns. Uber's "reliable reprocessing" architecture demonstrates production-grade DLQ at extreme scale.
- **RabbitMQ**: Native Dead Letter Exchanges (DLX) with automatic redelivery to alternative exchanges upon message rejection or TTL expiration.
- **AWS SQS**: Built-in redrive policy directing messages to separate DLQ after max receive count is exceeded.
- **Apache Beam**: Side Outputs pattern for routing failures; BigQueryIO deadletter pattern for batch processing with failed-element tables.
- **Apache Flink**: Side Output Tags for separating error streams into dedicated topics; checkpoint-based restart for transient errors combined with DLQ routing for non-transient errors.

The SQL/PostgreSQL dead-letter table approach is well-documented. Common lean schemas include: event_id, event_type, payload (JSONB), error_message, error_stacktrace, retry_count, status (PENDING/SUCCEEDED/FAILED/DISCARDED), failed_at, next_retry_at, and step_name. The `FOR UPDATE SKIP LOCKED` query pattern enables safe concurrent retry scheduling.

### Theoretical Grounding

The dead-letter pattern solves a fundamental tension in event-driven systems: **liveness vs. completeness**. The current Sylphie Learning pipeline correctly prioritizes liveness (a single broken event must not stall the entire pipeline), but sacrifices completeness (failed events are permanently lost). A dead-letter table resolves this by decoupling the failure recording from the main processing path — failures are captured without blocking progress, and can be retried or audited later.

This aligns with the broader principle of "make failures visible and recoverable" from enterprise integration patterns (Hohpe & Woolf, 2003). The pattern is especially valuable in knowledge-extraction pipelines where silent data loss directly undermines the system's ability to learn.

### Technical Feasibility

**LearningService.processEvent()** (`packages/learning/src/learning.service.ts`, lines 338-374):
- Wraps all pipeline steps in a try-catch block
- Available context at catch site: `event.id`, `event.session_id`, `event.timestamp`, `event.type`, `event.payload`, `event.schema_version`
- Pipeline steps: UpsertEntities → ExtractEdges → ConversationEntry → CanProduceEdges → RefineEdges → MarkAsLearned
- Each step service independently catches errors, logs them, and returns false/empty — errors do not prevent the event from being marked as learned
- Processing rate: max 5 events per 60s cycle (~7,200/day at capacity)
- Guard: `cycleInFlight` flag prevents concurrent overlap

**TimescaleDB integration** is straightforward:
- `TimescaleService` (`packages/shared/src/storage/timescale.service.ts`) provides pooled `.query<T>()` and `.withTransaction()` methods
- Events table schema (`infra/timescaledb/init/002-events.sql`) uses hypertables with 1-hour chunks, JSONB payloads, and correlation_id support
- `UpdateWkgService` (`packages/learning/src/pipeline/update-wkg.service.ts`, lines 58-84) demonstrates idempotent DDL migration pattern (CREATE TABLE/INDEX IF NOT EXISTS)
- `LearningEventLoggerService` (`packages/learning/src/logging/learning-event-logger.service.ts`, lines 59-82) provides a proven fire-and-forget INSERT pattern

**Existing patterns in codebase:**
- No dedicated dead-letter or retry service exists yet
- OpportunityQueueService implements priority decay and deduplication but not DLQ
- Connection retry pattern in TimescaleService (5 attempts, 3s delays) exists but is ad-hoc
- Fire-and-forget logging pattern is proven and resilient to its own failures

**Cognitive Awareness integration:**
- Drive exists in `packages/drive-engine/src/constants/drives.ts` (accumulation rate: 0.0006/tick)
- LearningService comments already note this drive should eventually trigger learning cycles
- `AttractorMonitorService` demonstrates the detector pattern for querying metrics and emitting alerts
- Integration would require either a new detector or IPC message from Learning to DriveProcessManager

## Assessment

| Dimension    | Rating   |
|-------------|----------|
| Plausibility | high     |
| Complexity   | moderate |
| Fit          | strong   |
| Risk         | low      |

## Verdict

This is a well-understood, industry-standard pattern with strong prior art and clean integration points in the Sylphie codebase. The Learning pipeline already has all the infrastructure needed (TimescaleDB, fire-and-forget logging, idempotent migrations) — the dead-letter table fills a genuine blind spot where failed events are silently lost. The main effort is in instrumenting each pipeline step's catch block and creating the new table, which is moderate but well-scoped. Recommend proceeding.

## Implementation Path

1. **Create `dead_letter_events` table** in `infra/timescaledb/init/` following the existing hypertable pattern:
   ```sql
   CREATE TABLE IF NOT EXISTS dead_letter_events (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     original_event_id UUID NOT NULL,
     session_id TEXT NOT NULL,
     event_type TEXT NOT NULL,
     failure_step TEXT NOT NULL,
     error_message TEXT NOT NULL,
     error_stack TEXT,
     payload JSONB,
     retry_count INTEGER DEFAULT 0,
     status TEXT DEFAULT 'PENDING',
     next_retry_at TIMESTAMPTZ,
     resolved_at TIMESTAMPTZ
   );
   CREATE INDEX IF NOT EXISTS idx_dle_status_timestamp ON dead_letter_events (status, timestamp DESC);
   CREATE INDEX IF NOT EXISTS idx_dle_session_step ON dead_letter_events (session_id, failure_step, timestamp DESC);
   ```

2. **Add idempotent migration** in `UpdateWkgService` (or new `DeadLetterMigrationService`) following the pattern at lines 58-84.

3. **Create `DeadLetterService`** (parallel to `LearningEventLoggerService`):
   - Single method: `recordFailure(eventId, sessionId, eventType, failureStep, error, payload)`
   - Fire-and-forget INSERT; catch and log its own errors to prevent cascading failures
   - Optional: `retryFailed(maxRetries: number)` method for batch retry of PENDING events

4. **Instrument pipeline step catch blocks** in each service:
   - `UpsertEntitiesService`, `ExtractEdgesService`, `ConversationEntryService`, `CanProduceEdgesService`, `RefineEdgesService`
   - At each catch site, call `deadLetterService.recordFailure()` before returning false/empty

5. **Add retry mechanism** (Phase 2):
   - Automatic exponential backoff: 30s → 60s → 120s → ... capped at 15 minutes
   - Max 5 retries; after which status changes to FAILED (requires manual review)
   - Classify errors: retryable (Neo4j timeout, LLM hiccup) vs non-retryable (schema mismatch, validation)
   - Poison message detection: if same event fails 3+ times with identical error, mark as non-retryable

6. **Add observability** (Phase 2):
   - Query dead_letter_events for failure rate per step, per session
   - Emit `LEARNING_FAILURE_RATE` event to TimescaleDB for dashboard consumption
   - Alert threshold: if >10% of events in a cycle fail, log warning

7. **Integrate with Cognitive Awareness drive** (Phase 3):
   - Add detector in `AttractorMonitorService` that queries failure rate
   - If sustained failure rate >20%, increase Cognitive Awareness pressure
   - This creates a feedback loop: high failure rate → increased awareness → more frequent learning cycles → faster retry

### Key Design Decisions

- **Separate table vs column on events**: Separate table. Dead-letter records have different lifecycle (retry, resolve) and different query patterns than normal events.
- **Automatic vs manual retry**: Both. Automatic for transient errors (with exponential backoff and max retries), manual trigger for poison messages after fix verification.
- **Retention policy**: 30 days for PENDING/FAILED, 7 days for resolved. TimescaleDB compression policies apply naturally.
- **Per-step vs per-event tracking**: Per-step. A single event can fail at multiple steps; tracking per-step gives finer-grained debugging.

### Risks to Mitigate

- **Replay safety**: Retry must be idempotent — deduplicate by event_id to avoid double-processing if a retry succeeds but the status update fails
- **Storage bloat**: Set retention policy (30 days) and leverage TimescaleDB compression; archive to cold storage if needed
- **Poison messages**: Detect early (3+ identical failures), route to DISCARDED status, never auto-retry indefinitely
- **No existing tests for error paths**: Dead-letter addition should include test coverage for failure capture

## Sources

- [Confluent: Apache Kafka Dead Letter Queue Guide](https://www.confluent.io/learn/kafka-dead-letter-queue/)
- [IBM Garage Event-Driven Reference Architecture - DLQ Pattern](https://ibm-cloud-architecture.github.io/refarch-eda/patterns/dlq/)
- [RabbitMQ Dead Letter Exchanges](https://www.rabbitmq.com/docs/dlx)
- [AWS SQS Dead Letter Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Apache Beam Dead Letter Pattern with BigQueryIO](https://beam.apache.org/documentation/patterns/bigqueryio/)
- [PostgreSQL as Dead Letter Queue for Event-Driven Systems](https://www.diljitpr.net/blog-post-postgresql-dlq)
- [Uber: Reliable Reprocessing with Apache Kafka](https://www.uber.com/us/en/blog/reliable-reprocessing/)
- [Enterprise Integration Patterns: Dead Letter Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html)
- Sylphie codebase: `packages/learning/src/learning.service.ts`, `packages/learning/src/logging/learning-event-logger.service.ts`, `packages/learning/src/pipeline/update-wkg.service.ts`, `infra/timescaledb/init/002-events.sql`, `packages/decision-making/src/monitoring/attractor-monitor.service.ts`
