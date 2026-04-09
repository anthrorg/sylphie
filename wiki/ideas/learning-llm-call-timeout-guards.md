# Idea: Add timeout guards to LLM calls in the learning pipeline

**Created:** 2026-04-09
**Status:** proposed

## Summary

The learning package's LLM-calling services (`refine-edges`, `conversation-reflection`, `cross-session-synthesis`) issue LLM requests with no timeout. If the LLM service hangs or responds slowly, pipeline cycles block indefinitely, causing interval timers to queue up and potentially cascade.

## Motivation

The learning pipeline runs on fixed-interval timers (60 s / 5 m / 30 m). Each cycle checks an `inFlight` boolean to skip if the previous cycle hasn't finished. Without a timeout on LLM calls, a single hung request can permanently stall that cycle type — no new learning, reflection, or synthesis will occur until the process restarts. Adding a per-call timeout (e.g. via `Promise.race` with a deadline, or an `AbortController`-style signal passed through `LlmRequest`) would let cycles fail fast, log the timeout, and recover on the next interval.

## Subsystems Affected

- learning (refine-edges, conversation-reflection, cross-session-synthesis)
- llm-broker (if a shared timeout option is added to `LlmRequest`)

## Open Questions

- Should the timeout be a single global constant, or per-service (reflection prompts are larger and may legitimately take longer)?
- Does the llm-broker already support an `AbortSignal` or `timeout` field on `LlmRequest`, or does that need to be added?
- Should a timed-out cycle retry immediately on the next interval, or back off (e.g. double the interval once)?
- Is there value in emitting a learning event on timeout so the pattern is observable in TimescaleDB?
