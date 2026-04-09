# Idea: Exponential Backoff for Opportunity Re-Queueing When LLM Is Unavailable

**Created:** 2026-04-09
**Status:** proposed

## Summary

When the planning pipeline encounters an unavailable LLM, it re-enqueues the opportunity immediately with no delay or backoff. This can cause a busy-loop where the same opportunities are dequeued, fail, and re-enqueue every 30-second processing cycle until the LLM comes back, wasting CPU and flooding logs.

## Motivation

The current `PlanningService.executePipeline` re-enqueues an opportunity instantly when the LLM is unreachable (used in the Proposal and Constraint Validation stages). With a 30-second processing interval and up to 10 ingested items per cycle, this creates a tight retry loop that:

- Burns cycles re-processing the same items repeatedly with no chance of success
- Pushes log volume up with identical warnings, making real issues harder to spot
- Prevents the queue from draining naturally via decay, since re-enqueue resets the item's timestamp
- Could starve newly arriving opportunities if the queue is at capacity (MAX_QUEUE_SIZE = 50)

Adding exponential backoff (e.g., doubling a `retryAfter` timestamp on each failed attempt, capped at something like 15 minutes) would let the system gracefully degrade. Opportunities stay in the queue but are skipped until their backoff window expires, giving the LLM time to recover while keeping the pipeline responsive for new, untried items.

## Subsystems Affected

- Planning (opportunity-queue.service.ts, planning.service.ts)

## Open Questions

- Should the backoff be per-opportunity or global (i.e., pause all processing when LLM is detected as down)?
- What maximum backoff cap makes sense given the decay timer (60s) and drop threshold (0.1)?
- Should a health-check ping to the LLM be introduced to short-circuit the backoff when it recovers?
- Does re-enqueueing reset the decay clock? If so, that interaction needs to be addressed alongside this change.
