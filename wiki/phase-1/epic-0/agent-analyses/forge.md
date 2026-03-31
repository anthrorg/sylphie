# Forge Analysis: Epic 0 -- Scaffold + Full Interface Skeleton

**Agent:** Forge (NestJS/TypeScript Systems Architect)
**Epic:** E0 -- Scaffold + Full Interface Skeleton
**Date:** 2026-03-28
**Status:** Planning only. No code produced.

---

## Preamble

Epic 0 is the skeleton pass. It is not the cheapest epic -- it is the most important one. Every subsequent epic adds real implementations behind already-compiling interfaces. If the interfaces are wrong, all downstream work inherits the error. If module dependencies create a cycle, it surfaces here in stubs before it is buried in real code. If a type dependency crosses a boundary that should not exist, the compiler flags it now.

The goal of this analysis is to define the skeleton precisely enough that an implementer can execute it mechanically without making architectural decisions. Every design choice is resolved here.

CANON traceability is noted where relevant. Decisions that have no CANON basis are flagged explicitly.

---

## 1. Complete Directory Tree

Every file that must exist at E0 completion. Files marked `(stub)` contain empty `@Injectable()` class with method bodies that `throw new NotImplementedException()`. Files marked `(types)` contain real types and interfaces -- these ARE the E0 deliverable, not placeholders. Files marked `(config)` contain real config logic.

```
sylphie/
├── src/
│   ├── main.ts                                         (config)
│   ├── app.module.ts                                   (config)
│   │
│   ├── shared/
│   │   ├── shared.module.ts                            (config)
│   │   ├── index.ts                                    (barrel)
│   │   ├── config/
│   │   │   ├── app.config.ts                           (types/config)
│   │   │   └── database.config.ts                      (types/config)
│   │   ├── exceptions/
│   │   │   ├── sylphie.exception.ts                    (types)
│   │   │   └── domain.exceptions.ts                    (types)
│   │   ├── filters/
│   │   │   └── sylphie-exception.filter.ts             (types)
│   │   └── types/
│   │       ├── drive.types.ts                          (types)
│   │       ├── provenance.types.ts                     (types)
│   │       ├── knowledge.types.ts                      (types)
│   │       ├── event.types.ts                          (types)
│   │       ├── action.types.ts                         (types)
│   │       ├── confidence.types.ts                     (types)
│   │       └── ipc.types.ts                            (types)
│   │
│   ├── events/
│   │   ├── events.module.ts                            (config)
│   │   ├── events.service.ts                           (stub)
│   │   ├── events.tokens.ts                            (types)
│   │   ├── interfaces/
│   │   │   └── events.interfaces.ts                    (types)
│   │   └── index.ts                                    (barrel)
│   │
│   ├── knowledge/
│   │   ├── knowledge.module.ts                         (config)
│   │   ├── knowledge.tokens.ts                         (types)
│   │   ├── wkg/
│   │   │   ├── wkg.service.ts                          (stub)
│   │   │   └── wkg-query.service.ts                    (stub)
│   │   ├── self-kg/
│   │   │   └── self-kg.service.ts                      (stub)
│   │   ├── other-kg/
│   │   │   └── other-kg.service.ts                     (stub)
│   │   ├── confidence/
│   │   │   └── confidence.service.ts                   (stub)
│   │   ├── interfaces/
│   │   │   └── knowledge.interfaces.ts                 (types)
│   │   └── index.ts                                    (barrel)
│   │
│   ├── drive-engine/
│   │   ├── drive-engine.module.ts                      (config)
│   │   ├── drive-engine.tokens.ts                      (types)
│   │   ├── drive-reader/
│   │   │   └── drive-reader.service.ts                 (stub)
│   │   ├── action-outcome-reporter/
│   │   │   └── action-outcome-reporter.service.ts      (stub)
│   │   ├── rule-proposer/
│   │   │   └── rule-proposer.service.ts                (stub)
│   │   ├── opportunity/
│   │   │   └── opportunity.service.ts                  (stub)
│   │   ├── interfaces/
│   │   │   └── drive-engine.interfaces.ts              (types)
│   │   └── index.ts                                    (barrel)
│   │
│   ├── decision-making/
│   │   ├── decision-making.module.ts                   (config)
│   │   ├── decision-making.tokens.ts                   (types)
│   │   ├── decision-making.service.ts                  (stub)
│   │   ├── arbitration/
│   │   │   ├── type1-arbitrator.service.ts             (stub)
│   │   │   └── type2-arbitrator.service.ts             (stub)
│   │   ├── episodic-memory/
│   │   │   └── episodic-memory.service.ts              (stub)
│   │   ├── prediction/
│   │   │   └── prediction.service.ts                   (stub)
│   │   ├── action-retriever/
│   │   │   └── action-retriever.service.ts             (stub)
│   │   ├── confidence-updater/
│   │   │   └── confidence-updater.service.ts           (stub)
│   │   ├── executor/
│   │   │   └── executor-engine.service.ts              (stub)
│   │   ├── interfaces/
│   │   │   ├── decision-making.interfaces.ts           (types)
│   │   │   └── prediction.interfaces.ts                (types)
│   │   └── index.ts                                    (barrel)
│   │
│   ├── communication/
│   │   ├── communication.module.ts                     (config)
│   │   ├── communication.tokens.ts                     (types)
│   │   ├── communication.service.ts                    (stub)
│   │   ├── input-parser/
│   │   │   └── input-parser.service.ts                 (stub)
│   │   ├── person-modeling/
│   │   │   └── person-modeling.service.ts              (stub)
│   │   ├── theater-validator/
│   │   │   └── theater-validator.service.ts            (stub)
│   │   ├── llm/
│   │   │   └── llm.service.ts                          (stub)
│   │   ├── stt/
│   │   │   └── stt.service.ts                          (stub)
│   │   ├── tts/
│   │   │   └── tts.service.ts                          (stub)
│   │   ├── interfaces/
│   │   │   └── communication.interfaces.ts             (types)
│   │   └── index.ts                                    (barrel)
│   │
│   ├── learning/
│   │   ├── learning.module.ts                          (config)
│   │   ├── learning.tokens.ts                          (types)
│   │   ├── learning.service.ts                         (stub)
│   │   ├── consolidation/
│   │   │   └── consolidation.service.ts                (stub)
│   │   ├── entity-extraction/
│   │   │   └── entity-extraction.service.ts            (stub)
│   │   ├── edge-refinement/
│   │   │   └── edge-refinement.service.ts              (stub)
│   │   ├── contradiction/
│   │   │   └── contradiction-detector.service.ts       (stub)
│   │   ├── interfaces/
│   │   │   └── learning.interfaces.ts                  (types)
│   │   └── index.ts                                    (barrel)
│   │
│   ├── planning/
│   │   ├── planning.module.ts                          (config)
│   │   ├── planning.tokens.ts                          (types)
│   │   ├── planning.service.ts                         (stub)
│   │   ├── research/
│   │   │   └── opportunity-research.service.ts         (stub)
│   │   ├── simulation/
│   │   │   └── simulation.service.ts                   (stub)
│   │   ├── proposal/
│   │   │   └── plan-proposal.service.ts                (stub)
│   │   ├── validation/
│   │   │   └── constraint-validation.service.ts        (stub)
│   │   ├── procedure/
│   │   │   └── procedure-creation.service.ts           (stub)
│   │   ├── rate-limiter/
│   │   │   └── planning-rate-limiter.service.ts        (stub)
│   │   ├── interfaces/
│   │   │   └── planning.interfaces.ts                  (types)
│   │   └── index.ts                                    (barrel)
│   │
│   └── web/
│       ├── web.module.ts                               (config)
│       ├── controllers/
│       │   ├── health.controller.ts                    (stub)
│       │   ├── drives.controller.ts                    (stub)
│       │   ├── graph.controller.ts                     (stub)
│       │   ├── conversation.controller.ts              (stub)
│       │   └── metrics.controller.ts                   (stub)
│       ├── gateways/
│       │   ├── telemetry.gateway.ts                    (stub)
│       │   ├── conversation.gateway.ts                 (stub)
│       │   └── graph.gateway.ts                        (stub)
│       ├── interfaces/
│       │   └── web.interfaces.ts                       (types)
│       └── index.ts                                    (barrel)
│
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── .eslintrc.js
├── .prettierrc
└── nest-cli.json
```

**Total file count at E0 completion:** approximately 75 TypeScript files plus 6 project-root config files.

**Notable structural decisions:**

- `drive-process/` is NOT present in `src/`. The isolated drive computation process belongs in a separate top-level directory (`drive-process/` at repo root) that is a separate compiled TypeScript project. E0 stubs the IPC boundary only. The drive process directory itself is out of scope for E0 but the IPC types must exist in `src/shared/types/ipc.types.ts` so the main process can compile against them.

- `web/` is an 8th module covering all HTTP controllers and WebSocket gateways. It is a pure output layer -- it has no logic of its own. It imports DriveEngineModule, KnowledgeModule, EventsModule, and DecisionMakingModule to read state and expose it over HTTP/WS. It does not import CommunicationModule, LearningModule, or PlanningModule directly (those subsystems emit events; the web layer reads from EventsModule).

- `confidence/` is a subdirectory under `knowledge/` rather than `shared/`. The pure `computeConfidence()` function lives in `shared/types/confidence.types.ts`. The `ConfidenceService` that wraps it with retrieval tracking and ceiling enforcement lives in `knowledge/confidence/`, because confidence enforcement is a knowledge persistence concern.

---

## 2. Module Dependency Map

### Dependency Rules (CANON-traced)

1. Subsystem modules do not import each other. Cross-subsystem communication goes through EventsModule or KnowledgeModule only. (CANON: "five subsystems communicating through two shared stores")
2. DriveEngineModule exports a read-only facade. No module imports it to write drive state. (CANON: Drive Isolation)
3. SharedModule is global -- ConfigModule, exception classes, and pure types are available everywhere without explicit import.
4. EventsModule and KnowledgeModule are the only modules imported by multiple subsystem modules.

### Import/Export Table

```
Module                  Imports                                      Exports
──────────────────────────────────────────────────────────────────────────────────────────────
SharedModule            ConfigModule (global)                        [global: ConfigService,
                                                                      exception classes,
                                                                      pure type functions]

EventsModule            SharedModule (implicit via global)           EVENTS_SERVICE token

KnowledgeModule         SharedModule (implicit)                      WKG_SERVICE token
                        EventsModule (contradiction events)          SELF_KG_SERVICE token
                                                                     OTHER_KG_SERVICE token
                                                                     CONFIDENCE_SERVICE token
                                                                     NEO4J_DRIVER token

DriveEngineModule       SharedModule (implicit)                      DRIVE_STATE_READER token
                        EventsModule (reads drive events)            ACTION_OUTCOME_REPORTER token
                                                                     RULE_PROPOSER token

DecisionMakingModule    SharedModule (implicit)                      DECISION_MAKING_SERVICE token
                        EventsModule (writes decision events)
                        KnowledgeModule (queries WKG action nodes)
                        DriveEngineModule (reads drive state)

CommunicationModule     SharedModule (implicit)                      COMMUNICATION_SERVICE token
                        EventsModule (writes communication events,   LLM_SERVICE token
                                      reads context)
                        KnowledgeModule (reads WKG for context,
                                         reads/writes Other KG)
                        DriveEngineModule (reads drive state for
                                           Theater Prohibition)

LearningModule          SharedModule (implicit)                      LEARNING_SERVICE token
                        EventsModule (reads learnable events,
                                      writes learning events)
                        KnowledgeModule (writes WKG nodes/edges)
                        DriveEngineModule (reads Cognitive Awareness
                                           drive for cycle trigger)

PlanningModule          SharedModule (implicit)                      PLANNING_SERVICE token
                        EventsModule (reads opportunity events,
                                      writes planning events)
                        KnowledgeModule (writes plan procedures
                                          to WKG)
                        DriveEngineModule (reads drive state for
                                           cold-start dampening)

WebModule               SharedModule (implicit)                      [no tokens; HTTP/WS surface]
                        EventsModule (reads metrics)
                        KnowledgeModule (graph viz read)
                        DriveEngineModule (drive state API)
                        DecisionMakingModule (cognitive loop status)

AppModule               SharedModule                                 [root; no exports]
                        EventsModule
                        KnowledgeModule
                        DriveEngineModule
                        DecisionMakingModule
                        CommunicationModule
                        LearningModule
                        PlanningModule
                        WebModule
```

### Circular Dependency Analysis

**No circular dependencies exist in this design.** The import graph is a DAG with clear layers:

```
Layer 0 (Infrastructure):  SharedModule
Layer 1 (Data stores):     EventsModule, KnowledgeModule
Layer 2 (Drive):           DriveEngineModule
Layer 3 (Subsystems):      DecisionMakingModule, CommunicationModule,
                           LearningModule, PlanningModule
Layer 4 (Output):          WebModule
Layer 5 (Root):            AppModule
```

Every import points upward toward a lower layer number. No module in Layer 3 imports another Layer 3 module.

**Potential circular dependency to watch:** KnowledgeModule imports EventsModule (to emit ContradictionEvents). EventsModule must NOT import KnowledgeModule. Verify this is clean. EventsModule has no knowledge-domain dependencies -- it is a pure TimescaleDB wrapper.

**The decision-making/communication tension:** DecisionMakingModule selects communication actions (what to say). CommunicationModule executes them (how to say it). Per the architecture, Decision Making publishes an action event to TimescaleDB; Communication subscribes. Neither module imports the other. This is the correct pattern. The interface boundary is the event stream, not a direct method call.

**The drive-engine/subsystem tension:** Subsystems (DecisionMaking, Communication, Learning, Planning) all import DriveEngineModule to read drive state. This is correct -- they read, they do not write. DriveEngineModule does NOT import any subsystem module. Drive state flows outward only.

---

## 3. DI Token Registry

All tokens are Symbol instances defined in each module's `*.tokens.ts` file. Symbol tokens prevent name collisions and enforce that the injection site and the provider are connected through the module system, not through string magic.

### SharedModule (no tokens -- global, class-based injection)

No DI tokens. `ConfigService` is injected by class reference.

### EventsModule -- `src/events/events.tokens.ts`

| Token            | Provided by    | Consumed by                                                      |
|------------------|----------------|------------------------------------------------------------------|
| `EVENTS_SERVICE` | EventsService  | KnowledgeModule, DriveEngineModule, DecisionMakingModule,        |
|                  |                | CommunicationModule, LearningModule, PlanningModule, WebModule   |

### KnowledgeModule -- `src/knowledge/knowledge.tokens.ts`

| Token                  | Provided by          | Consumed by                                                |
|------------------------|----------------------|------------------------------------------------------------|
| `NEO4J_DRIVER`         | Factory provider     | WkgService, WkgQueryService (internal to KnowledgeModule)  |
| `WKG_SERVICE`          | WkgService           | DecisionMakingModule, CommunicationModule,                 |
|                        |                      | LearningModule, PlanningModule, WebModule                  |
| `SELF_KG_SERVICE`      | SelfKgService        | DriveEngineModule (read-only), LearningModule              |
| `OTHER_KG_SERVICE`     | OtherKgService       | CommunicationModule (person modeling)                      |
| `CONFIDENCE_SERVICE`   | ConfidenceService    | DecisionMakingModule (graduation/demotion),                |
|                        |                      | LearningModule (post-upsert confidence check)              |

### DriveEngineModule -- `src/drive-engine/drive-engine.tokens.ts`

| Token                       | Provided by                    | Consumed by                                               |
|-----------------------------|--------------------------------|-----------------------------------------------------------|
| `DRIVE_STATE_READER`        | DriveReaderService             | DecisionMakingModule, CommunicationModule,                |
|                             |                                | LearningModule, PlanningModule, WebModule                 |
| `ACTION_OUTCOME_REPORTER`   | ActionOutcomeReporterService   | DecisionMakingModule (executor reports outcomes)          |
| `RULE_PROPOSER`             | RuleProposerService            | DecisionMakingModule (proposes new rules via queue)       |

**Architectural note on Drive tokens:** `DRIVE_STATE_READER` exposes only `getCurrentState(): DriveVector` and `driveState$: Observable<DriveVector>`. There is no `writeDrive`, no `modifyEvaluation`, no `setRule` method on this interface. This is the structural enforcement of Drive Isolation (CANON: Drive Isolation). Any future contributor who wants to add a write method to `IDriveStateReader` is creating a CANON violation -- they must be blocked at code review.

### DecisionMakingModule -- `src/decision-making/decision-making.tokens.ts`

| Token                      | Provided by                   | Consumed by         |
|----------------------------|-------------------------------|---------------------|
| `DECISION_MAKING_SERVICE`  | DecisionMakingService         | WebModule           |
| `EPISODIC_MEMORY_SERVICE`  | EpisodicMemoryService         | (internal only)     |
| `ARBITRATION_SERVICE`      | Type1ArbitratorService +      | (internal only)     |
|                            | Type2ArbitratorService        |                     |

**Note:** Only `DECISION_MAKING_SERVICE` is exported. Internal services are providers, not exports. WebModule needs cognitive loop status; it gets that through `DECISION_MAKING_SERVICE`. Nothing outside DecisionMakingModule needs to inject the arbitrator or episodic memory directly.

### CommunicationModule -- `src/communication/communication.tokens.ts`

| Token                     | Provided by               | Consumed by                        |
|---------------------------|---------------------------|------------------------------------|
| `COMMUNICATION_SERVICE`   | CommunicationService      | WebModule (WebSocket gateways)     |
| `LLM_SERVICE`             | LlmService                | DecisionMakingModule (Type 2 only) |

**Special case for `LLM_SERVICE`:** The Type 2 arbitrator (inside DecisionMakingModule) must call the LLM. The LLM service lives in CommunicationModule because it is a communication concern. DecisionMakingModule imports CommunicationModule ONLY to inject `LLM_SERVICE`. This is the sole exception to the "subsystems do not import each other" rule. The justification: the LLM is Type 2 deliberation infrastructure, not communication content. The alternative -- duplicating LlmService in DecisionMakingModule -- violates DRY. The risk -- DecisionMakingModule importing CommunicationModule broadly -- is mitigated by CommunicationModule exporting only `LLM_SERVICE` and `COMMUNICATION_SERVICE`. DecisionMakingModule sees only those tokens.

This must be documented explicitly in the module files with a comment explaining the exception.

### LearningModule -- `src/learning/learning.tokens.ts`

| Token              | Provided by       | Consumed by  |
|--------------------|-------------------|--------------|
| `LEARNING_SERVICE` | LearningService   | WebModule    |

### PlanningModule -- `src/planning/planning.tokens.ts`

| Token              | Provided by       | Consumed by  |
|--------------------|-------------------|--------------|
| `PLANNING_SERVICE` | PlanningService   | WebModule    |

### WebModule -- no tokens

WebModule provides HTTP controllers and WebSocket gateways but does not export services. Nothing imports from WebModule.

---

## 4. Interface Completeness Check

For each module, every interface method that must exist in the stub. Cross-module type dependencies are flagged with the module they originate from.

### 4.1 IEventsService (`src/events/interfaces/events.interfaces.ts`)

```typescript
interface IEventsService {
  /** Record a typed Sylphie event to TimescaleDB. */
  record(event: SylphieEvent): Promise<void>;
  // SylphieEvent from shared/types/event.types.ts

  /** Query events by type and time range. */
  query(filter: EventQueryFilter): Promise<SylphieEvent[]>;
  // EventQueryFilter from shared/types/event.types.ts

  /** Query events tagged has_learnable=true for Learning subsystem. */
  queryLearnableEvents(limit: number): Promise<LearnableEvent[]>;
  // LearnableEvent from shared/types/event.types.ts

  /** Count event occurrences by type within a time window (Drive Engine use). */
  queryEventFrequency(eventType: EventType, windowMs: number): Promise<number>;
  // EventType from shared/types/event.types.ts

  /** Mark an event as processed by the Learning subsystem. */
  markProcessed(eventId: string): Promise<void>;
}
```

No cross-module type dependencies. All types live in `shared/types/event.types.ts`.

### 4.2 IWkgService (`src/knowledge/interfaces/knowledge.interfaces.ts`)

```typescript
interface IWkgService {
  /** Upsert a node. Applies confidence ceiling (Immutable Standard 3). */
  upsertNode(request: KnowledgeUpsertRequest): Promise<KnowledgeNode>;

  /** Find node by label and type. Returns null if below retrieval threshold (0.50). */
  findNode(label: string, type: string): Promise<KnowledgeNode | null>;

  /** Create or update an edge. Contradiction detection required. */
  upsertEdge(
    sourceLabel: string,
    targetLabel: string,
    relationship: string,
    provenance: ProvenanceSource,
    properties?: Record<string, unknown>,
  ): Promise<KnowledgeEdge>;

  /** Query edges matching a filter. */
  queryEdges(filter: EdgeFilter): Promise<KnowledgeEdge[]>;

  /** Query a context subgraph for a given focal node. */
  queryContext(nodeLabel: string, depth: number): Promise<KnowledgeSubgraph>;

  /** Record a successful retrieval-and-use event (required for confidence ceiling). */
  recordRetrievalAndUse(nodeId: string): Promise<void>;

  /** Query action nodes for Type 1 candidates by context fingerprint. */
  queryActionCandidates(contextFingerprint: string): Promise<ActionCandidate[]>;
  // ActionCandidate from shared/types/action.types.ts
}
```

Cross-module type: `ActionCandidate` from `shared/types/action.types.ts`. This is fine -- `action.types.ts` is in shared, not in another subsystem module.

### 4.3 ISelfKgService (`src/knowledge/interfaces/knowledge.interfaces.ts`)

```typescript
interface ISelfKgService {
  /** Get Sylphie's current self-model (read-only, for Drive Engine). */
  getCurrentModel(): Promise<SelfModel>;
  // SelfModel defined in knowledge.interfaces.ts

  /** Update a self-concept. Called by Learning after consolidation. */
  updateSelfConcept(update: SelfConceptUpdate): Promise<void>;
}
```

No cross-module type dependencies.

### 4.4 IOtherKgService (`src/knowledge/interfaces/knowledge.interfaces.ts`)

```typescript
interface IOtherKgService {
  /** Get or create the person graph for a given person ID. */
  getPersonGraph(personId: string): Promise<PersonGraph>;
  // PersonGraph defined in knowledge.interfaces.ts

  /** Query a person model for a specific attribute. */
  queryPersonModel(personId: string, attribute: string): Promise<unknown>;

  /** Update the person model. Called by Communication after interaction. */
  updatePersonModel(personId: string, update: PersonModelUpdate): Promise<void>;
}
```

No cross-module type dependencies.

### 4.5 IConfidenceService (`src/knowledge/interfaces/knowledge.interfaces.ts`)

```typescript
interface IConfidenceService {
  /**
   * Compute current confidence for a node.
   * Uses ACT-R formula: min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
   */
  compute(params: ConfidenceParams): number;
  // ConfidenceParams is a pure type from knowledge.interfaces.ts,
  // backed by ACTRParams from shared/types/confidence.types.ts

  /** Record a successful use event and increment retrieval count. */
  recordUse(nodeId: string): Promise<void>;

  /**
   * Check and apply the confidence ceiling (Immutable Standard 3).
   * Returns clamped confidence value.
   */
  checkCeiling(rawConfidence: number, retrievalCount: number): number;
}
```

Cross-module dependency: `ACTRParams` from `shared/types/confidence.types.ts` (shared, not a boundary violation).

### 4.6 IDriveStateReader (`src/drive-engine/interfaces/drive-engine.interfaces.ts`)

```typescript
interface IDriveStateReader {
  /** Current drive vector. Read-only. Never mutate. (CANON: Drive Isolation) */
  getCurrentState(): DriveVector;
  // DriveVector from shared/types/drive.types.ts

  /** Observable drive state. Emits on each tick from the drive process. */
  readonly driveState$: Observable<DriveVector>;

  /** Sum of all drives above their neutral threshold. */
  getTotalPressure(): number;
}
```

Cross-module type: `DriveVector` from `shared/types/drive.types.ts`. No boundary violation.

**Critical:** This interface has no write methods. This is not an oversight. This is the structural enforcement of Drive Isolation.

### 4.7 IActionOutcomeReporter (`src/drive-engine/interfaces/drive-engine.interfaces.ts`)

```typescript
interface IActionOutcomeReporter {
  /**
   * Report an action outcome to the Drive Engine process for contingency evaluation.
   * Fire-and-forget -- does not await Drive Engine response.
   * (CANON: Drive Isolation -- main process sends events, Drive process evaluates)
   */
  reportOutcome(outcome: ActionOutcome): void;
  // ActionOutcome from shared/types/action.types.ts

  /**
   * Report software metrics (latency, memory, CPU) to Drive Engine.
   * Feeds System Health drive.
   */
  reportMetrics(metrics: SoftwareMetrics): void;
  // SoftwareMetrics from shared/types/drive.types.ts
}
```

Note the return type is `void`, not `Promise<void>`. These are fire-and-forget IPC sends. Making them async would imply the main process is waiting for the Drive Engine to process the event, which creates the wrong mental model about the communication channel.

### 4.8 IRuleProposer (`src/drive-engine/interfaces/drive-engine.interfaces.ts`)

```typescript
interface IRuleProposer {
  /**
   * Submit a new drive rule for guardian review.
   * Inserts into proposed_drive_rules only. Never modifies active drive_rules.
   * (CANON: No Self-Modification of Evaluation, Immutable Standard 6)
   */
  proposeRule(proposal: DriveRuleProposal): Promise<void>;
  // DriveRuleProposal from shared/types/drive.types.ts
}
```

### 4.9 IOpportunityDetector (`src/drive-engine/interfaces/drive-engine.interfaces.ts`)

```typescript
interface IOpportunityDetector {
  /**
   * Evaluate recent prediction evaluations and detect opportunities.
   * Called by the Drive Engine process on each tick (internal use only).
   * Not exported from DriveEngineModule -- this is drive-process-internal logic.
   */
  evaluatePredictions(outcomes: PredictionEvaluation[]): OpportunityCandidate[];
  // PredictionEvaluation, OpportunityCandidate from shared/types/drive.types.ts

  /** Get the current opportunity queue state (for WebModule metrics). */
  detectOpportunities(): Opportunity[];
  // Opportunity from shared/types/drive.types.ts
}
```

### 4.10 IDecisionMakingService (`src/decision-making/interfaces/decision-making.interfaces.ts`)

```typescript
interface IDecisionMakingService {
  /**
   * Process an input through the full decision cycle.
   * Encodes to episodic memory, generates candidates, arbitrates, executes,
   * evaluates prediction, reports outcome to Drive Engine.
   */
  processInput(input: SystemInput): Promise<DecisionOutcome>;
  // SystemInput, DecisionOutcome from decision-making.interfaces.ts

  /** Get the current cognitive context (for LLM context assembly). */
  getCognitiveContext(): Promise<CognitiveContext>;
  // CognitiveContext from decision-making.interfaces.ts

  /** Report an outcome that was determined externally (e.g., guardian correction). */
  reportOutcome(outcome: ExternalOutcome): Promise<void>;
}
```

### 4.11 IEpisodicMemoryService (`src/decision-making/interfaces/decision-making.interfaces.ts`)

```typescript
interface IEpisodicMemoryService {
  /**
   * Encode an experience into episodic memory.
   * Gated by attention and arousal levels. May return null if below threshold.
   */
  encode(experience: EpisodeInput): Promise<Episode | null>;
  // Episode, EpisodeInput from decision-making.interfaces.ts

  /** Get recent episodes filtered by context. */
  getRecentEpisodes(limit: number, contextFilter?: string): Promise<Episode[]>;

  /** Query episodes by context fingerprint for inner monologue candidate generation. */
  queryByContext(contextFingerprint: string): Promise<Episode[]>;

  /** Return episodes ready for Learning subsystem consolidation (age > threshold). */
  getConsolidationCandidates(): Promise<Episode[]>;
}
```

### 4.12 IArbitrationService (`src/decision-making/interfaces/decision-making.interfaces.ts`)

```typescript
interface IArbitrationService {
  /**
   * Arbitrate between Type 1 candidates and Type 2 deliberation.
   * Returns SHRUG if nothing meets the dynamic threshold (Immutable Standard 4).
   */
  arbitrate(
    context: DecisionContext,
    driveState: DriveVector,
    type1Candidates: ActionCandidate[],
  ): Promise<ArbitrationResult>;
  // All types from decision-making.interfaces.ts or shared drive/action types
}
```

Cross-module type: `DriveVector` from `shared/types/drive.types.ts`. Not a boundary violation.

### 4.13 IPredictionService (`src/decision-making/interfaces/prediction.interfaces.ts`)

```typescript
interface IPredictionService {
  /** Generate a prediction for a candidate action. */
  generatePrediction(
    action: ActionCandidate,
    context: DecisionContext,
    processType: 'TYPE_1' | 'TYPE_2',
  ): Promise<Prediction>;
  // Prediction from prediction.interfaces.ts

  /** Evaluate a prediction against actual outcome. */
  evaluatePrediction(
    prediction: Prediction,
    actualOutcome: ActionOutcome,
  ): PredictionAccuracy;
  // PredictionAccuracy from prediction.interfaces.ts
}
```

### 4.14 IExecutorEngine (`src/decision-making/interfaces/decision-making.interfaces.ts`)

```typescript
interface IExecutorEngine {
  /** Execute the selected arbitration result. */
  execute(
    selection: ArbitrationResult,
    context: DecisionContext,
  ): Promise<ExecutionResult>;

  /**
   * Transition to IDLE state. Called when no action is selected (SHRUG).
   * Records the shrug event to TimescaleDB per Immutable Standard 4.
   */
  forceIdle(): Promise<void>;

  /** Get current executor state machine state. */
  getState(): ExecutorState;
}
```

### 4.15 ICommunicationService (`src/communication/interfaces/communication.interfaces.ts`)

```typescript
interface ICommunicationService {
  /**
   * Handle input from the guardian.
   * Parses, determines intent, routes to Decision Making.
   */
  handleGuardianInput(input: GuardianInput): Promise<void>;
  // GuardianInput from communication.interfaces.ts

  /**
   * Generate a response to be delivered to the guardian.
   * Injects drive state into LLM context (Theater Prohibition enforcement).
   * Always calls Theater validator before delivering output.
   */
  generateResponse(intent: CommunicationIntent): Promise<CommunicationResponse>;
  // CommunicationIntent, CommunicationResponse from communication.interfaces.ts

  /**
   * Initiate a Sylphie-originated comment.
   * Records timestamp for Social 30s response window tracking.
   */
  initiateComment(intent: CommunicationIntent): Promise<void>;
}
```

### 4.16 ILlmService (`src/communication/interfaces/communication.interfaces.ts`)

```typescript
interface ILlmService {
  /**
   * Send a completion request to the Claude API.
   * Tracks latency and token usage -- required for Type 2 cost reporting.
   */
  complete(request: LlmRequest): Promise<LlmResponse>;
  // LlmRequest, LlmResponse from communication.interfaces.ts

  /**
   * Estimate token cost for a given context (pre-call, for arbitration cost estimation).
   */
  estimateCost(request: LlmRequest): LlmCostEstimate;
}
```

**This is the critical cross-module type dependency.** DecisionMakingModule injects `LLM_SERVICE` from CommunicationModule via its token. The `LlmRequest` and `LlmResponse` types are defined in `communication/interfaces/communication.interfaces.ts`. DecisionMakingModule must import these types for the Type 2 arbitrator to compile.

**Resolution:** Define `LlmRequest`, `LlmResponse`, and `LlmCostEstimate` in `shared/types/` rather than in communication interfaces. This eliminates the cross-module type import. The concrete communication-specific types (persona context, output format preferences) remain in communication interfaces. Only the boundary types shared with Decision Making live in shared.

This is a non-trivial design decision and is the right call -- types that cross module boundaries belong in shared.

### 4.17 IInputParserService (`src/communication/interfaces/communication.interfaces.ts`)

```typescript
interface IInputParserService {
  /**
   * Parse raw guardian input into structured intent.
   * LLM-mediated. Records event to TimescaleDB with has_learnable=true.
   */
  parse(rawInput: RawGuardianInput): Promise<ParsedInput>;
}
```

### 4.18 IPersonModelingService (`src/communication/interfaces/communication.interfaces.ts`)

```typescript
interface IPersonModelingService {
  /** Get the current interaction model for a person. */
  getPersonModel(personId: string): Promise<PersonInteractionModel>;

  /**
   * Update person model after an interaction.
   * Writes to Other KG (Grafeo) via IOtherKgService.
   * (CANON: Other KG isolation -- never touches WKG or Self KG)
   */
  updatePersonModel(
    personId: string,
    interaction: InteractionRecord,
  ): Promise<void>;
}
```

### 4.19 ITheaterValidator (`src/communication/interfaces/communication.interfaces.ts`)

```typescript
interface ITheaterValidator {
  /**
   * Validate that proposed output correlates with actual drive state.
   * Returns VALID if the emotion expressed matches drive state above 0.2.
   * Returns THEATRICAL if expressed emotion does not correlate with drive state.
   * THEATRICAL outputs receive zero reinforcement (Immutable Standard 1).
   */
  validate(
    proposedOutput: CommunicationResponse,
    driveState: DriveVector,
  ): TheaterValidationResult;
  // TheaterValidationResult from communication.interfaces.ts
}
```

Cross-module type: `DriveVector` from `shared/types/drive.types.ts`. Not a boundary violation.

### 4.20 ILearningService (`src/learning/interfaces/learning.interfaces.ts`)

```typescript
interface ILearningService {
  /**
   * Run one maintenance cycle.
   * Queries up to 5 learnable events, extracts entities/edges, upserts to WKG.
   * Triggered by Cognitive Awareness drive pressure or timer fallback.
   */
  runMaintenanceCycle(): Promise<MaintenanceCycleResult>;
  // MaintenanceCycleResult from learning.interfaces.ts

  /**
   * Check if a consolidation cycle should run.
   * Evaluates Cognitive Awareness drive level against threshold.
   */
  shouldConsolidate(driveState: DriveVector): boolean;
}
```

### 4.21 IEntityExtractionService (`src/learning/interfaces/learning.interfaces.ts`)

```typescript
interface IEntityExtractionService {
  /**
   * Extract entities from a learnable event.
   * LLM-assisted. Assigns LLM_GENERATED provenance at base confidence 0.35.
   * (CANON: Provenance Is Sacred)
   */
  extract(event: LearnableEvent): Promise<ExtractionResult>;
  // ExtractionResult from learning.interfaces.ts
  // LearnableEvent from shared/types/event.types.ts
}
```

Cross-module type: `LearnableEvent` from `shared/types/event.types.ts`. Not a boundary violation.

### 4.22 IEdgeRefinementService (`src/learning/interfaces/learning.interfaces.ts`)

```typescript
interface IEdgeRefinementService {
  /**
   * Refine relationships between extracted entities.
   * LLM-assisted. Edges carry LLM_GENERATED provenance.
   */
  refine(entities: ExtractedEntity[], context: LearnableEvent): Promise<RefinedEdge[]>;
}
```

### 4.23 IContradictionDetector (`src/learning/interfaces/learning.interfaces.ts`)

```typescript
interface IContradictionDetector {
  /**
   * Check whether a proposed upsert contradicts existing WKG knowledge.
   * Contradictions are developmental catalysts, not errors. (CANON: Learning subsystem)
   * Returns the contradiction details if found, null if clean.
   */
  check(
    proposed: KnowledgeUpsertRequest,
    existing: KnowledgeNode | null,
  ): ContradictionResult | null;
  // KnowledgeUpsertRequest from knowledge/interfaces
  // ContradictionResult from learning.interfaces.ts
}
```

Cross-module type: `KnowledgeUpsertRequest` from `src/knowledge/interfaces/knowledge.interfaces.ts`. This is a boundary crossing. LearningModule imports from KnowledgeModule, which is correct and expected -- the learning subsystem writes to the knowledge store.

### 4.24 IPlanningService (`src/planning/interfaces/planning.interfaces.ts`)

```typescript
interface IPlanningService {
  /**
   * Process an opportunity through the full planning pipeline.
   * INTAKE -> RESEARCH -> SIMULATE -> PROPOSE -> VALIDATE -> CREATE
   */
  processOpportunity(opportunity: Opportunity): Promise<PlanningResult>;
  // Opportunity from shared/types/drive.types.ts
  // PlanningResult from planning.interfaces.ts

  /** Get the current opportunity queue state. */
  getOpportunityQueue(): OpportunityQueueState;
}
```

Cross-module type: `Opportunity` from `shared/types/drive.types.ts`. Not a boundary violation.

### 4.25 Web Interface Stubs

Controller and gateway stubs are minimal -- they declare route/event handlers that return `throw new NotImplementedException()`. No interfaces required for stubs in E0; the full web interface contract belongs to E9.

---

## 5. Package.json Dependencies

### Core NestJS (required for module system, DI, lifecycle hooks)

| Package                      | Version    | Reason                                            |
|------------------------------|------------|---------------------------------------------------|
| `@nestjs/core`               | `^10.0.0`  | NestJS IoC container, module system               |
| `@nestjs/common`             | `^10.0.0`  | Decorators, interfaces, pipes, filters            |
| `@nestjs/platform-express`   | `^10.0.0`  | HTTP adapter (Express)                            |
| `@nestjs/websockets`         | `^10.0.0`  | WebSocket gateways (E9, but declared in E0 stubs) |
| `@nestjs/platform-socket.io` | `^10.0.0`  | Socket.io adapter for gateways                    |
| `@nestjs/config`             | `^3.0.0`   | ConfigModule, ConfigService, env validation       |
| `@nestjs/schedule`           | `^4.0.0`   | Timer-based scheduling (Learning timer fallback)  |
| `rxjs`                       | `^7.8.0`   | Observable-based drive state stream, RxJS 7+      |

### Configuration Validation

| Package             | Version   | Reason                                           |
|---------------------|-----------|--------------------------------------------------|
| `class-validator`   | `^0.14.0` | Decorators for config schema validation          |
| `class-transformer` | `^0.5.0`  | `plainToClass()` for config object construction  |

### TypeScript

| Package              | Version    | Reason                                      |
|----------------------|------------|---------------------------------------------|
| `typescript`         | `^5.1.0`   | Compiler. 5.x for latest decorator support  |
| `ts-node`            | `^10.9.0`  | Dev-time execution                          |
| `@types/node`        | `^20.0.0`  | Node.js type definitions                    |
| `@types/express`     | `^4.17.0`  | Express type definitions                    |

### Linting and Formatting

| Package                       | Version   | Reason                             |
|-------------------------------|-----------|-------------------------------------|
| `eslint`                      | `^8.0.0`  | Linting                            |
| `@typescript-eslint/parser`   | `^6.0.0`  | TypeScript-aware ESLint parser      |
| `@typescript-eslint/eslint-plugin` | `^6.0.0` | TypeScript ESLint rules         |
| `prettier`                    | `^3.0.0`  | Code formatting                    |
| `eslint-config-prettier`      | `^9.0.0`  | Disables ESLint rules that conflict |

### NestJS CLI

| Package        | Version   | Reason                                                 |
|----------------|-----------|--------------------------------------------------------|
| `@nestjs/cli`  | `^10.0.0` | Code generation, build tooling (`nest build`)          |
| `@nestjs/schematics` | `^10.0.0` | CLI-generated file templates                   |
| `@nestjs/testing` | `^10.0.0` | Test module utilities (not used in E0 but locked) |

### Database Drivers (declared in E0, implemented in E1)

These must be present in `package.json` at E0 so that E1 can import them without a separate package install step. The interfaces reference them via injection tokens; the concrete implementations (factory providers) are stubs in E0.

| Package         | Version    | Reason                                    |
|-----------------|------------|-------------------------------------------|
| `neo4j-driver`  | `^5.0.0`   | Neo4j driver for WKG. Factory provider stub in E0 |
| `pg`            | `^8.11.0`  | PostgreSQL driver (TimescaleDB, system DB)|
| `@types/pg`     | `^8.10.0`  | TypeScript types for pg                   |

### NOT included in E0

- `@anthropic-ai/sdk` -- LLM service implementation is E6
- `openai` -- STT/TTS is E6
- Grafeo SDK -- technology validation required before E1 (see §7)
- Any ORM (TypeORM, Prisma) -- TimescaleDB raw queries via `pg` directly; no ORM

---

## 6. Ticket Breakdown

Tickets are sized for single-session completion. A session is approximately 2-4 hours of implementation time. Dependencies are noted.

### Ticket E0-1: Project Bootstrap
**Session estimate:** 1 session
**Depends on:** nothing
**Deliverables:**
- `package.json` with all dependencies from §5
- `tsconfig.json` (strict: true, decorators enabled, paths aliases for `@shared`, `@events`, etc.)
- `tsconfig.build.json` (excludes test files)
- `nest-cli.json`
- `.eslintrc.js` (TypeScript ESLint, no-any rule as warning, no-unused-vars as error)
- `.prettierrc` (single quotes, trailing comma, 100 char line width)
- `src/main.ts` (bootstrap with global exception filter, shutdown hooks)
- `docker-compose.yml` (Neo4j, TimescaleDB, PostgreSQL stubs with volumes and health checks)
- `.env.example` (all required env vars documented)
- `npx tsc --noEmit` passes (empty project compiles)

**Validation:** `npx tsc --noEmit` exits 0. `npx eslint src/` passes.

---

### Ticket E0-2: Shared Types -- Drive, Provenance, Confidence
**Session estimate:** 1 session
**Depends on:** E0-1
**Deliverables:**
- `src/shared/types/drive.types.ts`
  - `DriveName` string literal union (12 drives)
  - `DriveVector` interface (readonly, all 12 drives as number [0,1])
  - `DriveSnapshot` (DriveVector + timestamp + sessionId)
  - `PressureDelta` (drive key + delta amount + cause)
  - `SoftwareMetrics` interface
  - `DriveRuleProposal` interface
  - `Opportunity`, `OpportunityCandidate`, `OpportunityType` types
  - `PredictionEvaluation` interface
  - `DRIVE_DEFAULTS` const assertion (initial drive values)

- `src/shared/types/provenance.types.ts`
  - `ProvenanceSource` union: `'SENSOR' | 'GUARDIAN' | 'LLM_GENERATED' | 'INFERENCE'`
  - `PROVENANCE_BASE_CONFIDENCE` const assertion: `{ SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, INFERENCE: 0.30 }`

- `src/shared/types/confidence.types.ts`
  - `ACTRParams` interface (base, count, lastRetrievalHours, decayRate)
  - `computeConfidence(params: ACTRParams): number` pure function
  - `CONFIDENCE_THRESHOLDS` const assertion (retrieval: 0.50, ceiling: 0.60, type1Graduation: 0.80, type1Demotion: 0.15)
  - `DEFAULT_DECAY_RATES` const assertion (per-provenance decay rates)

**Validation:** `npx tsc --noEmit` exits 0. `computeConfidence` has a JSDoc with the ACT-R formula.

---

### Ticket E0-3: Shared Types -- Knowledge, Events, Actions, IPC
**Session estimate:** 1 session
**Depends on:** E0-2 (provenance types required)
**Deliverables:**
- `src/shared/types/knowledge.types.ts`
  - `KnowledgeNode`, `KnowledgeEdge`, `KnowledgeSubgraph`
  - `KnowledgeUpsertRequest`, `EdgeFilter`, `NodeFilter`

- `src/shared/types/event.types.ts`
  - `SubsystemSource` union (5 subsystems)
  - `EventType` discriminated union (30+ event types; see roadmap E0b)
  - `SylphieEvent` interface (id, timestamp, source, type, driveSnapshot, payload)
  - `EventQueryFilter` interface
  - `LearnableEvent` (SylphieEvent with `hasLearnable: true` and `learningPayload`)

- `src/shared/types/action.types.ts`
  - `ActionType` union
  - `ActionProcedureData` interface
  - `ActionCandidate` interface (source: TYPE_1_GRAPH | TYPE_1_DRIVE | TYPE_2_LLM, confidence, etc.)
  - `ActionOutcome` interface
  - `DriveCategory` union

- `src/shared/types/ipc.types.ts`
  - `DriveIPCMessageType` union (DRIVE_SNAPSHOT, ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START, SESSION_END, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS)
  - `DriveIPCMessage<T>` generic interface
  - Payload types for each message type

- `src/shared/types/llm.types.ts` (NEW -- see §4.16 cross-module type resolution)
  - `LlmRequest`, `LlmResponse`, `LlmCostEstimate`
  - These live in shared to avoid CommunicationModule/DecisionMakingModule cross-import

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-4: Shared Module and Config
**Session estimate:** 1 session
**Depends on:** E0-3
**Deliverables:**
- `src/shared/config/app.config.ts` (AppConfig with all subsystem configs, class-validator decorators)
- `src/shared/config/database.config.ts` (Neo4jConfig, TimescaleConfig, PostgresConfig, GrafeoConfig)
- `src/shared/exceptions/sylphie.exception.ts` (SylphieException base)
- `src/shared/exceptions/domain.exceptions.ts` (KnowledgeException, DriveException, LearningException, PlanningException, CommunicationException, DecisionMakingException and their specific subclasses)
- `src/shared/filters/sylphie-exception.filter.ts` (NestJS ExceptionFilter implementation)
- `src/shared/shared.module.ts` (global module, exports ConfigModule)
- `src/shared/index.ts` (barrel: exports all types, exceptions, config classes)

**Validation:** `npx tsc --noEmit` exits 0. Barrel exports all public types.

---

### Ticket E0-5: Events Module Stub
**Session estimate:** 0.5 session
**Depends on:** E0-4
**Deliverables:**
- `src/events/interfaces/events.interfaces.ts` (IEventsService -- full interface per §4.1)
- `src/events/events.tokens.ts` (`EVENTS_SERVICE` Symbol)
- `src/events/events.service.ts` (stub implementing IEventsService, all methods throw NotImplementedException)
- `src/events/events.module.ts` (provides EVENTS_SERVICE via EventsService, exports EVENTS_SERVICE)
- `src/events/index.ts` (barrel: exports interface, token, module)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-6: Knowledge Module Stub
**Session estimate:** 1 session
**Depends on:** E0-4, E0-5
**Deliverables:**
- `src/knowledge/interfaces/knowledge.interfaces.ts` (IWkgService, ISelfKgService, IOtherKgService, IConfidenceService -- full interfaces per §4.2-4.5, plus KnowledgeSubgraph, SelfModel, PersonGraph local types)
- `src/knowledge/knowledge.tokens.ts` (WKG_SERVICE, SELF_KG_SERVICE, OTHER_KG_SERVICE, CONFIDENCE_SERVICE, NEO4J_DRIVER Symbols)
- `src/knowledge/wkg/wkg.service.ts` (stub)
- `src/knowledge/wkg/wkg-query.service.ts` (stub -- internal helper, not exported)
- `src/knowledge/self-kg/self-kg.service.ts` (stub)
- `src/knowledge/other-kg/other-kg.service.ts` (stub)
- `src/knowledge/confidence/confidence.service.ts` (stub -- wraps `computeConfidence` pure function)
- `src/knowledge/knowledge.module.ts` (provides all four tokens, exports all four tokens, NEO4J_DRIVER factory stub returns null with TODO comment)
- `src/knowledge/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-7: Drive Engine Module Stub
**Session estimate:** 1 session
**Depends on:** E0-4, E0-5, E0-6
**Deliverables:**
- `src/drive-engine/interfaces/drive-engine.interfaces.ts` (IDriveStateReader, IActionOutcomeReporter, IRuleProposer, IOpportunityDetector -- full interfaces per §4.6-4.9, DriveIPCChannel interface)
- `src/drive-engine/drive-engine.tokens.ts` (DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER, RULE_PROPOSER Symbols)
- `src/drive-engine/drive-reader/drive-reader.service.ts` (stub implementing IDriveStateReader, includes `readonly driveState$ = new Subject<DriveVector>().asObservable()` so Observable type compiles)
- `src/drive-engine/action-outcome-reporter/action-outcome-reporter.service.ts` (stub)
- `src/drive-engine/rule-proposer/rule-proposer.service.ts` (stub)
- `src/drive-engine/opportunity/opportunity.service.ts` (stub)
- `src/drive-engine/drive-engine.module.ts` (provides three exported tokens, imports EventsModule)
- `src/drive-engine/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0. `IDriveStateReader` has zero write methods -- this is verified by reading the interface file.

---

### Ticket E0-8: Decision Making Module Stub
**Session estimate:** 1.5 sessions
**Depends on:** E0-4, E0-5, E0-6, E0-7
**Deliverables:**
- `src/decision-making/interfaces/decision-making.interfaces.ts` (IDecisionMakingService, IEpisodicMemoryService, IArbitrationService, IExecutorEngine, IActionRetrieverService, IConfidenceUpdaterService, plus SystemInput, DecisionOutcome, DecisionContext, Episode, EpisodeInput, CognitiveContext, ArbitrationResult, ExternalOutcome, ExecutionResult, ExecutorState types)
- `src/decision-making/interfaces/prediction.interfaces.ts` (IPredictionService, Prediction, PredictionAccuracy types)
- `src/decision-making/decision-making.tokens.ts` (DECISION_MAKING_SERVICE, EPISODIC_MEMORY_SERVICE, ARBITRATION_SERVICE Symbols)
- Stub service files for all 7 internal services plus the main service
- `src/decision-making/decision-making.module.ts` (imports EventsModule, KnowledgeModule, DriveEngineModule, CommunicationModule [for LLM_SERVICE only], exports DECISION_MAKING_SERVICE; includes module-level comment explaining the CommunicationModule import exception)
- `src/decision-making/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-9: Communication Module Stub
**Session estimate:** 1 session
**Depends on:** E0-4, E0-5, E0-6, E0-7
**Deliverables:**
- `src/communication/interfaces/communication.interfaces.ts` (ICommunicationService, ILlmService, IInputParserService, IPersonModelingService, ITheaterValidator, ITtsService, ISttService, plus GuardianInput, CommunicationIntent, CommunicationResponse, ParsedInput, PersonInteractionModel, InteractionRecord, TheaterValidationResult, RawGuardianInput, local communication types)
- `src/communication/communication.tokens.ts` (COMMUNICATION_SERVICE, LLM_SERVICE, INPUT_PARSER_SERVICE, STT_SERVICE, TTS_SERVICE Symbols)
- Stub service files for all 6 services
- `src/communication/communication.module.ts` (imports EventsModule, KnowledgeModule, DriveEngineModule; exports COMMUNICATION_SERVICE, LLM_SERVICE)
- `src/communication/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-10: Learning Module Stub
**Session estimate:** 1 session
**Depends on:** E0-4, E0-5, E0-6, E0-7
**Deliverables:**
- `src/learning/interfaces/learning.interfaces.ts` (ILearningService, IEntityExtractionService, IEdgeRefinementService, IContradictionDetector, plus MaintenanceCycleResult, ExtractionResult, ExtractedEntity, RefinedEdge, ContradictionResult types)
- `src/learning/learning.tokens.ts` (LEARNING_SERVICE Symbol)
- Stub service files for all 4 services plus main service
- `src/learning/learning.module.ts` (imports EventsModule, KnowledgeModule, DriveEngineModule; exports LEARNING_SERVICE)
- `src/learning/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-11: Planning Module Stub
**Session estimate:** 1 session
**Depends on:** E0-4, E0-5, E0-6, E0-7
**Deliverables:**
- `src/planning/interfaces/planning.interfaces.ts` (IPlanningService, IOpportunityResearchService, ISimulationService, IConstraintValidationService, IProcedureCreationService, IPlanningRateLimiter, plus PlanningResult, OpportunityQueueState, ResearchResult, SimulationOutcome, PlanProposal, ValidationResult, PlanningState types)
- `src/planning/planning.tokens.ts` (PLANNING_SERVICE Symbol)
- Stub service files for all 6 services plus main service
- `src/planning/planning.module.ts` (imports EventsModule, KnowledgeModule, DriveEngineModule; exports PLANNING_SERVICE)
- `src/planning/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-12: Web Module Stubs
**Session estimate:** 0.5 session
**Depends on:** E0-8, E0-9, E0-10, E0-11
**Deliverables:**
- `src/web/interfaces/web.interfaces.ts` (HttpHealthResponse, DriveStateResponse, GraphQueryResponse, ConversationMessage, MetricsSummary)
- Controller stub files (5) -- each controller stub has route decorators with correct paths and return type annotations, but bodies throw NotImplementedException
- Gateway stub files (3) -- each gateway has `@WebSocketGateway` decorator and `@SubscribeMessage` decorators for the events it will handle in E9
- `src/web/web.module.ts` (imports DriveEngineModule, KnowledgeModule, EventsModule, DecisionMakingModule; no exports)
- `src/web/index.ts` (barrel)

**Validation:** `npx tsc --noEmit` exits 0.

---

### Ticket E0-13: AppModule and Final Verification
**Session estimate:** 0.5 session
**Depends on:** all previous tickets
**Deliverables:**
- `src/app.module.ts` with all 8 modules imported, ConfigModule.forRoot with validation function, global exception filter registered
- `src/main.ts` with bootstrap, global filter, shutdown hooks, port from ConfigService
- Final `npx tsc --noEmit` pass
- Manual review: no `forwardRef`, no `any` types, no circular module imports detectable by inspection
- Scan output of `@nestjs/core` circular dependency warning on startup (run `npm run start:dev` and check for warnings)

**Validation:** `npx tsc --noEmit` exits 0 with zero errors or warnings. `npm run start:dev` starts without circular dependency warnings.

---

### Ticket Summary Table

| Ticket  | Description                       | Sessions | Depends On           |
|---------|-----------------------------------|----------|----------------------|
| E0-1    | Project bootstrap                 | 1        | --                   |
| E0-2    | Shared types: drive/provenance/confidence | 1 | E0-1              |
| E0-3    | Shared types: knowledge/events/actions/IPC | 1 | E0-2            |
| E0-4    | Shared module, config, exceptions | 1        | E0-3                 |
| E0-5    | Events module stub                | 0.5      | E0-4                 |
| E0-6    | Knowledge module stub             | 1        | E0-4, E0-5           |
| E0-7    | Drive engine module stub          | 1        | E0-4, E0-5, E0-6     |
| E0-8    | Decision making module stub       | 1.5      | E0-4..E0-7           |
| E0-9    | Communication module stub         | 1        | E0-4..E0-7           |
| E0-10   | Learning module stub              | 1        | E0-4..E0-7           |
| E0-11   | Planning module stub              | 1        | E0-4..E0-7           |
| E0-12   | Web module stubs                  | 0.5      | E0-8..E0-11          |
| E0-13   | AppModule and final verification  | 0.5      | E0-12                |

**Total estimated sessions:** approximately 11.5 sessions (roughly 35-45 hours of focused implementation time).

**Parallelizable:** Tickets E0-8, E0-9, E0-10, and E0-11 can all be done in parallel once E0-7 is complete. They depend on the same foundation and do not depend on each other.

---

## 7. Risks and Mitigations

### Risk 1: Grafeo SDK Does Not Exist as a Mature Library
**Probability:** High
**Impact:** High -- Self KG and Other KG are blocked without it
**CANON relevance:** CANON requires Self KG and Other KG isolation (separate Grafeo instances). If Grafeo is vaporware or immature, the isolation model breaks.

**Mitigation for E0:** The `ISelfKgService` and `IOtherKgService` interfaces are defined as pure TypeScript interfaces with no driver-specific types. The stub implementations do not import any Grafeo driver. E0 compiles regardless of Grafeo's status.

**Flag for E1:** Before E1 begins, technology validation is required. Options to evaluate:
- Grafeo (check npm, GitHub for actual releases)
- Memgraph embedded
- Multiple SQLite instances with graph traversal via adjacency tables
- LevelGraph (graph DB on top of LevelDB)

The key requirement: completely isolated instances with no shared connection objects and ideally some Cypher-compatible query layer.

**If Grafeo is unavailable:** The interface contract (`ISelfKgService`, `IOtherKgService`) does not change. The implementation changes. The stub-first approach of E0 isolates this risk perfectly.

---

### Risk 2: `LLM_SERVICE` Cross-Module Import Creates Unexpected Coupling
**Probability:** Medium
**Impact:** Medium -- Future contributors may not understand the exception
**CANON relevance:** Subsystem module boundary discipline

**Context:** DecisionMakingModule imports CommunicationModule to inject `LLM_SERVICE` for Type 2 arbitration. This is the single sanctioned exception to the "subsystems do not import each other" rule.

**Mitigation:**
- Document the exception explicitly in `decision-making.module.ts` with a comment block explaining why it is necessary and what it permits.
- CommunicationModule exports ONLY `COMMUNICATION_SERVICE` and `LLM_SERVICE`. It does not export input parser, person modeling, theater validator, etc. This limits what DecisionMakingModule can see.
- The `LlmRequest`, `LlmResponse`, `LlmCostEstimate` types live in `shared/types/llm.types.ts`, not in `communication/interfaces/`. This means the Type 2 arbitrator does not need to import communication interface files directly -- only the token.

**Alternative rejected:** Duplicating `LlmService` in DecisionMakingModule. This creates divergence when the LLM client is updated. Single source of truth matters.

---

### Risk 3: DriveVector Type Used in DriveReaderService.driveState$ Cannot Compile Without Subject Import
**Probability:** Certain (TypeScript issue in stub)
**Impact:** Low -- Compile error on stub only
**Description:** The `IDriveStateReader` interface declares `readonly driveState$: Observable<DriveVector>`. The stub service must satisfy this with a real `Observable` instance for TypeScript to pass `--noEmit`. An uninitialized `driveState$` will fail to compile.

**Mitigation:** The stub initializes `driveState$` as:
```typescript
readonly driveState$ = new Subject<DriveVector>().asObservable();
```
This requires importing `Subject` from `rxjs`. The stub is more than a pure empty class -- it has this minimal real implementation. This is the correct pattern for any interface property that must compile.

---

### Risk 4: Discriminated Union for EventType Grows Unwieldy
**Probability:** Medium (30+ event types in E0b)
**Impact:** Low for E0, Medium for future maintenance
**Description:** `SylphieEvent` uses a discriminated union on `type`. With 30+ event types, the union becomes difficult to extend. Adding a new event type in E3 or E5 requires modifying `event.types.ts` in shared, which touches the root of the shared module.

**Mitigation:** Use a two-level design:
- `SubsystemEventType` unions per subsystem (e.g., `DecisionMakingEventType`, `CommunicationEventType`, etc.)
- `EventType` is the union of all subsystem event type unions: `type EventType = DecisionMakingEventType | CommunicationEventType | ...`

This allows each epic to add to its own subsystem event type union without touching the others. The discriminated union still works because each subsystem prefix makes types unique.

---

### Risk 5: tsconfig Path Aliases Break `npx tsc --noEmit` on First Run
**Probability:** Medium
**Impact:** Low -- Configuration issue only
**Description:** Path aliases (`@shared`, `@events`, etc.) in tsconfig require `paths` configuration. The NestJS compiler (`nest build`) handles these, but raw `npx tsc --noEmit` may not follow them without `tsconfig-paths`.

**Mitigation:** Use `tsconfig-paths/register` in `ts-node` configuration. Alternatively, avoid path aliases entirely in E0 and use relative imports. Path aliases improve developer experience but are not required for correctness. Relative imports are unambiguous and always work.

**Decision:** Relative imports for E0. Path aliases can be added after `npx tsc --noEmit` is proven clean.

---

### Risk 6: NotImplementedException Not Defined Yet
**Probability:** Certain (NestJS does not provide it)
**Impact:** Low -- One-line addition to `domain.exceptions.ts`
**Description:** Stub methods `throw new NotImplementedException()`. NestJS provides `NotImplementedException` extending `HttpException`, which is appropriate for HTTP controllers. For non-HTTP service stubs, a domain exception is cleaner.

**Mitigation:** Define `NotImplementedException extends SylphieException` in `src/shared/exceptions/domain.exceptions.ts`. All stubs import from the shared barrel. This is a 5-line addition to E0-4.

---

### Risk 7: Observable import in DriveEngine stubs requires rxjs in package.json from day one
**Probability:** Certain
**Impact:** None if handled in E0-1
**Description:** `IDriveStateReader.driveState$` is typed as `Observable<DriveVector>`. This type requires `rxjs` to compile. `rxjs` is already listed in the package.json dependencies in §5.

**Mitigation:** Already addressed. Confirm `rxjs` is in production dependencies, not devDependencies. It is a runtime dependency (DriveReaderService uses it at runtime in E4).

---

## Appendix: tsconfig.json Minimum Requirements

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*spec.ts"]
}
```

`emitDecoratorMetadata` and `experimentalDecorators` are required for NestJS DI to function. Without them, `@Injectable()`, `@Inject()`, and `@Module()` do not emit the metadata that the IoC container reads.

`useUnknownInCatchVariables` is a TypeScript 4.4+ feature that types `catch` clause variables as `unknown` by default. This is the correct behavior -- caught errors are always `unknown` at the boundary.

---

## Appendix: .env.example Required Variables

Every required environment variable must be in `.env.example` at E0 completion. Documented here for completeness:

```
# NestJS Application
PORT=3000
DEBUG=false

# Neo4j (World Knowledge Graph)
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=
NEO4J_MAX_CONNECTION_POOL_SIZE=50

# TimescaleDB (Event Backbone)
TIMESCALE_HOST=localhost
TIMESCALE_PORT=5432
TIMESCALE_DATABASE=sylphie_events
TIMESCALE_USERNAME=sylphie_app
TIMESCALE_PASSWORD=

# PostgreSQL (System DB)
POSTGRES_HOST=localhost
POSTGRES_PORT=5433
POSTGRES_DATABASE=sylphie_system
POSTGRES_USERNAME=sylphie_app
POSTGRES_PASSWORD=

# Grafeo (Self KG and Other KG)
GRAFEO_DATA_PATH=./data/grafeo
# NOTE: Technology validation required before E1

# LLM (Anthropic Claude API)
ANTHROPIC_API_KEY=
LLM_MODEL=claude-opus-4-5
LLM_MAX_TOKENS_TYPE2=4096

# OpenAI (STT + TTS)
OPENAI_API_KEY=
STT_MODEL=whisper-1
TTS_MODEL=tts-1
TTS_VOICE=alloy

# Drive Engine Process
DRIVE_ENGINE_TICK_RATE_HZ=100
DRIVE_SELF_EVAL_INTERVAL_TICKS=10
DRIVE_COLD_START_DECISIONS=50
```

---

*Analysis complete. All design decisions in this document are pre-implementation. No code was written. The implementer should read this document, then execute tickets in order starting at E0-1.*
