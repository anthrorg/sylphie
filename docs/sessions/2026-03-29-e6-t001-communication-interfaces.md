# 2026-03-29 -- E6-T001: Refined Communication Subsystem Interfaces

## Changes

- MODIFIED: `src/communication/interfaces/communication.interfaces.ts` -- Expanded with 12 new interface/type definitions per ticket E6-T001 requirements
- MODIFIED: `src/communication/index.ts` -- Updated barrel exports to include all new types

## New Types Added

1. **Communication Events** (5 types)
   - `InputReceivedEvent` -- Records raw input arrival (voice vs typed)
   - `InputParsedEvent` -- Records parsed intent and entity extraction results
   - `ResponseGeneratedEvent` -- Records LLM response creation with theater validation result
   - `ResponseDeliveredEvent` -- Records response output delivery (text/audio/both)
   - `SocialCommentInitiatedEvent` -- Records drive-motivated unprompted comments

2. **Response Generation Context** (4 types)
   - `ResponseGenerationContext` -- Complete context for LLM: drive state + WKG + person model + episodes
   - `ConversationMessage` -- Single message in a conversation thread (speaker, content, timestamp)
   - `EpisodeSummary` -- Lightweight episode summary for LLM grounding
   - `ConversationThread` -- Multi-turn conversation record with topics and participants

3. **Type 2 Cost Tracking** (1 type)
   - `LlmCostReport` -- Cognitive effort metrics (latency_ms, token_count, cost_usd) for Drive Engine

4. **Drive Narrative Construction** (2 types)
   - `DriveNarrative` -- Single drive narrative component (drive, pressure, narrative text, threshold status)
   - `MotivationalNarrative` -- Assembled motivational state for LLM system prompt

## Wiring Changes

- Added imports: `EventType` from `src/shared/types/event.types`
- Added imports: `ILlmService` from `src/shared/types/llm.types` (not used in interfaces, imported for reference)
- All new types are exported through `src/communication/index.ts` barrel

## Key Design Decisions

1. **ResponseGenerationContext** includes `driveState: DriveSnapshot` per CANON Theater Prohibition (Standard 1) -- LLM must know actual motivational state
2. **LlmCostReport** uses snake_case field names (`latency_ms`, `token_count`) to match Drive Engine metrics payload convention
3. **EpisodeSummary** separated from shared LLM types -- Communication subsystem needs summaries while Planning/Learning use different episode structures
4. **ConversationThread** enables topic tracking and multi-turn coherence for person-aware response generation
5. All types use readonly properties per immutability requirements
6. All types include comprehensive JSDoc with CANON references

## Known Issues

- None. All types compile without errors or warnings.
- No use of 'any' type across new additions.

## Gotchas for Next Session

- `ResponseGenerationContext` type is referenced but not yet used in ICommunicationService methods -- implementation will wire these together
- `LlmCostReport` fields use snake_case to align with Drive Engine payload conventions (not camelCase like most TypeScript code)
- `EpisodeSummary` in this module is distinct from the homonymous type in `src/shared/types/llm.types.ts` -- both exist for different subsystem contexts
- Theater validation currently uses only the `driveSnapshot` from `GeneratedResponse`; future work may use full `ResponseGenerationContext`
