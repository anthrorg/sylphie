# Epic 9: Cross-Agent Discussion Decisions

**Date:** 2026-03-29
**Participants:** Forge, Sentinel, Vox, Canon

---

## Decision 1: WebModule is NOT a 6th Subsystem

**Consensus:** Unanimous. WebModule is a surface transport layer. All intelligence remains in the five core subsystems. WebModule reads from subsystem interfaces; it never contains business logic.

**Canon verdict:** COMPLIANT — preserves five-subsystem architecture.

---

## Decision 2: Chat Input Routing

**Forge/Vox alignment:** Chat input flows through ConversationGateway → CommunicationService.handleGuardianInput() → Decision Making. Never bypasses Communication.

**Canon enforcement:** Direct action selection endpoints (`POST /api/decision/action`) and direct graph writes (`POST /api/graph/upsert`) are PROHIBITED.

---

## Decision 3: Drive Override Endpoints REMOVED

**Canon flagged:** v1 had `postDriveOverride`, `postDriveDrift`, `postDriveReset` endpoints. These violate Drive Engine isolation (CANON §Drive Isolation, Immutable Standard 6).

**Decision:** No drive write endpoints in v2. Drive state is exposed via read-only IDriveStateReader only.

---

## Decision 4: WebSocket Architecture

**Forge proposed:** Three separate NestJS @WebSocketGateway decorators with ws adapter (not Socket.io).

**Vox proposed:** Conversation-specific WebSocket paths with session validation.

**Resolution:** Use NestJS @WebSocketGateway with `ws` adapter (lighter weight than Socket.io for our use case). Three gateways:
1. `/ws/telemetry` — drive ticks, predictions, action selections (high frequency)
2. `/ws/graph` — WKG change notifications (low frequency)
3. `/ws/conversation` — chat bidirectional (medium frequency)

ConnectionManagerService manages client lifecycle across all gateways.

---

## Decision 5: Health Check Strategy

**Sentinel proposed:** Parallel checks for all 5 databases with 150ms individual timeouts, 500ms overall.

**Forge confirmed:** Health check runs through subsystem health interfaces, not direct DB access.

**Resolution:** HealthController calls health check methods on injected services (IWkgService, IEventService, etc.). Each service owns its own health check logic. HealthController aggregates results.

---

## Decision 6: Voice Endpoints

**Vox proposed:** Voice endpoints (transcribe/synthesize) live in E9 as HTTP surface, but logic stays in E6 (Communication).

**Resolution:** Include voice HTTP endpoints in E9 scope. They delegate to ISttService.transcribe() and ITtsService.synthesize() from CommunicationModule. This is consistent with the gateway pattern.

---

## Decision 7: Development Metrics

**Canon validated:** The 7 Primary Health Metrics from CANON (§Development Metrics) can all be computed from existing subsystem data:

1. Type 1/Type 2 ratio — query EventsModule for action selection events
2. Prediction MAE — query EventsModule for prediction evaluation events
3. Experiential provenance ratio — query KnowledgeModule for provenance counts
4. Behavioral diversity index — query EventsModule for action type frequency
5. Guardian response rate — query EventsModule for social drive contingency events
6. Interoceptive accuracy — query KnowledgeModule (Self KG) vs Drive Engine state
7. Mean drive resolution time — query EventsModule for drive state transitions

---

## Decision 8: Person Model API

**Vox proposed:** Read-only person model summaries for debugging.

**Canon concern:** Other KG isolation must be maintained.

**Resolution:** Include a read-only person model endpoint that returns PersonModelService.getPersonModel() summaries. No raw Grafeo graph data exposed. Guarded by development mode flag.

---

## Decision 9: Graph Query Protection

**Sentinel raised:** Neo4j graph queries for visualization can be expensive.

**Resolution:** Enforce query limits: max depth=3, max nodes=200, timeout=5s. Pagination required for large result sets. No arbitrary Cypher execution from the API.

---

## Decision 10: Theater Prohibition in API

**Vox/Canon alignment:** Outgoing conversation messages MUST include drive state snapshot and TheaterCheck result. Frontend displays drive correlation alongside Sylphie's responses for transparency.
