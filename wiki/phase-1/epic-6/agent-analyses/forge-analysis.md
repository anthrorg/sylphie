# Forge Analysis — Epic 6: Communication

**Agent:** Forge (NestJS/TypeScript Systems Architect)
**Model:** sonnet
**Date:** 2026-03-29

## Summary

CommunicationModule architecture is straightforward NestJS with well-defined boundaries. 8 internal services, 2 public exports (COMMUNICATION_SERVICE, LLM_SERVICE). Standard DI patterns with read-only drive state access.

## Key Architectural Decisions

1. **Module Exports**: Only COMMUNICATION_SERVICE and LLM_SERVICE are public. All internal services (parser, theater validator, person modeling, voice, social tracking) are private to the module.

2. **Drive Engine Access**: IDriveStateReader injected via DRIVE_STATE_READER token. Read-only. No write path exists from Communication to Drive Engine evaluation function.

3. **Configuration**: New config entries for OpenAI (STT/TTS), Anthropic (LLM), theater validation settings, person modeling settings. All validated on startup with class-validator.

4. **Error Hierarchy**: CommunicationException base → STTDegradationError, TTSDegradationError, TheaterViolationError, PersonModelIsolationError, LlmUnavailableError.

5. **Async Patterns**: Sentence-level TTS streaming via Observable<Buffer>. WebSocket gateway with HTTP fallback. Health checks for voice services.

## Anti-Patterns to Prevent

1. LLM deciding actions (should only translate intent to words)
2. Person model data leaking into WKG
3. Provenance laundering (LLM_GENERATED stripped during persistence)
4. Unmetered LLM calls (no cost event = violation)
5. God service (CommunicationService facade delegates, does not implement)
6. Direct instantiation bypassing DI
7. Synchronous voice blocking (always use async with degradation)

## Module Structure

```
src/communication/
├── communication.module.ts       # Module with imports/exports
├── communication.service.ts      # Public facade
├── input-parser/
│   └── input-parser.service.ts
├── response-generator/
│   ├── response-generator.service.ts
│   └── llm-context-assembler.service.ts
├── person-modeling/
│   └── person-modeling.service.ts
├── theater-validator/
│   └── theater-validator.service.ts
├── llm/
│   └── llm.service.ts
├── voice/
│   ├── stt.service.ts
│   └── tts.service.ts
├── chatbox/
│   └── chatbox.gateway.ts
├── social/
│   └── social-contingency.service.ts
├── interfaces/
│   └── communication.interfaces.ts
└── index.ts
```
