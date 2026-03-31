# 2026-03-29 -- Entity Extraction Service Implementation (E7-T005)

## Changes
- NEW: `src/learning/extraction/entity-extraction.service.ts` -- Full LLM-backed entity extraction implementation

## Summary
Implemented EntityExtractionService, the Type 2 entity extraction subsystem for the Learning pipeline. The service:

1. **Provenance Handling (CANON §7)**: Maps event source (GUARDIAN/SENSOR/LLM_GENERATED) to base confidence (0.60/0.40/0.35).
2. **LLM Integration**: Calls ILlmService with conservative temperature (0.2) and structured JSON prompt for entity extraction.
3. **Entity Resolution**: Queries WKG via `querySubgraph` to detect EXACT_MATCH, FUZZY_MATCH, AMBIGUOUS, or NEW entities.
4. **Shrug Imperative (CANON Standard 4)**: Flags entities with confidence < 0.45 as AMBIGUOUS rather than guessing.
5. **Cost Tracking**: Emits ENTITY_EXTRACTED events to TimescaleDB per CANON Type 2 Cost Requirement.
6. **Error Handling**: Graceful degradation on LLM/WKG failures; returns empty array on extraction failure.

## Wiring Changes
- Service accepts three injected dependencies: ILlmService, IWkgService, IEventService
- Tokens: LLM_SERVICE (shared), WKG_SERVICE and EVENTS_SERVICE (from their modules)
- Output: ExtractedEntity[] with provenance, resolution type, confidence, sourceEventId

## Known Issues
- Fuzzy matching not yet implemented (WKG similarity query pending)
- Cost event recording doesn't yet track actual token usage (placeholder implementation)

## Gotchas for Next Session
- WKG `querySubgraph` properties filter expects exact name match; fuzzy matching requires additional work
- LLM prompt instructs conservative extraction but LLM may still generate high-confidence low-value entities
- Entity resolution queries with minConfidence: 0.0 to include all nodes for resolution decision-making
