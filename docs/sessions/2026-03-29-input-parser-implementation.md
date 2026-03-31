# 2026-03-29 -- Implemented Input Parser Service (E6-T004)

## Changes
- NEW: `src/communication/input-parser/input-parser.service.ts` -- Full InputParserService implementation with intent classification, entity extraction, WKG resolution, and guardian feedback detection
- NEW: `src/communication/input-parser/__tests__/input-parser.service.spec.ts` -- 20 unit tests covering all 6 intent types, entity extraction, feedback detection, and error fallback paths

## Implementation Details
- Intent classification via LLM structured JSON output (low temperature 0.2 for consistency)
- Entity extraction with WKG node resolution by label matching on properties.name
- Guardian feedback detection via text markers (CORRECTION: "wrong", "incorrect", etc.; CONFIRMATION: "right", "correct", "yes", etc.)
- Fallback to STATEMENT + empty entities on LLM parse failures
- All extracted entities tagged LLM_GENERATED provenance (0.35 base confidence per CANON)
- Anaphora resolution placeholder (returns empty contextReferences for future conversation context integration)

## Wiring Changes
- Injected ILlmService via LLM_SERVICE token for intent/entity LLM calls
- Injected IWkgService via WKG_SERVICE token for entity resolution
- Injected IEventService via EVENTS_SERVICE token (ready for INPUT_PARSED event emission)

## Known Issues
- Anaphora resolution currently unimplemented (placeholder for future integration with conversation thread history)
- Entity resolution uses simple property.name matching; more sophisticated semantic matching may be needed for ambiguous entities
- WKG lookup catch block logs debug message but doesn't fail (graceful degradation to unresolved entities)

## Gotchas for Next Session
- LLM structured JSON parsing is strict; invalid JSON falls back to STATEMENT intent (logged as warn-level)
- ACTRParams.lastRetrievalAt can be null if count === 0 (design per confidence.types.ts)
- NodeLevel type is union literal 'INSTANCE' | 'SCHEMA' | 'META_SCHEMA' (not 'entity')
- findNodeByLabel returns nodes by label, not filtered by confidence threshold (callers must apply threshold if needed)
