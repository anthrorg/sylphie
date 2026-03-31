# 2026-03-30 -- Epic 9 T002: WebModule Full DI Wiring

## Changes
- MODIFIED: `src/web/web.module.ts` -- Expanded with DriveEngineModule and CommunicationModule imports. Added VoiceController and ConnectionManagerService wiring. Exports CONNECTION_MANAGER token. Updated documentation.
- NEW: `src/web/web.tokens.ts` -- DI token definitions (CONNECTION_MANAGER) following Symbol pattern.
- NEW: `src/web/controllers/voice.controller.ts` -- VoiceController stub with transcribe/synthesize endpoints (Epic 9 T012).
- NEW: `src/web/services/connection-manager.service.ts` -- ConnectionManagerService implementing IConnectionManagerService. Manages WebSocket client lifecycle per channel with broadcast, unicast, metrics.
- NEW: `src/web/guards/development.guard.ts` -- DevelopmentGuard for development-mode-only endpoints.
- NEW: `src/web/utils/paginator.ts` -- Pagination utilities (PaginationParams, PaginatedResult, paginate(), validatePaginationParams).
- NEW: `src/web/utils/graph-serializer.ts` -- Graph serialization stubs (GraphNodeSerialized, GraphEdgeSerialized, GraphSubgraphSerialized, stub functions).
- NEW: `src/web/utils/index.ts` -- Barrel export for utilities.
- MODIFIED: `src/web/index.ts` -- Added exports for CONNECTION_MANAGER token, IConnectionManagerService, WebConfig, and utilities.

## Wiring Changes
- WebModule now imports DriveEngineModule (DRIVE_STATE_READER for telemetry) and CommunicationModule (LLM_SERVICE for response generation).
- WebModule exports CONNECTION_MANAGER token via provider registration.
- All five subsystem modules are now accessible to WebModule: KnowledgeModule, EventsModule, DatabaseModule, DriveEngineModule, CommunicationModule.
- Controllers: 5 existing + 1 new (VoiceController) = 6 total.
- Gateways: 3 (unchanged).
- Services: 2 existing + 1 new (ConnectionManagerService) = 3 total.

## Known Issues
- VoiceController is a stub (throws Error) — full implementation in Epic 9 T012.
- ConnectionManagerService is a stub — real WebSocket wiring in Epic 9 T011.
- graph-serializer utility functions are stubs — implemented in Epic 9 T005.
- No environment configuration yet for WebConfig in RegisterAs pattern (will be added when config factory is created).

## Gotchas for Next Session
- VoiceController depends on STT_SERVICE and TTS_SERVICE from CommunicationModule (not wired in this task).
- ConnectionManagerService needs real Socket.io or ws library integration for send/broadcast in Epic 9 T011.
- DevelopmentGuard expects webConfig.developmentMode from ConfigService — verify web.config.ts is properly registered in SharedModule.
- WebModule circular dependency risk: DriveEngineModule imports DatabaseModule, which WebModule also imports. NestJS handles this, but worth monitoring.
