# Idea: Supervisor Verdict Audit Trail via TimescaleDB

**Created:** 2026-04-10
**Status:** proposed

## Summary

Persist all supervisor verdicts (rating, reasoning, intervention, cost) to TimescaleDB so they survive restarts, enable historical analysis of evaluation patterns, and provide an audit trail for how the supervisor shaped Sylphie's learning over time.

## Motivation

Currently the supervisor stores recent verdicts in an in-memory buffer (`recentVerdicts`) that is lost on every restart. There is no persistent record of what the supervisor evaluated, what it rated, or what interventions it issued. This means:

- No way to analyze whether the supervisor's evaluations are improving Sylphie's behavior over time
- No audit trail for debugging why certain corrections or reinforcements happened
- The `pendingInterventions` array grows unbounded in memory and is never consumed or persisted
- Budget spend history is lost, making it impossible to review cost-effectiveness of supervisor evaluations
- When DeepSeek reasoning traces are eventually captured (there's already a TODO for this), there's nowhere to store them persistently

TimescaleDB is the project's event backbone and already records events from all subsystems. Supervisor verdicts are events and belong there. Persisting them would also enable queries like "show me all 'wrong' verdicts from the last week" or "what's the distribution of ratings over time" -- useful for tuning sampling policy and understanding supervisor drift.

## Subsystems Affected

- Supervisor (verdict emission, cost tracking, intervention logging)
- TimescaleDB event schema (new event types for supervisor verdicts and interventions)

## Open Questions

- Should the full DeepSeek reasoning trace be stored in the event payload, or just a summary? Full traces could be large but are valuable for transparency.
- Should verdict persistence be synchronous (blocking the evaluation pipeline) or fire-and-forget like the current intervention dispatch?
- Is there value in a separate "supervisor_verdicts" hypertable with its own retention policy, or should these be standard events in the existing events table?
- How should the pending interventions queue interact with persistence -- persist on push, or batch-flush periodically?
