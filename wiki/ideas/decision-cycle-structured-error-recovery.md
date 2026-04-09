# Idea: Structured Error Recovery and Diagnostic Propagation in the Decision Cycle

**Created:** 2026-04-09
**Status:** proposed

## Summary

The decision-making cycle catches errors at the top-level tick but silently discards diagnostic context, preventing downstream services (Learning, Confidence Updater) from distinguishing transient failures from structural ones and losing opportunities for graceful degradation.

## Motivation

Today, errors in the decision loop are handled asymmetrically across services:

- **`decision-making.service.ts`**: The tick cycle wraps `processInput` in a single try/catch that logs and swallows the error. Dependent services (action handlers, LLM) never learn they should clean up partial state.
- **`arbitration.service.ts`**: If contradiction scanning fails, the result silently downgrades to SHRUG with no record of why — the Learning subsystem can't distinguish "no opinion" from "analysis broke."
- **`action-handlers/registry.ts`**: LLM and WKG query failures return `null`, discarding whether the cause was a network timeout, invalid query, or service unavailability.
- **`ollama-llm.service.ts`**: When the circuit breaker trips, the LLM becomes permanently unavailable for the session with no recovery path or graceful degradation signal.

The net effect is that all errors look the same to downstream consumers: the cycle either succeeds or silently fails. The Learning subsystem loses information about *how* actions failed, the Confidence Updater can't apply appropriate penalties, and transient failures (timeouts) are treated identically to permanent ones (missing WKG nodes).

## Subsystems Affected

- Decision-Making (`decision-making.service.ts`, `executor-engine.service.ts`) — error recovery at the cycle/state level
- Decision-Making (`action-handlers/registry.ts`) — replace null returns with typed error objects
- Decision-Making (`arbitration.service.ts`) — propagate contradiction scanner errors instead of silent downgrade
- Decision-Making (`ollama-llm.service.ts`) — add circuit breaker recovery state and gradual reset
- Decision-Making (`episodic-memory.service.ts`) — add optional `cycleErrorContext` field to Episode
- Learning — consume error context from episodes to refine confidence updates

## Open Questions

- Should transient errors (LLM timeout) trigger automatic retry with backoff, or just be classified and passed to Learning?
- How should Type 1 reflexes act as a fallback when deliberation fails — should the arbitrator explicitly re-enter Type 1 evaluation, or should the executor engine handle this as a state fallback?
- Does the Confidence Updater need new decay/penalty curves for error-tagged episodes, or can it reuse the existing `counter_indicated` path?
- What's the overlap with the dead-letter tracking idea for the Learning pipeline — should error-context episodes flow into the same `failed_learning_events` table?
- Is it worth introducing a `CycleErrorContext` type shared across services, or should each service define its own error shape?
