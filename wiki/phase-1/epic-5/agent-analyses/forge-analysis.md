# Epic 5: Decision Making (Core Cognitive Loop) -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** Full DecisionMakingModule implementation with Type 1/Type 2 arbitration, episodic memory, prediction, and action retrieval
**Analysis Date:** 2026-03-29
**Scope:** NestJS/TypeScript architecture, module boundaries, DI patterns, service contracts, async patterns, error handling, integration with Events, Knowledge, and Drive Engine

---

## Executive Summary

Epic 5 is the core cognitive loop of Sylphie. It implements the **dual-process decision architecture** (Type 1/Type 2 arbitration), **episodic memory** as a first-class component, **prediction generation and evaluation**, and **action retrieval and execution**. This is the most complex epic because it:

1. Orchestrates subsystems (Events, Knowledge, Drive Engine, Communication)
2. Manages the Executor Engine state machine (8 states)
3. Implements ACT-R confidence dynamics for Type 1/Type 2 arbitration
4. Handles episodic memory lifecycle (encode → decay → consolidation)
5. Produces the primary decision loop that runs continuously

The architectural challenge is **tight temporal coupling without circular dependencies**. Decision Making must read from Drive Engine, communicate with Knowledge, emit to Events, and interpret LLM outputs — but none of these should create a dependency cycle. The solution is **read-only interface projection** (DependencyProxy pattern) and **unidirectional event flow**.

This analysis covers module structure, service dependency graph, interface contracts, file structure, cross-module integration, error handling, async patterns, configuration, and testing strategy.

---

## 1. Complete Directory Tree

Every file that must exist at E5 completion.

```
src/decision-making/
├── decision-making.module.ts                    (config)
├── decision-making.tokens.ts                    (types/DI)
├── index.ts                                     (barrel)
│
├── interfaces/
│   ├── decision-making.interfaces.ts            (types) - IDecisionMakingService
│   ├── episodic-memory.interfaces.ts            (types) - IEpisodicMemoryService
│   ├── arbitration.interfaces.ts                (types) - IArbitrationService
│   ├── prediction.interfaces.ts                 (types) - IPredictionService
│   ├── action-retriever.interfaces.ts           (types) - IActionRetrieverService
│   ├── confidence-updater.interfaces.ts         (types) - IConfidenceUpdaterService
│   ├── executor-engine.interfaces.ts            (types) - IExecutorEngine
│   └── index.ts                                 (barrel)
│
├── decision-making/
│   ├── decision-making.service.ts               (impl)
│   ├── decision-making.service.spec.ts          (tests)
│   └── index.ts                                 (barrel)
│
├── episodic-memory/
│   ├── episodic-memory.service.ts               (impl)
│   ├── episodic-memory.service.spec.ts          (tests)
│   ├── episodic-memory.schema.ts                (types) - Episode, EpisodeIndex
│   └── index.ts                                 (barrel)
│
├── arbitration/
│   ├── arbitration.service.ts                   (impl)
│   ├── arbitration.service.spec.ts              (tests)
│   ├── type1-arbitrator.service.ts              (impl)
│   ├── type1-arbitrator.service.spec.ts         (tests)
│   ├── type2-arbitrator.service.ts              (impl)
│   ├── type2-arbitrator.service.spec.ts         (tests)
│   ├── arbitration.constants.ts                 (config)
│   └── index.ts                                 (barrel)
│
├── prediction/
│   ├── prediction.service.ts                    (impl)
│   ├── prediction.service.spec.ts               (tests)
│   ├── prediction.schema.ts                     (types) - Prediction, PredictionResult
│   ├── prediction.constants.ts                  (config)
│   └── index.ts                                 (barrel)
│
├── action-retriever/
│   ├── action-retriever.service.ts              (impl)
│   ├── action-retriever.service.spec.ts         (tests)
│   ├── action-tree.schema.ts                    (types) - ActionNode, ActionTree
│   ├── action-retriever.constants.ts            (config)
│   └── index.ts                                 (barrel)
│
├── confidence-updater/
│   ├── confidence-updater.service.ts            (impl)
│   ├── confidence-updater.service.spec.ts       (tests)
│   ├── confidence.calculator.ts                 (impl) - ACT-R formula
│   ├── confidence.constants.ts                  (config)
│   └── index.ts                                 (barrel)
│
├── executor-engine/
│   ├── executor-engine.service.ts               (impl)
│   ├── executor-engine.service.spec.ts          (tests)
│   ├── executor-state.machine.ts                (impl) - State machine logic
│   ├── executor.constants.ts                    (config)
│   ├── executor.schema.ts                       (types) - ExecutorState, Transition
│   └── index.ts                                 (barrel)
│
└── exceptions/
    ├── decision-making.exceptions.ts            (types) - DomainException subclasses
    └── index.ts                                 (barrel)
```

**Legend:**
- `(config)` - Module/provider configuration, real DI setup
- `(impl)` - Real implementation, business logic
- `(types)` - Interfaces, types, no runtime logic
- `(tests)` - Jest unit tests, `.spec.ts` files only at E5 (integration tests in E8)

---

## 2. Service Dependency Graph

### 2.1 Dependency Overview

```
DecisionMakingService
├── depends on: EventsModule (EVENTS_SERVICE) [read-write]
├── depends on: KnowledgeModule (WKG_SERVICE, CONFIDENCE_SERVICE) [read-only]
├── depends on: DriveEngineModule (DRIVE_STATE_READER) [read-only]
├── depends on: CommunicationModule (LLM_SERVICE) [read-only, Type 2 only]
├── manages: EpisodicMemoryService [internal]
├── manages: ArbitrationService [internal]
├── manages: PredictionService [internal]
├── manages: ActionRetrieverService [internal]
├── manages: ConfidenceUpdaterService [internal]
└── manages: ExecutorEngineService [internal]

```

### 2.2 Strict Circular Dependency Prevention

**Critical constraint:** DecisionMakingModule must NOT depend on CommunicationModule; CommunicationModule depends on DecisionMakingModule (for action execution context). This is enforced by:

1. **LLM_SERVICE token injection into DecisionMakingModule** -- provided by CommunicationModule, injected by ConfigService reference
2. **Lazy injection pattern** -- DecisionMakingService receives `@Inject(LLM_SERVICE)` but calls it via interface only when Type 2 is selected
3. **No back-reference** -- CommunicationModule NEVER imports DecisionMakingModule or its types in exports

Similarly, **DecisionMakingModule must NOT depend on DriveEngineModule's internal logic** -- only the read-only `DRIVE_STATE_READER` interface. This is enforced by:

1. DriveEngineModule exports ONLY `DRIVE_STATE_READER` token (not the entire module)
2. DecisionMakingModule imports DriveEngineModule as a dependency but accesses it through the narrow interface
3. Inject documentation clearly notes "read-only: do not call setDrive() or modify rules"

---

## 3. Complete Interface Contracts

### 3.1 IDecisionMakingService

```typescript
/**
 * DecisionMakingService: The central cognitive loop.
 *
 * Flow:
 * 1. Input arrives (text, sensor, etc.)
 * 2. Encode into episodic memory
 * 3. Generate predictions (Type 1 + Type 2 candidates)
 * 4. Arbitrate (Type 1 vs Type 2)
 * 5. Execute selected action via ExecutorEngine
 * 6. Record outcome and drive evaluation
 *
 * CANON traceability: Decision Making Subsystem (CANON.md §2)
 */
export interface IDecisionMakingService {
  /**
   * Process an incoming input and produce a decision.
   *
   * This is the entry point. All external inputs (text, sensor, etc.)
   * pass through this method.
   *
   * @param input - SylphieInput (text, sensory, or drive notification)
   * @param context - Optional contextual metadata (person, location, correlation_id)
   * @returns Promise<DecisionOutcome> with selected action, confidence, reasoning
   * @throws DecisionProcessingError if a subsystem fails
   * @throws ValidationError if input is malformed
   *
   * Timing guarantee: Max 5 seconds total (Type 1 < 100ms, Type 2 < 4.9s)
   *
   * Side effects:
   * - Emits INPUT_RECEIVED event to TimescaleDB
   * - Records decision outcome to TimescaleDB
   * - Updates episodic memory
   */
  processInput(
    input: SylphieInput,
    context?: DecisionContext,
  ): Promise<DecisionOutcome>;

  /**
   * Get the current cognitive context: recent episodes, drive state,
   * active predictions, and arbitration history.
   *
   * Used by Communication and Learning subsystems to understand
   * Sylphie's current mental state.
   *
   * @returns Promise<CognitiveContext> snapshot
   * @throws MemoryAccessError if episodic memory fails
   */
  getCognitiveContext(): Promise<CognitiveContext>;

  /**
   * Report the outcome of an executed action (after observation phase).
   *
   * The Executor Engine has executed an action and observed results.
   * This method updates the prediction record with the actual outcome,
   * allowing Drive Engine to evaluate success/failure.
   *
   * @param outcomeReport - ActionOutcomeReport with success/failure flags
   * @throws OutcomeRecordingError if persistence fails
   * @throws PredictionNotFoundError if the prediction is not tracked
   *
   * Side effects:
   * - Updates prediction confidence in Knowledge Graph
   * - Emits OUTCOME_RECORDED event
   * - May trigger opportunity detection in Drive Engine
   */
  reportOutcome(outcomeReport: ActionOutcomeReport): Promise<void>;

  /**
   * Get the current Executor state (for debugging and UI).
   *
   * @returns ExecutorEngineState enum value
   */
  getExecutorState(): ExecutorEngineState;

  /**
   * Force the executor to IDLE state (emergency stop or reset).
   *
   * Used during testing, error recovery, or when a subsystem fails.
   * Does NOT record this as a decision -- it is a system command.
   *
   * @throws ExecutorError if state machine cannot transition
   */
  forceIdle(): Promise<void>;
}
```

### 3.2 IEpisodicMemoryService

```typescript
/**
 * EpisodicMemoryService: Temporal working memory for decision making.
 *
 * Stores recent experiences with decay. Fresh episodes are detail-rich;
 * older episodes consolidate into semantic knowledge (WKG) through
 * the Learning subsystem.
 *
 * Memory lifecycle:
 * 1. Encode: New episode created with max confidence (0.95)
 * 2. Active: Episode contributes to predictions (fresh_weight = 1.0 decay over minutes)
 * 3. Consolidation: Learning extracts entities/edges (has_learnable = true)
 * 4. Archive: Episode older than retention_window is marked archived
 *
 * CANON traceability: Episodic Memory (CANON.md §2.1)
 */
export interface IEpisodicMemoryService {
  /**
   * Encode a new experience into episodic memory.
   *
   * @param input - SylphieInput to encode
   * @param context - DecisionContext (drive state, attention, arousal)
   * @returns Promise<EpisodeId> UUID of the newly created episode
   * @throws MemoryEncodingError if validation fails
   *
   * Side effect: Creates Episode node in Grafeo KG(Self)
   *
   * Gating: Episodes are only created if attention > 0.3.
   * Low-attention ticks (e.g., idle waiting) do not clutter memory.
   */
  encode(input: SylphieInput, context: DecisionContext): Promise<string>;

  /**
   * Retrieve recent episodes (last N minutes, sorted by recency).
   *
   * @param windowMinutes - How many minutes back (default 5)
   * @param limit - Max episodes to return (default 20)
   * @returns Promise<Episode[]> sorted by timestamp DESC
   * @throws MemoryAccessError if query fails
   *
   * Confidence weighting: Episodes decay over time.
   * A 1-minute-old episode has weight 0.95; 5-minute-old = 0.70
   * Used by PredictionService to weight examples.
   */
  getRecentEpisodes(
    windowMinutes?: number,
    limit?: number,
  ): Promise<Episode[]>;

  /**
   * Query episodes by context (e.g., "episodes where person=Jim").
   *
   * Used by PredictionService to find relevant past situations.
   *
   * @param query - EpisodeQuery with optional filters
   * @returns Promise<Episode[]>
   * @throws MemoryAccessError if query fails
   * @throws ValidationError if query is malformed
   */
  queryByContext(query: EpisodeQuery): Promise<Episode[]>;

  /**
   * Mark an episode as learnable (candidates for consolidation).
   *
   * Learning subsystem calls this to flag episodes for entity/edge extraction.
   *
   * @param episodeId - UUID of episode to mark
   * @throws EpisodeNotFoundError if ID doesn't exist
   */
  markLearnable(episodeId: string): Promise<void>;

  /**
   * Get summary statistics for the current memory state.
   *
   * @returns MemoryStats with total_episodes, active_weight, retention_seconds
   */
  getStats(): Promise<MemoryStats>;
}
```

### 3.3 IArbitrationService

```typescript
/**
 * ArbitrationService: Dual-process Type 1 vs Type 2 decision arbitration.
 *
 * Given:
 * - A set of Type 1 candidate actions (from ActionRetriever)
 * - A set of Type 2 candidate actions (from LLM)
 * - Current drive state
 *
 * Decide which action to execute based on confidence, drive valence,
 * and prediction quality history.
 *
 * Core principle: Type 1 wins by default (low latency). Type 2 is engaged
 * only if Type 1 confidence is insufficient OR if recent Type 1 predictions
 * have failed.
 *
 * CANON traceability: Type 1/Type 2 Arbitration (CANON.md §1.2, §2.1)
 */
export interface IArbitrationService {
  /**
   * Arbitrate between Type 1 and Type 2 candidates.
   *
   * @param situation - Current EpisodeContext for arbitration
   * @param type1Candidates - Array of ActionCandidate from Type 1 retriever
   * @param type2Candidates - Array of ActionCandidate from Type 2 (LLM)
   * @param driveState - Current 12-drive state snapshot
   * @returns Promise<ArbitrationDecision> with selected action, provenance, reasoning
   * @throws ArbitrationError if no candidates are valid
   * @throws ThresholdCalculationError if drive state is missing
   *
   * Time limit: < 50ms (Type 1 evaluation must be fast)
   *
   * Algorithm:
   * 1. Validate all candidates (signature, provenance, confidence)
   * 2. Apply Type 1 filter: candidates with confidence > dynamic_threshold
   * 3. If Type 1 candidates exist:
   *    - Rank by confidence + drive_alignment score
   *    - Select top-ranked
   *    - Return with provenance TYPE_1
   * 4. If no Type 1 candidates or threshold is high (recent failures):
   *    - Rank Type 2 candidates by LLM confidence + drive_alignment
   *    - Select top-ranked
   *    - Return with provenance TYPE_2
   * 5. If all else fails: return SHRUG action (Immutable Standard 4)
   *
   * Threshold dynamics:
   * - Base threshold: 0.70
   * - Adjusted by anxiety: high anxiety (> 0.7) raises threshold to 0.75
   * - Adjusted by recent failures: N consecutive prediction failures raise threshold
   * - Immutable floor: 0.50 (always at least 50% confidence)
   */
  arbitrate(
    situation: EpisodeContext,
    type1Candidates: ActionCandidate[],
    type2Candidates: ActionCandidate[],
    driveState: DriveSnapshot,
  ): Promise<ArbitrationDecision>;

  /**
   * Get the current dynamic confidence threshold.
   *
   * Used by Type 1 Arbitrator to determine filter level.
   *
   * @returns number between 0.50 and 0.90
   */
  getDynamicThreshold(): Promise<number>;
}
```

### 3.4 IPredictionService

```typescript
/**
 * PredictionService: Generates predictive hypotheses about action outcomes.
 *
 * For each candidate action, produces a prediction:
 * "If I do X, then Y will happen with confidence Z"
 *
 * Predictions are the foundation of:
 * - Type 1/Type 2 arbitration (confidence comparison)
 * - Drive evaluation (did the action produce desired outcomes?)
 * - Learning (failed predictions trigger consolidation)
 *
 * CANON traceability: Prediction Drives Learning (CANON.md §1.6, §2.5)
 */
export interface IPredictionService {
  /**
   * Generate a prediction for an action candidate.
   *
   * Given an action and current context, predict likely outcomes.
   *
   * @param action - ActionCandidate to predict
   * @param context - EpisodeContext (recent episodes, drive state, person model)
   * @returns Promise<Prediction> with outcome_description, confidence, basis
   * @throws PredictionGenerationError if LLM or graph lookup fails
   * @throws ContextError if context is incomplete
   *
   * For Type 1 predictions:
   * - Look up historical action outcomes in WKG (action node with outcome edges)
   * - Confidence derived from retrieval confidence
   * - Basis: "Type 1: Historical pattern"
   *
   * For Type 2 predictions:
   * - Call LLM with action, context, recent episodes
   * - Confidence derived from LLM confidence + episodic evidence
   * - Basis: "Type 2: LLM reasoning + episodic analogy"
   *
   * Time limit: < 3 seconds total (1ms Type 1, 2.99s Type 2)
   */
  generatePrediction(
    action: ActionCandidate,
    context: EpisodeContext,
  ): Promise<Prediction>;

  /**
   * Evaluate a prediction against observed reality.
   *
   * After an action is executed and observed, compare prediction
   * to actual outcome. Compute Mean Absolute Error (MAE).
   *
   * @param prediction - Original Prediction object
   * @param outcome - Observed ActionOutcome (success/failure flags)
   * @returns PredictionEvaluation with mae, confidence_update, is_correct
   * @throws PredictionNotFoundError if prediction ID not tracked
   *
   * MAE computation:
   * - Binary outcome: if predicted_confidence == actual (0 or 1), MAE = 0
   * - Otherwise: MAE = |predicted_confidence - actual|
   *
   * Example:
   * - Prediction: "If I say hello, Jim will respond" (confidence 0.9)
   * - Actual: Jim responds (outcome = 1.0)
   * - MAE = |0.9 - 1.0| = 0.1 (slight overconfidence, acceptable)
   *
   * - Prediction: "If I go to bed, Jim will leave" (confidence 0.8)
   * - Actual: Jim stays (outcome = 0.0)
   * - MAE = |0.8 - 0.0| = 0.8 (major failure, Type 1 demotion)
   *
   * Side effect: Emits PREDICTION_EVALUATED event to TimescaleDB
   */
  evaluatePrediction(
    prediction: Prediction,
    outcome: ActionOutcome,
  ): Promise<PredictionEvaluation>;

  /**
   * Get statistics on prediction accuracy.
   *
   * Used by arbitration to adjust dynamic threshold.
   *
   * @returns PredictionStats with mae_average, success_rate, recent_failures
   */
  getStats(): Promise<PredictionStats>;
}
```

### 3.5 IActionRetrieverService

```typescript
/**
 * ActionRetrieverService: Type 1 action candidate generation.
 *
 * Queries the WKG for known actions and their expected outcomes.
 * Acts as a fast, non-blocking lookup layer for Type 1 decision making.
 *
 * CANON traceability: Type 1 fast retrieval (CANON.md §1.2)
 */
export interface IActionRetrieverService {
  /**
   * Retrieve candidate actions for the current context.
   *
   * @param context - EpisodeContext (current situation, recent episodes, person)
   * @param options - Optional: maxCandidates (default 5), minConfidence (default 0.50)
   * @returns Promise<ActionCandidate[]> sorted by confidence DESC
   * @throws ContextError if context is incomplete
   * @throws WkgQueryError if graph lookup fails
   *
   * Query logic:
   * 1. Identify relevant action nodes from WKG (based on context similarity)
   * 2. Filter by confidence >= minConfidence
   * 3. Rank by confidence + context relevance
   * 4. Return top maxCandidates
   *
   * Time limit: < 10ms (pure graph retrieval, no LLM)
   *
   * Time limit: < 10ms (pure graph retrieval, no LLM)
   */
  retrieve(
    context: EpisodeContext,
    options?: ActionRetrievalOptions,
  ): Promise<ActionCandidate[]>;

  /**
   * Initialize the action tree on first boot.
   *
   * Creates the root action node and bootstrap actions (IDLE, SHRUG, etc.).
   *
   * @throws ActionTreeError if initialization fails
   *
   * Bootstrap actions (always present, confidence = 0.95):
   * - IDLE: Do nothing, maintain current state
   * - SHRUG: Signal incomprehension (Immutable Standard 4)
   * - ERROR_RECOVERY: Emergency state transition
   */
  bootstrapActionTree(): Promise<void>;

  /**
   * Get statistics on the action tree.
   *
   * @returns ActionTreeStats with total_actions, avg_confidence, retrieval_success_rate
   */
  getStats(): Promise<ActionTreeStats>;
}
```

### 3.6 IConfidenceUpdaterService

```typescript
/**
 * ConfidenceUpdaterService: ACT-R confidence dynamics.
 *
 * Implements the confidence formula:
 * confidence = min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
 *
 * Updates confidence on successful use and decay over time.
 *
 * CANON traceability: Confidence Dynamics (CANON.md §3)
 */
export interface IConfidenceUpdaterService {
  /**
   * Update confidence for a knowledge item based on use outcome.
   *
   * @param itemId - UUID of knowledge item (action, prediction, edge)
   * @param outcome - USE_SUCCESS | USE_FAILURE | GUARDIAN_CONFIRMATION | GUARDIAN_CORRECTION
   * @param context - Optional: drive state, latency for impact weighting
   * @returns ConfidenceUpdate with new_confidence, delta, update_reason
   * @throws ItemNotFoundError if itemId doesn't exist in graph
   * @throws ConfidenceError if formula computation fails
   *
   * Outcome multipliers (CANON §5: Guardian Asymmetry):
   * - USE_SUCCESS: count += 1
   * - USE_FAILURE: confidence -= 0.15 (if MAE > 0.15, additional Type 1 demotion check)
   * - GUARDIAN_CONFIRMATION: confidence += 0.10, count += 2 (2x weight)
   * - GUARDIAN_CORRECTION: confidence -= 0.20, count -= 1 (3x negative weight)
   *
   * Decay: Every 1 hour since last use, confidence decays by -0.05 (tunable per type)
   */
  update(
    itemId: string,
    outcome: ConfidenceOutcome,
    context?: ConfidenceUpdateContext,
  ): Promise<ConfidenceUpdate>;

  /**
   * Compute confidence without persisting (for hypotheticals).
   *
   * @param baseConfidence - Starting confidence
   * @param count - Number of successful uses
   * @param hoursSinceUse - Time decay
   * @returns number: new confidence value
   */
  compute(
    baseConfidence: number,
    count: number,
    hoursSinceUse: number,
  ): number;

  /**
   * Check if an item has graduated to Type 1 status.
   *
   * Type 1 graduation requires:
   * - confidence > 0.80 AND
   * - prediction MAE < 0.10 over last 10 uses
   *
   * @param itemId - UUID of the item
   * @returns Promise<boolean>
   */
  isType1Ready(itemId: string): Promise<boolean>;

  /**
   * Demote a Type 1 item back to Type 2 if prediction quality decays.
   *
   * If recent MAE > 0.15, downgrade confidence by 0.20 and reset count to 3.
   *
   * @param itemId - UUID of the item
   * @returns Promise<ConfidenceUpdate> with demotion details
   */
  demoteIfNeeded(itemId: string): Promise<ConfidenceUpdate | null>;
}
```

### 3.7 IExecutorEngineService

```typescript
/**
 * ExecutorEngineService: Action execution and state machine.
 *
 * Manages the state machine:
 * IDLE -> CATEGORIZING -> PREDICTING -> ARBITRATING -> RETRIEVING -> EXECUTING -> OBSERVING -> LEARNING
 *
 * (In E5, full Learning state is not implemented; it transitions back to IDLE
 * and emits a learnable event for the Learning subsystem to process asynchronously)
 *
 * CANON traceability: Executor flow (CANON.md §2.1)
 */
export interface IExecutorEngineService {
  /**
   * Transition the executor to a new state with input data.
   *
   * @param toState - Target ExecutorEngineState
   * @param data - State-specific payload (depends on toState)
   * @returns Promise<ExecutorTransition> with success flag, validation errors, latency
   * @throws InvalidTransitionError if the transition is not allowed
   * @throws ValidationError if data is malformed for the target state
   *
   * Valid transitions:
   * - IDLE -> CATEGORIZING: data = { input: SylphieInput }
   * - CATEGORIZING -> PREDICTING: data = { context: EpisodeContext }
   * - PREDICTING -> ARBITRATING: data = { predictions: Prediction[] }
   * - ARBITRATING -> RETRIEVING: data = { selectedAction: ActionCandidate }
   * - RETRIEVING -> EXECUTING: data = { actionToExecute: Action }
   * - EXECUTING -> OBSERVING: data = { executionReport: ExecutionReport }
   * - OBSERVING -> LEARNING: data = { outcome: ActionOutcome }
   * - LEARNING -> IDLE: (automatic, no data)
   *
   * All transitions are recorded to TimescaleDB with latency metrics.
   */
  transition(
    toState: ExecutorEngineState,
    data?: Record<string, unknown>,
  ): Promise<ExecutorTransition>;

  /**
   * Get the current state of the executor.
   *
   * @returns ExecutorEngineState enum value
   */
  getState(): ExecutorEngineState;

  /**
   * Force the executor back to IDLE (emergency stop).
   *
   * Clears all in-flight data, resets state machine.
   * Used for error recovery or subsystem restart.
   *
   * @throws ExecutorError if state reset fails
   *
   * Side effect: Emits EXECUTOR_FORCED_IDLE event (not recorded as a decision)
   */
  forceIdle(): Promise<void>;

  /**
   * Get timing information for the current cycle.
   *
   * @returns CycleTiming with per-state latencies, total time
   */
  getTiming(): CycleTiming;
}
```

---

## 4. Cross-Module Integration

### 4.1 EventsModule Integration

**What DecisionMakingModule reads:**
- `IEventService.queryLearnableEvents()` - Not used in E5 (Learning uses this)
- Not used in E5; Decision Making only writes events

**What DecisionMakingModule writes:**
```
Input received: INPUT_RECEIVED
  timestamp, input_text, input_type, person, context_metadata

Episode encoded: EPISODE_ENCODED
  episode_id, context_drive_state

Prediction generated: PREDICTION_GENERATED
  prediction_id, action, confidence, basis (Type 1 vs Type 2)

Arbitration completed: ARBITRATION_COMPLETED
  selected_action, confidence, arbitration_reason

Action executed: ACTION_EXECUTED
  action_id, executor_state, timing

Outcome observed: OUTCOME_OBSERVED
  prediction_id, actual_outcome_json, mae_computed

Executor state change: EXECUTOR_STATE_CHANGED
  from_state, to_state, latency_ms
```

**Injection pattern:**
```typescript
@Injectable()
export class DecisionMakingService implements IDecisionMakingService {
  constructor(
    @Inject(EVENTS_SERVICE) private eventsService: IEventService,
  ) {}

  async processInput(input: SylphieInput) {
    // Record input event
    const { eventId } = await this.eventsService.record({
      type: 'INPUT_RECEIVED',
      timestamp: new Date(),
      input,
    });
    // ... rest of processing
  }
}
```

### 4.2 KnowledgeModule Integration

**What DecisionMakingModule reads:**
- `IWkgService.query()` - Search for entities, actions, patterns
- `IWkgService.getNode()` - Retrieve action nodes with historical outcomes
- `IConfidenceService.getConfidence()` - Check item confidence levels
- `IConfidenceService.updateConfidence()` - Update confidence after outcome

**Write operations:**
- DecisionMakingModule does NOT write directly to WKG (read-only via ActionRetriever)
- ConfidenceUpdaterService calls IConfidenceService.updateConfidence() for updates

**Injection pattern:**
```typescript
@Injectable()
export class ActionRetrieverService implements IActionRetrieverService {
  constructor(
    @Inject(WKG_SERVICE) private wkgService: IWkgService,
    @Inject(CONFIDENCE_SERVICE) private confidenceService: IConfidenceService,
  ) {}

  async retrieve(context: EpisodeContext) {
    // Retrieve action candidates from WKG
    const actions = await this.wkgService.query('MATCH (a:Action) ...');
    // Filter by confidence
    return actions.filter(a =>
      this.confidenceService.getConfidence(a.id) > 0.50
    );
  }
}
```

### 4.3 DriveEngineModule Integration

**What DecisionMakingModule reads:**
- `IDriveStateReader.getDriveSnapshot()` - Current drive state (all 12 drives)
- `IDriveStateReader.getDriveDynamics()` - Recent drive trends

**Write operations:**
- DecisionMakingModule does NOT write to drive state (read-only)
- ActionOutcomeReporter is called by Drive Engine AFTER evaluation

**Critical constraint:**
```typescript
/**
 * DRIVE_STATE_READER is read-only. Never call methods like:
 * - setDrive(), modifyDriveRule(), proposeDriveRule()
 *
 * These operations are reserved for the Drive Engine (separate process).
 * Violating this constraint violates Immutable Standard 6.
 */
@Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader;
```

**Injection pattern:**
```typescript
@Injectable()
export class ArbitrationService implements IArbitrationService {
  constructor(
    @Inject(DRIVE_STATE_READER) private driveStateReader: IDriveStateReader,
  ) {}

  async arbitrate(
    situation,
    type1Candidates,
    type2Candidates,
    driveState: DriveSnapshot,
  ) {
    // Drive state is passed in (not read dynamically)
    // This ensures decision evaluation doesn't change mid-arbitration
    const threshold = this.computeThreshold(driveState);
    // ...
  }
}
```

### 4.4 CommunicationModule Integration

**What DecisionMakingModule calls:**
- `ILlmService.generatePredictions()` - Type 2 candidate generation
- `ILlmService.generateResponse()` - Not used in E5 (Communication uses this)

**Critical constraint:**
```typescript
/**
 * LLM_SERVICE is injected lazily. CommunicationModule depends on
 * DecisionMakingModule (for action execution), so we cannot make
 * DecisionMakingModule depend on CommunicationModule.
 *
 * Solution: LLM_SERVICE token is provided at module initialization,
 * but we treat it as an optional dependency. If unavailable, Type 2
 * falls back to graph-based reasoning only.
 */
@Inject(LLM_SERVICE) private readonly llmService?: ILlmService;
```

**Injection pattern:**
```typescript
@Injectable()
export class Type2ArbitratorService {
  constructor(
    @Inject(LLM_SERVICE) private llmService: ILlmService,
  ) {}

  async generateType2Candidates(context: EpisodeContext) {
    if (!this.llmService) {
      this.logger.warn('LLM service unavailable; using graph-only reasoning');
      return [];
    }
    const predictions = await this.llmService.generatePredictions(context);
    return predictions;
  }
}
```

---

## 5. Async Patterns and Observables

### 5.1 Decision Cycle (Promise-based)

```typescript
// Standard async/await flow in DecisionMakingService.processInput()

async processInput(input: SylphieInput): Promise<DecisionOutcome> {
  // 1. Encode into episodic memory
  const episodeId = await this.episodicMemory.encode(input, context);

  // 2. Retrieve recent context
  const recentEpisodes = await this.episodicMemory.getRecentEpisodes();

  // 3. Generate predictions (Type 1 + Type 2 in parallel)
  const [type1Predictions, type2Predictions] = await Promise.all([
    this.generateType1Predictions(context),
    this.generateType2Predictions(context),
  ]);

  // 4. Arbitrate
  const decision = await this.arbitrator.arbitrate(
    context,
    type1Predictions,
    type2Predictions,
    driveState,
  );

  // 5. Execute (async, fire-and-forget for observation)
  this.executorEngine.transition(ExecutorEngineState.EXECUTING, {
    action: decision.action,
  }).catch(err => this.logger.error('Execution failed', err));

  // 6. Return immediately (not waiting for outcome)
  return decision;
}
```

### 5.2 Observable Patterns (Future Enhancement for E6+)

For real-time reactive subscribers (Drive Engine, Communication), EventsModule can provide an Observable:

```typescript
// In EventsModule (E2), optional streamEvents() method:
export interface IEventService {
  streamEvents(filter?: EventFilter): Observable<SylphieEvent>;
}

// In DriveEngineModule, subscribe to decision events:
this.eventsService.streamEvents({ type: 'OUTCOME_OBSERVED' })
  .pipe(
    filter(event => this.isRelevantOutcome(event)),
    tap(event => this.evaluateDriveImpact(event)),
    debounceTime(100), // Prevent thrashing
  )
  .subscribe();
```

**For E5:** Keep this as a note for future enhancement. DecisionMakingModule uses Promises only.

### 5.3 Timing Guarantees and Latency Tracking

All async operations must record timing:

```typescript
@Injectable()
export class DecisionMakingService {
  private cycleTimer: CycleTimer;

  async processInput(input: SylphieInput): Promise<DecisionOutcome> {
    const cycleStart = Date.now();

    // Record each phase latency
    const encodeStart = Date.now();
    const episodeId = await this.episodicMemory.encode(input, context);
    const encodeLatency = Date.now() - encodeStart;

    const predictStart = Date.now();
    const predictions = await this.predictionService.generatePrediction(...);
    const predictLatency = Date.now() - predictStart;

    const arbitrateStart = Date.now();
    const decision = await this.arbitrator.arbitrate(...);
    const arbitrateLatency = Date.now() - arbitrateStart;

    const totalLatency = Date.now() - cycleStart;

    // Record timing event
    await this.eventsService.record({
      type: 'DECISION_CYCLE_TIMING',
      encode_latency_ms: encodeLatency,
      predict_latency_ms: predictLatency,
      arbitrate_latency_ms: arbitrateLatency,
      total_latency_ms: totalLatency,
    });

    return decision;
  }
}
```

---

## 6. Error Handling

### 6.1 Exception Hierarchy

```typescript
// src/decision-making/exceptions/decision-making.exceptions.ts

/**
 * Base exception for Decision Making subsystem.
 * All exceptions in this subsystem inherit from this.
 */
export class DecisionMakingException extends SylphieException {
  readonly subsystem = 'DECISION_MAKING';
}

// Memory errors
export class MemoryEncodingError extends DecisionMakingException {
  constructor(reason: string) {
    super(`Failed to encode episode: ${reason}`, 'MEMORY_ENCODING_ERROR');
  }
}

export class MemoryAccessError extends DecisionMakingException {
  constructor(reason: string) {
    super(`Failed to access episodic memory: ${reason}`, 'MEMORY_ACCESS_ERROR');
  }
}

// Prediction errors
export class PredictionGenerationError extends DecisionMakingException {
  constructor(action: string, reason: string) {
    super(`Failed to generate prediction for ${action}: ${reason}`, 'PREDICTION_GENERATION_ERROR');
  }
}

export class PredictionEvaluationError extends DecisionMakingException {
  constructor(predictionId: string, reason: string) {
    super(`Failed to evaluate prediction ${predictionId}: ${reason}`, 'PREDICTION_EVALUATION_ERROR');
  }
}

// Arbitration errors
export class ArbitrationError extends DecisionMakingException {
  constructor(reason: string) {
    super(`Arbitration failed: ${reason}`, 'ARBITRATION_ERROR');
  }
}

export class NoValidCandidatesError extends DecisionMakingException {
  constructor() {
    super('No valid action candidates (returning SHRUG)', 'NO_VALID_CANDIDATES');
  }
}

// Action retrieval errors
export class ActionRetrievalError extends DecisionMakingException {
  constructor(reason: string) {
    super(`Failed to retrieve actions: ${reason}`, 'ACTION_RETRIEVAL_ERROR');
  }
}

// Executor errors
export class ExecutorError extends DecisionMakingException {
  constructor(reason: string) {
    super(`Executor state machine error: ${reason}`, 'EXECUTOR_ERROR');
  }
}

export class InvalidTransitionError extends ExecutorError {
  constructor(from: ExecutorEngineState, to: ExecutorEngineState) {
    super(`Cannot transition from ${from} to ${to}`);
  }
}

export class ExecutorTimeoutError extends ExecutorError {
  constructor(state: ExecutorEngineState, timeoutMs: number) {
    super(`State ${state} exceeded timeout of ${timeoutMs}ms`);
  }
}

// Confidence errors
export class ConfidenceComputationError extends DecisionMakingException {
  constructor(itemId: string, reason: string) {
    super(`Failed to compute confidence for ${itemId}: ${reason}`, 'CONFIDENCE_ERROR');
  }
}
```

### 6.2 Error Handling Patterns

**In decision-making.service.ts:**

```typescript
async processInput(input: SylphieInput): Promise<DecisionOutcome> {
  try {
    // Encoding phase
    const episodeId = await this.episodicMemory.encode(input, context)
      .catch(err => {
        this.logger.error('Episode encoding failed', err);
        throw new MemoryEncodingError(err.message);
      });

    // Prediction phase with fallback
    const predictions = await this.predictionService
      .generatePrediction(action, context)
      .catch(err => {
        this.logger.warn('Prediction generation failed, using defaults', err);
        return this.defaultPredictions;
      });

    // Arbitration phase
    const decision = await this.arbitrator.arbitrate(...)
      .catch(err => {
        this.logger.error('Arbitration failed', err);
        // Emergency fallback: return SHRUG action
        return {
          action: ActionType.SHRUG,
          confidence: 0.0,
          reason: 'Arbitration system failure',
        };
      });

    return decision;
  } catch (error) {
    // Unrecoverable error; force executor to IDLE
    await this.executorEngine.forceIdle()
      .catch(err2 => this.logger.error('Failed to force idle', err2));
    throw error;
  }
}
```

**Timeout handling:**

```typescript
@Injectable()
export class ExecutorEngineService {
  private STATE_TIMEOUTS: Record<ExecutorEngineState, number> = {
    IDLE: 5000,
    CATEGORIZING: 100,
    PREDICTING: 3000,
    ARBITRATING: 100,
    RETRIEVING: 100,
    EXECUTING: 10000,
    OBSERVING: 5000,
    LEARNING: 0, // No timeout (async background task)
  };

  async transition(toState: ExecutorEngineState, data?: any) {
    const timeoutMs = this.STATE_TIMEOUTS[toState];

    try {
      const promise = this.performTransition(toState, data);
      return await Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new ExecutorTimeoutError(toState, timeoutMs)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (error) {
      if (error instanceof ExecutorTimeoutError) {
        await this.forceIdle();
      }
      throw error;
    }
  }
}
```

---

## 7. Configurable Parameters

### 7.1 Configuration Schema

```typescript
// src/decision-making/decision-making.config.ts

export interface DecisionMakingConfig {
  // Arbitration thresholds
  arbitration: {
    baseConfidenceThreshold: number;           // Default: 0.70
    anxietyThresholdMultiplier: number;        // Default: 1.07 (7% increase when anxious)
    consecutiveFailureThreshold: number;        // Default: 3 (after 3 failures, raise threshold)
    minConfidenceFloor: number;                 // Default: 0.50 (Immutable Standard floor)
  };

  // Episodic memory parameters
  episodicMemory: {
    retentionWindowMinutes: number;            // Default: 30
    maxEpisodes: number;                        // Default: 1000
    decayHalfLifeMinutes: number;              // Default: 5 (0.95 weight after 1 min)
    attentionThreshold: number;                 // Default: 0.30 (episodes only on high attention)
  };

  // Prediction parameters
  prediction: {
    type1TimeoutMs: number;                     // Default: 10
    type2TimeoutMs: number;                     // Default: 2990 (leaving 10ms buffer)
    totalTimeoutMs: number;                     // Default: 5000 (hard cap)
    llmTemperature: number;                     // Default: 0.7 (LLM sampling)
    llmMaxTokens: number;                       // Default: 200
  };

  // Action retrieval parameters
  actionRetriever: {
    defaultMaxCandidates: number;               // Default: 5
    minConfidenceThreshold: number;             // Default: 0.50
    queryTimeoutMs: number;                     // Default: 10
  };

  // Confidence dynamics (ACT-R)
  confidence: {
    decayRatePerHour: number;                   // Default: 0.05 (5% per hour)
    useSuccessWeight: number;                   // Default: 1.0
    useFailureWeight: number;                   // Default: -0.15
    guardianConfirmationWeight: number;         // Default: 2.0 (2x multiplier)
    guardianCorrectionWeight: number;           // Default: -3.0 (3x negative)
    type1GraduationThreshold: number;           // Default: 0.80
    type1DemotionMaeThreshold: number;          // Default: 0.15
  };

  // Executor state machine
  executor: {
    stateTimeouts: Record<ExecutorEngineState, number>;
    maxCycleLatencyMs: number;                  // Default: 5000
  };
}
```

### 7.2 Configuration Injection

```typescript
// In decision-making.module.ts

@Module({
  imports: [
    ConfigModule.forRoot({
      validationSchema: joi.object({
        DECISION_MAKING_BASE_THRESHOLD: joi
          .number()
          .default(0.70)
          .min(0.50)
          .max(0.90),
        DECISION_MAKING_EPISODIC_RETENTION_MIN: joi
          .number()
          .default(30),
        // ... more schema definitions
      }),
    }),
  ],
  providers: [
    {
      provide: DECISION_MAKING_CONFIG,
      useFactory: (configService: ConfigService): DecisionMakingConfig => ({
        arbitration: {
          baseConfidenceThreshold: configService.get(
            'DECISION_MAKING_BASE_THRESHOLD',
          ),
          // ...
        },
        // ...
      }),
      inject: [ConfigService],
    },
  ],
})
export class DecisionMakingModule {}
```

---

## 8. Testing Strategy

### 8.1 Unit Test Boundaries

Each service has a dedicated `.spec.ts` file. Boundaries are enforced using Jest mocks.

**EpisodicMemoryService.spec.ts:**
```typescript
describe('EpisodicMemoryService', () => {
  let service: EpisodicMemoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpisodicMemoryService,
        {
          provide: GRAFEO_SELF_KG,
          useValue: {
            createNode: jest.fn(),
            queryNodes: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<EpisodicMemoryService>(EpisodicMemoryService);
  });

  describe('encode', () => {
    it('should create a new episode with max confidence', async () => {
      const input = { type: 'TEXT', text: 'Hello' };
      const context = { attention: 0.8, driveState: {...} };

      const episodeId = await service.encode(input, context);

      expect(episodeId).toBeDefined();
      expect(grafeoKg.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Episode',
          properties: expect.objectContaining({
            confidence: 0.95,
          }),
        }),
      );
    });

    it('should not create episode if attention is below threshold', async () => {
      const input = { type: 'TEXT', text: 'Ignored' };
      const context = { attention: 0.1, driveState: {...} };

      const episodeId = await service.encode(input, context);

      expect(episodeId).toBeNull();
    });

    it('should throw MemoryEncodingError if graph operation fails', async () => {
      grafeoKg.createNode.mockRejectedValue(new Error('Graph failure'));

      await expect(service.encode(input, context)).rejects.toThrow(
        MemoryEncodingError,
      );
    });
  });

  describe('getRecentEpisodes', () => {
    it('should return episodes sorted by recency with decay weights', async () => {
      const mockEpisodes = [
        { id: '1', timestamp: new Date(), confidence: 0.95 },
        { id: '2', timestamp: new Date(Date.now() - 60000), confidence: 0.80 },
      ];
      grafeoKg.queryNodes.mockResolvedValue(mockEpisodes);

      const episodes = await service.getRecentEpisodes(5, 20);

      expect(episodes).toHaveLength(2);
      expect(episodes[0].id).toBe('1'); // Most recent first
    });
  });
});
```

**ArbitrationService.spec.ts:**
```typescript
describe('ArbitrationService', () => {
  let service: ArbitrationService;
  let mockDriveStateReader: Partial<IDriveStateReader>;

  beforeEach(async () => {
    mockDriveStateReader = {
      getDriveSnapshot: jest.fn().mockResolvedValue({
        anxiety: 0.5,
        curiosity: 0.7,
        // ... other drives
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ArbitrationService,
        {
          provide: DRIVE_STATE_READER,
          useValue: mockDriveStateReader,
        },
      ],
    }).compile();

    service = module.get<ArbitrationService>(ArbitrationService);
  });

  describe('arbitrate', () => {
    it('should select Type 1 candidate if confidence is above threshold', async () => {
      const type1Candidates = [
        {
          action: 'GREET',
          confidence: 0.85,
          provenance: 'TYPE_1',
        },
      ];
      const type2Candidates = [];
      const driveState = createMockDriveSnapshot();

      const decision = await service.arbitrate(
        situation,
        type1Candidates,
        type2Candidates,
        driveState,
      );

      expect(decision.action).toBe('GREET');
      expect(decision.provenance).toBe('TYPE_1');
    });

    it('should fall back to Type 2 if Type 1 confidence is too low', async () => {
      const type1Candidates = [
        {
          action: 'GREET',
          confidence: 0.65,
          provenance: 'TYPE_1',
        },
      ];
      const type2Candidates = [
        {
          action: 'SHRUG',
          confidence: 0.72,
          provenance: 'TYPE_2',
        },
      ];

      const decision = await service.arbitrate(
        situation,
        type1Candidates,
        type2Candidates,
        driveState,
      );

      expect(decision.provenance).toBe('TYPE_2');
    });

    it('should return SHRUG if no candidates meet minimum threshold', async () => {
      const type1Candidates = [
        {
          action: 'GREET',
          confidence: 0.45,
          provenance: 'TYPE_1',
        },
      ];
      const type2Candidates = [];

      const decision = await service.arbitrate(
        situation,
        type1Candidates,
        type2Candidates,
        driveState,
      );

      expect(decision.action).toBe(ActionType.SHRUG);
    });

    it('should raise threshold when anxiety is high', async () => {
      const highAnxietyDriveState = {
        ...createMockDriveSnapshot(),
        anxiety: 0.80,
      };

      // With high anxiety, 0.75 confidence should fail
      const type1Candidates = [
        {
          action: 'GREET',
          confidence: 0.75,
          provenance: 'TYPE_1',
        },
      ];
      const type2Candidates = [];

      const decision = await service.arbitrate(
        situation,
        type1Candidates,
        type2Candidates,
        highAnxietyDriveState,
      );

      expect(decision.provenance).toBe('TYPE_2');
    });
  });

  describe('getDynamicThreshold', () => {
    it('should return base threshold when no anomalies', async () => {
      const threshold = await service.getDynamicThreshold();
      expect(threshold).toBeCloseTo(0.70, 2);
    });
  });
});
```

**ExecutorEngineService.spec.ts:**
```typescript
describe('ExecutorEngineService', () => {
  let service: ExecutorEngineService;
  let mockEventsService: Partial<IEventService>;

  beforeEach(async () => {
    mockEventsService = {
      record: jest.fn().mockResolvedValue({ eventId: 'evt-1' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ExecutorEngineService,
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<ExecutorEngineService>(ExecutorEngineService);
  });

  describe('transition', () => {
    it('should transition from IDLE to CATEGORIZING', async () => {
      const input = { type: 'TEXT', text: 'Hello' };
      const result = await service.transition(ExecutorEngineState.CATEGORIZING, {
        input,
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe(ExecutorEngineState.CATEGORIZING);
      expect(service.getState()).toBe(ExecutorEngineState.CATEGORIZING);
    });

    it('should reject invalid transitions', async () => {
      // Start in IDLE, try to jump to EXECUTING (skipping intermediate states)
      await expect(
        service.transition(ExecutorEngineState.EXECUTING, {}),
      ).rejects.toThrow(InvalidTransitionError);
    });

    it('should timeout if state exceeds max duration', async () => {
      // Mock a state that takes too long
      const slowTransition = new Promise(resolve =>
        setTimeout(resolve, 6000),
      );

      service['performTransition'] = jest.fn(() => slowTransition);

      await expect(
        service.transition(ExecutorEngineState.CATEGORIZING, {}),
      ).rejects.toThrow(ExecutorTimeoutError);
    });

    it('should record timing metrics', async () => {
      await service.transition(ExecutorEngineState.CATEGORIZING, { input: {} });

      expect(mockEventsService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EXECUTOR_STATE_CHANGED',
        }),
      );
    });
  });

  describe('forceIdle', () => {
    it('should reset to IDLE from any state', async () => {
      await service.transition(ExecutorEngineState.PREDICTING, {});
      await service.forceIdle();

      expect(service.getState()).toBe(ExecutorEngineState.IDLE);
    });
  });
});
```

### 8.2 Integration Test Boundaries

Integration tests (`.integration.spec.ts`, run separately from unit tests):

**decision-making.integration.spec.ts:**
```typescript
describe('DecisionMakingService (Integration)', () => {
  let decisionService: IDecisionMakingService;
  let eventsService: IEventService;
  let wkgService: IWkgService;
  let driveStateReader: IDriveStateReader;

  beforeEach(async () => {
    // Start full app with TestingModule
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [testDatabaseConfig], // Test DB credentials
        }),
        AppModule, // Full app, all modules
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    decisionService = module.get<IDecisionMakingService>(DECISION_MAKING_SERVICE);
    eventsService = module.get<IEventService>(EVENTS_SERVICE);
    wkgService = module.get<IWkgService>(WKG_SERVICE);
    driveStateReader = module.get<IDriveStateReader>(DRIVE_STATE_READER);
  });

  afterEach(async () => {
    // Cleanup: clear TimescaleDB, reset Neo4j
  });

  describe('Full decision cycle', () => {
    it('should process input and record events end-to-end', async () => {
      const input = {
        type: InputType.TEXT,
        text: 'Hello, Sylphie!',
        person: 'Jim',
      };

      const outcome = await decisionService.processInput(input);

      expect(outcome.action).toBeDefined();
      expect(outcome.confidence).toBeGreaterThan(0);

      // Verify events were written to TimescaleDB
      const events = await eventsService.query({
        type: 'DECISION_CYCLE_TIMING',
        timeRange: { start: new Date(Date.now() - 1000) },
      });

      expect(events.length).toBeGreaterThan(0);
    });

    it('should update action confidence in WKG after outcome', async () => {
      // ... setup ...

      await decisionService.processInput(input);
      await decisionService.reportOutcome(outcomeReport);

      // Verify confidence was updated in WKG
      const action = await wkgService.getNode('Action', actionId);
      expect(action.confidence).not.toEqual(originalConfidence);
    });
  });
});
```

### 8.3 Test Coverage Targets

| Service | Unit Coverage | Integration Coverage |
|---------|---|---|
| DecisionMakingService | 85% (core paths + error cases) | Happy path + error scenarios |
| EpisodicMemoryService | 90% (encode, query, decay) | Episode lifecycle with real Grafeo |
| ArbitrationService | 85% (Type 1/Type 2 logic, thresholds) | Arbitration with real drive state |
| PredictionService | 80% (Type 1 + Type 2 paths) | Prediction generation + evaluation with real WKG + LLM |
| ActionRetrieverService | 85% (query, bootstrap, stats) | Retrieval from real WKG |
| ConfidenceUpdaterService | 90% (ACT-R formula, updates) | Confidence persistence in real WKG |
| ExecutorEngineService | 95% (state machine, transitions) | State machine with real event recording |

---

## 9. Module Declaration and Exports

### 9.1 DecisionMakingModule Configuration

```typescript
// src/decision-making/decision-making.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EventsModule } from '../events/events.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';

import { DecisionMakingService } from './decision-making/decision-making.service';
import { EpisodicMemoryService } from './episodic-memory/episodic-memory.service';
import { ArbitrationService } from './arbitration/arbitration.service';
import { Type1ArbitratorService } from './arbitration/type1-arbitrator.service';
import { Type2ArbitratorService } from './arbitration/type2-arbitrator.service';
import { PredictionService } from './prediction/prediction.service';
import { ActionRetrieverService } from './action-retriever/action-retriever.service';
import { ConfidenceUpdaterService } from './confidence-updater/confidence-updater.service';
import { ExecutorEngineService } from './executor-engine/executor-engine.service';

import { DECISION_MAKING_SERVICE, DECISION_MAKING_CONFIG } from './decision-making.tokens';
import decisionMakingConfig from './decision-making.config';

@Module({
  imports: [
    ConfigModule.forFeature(() => decisionMakingConfig),
    EventsModule,
    KnowledgeModule,
    DriveEngineModule, // Read-only via DRIVE_STATE_READER
  ],
  providers: [
    // Core service
    {
      provide: DECISION_MAKING_SERVICE,
      useClass: DecisionMakingService,
    },

    // Config provider
    {
      provide: DECISION_MAKING_CONFIG,
      useFactory: (configService: ConfigService) => ({
        arbitration: {
          baseConfidenceThreshold: configService.get('DECISION_MAKING_BASE_THRESHOLD', 0.70),
          anxietyThresholdMultiplier: configService.get('DECISION_MAKING_ANXIETY_MULTIPLIER', 1.07),
          // ...
        },
        // ...
      }),
      inject: [ConfigService],
    },

    // Internal services
    EpisodicMemoryService,
    ArbitrationService,
    Type1ArbitratorService,
    Type2ArbitratorService,
    PredictionService,
    ActionRetrieverService,
    ConfidenceUpdaterService,
    ExecutorEngineService,
  ],
  exports: [DECISION_MAKING_SERVICE],
})
export class DecisionMakingModule {}
```

### 9.2 Barrel Exports

```typescript
// src/decision-making/index.ts

export * from './interfaces';
export * from './decision-making/decision-making.service';
export * from './episodic-memory/episodic-memory.service';
export * from './arbitration/arbitration.service';
export * from './prediction/prediction.service';
export * from './action-retriever/action-retriever.service';
export * from './confidence-updater/confidence-updater.service';
export * from './executor-engine/executor-engine.service';
export * from './decision-making.tokens';
export * from './decision-making.module';
export { DecisionMakingException } from './exceptions';
```

---

## 10. Wiring Dependencies in AppModule

```typescript
// src/app.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SharedModule } from './shared/shared.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { EventsModule } from './events/events.module';
import { DecisionMakingModule } from './decision-making/decision-making.module';
import { DriveEngineModule } from './drive-engine/drive-engine.module';
import { CommunicationModule } from './communication/communication.module';
import { LearningModule } from './learning/learning.module';
import { PlanningModule } from './planning/planning.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: joi.object({
        // ... validation schema ...
      }),
    }),
    SharedModule,
    KnowledgeModule,
    EventsModule,
    DriveEngineModule,
    DecisionMakingModule,     // Depends on Knowledge, Events, DriveEngine
    CommunicationModule,      // Depends on DecisionMaking (via LLM_SERVICE)
    LearningModule,           // Depends on Knowledge, Events
    PlanningModule,           // Depends on Knowledge, Events, DriveEngine, DecisionMaking
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
```

---

## 11. Key Architectural Decisions (CANON Traceability)

| Decision | CANON Ref | Rationale |
|----------|-----------|-----------|
| Episodic memory as first-class component (not just graph queries) | §2.1 | Temporal decay and fresh-episode weighting require separate storage from semantic knowledge |
| Type 1/Type 2 arbitration with dynamic threshold | §1.2, §2.1 | Emergent behavior; threshold adapts to drive state and prediction accuracy |
| Prediction generation BEFORE action execution | §1.6, §2.5 | Enables evaluation-driven learning and confidence updates |
| Executor state machine with 8 states | §2.1 | Enforce temporal ordering; prevent race conditions in decision cycle |
| Read-only drive state injection | §4 (Drive Isolation) | Prevents reward signal manipulation (Immutable Standard 6) |
| Events as inter-subsystem communication | §3 | Decouples subsystems; enables asynchronous learning + real-time monitoring |
| ACT-R confidence formula with decay | §3 | Evidence-based knowledge quality metrics; prevents hallucinated confidence |
| Guardian weight multipliers (2x, 3x) | §5 (Guardian Asymmetry) | Teacher feedback outweighs algorithm; aligns with human learning principles |

---

## 12. Known Constraints and Gotchas

### 12.1 Circular Dependency Avoidance

- **Problem:** CommunicationModule needs to call DecisionMakingService, but DecisionMakingModule needs LLM_SERVICE from CommunicationModule.
- **Solution:** Use lazy injection via `@Inject(LLM_SERVICE)` optional dependency.
- **Cost:** Type 2 falls back to graph-only if LLM is unavailable.

### 12.2 Timing Sensitivity

- **Problem:** Type 1 prediction (< 10ms) + Type 2 prediction (< 3s) + arbitration (< 50ms) = 5s total max, but LLM latency is unpredictable.
- **Solution:** Use Promise.race with timeout; on timeout, fall back to Type 1 only.
- **Cost:** May miss optimal Type 2 candidates on overloaded LLM.

### 12.3 Episodic Memory Consolidation

- **Problem:** Episodic memory grows unbounded if not consolidated.
- **Solution:** Learning subsystem (E6) pulls learnable episodes and upserts them to WKG.
- **Cost:** Requires coordination with Learning; episodic memory is NOT self-consolidating.

### 12.4 Confidence Update Isolation

- **Problem:** ConfidenceUpdaterService updates WKG directly; must not be called during arbitration (race condition).
- **Solution:** Confidence updates happen AFTER action execution (in reportOutcome, not during prediction).
- **Cost:** Confidence lag (old values used during next decision cycle).

### 12.5 Drive State Snapshot Passing

- **Problem:** Drive state changes during decision cycle; arbitration sees stale state if not passed as snapshot.
- **Solution:** Pass `driveState: DriveSnapshot` as parameter to arbitrate(); do not call DriveStateReader during arbitration.
- **Cost:** Must pre-fetch drive state in DecisionMakingService before entering arbitration.

---

## 13. Tickets for Implementation

Rough breakdown (detail in decisions.md):

| Ticket | Service | Effort | Dependencies |
|--------|---------|--------|--------------|
| E5-01 | Module scaffold + DI setup | XS | E0, E1 |
| E5-02 | EpisodicMemoryService implementation | S | E3 (Grafeo) |
| E5-03 | PredictionService (Type 1 path) | S | E3 (WKG queries) |
| E5-04 | ActionRetrieverService + bootstrap | S | E3 (WKG) |
| E5-05 | Type1ArbitratorService | S | E5-03, E5-04 |
| E5-06 | Type2ArbitratorService + LLM integration | M | E2 (LLM_SERVICE) |
| E5-07 | ArbitrationService + threshold logic | M | E5-05, E5-06 |
| E5-08 | ConfidenceUpdaterService (ACT-R formula) | S | E3 (confidence updates) |
| E5-09 | ExecutorEngineService state machine | M | E2 (Events) |
| E5-10 | DecisionMakingService orchestration | L | All above |
| E5-11 | Error handling + exceptions | S | All above |
| E5-12 | Unit tests | M | All above |
| E5-13 | Integration tests | L | Full stack |

---

## 14. Success Criteria

At E5 completion:

1. **Interface compilation:** All DecisionMakingModule types compile without errors; circular dependency check passes.
2. **DI wiring:** All services inject correctly; dependency graph is acyclic.
3. **Executor state machine:** All 8 states reachable; invalid transitions rejected.
4. **Arbitration logic:** Type 1 confidence > threshold → Type 1 wins; otherwise Type 2 or SHRUG.
5. **Episodic memory:** Episodes encode with decay; queryByContext returns relevant episodes.
6. **Prediction evaluation:** After outcome, MAE computed correctly; confidence updated.
7. **Error handling:** All exceptions caught; system recovers gracefully (no unhandled rejections).
8. **Timing:** Full decision cycle < 5 seconds (Type 1 path < 100ms).
9. **Event recording:** All major decision steps recorded to TimescaleDB.
10. **Test coverage:** Unit tests at 85%+; integration tests cover happy path + error cases.

---

## References

- **CANON:** `/wiki/CANON.md` -- Immutable design document
- **E0 Analysis:** `/wiki/phase-1/epic-0/agent-analyses/forge.md` -- Interface skeleton design
- **E1 Analysis:** `/wiki/phase-1/epic-1/agent-analyses/forge.md` -- Database infrastructure patterns
- **E2 Analysis:** `/wiki/phase-1/epic-2/agent-analyses/forge.md` -- Events module design
- **Architecture Diagram:** `/wiki/sylphie2.png` -- Visual subsystem map

---

## Appendix A: Type Definitions Reference

```typescript
// src/shared/types/action.types.ts
export enum ActionType {
  IDLE = 'IDLE',
  SHRUG = 'SHRUG',
  ERROR_RECOVERY = 'ERROR_RECOVERY',
  TEXT_RESPONSE = 'TEXT_RESPONSE',
  // ... domain-specific actions
}

export enum InputType {
  TEXT = 'TEXT',
  SENSOR = 'SENSOR',
  DRIVE_NOTIFICATION = 'DRIVE_NOTIFICATION',
  SYSTEM_EVENT = 'SYSTEM_EVENT',
}

export enum ExecutorEngineState {
  IDLE = 'IDLE',
  CATEGORIZING = 'CATEGORIZING',
  PREDICTING = 'PREDICTING',
  ARBITRATING = 'ARBITRATING',
  RETRIEVING = 'RETRIEVING',
  EXECUTING = 'EXECUTING',
  OBSERVING = 'OBSERVING',
  LEARNING = 'LEARNING',
}

// src/shared/types/confidence.types.ts
export type ConfidenceOutcome =
  | 'USE_SUCCESS'
  | 'USE_FAILURE'
  | 'GUARDIAN_CONFIRMATION'
  | 'GUARDIAN_CORRECTION';

// src/shared/types/drive.types.ts
export type DriveSnapshot = Record<string, number>; // 12 drives, each 0.0-1.0
```

---

**End of Analysis Document**
