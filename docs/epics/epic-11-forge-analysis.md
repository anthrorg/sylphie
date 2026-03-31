# Epic 11: Frontend Port & Media Integration — Forge Analysis

**Date:** 2026-03-30
**Author:** Forge (NestJS/TypeScript Systems Architect)
**Scope:** WebSocket adapter layer, Observatory/Skills/Media endpoints, frontend integration, module structure

---

## 1. Current State Audit

Before proposing anything, it is worth being precise about what already exists and what does not. Misreading the current state is the fastest path to over-engineering.

### What Exists in the Backend

The `WebModule` at `src/web/web.module.ts` is the single HTTP/WS surface. It already provides:

- Three gateways: `ConversationGateway` (`/ws/conversation`), `TelemetryGateway` (`/ws/telemetry`), `GraphUpdatesGateway` (`/ws/graph`)
- Six REST controllers: `HealthController`, `DrivesController`, `GraphController`, `ConversationController`, `MetricsController`, `VoiceController`
- A `ConnectionManagerService` for WebSocket lifecycle management

### What Does Not Exist

- No `frontend/` directory. The React frontend has not been scaffolded.
- No Observatory endpoints (vocabulary growth, drive evolution, action diversity, developmental stage, session comparison, comprehension accuracy, phrase recognition).
- No Skills management endpoints. CANON A.13 marks skills as "DEFERRED — emerge from Planning procedures." This is a boundary the epic must navigate carefully.
- No video/camera streaming or WebRTC signaling.
- No adapter layer between Sylphie's wire format and any co-being frontend format.

### Key Wire Format Mismatches

These are the structural differences that need an adapter layer, not refactoring of the core DTOs:

| Location | Sylphie (current) | Co-being frontend (expected) | Risk |
|---|---|---|---|
| Conversation outbound | `{ sessionId, driveSnapshot: { drives: [{name, value}], totalPressure, ... } }` | `{ turn_id, grounding_ratio, is_grounded }` | Moderate — semantic gap, not just naming |
| Telemetry outbound | `{ events: [{ type, payload: { driveSnapshot: { drives: [...] } } }] }` | `{ system_health: 0.5, curiosity: 0.3, ... }` (flat snake_case) | High — completely different shape |
| Graph WebSocket outbound | `{ id, sourceId, targetId, ... }` | `{ node_id, source_node_id, schema_level, ... }` | Moderate — naming plus an added `schema_level` field |

The risk on telemetry is the highest. The co-being frontend expects a flat object; Sylphie emits a batched frame of structured events. These are not the same protocol — they have different semantics, not just different key names. An adapter must flatten and project, not just rename.

---

## 2. CANON Constraints That Bound the Design

Before the module structure question, three CANON constraints directly affect Epic 11:

**Drive Isolation (CANON §Drive Isolation):** The telemetry adapter is read-only. Nothing from the frontend touches the drive evaluation function. Any endpoint that could be construed as writing drive state is a CANON violation. The flat `{ system_health: 0.5 }` format the co-being frontend expects must be generated from the `IDriveStateReader` interface, not from any endpoint that accepts a drive value payload.

**Skills Are Deferred (CANON A.13):** "Skill packages emerge from Planning procedures." Skills are not a standalone data store; they are Planning-module output that graduates into the WKG. A `SkillsModule` that manages a separate skill database would contradict this. The correct structure is REST endpoints over the Planning module's existing procedure nodes in the WKG. The "skills CRUD" requirement should be scoped to read and soft-delete of procedure nodes, not a full independent entity lifecycle.

**No Separate Observatory Service:** The observatory metrics (vocabulary growth, developmental stage, comprehension accuracy, phrase recognition) are derived metrics — they aggregate existing WKG data and TimescaleDB event data. CANON §Architecture says the five subsystems share state through exactly two channels: TimescaleDB and the WKG. Observatory endpoints must be computed from those two stores through existing module interfaces. A separate Observatory microservice or database would be an infrastructure violation.

---

## 3. Recommended Module Structure

### 3.1 WebSocket Adapter Layer — In WebModule, Not a New Module

The adapter layer does not deserve its own NestJS module. It is a transformation concern, not a domain concern. It belongs in `src/web/adapters/` as pure transformation functions and a thin adapter service.

Proposed directory additions inside `src/web/`:

```
src/web/
├── adapters/
│   ├── conversation.adapter.ts      # ConversationOutgoingMessage -> co-being turn format
│   ├── telemetry.adapter.ts         # TelemetryFrame -> flat snake_case drive object
│   ├── graph.adapter.ts             # GraphNodeDto/GraphEdgeDto -> co-being node format
│   └── index.ts
```

These are pure functions, not injectable services. They take the existing DTO types and return the co-being wire format. The gateways call them before emitting. No DI token required.

The key design decision: **the existing DTOs do not change**. The adapters are a projection layer at the emission point. This preserves the existing WebSocket contracts for any future native Sylphie clients while adding co-being compatibility.

For the telemetry adapter specifically, the flat object format needs to be defined as a named type:

```typescript
// src/web/adapters/telemetry.adapter.ts
export interface CoBeing_DriveFrame {
  readonly system_health: number;
  readonly moral_valence: number;
  readonly integrity: number;
  readonly cognitive_awareness: number;
  readonly guilt: number;
  readonly curiosity: number;
  readonly boredom: number;
  readonly anxiety: number;
  readonly satisfaction: number;
  readonly sadness: number;
  readonly information_integrity: number;
  readonly social: number;
  readonly total_pressure: number;
  readonly tick_number: number;
  readonly timestamp: number;
}
```

The `grounding_ratio` and `is_grounded` fields the co-being conversation format expects are semantic — they imply a "groundedness" concept that does not directly exist in Sylphie's architecture. The closest mapping is the Theater Prohibition check result (`TheaterCheckDto`). The adapter should map `theaterCheck.passed` to `is_grounded` and compute `grounding_ratio` as `theaterCheck.correlationScore` if that field exists, or derive it from the drive pressure values. This mapping must be documented in the adapter with a comment referencing CANON Standard 1. It cannot be silently elided.

For graph, the `schema_level` field the co-being format expects maps cleanly to the WKG's three levels (instance, schema, meta-schema). The `GraphNodeDto` carries a `type` field that partially encodes this, but the levels are not explicitly tagged in the current DTO. The graph adapter will need to infer `schema_level` from node type conventions until the WKG service adds an explicit field. This is a known approximation and must be documented.

### 3.2 Observatory Endpoints — Extend MetricsModule, Not a New Module

The existing `MetricsController` at `GET /api/metrics` already exposes the seven CANON health metrics. The Observatory endpoints are an extension of this, not a parallel system.

The MetricsModule (`src/metrics/`) already has `IMetricsComputation`, `IDriftDetection`, and `IAttractorDetection`. The Observatory endpoints listed in the epic map to existing or computable metrics:

| Observatory Endpoint | Maps To | Source |
|---|---|---|
| Vocabulary growth | WKG node count over time, by type | WKG stats + TimescaleDB event query |
| Drive evolution | Drive snapshot history | TimescaleDB drive events |
| Action diversity | BehavioralDiversityIndex (already exists in MetricsController) | EventService query |
| Developmental stage | Type1/Type2 ratio + prediction MAE together | MetricsController (composite) |
| Session comparison | Baseline snapshots from DriftDetection | DriftDetectionService |
| Comprehension accuracy | Prediction MAE filtered to INPUT_PARSED events | EventService query |
| Phrase recognition | CAN_PRODUCE edges in WKG with confidence > 0.5 | WKG query |

The correct structure: add new endpoints to `MetricsController` under `GET /api/metrics/observatory/*`. The controller already imports `EVENTS_SERVICE`, `WKG_SERVICE`, and `DRIVE_STATE_READER`. No new module imports are required for most of these.

For session comparison and drift analysis, `MetricsController` currently does not inject the `METRICS_COMPUTATION` service from MetricsModule — it re-implements computations inline. That design debt must be resolved here: inject the MetricsModule tokens and delegate, rather than continuing to duplicate computation logic in the controller.

This means WebModule must add `MetricsModule` to its imports:

```typescript
// src/web/web.module.ts — updated imports array
imports: [
  KnowledgeModule,
  EventsModule,
  DatabaseModule,
  DriveEngineModule,
  CommunicationModule,
  MetricsModule,   // ADD for observatory endpoints
],
```

This is not a circular dependency. MetricsModule imports EventsModule and KnowledgeModule. WebModule already imports both. NestJS deduplicates module instances, so adding MetricsModule to WebModule's imports is safe.

### 3.3 Skills Endpoints — In WebModule, No New Module

Skills in CANON terms are procedure nodes in the WKG. They are not a separate entity. The correct backend representation is:

```
GET  /api/skills           Query WKG for Procedure nodes, paginated
GET  /api/skills/:id       Single procedure node with its performance history
DELETE /api/skills/:id     Soft-delete (lower confidence to below retrieval threshold; do not remove node)
```

There is no `POST /api/skills` for creating skills. Skills are created by the Planning subsystem through the opportunity pipeline. Creating a skill via REST would bypass the prediction-evaluation loop and violate CANON Standard 2 (the Contingency Requirement). If the co-being frontend has a "create skill" UI, that flow does not map to Sylphie's architecture and should be removed from the ported frontend or redirected to a "request opportunity evaluation" endpoint.

Implementation: a `SkillsController` in `src/web/controllers/skills.controller.ts`. No new module. It injects `WKG_SERVICE`, already available in WebModule through KnowledgeModule.

### 3.4 Video/Camera Streaming and WebRTC — New MediaModule

This is the one new module the epic genuinely justifies.

Media concerns are architecturally distinct from the Communication subsystem. CommunicationModule handles LLM voice, STT, and TTS — all text-and-audio pipelines. Video capture and WebRTC signaling are a different transport layer with different dependencies. Placing them in CommunicationModule would bloat a module that is already at the upper edge of manageable size.

A `MediaModule` handles:
- WebRTC signaling (offer/answer/ICE candidate exchange over WebSocket)
- Camera frame relay to the CommunicationModule's input pipeline (Phase 1: browser MediaStream relay; Phase 2: YOLO perception)

Proposed structure:

```
src/media/
├── media.module.ts
├── media.tokens.ts
├── webrtc/
│   ├── webrtc-signaling.service.ts    # Stores offers/answers per session
│   └── webrtc-signaling.gateway.ts    # /ws/media WebSocket for signaling
├── camera/
│   └── camera-relay.service.ts        # Relays frame metadata to EventsModule
├── interfaces/
│   ├── media.interfaces.ts            # IWebRtcSignalingService, ICameraRelayService
│   └── index.ts
└── index.ts
```

Module imports for MediaModule:
- `ConfigModule` — WebRTC STUN/TURN server configuration
- `EventsModule` — records MEDIA_SESSION_STARTED, MEDIA_FRAME_RECEIVED events

MediaModule does not import CommunicationModule directly. Camera frames are dropped onto the EventsModule event stream, and CommunicationModule's input parser subscribes to those events. This preserves the CANON rule that subsystems communicate through shared stores, not direct module imports.

WebRTC signaling gateway lives in MediaModule, not WebModule. WebModule is the general API surface; MediaModule is a specialized transport layer. Both register WebSocket gateways at different paths without needing to be in the same module. NestJS supports this naturally.

AppModule imports MediaModule after WebModule in its imports array.

### 3.5 Frontend — New `frontend/` Workspace

The frontend is not part of the NestJS module system, but its configuration affects the backend. Key structural decisions:

The `frontend/` directory should be a standalone Vite project, not a NestJS serve target. The Vite dev server proxies to the NestJS backend. No backend change is required to serve the frontend — it is a separate process in development, and in production it can be served as static files from a reverse proxy (nginx or similar) that also fronts the NestJS server.

Type sharing: the co-being frontend uses `@cobeing/shared` types. After porting, these are replaced with local types derived from the Sylphie DTOs in `src/web/dtos/`. The correct approach is a local types file the frontend imports:

```
frontend/src/types/
├── sylphie-wire.ts      # Mirrors src/web/dtos/*.ts as frontend-facing types
└── cobeing-compat.ts    # The co-being shapes that the adapters project to
```

This keeps the frontend independent from the NestJS module system while avoiding type definition duplication.

---

## 4. Key Technical Risks

### Risk 1: Telemetry Format Semantic Gap (High)

The co-being flat `{ system_health: 0.5 }` object is not just a rename of the Sylphie `TelemetryFrame`. Sylphie's telemetry is batched (multiple events per frame, with sequence numbers for ordering). The co-being format appears to be a single-state snapshot. If the frontend renders based on per-message state replacement rather than merging a batch, connecting the two protocols requires the adapter to emit one frame per drive snapshot, discarding batching. At 100Hz drive ticks with a 500ms batch interval, the current design sends approximately 1 message per 500ms containing up to 50 snapshots. Unbatching this to per-snapshot messages could increase WebSocket message frequency by 50x. Assess the co-being frontend's rendering loop before committing to this approach. A dedicated low-frequency co-being telemetry feed alongside the existing high-fidelity batched feed may be required.

### Risk 2: grounding_ratio / is_grounded Have No Direct Mapping (Medium)

These fields imply a concept ("grounding") that is not a first-class Sylphie construct. The Theater Prohibition check result is the closest analog, but `TheaterCheckDto` is only present on `ConversationOutgoingMessage` responses — it does not exist on the telemetry stream. If the co-being frontend uses `is_grounded` for telemetry visualization, the mapping is undefined. Decision point: define `is_grounded = theaterCheck.passed ?? true` on conversation messages, and omit the field from telemetry where it has no meaning. Do not fabricate a value.

### Risk 3: schema_level Field Not in Current WKG DTOs (Medium)

`GraphNodeDto` has a `type` field but not `schema_level`. The WKG three-level structure (instance/schema/meta-schema) is documented in CANON but not yet reflected as a first-class property in the graph DTOs or Neo4j node properties. The graph adapter will have to infer schema level from type conventions, which will be wrong for some node types. The correct fix is to add `schema_level` as an explicit field to `GraphNodeDto` and ensure the WKG service populates it during node upserts. That is a breaking change to the existing DTO interface and must be treated as a prerequisite ticket for the graph adapter work.

### Risk 4: Skills CRUD Expectations vs. CANON A.13 (Medium)

If the co-being frontend has a "create skill" or "edit skill" flow, those features cannot be ported faithfully. They contradict the planning pipeline. This must be decided before frontend work begins: either remove the create/edit UI and replace it with a "request opportunity evaluation" pathway, or explicitly document that skill creation in the UI triggers a planning pipeline request rather than a direct WKG write. Either option is architecturally valid; choosing neither and porting the UI as-is creates a CANON Standard 2 violation path.

### Risk 5: WebRTC Phase 1 Scope Ambiguity (Low-Medium)

WebRTC signaling without a TURN relay server only works reliably on the same local network. Phase 1 is a local companion, so this is likely acceptable. However, if the STUN/TURN configuration is absent from the config schema on startup, media sessions will silently fail in some network environments. The `MediaConfig` class must include `stunServers` with a default of `stun:stun.l.google.com:19302` and an optional `turnServer`, both validated at startup. Missing media configuration should be a startup warning, not a silent runtime failure.

### Risk 6: WebModule Import Graph Growth (Low)

Adding `MetricsModule` to WebModule's imports makes it the fifth subsystem-level import alongside KnowledgeModule, DriveEngineModule, CommunicationModule, and DatabaseModule. WebModule is legitimately a consumer of all of these. But if a future epic adds more imports to WebModule, it warrants a structural audit: the module may need to be split into a `DashboardModule` (read-heavy controllers) and a separate real-time gateway module. Epic 11 does not trigger that split, but the threshold is close.

---

## 5. Dependency Ordering (What Must Be Built First)

**Wave 1 — Type System Foundation**

These must exist before any other tickets compile against them.

1. Define `CoBeing_DriveFrame`, `CoBeing_ConversationTurn`, `CoBeing_GraphNode`, `CoBeing_GraphEdge` interface types in `src/web/adapters/`. These are the target shapes for the adapter functions. Defining them first lets all adapter implementations compile-check against a stable contract.
2. Add `schema_level: 'instance' | 'schema' | 'meta-schema'` to `GraphNodeDto` in `src/web/dtos/graph.dto.ts`. Update the WkgService node upsert to populate this field. This is a prerequisite for the graph adapter and must happen before frontend porting begins.
3. Define `MediaConfig` in `src/shared/config/app.config.ts` with STUN/TURN configuration, validated on startup.

**Wave 2 — Adapter Layer and Controller Extensions**

4. Implement `telemetry.adapter.ts`, `conversation.adapter.ts`, `graph.adapter.ts`.
5. Update the three gateways to call the adapters before emission. Both the original Sylphie format and the co-being format must be supported; clients indicate their preferred protocol via a query parameter on the WebSocket connection URL (e.g., `?protocol=cobeing-v1`). The dual-format approach is strongly preferred over replacing the existing format — it preserves backward compatibility with existing test harnesses.
6. Add `SkillsController` to `src/web/controllers/`. Add to WebModule's `controllers` array.
7. Add observatory endpoints to `MetricsController`. Inject `METRICS_COMPUTATION` from MetricsModule rather than continuing inline computation. Add `MetricsModule` to WebModule's imports array.

**Wave 3 — MediaModule**

8. Scaffold `src/media/` with interfaces and tokens first.
9. Implement `WebRtcSignalingGateway` with offer/answer/ICE candidate exchange.
10. Implement `CameraRelayService` — thin in Phase 1 (relay frame metadata to EventsModule; no YOLO integration in E11).
11. Add `MediaModule` to `AppModule` imports.

**Wave 4 — Frontend**

12. Create `frontend/` as a Vite + React + TypeScript project. Configure Vite proxy for `/api` and `/ws`.
13. Copy co-being frontend source into `frontend/src/`.
14. Replace `@cobeing/shared` imports with local `frontend/src/types/sylphie-wire.ts`.
15. Update WebSocket connection strings to co-being-protocol paths (e.g., `/ws/telemetry?protocol=cobeing-v1`).
16. Remove demo mode code.
17. End-to-end verification: all four WebSocket connections live in dev, `/api/health` returns 200, graph visualization renders WKG data.

---

## 6. Ticket Count and Complexity Estimate

**Wave 1 — Type System Foundation**

| Ticket | Work | Complexity |
|---|---|---|
| E11-T001 | Co-being adapter target types (four interfaces in `src/web/adapters/`) | Small |
| E11-T002 | `schema_level` field in GraphNodeDto + WkgService population | Medium |
| E11-T003 | `MediaConfig` in AppConfig with startup validation | Small |

**Wave 2 — Adapter Layer and Controller Extensions**

| Ticket | Work | Complexity |
|---|---|---|
| E11-T004 | `telemetry.adapter.ts` + TelemetryGateway dual-protocol support | Medium |
| E11-T005 | `conversation.adapter.ts` + ConversationGateway dual-protocol support. Includes `is_grounded` / `grounding_ratio` mapping decision. | Medium |
| E11-T006 | `graph.adapter.ts` + GraphUpdatesGateway dual-protocol support | Small |
| E11-T007 | `SkillsController`: `GET /api/skills`, `GET /api/skills/:id`, `DELETE /api/skills/:id` | Small |
| E11-T008 | Observatory endpoints in MetricsController (vocabulary growth, drive evolution, developmental stage, session comparison, comprehension accuracy, phrase recognition). Wire MetricsModule into WebModule. Resolve MetricsController DI debt. | Large |

**Wave 3 — MediaModule**

| Ticket | Work | Complexity |
|---|---|---|
| E11-T009 | MediaModule scaffold: interfaces, tokens, module declaration | Small |
| E11-T010 | WebRtcSignalingGateway (`/ws/media`): offer/answer/ICE exchange | Medium |
| E11-T011 | CameraRelayService: frame metadata relay to EventsModule | Small |
| E11-T012 | AppModule wiring: add MediaModule | Small |

**Wave 4 — Frontend**

| Ticket | Work | Complexity |
|---|---|---|
| E11-T013 | Vite project scaffold in `frontend/`. Proxy config. Package.json scripts. | Small |
| E11-T014 | Co-being source port: copy source, replace `@cobeing/shared` imports | Medium |
| E11-T015 | WebSocket URL migration: update all WS connection strings to Sylphie paths | Small |
| E11-T016 | Remove demo mode code | Medium |
| E11-T017 | End-to-end verification: all WS connections live, graph renders, health check passes | Medium |

**Total: 17 tickets**

| Complexity | Count |
|---|---|
| Large | 1 (E11-T008: observatory endpoints) |
| Medium | 7 |
| Small | 9 |

E11-T008 is the single highest-effort item. It involves seven distinct metric computations, four of which require queries not currently in MetricsController, and it requires resolving the inline computation debt before delegating to MetricsModule. Consider splitting it: one ticket for the four metrics that are simple event queries (drive evolution, developmental stage, comprehension accuracy, action diversity), and one for the three that require WKG graph traversal (vocabulary growth, phrase recognition, session comparison).

---

## 7. Interface Contracts That Must Be Defined Before Implementation Begins

These shapes must be reviewed and approved before Wave 2 implementation starts. Agents must not invent these independently.

### Protocol Negotiation

```typescript
// Addition to src/web/interfaces/websocket.interfaces.ts

/**
 * Wire protocol discriminator for WebSocket connections.
 *
 * Clients indicate protocol preference via query parameter on connection URL.
 * Example: ws://localhost:3000/ws/telemetry?protocol=cobeing-v1
 *
 * When absent, gateways default to 'sylphie-native'.
 */
export type WireProtocol = 'sylphie-native' | 'cobeing-v1';
```

### Skills DTO

```typescript
// src/web/dtos/skills.dto.ts

/**
 * SkillDto — a Planning procedure node serialized for the Skills UI.
 *
 * CANON A.13: Skills emerge from Planning procedures. This DTO represents
 * a Procedure node from the WKG. Creation via REST is not supported.
 */
export interface SkillDto {
  readonly id: string;
  readonly label: string;
  readonly confidence: number;
  readonly provenance: string;
  /** Number of successful retrieval-and-use events. */
  readonly useCount: number;
  /** Prediction MAE for this procedure's last 10 uses. */
  readonly predictionMae: number;
  /** Whether this procedure has graduated to Type 1 per CANON graduation criteria. */
  readonly isType1: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}
```

### Media Signaling Interfaces

```typescript
// src/media/interfaces/media.interfaces.ts

export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'session-end';

export interface SignalingMessage {
  readonly type: SignalType;
  readonly sessionId: string;
  readonly payload: unknown; // RTCSessionDescriptionInit or RTCIceCandidateInit
}

export interface IWebRtcSignalingService {
  /**
   * Store an offer for a new media session. Returns the assigned session ID.
   * Sessions expire after configurable timeout (default 60s without an answer).
   */
  storeOffer(offer: unknown): string;

  /**
   * Retrieve a pending offer by session ID. Returns null if expired or not found.
   */
  getOffer(sessionId: string): unknown | null;

  /**
   * Store an answer for a pending session.
   * @throws MediaException if no pending offer exists for sessionId
   */
  storeAnswer(sessionId: string, answer: unknown): void;
}
```

---

## 8. What This Epic Does Not Change

These module boundaries must not be disturbed by Epic 11 work:

- The five subsystem modules (DecisionMaking, Communication, Learning, DriveEngine, Planning) do not add HTTP controllers or WebSocket gateways. All external surface area remains in WebModule and MediaModule.
- `CommunicationModule`'s `ChatboxGateway` at `src/communication/chatbox/chatbox.gateway.ts` is a pre-existing internal gateway. It is not the same as `ConversationGateway`. If the co-being frontend's conversation UI replaces ChatboxGateway's role, the two must coexist during the transition. Do not remove the internal gateway without an explicit decision.
- `DriveSnapshotDto` in `src/web/dtos/drive.dto.ts` does not change shape. The adapter translates to the co-being format at emission time. The DTO is the canonical Sylphie representation.
- MetricsModule remains a standalone module. Dependency direction: WebModule imports MetricsModule, not the reverse.

---

## Summary

Epic 11 is 17 tickets in four waves. The critical path runs through three decisions that must be made before any implementation begins:

1. **Dual-protocol or protocol replacement?** The analysis recommends dual-protocol support via query parameter. Protocol replacement would break any existing test harnesses connected to the native Sylphie WebSocket format.

2. **`is_grounded` / `grounding_ratio` mapping.** These must be explicitly defined in the adapter contract before implementation. The recommended mapping: `is_grounded = theaterCheck.passed ?? true` on conversation messages; field absent from telemetry frames where it has no semantic meaning.

3. **Skills create/edit in co-being UI.** This must be removed or redirected to the planning pipeline before frontend porting begins. Leaving it in creates a CANON Standard 2 violation path.

The single highest-risk ticket is E11-T008 (observatory endpoints). Plan for it to take 2x the time of a typical medium ticket. It is a strong candidate for splitting into two tickets before the sprint begins.
