# 2026-03-29 -- E7-T008: Temporal Pattern Detection Job

## Changes
- NEW: `/src/learning/jobs/temporal-pattern.job.ts` -- Full implementation of TemporalPatternJob

## Implementation Details
- **Pattern Detection**: Scans recent conversation events (RESPONSE_DELIVERED, INPUT_RECEIVED) to detect when guardian responds to Sylphie within a 3-turn window
- **RESPONSE_TO Edges**: Creates edges in WKG with LLM_GENERATED provenance at 0.35 base confidence
- **Frequency Boost**: Confidence increases by 0.05 per occurrence (capped at 0.60 ceiling), reflecting recurring contingencies
- **Event Querying**: Uses IEventService to query 24 hours of conversation history (max 500 events per run)
- **Node Creation**: Creates Phrase/Utterance nodes for both Sylphie and guardian utterances, preserving original text
- **Error Handling**: Captures contradictions and issues without failing the entire job

## Wiring Changes
- Injects EVENTS_SERVICE (IEventService) and WKG_SERVICE (IWkgService) via NestJS DI
- Returns JobResult with artifact count, issues array, and latency metrics
- Implements ILearningJob interface for integration into learning consolidation cycle

## Known Issues
- Pattern detection currently uses phrase text as node identifiers; production should extract entities and link to them
- No filtering for spam/noise phrases (e.g., repeated single-character utterances)
- Phrase sanitization is basic; may need NLP preprocessing for robustness

## Gotchas for Next Session
- Event type strings (RESPONSE_DELIVERED, INPUT_RECEIVED) must match the EventType union in event.types.ts
- NodeUpsertRequest and EdgeUpsertRequest require explicit provenance (not optional)
- Confidence ceiling (0.60) is enforced at persistence layer; initial values > 0.60 are clamped
- RESPONSE_TO is a custom relationship type; production should define relationship type constants in a schema file
