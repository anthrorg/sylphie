# 2026-03-30 -- Epic 9: Dashboard API and WebSocket Gateways

## Changes
- NEW: src/web/dtos/ (8 files) -- DTO types for all endpoints (health, drive, graph, conversation, metrics, voice, person-model)
- NEW: src/web/interfaces/ (3 files) -- IConnectionManagerService, WebConfig, WebSocket frame types, DI tokens
- NEW: src/web/exceptions/web.exceptions.ts -- WebException, GraphQueryTimeoutError, InvalidSessionError, WebSocketConnectionError
- NEW: src/web/filters/ (2 files) -- HTTP and WebSocket exception filters with dev/prod mode
- NEW: src/web/guards/development.guard.ts -- Feature gate for debug-only endpoints
- NEW: src/web/utils/ (2 files) -- Pagination helper, graph serializer
- NEW: src/web/web.config.ts -- 15 env vars mapped via registerAs('web')
- MODIFIED: src/web/web.module.ts -- Full DI wiring: DriveEngineModule, CommunicationModule, 6 controllers, 3 gateways
- MODIFIED: src/web/controllers/ (6 files) -- Implemented Health, Drives, Graph, Conversation, Metrics, Voice
- MODIFIED: src/web/gateways/ (3 files) -- Implemented Telemetry, GraphUpdates, Conversation
- MODIFIED: src/web/services/connection-manager.service.ts -- Full channel-based WS lifecycle with heartbeat
- MODIFIED: src/shared/types/event.types.ts -- Added 9 WEB event types + 'WEB' subsystem
- MODIFIED: src/events/builders/event-builders.ts -- Added createWebEvent builder
- MODIFIED: .env.example -- Added 15 WEB_* env vars

## Wiring Changes
- WebModule now imports DriveEngineModule and CommunicationModule (in addition to existing)
- 9 new event types flow through TimescaleDB with subsystem='WEB'
- ConnectionManagerService tracks WS clients across telemetry/graph/conversation channels

## Known Issues
- E10 integration: full end-to-end with React frontend and real databases not yet verified
- WebSocket gateways use polling for graph events (future: native event subscription)

## Gotchas for Next Session
- Graph subgraph timeout uses Promise.race with reject — ensure cleanup of the losing promise
- Telemetry gateway buffers at 500ms; adjust WEB_TELEMETRY_BATCH_INTERVAL_MS for testing
