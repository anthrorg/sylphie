# Idea: Expose DeepSeek Reasoning Content on LlmResponse Interface

**Created:** 2026-04-13
**Status:** proposed

## Summary

The supervisor evaluation in `packages/supervisor/src/supervisor.service.ts` (line 273) notes that DeepSeek's `reasoning_content` is folded into `response.content` by OllamaLlmService and is not separately available. The `reasoningTrace` field on the verdict is set to `undefined`. The LlmResponse interface should expose `reasoning_content` as a separate field so the supervisor can store the reasoning chain independently from the final verdict.

## Motivation

DeepSeek-reasoner produces a reasoning trace that shows the model's chain-of-thought before arriving at a verdict. This trace is valuable for debugging supervisor decisions, auditing safety evaluations, and understanding why a verdict was issued. Currently it's mixed into the content field (or lost entirely), making it impossible to separate the reasoning from the conclusion. Storing it separately enables a proper audit trail.

## Subsystems Affected

- **shared** — `LlmResponse` interface needs an optional `reasoningContent` field.
- **decision-making** — `OllamaLlmService` (or whatever LLM adapter handles DeepSeek) needs to parse and separate `reasoning_content` from `content` in the API response.
- **supervisor** — Can then populate `reasoningTrace` on the verdict from `response.reasoningContent`.

## Open Questions

- Does the Ollama API for DeepSeek models return `reasoning_content` as a separate field, or is it always merged?
- Should reasoning content count toward token budgets and cost tracking separately?
- Is this useful for other LLM tiers beyond DeepSeek-reasoner?
