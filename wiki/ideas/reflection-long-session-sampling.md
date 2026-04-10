# Idea: Windowed Sampling for Long Session Reflection

**Created:** 2026-04-10
**Status:** proposed

## Summary

The conversation reflection service truncates long sessions at 8000 characters, meaning insights are only extracted from the beginning of a conversation. Replace this hard truncation with a windowed or stratified sampling strategy so that reflection can surface insights from the entire conversation arc.

## Motivation

In `conversation-reflection.service.ts`, the `buildReflectionPrompt` function iterates events chronologically and stops once `MAX_CONVERSATION_CHARS` (8000) is exhausted. For long sessions (e.g., a 30-minute multi-topic discussion), the LLM only ever sees the first few minutes of events. This creates a systematic blind spot: TONAL_SHIFT and DELAYED_REALIZATION insights — which by definition depend on comparing early and late parts of a conversation — are nearly impossible to detect when the tail of the conversation is never sent to the LLM.

A sampling strategy (e.g., first N chars + last N chars + sampled middle, or a two-pass approach where a cheap summarization pass compresses the full timeline before the reflection pass) would let the reflection system reason about the complete narrative arc without exceeding token budgets.

## Subsystems Affected

- Learning (conversation reflection pipeline)
- Shared (LLM service — may need a two-call pattern or streaming support for the summarization pre-pass)

## Open Questions

- What sampling strategy best preserves narrative arc? (head+tail, uniform sampling, density-based sampling around topic shifts?)
- Should the summarization pre-pass use a cheaper LLM tier (e.g., `fast` instead of `medium`)?
- Is 8000 chars the right budget, or should it scale with the session's event count?
- Would a multi-window approach (reflect on windows independently, then merge insights) produce better results than a single summarized pass?
