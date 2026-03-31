# 2026-03-29 -- Epic 6: Communication Subsystem Complete

## Changes
- NEW: src/communication/interfaces/communication.interfaces.ts -- Refined all types (926 lines): ParsedInput, ResponseGenerationContext, DriveNarrative, LlmCostReport, ConversationThread, event types
- NEW: src/communication/communication.module.ts -- Full module with 11 providers, EventsModule/DriveEngineModule imports
- NEW: src/communication/llm/llm.service.ts -- Anthropic SDK client with cost tracking, retry, circuit breaker
- NEW: src/communication/input-parser/input-parser.service.ts -- LLM-mediated 6-intent classification, entity extraction, guardian feedback detection
- NEW: src/communication/response-generator/llm-context-assembler.service.ts -- CANON A.6 context assembly with drive narrative and Theater instruction
- NEW: src/communication/response-generator/response-generator.service.ts -- Full pipeline: context→LLM→Theater validation→retry→deliver
- NEW: src/communication/theater-validator/theater-validator.service.ts -- Keyword-based emotion-drive correlation, 43 unit tests
- NEW: src/communication/person-modeling/person-modeling.service.ts -- Per-person Grafeo isolation, sanitized PersonModel API
- NEW: src/communication/voice/stt.service.ts -- OpenAI Whisper with graceful degradation
- NEW: src/communication/voice/tts.service.ts -- OpenAI TTS with acknowledgment cache
- NEW: src/communication/chatbox/chatbox.gateway.ts -- WebSocket gateway with thread management
- NEW: src/communication/social/social-contingency.service.ts -- 30s window social contingency tracking
- NEW: src/communication/communication.service.ts -- Full facade orchestrating all 9 internal services

## Wiring Changes
- CommunicationModule imports EventsModule, DriveEngineModule, ConfigModule
- DRIVE_STATE_READER and ACTION_OUTCOME_REPORTER injected read-only
- SOCIAL_CONTINGENCY_MET event type added to event vocabulary

## Known Issues
- Voice pipeline untested against real OpenAI API (mocked in tests)
- Chatbox gateway open handle warning in Jest (timer cleanup)

## Gotchas for Next Session
- Epic 7 (Learning) depends on Communication events tagged has_learnable=true
- Epic 8 (Planning) and Epic 9 (Dashboard) are now unblocked
