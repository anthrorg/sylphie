# 2026-03-29 -- Response Generator Implementation (E6-T007)

## Changes

- **MODIFIED:** `src/communication/response-generator/response-generator.service.ts`
  - Implemented ResponseGeneratorService with full response generation pipeline
  - Context assembly via LlmContextAssemblerService (T005)
  - LLM invocation with cost tracking (prompt + completion tokens)
  - Theater Prohibition validation on every response
  - Max 1 retry with stricter constraints on validation failure
  - Fallback to neutral response when theater persists
  - RESPONSE_GENERATED event emission with latency and token cost
  - Graceful error handling with event logging

- **NEW:** `src/communication/response-generator/__tests__/response-generator.service.spec.ts`
  - 11 unit tests covering full service behavior
  - Tests for successful generation with theater validation
  - Theater violation retry logic with single regeneration attempt
  - Fallback response generation when theater persists
  - LLM failure handling with graceful degradation
  - Cost accumulation across retries (tokens, latency)
  - Event emission verification with cost metrics
  - Error propagation and recovery scenarios

## Wiring Changes

- LLM_SERVICE injected for LLM API calls
- THEATER_VALIDATOR injected for drive-state correlation checks
- LLM_CONTEXT_ASSEMBLER injected for context assembly
- EVENTS_SERVICE injected for TimescaleDB event recording

## Implementation Details

### Pipeline (Core Method)
1. Assemble LLM context via LlmContextAssemblerService
2. Call LLM with assembled request
3. Validate response against drive state via TheaterValidator
4. If Theater detected:
   - Attempt single retry with stricter constraints
   - Use retry response if validation passes
   - Use neutral fallback if retry also fails
5. Emit RESPONSE_GENERATED event with cost metrics
6. Return GeneratedResponse (text, theaterCheck, tokensUsed, latencyMs)

### Theater Prohibition Handling
- Initial validation: checks if response correlates with drive state
- Retry validation: strengthened system prompt with explicit Theater constraints
- Fallback generation: minimal, emotionally neutral responses by action type
  - RESPOND_TO_QUESTION: "I acknowledge your question..."
  - RESPOND_TO_STATEMENT: "I have received this information..."
  - Default: "I am considering this..."

### Cost Reporting
- Tracks total tokens across all LLM calls (initial + retries)
- Tracks total latency (end-to-end from service entry to exit)
- Emits RESPONSE_GENERATED event with:
  - Theater validation pass/fail
  - Violation count
  - Token usage (prompt + completion)
  - Latency in milliseconds
  - Correlation ID for tracing

## Known Issues

None. Service is complete and fully tested.

## Gotchas for Next Session

- The service method signature includes driveState in ActionIntent, not as separate parameter
- Theater Prohibition instructions are injected in both the initial prompt and retry prompt
- Event emission failures don't block response delivery (graceful degradation)
- Neutral fallback responses are customized per action type to provide context-aware fallbacks
