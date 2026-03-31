# 2026-03-29 -- E6-T002: Replace E0 stub CommunicationModule with real module structure

## Changes

### NEW DIRECTORY STRUCTURE
- Created `src/communication/input-parser/` — InputParserService (moved)
- Created `src/communication/response-generator/` — ResponseGeneratorService + LlmContextAssemblerService (new)
- Created `src/communication/person-modeling/` — PersonModelingService (moved)
- Created `src/communication/theater-validator/` — TheaterValidatorService (moved)
- Created `src/communication/llm/` — LlmServiceImpl (moved)
- Created `src/communication/voice/` — SttService + TtsService (moved)
- Created `src/communication/chatbox/` — ChatboxGateway (new)
- Created `src/communication/social/` — SocialContingencyService (new)

### FILES MODIFIED
- **communication.tokens.ts** — Added new DI tokens: RESPONSE_GENERATOR, LLM_CONTEXT_ASSEMBLER, SOCIAL_CONTINGENCY, CHATBOX_GATEWAY
- **communication.module.ts** — Wired all providers, updated imports to point to new subdirectory paths, added EventsModule import, exported all public tokens
- **index.ts** — Updated barrel exports to include new tokens and re-export LLM_SERVICE from shared
- **All services** — Updated import paths to reflect new directory structure (relative paths now point to ../interfaces, ../../shared, etc.)

### NEW SERVICE FILES (STUB IMPLEMENTATIONS)
- **response-generator/response-generator.service.ts** — Orchestrates LLM response generation pipeline
- **response-generator/llm-context-assembler.service.ts** — Assembles complete context for LLM from multiple sources
- **social/social-contingency.service.ts** — Handles social drive contingencies and spontaneous comments
- **chatbox/chatbox.gateway.ts** — WebSocket gateway for real-time chat

## Wiring Changes

- **Imports:** DriveEngineModule (DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER), EventsModule
- **Providers:** 11 total (1 main facade + 10 supporting services)
- **Exports:** COMMUNICATION_SERVICE, INPUT_PARSER_SERVICE, LLM_SERVICE, plus 4 new tokens
- **Module Boundary:** Clean separation enforced via barrel exports (index.ts)

## Known Issues

- All service implementations are stubs (throw 'Not implemented') — to be filled by T003–T011
- ChatboxGateway uses `any` type for server to avoid ws module typing issues

## Gotchas for Next Session

- Theater validator has comprehensive emotion detection logic (keyword-based) — preserve its complexity
- LLmContextAssemblerService will need to query WKG, person models, episodic memory, and conversation history
- ResponseGeneratorService must report Type 2 cost (latencyMs, tokensUsed) to Drive Engine after LLM call
- All services in subdirectories use relative paths to ../interfaces — do not move interfaces file
