# app-sylphie — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**44 files** mapped.

## File-by-file

### `apps/sylphie/src/`

#### app.module.ts
*module* — Main NestJS application module that orchestrates all subsystems: decision-making, learning, planning, drive engine, supervisor, cognition, and all REST/WebSocket controllers and services.

AppModule imports and wires together the entire Sylphie architecture. It configures NestJS modules: ConfigModule (loads .env via process.cwd()), ServeStaticModule (serves Vite frontend in production from frontend/dist), PrismaModule, TimescaleModule, DriveEngineModule, DecisionMakingModule, LearningModule, PlanningModule, SupervisorModule, and CognitionModule. Neo4jModule is forRoot'd with three persistent instances (WORLD, SELF, OTHER) plus optional PKG instance based on config presence. PostgreSQL runtime pool is provisioned with 3 max connections, 30s idle timeout, 5s connection timeout. CognitionModule is marked @Global() to expose TENSOR_INFERENCE_SERVICE (implemented by TensorInferenceAdapter) to DecisionMakingService without violating package layering. Controllers: AuthController, GraphController, PkgController, SkillsController, DrivesController, PressureController, VoiceController, MetricsController, LlmController, DebugController, SupervisorController, RulesController, CognitionController. Services span sensory logging, drive publishing, WKG/PKG queries, STT/TTS, communication, conversation history, person modeling, visual working memory, telemetry/supervisor broadcast, cognition bridging, learning pressure bridge. Six WebSocket gateways (GraphGateway, ConversationGateway, TelemetryGateway, PerceptionGateway, AudioGateway, SupervisorGateway) handle real-time subscriptions.

- **Exports:** `AppModule`
- **Key constants:** `max connection pool size=3`, `idleTimeoutMillis=30000`, `connectionTimeoutMillis=5000`, `postgres.port=5434`, `postgres.database=sylphie_system`
- **Deps:** `@sylphie/shared`, `@sylphie/decision-making`, `@sylphie/learning`, `@sylphie/planning`, `@sylphie/drive-engine`, `@sylphie/supervisor`, `./controllers/*`, `./gateways/*`, `./services/*`
- **Gotchas:** Neo4jModule.PKG instance is optional and only instantiated if neo4j.pkg.uri is configured in .env; comment on line 143-155 explicitly documents this conditional logic. CognitionModule uses @Global() decorator which is a NestJS exception to normal module scoping — required to avoid circular dependency between app-level and packages/ layer. Comment on line 63-68 explains the rationale.

#### main.ts
*service* — NestJS application entry point that bootstraps the Sylphie backend server.

Exports a single async bootstrap() function that initializes the NestJS application using AppModule. Reconfigures the verbose logging subsystem to ensure the file handler opens after dotenv loads .env. Creates a WebSocketLoggerService that integrates with TelemetryBroadcastService to stream logs to the frontend. Configures the app with a global 'api' prefix, WebSocket adapter via @nestjs/platform-ws, CORS with configurable origin (default http://localhost:5173), and shutdown hooks. Server listens on PORT (Railway), APP_PORT (local override), or defaults to 3000. Entry point is a direct call to bootstrap() at module level.

- **Key constants:** `CORS_ORIGIN_DEFAULT=http://localhost:5173`, `PORT_DEFAULT=3000`, `GLOBAL_PREFIX=api`
- **Deps:** `@nestjs/core:NestFactory`, `@nestjs/common:Logger`, `@nestjs/platform-ws:WsAdapter`, `@sylphie/shared:reconfigureVerbose`, `./app.module:AppModule`, `./services/websocket-logger.service:WebSocketLoggerService`, `./services/telemetry-broadcast.service:TelemetryBroadcastService`
- **Gotchas:** VERBOSE reconfiguration executed synchronously after dotenv but bootstrap is async—timing is implicit. Logger integration to broadcast service assumes TelemetryBroadcastService is singleton and available in DI container.

### `apps/sylphie/src/controllers/`

#### auth.controller.ts
*service* — NestJS authentication controller managing user registration, login, and session state via JWT tokens.

AuthController is a NestJS controller (route '/auth') providing three endpoints: POST /auth/register creates users with bcrypt-hashed passwords after checking for duplicates; POST /auth/login validates credentials, checks approval status, and returns a signed JWT on success; GET /auth/me (guarded by AuthGuard) returns the authenticated user's profile from JWT payload. Token generation uses JWT with 7-day expiration, secret from ConfigService. Users start in unapproved state and require guardian approval before login. Includes role-based access via isGuardian flag encoded in tokens.

- **Exports:** `AuthController`
- **Key constants:** `bcrypt_rounds=10`, `jwt_expiresIn=7d`, `route=/auth`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared.PrismaService`, `bcrypt`, `jsonwebtoken`, `../guards/auth.guard.AuthGuard`, `../guards/auth.guard.JwtPayload`
- **Gotchas:** No refresh token mechanism; 7-day fixed expiration only. No rate-limiting on register/login endpoints. Approved flag is user.approved but not exposed in tokens. isGuardian flag defaults to false in response when undefined. No explicit logout endpoint.

#### cognition.controller.ts
*controller* — Dashboard endpoint aggregating cognition sidecar diagnostics for the Guardian tensor UI

Single controller class CognitionController with one GET endpoint /api/cognition/dashboard. Injects CognitionGatewayService to fetch four diagnostic streams in parallel: health (models_loaded, bootstrap_mode, training_enabled, total_parameters), bootstrap (mode, agreement_rate, per_category_agreement, categories_graduated, total_shadow_samples, total_audit_samples), metrics (training_steps, training_loss, inference_latency_ms, samples_in_buffer, checkpoint_count, per_category_confidence), and modelState. All four fetches run concurrently with 5s timeouts. Returns {available: false} if gateway unavailable; otherwise returns {available: true} with all four sections mapped to simplified snake_case→camelCase transforms, or null if any fetch fails. No database writes, no business logic beyond aggregation.

- **Exports:** `CognitionController`
- **Deps:** `@nestjs/common`, `../services/cognition-gateway.service`
- **Gotchas:** No error handling beyond section-level nullification—network timeouts/sidecar unavailability silently null out individual sections rather than failing the entire response. Missing health/bootstrap/metrics/modelState data is normalized to null rather than thrown. Logger declared but never used.

#### debug.controller.ts
*module* — Debug HTTP endpoints for camera status inspection and stream testing.

Defines DebugController, a NestJS HTTP controller mounted at /debug path. Exports two GET endpoints: cameraStatus() returns hardcoded {active: false} response; cameraStream() throws NotFoundException (404) with message "Camera not available". Both methods are stub implementations with no actual camera integration. No side effects, no database/network calls, no state management.

- **Exports:** `DebugController`
- **Deps:** `@nestjs/common`
- **Gotchas:** Both endpoints are stubs — cameraStatus always reports camera inactive regardless of actual state; cameraStream unconditionally throws 404; no real camera service integration present

#### drives.controller.ts
*controller* — Read-only HTTP endpoints for drive-engine liveness and pressure monitoring, intentionally blocking mutations to enforce process isolation.

DrivesController exposes GET /drives returning tickNumber, totalPressure, timestamp, isConnected (true iff tickNumber>0 AND timestamp within 2s). Three POST endpoints (override, drift, reset) all throw NotImplementedException per CANON §Drive Isolation: mutations forbidden from app process. PressureController mirrors the 2s recency window, GET /pressure returns is_connected and is_stale booleans. Both controllers inject IDriveStateReader (read-only access). Timestamp handling normalizes Date or string to Date before comparison. Key invariant: tickNumber alone is insufficient for liveness; must validate recency because stalled drive process keeps frozen counter forever.

- **Exports:** `DrivesController`, `PressureController`
- **Key constants:** `NOT_SUPPORTED='Drive mutation from the app process is forbidden by CANON Drive Isolation. Route changes through guardian-feedback events instead (see stub-inventory §3.3).'`, `recencyWindow=2000ms`
- **Deps:** `@nestjs/common`, `@sylphie/drive-engine (DRIVE_STATE_READER, IDriveStateReader)`
- **Gotchas:** Stub: Drive mutation routing through guardian-feedback events is open design decision (stub-inventory §3.3); currently returns 501 instead of executing. Timestamp coercion from Date\|string suggests client variability. Drive process death leaves tickNumber frozen — liveness must check recency or risk false-positive health signal.

#### graph.controller.ts
*component* — NestJS REST controller for querying working knowledge graph snapshots and node/edge pagination

GraphController exposes six HTTP endpoints for legacy full-graph snapshots (getSnapshot, getOkgSnapshot, getSkgSnapshot, getPkgSnapshot), two explorer endpoints (searchNodes via GET /graph/wkg/search with query param 'q' and limit clamped to 1-50, getNeighborhood via GET /graph/wkg/neighborhood with nodeId and hops clamped to 1-3), and four paginated endpoints for progressive loading (getCount, getNodes with skip/limit defaulting to 0/500 and clamped to max 2000, getEdges with skip/limit defaulting to 0/1000 and clamped to max 5000). All instance-based routes validate instance name via resolveInstance() and throw BadRequestException if unknown. Query parameters are parsed as integers with fallbacks; search limit caps at 50, neighborhood hops at 3, node limit at 2000, edge limit at 5000.

- **Exports:** `GraphController`
- **Key constants:** `DEFAULT_SEARCH_LIMIT=10`, `MAX_SEARCH_LIMIT=50`, `MIN_SEARCH_LIMIT=1`, `DEFAULT_NEIGHBORHOOD_HOPS=2`, `MAX_NEIGHBORHOOD_HOPS=3`, `MIN_NEIGHBORHOOD_HOPS=1`, `DEFAULT_NODES_SKIP=0`, `DEFAULT_NODES_LIMIT=500`, `MAX_NODES_LIMIT=2000`, `MIN_NODES_LIMIT=1`, `DEFAULT_EDGES_SKIP=0`, `DEFAULT_EDGES_LIMIT=1000`, `MAX_EDGES_LIMIT=5000`, `MIN_EDGES_LIMIT=1`
- **Deps:** `@nestjs/common (Controller, Get, Param, Query, Logger, BadRequestException)`, `../services/wkg-query.service (WkgQueryService, GraphSnapshotDto, SearchNodeResult, NeighborhoodDto)`
- **Gotchas:** No validation of nodeId/instance name format beyond empty-check; resolveInstance() abstraction not shown (implementation in WkgQueryService); search and neighborhood endpoints declared before :instance/* wildcard to avoid route collision (noted in comment); no error handling for WkgQueryService failures; Logger instantiated but not actively used in endpoint handlers

#### llm.controller.ts
*service* — NestJS REST controller exposing LLM availability for the Lesion Test gate

LlmController is a NestJS @Controller handling two REST routes for the CANON Lesion Test: POST /llm/lesion marks the LLM service unavailable to test graceful degradation (via enableLesionTest), and POST /llm/heal restores it (resetCircuitBreaker). The controller injects ILlmService and wraps calls with logging. The gate deliberately toggles availability rather than crashing the socket to prove the system's intended no-LLM codepath works; these routes do not modify drive state, metrics, or evaluation scoring (Theater Prohibition compliance).

- **Exports:** `LlmController`
- **Deps:** `@nestjs/common`, `@sylphie/shared (LLM_SERVICE, ILlmService)`
- **Gotchas:** Theater Prohibition mandate: routes must only toggle LLM availability, never alter drive state/metrics/scoring. Dual lesioning defense: socket severing AND this flag together ensure graceful degradation.

#### metrics.controller.ts
*service* — CANON health metrics REST endpoint + provability gate diagnostic seams (WS3 C3 + WS5 perception hermeticity).

MetricsController exposes 7 CANON development metrics (Type1Type2Ratio, PredictionMAE, ProvenanceRatio, BehavioralDiversityIndex, GuardianResponseRate, InteroceptiveAccuracy, MeanDriveResolutionTime) via /metrics/health snapshot. Provides hermetic reset routes for provability gate (latent-reset, person-facts-reset, episodic-reset, perception-reset, scene-predictor-reset) + WS3 T4 C3 gate seam (/c3-seed, /c3-reinforce, /decay-now, /c3-inspect, /c3-cleanup) proving compounding memory mechanism through real reinforceFactNode + decay cycle. WS3 T5 provenance verification (/node-exists) checks if groundingProvenance node IDs actually exist in live Neo4j. Observatory endpoints return per-session historical slices for dashboard charts (vocabulary-growth, drive-evolution, action-diversity, developmental-stage, session-comparison, comprehension-accuracy, phrase-recognition). All metrics default to zero/NaN when data unavailable; no writes on read paths; read-only DriveStateReader enforces CANON Drive Isolation.

- **Exports:** `MetricsController`
- **Key constants:** `MAX_TOTAL_PRESSURE=12.0`, `MIN_CONFIDENCE_PRUNE_THRESHOLD=0.10`, `BEHAVIORAL_DIVERSITY_WINDOW_SIZE=20`, `GUARDIAN_RESPONSE_WINDOW_HOURS=24`, `GUARDIAN_RESPONSE_TIMEOUT_SECONDS=30`, `DRIVE_RESOLUTION_WINDOW_MINUTES=5`, `DEVELOPMENT_STAGE_AUTONOMY_THRESHOLD=0.80`, `DEVELOPMENT_STAGE_CONSOLIDATING_THRESHOLD=0.50`, `DEVELOPMENT_STAGE_EMERGING_THRESHOLD=0.20`, `C3_CONTROL_ID='ws3-c3-control'`, `C3_TREATMENT_ID='ws3-c3-treatment'`, `C3_ANCHOR_ID='ws3-c3-anchor'`, `DEFAULT_C3_CONFIDENCE=0.30`, `DEFAULT_C3_AGE_HOURS=48`, `DEFAULT_C3_ANCHOR_CONFIDENCE=0.95`
- **Deps:** `@sylphie/decision-making (ArbitrationService, AttractorMonitorService, LatentSpaceService, ModalityRegistryService, WkgContextService, EpisodicMemoryService, ScenePredictionService)`, `@sylphie/drive-engine (IDriveStateReader)`, `@sylphie/learning (ILearningService)`, `@sylphie/shared (Neo4jService, TimescaleService, HealthMetrics types)`, `PersonModelService`, `VisualWorkingMemoryService`, `PerceptionGateway`
- **Gotchas:** C3 write-recency guard (lines 532-542): control + treatment seeded with identical created_at/updated_at; reinforceFactNode() never touches updated_at to isolate divergence to reinforcement only (verified assertion in gate). Decay uses coalesce(last_retrieval_at, updated_at, created_at) so control decays from shared old updated_at while treatment uses fresh last_retrieval_at. Orphan-prune confound neutralized via shared FIXTURE_ANCHOR edge (zero asymmetry). Behavioral diversity (line 1289) is structural proxy only — full action type diversity requires payload category field not currently in schema. Guardian response rate (line 1369) matches COMMUNICATION subsystem event types; window is last 24 hours with 30-second response threshold. Observatory queries return empty arrays (not zeroed objects) when no sessions exist, per chart renderer expectation. Interoceptive accuracy (line 1416-1417) uses cognitive-awareness drive from pressure vector; cold-start (tickNumber===0) returns accuracy=0 to signal pre-connection. Node-exists defaults to WORLD instance (line 830) and uses node_id for WORLD vs attr_id for OKG (line 837-839).

#### pkg.controller.ts
*component* — REST API endpoints for code-graph querying and analysis

NestJS Controller exposing three GET endpoints on /graph/pkg route: search() queries the codebase by pattern with optional fileFilter and configurable limit (1-50, default 20); getFunctionDetail() returns metadata for a named function with optional filePath context; getDataFlow() traces data dependencies upstream/downstream/both with configurable depth (1-6, default 3). All methods delegate to injected PkgQueryService. Includes Logger instance for debugging. Validates numeric query parameters (limit, depth) with bounds-checking and fallback defaults.

- **Exports:** `PkgController`
- **Key constants:** `limit_max=50`, `limit_default=20`, `limit_min=1`, `depth_max=6`, `depth_min=1`, `depth_default=3`
- **Deps:** `@nestjs/common`, `../services/pkg-query.service`

#### rules.controller.ts
*controller* — NestJS controller exposing guardian-authenticated endpoints for drive rule proposal review, approval, and rejection.

RulesController is a guardian dashboard controller with 4 endpoints: GET /rules/proposed (list proposed rules, optionally filtered by status), GET /rules/active (list active rules), POST /rules/:id/approve (guardian-only approval), POST /rules/:id/reject (guardian-only rejection). All endpoints require AuthGuard. Approve and reject endpoints additionally check req.user.isGuardian and throw ForbiddenException if the user lacks guardian role. The controller delegates all business logic to GuardianRulesService. Aligns with CANON Immutable Standard 6 (No Self-Modification of Evaluation) by gating rule modifications behind guardian authentication only.

- **Exports:** `RulesController`
- **Deps:** `@nestjs/common`, `../guards/auth.guard`, `../services/guardian-rules.service`
- **Gotchas:** No input validation decorators (e.g., @IsString, @IsUUID) on route parameters or query params; status filter on proposed rules is untyped.

#### skills.controller.ts
*controller* — Guardian endpoint for destructive system reset operations on knowledge graphs and learned state.

SkillsController exposes two guardian-only POST endpoints for knowledge graph reset: /skills/reset performs full system reset (delete all WKG nodes/edges, re-bootstrap), while /skills/reset-world does WORLD-only reset (preserves SELF KG, OTHER KG, tensor pipeline, voice patterns, sensory ticks, PostgreSQL; queues old events for reprocessing to use improved pipeline). Both endpoints require confirmation flag in request body and log warnings via NestJS Logger. Delegates actual reset logic to WkgBootstrapService (resetAndBootstrap, resetWorldOnly methods). Returns success response with node/edge counts and operation metadata.

- **Exports:** `SkillsController`
- **Deps:** `@nestjs/common`, `../services/wkg-bootstrap.service`
- **Gotchas:** Both endpoints require explicit { "confirm": true } in POST body; no default confirmation mechanism; assumes WkgBootstrapService methods are safe and complete; no rate-limiting or audit trail visible at controller level; reset-world returns literal string names in preserved array (may diverge from actual service behavior if not kept in sync)

#### supervisor.controller.ts
*component* — REST controller exposing supervisor status, verdicts, policy updates, and manual interventions

SupervisorController is a NestJS @Controller wrapping ISupervisorService to provide the guardian control surface. GET /supervisor/status returns full supervisor state (sampling policy, budget, verdict counts, recent 20 verdicts). GET /supervisor/verdicts accepts optional limit query param (1-50, default 50) and returns most recent N verdicts from status buffer. POST /supervisor/policy accepts partial SamplingPolicy object and merges supplied fields. POST /supervisor/intervene accepts SupervisorIntervention body (source expected to be 'guardian') and submits it. POST /supervisor/enable and POST /supervisor/disable toggle enabled flag and return status. All mutation endpoints return {ok:true} or {ok:true,enabled:bool}.

- **Exports:** `SupervisorController`
- **Key constants:** `default limit=50 for verdicts`, `verdict limit clamped to Math.max(1,Math.min(parseInt(limit,10)\|\|50,status.recentVerdicts.length))`
- **Deps:** `@nestjs/common (Controller,Get,Post,Body,Inject,Query)`, `@sylphie/supervisor (SUPERVISOR_SERVICE,ISupervisorService,SamplingPolicy,SupervisorIntervention)`
- **Gotchas:** limit query param coerced with parseInt(limit,10)\|\|50 (silently defaults on NaN); no explicit error handling on malformed SamplingPolicy or SupervisorIntervention bodies; controller assumes ISupervisorService is always injected and callable without null checks

#### voice.controller.ts
*component* — NestJS HTTP controller for voice services (STT/TTS status, transcription, audio retrieval)

VoiceController is a NestJS REST controller that exposes three endpoints: GET /voice/status returns availability flags for STT and TTS services; POST /voice/transcribe is a legacy one-shot transcription endpoint (stub returning empty text, confidence 0, latencyMs 0) with a note that real-time streaming STT should use /ws/audio gateway instead; GET /voice/audio/:turnId throws NotFoundException. Dependencies are SttService and TtsService injected via constructor. The status endpoint checks .available property on both services and returns combined + individual availability flags.

- **Exports:** `VoiceController`
- **Deps:** `../services/stt.service`, `../services/tts.service`
- **Gotchas:** transcribe() endpoint is a stub returning hardcoded empty response (confidence: 0, latencyMs: 0, text: ''); comment explicitly flags legacy path and redirects real-time streaming to /ws/audio; getAudio() always throws NotFoundException

### `apps/sylphie/src/gateways/`

#### audio.gateway.ts
*service* — NestJS WebSocket gateway for continuous audio streaming from client, STT integration, and real-time transcription handling.

AudioGateway is a NestJS WebSocket service (@WebSocketGateway at /ws/audio) that manages client connections, receives binary audio chunks (Opus/WebM), and coordinates between the sensory pipeline and Deepgram STT service. On connection, it creates a Deepgram session and registers a message handler; on disconnect it closes the session and cleans up state. handleMessage() parses JSON config, forwards all audio chunks to both tickSampler.updateAudio() and stt.sendAudio(), tracking bytes and chunk counts. handleTranscript() accumulates interim/final results, buffers complete utterances, and sends both live transcriptions and complete utterance notifications back to the client. handleDeepgramClose() implements reconnection logic: code 1000 (clean close) triggers a restart_audio message to the frontend and creates a new session; other codes (e.g. 1006) log error and skip reconnect. Deepgram's VAD handles silence detection; WebM container integrity is preserved by never skipping chunks.

- **Exports:** `AudioGateway`
- **Key constants:** `vlog=verboseFor('Voice')`, `nextClientId=1`, `audio_config_heuristic_size_threshold=256`, `reconnect_heuristic_code=1000`, `log_interval_chunks=20`
- **Deps:** `@nestjs/websockets`, `@nestjs/common`, `ws`, `@sylphie/decision-making`, `@sylphie/shared`, `../services/stt.service`
- **Gotchas:** nextClientId is module-level mutable state (non-reset); no mutex on clients map (potential race if multiple concurrent connections); transcript buffering accumulates text in interimBuffer without max-length guard; Deepgram reconnect on code 1000 implies frontend must send fresh WebM header on restart_audio reception (contract enforced by comment, not validation)

#### conversation.gateway.ts
*service* — WebSocket transport layer bridging frontend to Communication subsystem; manages client connections, routes turn deliveries, broadcasts system state.

ConversationGateway is a NestJS WebSocketGateway (path /ws/conversation) implementing OnGatewayConnection/OnGatewayDisconnect/OnModuleInit. Core data structures: clients (Set<WebSocket>), clientUsers (Map WebSocket→ConnectedUser), clientSocketIds (Map WebSocket→string), socketIdToClient (reverse lookup), userIdToClient (userId→current socket for reconnect tolerance). Key methods: handleConnection (JWT extraction, socket ID assignment, stale connection eviction, OKG person node creation), handleDisconnect (reverse map cleanup), handleMessage (WS4 Ticket 2: intakeTurn enqueue, trigger-phrase dispatch, per-socket thinking_indicator), handleGuardianFeedback (routes feedback to CommunicationService), routeDelivery (WS4 Ticket 4: 3-way decision table: TARGETED by socketId, USER_FALLBACK by userId, BROADCAST for self-tick/ambient). onModuleInit subscribes to communication.delivery$ for response broadcast and communication.queuePositionUpdates$ for per-socket queue positions. Key constants: socketIdCounter (monotonic), DeliveryRoute type union. ConnectedUser interface carries userId, username, isGuardian (WS4 Ticket 3: from JWT claim, default false; Ticket 7: tokenless→guest/false). Notable: extractUserFromConnection parses JWT from query param, defaults to null (anonymous); thinking_indicator is scoped to originator socket only (ticket 6); per-turn speaker context bound at intakeTurn, not global mutable setActivePerson.

- **Exports:** `ConversationGateway`
- **Key constants:** `socketIdCounter=0`, `vlog=verboseFor('Communication')`, `WS_PATH='/ws/conversation'`
- **Deps:** `@nestjs/websockets`, `@nestjs/common`, `@nestjs/config`, `ws`, `jsonwebtoken`, `@sylphie/shared`, `../services/communication.service`, `../services/person-model.service`
- **Gotchas:** Ticket 4: theater prohibition enforced (dropped deliveries logged, never faked); stale reconnections managed via clientSocketIds→socketId assignment; setActivePerson deliberately NOT called at connection or in handleMessage (WS4 Ticket 4 part B.4 addressed); thinking_indicator split: started scoped to originator, cleared broadcast (ticket 6).

#### graph.gateway.ts
*service* — WebSocket gateway for real-time graph (knowledge) updates to connected clients

GraphGateway is a NestJS WebSocket gateway listening on /ws/graph. It manages a Set of connected WebSocket clients, sends initial knowledge graph snapshots via WkgQueryService.getSnapshot() when clients connect, handles client disconnections cleanly, and provides a broadcast() method to push delta updates to all connected clients. On connection failure, sends empty snapshot fallback. Uses verboseFor logging for Knowledge domain.

- **Exports:** `GraphGateway`
- **Key constants:** `path=/ws/graph`
- **Deps:** `WkgQueryService`
- **Gotchas:** Error handling sends empty snapshot fallback on getSnapshot() failure - may mask underlying service issues. No client disconnect cleanup beyond removal from Set. No message type validation on broadcast payloads. No connection/reconnection exponential backoff or heartbeat mechanism visible.

#### perception.gateway.ts
*service* — WebSocket gateway receiving JPEG frames from perception sidecar; orchestrates detection, face tracking, scene events, VLM captions, and VWM integration

PerceptionGateway is a NestJS WebSocket gateway (@WebSocketGateway path /ws/perception) that handles inbound JPEG frames at max 15 FPS. On connection, it receives JPEG data, calls the external perception service (/perception/detect) to get object/face detections and tracked objects, maps Python DTOs to TypeScript types (FaceDetection, TrackedObjectDTO, SceneSummary), feeds results into TickSamplerService (video detections, faces, scene). For faces, it fire-and-forget to FaceSnapshotService if an active person is set. For scene events, it runs SceneEventDetectorService, updates VisualWorkingMemoryService (VWM), and triggers VLM captions on scene changes or 30s periodic; caption requests are throttled (5s cooldown, one in-flight guard). Final enriched payload (detections, scene_events, vwm_entities, vlm_caption) is sent back to browser. Frame-drop logic (frame-time throttle + processing flag) prevents back-to-back frame stacking.

- **Exports:** `PerceptionGateway`
- **Key constants:** `MAX_FPS=15`, `MIN_FRAME_INTERVAL_MS=67`, `CAPTION_COOLDOWN_MS=5000`, `CAPTION_PERIODIC_MS=30000`, `PERCEPTION_HOST=http://localhost:8430`
- **Deps:** `@nestjs/websockets`, `@nestjs/common`, `@nestjs/config`, `ws`, `@sylphie/decision-making`, `@sylphie/shared`, `PersonModelService`, `FaceSnapshotService`, `SceneEventDetectorService`, `VisualWorkingMemoryService`
- **Gotchas:** Error handling is silent (catch blocks empty or no-op); perception service fetch failure or VLM unavailability are swallowed. VWM update is inline, not fire-and-forget. WS5 T0.5/T0.8 notes mark frame-processing observability (isProcessing() method) and synthetic discriminator on tracked objects as gate-specific concerns. requestVlmCaption is fire-and-forget but holds captionInFlight flag to prevent stacking—if VLM is slow, periodic captions may be delayed past CAPTION_PERIODIC_MS.

#### supervisor.gateway.ts
*service* — WebSocket gateway that registers supervisor clients with the broadcast service for verdict distribution.

Thin NestJS WebSocket gateway exposing /ws/supervisor endpoint. Implements OnGatewayConnection and OnGatewayDisconnect lifecycle hooks. Single class SupervisorGateway delegates all state management to SupervisorBroadcastService: addClient() on connection, removeClient() on disconnect. Logs connection events via NestJS Logger. Mirrors TelemetryGateway pattern to keep services decoupled from gateway layer; broadcasting logic lives in service, not gateway.

- **Exports:** `SupervisorGateway`
- **Key constants:** `path=/ws/supervisor`
- **Deps:** `@nestjs/websockets`, `@nestjs/common`, `ws`, `../services/supervisor-broadcast.service`
- **Gotchas:** Dead code risk: WebSocket client parameter type-checked but no message handlers or heartbeat defined; consider if connection lifecycle alone is sufficient or if disconnect detection should be explicit

#### telemetry.gateway.ts
*component* — WebSocket gateway that registers telemetry clients for broadcasting.

Thin NestJS WebSocket gateway exposing /ws/telemetry endpoint. Implements OnGatewayConnection and OnGatewayDisconnect lifecycle hooks. Delegates actual broadcast logic to TelemetryBroadcastService: handleConnection calls broadcast.addClient(client) with log, handleDisconnect calls broadcast.removeClient(client). Uses private Logger for client connection/disconnection events. No subscription handling, message routing, or state mgmt in gateway itself — pure registration layer.

- **Exports:** `TelemetryGateway`
- **Key constants:** `path=/ws/telemetry`
- **Deps:** `@nestjs/websockets:WebSocketGateway,OnGatewayConnection,OnGatewayDisconnect`, `@nestjs/common:Logger`, `ws:WebSocket`, `../services/telemetry-broadcast.service:TelemetryBroadcastService`

#### webrtc.gateway.ts
*service* — WebRTC signaling gateway for peer connection negotiation.

Single NestJS WebSocket gateway class (WebRTCGateway) that listens on /ws/webrtc path. Implements OnGatewayConnection interface to accept WebSocket clients. Logs incoming connections via injected Logger. Currently a stub: accepts connections but does not process ICE candidates, SDP offers/answers, or other signaling messages—those are deferred for implementation. No state management, forwarding logic, or message routing implemented.

- **Exports:** `WebRTCGateway`
- **Key constants:** `path=/ws/webrtc`
- **Deps:** `@nestjs/websockets`, `@nestjs/common`, `ws`
- **Gotchas:** Entire signaling pipeline is a stub: no handleMessage, no ICE/SDP processing, no error handling, no message forwarding to peers. Ready to accept connections but cannot complete WebRTC negotiation. No tests present in file.

### `apps/sylphie/src/guards/`

#### auth.guard.ts
*service* — NestJS route guard that validates JWT bearer tokens and populates request.user

Exports AuthGuard (CanActivate implementation) and JwtPayload interface. AuthGuard.canActivate() extracts Bearer token from Authorization header, verifies it against JWT_SECRET from ConfigService, and attaches decoded payload (sub, username, isGuardian) to request.user. Throws UnauthorizedException if header missing, malformed, or token verification fails. No DB/network/FS side effects; purely cryptographic validation.

- **Exports:** `AuthGuard`, `JwtPayload`
- **Key constants:** `Bearer token prefix = 'Bearer '`, `Token slice offset = 7`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `jsonwebtoken`
- **Gotchas:** No token expiration check explicit in verify() call — relies on jwt.verify() to reject exp claim if present; no refresh token logic; secret loaded synchronously from config (potential blocking if ConfigService is slow); error catch clause catches all exceptions uniformly without logging or distinction

### `apps/sylphie/src/services/`

#### cognition-bridge.service.ts
*service* — Lightweight observer for tensor/LLM agreement logging and caching sidecar results.

CognitionBridgeService is a NestJS injectable service with OnModuleInit/OnModuleDestroy lifecycle hooks. It subscribes to DecisionMakingService.response$ stream and logs tensor metadata (tensorTopCategory, tensorConsensus, bootstrapMode, arbitrationType) when present in completed CycleResponse objects. The service stores only the most recent sidecar result for inspection by other services (getLastResult() method stub mentioned but not implemented in this file). Tensor inference now happens in DecisionMakingService.processInput() via ITensorInferenceService; this bridge does not call the sidecar directly — it only logs and caches. Uses verboseFor() logging utility for diagnostics.

- **Exports:** `CognitionBridgeService`
- **Key constants:** `vlog=verboseFor('CognitionBridge')`
- **Deps:** `@nestjs/common`, `rxjs`, `@sylphie/shared`, `@sylphie/decision-making`
- **Gotchas:** getLastResult() method mentioned in JSDoc (line 10) but not actually implemented in class; subscription cleanup via unsubscribe() on destroy; no error handling in cycle response subscription.

#### cognition-gateway.service.ts
*service* — HTTP gateway to TensorFlow cognition sidecar; routes cognitive cycles, training samples, and metrics

CognitionGatewayService is a NestJS service (OnModuleInit) that acts as an HTTP client to the cognition sidecar running at COGNITION_HOST (default http://localhost:8431). It exports four response interfaces (CognitionCycleResult, CognitionHealthResult, CognitionMetrics, BootstrapStatusResult) and one training sample interface (CognitionTrainingSample). Core methods: runCycle() POSTs to /cognition/cycle with fused embedding, drive vector/deltas, and optional panel context, with 50ms timeout for inference; submitTrainingSample() fire-and-forget POSTs to /cognition/train with 5s timeout; fetchBootstrapStatus(), fetchMetrics(), fetchModelState(), fetchHealth() all GET endpoints with 5s timeouts. Private checkHealth() runs at module init and on error recovery (30s reschedule). Graceful degradation: all methods return null if unavailable, and service tracks availability state (available flag) and bootstrap mode ('shadow' default).

- **Exports:** `CognitionGatewayService`, `CognitionCycleResult`, `CognitionHealthResult`, `CognitionMetrics`, `BootstrapStatusResult`, `CognitionTrainingSample`
- **Key constants:** `COGNITION_HOST=http://localhost:8431`, `CYCLE_TIMEOUT_MS=50`, `TRAIN_TIMEOUT_MS=5000`, `HEALTH_TIMEOUT_MS=5000`, `HEALTH_RECHECK_MS=30000`, `DEFAULT_BOOTSTRAP_MODE=shadow`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared (SensoryFrame, DriveSnapshot, DRIVE_INDEX_ORDER, verboseFor)`
- **Gotchas:** runCycle() has a tight 50ms timeout (line 174) that may timeout on slow sidecar responses; submitTrainingSample() is truly fire-and-forget with no error propagation (deliberate by design); episodicContext defaults to 768-element zero array if not provided; no retries on transient failures, only single 30s reschedule on checkHealth failure; TimeoutError handled silently (vlog only, line 193-194)

#### communication.service.ts
*service* — Core of Communication subsystem: input parsing, response delivery, event logging, and reinforcement loop closure.

CommunicationService (NestJS @Injectable) bridges Decision Making and ConversationGateway. Main responsibilities: (1) parseInput() classifies input, extracts entities, detects guardian feedback, writes fast facts to OKG/WKG bypassing 60s cycle; (2) intakeTurn() receives inbound chat, mints turnId, updates tickSampler slots (history, person_model, speaker_name), records arrival for 30s self-tick guard, enqueues via decisionMaking; (3) handleCycleResponse() receives response from Decision Making, validates theater prohibition, synthesizes TTS audio (with voice latent space cache lookup first), emits DeliveryPayload on delivery$ subject, adds to conversation history, stores pending turn for guardian feedback correlation, reports basic outcome; (4) reportGuardianFeedback() maps turnId to CycleResponse and calls reportOutcome() with 2x/3x weight per CANON Standard 5; (5) handleTriggerPhrase()/handleWhoAmI() short-circuits normal pipeline for "Who am I?"; (6) Guardian teaching detection writes GUARDIAN_TEACHING_DETECTED event to TimescaleDB and reports drive pressure; (7) logEvent() fire-and-forget TimescaleDB logging. Constants: MAX_PENDING_TURNS=50. Key algorithms: voice cache valence computation (satisfaction+curiosity*0.5 vs anxiety+sadness+guilt*0.5), sanitizeResponseText() strips LLM formatting artifacts, detectTriggerPhrase/classifyInput/extractEntities/detectGuardianFeedback pure helpers.

- **Exports:** `CommunicationService`
- **Key constants:** `MAX_PENDING_TURNS=50`
- **Deps:** `@nestjs/common`, `rxjs`, `@sylphie/shared`, `@sylphie/decision-making`, `@sylphie/drive-engine`, `TtsService`, `ConversationHistoryService`, `PersonModelService`, `VoiceLatentSpaceService`, `Neo4jService`, `TimescaleService`, `TickSamplerService`, `CycleGuardService`
- **Gotchas:** Theater prohibition check is flag-only, TODO for real sentiment analysis vs drive state (line 928); writeFastFacts WS4 T5 deleted speaker→WKG dual-write (line 779-784) — self-reported facts OKG-only now; voice latent space dependency requires ElevenLabs bootstrap; pending turns map unbounded-growth mitigated via 50-entry LRU (lines 688-696); voice cache hit=Type1, TTS miss=Type2, both stored for future; originator threaded through delivery for targeted socket routing (WS4 T6); grounding provenance nodes forwarded WS3 T5 (lines 641-650); all TimescaleDB writes fire-and-forget, no error propagation to response pipeline.

#### conversation-history.service.ts
*service* — Token-aware rolling buffer of conversation turns for the current session, feeding into sensory pipeline.

ConversationHistoryService maintains an ordered list of user/assistant message pairs with dual eviction strategy: hard cap on message count (MAX_MESSAGES=50) and soft cap on estimated tokens (MAX_BUFFER_TOKENS=4096). Core methods: addUserMessage() / addAssistantMessage() (adds to history, marks preceding unanswered user messages as answered when assistant responds), getHistory() (returns readonly LlmMessage[]), getSplitHistory() (separates answered exchanges into compact summary and unanswered user messages into pending), getAnnotatedHistory() (adds [answered]/[unanswered] tags to user messages). OnModuleInit creates TimescaleDB schema if available and restores last 50 messages from previous session. OnModuleDestroy saves current buffer to database. Emits one-line JSON transcript events to stdout per turn (evt: conversation_turn or conversation_session_start) for log drains. Token estimation: CHARS_PER_TOKEN=3.5, MESSAGE_OVERHEAD_TOKENS=4.

- **Exports:** `ConversationHistoryService`
- **Key constants:** `MAX_MESSAGES=50`, `MAX_BUFFER_TOKENS=4096`, `CHARS_PER_TOKEN=3.5`, `MESSAGE_OVERHEAD_TOKENS=4`
- **Deps:** `@nestjs/common (Injectable, Logger, Optional, Inject, OnModuleInit, OnModuleDestroy)`, `@sylphie/shared (TimescaleService, verboseFor, LlmMessage)`, `node:crypto (randomUUID)`
- **Gotchas:** Internal ConversationEntry uses answered boolean field to track which user messages have received assistant responses. getSplitHistory() implements implicit answered-state propagation: marks all preceding unanswered user messages as answered when assistant message is added. trim() may underflow estimatedTokens due to rounding in token estimation (guard at line 316-318). Transcript events emitted always-on (not gated on VERBOSE) for Railway log stream.

#### drive-publisher.service.ts
*service* — Bridges drive engine state to frontend via WebSocket, publishing executor_cycle telemetry at 2Hz

DrivePublisherService is an NestJS @Injectable service that subscribes to the Drive Engine's driveState$ Observable (IDriveStateReader), throttles emissions to 2Hz (500ms), and broadcasts executor_cycle telemetry messages via TelemetryBroadcastService. The publishSnapshot() method transforms backend camelCase pressure vectors (systemHealth, moralValence, integrity, etc.) into frontend snake_case keys using DRIVE_KEY_MAP (e.g., systemHealth → system_health), computes drive deltas identically, identifies the dominant drive as the highest positive pressure value, and constructs a telemetry payload with pressureVector, driveVelocity, dominantDrive, timestamp, sequence_number, and stub fields (state=idle, action=null, action_confidence=null, drive_entropy=0, guardian_present=null, dynamic_threshold=0). Side effect: publishes WebSocket broadcasts to all connected frontend clients. Service implements OnModuleInit (subscribes on startup, logs at INFO level) and OnModuleDestroy (unsubscribes cleanly).

- **Exports:** `DrivePublisherService`
- **Key constants:** `throttleMs=500`, `publishHz=2`, `DRIVE_KEY_MAP={systemHealth:system_health,moralValence:moral_valence,integrity:integrity,cognitiveAwareness:cognitive_awareness,guilt:guilt,curiosity:curiosity,boredom:boredom,anxiety:anxiety,satisfaction:satisfaction,sadness:sadness,focus:focus,social:social}`
- **Deps:** `@nestjs/common`, `rxjs`, `rxjs/operators`, `@sylphie/drive-engine`, `@sylphie/shared`, `./telemetry-broadcast.service`
- **Gotchas:** Telemetry payload includes stub/placeholder fields (action=null, action_confidence=null, category=null, guardian_present=null, dynamic_threshold=0, drive_entropy=0, state=idle) that hardcode neutral/unimplemented values; timestamp handling accepts both Date objects and ISO strings with runtime coercion; no error recovery if TelemetryBroadcastService fails—error-path is silent on broadcast.

#### face-snapshot.service.ts
*service* — Opportunistic face snapshot collection + latent embedding space for person identification

FaceSnapshotService automatically captures face crops from camera frames at multiple head angles (frontal, left, right, up, down) when a user lacks sufficient snapshots. Stores crops + metadata in OKG (Neo4j), embeddings in TimescaleDB (pgvector hot layer), and maintains in-memory centroid embeddings per person for instant face identification. Core classes: FaceSnapshotService (main injectable service). Public methods: processFaceFrame() rate-limited frame handler that crops faces, embeddings via Python perception service, and persists; identifyFace(embedding) returns personId if cosine similarity >= 0.55 threshold; matchFace() for VWM deduplication. Private: classifyAngle() uses MediaPipe landmarks (nose, cheeks, eyes) to compute yaw/pitch and categorize head pose via dead zones; updateCentroid() incremental mean averaging; hydrate() loads all embeddings from TimescaleDB on startup to rebuild centroids. Key thresholds: CROP_INTERVAL_MS=1500, MIN_CONFIDENCE=0.65, IDENTIFICATION_THRESHOLD=0.55, FACE_EMBEDDING_DIM=1280. DB side-effects: Creates FaceSnapshot nodes in OKG with HAS_FACE_SNAPSHOT relationships; inserts into face_embeddings table (pgvector) with person_id, angle, embedding, timestamps; creates indices and constraints.

- **Exports:** `FaceSnapshotService`
- **Key constants:** `CROP_INTERVAL_MS=1500`, `MIN_CONFIDENCE=0.65`, `IDENTIFICATION_THRESHOLD=0.55`, `FACE_EMBEDDING_DIM=1280`, `FRAME_W=640`, `FRAME_H=480`, `ALL_ANGLES=['frontal','left','right','up','down']`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared (Neo4jService, TimescaleService, FaceDetection, verboseFor)`, `crypto`
- **Gotchas:** Hot-layer centroid initialization (empty array checks); parseEmbedding() handles pgvector text format fragile to format changes; Python /perception/crop-face endpoint dependency; no explicit cleanup of stale centroids or collection state; face_crop_b64 stored full in OKG (no deduplication); landmarks indexing hardcoded (1, 234, 454, 159, 386) — any change to MediaPipe version breaks angle classification.

#### guardian-rules.service.ts
*service* — Dashboard API for managing proposed and active drive rules; enforces guardian-only approval/rejection (CANON Standard 6).

GuardianRulesService provides NestJS @Injectable() service with three core methods: getProposedRules(status='pending') fetches pending proposed rules from proposed_drive_rules table sorted by created_at DESC; getActiveRules() fetches enabled rules from drive_rules table; approveRule(proposedRuleId) copies a pending proposed rule into drive_rules (enabled=true) within a transaction and marks it approved; rejectRule(proposedRuleId) marks a pending rule rejected without creating active rule. Uses PostgreSQL pool injection. Enforces CANON immutable standard 6: only guardians via dashboard can promote rules, system never auto-calls approve/reject. All queries use parameterized statements; transactions use client.query(BEGIN/COMMIT/ROLLBACK) for atomicity.

- **Exports:** `GuardianRulesService`, `ProposedRuleDto`, `ActiveRuleDto`
- **Deps:** `@nestjs/common (Injectable, Logger, NotFoundException, Inject)`, `pg (Pool)`, `@sylphie/shared (POSTGRES_RUNTIME_POOL)`
- **Gotchas:** approveRule transaction assumes proposed_drive_rules and drive_rules schema exists; no schema validation or constraints enforced in code; rejectRule and approveRule throw NotFoundException if rule not found or not pending status—caller must handle; created_at/updated_at converted to ISO strings but no timezone awareness documented.

#### learning-pressure-bridge.service.ts
*service* — Bridges drive-engine CognitiveAwareness pressure to learning cycle scheduling

LearningPressureBridgeService (Injectable, NestJS) wires pressure-driven cycle triggers into the learning pipeline. Subscribes to driveReader.driveState$ (DriveStateReader token) on module init; extracts CognitiveAwareness pressure from each DriveSnapshot. When pressure exceeds PRESSURE_CYCLE_THRESHOLD (0.70), calls learningService.forceCycle() after a MIN_CYCLE_INTERVAL_MS (30000ms) debounce to prevent back-to-back triggers. Unsubscribes cleanly on module destroy. Logs pressure events via verboseFor(), errors via Logger. Implements CANON §Subsystem 3 (Learning) directive that drive pressure (not timer-only) is the primary cycle trigger.

- **Exports:** `LearningPressureBridgeService`
- **Key constants:** `PRESSURE_CYCLE_THRESHOLD=0.70`, `MIN_CYCLE_INTERVAL_MS=30000`, `vlog=verboseFor('Learning')`
- **Deps:** `@nestjs/common`, `rxjs`, `@sylphie/drive-engine`, `@sylphie/shared`, `@sylphie/learning`
- **Gotchas:** No stubs; error handling via catch on forceCycle() promise; lastForcedCycleAt is in-memory debounce (not persisted); threshold and interval are hardcoded constants without runtime config.

#### person-model.service.ts
*service* — Other Evaluation (person modeling) — stores and retrieves facts about conversation partners in the Other Knowledge Graph (OKG) to enable personalized responses calibrated to each speaker.

PersonModelService (NestJS @Injectable) manages facts about persons stored in Neo4j OTHER instance, keyed by User.id (PostgreSQL UUIDs). Core classes: PersonFact (key, value, confidence, source, learnedAt), ExtractedFact (extracted from conversation text, targets 'speaker' or 'sylphie'). Key methods: ensurePersonNode() creates/updates Person anchor nodes; writeFact() persists extracted facts with guardian-aware confidence tiering via deriveOkgFactTier (0.90 for guardian self-reports, 0.60 for non-guardian); loadFacts() reads from OKG with in-memory caching; clearFactsForPerson(userId) and clearFactsForAllPersons() wipe attribute nodes for gate hermeticity (P0 provability). getPersonModel(userId) returns PersonModelSummary for LLM context. extractFactsFromText(text) is a pure function parsing speaker and sylphie facts via regex: "My name is X", "I am X", "I work at/in X", "I live in X", "I like/love X", "I'm N years old", plus "Your name", "You are/like/live" for sylphie self-facts. IDENTITY_STOPWORDS prevents junk identity captures ("glad", "tired", etc.). WS4 Ticket 4 notes: getPersonModelForTurn(userId) bypasses global activePersonId slot during active inbound turns, fixing active-person thrash. WS4 Ticket 5 fixes guardian-aware tiering: confidence and provenance_type derived from (source, isGuardian) pair, never identity-string matching, per CANON Standards 3 and 5. Ticket 7 legacy tokenless-guardian compatibility: omitted isGuardian defaults to true.

- **Exports:** `PersonModelService`, `PersonFact`, `ExtractedFact`, `extractFactsFromText`
- **Key constants:** `IDENTITY_STOPWORDS=["not","very","so","just","also","really","doing","going","feeling","glad","happy","sorry","pleased","thankful","grateful","welcome","called","sure","afraid","fine","good","great","okay","ok","well","tired","bored","curious","excited","interested","ready","here","back","done","trying","looking","thinking","wondering","asking","still","always","now"]`, `DANGLING_TAIL_REGEX=/\b(?:to\|of\|in\|at\|for\|on\|with\|that\|it\|the\|and\|or\|but)$/`
- **Deps:** `@nestjs/common (Injectable, Logger, Optional, Inject, OnModuleInit)`, `@sylphie/shared (Neo4jService, Neo4jInstanceName, PersonModelSummary, verboseFor, deriveOkgFactTier)`
- **Gotchas:** Fact value extraction limits to 50 chars (substring(0,50)). loadFacts() returns default confidence 0.5 and source 'inferred' on NULL from DB. Guardian confidence hardcoded 0.90, non-guardian self-reports 0.60 (CANON Standard 3 ceiling). Neo4j session error handling logs warnings but does not throw; relies on caller null-checks. activePersonId global slot now deprecated during active inbound turns (WS4 T4); retained only for idle/self-tick fallback. clearFactsForAllPersons() enumerates no persons but wipes entire OKG corpus for gate hermeticity (P0'). extractFactsFromText() regex patterns do not handle contractions in all cases (e.g., "I'm" uses optional (?:'m\| am) but some edge cases may slip). No rate-limiting or fact deduplication logic beyond simple cache-and-update.

#### pkg-query.service.ts
*service* — REST wrapper around PKG Neo4j graph for frontend codebase explorer queries

@Injectable NestJS service PkgQueryService wrapping the PKG Neo4j instance to expose codebase intelligence as queryable methods. Exports five response DTOs: SearchResult (function/type search hits with line numbers, export status, match lines), FunctionDetail (enriched function metadata including args, return type, JSDoc, related types, callers, callees, recent git changes), DataFlowNode (graph node with name, filePath, type, hopDistance), DataFlowResult (upstream and downstream data-flow from a start node). Core methods: search(pattern, fileFilter?, limit=20) with fallback logic (CodeBlock bodyText then Function/Type name+bodyText, case-insensitive regex), getFunctionDetail(name, filePath?) executing six coordinated Cypher queries (function metadata, types used, callers, callees, changes), getDataFlow(name, direction='both', depth=3) computing upstream (who calls/uses) and downstream (what is called/used) paths up to maxDepth=6 hops using multi-label traversals (CALLS, USES_TYPE, INJECTS, EXTENDS, IMPLEMENTS). Query limits: 20 for search, 50 for data-flow, 20 for related entities. Utility helpers: asString/asNumber type coercion, toRegex case-insensitive escape-and-wrap.

- **Exports:** `PkgQueryService`, `SearchResult`, `FunctionDetail`, `DataFlowNode`, `DataFlowResult`
- **Key constants:** `maxResults = min(max(1, limit), 50)`, `maxDepth = min(max(1, depth), 6)`, `matchLines slice to 5`
- **Deps:** `@nestjs/common`, `@sylphie/shared (Neo4jService, Neo4jInstanceName)`
- **Gotchas:** no error re-throw, warnings logged silently; no validation of Neo4j node structure; query limits hardcoded (20-50); upstream/downstream traversal uses 6-label OR chain in single path match (potential performance issue on large graphs); regex pattern applied client-side on bodyText split by line (not Cypher-native)

#### scene-event-detector.service.ts
*service* — Detects semantic scene events by diffing tracked-object state across frames; translates object lifecycle transitions into meaningful events (arrivals, disappearances, occlusion) for the cognitive pipeline.

Exports SceneEventDetectorService (NestJS @Injectable). Main method detectEvents(currentObjects, faces, summary) compares current frame tracked objects against previous frame state and generates SceneEvent arrays. Detects: appearance/disappearance of objects, person-specific arrival/left events with optional face identification via FaceSnapshotService.identifyFace(), and face occlusion (person bbox persists but face bbox disappears). Uses bboxOverlaps helper for AABB intersection testing [x_min, y_min, x_max, y_max]. Maintains internal state: previousObjects Map<trackId, TrackedObjectDTO> and previousFaceTracks Set<trackId>. Returns SceneSnapshot with timestamp, frameSequence, objects array, events array, and summary. Logs event details via NestJS Logger and vlog (Perception channel) for debug visibility.

- **Exports:** `SceneEventDetectorService`, `bboxOverlaps`
- **Key constants:** `vlog = verboseFor('Perception')`
- **Deps:** `@nestjs/common`, `@sylphie/shared (TrackedObjectDTO, SceneEvent, SceneSnapshot, SceneSummary, FaceDetection, SceneEventType, verboseFor)`, `./face-snapshot.service`
- **Gotchas:** Face identification triggers FACE_IDENTIFIED event only when personId is newly assigned; re-identification on existing tracks with missing personId occurs in a separate loop after appearance/disappearance detection. Overlapping events (both FACE_IDENTIFIED and PERSON_ARRIVED) can be emitted for the same track in one frame. No explicit handling for label changes on same trackId across frames.

#### sensory-logger.service.ts
*service* — Temporary sensory pipeline sampler that logs fused multimodal frames to telemetry on a fixed interval.

SensoryLoggerService is a NestJS Injectable that runs a periodic sampling loop via setInterval on module init. It calls tickSampler.sample() every 2000ms to fetch the current sensory frame, extracts active_modalities and fused_embedding, checks if the embedding has non-zero values, and broadcasts a structured log to TelemetryBroadcastService for frontend visibility. Also logs verbose details (modalities, embedding dimension, signal presence) to the Perception vlog. This is explicitly marked as a temporary stand-in until the executor engine wires its own tick loop and can call tickSampler directly. Error handling wraps the sample() call in try/catch and warns on failure.

- **Exports:** `SensoryLoggerService`
- **Key constants:** `SAMPLE_INTERVAL_MS=2000`
- **Deps:** `@nestjs/common`, `@sylphie/decision-making::TickSamplerService`, `@sylphie/shared::verboseFor`, `./telemetry-broadcast.service::TelemetryBroadcastService`
- **Gotchas:** STUB: Service is explicitly documented as temporary and will be removed once executor engine tick loop is wired. setInterval is never cleared (no onModuleDestroy); leak risk if service is destroyed and recreated. vlog output tied to hardcoded 'Perception' channel.

#### stt.service.ts
*service* — Manages Deepgram live transcription WebSocket sessions, buffers audio chunks during connection, and emits transcript results.

Exports SttService (Injectable NestJS service) with lifecycle hooks onModuleInit/onModuleDestroy. Core methods: createSession() opens a Deepgram nova-2 WS connection with audio buffering and 5s KeepAlive timers; sendAudio() forwards chunks to Deepgram or buffers if still connecting; closeSession() gracefully closes and cleans up timers. Exports TranscriptResult interface with text, isFinal, confidence, speechFinal fields. Deepgram model=nova-2, language=en-US, utterance_end_ms=1200, endpointing=300ms, vad_events=true. WebM header must arrive before audio to avoid data loss. Keeps internal Maps for sessions, keepAliveTimers, and pendingBuffers keyed by clientId. Verbose logging via verboseFor('Voice').

- **Exports:** `SttService`, `TranscriptResult`
- **Key constants:** `model=nova-2`, `language=en-US`, `smart_format=true`, `interim_results=true`, `utterance_end_ms=1200`, `vad_events=true`, `endpointing=300`, `keepAlive interval=5000ms`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `ws`, `@sylphie/shared`
- **Gotchas:** Buffer-before-open race: audio chunks arriving during WS CONNECTING state are buffered; must include WebM header in first chunks or transcription will fail. Non-JSON messages from Deepgram are silently ignored. apiKey config at voice.deepgramApiKey is only read once at module init; no hot-reload. Close-on-error does not invoke onClose callback.

#### supervisor-broadcast.service.ts
*service* — Manages supervisor WebSocket clients and broadcasts verdict messages to connected frontend clients.

SupervisorBroadcastService is a NestJS @Injectable service that maintains a Set of WebSocket clients, subscribes to supervisorService.verdict$ at module init, and broadcasts verdicts to all connected clients. The service exposes three public methods: onModuleInit() sets up the verdict$ subscription to emit verdicts as {type: 'supervisor_verdict', verdict}, addClient() registers a client to the Set, and removeClient() deregisters one. The broadcast(message) method serializes the message to JSON, iterates over all clients checking readyState === WebSocket.OPEN, sends the payload to open clients, and logs the count sent via verboseFor('Supervisor'). No DB/network side effects beyond WS sends. Extracted from SupervisorGateway to allow verdict subscription to begin before any clients connect, mirroring TelemetryBroadcastService.

- **Exports:** `SupervisorBroadcastService`
- **Key constants:** `verboseFor('Supervisor')`
- **Deps:** `@nestjs/common`, `ws`, `@sylphie/supervisor`, `@sylphie/shared`
- **Gotchas:** No error handling on JSON.stringify or client.send() — malformed messages could silently fail; no reconnection/heartbeat logic; assumes clients are cleaned up when WS closes (relies on gateway to call removeClient).

#### telemetry-broadcast.service.ts
*service* — NestJS Injectable that broadcasts telemetry messages to all connected WebSocket clients without coupling services to the presentation layer.

TelemetryBroadcastService is a dependency-injectable singleton that decouples telemetry publishing from the gateway layer. It maintains a Set of active WebSocket clients (addClient, removeClient). sendLog() creates a structured payload with type "system_log", text, ISO timestamp, and level (info|warn|error), then sends to all OPEN clients. broadcast() accepts any message, JSON-stringifies it, sends to all OPEN clients, and vlog-reports the message type and recipient count (except executor_cycle messages, which fire at 2Hz and would flood logs). Only sends to clients with readyState === WebSocket.OPEN.

- **Exports:** `TelemetryBroadcastService`
- **Key constants:** `verboseFor logger prefix = "Telemetry"`
- **Deps:** `@nestjs/common`, `ws`, `@sylphie/shared`
- **Gotchas:** No error handling for client.send() failures; no client reconnection logic; executor_cycle messages suppressed from vlog to prevent log flood (hardcoded type check)

#### tensor-inference-adapter.service.ts
*service* — Adapter bridging DecisionMaking to Python cognition sidecar, managing bootstrap lifecycle and drive history buffering

TensorInferenceAdapter implements ITensorInferenceService. Core methods: infer() calls CognitionGatewayService.runCycle() with real SensoryFrame + DriveSnapshot, buffers drive vectors into 10-frame rolling history (120 floats), periodically refreshes bootstrap mode/graduated categories every 100 cycles, returns TensorInferenceResult with action bias, urgency, novelty, convergence scores, and shouldUseTensor() predicate. submitTraining() serializes training samples with fused embeddings, drive vectors, deltas, and arbitration metadata to gateway. recordDriveVector() maintains DRIVE_HISTORY_SIZE=10 circular buffer; getDriveHistoryFlattened() pads with zeros to 10x12 matrix, flattened to 120 floats for panel context. refreshBootstrapStatus() fetches and logs mode transitions from gateway; categories stored lowercase in Set.

- **Exports:** `TensorInferenceAdapter`
- **Key constants:** `BOOTSTRAP_REFRESH_INTERVAL=100`, `DRIVE_HISTORY_SIZE=10`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `@sylphie/decision-making`, `./cognition-gateway.service`
- **Gotchas:** Drive history padding assumes exactly 12 floats per frame (DRIVE_INDEX_ORDER length); refreshBootstrapStatus errors silently caught in infer() line 80; episodicContext optional but type suggests embeddings (not validated); panelContext merging overwrites caller fields except driveHistory which is always from adapter buffer

#### tts.service.ts
*service* — Text-to-Speech synthesis via ElevenLabs REST API, returns MP3 audio buffer for client playback.

Injectable NestJS service TtsService implements OnModuleInit. Loads ElevenLabs API credentials (apiKey, voiceId, modelId) from ConfigService on module init with sensible defaults (voiceId=21m00Tcm4TlvDq8ikWAM, modelId=eleven_turbo_v2_5). Exposes available getter to check API key presence. Main synthesize(text) method trims input, returns null if unavailable/empty, posts to ElevenLabs v1/text-to-speech/{voiceId}/stream with stability=0.5 and similarity_boost=0.75, catches errors and HTTP failures, returns Buffer of MP3 audio or null on any error.

- **Exports:** `TtsService`
- **Key constants:** `defaultVoiceId=21m00Tcm4TlvDq8ikWAM`, `defaultModelId=eleven_turbo_v2_5`, `stability=0.5`, `similarity_boost=0.75`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared`
- **Gotchas:** Silent null returns on all failures (unavailable, empty text, API error, network error, response error) — caller cannot distinguish why; no retry logic; ElevenLabs endpoint hardcoded to https://api.elevenlabs.io/v1; voice settings stability/boost not configurable.

#### visual-working-memory.service.ts
*service* — Stabilizes noisy tracker output into a coherent scene model, cross-references with WKG for identity resolution, creates nodes for unrecognized objects.

VisualWorkingMemoryService bridges raw perception to cognitive awareness. Maintains in-memory stable scene entities with hysteresis-driven lifecycle (entering/present/leaving/gone states) using 30-frame rolling presence windows; tracks embeddings for cosine matching (0.75 threshold) against known objects. Updates WKG nodes for discovered entities and creates placeholder nodes for undiscovered objects. Implements face identification via FaceSnapshotService and person discovery flow. Key constants: PRESENCE_WINDOW_SIZE=30, ENTER_RATIO=0.70, EXIT_RATIO=0.20, LEAVING_TIMEOUT_MS=2000, OBJECT_MATCH_THRESHOLD=0.75, MAX_SCENE_ENTITIES=100. updateScene() processes frame-by-frame tracker input, manages entity creation/reassociation/state-transition, prunes old 'gone' entities. resolveEntityIdentity() queries TimescaleDB (visual_object_embeddings with ivfflat index) for known objects or creates new nodes. resetForGate() (WS5 T0.7) clears in-memory state, deletes synthetic WORLD nodes, truncates embeddings table for hermetic gate isolation. Writes to Neo4j WORLD/OTHER instances and TimescaleDB; reads entity embeddings from tracker DTOs.

- **Exports:** `VisualWorkingMemoryService`
- **Key constants:** `PRESENCE_WINDOW_SIZE=30`, `ENTER_RATIO=0.70`, `EXIT_RATIO=0.20`, `GONE_RATIO=0.0`, `LEAVING_TIMEOUT_MS=2000`, `OBJECT_MATCH_THRESHOLD=0.75`, `REASSOCIATION_IOU_THRESHOLD=0.3`, `MAX_SCENE_ENTITIES=100`
- **Deps:** `@nestjs/common`, `crypto.randomUUID`, `@sylphie/shared (Neo4jService, TimescaleService, SceneSnapshot, TrackedObjectDTO, verboseFor)`, `FaceSnapshotService`, `PersonModelService`
- **Gotchas:** WS5 T0.8: synthetic field carried from detection DTO to discriminate gate-injected frames (synthetic=true marks VisualObject nodes for perception-reset deletion without affecting SENSOR provenance); resolveEntityIdentity is fire-and-forget on state transition (async without await); ivfflat index creation deferred until sufficient data exists; face matching falls back to placeholder node creation for new faces; no explicit stub inventory but extensive error-catching on DB operations

#### voice-latent-space.service.ts
*service* — TTS bootstrap & cache architecture: three-layer (hot/warm/cold) voice pattern caching to replace ElevenLabs calls with cached audio over time.

VoiceLatentSpaceService (Injectable, OnModuleInit) implements three-layer caching: Hot layer (in-memory Map<textHash, HotVoiceEntry>) for microsecond text-hash lookups; Warm layer (TimescaleDB voice_patterns table) for persistence across reboots; Cold layer (object storage, future). lookup(text, valence) retrieves cached audio if text hash matches and emotional valence within VALENCE_TOLERANCE (0.3 delta). store(text, audioBase64, audioFormat, valence) captures TTS output to both layers, evicts LRU if hotLayer exceeds MAX_HOT_ENTRIES (500). ensureSchema() creates voice_patterns table with indexes on text_hash and usage_count/last_used_at. hydrate() loads top MAX_HOT_ENTRIES patterns from warm layer on init, ordered by usage. clear() truncates both layers. VoicePattern, VoiceCacheResult, HotVoiceEntry are the data models.

- **Exports:** `VoiceLatentSpaceService`, `VoicePattern`, `VoiceCacheResult`
- **Key constants:** `MAX_HOT_ENTRIES=500`, `VALENCE_TOLERANCE=0.3`
- **Deps:** `@nestjs/common`, `crypto`, `@sylphie/shared (TimescaleService, EMBEDDING_DIM, verboseFor)`
- **Gotchas:** hotLayer uses LRU eviction by usageCount (not timestamp); warm layer write is fire-and-forget (catch swallows errors); durationMs not tracked in hot layer (returns 0); updateUsage ignores errors silently; hydration limited to MAX_HOT_ENTRIES cold-start capacity; no pgvector mentioned despite wiki comment about it; audio_data stored as base64 TEXT in DB, no blob storage yet.

#### websocket-logger.service.ts
*service* — NestJS logger that outputs to console, WebSocket broadcast, and persistent log file simultaneously

WebSocketLoggerService extends ConsoleLogger and implements a three-channel logging pipeline: (1) ConsoleLogger.log/debug/warn/error for terminal output, (2) TelemetryBroadcastService.sendLog() for frontend WebSocket delivery of info/warn/error (debug excluded), (3) fs.WriteStream appending to logs/sylphie.log with ISO timestamps and level-padded formatting. Constructor creates logs/ directory at process.cwd() and opens append-mode WriteStream. setTelemetryBroadcast() injects the broadcast service after DI bootstrap. Each level (log, warn, error) forwards; debug only appends to file, omitting WebSocket broadcast. appendFile() writes ISO-8601 timestamp, left-padded 5-char level, optional context in brackets, then message.

- **Exports:** `WebSocketLoggerService`
- **Key constants:** `logDir=path.resolve(process.cwd(), 'logs')`, `logFile='sylphie.log'`, `WriteStream flags='a'`
- **Deps:** `@nestjs/common.ConsoleLogger`, `./telemetry-broadcast.service.TelemetryBroadcastService`, `fs`, `path`
- **Gotchas:** No error handling on fs.createWriteStream or WriteStream.write — could silently drop logs if disk is full or stream errors. setTelemetryBroadcast() relies on manual post-DI injection; if never called, telemetry is undefined and silent. debug() does not forward to WebSocket, only to console and file (intentional design but worth noting). No log rotation or size management on sylphie.log.

#### wkg-bootstrap.service.ts
*service* — Seeds the World Knowledge Graph with bootstrap nodes on startup and handles full/partial system resets.

Exports WkgBootstrapService (NestJS @Injectable), which runs on module init and manages three reset scenarios: bootstrap() seeds 1 CoBeing anchor node + 12 Drive nodes to Neo4j WORLD via MERGE (idempotent); bootstrapSelfKg() creates identical nodes in SELF graph with HAS_FACT edges to 3 identity Attribute nodes. resetWorldOnly() wipes WORLD graph only, resets has_learned=false on INPUT_RECEIVED/INPUT_PARSED events in TimescaleDB for reprocessing, truncates reflected_sessions and synthesized_insight_pairs, re-bootstraps. resetAndBootstrap() performs full system reset: clears all three Neo4j graphs (WORLD/SELF/OTHER), truncates 5 TimescaleDB tables (learned_patterns, voice_patterns, sensory_ticks, events, reflected_sessions), clears PostgreSQL proposed_drive_rules, resets Drive Engine in-memory state via outcomeReporter.resetDriveState(), clears latent space hot layer, voice cache, conversation history, person model, tick sampler, and episodic memory ring buffer. All nodes created with provenance_type INFERENCE or SYSTEM_BOOTSTRAP, confidence 1.0, created_at timestamp.

- **Exports:** `WkgBootstrapService`
- **Key constants:** `DRIVE_LABELS (Record<DriveName, string> with 12 entries: SystemHealth, MoralValence, Integrity, CognitiveAwareness, Guilt, Curiosity, Boredom, Anxiety, Satisfaction, Sadness, Focus, Social)`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `pg`, `@sylphie/shared`, `@sylphie/drive-engine`, `@sylphie/decision-making`, `./voice-latent-space.service`, `./conversation-history.service`, `./person-model.service`
- **Gotchas:** Non-fatal error handling in onModuleInit (swallows errors, logs deferred); resetWorldOnly() assumes old events exist for reprocessing but gracefully handles missing tables; resetAndBootstrap() creates PostgreSQL connection pool with hardcoded defaults (host=localhost, port=5434, database=sylphie_system, user=postgres, password=postgres) from config.get() — these may be insecure or env-dependent; reset methods do not verify that downstream services (latent spaces, episodic memory, etc.) actually cleared successfully; DRIVE_INDEX_ORDER and CORE_DRIVES imported but their membership is not visible in this file.

#### wkg-query.service.ts
*service* — Neo4j query service for knowledge graphs (WKG, OKG, SKG, PKG) — provides snapshots, pagination, full-text search, and neighborhood traversal for the frontend explorer dashboard.

WkgQueryService is a NestJS injectable service managing read-access to four Neo4j knowledge graphs: WORLD (public facts), OTHER (person models), SELF (Sylphie self-model), and PKG (codebase structure). On module init, it creates indexes and constraints for ActionProcedure, Entity, CoBeing, Drive, Insight, Conversation nodes plus a full-text label index spanning all node types. Key methods: getSnapshot/getOkgSnapshot/getSkgSnapshot fetch full 5000-node/10000-edge snapshots; getPkgSnapshot adds in-memory 60s TTL cache and excludes CodeBlock nodes + heavy properties (bodyText, args); getCount/getNodePage/getEdgePage support paginated frontend loading; searchNodes performs Lucene full-text prefix search on node labels; getNeighborhood fetches N-hop ego-graphs (capped 500 nodes/3 hops). Record mappers handle Neo4j driver type conversions (Integer→number, Date objects) and partition node/edge properties into promoted top-level fields vs generic properties bag using NODE_META_KEYS/EDGE_META_KEYS/SNAPSHOT_STRIP_KEYS sets. Label migration runs once to backfill :Entity labels on unlabeled legacy nodes. Error handling is non-fatal for index creation failures (queries still work, slower).

- **Exports:** `WkgQueryService`, `GraphNodeDto`, `GraphEdgeDto`, `GraphSnapshotDto`, `SearchNodeResult`, `NeighborhoodDto`
- **Key constants:** `PKG_CACHE_TTL_MS=60000`, `NODE_META_KEYS=[node_id,node_type,label,schema_level,provenance_type,confidence,created_at,updated_at]`, `EDGE_META_KEYS=[edge_id,label,confidence,created_at]`, `SNAPSHOT_STRIP_KEYS=[bodyText,args,properties]`
- **Deps:** `@nestjs/common`, `@sylphie/shared::Neo4jService`, `@sylphie/shared::Neo4jInstanceName`
- **Gotchas:** PKG snapshot cache invalidation is manual (call invalidatePkgCache after code sync); pagination queries open separate sessions to avoid implicit transaction conflicts; node_id can fallback to Neo4j elementId if property missing; edges may reference nodes by elementId when node_id property absent; full-text search has Lucene special-char escaping; no explicit rate limiting or auth checks (assumes trust chain from API layer); LABEL_MIGRATION_CYPHER runs on every module init but idempotent via WHERE size(labels(n))=0 check

## Risks / stubs / TODOs

- `apps/sylphie/src/app.module.ts` — Neo4jModule.PKG instance is optional and only instantiated if neo4j.pkg.uri is configured in .env; comment on line 143-155 explicitly documents this conditional logic. CognitionModule uses @Global() decorator which is a NestJS exception to normal module scoping — required to avoid circular dependency between app-level and packages/ layer. Comment on line 63-68 explains the rationale.
- `apps/sylphie/src/controllers/auth.controller.ts` — No refresh token mechanism; 7-day fixed expiration only. No rate-limiting on register/login endpoints. Approved flag is user.approved but not exposed in tokens. isGuardian flag defaults to false in response when undefined. No explicit logout endpoint.
- `apps/sylphie/src/controllers/cognition.controller.ts` — No error handling beyond section-level nullification—network timeouts/sidecar unavailability silently null out individual sections rather than failing the entire response. Missing health/bootstrap/metrics/modelState data is normalized to null rather than thrown. Logger declared but never used.
- `apps/sylphie/src/controllers/debug.controller.ts` — Both endpoints are stubs — cameraStatus always reports camera inactive regardless of actual state; cameraStream unconditionally throws 404; no real camera service integration present
- `apps/sylphie/src/controllers/drives.controller.ts` — Stub: Drive mutation routing through guardian-feedback events is open design decision (stub-inventory §3.3); currently returns 501 instead of executing. Timestamp coercion from Date\|string suggests client variability. Drive process death leaves tickNumber frozen — liveness must check recency or risk false-positive health signal.
- `apps/sylphie/src/controllers/graph.controller.ts` — No validation of nodeId/instance name format beyond empty-check; resolveInstance() abstraction not shown (implementation in WkgQueryService); search and neighborhood endpoints declared before :instance/* wildcard to avoid route collision (noted in comment); no error handling for WkgQueryService failures; Logger instantiated but not actively used in endpoint handlers
- `apps/sylphie/src/controllers/llm.controller.ts` — Theater Prohibition mandate: routes must only toggle LLM availability, never alter drive state/metrics/scoring. Dual lesioning defense: socket severing AND this flag together ensure graceful degradation.
- `apps/sylphie/src/controllers/metrics.controller.ts` — C3 write-recency guard (lines 532-542): control + treatment seeded with identical created_at/updated_at; reinforceFactNode() never touches updated_at to isolate divergence to reinforcement only (verified assertion in gate). Decay uses coalesce(last_retrieval_at, updated_at, created_at) so control decays from shared old updated_at while treatment uses fresh last_retrieval_at. Orphan-prune confound neutralized via shared FIXTURE_ANCHOR edge (zero asymmetry). Behavioral diversity (line 1289) is structural proxy only — full action type diversity requires payload category field not currently in schema. Guardian response rate (line 1369) matches COMMUNICATION subsystem event types; window is last 24 hours with 30-second response threshold. Observatory queries return empty arrays (not zeroed objects) when no sessions exist, per chart renderer expectation. Interoceptive accuracy (line 1416-1417) uses cognitive-awareness drive from pressure vector; cold-start (tickNumber===0) returns accuracy=0 to signal pre-connection. Node-exists defaults to WORLD instance (line 830) and uses node_id for WORLD vs attr_id for OKG (line 837-839).
- `apps/sylphie/src/controllers/rules.controller.ts` — No input validation decorators (e.g., @IsString, @IsUUID) on route parameters or query params; status filter on proposed rules is untyped.
- `apps/sylphie/src/controllers/skills.controller.ts` — Both endpoints require explicit { "confirm": true } in POST body; no default confirmation mechanism; assumes WkgBootstrapService methods are safe and complete; no rate-limiting or audit trail visible at controller level; reset-world returns literal string names in preserved array (may diverge from actual service behavior if not kept in sync)
- `apps/sylphie/src/controllers/supervisor.controller.ts` — limit query param coerced with parseInt(limit,10)\|\|50 (silently defaults on NaN); no explicit error handling on malformed SamplingPolicy or SupervisorIntervention bodies; controller assumes ISupervisorService is always injected and callable without null checks
- `apps/sylphie/src/controllers/voice.controller.ts` — transcribe() endpoint is a stub returning hardcoded empty response (confidence: 0, latencyMs: 0, text: ''); comment explicitly flags legacy path and redirects real-time streaming to /ws/audio; getAudio() always throws NotFoundException
- `apps/sylphie/src/gateways/audio.gateway.ts` — nextClientId is module-level mutable state (non-reset); no mutex on clients map (potential race if multiple concurrent connections); transcript buffering accumulates text in interimBuffer without max-length guard; Deepgram reconnect on code 1000 implies frontend must send fresh WebM header on restart_audio reception (contract enforced by comment, not validation)
- `apps/sylphie/src/gateways/conversation.gateway.ts` — Ticket 4: theater prohibition enforced (dropped deliveries logged, never faked); stale reconnections managed via clientSocketIds→socketId assignment; setActivePerson deliberately NOT called at connection or in handleMessage (WS4 Ticket 4 part B.4 addressed); thinking_indicator split: started scoped to originator, cleared broadcast (ticket 6).
- `apps/sylphie/src/gateways/graph.gateway.ts` — Error handling sends empty snapshot fallback on getSnapshot() failure - may mask underlying service issues. No client disconnect cleanup beyond removal from Set. No message type validation on broadcast payloads. No connection/reconnection exponential backoff or heartbeat mechanism visible.
- `apps/sylphie/src/gateways/perception.gateway.ts` — Error handling is silent (catch blocks empty or no-op); perception service fetch failure or VLM unavailability are swallowed. VWM update is inline, not fire-and-forget. WS5 T0.5/T0.8 notes mark frame-processing observability (isProcessing() method) and synthetic discriminator on tracked objects as gate-specific concerns. requestVlmCaption is fire-and-forget but holds captionInFlight flag to prevent stacking—if VLM is slow, periodic captions may be delayed past CAPTION_PERIODIC_MS.
- `apps/sylphie/src/gateways/supervisor.gateway.ts` — Dead code risk: WebSocket client parameter type-checked but no message handlers or heartbeat defined; consider if connection lifecycle alone is sufficient or if disconnect detection should be explicit
- `apps/sylphie/src/gateways/webrtc.gateway.ts` — Entire signaling pipeline is a stub: no handleMessage, no ICE/SDP processing, no error handling, no message forwarding to peers. Ready to accept connections but cannot complete WebRTC negotiation. No tests present in file.
- `apps/sylphie/src/guards/auth.guard.ts` — No token expiration check explicit in verify() call — relies on jwt.verify() to reject exp claim if present; no refresh token logic; secret loaded synchronously from config (potential blocking if ConfigService is slow); error catch clause catches all exceptions uniformly without logging or distinction
- `apps/sylphie/src/main.ts` — VERBOSE reconfiguration executed synchronously after dotenv but bootstrap is async—timing is implicit. Logger integration to broadcast service assumes TelemetryBroadcastService is singleton and available in DI container.
- `apps/sylphie/src/services/cognition-bridge.service.ts` — getLastResult() method mentioned in JSDoc (line 10) but not actually implemented in class; subscription cleanup via unsubscribe() on destroy; no error handling in cycle response subscription.
- `apps/sylphie/src/services/cognition-gateway.service.ts` — runCycle() has a tight 50ms timeout (line 174) that may timeout on slow sidecar responses; submitTrainingSample() is truly fire-and-forget with no error propagation (deliberate by design); episodicContext defaults to 768-element zero array if not provided; no retries on transient failures, only single 30s reschedule on checkHealth failure; TimeoutError handled silently (vlog only, line 193-194)
- `apps/sylphie/src/services/communication.service.ts` — Theater prohibition check is flag-only, TODO for real sentiment analysis vs drive state (line 928); writeFastFacts WS4 T5 deleted speaker→WKG dual-write (line 779-784) — self-reported facts OKG-only now; voice latent space dependency requires ElevenLabs bootstrap; pending turns map unbounded-growth mitigated via 50-entry LRU (lines 688-696); voice cache hit=Type1, TTS miss=Type2, both stored for future; originator threaded through delivery for targeted socket routing (WS4 T6); grounding provenance nodes forwarded WS3 T5 (lines 641-650); all TimescaleDB writes fire-and-forget, no error propagation to response pipeline.
- `apps/sylphie/src/services/conversation-history.service.ts` — Internal ConversationEntry uses answered boolean field to track which user messages have received assistant responses. getSplitHistory() implements implicit answered-state propagation: marks all preceding unanswered user messages as answered when assistant message is added. trim() may underflow estimatedTokens due to rounding in token estimation (guard at line 316-318). Transcript events emitted always-on (not gated on VERBOSE) for Railway log stream.
- `apps/sylphie/src/services/drive-publisher.service.ts` — Telemetry payload includes stub/placeholder fields (action=null, action_confidence=null, category=null, guardian_present=null, dynamic_threshold=0, drive_entropy=0, state=idle) that hardcode neutral/unimplemented values; timestamp handling accepts both Date objects and ISO strings with runtime coercion; no error recovery if TelemetryBroadcastService fails—error-path is silent on broadcast.
- `apps/sylphie/src/services/face-snapshot.service.ts` — Hot-layer centroid initialization (empty array checks); parseEmbedding() handles pgvector text format fragile to format changes; Python /perception/crop-face endpoint dependency; no explicit cleanup of stale centroids or collection state; face_crop_b64 stored full in OKG (no deduplication); landmarks indexing hardcoded (1, 234, 454, 159, 386) — any change to MediaPipe version breaks angle classification.
- `apps/sylphie/src/services/guardian-rules.service.ts` — approveRule transaction assumes proposed_drive_rules and drive_rules schema exists; no schema validation or constraints enforced in code; rejectRule and approveRule throw NotFoundException if rule not found or not pending status—caller must handle; created_at/updated_at converted to ISO strings but no timezone awareness documented.
- `apps/sylphie/src/services/learning-pressure-bridge.service.ts` — No stubs; error handling via catch on forceCycle() promise; lastForcedCycleAt is in-memory debounce (not persisted); threshold and interval are hardcoded constants without runtime config.
- `apps/sylphie/src/services/person-model.service.ts` — Fact value extraction limits to 50 chars (substring(0,50)). loadFacts() returns default confidence 0.5 and source 'inferred' on NULL from DB. Guardian confidence hardcoded 0.90, non-guardian self-reports 0.60 (CANON Standard 3 ceiling). Neo4j session error handling logs warnings but does not throw; relies on caller null-checks. activePersonId global slot now deprecated during active inbound turns (WS4 T4); retained only for idle/self-tick fallback. clearFactsForAllPersons() enumerates no persons but wipes entire OKG corpus for gate hermeticity (P0'). extractFactsFromText() regex patterns do not handle contractions in all cases (e.g., "I'm" uses optional (?:'m\| am) but some edge cases may slip). No rate-limiting or fact deduplication logic beyond simple cache-and-update.
- `apps/sylphie/src/services/pkg-query.service.ts` — no error re-throw, warnings logged silently; no validation of Neo4j node structure; query limits hardcoded (20-50); upstream/downstream traversal uses 6-label OR chain in single path match (potential performance issue on large graphs); regex pattern applied client-side on bodyText split by line (not Cypher-native)
- `apps/sylphie/src/services/scene-event-detector.service.ts` — Face identification triggers FACE_IDENTIFIED event only when personId is newly assigned; re-identification on existing tracks with missing personId occurs in a separate loop after appearance/disappearance detection. Overlapping events (both FACE_IDENTIFIED and PERSON_ARRIVED) can be emitted for the same track in one frame. No explicit handling for label changes on same trackId across frames.
- `apps/sylphie/src/services/sensory-logger.service.ts` — STUB: Service is explicitly documented as temporary and will be removed once executor engine tick loop is wired. setInterval is never cleared (no onModuleDestroy); leak risk if service is destroyed and recreated. vlog output tied to hardcoded 'Perception' channel.
- `apps/sylphie/src/services/stt.service.ts` — Buffer-before-open race: audio chunks arriving during WS CONNECTING state are buffered; must include WebM header in first chunks or transcription will fail. Non-JSON messages from Deepgram are silently ignored. apiKey config at voice.deepgramApiKey is only read once at module init; no hot-reload. Close-on-error does not invoke onClose callback.
- `apps/sylphie/src/services/supervisor-broadcast.service.ts` — No error handling on JSON.stringify or client.send() — malformed messages could silently fail; no reconnection/heartbeat logic; assumes clients are cleaned up when WS closes (relies on gateway to call removeClient).
- `apps/sylphie/src/services/telemetry-broadcast.service.ts` — No error handling for client.send() failures; no client reconnection logic; executor_cycle messages suppressed from vlog to prevent log flood (hardcoded type check)
- `apps/sylphie/src/services/tensor-inference-adapter.service.ts` — Drive history padding assumes exactly 12 floats per frame (DRIVE_INDEX_ORDER length); refreshBootstrapStatus errors silently caught in infer() line 80; episodicContext optional but type suggests embeddings (not validated); panelContext merging overwrites caller fields except driveHistory which is always from adapter buffer
- `apps/sylphie/src/services/tts.service.ts` — Silent null returns on all failures (unavailable, empty text, API error, network error, response error) — caller cannot distinguish why; no retry logic; ElevenLabs endpoint hardcoded to https://api.elevenlabs.io/v1; voice settings stability/boost not configurable.
- `apps/sylphie/src/services/visual-working-memory.service.ts` — WS5 T0.8: synthetic field carried from detection DTO to discriminate gate-injected frames (synthetic=true marks VisualObject nodes for perception-reset deletion without affecting SENSOR provenance); resolveEntityIdentity is fire-and-forget on state transition (async without await); ivfflat index creation deferred until sufficient data exists; face matching falls back to placeholder node creation for new faces; no explicit stub inventory but extensive error-catching on DB operations
- `apps/sylphie/src/services/voice-latent-space.service.ts` — hotLayer uses LRU eviction by usageCount (not timestamp); warm layer write is fire-and-forget (catch swallows errors); durationMs not tracked in hot layer (returns 0); updateUsage ignores errors silently; hydration limited to MAX_HOT_ENTRIES cold-start capacity; no pgvector mentioned despite wiki comment about it; audio_data stored as base64 TEXT in DB, no blob storage yet.
- `apps/sylphie/src/services/websocket-logger.service.ts` — No error handling on fs.createWriteStream or WriteStream.write — could silently drop logs if disk is full or stream errors. setTelemetryBroadcast() relies on manual post-DI injection; if never called, telemetry is undefined and silent. debug() does not forward to WebSocket, only to console and file (intentional design but worth noting). No log rotation or size management on sylphie.log.
- `apps/sylphie/src/services/wkg-bootstrap.service.ts` — Non-fatal error handling in onModuleInit (swallows errors, logs deferred); resetWorldOnly() assumes old events exist for reprocessing but gracefully handles missing tables; resetAndBootstrap() creates PostgreSQL connection pool with hardcoded defaults (host=localhost, port=5434, database=sylphie_system, user=postgres, password=postgres) from config.get() — these may be insecure or env-dependent; reset methods do not verify that downstream services (latent spaces, episodic memory, etc.) actually cleared successfully; DRIVE_INDEX_ORDER and CORE_DRIVES imported but their membership is not visible in this file.
- `apps/sylphie/src/services/wkg-query.service.ts` — PKG snapshot cache invalidation is manual (call invalidatePkgCache after code sync); pagination queries open separate sessions to avoid implicit transaction conflicts; node_id can fallback to Neo4j elementId if property missing; edges may reference nodes by elementId when node_id property absent; full-text search has Lucene special-char escaping; no explicit rate limiting or auth checks (assumes trust chain from API layer); LABEL_MIGRATION_CYPHER runs on every module init but idempotent via WHERE size(labels(n))=0 check

## Change log
- 2026-06-13 — Initial auto-generated map (44 files read in full).
