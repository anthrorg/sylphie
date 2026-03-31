# Epic 9: Dashboard API and WebSocket Gateways — Implementation Plan

**Epic:** 9
**Phase:** 1
**Created:** 2026-03-29
**Status:** Planned
**Complexity:** M
**Dependencies:** E2 (Events), E3 (Knowledge), E4 (Drive Engine), E5 (Decision Making), E6 (Communication)

---

## Overview

Epic 9 builds the WebModule — the HTTP REST and WebSocket API surface through which the React frontend dashboard observes and interacts with Sylphie's internal state. WebModule is a **pure consumer**: it reads from subsystem interfaces, never contains business logic, and all mutations flow through application-layer services.

The critical architectural principle: **WebModule is a gateway, not a brain.** It does not make decisions, modify drive state, or generate knowledge. It translates internal state into API responses and WebSocket streams.

This epic delivers the API contract that Epic 10 (Integration) will verify end-to-end with the React frontend.

---

## Architecture

### Module Placement

```
src/web/
├── web.module.ts                     # Module declaration
├── web.config.ts                     # Configuration validation
├── controllers/
│   ├── health.controller.ts          # GET /api/health (all 5 databases)
│   ├── drives.controller.ts          # GET /api/drives/* (read-only)
│   ├── graph.controller.ts           # GET /api/graph/* (read-only WKG)
│   ├── conversation.controller.ts    # GET /api/conversation/* (history)
│   ├── metrics.controller.ts         # GET /api/metrics/* (CANON health metrics)
│   └── voice.controller.ts           # POST /api/voice/* (STT/TTS delegation)
├── gateways/
│   ├── telemetry.gateway.ts          # WS /ws/telemetry (drive ticks, predictions)
│   ├── graph-updates.gateway.ts      # WS /ws/graph (WKG change notifications)
│   ├── conversation.gateway.ts       # WS /ws/conversation (bidirectional chat)
│   └── connection-manager.service.ts # Shared WS client lifecycle
├── guards/
│   └── development.guard.ts          # Feature gate for debug endpoints
├── filters/
│   ├── http-exception.filter.ts      # Domain → HTTP status mapping
│   └── ws-exception.filter.ts        # WebSocket error frames
├── dtos/                             # All request/response DTOs
├── interfaces/
│   ├── web.interfaces.ts             # Service interfaces
│   ├── websocket.interfaces.ts       # WS frame types
│   └── web.tokens.ts                 # DI tokens
├── utils/
│   ├── paginator.ts                  # Pagination helper
│   └── graph-serializer.ts           # Neo4j → JSON serializer
└── index.ts                          # Barrel exports
```

### Module Dependencies

```
WebModule
  imports:
    - ConfigModule
    - EventsModule        (query events, telemetry, metrics)
    - KnowledgeModule     (graph visualization, provenance stats)
    - DriveEngineModule   (read-only drive state via IDriveStateReader)
    - CommunicationModule (chat routing, voice delegation)
  exports:
    - (none — WebModule is a leaf consumer)
```

### Data Flow

```
                    ┌──────────────┐
                    │  React       │
                    │  Frontend    │
                    └──────┬───────┘
                           │ HTTP/WS
                    ┌──────▼───────┐
                    │  WebModule   │  ◄── Pure consumer, no business logic
                    └──────┬───────┘
           ┌───────┬───────┼───────┬────────┐
           ▼       ▼       ▼       ▼        ▼
        Events  Knowledge  Drive   Comm   Planning
        Module  Module     Engine  Module  Module
           │       │       │       │        │
           ▼       ▼       ▼       ▼        ▼
        Timescale  Neo4j  IPC     Claude   WKG
        DB                Process  API
```

### CANON Compliance

**Philosophy alignment:**
- WebModule preserves the five-subsystem architecture (it is NOT a 6th subsystem)
- All WKG access is read-only (writes only through KnowledgeModule)
- Chat input routes through CommunicationModule → DecisionMakingModule
- Drive state accessed via IDriveStateReader (read-only, CANON §Drive Isolation)

**Six Immutable Standards:**
1. **Theater Prohibition** — Outgoing conversation messages include theaterCheck + drive state for transparency
2. **Contingency Requirement** — Chat flows through Decision Making, maintaining contingency tracking
3. **Confidence Ceiling** — Graph API displays confidence values accurately from WKG
4. **Shrug Imperative** — API can represent "I don't know" responses from Decision Making
5. **Guardian Asymmetry** — Chat feedback routed through Communication with 2x/3x weighting
6. **No Self-Modification** — No drive rule modification endpoints; read-only for drive rules

**Prohibited patterns (from v1 that MUST NOT carry forward):**
- Drive override endpoints (postDriveOverride, postDriveDrift, postDriveReset)
- Direct graph write endpoints
- Direct action selection endpoints
- Camera/hardware endpoints (Phase 2)

---

## v1 Code Lift Assessment

**Adapt patterns from v1:**
- HealthController: simple status ping → expand to 5-database cascade
- GraphController: paginated snapshot + stats → add subgraph extraction
- ConversationGateway: WS lifecycle, message handling → rebuild with NestJS gateways
- ConnectionManagerService: channel-based client management → adapt for ws adapter
- TelemetryGateway: subscription lifecycle → rebuild with RxJS buffering

**Clean-room reimplementation:**
- Exception hierarchy (more granular per Forge patterns)
- DTO layer (explicit serialization control)
- WebSocket message framing (standardized TelemetryFrame, GraphUpdateFrame, etc.)
- Development metrics API (new — computes CANON health metrics)
- Voice endpoints (new surface for E6 services)

---

## Ticket Dependency Graph

```
E9-T001 (Types & Interfaces)
  ├── E9-T002 (Module Skeleton)
  │     ├── E9-T003 (ConnectionManager)
  │     │     ├── E9-T009 (TelemetryGateway)
  │     │     ├── E9-T010 (GraphUpdatesGateway)
  │     │     └── E9-T011 (ConversationGateway)
  │     ├── E9-T004 (HealthController)
  │     ├── E9-T005 (DrivesController)
  │     ├── E9-T006 (GraphController)
  │     ├── E9-T007 (ConversationController)
  │     ├── E9-T008 (MetricsController)
  │     ├── E9-T012 (VoiceController)
  │     └── E9-T013 (Exception Filters)
  ├── E9-T014 (Configuration)
  └── E9-T015 (Event Types)

E9-T016 (Unit Tests: Controllers) ← E9-T004..T008
E9-T017 (Unit Tests: Gateways) ← E9-T003, E9-T009..T011
E9-T018 (Integration Test) ← E9-T016, E9-T017
E9-T019 (Documentation) ← E9-T018
```

---

## Implementation Sequence

```
Phase 9a (Foundation): T001, T014, T015 (types, config, events) — parallel
Phase 9b (Skeleton):   T002 (module wiring)
Phase 9c (Infra):      T003, T013 (connection manager, exception filters) — parallel
Phase 9d (Endpoints):  T004, T005, T006, T007, T008, T012 (all controllers) — parallel
Phase 9e (Gateways):   T009, T010, T011 (all gateways) — parallel
Phase 9f (Tests):      T016, T017 (unit tests) — parallel
Phase 9g (Verify):     T018 (integration test)
Phase 9h (Docs):       T019 (session log)
```

---

## Risks

1. **Interface gaps** — Health check methods may not exist on subsystem interfaces yet. T004 may need to propose interface extensions.
2. **WebSocket adapter choice** — Using `ws` (not Socket.io). Need `@nestjs/platform-ws` adapter configured in main.ts.
3. **Telemetry volume** — Drive Engine ticks at 100Hz. Telemetry gateway must buffer aggressively (500ms batches) to prevent overwhelming clients.
4. **Graph query performance** — Neo4j subgraph queries can be expensive. Strict limits (depth=3, nodes=200, timeout=5s) enforced.
5. **E6 dependency** — ConversationGateway and VoiceController depend on CommunicationModule being implemented (E6).

---

## CANON Verification Summary

**Verdict: COMPLIANT**

All tickets validated against:
- ✅ Philosophy: five-subsystem architecture preserved, WebModule is surface layer
- ✅ Standard 1 (Theater): theaterCheck included in conversation responses
- ✅ Standard 2 (Contingency): chat flows through Communication → Decision Making
- ✅ Standard 3 (Confidence Ceiling): graph API displays accurate confidence values
- ✅ Standard 4 (Shrug): API handles "I don't know" responses
- ✅ Standard 5 (Guardian Asymmetry): feedback routing with 2x/3x weights
- ✅ Standard 6 (No Self-Modification): no drive rule write endpoints
- ✅ Phase boundary: no Phase 2 (hardware) endpoints
- ✅ Drive isolation: read-only via IDriveStateReader
- ✅ KG isolation: graph API read-only, Other KG summaries only
