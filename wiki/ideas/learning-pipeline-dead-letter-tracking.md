# Idea: Dead-Letter Tracking for Failed Learning Pipeline Events

**Created:** 2026-04-09
**Status:** proposed

## Summary

Add a dead-letter tracking table so that events which fail during the learning pipeline's `processEvent` step are recorded with their error context, rather than being silently marked as learned and lost forever.

## Motivation

Currently in `LearningService.processEvent()`, when any pipeline step throws (entity upsert, edge extraction, conversation entry, etc.), the catch block logs an error to stdout and then marks the event as learned anyway to prevent a single broken event from stalling the entire pipeline. This is the right call for liveness, but it means failed events vanish without a trace — there's no queryable record of what failed, why it failed, or how often failures occur.

This creates several blind spots:

- **Silent data loss**: Events that fail are permanently skipped. Knowledge that should have been extracted never makes it into the WKG.
- **No failure auditing**: There's no way to answer "how many events have we lost this week?" or "which subsystem's events fail most often?"
- **No retry path**: Transient failures (Neo4j timeout, LLM hiccup) can't be retried because the event is already marked learned.
- **No alerting**: If failure rates spike (e.g., a schema change breaks entity extraction), there's no signal beyond log noise.

A `failed_learning_events` table in TimescaleDB would capture the event ID, the pipeline step that failed, the error message, and a retry count. A separate recovery pass (or manual trigger) could re-attempt failed events periodically, and a simple query could surface failure trends for monitoring.

## Subsystems Affected

- Learning (LearningService, processEvent error handling)
- Shared (TimescaleService — new table DDL)
- Potentially Drive Engine (if failure-rate metrics feed into Cognitive Awareness pressure)

## Open Questions

- Should failed events be retried automatically on a backoff schedule, or only via manual trigger?
- What's the right retention policy for the dead-letter table? Keep forever, or prune after N days?
- Should there be a max retry count after which the event is permanently abandoned (and flagged for human review)?
- Could failure-rate spikes feed into the Cognitive Awareness drive as a pressure signal ("I'm failing to learn")?
