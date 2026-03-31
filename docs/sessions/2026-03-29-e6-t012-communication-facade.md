# 2026-03-29 -- Implement ICommunicationService (E6-T012)

## Changes
- IMPLEMENTED: `src/communication/communication.service.ts` -- Full facade for Communication subsystem (3 methods: handleGuardianInput, generateResponse, initiateComment)
- NEW: `src/communication/__tests__/communication.service.spec.ts` -- Comprehensive unit tests covering all three methods, graceful degradation, event emission, Theater validation, Social contingency tracking

## Wiring Changes
- CommunicationService now orchestrates: InputParserService → PersonModelingService → ResponseGeneratorService → TtsService → ChatboxGateway
- Drive state read on every response generation (IDriveStateReader)
- Type 2 cost reported to Drive Engine (IActionOutcomeReporter)
- Social contingency tracking integrated for guardian response detection (30s window)
- Events emitted to TimescaleDB: INPUT_RECEIVED, INPUT_PARSED, RESPONSE_DELIVERED, SOCIAL_COMMENT_INITIATED

## Known Issues
- EventBuilder type narrowing requires `as any` casts due to TypeScript union type inference limits (not a functional issue)
- DriveName resolution from pressureVector uses string key iteration with type casts (pragmatic workaround)

## Gotchas for Next Session
- Person model update currently uses dummy ParsedInput because handleGuardianInput doesn't generate response (that's Decision Making's job)
- Social contingency checkGuardianResponse called in handleGuardianInput, but tracking only occurs in initiateComment (asymmetric API)
- Theater Prohibition violation returns null from initiateComment (Shrug Imperative Standard 4) — handle caller-side when needed
