# Idea: Priority-Based Eviction When Opportunity Queue Hits Hard Cap

**Created:** 2026-04-09
**Status:** proposed

## Summary

When the opportunity queue reaches its hard cap (MAX_QUEUE_SIZE = 50), instead of unconditionally rejecting new opportunities, compare the incoming item's priority against the lowest-priority item in the queue and evict it if the newcomer ranks higher.

## Motivation

Currently in `OpportunityQueueService.enqueue()`, a full queue means any new opportunity is dropped regardless of its priority. This creates a scenario where a HIGH or GUARDIAN_TEACHING opportunity could be rejected while stale, nearly-decayed LOW-priority items occupy queue slots. Since the queue is already sorted by `currentPriority` descending, the lowest-priority item is always at `this.queue[this.queue.length - 1]`, making the comparison and eviction trivially cheap. This would make the system more responsive to important opportunities under load and prevent priority inversion at the queue boundary.

## Subsystems Affected

- **Planning** — `OpportunityQueueService` (the queue itself)
- **Logging** — new vlog/debug entry for eviction events to maintain traceability

## Open Questions

- Should eviction be limited to items below a certain priority threshold (e.g., only evict items already below 0.2), or should any lower-priority item be fair game?
- Should evicted items emit a distinct event (e.g., `OPPORTUNITY_EVICTED`) so downstream analytics can track displacement pressure on the queue?
- Does GUARDIAN_TEACHING classification warrant bypassing the hard cap entirely rather than evicting, given its special status?
