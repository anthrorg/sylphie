# Phase 1 Roadmap: Sylphie v2 Lift-and-Shift

## Context

Sylphie v2 is a ground-up reimplementation of the "co-being" AI companion as a NestJS monolith with five subsystems, five databases, and formal dual-process cognition. The v2 repo currently contains only CANON, CLAUDE.md, agent profiles, and an MCP tooling package -- no application code exists. This roadmap sequences the work from infrastructure to integration, mapping v1 code that can be lifted and identifying what's entirely new.

**Implementation strategy:** Epic 0 builds the full skeleton -- NestJS scaffold, all shared types, all module stubs, all interfaces, all DI tokens -- so that `npx tsc --noEmit` passes across the entire project before any implementation begins. Every subsequent epic fills in real implementations behind already-compiling interfaces.

---

## v1 -> v2: What Changes

| Aspect | v1 (co-being) | v2 (sylphie) |
|--------|---------------|--------------|
| Drive isolation | ESP32 hardware (UDP/HTTP) | Separate Node.js process (IPC) |
| Architecture | Multi-package monorepo | Single NestJS monolith with modules |
| TimescaleDB | Observatory-only (CB never reads) | Central event backbone (all 5 subsystems read/write) |
| Self/Other KGs | None | Grafeo (embedded, isolated) |
| Planning | No formal subsystem | Subsystem 5: opportunity -> procedure pipeline |
| Episodic Memory | None | First-class component in Decision Making |
| Type 1/Type 2 | Implicit confidence-based | Formal arbitration with graduation (>0.80, MAE<0.10) |
| Prediction | Post-action only | Pre-action Inner Monologue generating multiple predictions |
| Immutable Standards | Design goals | Code-level enforcement |

---

## Epic Dependency Graph

```
E0 (Scaffold + Full Skeleton)
 |
 +----------+----------+
 |          |          |
 v          v          v
E1 (DBs)  E2 (Events) E3 (Knowledge)
 |          |          |
 +----------+----------+
 |                     |
 v                     v
E4 (Drive Engine)     E4 (Drive Engine)
 |
 +----------+----------+
 |          |          |
 v          v          v
E5 (DM)   E6 (Comm)  E6 (Comm)
 |          |
 v          v
E7 (Learn) E8 (Plan)
 |          |
 +----------+
 |
 v
E9 (Frontend API)
 |
 v
E10 (Integration)
```

---

## Epic 0: Scaffold + Full Interface Skeleton
**Complexity: L** | **Dependencies: None**

NestJS monolith scaffolding, ALL shared types, ALL module stubs with interfaces, ALL DI tokens. The entire project compiles with `npx tsc --noEmit` at the end of this epic. No implementations -- just the skeleton that everything hangs on.

### E0a: Project Scaffold
- `package.json` (NestJS 10+, neo4j-driver, pg, class-validator, RxJS, @nestjs/config)
- `tsconfig.json` (strict: true)
- `src/main.ts`, `src/app.module.ts`
- `docker-compose.yml` with Neo4j, TimescaleDB, PostgreSQL, Grafeo placeholders
- `.env.example`
- ESLint + Prettier config

### E0b: Shared Types (real implementations -- these ARE the deliverable, not stubs)
- `src/shared/types/drive.types.ts` -- DriveName enum (12 drives), PressureVector, DriveSnapshot, PressureDelta
- `src/shared/types/provenance.types.ts` -- ProvenanceSource union, PROVENANCE_BASE_CONFIDENCE map
- `src/shared/types/knowledge.types.ts` -- KnowledgeNode, KnowledgeEdge, EdgeFilter, NodeFilter
- `src/shared/types/event.types.ts` -- SylphieEvent, EventType discriminated union (30+ event types), SubsystemSource, LearnableEvent
- `src/shared/types/action.types.ts` -- ActionProcedureData, ActionCandidate, DriveCategory
- `src/shared/types/confidence.types.ts` -- ACTRParams, computeConfidence() pure function, CONFIDENCE_THRESHOLDS, DEFAULT_DECAY_RATES
- `src/shared/types/ipc.types.ts` -- DriveIPCMessage, DriveIPCMessageType, all IPC payload types
- `src/shared/config/app.config.ts` -- Validated config schema (ConfigModule)
- `src/shared/config/database.config.ts` -- DB connection configs
- `src/shared/exceptions/` -- SylphieException base, per-domain exceptions
- `src/shared/shared.module.ts` -- Global shared module
- `src/shared/index.ts` -- Barrel export

### E0c: Module Interface Stubs (empty service classes implementing full interfaces)

Each module gets: `*.module.ts`, `interfaces/*.interfaces.ts`, DI tokens, empty `@Injectable()` service classes that satisfy the interfaces with `throw new Error('Not implemented')`, and `index.ts` barrel.

**Events Module** (`src/events/`):
- `IEventService` interface: record(), query(), queryLearnableEvents(), queryEventFrequency(), markProcessed()
- `EVENTS_SERVICE` token
- `EventsService` stub implementing IEventService

**Knowledge Module** (`src/knowledge/`):
- `IWkgService` interface: upsertNode(), findNode(), upsertEdge(), queryEdges(), queryContext(), recordRetrievalAndUse()
- `ISelfKgService` interface: getCurrentModel(), updateSelfConcept()
- `IOtherKgService` interface: getPersonGraph(), queryPersonModel(), updatePersonModel()
- `IConfidenceService` interface: compute(), recordUse(), checkCeiling()
- Tokens: `WKG_SERVICE`, `SELF_KG_SERVICE`, `OTHER_KG_SERVICE`, `NEO4J_DRIVER`
- Stub service classes for each

**Drive Engine Module** (`src/drive-engine/`):
- `IDriveStateReader` interface: getCurrentState(), driveState$ Observable, getTotalPressure()
- `IActionOutcomeReporter` interface: reportOutcome(), reportMetrics()
- `IRuleProposer` interface: proposeRule()
- `IOpportunityDetector` interface: evaluatePredictions(), detectOpportunities()
- Tokens: `DRIVE_STATE_READER`, `ACTION_OUTCOME_REPORTER`, `RULE_PROPOSER`
- `DriveReaderService` stub, `ActionOutcomeReporterService` stub

**Decision Making Module** (`src/decision-making/`):
- `IDecisionMakingService` interface: processInput(), getCognitiveContext(), reportOutcome()
- `IEpisodicMemoryService` interface: encode(), getRecentEpisodes(), queryByContext()
- `IArbitrationService` interface: arbitrate()
- `IPredictionService` interface: generatePrediction(), evaluatePrediction()
- `IActionRetrieverService` interface: retrieve(), bootstrapActionTree()
- `IConfidenceUpdaterService` interface: update()
- `IExecutorEngine` interface: transition(), forceIdle(), getState()
- Tokens: `DECISION_MAKING_SERVICE`, `EPISODIC_MEMORY_SERVICE`, `ARBITRATION_SERVICE`
- Stub service classes for each

**Communication Module** (`src/communication/`):
- `ICommunicationService` interface: handleGuardianInput(), generateResponse(), initiateComment()
- `IInputParserService` interface: parse()
- `IPersonModelingService` interface: getPersonModel(), updatePersonModel()
- `ITheaterValidator` interface: validate()
- `ILlmService` interface: complete(), estimateCost()
- `ISttService` interface: transcribe()
- `ITtsService` interface: synthesize()
- Tokens: `COMMUNICATION_SERVICE`, `LLM_SERVICE`, `INPUT_PARSER_SERVICE`
- Stub service classes for each

**Learning Module** (`src/learning/`):
- `ILearningService` interface: runMaintenanceCycle(), shouldConsolidate()
- `IEntityExtractionService` interface: extract()
- `IEdgeRefinementService` interface: refine()
- `IContradictionDetector` interface: check()
- Token: `LEARNING_SERVICE`
- Stub service classes for each

**Planning Module** (`src/planning/`):
- `IPlanningService` interface: processOpportunity(), getOpportunityQueue()
- `IOpportunityResearchService` interface: research()
- `ISimulationService` interface: simulate()
- `IConstraintValidationService` interface: validate()
- `IProcedureCreationService` interface: create()
- `IPlanningRateLimiter` interface: canProceed(), getState()
- Token: `PLANNING_SERVICE`
- Stub service classes for each

**Web Module** (`src/web/`):
- Controller stubs: HealthController, DrivesController, GraphController, ConversationController, MetricsController
- Gateway stubs: TelemetryGateway, ConversationGateway, GraphGateway

### E0d: Verification
- `npx tsc --noEmit` passes with zero errors
- All modules import/export correctly (no circular dependencies)
- AppModule imports all 8 modules
- Every interface has at least one stub implementing it

### v1 sources for E0:
- `co-being/docker-compose.yml` (adapt for v2 services)
- `co-being/tsconfig.json` (adapt)
- `co-being/packages/shared/src/pressure.types.ts` -> drive.types.ts
- `co-being/packages/shared/src/instance-confidence.ts` -> confidence.types.ts
- `co-being/packages/backend/src/orchestrator/action.types.ts` -> action.types.ts
- `co-being/packages/backend/src/orchestrator/pressure-source.interface.ts` -> drive-engine interfaces
- `co-being/packages/graph/src/graph-persistence.interface.ts` -> knowledge interfaces
- Agent profiles (forge.md, cortex.md, drive.md, sentinel.md, etc.) for interface shapes

---

## Epic 1: Database Infrastructure
**Complexity: L** | **Dependencies: E0**

All 5 database connections wired, schemas created, stubs replaced with real connection providers.

**Deliverables:**
- Neo4j driver factory provider, constraint setup on module init, health check
- TimescaleDB connection (pg client), hypertable schema, compression/retention policies
- PostgreSQL system DB: `drive_rules` table (write-protected), `proposed_drive_rules`, `users`, `settings`
- Grafeo integration for Self KG and Other KG (requires technology validation first)
- Docker Compose finalized with all services, volumes, health checks
- PostgreSQL RLS: `sylphie_app` role has SELECT on `drive_rules`, INSERT on `proposed_drive_rules` only

**Key risk: Grafeo availability.** If Grafeo doesn't exist as a mature library, evaluate alternatives (memgraph, embedded LPG, multiple SQLite with graph abstractions). The real requirement is "embedded graph DB with Cypher support, completely isolated instances."

**v1 lift:** `co-being/docker-compose.yml` (Neo4j/TimescaleDB config), `co-being/packages/backend/schema/timescaledb.sql` (heavy adaptation)

---

## Epic 2: Events Module (TimescaleDB Backbone)
**Complexity: L** | **Dependencies: E0, E1**

Fill in the IEventService stub with real TimescaleDB implementation.

**Deliverables:**
- Real `EventsService` replacing the stub: record(), query(), queryLearnableEvents(), queryEventFrequency(), markProcessed()
- Event stream schema: typed events with subsystem tags, drive snapshots, correlation IDs, `has_learnable` flag, `schema_version`
- Write path: typed event emission with UTC timestamping
- Read path: temporal range queries, event type filtering, subsystem-scoped queries, frequency aggregation

**v1 lift:** Conceptual only. Clean-room implementation following sentinel.md agent profile.

---

## Epic 3: Knowledge Module (WKG + Self KG + Other KG)
**Complexity: XL** | **Dependencies: E0, E1**

Fill in knowledge service stubs with real Neo4j/Grafeo implementations.

**Deliverables:**
- Real `WkgService`: Neo4j upsertNode, findNode, upsertEdge, queryEdges with provenance enforcement, confidence ceilings, contradiction detection
- Real `SelfKgService`: Grafeo implementation for KG(Self)
- Real `OtherKgService`: Grafeo per-person models (Map keyed by personId)
- Real `ConfidenceService`: ACT-R confidence wrapping pure functions + retrieval tracking
- Provenance required on every write (enforced at service layer)
- Confidence Ceiling: no node > 0.60 without retrieval-and-use (Immutable Standard 3)

**v1 lift:**
- `co-being/packages/graph/src/neo4j-persistence.service.ts` -- Cypher queries (add provenance enforcement)
- `co-being/packages/backend/src/graph/semantic/` -- contradiction detection logic

---

## Epic 4: Drive Engine (Isolated Process)
**Complexity: XL** | **Dependencies: E0, E1, E2**

Fill in drive engine stubs. Build the separate computation process.

**Deliverables:**
- **Separate process** (`src/drive-engine/drive-process/`):
  - TypeScript port of v1 Python `SimulatedPressureEngine`
  - 12-drive computation: signals -> core drives -> complement drives -> cross-modulation -> clamping
  - 100Hz tick loop
  - Rule lookup from PostgreSQL (read-only)
  - Self-evaluation on slower timescale (reads Self KG)
  - Prediction accuracy evaluation
  - Opportunity detection from prediction failures
- **Real DriveReaderService** replacing stub:
  - IDriveStateReader: getCurrentState(), driveState$ Observable
  - IActionOutcomeReporter: reportOutcome() (fire-and-forget IPC to child)
  - IRuleProposer: proposeRule() (INSERT into proposed_drive_rules only)
- **IPC**: Node.js `child_process.fork()` with typed messages
  - Inbound: ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END
  - Outbound: DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS
- **One-way enforcement**: structural (no write methods on exported interface), process-level (separate process), database-level (PostgreSQL RLS)
- Behavioral contingencies: satisfaction habituation curve, anxiety amplification, guilt repair, social comment quality, curiosity information gain

**v1 lift:**
- `co-being/packages/drive-engine/src/drive_engine/server.py` -- Python drive computation (full TypeScript rewrite)
- `co-being/packages/backend/src/orchestrator/drive-engine-client.service.ts` -- adapt to IPC

---

## Epic 5: Decision Making (Core Cognitive Loop)
**Complexity: XL** | **Dependencies: E2, E3, E4**

Fill in decision making stubs. Heaviest v1 code reuse.

**Deliverables:**
- Executor engine state machine: IDLE -> CATEGORIZING -> PREDICTING -> ARBITRATING -> RETRIEVING -> EXECUTING -> OBSERVING -> LEARNING
- Executor loop: tick-based cycle driving the state machine
- **Episodic Memory** (NEW): temporally-contextualized experiences, attention/arousal gating, graceful degradation
- **Inner Monologue** (NEW): generate multiple predictions from episodic memory before action selection
- **Type 1/Type 2 Arbitration** (NEW): dynamic threshold modulated by drive state. Graduation at confidence > 0.80 AND MAE < 0.10 over last 10 uses. Demotion at MAE > 0.15
- Action retriever: retrieve action procedures from WKG by category and confidence
- Confidence updater: ACT-R confidence updates (reinforced/decayed/counter_indicated)
- Shrug Imperative: when nothing above threshold, signal incomprehension (Immutable Standard 4)
- Action handler registry: speak, ask_guardian, explore_graph, read_definition, reflex handlers

**v1 direct lift:**
- `co-being/packages/backend/src/orchestrator/executor-engine.service.ts` -- state machine
- `co-being/packages/backend/src/orchestrator/executor-loop.service.ts` -- tick loop
- `co-being/packages/backend/src/orchestrator/action-retriever.service.ts` -- action retrieval
- `co-being/packages/backend/src/orchestrator/confidence-updater.service.ts` -- 3-path outcome logic
- `co-being/packages/backend/src/orchestrator/handlers/*.ts` -- action handlers

**CANON spec gaps:** A.2 (Episodic Memory), A.3 (Arbitration Algorithm) are reserved.

---

## Epic 6: Communication (Input/Output + Person Modeling)
**Complexity: L** | **Dependencies: E2, E3, E4**

Can be built in parallel with E5.

**Deliverables:**
- Input parser: LLM-mediated input interpretation
- Response generator: LLM response with drive state injection for Theater Prohibition
- Theater Prohibition enforcement: directional — pressure expression (distress, need, urgency) requires drive > 0.2; relief expression (contentment, calm, fulfillment) requires drive < 0.3; both violations receive zero reinforcement (Immutable Standard 1)
- Person modeling via Other KG (Grafeo): per-person interaction model
- STT: OpenAI Whisper API; TTS: OpenAI TTS API
- Chatbox: WebSocket gateway for text chat
- LLM service: Claude API client with cost tracking
- Social comment quality: timestamp Sylphie-initiated utterances, detect guardian response within 30s
- All communication events emitted to TimescaleDB with `has_learnable=true` flag

**v1 lift:**
- `co-being/packages/conversation-engine/` -- parser structure
- `co-being/packages/backend/src/voice/` -- STT/TTS patterns
- `co-being/packages/backend/src/web/conversation.gateway.ts` -- WebSocket pattern

---

## Epic 7: Learning (Consolidation Pipeline)
**Complexity: L** | **Dependencies: E2, E3, E4, E6**

Needs communication events flowing to work.

**Deliverables:**
- Maintenance cycle orchestrator: pressure-driven (Cognitive Awareness drive), timer fallback
- Consolidation: query TimescaleDB for learnable events (max 5 per cycle)
- Entity extraction: LLM-assisted, LLM_GENERATED provenance at 0.35
- Edge refinement: LLM-assisted relationship identification
- Contradiction detection: flag conflicts as developmental catalysts
- Learning jobs (ported from v1 maintenance-engine):
  - Temporal pattern detection, procedure formation, pattern generalization, correction processing

**v1 direct lift:**
- `co-being/packages/maintenance-engine/src/services/` -- consolidation engine, metacognitive analyzer
- `co-being/packages/maintenance-engine/src/jobs/` -- all 7 jobs
- `co-being/packages/maintenance-server/src/maintenance/maintenance-pressure-loop.service.ts`

---

## Epic 8: Planning (Opportunity-to-Procedure Pipeline)
**Complexity: L** | **Dependencies: E2, E3, E4, E5**

Entirely new subsystem. No v1 equivalent.

**Deliverables:**
- Opportunity queue with priority decay
- Research service: query TimescaleDB event patterns around an opportunity
- Simulation service: model potential outcomes (CANON A.5 reserved -- start with historical pattern matching)
- Proposal service: generate plan candidates (LLM-assisted)
- Constraint validation: LLM validates plan against CANON rules
- Procedure creator: write validated plan to WKG with LLM_GENERATED provenance at 0.35
- Rate limiting: max plans per time window, cold-start dampening

**Attractor state prevention:**
- Planning Runaway: rate limiting + opportunity decay
- Prediction Pessimist: cold-start dampening

---

## Epic 9: Dashboard API and WebSocket Gateways
**Complexity: M** | **Dependencies: E2, E3, E4, E5**

HTTP/WS surface for the React frontend. Can start incrementally after E4.

**Deliverables:**
- Health check endpoint (all 5 databases)
- Drive state REST API + WebSocket real-time
- WKG query API (read-only graph visualization)
- Conversation history + chat input endpoints
- Telemetry WebSocket (drive state, action selections, predictions)
- Development metrics API (Type 1/Type 2 ratio, prediction MAE, provenance ratio, behavioral diversity)

**v1 lift:** `co-being/packages/backend/src/web/` controllers and gateways

---

## Epic 10: Integration and End-to-End Verification
**Complexity: L** | **Dependencies: All previous**

Prove the CANON's Phase 1 requirements are met.

**Must prove (per CANON):**
1. The prediction-evaluation loop produces genuine learning
2. The Type 1/Type 2 ratio shifts over time
3. The graph grows reflecting real understanding, not LLM regurgitation
4. Personality emerges from contingencies
5. The Planning subsystem creates useful procedures
6. Drive dynamics produce recognizable behavioral patterns

**Deliverables:**
- Full-loop integration: cold start -> guardian speaks -> parse -> decide -> respond -> drives update -> learning extracts -> WKG grows -> next decision has Type 1 candidate
- Lesion test framework: run without LLM, verify Type 1 behavior
- Type 1 graduation test: simulate successful repetitions -> graduation
- Drift detection baseline
- Attractor state tests: verify prevention for all 6 known states

**Verification approach:** Start app (`npm run start:dev`), use Playwright MCP at `http://localhost:3000`, check Neo4j at `http://localhost:7474`, verify via `npx tsc --noEmit`.

---

## Cross-Cutting Concerns

These are defined in E0 (interfaces) and enforced in every subsequent epic:

| Concern | Where Enforced | Implementation |
|---------|---------------|----------------|
| Provenance tagging | Knowledge module (E3) | Required field on every graph write interface -- not optional |
| Confidence dynamics (ACT-R) | Knowledge module (E3), Decision Making (E5) | Pure function in shared (E0), service wrapper in knowledge (E3), lazy computation on read |
| Theater Prohibition | Communication (E6), Drive Engine (E4) | Post-generation check in Comm, zero-reinforcement in Drive |
| Confidence Ceiling | Knowledge module (E3) | Clamp at 0.60 when count===0 in upsertNode |
| Shrug Imperative | Decision Making (E5) | When no candidate above dynamic threshold, output shrug action |
| Guardian Asymmetry | Drive Engine (E4) | 2x confirmation, 3x correction weight multipliers |
| No Self-Modification | Drive Engine (E4), PostgreSQL (E1) | RLS on drive_rules table, no write methods on exported interface |
| Event emission | Events module (E2) | Every subsystem uses IEventService.record() with typed events |
| LLM cost tracking | Communication (E6) | Shared LLM service tracks tokens, latency, feeds Type 2 cost pressure |
| Drive state injection | Communication (E6) | IDriveStateReader injected, snapshot attached to LLM context |

---

## Known Spec Gaps (CANON Appendix)

These need Jim's input before or during the relevant epic:

| Gap | Appendix | Blocks Epic | Recommended Default |
|-----|----------|-------------|---------------------|
| Episodic Memory spec | A.2 | E5 | Episodes in TimescaleDB, consolidated to WKG by Learning, degradation via TimescaleDB retention |
| Arbitration Algorithm | A.3 | E5 | Dynamic threshold from cortex.md agent profile, drive-modulated |
| Opportunity Detection criteria | A.4 | E4, E8 | Recurring failures (3+ in window) -> Opportunity; high-impact single failures -> Opportunity; else -> Potential |
| Simulation Methodology | A.5 | E8 | Historical pattern matching: "when action X was taken in context Y, outcome was Z" |
| LLM Context Assembly | A.6 | E6 | Drive snapshot + recent episodes + WKG context subgraph + person model |
| Communication Parser | A.7 | E6 | Whitespace tokenization + LLM-assisted intent classification |
| Self-Evaluation Protocol | A.8 | E4 | Slower timescale (every N ticks), reads Self KG, updates drive baselines |

---

## Recommended Implementation Order (Single Developer)

```
E0 (skeleton) -> E1 & E2 & E3 (parallel infra) -> E4 -> E5 & E6 (parallel) -> E7 -> E8 -> E9 -> E10
```

**Critical path:** E0 -> E1/E2/E3 -> E4 -> E5 -> E7 -> E10

**Estimated relative effort:**
- E0: ~15% (scaffold + ALL types + ALL interfaces + ALL stubs -- this is the big skeleton pass)
- E1+E2+E3: ~15% (databases + events + knowledge -- can largely parallelize)
- E4: ~15% (drive engine)
- E5: ~20% (decision making -- heaviest epic)
- E6+E7+E8: ~15% (communication, learning, planning)
- E9+E10: ~10% (API + integration)

**Why E0 is worth the upfront investment:**
- Every subsequent epic is "fill in real code behind compiling interfaces"
- No interface surprises mid-epic -- all contracts locked
- Circular dependency detection happens in stubs, not in running code
- Any agent can work on any epic without guessing what adjacent modules export
- `npx tsc --noEmit` validates the full project from day one
