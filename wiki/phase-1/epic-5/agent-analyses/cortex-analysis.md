# Cortex Analysis: Epic 5 -- The Decision Making Cognitive Loop

**Agent:** Cortex (Decision Making Subsystem Engineer)
**Epic:** 5 -- Decision Making (Core Cognitive Loop)
**Date:** 2026-03-29
**Status:** Comprehensive Technical Analysis for Planning

---

## Executive Summary

Epic 5 implements the central cognitive loop that transforms sensory inputs, drive state, and world knowledge into goal-directed action. This is the computational center of gravity for the entire system. Unlike the Drive Engine (E4), which evaluates and measures, or Learning (E3), which consolidates, Decision Making is the moment-by-moment executor that selects what Sylphie does right now.

The architecture is built on **dual-process cognition**: Type 1 (fast, graph-based reflexes with high confidence) competing with Type 2 (slow, LLM-mediated deliberation). The system starts every possible behavior as Type 2, then graduates successful behaviors to Type 1 through the prediction-evaluation loop. The ratio of Type 1 to Type 2 is the primary metric of development.

**Critical architectural principle:** Everything in the Decision Making loop must be measurable and attributable to real cognition, not theater. The Shrug Imperative (CANON Immutable Standard 4) is foundational—when nothing rises above the dynamic confidence threshold, Sylphie signals incomprehension rather than selecting a random low-confidence action.

**Five key components emerge from the architecture:**

1. **Episodic Memory** — First-class temporal storage that encodes experiences with attention/arousal gating and graceful degradation
2. **Inner Monologue** — Multiple prediction generation from episodic context, graph retrieval, and LLM capacity
3. **Type 1/Type 2 Arbitration** — Dynamic threshold computation modulated by drive state, confidence floor/ceiling enforcement
4. **Executor Engine** — State machine (8 states: IDLE → CATEGORIZING → PREDICTING → ARBITRATING → RETRIEVING → EXECUTING → OBSERVING → LEARNING)
5. **Confidence Updater** — Three-path outcome logic (reinforced/decayed/counter-indicated) with ACT-R dynamics

**Critical findings from this analysis:**

- The Executor Engine's state machine is well-specified, but the OBSERVING → LEARNING transition must account for episodic memory gating
- The dynamic threshold computation can oscillate if drive cross-modulation is not carefully designed; upper bounds (clamp at 0.70) prevent runaway Type 2 dependency
- The v1 ConfidenceUpdater implementation can be lifted with modification: v1 used counter-indication detection; v2 must add explicit MAE-based prediction classification and Type 1 graduation logic
- Episodic Memory is the highest-risk new component; its consolidation interface must provide both detail-rich recent episodes and semantic decay toward older episodes
- The Shrug Imperative enforcement is not automatic—it requires an explicit "no action above threshold" case in the arbitration logic and an action representing "signal incomprehension"

---

## 1. Component Breakdown & File Structure

### 1.1 Directory Structure

All files live in `src/decision-making/` following the E0 scaffold:

```
src/decision-making/
├── decision-making.module.ts             (config)
├── decision-making.service.ts            (main service, orchestrates loop)
├── decision-making.tokens.ts             (DI tokens)
│
├── episodic-memory/
│   ├── episodic-memory.service.ts       (Episode encoding, consolidation)
│   ├── episodic-memory.types.ts          (Episode, ConsolidationLevel, AttentionGate)
│   ├── episode-consolidator.ts           (Semantic decay, detail reduction)
│   └── index.ts
│
├── prediction/
│   ├── prediction.service.ts             (Core prediction generation)
│   ├── inner-monologue.service.ts        (Multiple candidate generation)
│   ├── prediction-evaluator.service.ts   (MAE computation, classification)
│   ├── prediction.types.ts               (Prediction, PredictionOutcome, MAE)
│   └── index.ts
│
├── arbitration/
│   ├── arbitration.service.ts            (Type 1/Type 2 arbitration logic)
│   ├── arbitration-threshold.service.ts  (Dynamic threshold computation)
│   ├── arbitration.types.ts              (ArbitrationCandidate, ThresholdState)
│   └── index.ts
│
├── executor/
│   ├── executor-engine.service.ts        (State machine, event transitions)
│   ├── executor-engine.types.ts          (ExecutorState enum, ExecutorContext)
│   └── index.ts
│
├── action-retriever/
│   ├── action-retriever.service.ts       (WKG query by context fingerprint)
│   ├── action-bootstrap.service.ts       (Initialize root actions at startup)
│   ├── action-retriever.types.ts         (ActionContext, ContextFingerprint)
│   └── index.ts
│
├── confidence-updater/
│   ├── confidence-updater.service.ts     (Three-path update logic)
│   ├── confidence-updater.types.ts       (OutcomePath, ConfidenceUpdate)
│   └── index.ts
│
├── interfaces/
│   ├── decision-making.interfaces.ts    (IDecisionMakingService, IEpisodicMemoryService)
│   ├── prediction.interfaces.ts         (IPredictionService, IPredictionEvaluator)
│   ├── arbitration.interfaces.ts        (IArbitrationService, IArbitrationThreshold)
│   ├── executor.interfaces.ts           (IExecutorEngine)
│   ├── action-retriever.interfaces.ts   (IActionRetrieverService)
│   ├── confidence-updater.interfaces.ts (IConfidenceUpdaterService)
│   └── index.ts
│
└── index.ts (barrel export)
```

### 1.2 Service Dependencies & Injection

**Decision Making Module imports:**
- `KnowledgeModule` → WKG queries, Confidence reads
- `DriveEngineModule` → Drive state readings (IDriveStateReader)
- `EventsModule` → TimescaleDB writes (IEventService)
- `CommunicationModule` → Input parsing results

**DI tokens (decision-making.tokens.ts):**

```typescript
export const DECISION_MAKING_SERVICE = Symbol('IDecisionMakingService');
export const EPISODIC_MEMORY_SERVICE = Symbol('IEpisodicMemoryService');
export const INNER_MONOLOGUE_SERVICE = Symbol('IInnerMonologueService');
export const PREDICTION_SERVICE = Symbol('IPredictionService');
export const PREDICTION_EVALUATOR = Symbol('IPredictionEvaluator');
export const ARBITRATION_SERVICE = Symbol('IArbitrationService');
export const ARBITRATION_THRESHOLD = Symbol('IArbitrationThreshold');
export const EXECUTOR_ENGINE = Symbol('IExecutorEngine');
export const ACTION_RETRIEVER = Symbol('IActionRetrieverService');
export const CONFIDENCE_UPDATER = Symbol('IConfidenceUpdaterService');
```

---

## 2. State Machine Design: The Executor Engine

### 2.1 State Diagram

```
┌─────────┐
│  IDLE   │ (waiting for input or drive trigger)
└────┬────┘
     │ receive input or drive opportunity
     ▼
┌──────────────┐
│ CATEGORIZING │ (classify input to drive category)
└────┬─────────┘
     │ categorization complete
     ▼
┌───────────┐
│ PREDICTING│ (Inner Monologue: generate 2-5 candidate predictions)
└────┬──────┘
     │ predictions generated
     ▼
┌─────────────┐
│ ARBITRATING │ (Type 1/Type 2 compete; select highest-confidence action)
└────┬────────┘
     │ action selected (or SHRUG if all below threshold)
     ▼
┌────────────┐
│ RETRIEVING │ (Fetch full action procedure from WKG, validate confidence ceiling)
└────┬───────┘
     │ procedure validated
     ▼
┌───────────┐
│ EXECUTING │ (Motor/communication interface executes action)
└────┬──────┘
     │ execution complete
     ▼
┌──────────┐
│ OBSERVING│ (Record outcome to TimescaleDB; emit ActionOutcomeReported)
└────┬─────┘
     │ outcome recorded
     ▼
┌─────────────┐
│  LEARNING   │ (Episodic memory gating; encode or skip; emit LearningEvent)
└────┬────────┘
     │ learning update complete
     ▼
     └──────────────→ IDLE
```

### 2.2 Executor Engine States (TypeScript Enum)

```typescript
// executor-engine.types.ts
export enum ExecutorState {
  IDLE = 'IDLE',
  CATEGORIZING = 'CATEGORIZING',
  PREDICTING = 'PREDICTING',
  ARBITRATING = 'ARBITRATING',
  RETRIEVING = 'RETRIEVING',
  EXECUTING = 'EXECUTING',
  OBSERVING = 'OBSERVING',
  LEARNING = 'LEARNING',
}

export interface ExecutorContext {
  // Immutable throughout one decision cycle
  cycleId: string;
  timestamp: number;
  driveSnapshot: DriveSnapshot;
  inputSource: 'INTERNAL' | 'EXTERNAL';
  inputContent?: string;

  // Mutable as state progresses
  currentState: ExecutorState;
  driveCategory?: DriveCategory;
  predictions?: Prediction[];
  selectedAction?: ArbitrationCandidate;
  actionProcedure?: ActionProcedureData;
  executionResult?: {
    status: 'SUCCESS' | 'FAILURE' | 'PARTIAL';
    outcomeData: Record<string, unknown>;
    latencyMs: number;
  };
  learningDecision?: 'ENCODE' | 'SKIP';
  hasLearned?: boolean;
}
```

### 2.3 State Transitions & Guards

**IDLE → CATEGORIZING**
- Guard: `driveSnapshot.anyDriveAboveBaseline(0.2)` OR `inputReceived()`
- Action: Initialize ExecutorContext, emit ExecutorStateChanged event

**CATEGORIZING → PREDICTING**
- Guard: `driveCategory assigned`
- Action: Call DriveCategorizer.categorizeInput(), pass result to ExecutorContext
- Fallback: If categorization fails, SHRUG (jump to OBSERVING with incomprehension action)

**PREDICTING → ARBITRATING**
- Guard: `predictions.length >= 1` (minimum 1 prediction generated)
- Action: Call InnerMonologue.generatePredictions() → collect 2-5 candidates
- Note: If LLM fails or latency exceeds 5s, fall back to Type 1 only

**ARBITRATING → RETRIEVING**
- Guard: `selectedAction.confidence > dynamicThreshold || selectedAction === SHRUG`
- Action: Call Arbitrator.arbitrate() with Type 1 and Type 2 candidates
- Shrug enforcement: If all Type 1 candidates fail threshold AND Type 2 generates nothing >threshold, select SHRUG action

**RETRIEVING → EXECUTING**
- Guard: `actionProcedure !== null && procedureValid()`
- Action: Call ActionRetriever.retrieve(selectedAction.nodeId) → get full procedure
- Fallback: If retrieval fails, demote action and re-arbitrate

**EXECUTING → OBSERVING**
- Guard: (always succeeds; execution is best-effort)
- Action: Call ExecutionInterface.execute(actionProcedure) → record wall-clock time
- Note: Execution failure is a real outcome, not a lost opportunity

**OBSERVING → LEARNING**
- Guard: (always succeeds)
- Action: Call IEventService.recordActionOutcome() → TimescaleDB write
- Emit: ActionOutcomeReported event to Drive Engine
- Note: Do NOT report to Learning yet; Learning subscribes to ActionOutcomeReported

**LEARNING → IDLE**
- Guard: (always succeeds)
- Action: Apply episodic memory gating (see Episodic Memory section)
- Conditional encoding: If attention > 0.5 OR arousal > 0.6, encode to episodic memory
- Emit: LearningEventEmitted
- Reset: Clear ExecutorContext, return to IDLE

### 2.4 Executor Engine Service Signature

```typescript
// executor/executor-engine.service.ts

export interface IExecutorEngine {
  /**
   * Main tick: advance state machine by one transition.
   * Called ~10Hz by the decision-making service main loop.
   */
  tick(): Promise<void>;

  /**
   * Get current executor state and context.
   */
  getState(): { state: ExecutorState; context: ExecutorContext | null };

  /**
   * Force return to IDLE (emergency stop).
   */
  forceIdle(): void;

  /**
   * Observable of state changes for telemetry/monitoring.
   */
  stateChanged$: Observable<{ from: ExecutorState; to: ExecutorState }>;
}

@Injectable()
export class ExecutorEngineService implements IExecutorEngine {
  private currentState = ExecutorState.IDLE;
  private context: ExecutorContext | null = null;
  private stateChanged$ = new Subject<{ from: ExecutorState; to: ExecutorState }>();

  constructor(
    private driveCategorizer: DriveCategorizer,
    private innerMonologue: InnerMonologueService,
    private arbitration: IArbitrationService,
    private actionRetriever: IActionRetrieverService,
    private executionInterface: ExecutionInterface,
    private eventService: IEventService,
    private episodicMemory: IEpisodicMemoryService,
    private logger: Logger,
  ) {}

  async tick(): Promise<void> {
    // Dispatch to current state's handler
    const handler = this.stateHandlers[this.currentState];
    if (!handler) {
      throw new Error(`No handler for state ${this.currentState}`);
    }
    await handler.call(this);
  }

  private stateHandlers = {
    [ExecutorState.IDLE]: this.handleIdle,
    [ExecutorState.CATEGORIZING]: this.handleCategorizing,
    [ExecutorState.PREDICTING]: this.handlePredicting,
    [ExecutorState.ARBITRATING]: this.handleArbitrating,
    [ExecutorState.RETRIEVING]: this.handleRetrieving,
    [ExecutorState.EXECUTING]: this.handleExecuting,
    [ExecutorState.OBSERVING]: this.handleObserving,
    [ExecutorState.LEARNING]: this.handleLearning,
  };

  private async handleIdle(): Promise<void> {
    // Check for input, drive pressure
    const driveSnapshot = await this.driveReader.getSnapshot();
    const input = await this.inputQueue.dequeue();

    if (!input && !driveSnapshot.anyAboveBaseline(0.2)) {
      // Nothing to do; stay IDLE
      return;
    }

    this.context = {
      cycleId: this.generateCycleId(),
      timestamp: Date.now(),
      driveSnapshot,
      inputSource: input ? 'EXTERNAL' : 'INTERNAL',
      inputContent: input?.content,
      currentState: ExecutorState.CATEGORIZING,
    };

    this.transitionTo(ExecutorState.CATEGORIZING);
  }

  private async handleCategorizing(): Promise<void> {
    // Classify input to drive category
    const category = await this.driveCategorizer.categorize({
      input: this.context.inputContent,
      driveState: this.context.driveSnapshot,
    });

    if (!category) {
      // Cannot categorize; default to general inquiry
      this.context.driveCategory = 'GENERAL';
    } else {
      this.context.driveCategory = category;
    }

    this.transitionTo(ExecutorState.PREDICTING);
  }

  private async handlePredicting(): Promise<void> {
    // Generate 2-5 predictions via Inner Monologue
    const predictions = await this.innerMonologue.generatePredictions({
      context: this.context,
      driveCategory: this.context.driveCategory,
      episodicMemory: await this.episodicMemory.getRecentEpisodes(5),
    });

    this.context.predictions = predictions;

    if (predictions.length === 0) {
      // Fallback: generate single "ask for help" prediction
      this.context.predictions = [this.generateHelpPrediction()];
    }

    this.transitionTo(ExecutorState.ARBITRATING);
  }

  private async handleArbitrating(): Promise<void> {
    // Type 1 vs Type 2 competition
    const selectedCandidate = await this.arbitration.arbitrate({
      predictions: this.context.predictions,
      driveState: this.context.driveSnapshot,
      type1Candidates: await this.getType1Candidates(),
    });

    this.context.selectedAction = selectedCandidate;
    this.transitionTo(ExecutorState.RETRIEVING);
  }

  private async handleRetrieving(): Promise<void> {
    // Fetch procedure from WKG
    const procedure = await this.actionRetriever.retrieve({
      nodeId: this.context.selectedAction.actionNodeId,
      context: this.context,
    });

    if (!procedure) {
      // Cannot retrieve; SHRUG
      this.context.selectedAction = this.generateShrugAction();
    }

    this.context.actionProcedure = procedure;
    this.transitionTo(ExecutorState.EXECUTING);
  }

  private async handleExecuting(): Promise<void> {
    const startTime = Date.now();

    try {
      const result = await this.executionInterface.execute(
        this.context.actionProcedure,
      );

      this.context.executionResult = {
        status: result.success ? 'SUCCESS' : 'PARTIAL',
        outcomeData: result.data,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      this.context.executionResult = {
        status: 'FAILURE',
        outcomeData: { error: error.message },
        latencyMs: Date.now() - startTime,
      };
    }

    this.transitionTo(ExecutorState.OBSERVING);
  }

  private async handleObserving(): Promise<void> {
    // Record to TimescaleDB
    await this.eventService.recordActionOutcome({
      cycleId: this.context.cycleId,
      timestamp: this.context.timestamp,
      actionNodeId: this.context.selectedAction.actionNodeId,
      executionResult: this.context.executionResult,
      driveState: this.context.driveSnapshot,
    });

    this.transitionTo(ExecutorState.LEARNING);
  }

  private async handleLearning(): Promise<void> {
    // Episodic memory gating
    const shouldEncode = await this.episodicMemory.shouldEncode({
      outcome: this.context.executionResult,
      driveState: this.context.driveSnapshot,
      attention: this.context.driveSnapshot.attentionLevel,
      arousal: this.context.driveSnapshot.arousalLevel,
    });

    if (shouldEncode) {
      await this.episodicMemory.encode({
        cycleId: this.context.cycleId,
        input: this.context.inputContent,
        prediction: this.context.predictions[0],
        outcome: this.context.executionResult,
        driveState: this.context.driveSnapshot,
      });
    }

    this.transitionTo(ExecutorState.IDLE);
    this.context = null;
  }

  private transitionTo(nextState: ExecutorState): void {
    const from = this.currentState;
    this.currentState = nextState;
    this.context.currentState = nextState;
    this.stateChanged$.next({ from, to: nextState });
    this.logger.debug(`ExecutorEngine: ${from} → ${nextState}`);
  }

  // ... other methods
}
```

---

## 3. Type 1 / Type 2 Arbitration Algorithm

### 3.1 Architecture Overview

The arbitration service is the core of behavioral development. It is responsible for:
1. Collecting Type 1 candidates (graph-based reflexes with compiled confidence)
2. Collecting Type 2 candidates (LLM-mediated predictions with dynamically-computed confidence)
3. Computing a dynamic confidence threshold modulated by drive state
4. Ranking candidates by confidence
5. Selecting the highest-confidence candidate above the threshold
6. Enforcing the Shrug Imperative if all candidates fall below threshold

### 3.2 Dynamic Threshold Computation

The threshold is NOT static at 0.50. It is computed dynamically based on drive state and modulated by urgency, anxiety, and cognitive load.

```typescript
// arbitration-threshold.service.ts

export interface IArbitrationThreshold {
  computeThreshold(driveSnapshot: DriveSnapshot): number;
}

export class ArbitrationThresholdService implements IArbitrationThreshold {
  /**
   * Compute dynamic confidence threshold based on CANON drive cross-modulation.
   * Base: 0.50
   *
   * Modulations:
   * - Anxiety (>0.6) lowers threshold by 0.10 (makes actions easier to select when afraid)
   * - Curiosity (>0.6) raises threshold by 0.05 (be more picky about what to explore)
   * - Boredom (>0.6) lowers threshold by 0.10 (do something, anything)
   * - Cognitive Load (>0.7) raises threshold by 0.15 (when overloaded, only do high-confidence actions)
   *
   * Floor: 0.30 (never go below; prevents SHRUG from being too common)
   * Ceiling: 0.70 (never go above; prevents Type 2 addict when all drives satisfied)
   */
  computeThreshold(driveSnapshot: DriveSnapshot): number {
    let threshold = 0.50;

    // Anxiety: act faster when scared
    if (driveSnapshot.anxiety > 0.6) {
      threshold -= 0.10;
    }

    // Curiosity: be pickier when curious (explore carefully)
    if (driveSnapshot.curiosity > 0.6) {
      threshold += 0.05;
    }

    // Boredom: lower the bar to do something
    if (driveSnapshot.boredom > 0.6) {
      threshold -= 0.10;
    }

    // Cognitive Load: only do high-confidence things when overloaded
    if (driveSnapshot.cognitiveAwareness > 0.7) {
      threshold += 0.15;
    }

    // System Health: when unhealthy, be more conservative
    if (driveSnapshot.systemHealth < 0.3) {
      threshold += 0.05;
    }

    // Clamp to [0.30, 0.70]
    return Math.max(0.30, Math.min(0.70, threshold));
  }
}
```

### 3.3 Arbitration Service Signature

```typescript
// arbitration.interfaces.ts

export interface ArbitrationCandidate {
  actionNodeId: string;
  actionName: string;
  confidence: number;
  source: 'TYPE1' | 'TYPE2';
  predictedReliability: number; // Based on prediction MAE
  driveRelevance: number; // How well action addresses current drive
  timestamp: number;
}

export interface IArbitrationService {
  /**
   * Core arbitration: rank candidates, select winner.
   * Returns the highest-confidence candidate above threshold,
   * or SHRUG if all are below threshold.
   */
  arbitrate(params: {
    predictions: Prediction[];           // Type 2 candidates from Inner Monologue
    driveState: DriveSnapshot;
    type1Candidates: ActionNode[];       // Type 1 reflexes from WKG
  }): Promise<ArbitrationCandidate>;
}

@Injectable()
export class ArbitrationService implements IArbitrationService {
  constructor(
    private thresholdService: IArbitrationThreshold,
    private confidenceService: IConfidenceService,
    private wkgService: IWkgService,
    private driveReader: IDriveStateReader,
  ) {}

  async arbitrate(params: {
    predictions: Prediction[];
    driveState: DriveSnapshot;
    type1Candidates: ActionNode[];
  }): Promise<ArbitrationCandidate> {
    const { predictions, driveState, type1Candidates } = params;

    // Step 1: Compute dynamic threshold
    const dynamicThreshold = this.thresholdService.computeThreshold(driveState);

    // Step 2: Build Type 1 candidates from graph
    const type1Ranked = await Promise.all(
      type1Candidates.map(async (node) => {
        const confidence = await this.confidenceService.getConfidence(node.id);
        const relevance = this.computeDriveRelevance(node, driveState);

        return {
          actionNodeId: node.id,
          actionName: node.label,
          confidence,
          source: 'TYPE1' as const,
          predictedReliability: confidence, // Type 1 uses confidence as reliability
          driveRelevance: relevance,
          timestamp: Date.now(),
        };
      }),
    );

    // Step 3: Build Type 2 candidates from predictions
    const type2Ranked = predictions.map((pred) => ({
      actionNodeId: pred.actionNodeId,
      actionName: pred.actionName,
      confidence: pred.generatedConfidence,
      source: 'TYPE2' as const,
      predictedReliability: pred.predictedReliability,
      driveRelevance: pred.driveRelevance,
      timestamp: pred.timestamp,
    }));

    // Step 4: Combine and rank by confidence
    const allCandidates = [...type1Ranked, ...type2Ranked]
      .sort((a, b) => b.confidence - a.confidence);

    // Step 5: Select highest above threshold
    const winner = allCandidates.find((c) => c.confidence > dynamicThreshold);

    if (winner) {
      return winner;
    }

    // Step 6: Shrug Imperative — no action above threshold
    return this.generateShrugCandidate();
  }

  private generateShrugCandidate(): ArbitrationCandidate {
    return {
      actionNodeId: 'SHRUG',
      actionName: 'Signal incomprehension',
      confidence: 1.0, // Shrug is always executed if selected
      source: 'TYPE1',
      predictedReliability: 1.0,
      driveRelevance: 0.0,
      timestamp: Date.now(),
    };
  }

  private computeDriveRelevance(
    actionNode: ActionNode,
    driveState: DriveSnapshot,
  ): number {
    // Query the action's recorded drive targets from WKG
    const targetDrives = actionNode.properties?.targetDrives || [];

    let relevance = 0;
    for (const driveName of targetDrives) {
      const driveValue = driveState[driveName] || 0;
      relevance = Math.max(relevance, driveValue);
    }

    return relevance;
  }
}
```

### 3.4 Graduation & Demotion

Type 1 actions are **selected during arbitration**, but they graduate to formal "Type 1 status" asynchronously:

**Graduation trigger:**
- Action executed successfully (prediction evaluated as accurate)
- `confidence > 0.80` AND `prediction MAE < 0.10` over last 10 uses
- Action marked with property `type1_graduated: true` in WKG

**Demotion trigger:**
- Recent prediction MAE > 0.15 for 3+ consecutive uses
- Confidence reduced by 0.15 immediately
- `type1_graduated` property reverted to false
- Drive Engine reports demotion event to Learning

This happens post-hoc, after OBSERVING phase, when Confidence Updater processes the outcome.

---

## 4. Prediction Pipeline

### 4.1 Architecture Overview

Prediction is the heart of learning. Predictions are generated *before* action execution, then evaluated *after*. Accurate predictions confirm behavior; inaccurate predictions drive the Planning subsystem to create new procedures.

**Three phases:**
1. **Generation** (Inner Monologue): What will happen if I do X?
2. **Selection** (Arbitration): Which prediction is most reliable?
3. **Evaluation** (Post-execution): Was I right?

### 4.2 Inner Monologue Service

Inner Monologue generates 2-5 candidate predictions from episodic memory, graph context, and LLM.

```typescript
// prediction/inner-monologue.service.ts

export interface Prediction {
  // Identity
  predictionId: string;
  actionNodeId: string;
  actionName: string;
  timestamp: number;
  cycleId: string;

  // Prediction itself
  predictedOutcome: string;               // What will happen?
  predictedReliability: number;           // Confidence in this prediction
  generatedConfidence: number;            // LLM confidence score (0-1)

  // Context
  contextFingerprint: string;             // Hash of episodic context
  episodicMemoryIds: string[];            // Which episodes informed this?
  driveState: DriveSnapshot;
  driveRelevance: number;                 // How relevant to current drives?

  // Source
  source: 'TYPE1_CACHED' | 'TYPE1_INFERENCE' | 'TYPE2_LLM';
}

export interface IInnerMonologueService {
  /**
   * Generate 2-5 predictions for a given context.
   * Tries Type 1 first (graph-based); supplements with Type 2 (LLM).
   */
  generatePredictions(params: {
    context: ExecutorContext;
    driveCategory: DriveCategory;
    episodicMemory: Episode[];
  }): Promise<Prediction[]>;
}

@Injectable()
export class InnerMonologueService implements IInnerMonologueService {
  constructor(
    private actionRetriever: IActionRetrieverService,
    private wkgService: IWkgService,
    private llmService: ILlmService,
    private confidenceService: IConfidenceService,
    private logger: Logger,
  ) {}

  async generatePredictions(params: {
    context: ExecutorContext;
    driveCategory: DriveCategory;
    episodicMemory: Episode[];
  }): Promise<Prediction[]> {
    const { context, driveCategory, episodicMemory } = params;

    // Step 1: Retrieve Type 1 actions (cached procedures)
    const type1Actions = await this.actionRetriever.retrieve({
      category: driveCategory,
      minConfidence: 0.50,
      limit: 3,
    });

    const predictions: Prediction[] = [];

    // Step 2: For each Type 1 action, generate a prediction
    for (const action of type1Actions) {
      const confidence = await this.confidenceService.getConfidence(action.id);
      const prediction = await this.generateType1Prediction(
        action,
        context,
        confidence,
      );
      predictions.push(prediction);
    }

    // Step 3: Generate Type 2 (LLM) predictions
    // Only if Type 2 cost is acceptable (Cognitive Awareness < 0.8)
    if (context.driveSnapshot.cognitiveAwareness < 0.8) {
      const llmPredictions = await this.generateType2Predictions(
        context,
        episodicMemory,
        predictions.length, // Pass count of Type 1 predictions
      );
      predictions.push(...llmPredictions);
    }

    // Step 4: Rank by generatedConfidence
    predictions.sort((a, b) => b.generatedConfidence - a.generatedConfidence);

    // Return top 5 (or all if <5)
    return predictions.slice(0, 5);
  }

  private async generateType1Prediction(
    action: ActionNode,
    context: ExecutorContext,
    confidence: number,
  ): Promise<Prediction> {
    // Query WKG for the action's PRODUCES_OUTCOME edges
    const outcomes = await this.wkgService.query(`
      MATCH (a:Procedure {id: $id})-[:PRODUCES_OUTCOME]->(o)
      RETURN o.label AS outcome, o.confidence AS outcomeConfidence
    `, { id: action.id });

    const predictedOutcome = outcomes.length > 0
      ? outcomes[0].outcome
      : 'Unknown outcome';

    return {
      predictionId: this.generateId(),
      actionNodeId: action.id,
      actionName: action.label,
      timestamp: Date.now(),
      cycleId: context.cycleId,
      predictedOutcome,
      predictedReliability: confidence,
      generatedConfidence: confidence,
      contextFingerprint: '',
      episodicMemoryIds: [],
      driveState: context.driveSnapshot,
      driveRelevance: this.computeDriveRelevance(action, context),
      source: 'TYPE1_CACHED',
    };
  }

  private async generateType2Predictions(
    context: ExecutorContext,
    episodicMemory: Episode[],
    type1Count: number,
  ): Promise<Prediction[]> {
    // Call LLM with episodic context
    const llmResponse = await this.llmService.generatePredictions({
      context,
      recentEpisodes: episodicMemory,
      driveFocus: context.driveCategory,
      existingType1Count: type1Count,
    });

    // Parse LLM response into Prediction objects
    return llmResponse.predictions.map((pred) => ({
      predictionId: this.generateId(),
      actionNodeId: pred.actionId || 'LLM_GENERATED',
      actionName: pred.actionName,
      timestamp: Date.now(),
      cycleId: context.cycleId,
      predictedOutcome: pred.outcome,
      predictedReliability: pred.confidence,
      generatedConfidence: pred.confidence,
      contextFingerprint: this.hashEpisodes(episodicMemory),
      episodicMemoryIds: episodicMemory.map((e) => e.id),
      driveState: context.driveSnapshot,
      driveRelevance: pred.driveRelevance,
      source: 'TYPE2_LLM',
    }));
  }

  private computeDriveRelevance(
    action: ActionNode,
    context: ExecutorContext,
  ): number {
    const targetDrives = action.properties?.targetDrives || [];
    let relevance = 0;
    for (const driveName of targetDrives) {
      const driveValue = context.driveSnapshot[driveName] || 0;
      relevance = Math.max(relevance, driveValue);
    }
    return relevance;
  }

  private hashEpisodes(episodes: Episode[]): string {
    return episodes.map((e) => e.id).join(':');
  }

  private generateId(): string {
    return `pred_${Date.now()}_${Math.random()}`;
  }
}
```

### 4.3 Prediction Evaluator

After action execution, predictions are evaluated for accuracy. The outcome determines reinforcement/decay signals.

```typescript
// prediction/prediction-evaluator.service.ts

export interface PredictionOutcome {
  predictionId: string;
  predicted: string;
  actual: string;
  mae: number;                           // Mean absolute error (0-1)
  classification: 'ACCURATE' | 'FAILED';
  confidence: number;                    // Based on MAE
  createdAt: number;
}

export interface IPredictionEvaluator {
  /**
   * Evaluate a prediction against actual outcome.
   * Returns MAE and classification.
   */
  evaluatePrediction(params: {
    prediction: Prediction;
    actualOutcome: ExecutionResult;
  }): Promise<PredictionOutcome>;
}

@Injectable()
export class PredictionEvaluatorService implements IPredictionEvaluator {
  constructor(
    private wkgService: IWkgService,
    private logger: Logger,
  ) {}

  async evaluatePrediction(params: {
    prediction: Prediction;
    actualOutcome: ExecutionResult;
  }): Promise<PredictionOutcome> {
    const { prediction, actualOutcome } = params;

    // Compute MAE: semantic distance between predicted and actual
    const mae = await this.computeMAE(
      prediction.predictedOutcome,
      actualOutcome.outcomeDescription,
    );

    // Classification: accurate if MAE < 0.10, failed if MAE > 0.15
    let classification: 'ACCURATE' | 'FAILED';
    if (mae < 0.10) {
      classification = 'ACCURATE';
    } else if (mae > 0.15) {
      classification = 'FAILED';
    } else {
      // Ambiguous (0.10-0.15): treat as accurate but reduce confidence
      classification = 'ACCURATE';
    }

    // Confidence: inversely proportional to MAE
    const confidence = Math.max(0, 1.0 - mae);

    return {
      predictionId: prediction.predictionId,
      predicted: prediction.predictedOutcome,
      actual: actualOutcome.outcomeDescription,
      mae,
      classification,
      confidence,
      createdAt: Date.now(),
    };
  }

  private async computeMAE(
    predicted: string,
    actual: string,
  ): Promise<number> {
    // Semantic similarity metric
    // Simple approach: Levenshtein distance normalized
    // Real implementation: vector embedding comparison or LLM evaluation

    // For now: approximate using string similarity
    const distance = this.levenshteinDistance(predicted, actual);
    const maxLength = Math.max(predicted.length, actual.length);

    // Normalize to [0, 1]
    return Math.min(1, distance / maxLength);
  }

  private levenshteinDistance(a: string, b: string): number {
    // Standard edit distance algorithm
    const aLen = a.length;
    const bLen = b.length;
    const matrix: number[][] = Array(aLen + 1)
      .fill(null)
      .map(() => Array(bLen + 1).fill(0));

    for (let i = 0; i <= aLen; i++) {
      matrix[i][0] = i;
    }
    for (let j = 0; j <= bLen; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= aLen; i++) {
      for (let j = 1; j <= bLen; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost, // substitution
        );
      }
    }

    return matrix[aLen][bLen];
  }
}
```

---

## 5. Episodic Memory: Temporal Experience with Graceful Degradation

### 5.1 Architecture Overview

Episodic Memory is **first-class**—not a query into the WKG, but a separate time-series store that records fine-grained experiences. Episodes flow through three phases:

1. **Encoding** — Recent experience encoded with full detail (gated by attention/arousal)
2. **Consolidation** — Gradual semantic degradation as episodes age
3. **Retrieval** — Return detail-rich recent episodes, abstract older ones

This design prevents the system from developing a "recency bias" while preserving temporal structure.

### 5.2 Episode Schema

```typescript
// episodic-memory/episodic-memory.types.ts

export interface Episode {
  id: string;
  timestamp: number;
  cycleId: string;

  // What happened
  input?: string;                        // User input or drive trigger
  selectedAction: string;                // Action node ID
  actionName: string;
  prediction: {
    predictedOutcome: string;
    generatedConfidence: number;
  };
  outcome: {
    status: 'SUCCESS' | 'FAILURE' | 'PARTIAL';
    actualOutcome: string;
  };

  // How we felt
  driveState: DriveSnapshot;
  attentionLevel: number;                // What was attended to?
  arousalLevel: number;                  // How activated were we?

  // Consolidation state
  consolidationLevel: ConsolidationLevel;
  detailLoss: number;                    // Proportion of detail lost (0-1)
  semanticTags: string[];                // Abstracted categories
  createdAt: number;
  lastAccessedAt: number;
}

export type ConsolidationLevel =
  | 'DETAIL_RICH'    // Fresh episode, full detail
  | 'CONSOLIDATING'  // Losing detail, gaining abstraction
  | 'SEMANTIC';      // Highly abstracted, contributes to semantic memory

export interface IEpisodicMemoryService {
  /**
   * Check if an episode should be encoded (gated by attention/arousal).
   */
  shouldEncode(params: {
    outcome: ExecutionResult;
    driveState: DriveSnapshot;
    attention: number;
    arousal: number;
  }): Promise<boolean>;

  /**
   * Encode a new episode with full detail.
   */
  encode(params: {
    cycleId: string;
    input?: string;
    prediction: Prediction;
    outcome: ExecutionResult;
    driveState: DriveSnapshot;
  }): Promise<Episode>;

  /**
   * Retrieve recent episodes (N most recent).
   * Returns detail-rich episodes that are recent.
   */
  getRecentEpisodes(count: number): Promise<Episode[]>;

  /**
   * Query episodes by context fingerprint or semantic tag.
   */
  queryByContext(fingerprint: string): Promise<Episode[]>;

  /**
   * Consolidation cycle: move detail to semantic, reduce storage.
   * Called periodically (every 100 episodes or 1 hour).
   */
  consolidate(): Promise<void>;
}
```

### 5.3 Episodic Memory Service Implementation

```typescript
// episodic-memory/episodic-memory.service.ts

@Injectable()
export class EpisodicMemoryService implements IEpisodicMemoryService {
  private episodes: Map<string, Episode> = new Map();
  private recentBuffer: Episode[] = []; // Ring buffer of last 50 episodes
  private consolidationThreshold = 100;  // Consolidate every N episodes

  constructor(
    private timescaleDb: IEventService,
    private consolidator: EpisodeConsolidator,
    private logger: Logger,
  ) {}

  async shouldEncode(params: {
    outcome: ExecutionResult;
    driveState: DriveSnapshot;
    attention: number;
    arousal: number;
  }): Promise<boolean> {
    const { attention, arousal, outcome } = params;

    // Encode if:
    // 1. Attention > 0.5 (episode was attended to), OR
    // 2. Arousal > 0.6 (episode was emotionally significant), OR
    // 3. Outcome was failure (learning opportunity)

    if (attention > 0.5 || arousal > 0.6 || outcome.status === 'FAILURE') {
      return true;
    }

    // Random sampling of background successes (10% chance)
    if (outcome.status === 'SUCCESS' && Math.random() < 0.1) {
      return true;
    }

    return false;
  }

  async encode(params: {
    cycleId: string;
    input?: string;
    prediction: Prediction;
    outcome: ExecutionResult;
    driveState: DriveSnapshot;
  }): Promise<Episode> {
    const episodeId = `ep_${Date.now()}_${this.generateId()}`;

    const episode: Episode = {
      id: episodeId,
      timestamp: Date.now(),
      cycleId: params.cycleId,
      input: params.input,
      selectedAction: params.prediction.actionNodeId,
      actionName: params.prediction.actionName,
      prediction: {
        predictedOutcome: params.prediction.predictedOutcome,
        generatedConfidence: params.prediction.generatedConfidence,
      },
      outcome: {
        status: params.outcome.status,
        actualOutcome: params.outcome.outcomeDescription,
      },
      driveState: params.driveState,
      attentionLevel: params.driveState.attentionLevel || 0.5,
      arousalLevel: params.driveState.arousalLevel || 0.3,
      consolidationLevel: 'DETAIL_RICH',
      detailLoss: 0,
      semanticTags: this.generateSemanticTags(params.prediction.actionName),
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };

    // Store in-memory
    this.episodes.set(episodeId, episode);
    this.recentBuffer.push(episode);
    if (this.recentBuffer.length > 50) {
      this.recentBuffer.shift();
    }

    // Write to TimescaleDB for persistence
    await this.timescaleDb.recordEpisode(episode);

    // Check if consolidation is needed
    if (this.episodes.size >= this.consolidationThreshold) {
      await this.consolidate();
    }

    return episode;
  }

  async getRecentEpisodes(count: number): Promise<Episode[]> {
    // Return the last N episodes from the ring buffer
    const start = Math.max(0, this.recentBuffer.length - count);
    return this.recentBuffer.slice(start);
  }

  async queryByContext(fingerprint: string): Promise<Episode[]> {
    // Return episodes whose semantic tags match the fingerprint
    const episodes = Array.from(this.episodes.values())
      .filter((ep) => ep.semanticTags.some((tag) => fingerprint.includes(tag)))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);

    return episodes;
  }

  async consolidate(): Promise<void> {
    this.logger.debug('EpisodicMemory: consolidation cycle started');

    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

    for (const [id, episode] of this.episodes.entries()) {
      const ageMs = now - episode.createdAt;

      if (ageMs > maxAge) {
        // Delete very old episodes
        this.episodes.delete(id);
        continue;
      }

      // Determine consolidation level based on age
      const ageHours = ageMs / (60 * 60 * 1000);

      if (ageHours < 1) {
        episode.consolidationLevel = 'DETAIL_RICH';
        episode.detailLoss = 0;
      } else if (ageHours < 24) {
        episode.consolidationLevel = 'CONSOLIDATING';
        episode.detailLoss = Math.min(0.5, ageHours / 24);
      } else {
        episode.consolidationLevel = 'SEMANTIC';
        episode.detailLoss = Math.min(1.0, (ageHours - 24) / 72);
      }
    }

    this.logger.debug(
      `EpisodicMemory: consolidation complete. Episodes: ${this.episodes.size}`,
    );
  }

  private generateSemanticTags(actionName: string): string[] {
    // Extract abstract categories from action name
    // E.g., "ask_for_help" -> ["QUESTION", "SOCIAL", "SEEKING"]

    const tags: string[] = [];

    if (actionName.includes('ask') || actionName.includes('question')) {
      tags.push('QUESTION');
    }
    if (actionName.includes('social') || actionName.includes('talk')) {
      tags.push('SOCIAL');
    }
    if (actionName.includes('learn') || actionName.includes('explore')) {
      tags.push('EXPLORATORY');
    }
    if (actionName.includes('rest') || actionName.includes('wait')) {
      tags.push('IDLE');
    }

    return tags.length > 0 ? tags : ['GENERAL'];
  }

  private generateId(): string {
    return Math.random().toString(36).substring(7);
  }
}
```

---

## 6. Inner Monologue: Multiple Prediction Generation

Inner Monologue is responsible for generating 2-5 diverse candidate predictions. It tries Type 1 first (retrieval from WKG), then supplements with Type 2 (LLM generation) if budget permits.

**Key design principle:** Do not call the LLM unless Type 2 cost is acceptable. Cognitive Awareness drive pressure signals when the system is cognitively overloaded; if Cognitive Awareness > 0.80, skip Type 2.

The implementation is in prediction/inner-monologue.service.ts (see section 4.2).

---

## 7. Action Retriever: WKG Query Patterns

### 7.1 Context Fingerprinting

Before retrieving actions, the system computes a **context fingerprint** — a hash of the current drive state, episodic memory, and input category. This enables the WKG query to be targeted rather than scanning the entire graph.

```typescript
// action-retriever/action-retriever.types.ts

export interface ContextFingerprint {
  driveCategory: DriveCategory;
  episodicHash: string;                  // Hash of recent episodes
  dominantDrive: string;                 // Highest-activation drive
  secondaryDrive: string;                // Second-highest
  inputHash: string;                     // Hash of input content
}

export interface ActionContext {
  category: DriveCategory;
  minConfidence: number;
  limit: number;
  fingerprint?: ContextFingerprint;
  excludeNodeIds?: string[];             // Don't re-retrieve failed actions
}
```

### 7.2 Action Retriever Service

```typescript
// action-retriever/action-retriever.service.ts

export interface IActionRetrieverService {
  /**
   * Retrieve action nodes from WKG by context.
   * Uses context fingerprint to narrow query scope.
   */
  retrieve(context: ActionContext): Promise<ActionNode[]>;

  /**
   * Bootstrap action tree at startup.
   * Ensure all root actions (SHRUG, HELP, etc.) exist.
   */
  bootstrapActionTree(): Promise<void>;
}

@Injectable()
export class ActionRetrieverService implements IActionRetrieverService {
  constructor(
    private wkgService: IWkgService,
    private confidenceService: IConfidenceService,
    private logger: Logger,
  ) {}

  async retrieve(context: ActionContext): Promise<ActionNode[]> {
    // Step 1: Compute context fingerprint if not provided
    const fingerprint = context.fingerprint || this.computeFingerprint(context);

    // Step 2: Query WKG for actions in the category
    const query = `
      MATCH (proc:Procedure)
      WHERE proc.category = $category
      AND proc.confidence >= $minConfidence
      RETURN proc
      ORDER BY proc.confidence DESC
      LIMIT $limit
    `;

    const nodes = await this.wkgService.query(query, {
      category: context.category,
      minConfidence: context.minConfidence,
      limit: context.limit,
    });

    // Step 3: Filter out excluded nodes
    return nodes.filter((n) => !context.excludeNodeIds?.includes(n.id));
  }

  async bootstrapActionTree(): Promise<void> {
    this.logger.debug('ActionRetriever: bootstrapping root action tree');

    // Ensure root actions exist
    const rootActions = [
      { id: 'SHRUG', label: 'Signal incomprehension', category: 'GENERAL' },
      { id: 'HELP', label: 'Ask for help', category: 'GENERAL' },
      { id: 'WAIT', label: 'Wait for input', category: 'GENERAL' },
    ];

    for (const action of rootActions) {
      const exists = await this.wkgService.nodeExists(action.id);
      if (!exists) {
        await this.wkgService.createNode({
          id: action.id,
          labels: ['Procedure', 'ROOT_ACTION'],
          properties: {
            label: action.label,
            category: action.category,
            confidence: 0.95,
            provenance: 'SYSTEM',
            type1_graduated: true,
          },
        });
      }
    }

    this.logger.debug('ActionRetriever: bootstrap complete');
  }

  private computeFingerprint(context: ActionContext): ContextFingerprint {
    // Placeholder: real implementation would hash episodic context
    return {
      driveCategory: context.category,
      episodicHash: '',
      dominantDrive: context.category,
      secondaryDrive: 'GENERAL',
      inputHash: '',
    };
  }
}
```

---

## 8. Confidence Updater: ACT-R Dynamics & Outcome Processing

### 8.1 Three-Path Outcome Logic

After action execution, the Drive Engine reports the outcome (success/failure/partial). The Confidence Updater processes this through **three mutually-exclusive paths**:

1. **Counter-Indication Path:** Prediction failed in a way that contradicts knowledge
2. **No Relief Path:** Prediction was accurate, but outcome didn't reduce drive pressure
3. **Relief Path:** Prediction was accurate AND outcome reduced drive pressure

```typescript
// confidence-updater/confidence-updater.service.ts

export type OutcomePath =
  | 'COUNTER_INDICATED'   // Prediction failed; knowledge is wrong
  | 'NO_RELIEF'           // Prediction correct but didn't help
  | 'REINFORCED';         // Prediction correct and relieved drive

export interface ConfidenceUpdate {
  nodeId: string;
  oldConfidence: number;
  newConfidence: number;
  outcomePath: OutcomePath;
  change: number;
  reason: string;
}

export interface IConfidenceUpdaterService {
  /**
   * Update confidence of an action based on outcome.
   * Returns the update operation for logging.
   */
  update(params: {
    actionNodeId: string;
    prediction: Prediction;
    outcome: ExecutionResult;
    driveState: DriveSnapshot;
  }): Promise<ConfidenceUpdate>;
}

@Injectable()
export class ConfidenceUpdaterService implements IConfidenceUpdaterService {
  constructor(
    private confidenceService: IConfidenceService,
    private predictionEvaluator: IPredictionEvaluator,
    private eventService: IEventService,
    private logger: Logger,
  ) {}

  async update(params: {
    actionNodeId: string;
    prediction: Prediction;
    outcome: ExecutionResult;
    driveState: DriveSnapshot;
  }): Promise<ConfidenceUpdate> {
    const { actionNodeId, prediction, outcome, driveState } = params;

    // Step 1: Evaluate prediction
    const predictionOutcome = await this.predictionEvaluator.evaluatePrediction({
      prediction,
      actualOutcome: outcome,
    });

    // Step 2: Get current confidence
    const oldConfidence = await this.confidenceService.getConfidence(actionNodeId);

    // Step 3: Determine outcome path
    let outcomePath: OutcomePath;
    let confidenceChange: number;

    if (predictionOutcome.classification === 'FAILED') {
      // Prediction was wrong; knowledge is incorrect
      outcomePath = 'COUNTER_INDICATED';

      // Check if anxiety amplification applies
      if (driveState.anxiety > 0.7) {
        confidenceChange = -0.02 * 1.5; // 1.5x amplification
      } else {
        confidenceChange = -0.02;
      }
    } else if (this.didOutcomeRelieveDrive(outcome, driveState)) {
      // Prediction was correct AND outcome helped
      outcomePath = 'REINFORCED';

      // Apply ACT-R formula
      const retrievalCount = await this.confidenceService.getRetrievalCount(
        actionNodeId,
      );
      const newConfidence = this.computeACTRConfidence({
        base: await this.confidenceService.getBaseConfidence(actionNodeId),
        retrievalCount: retrievalCount + 1,
        hoursSinceRetrieval: 0,
        decayRate: await this.confidenceService.getDecayRate(actionNodeId),
      });

      confidenceChange = newConfidence - oldConfidence;
    } else {
      // Prediction was correct but didn't help
      outcomePath = 'NO_RELIEF';
      confidenceChange = -0.01;
    }

    // Step 4: Apply change (clamped to [0, 1])
    const newConfidence = Math.max(0, Math.min(1, oldConfidence + confidenceChange));

    // Step 5: Update in Knowledge module
    await this.confidenceService.setConfidence(actionNodeId, newConfidence);

    // Step 6: Log the update
    const update: ConfidenceUpdate = {
      nodeId: actionNodeId,
      oldConfidence,
      newConfidence,
      outcomePath,
      change: confidenceChange,
      reason: this.generateReason(outcomePath, confidenceChange),
    };

    await this.eventService.recordConfidenceUpdate(update);

    this.logger.debug(
      `Confidence: ${actionNodeId} ${oldConfidence.toFixed(2)} → ${newConfidence.toFixed(2)} (${outcomePath})`,
    );

    return update;
  }

  private didOutcomeRelieveDrive(
    outcome: ExecutionResult,
    driveState: DriveSnapshot,
  ): boolean {
    // Check if outcome moved drive state in a relief direction
    // This is recorded in the outcome data by Drive Engine

    if (outcome.status === 'FAILURE') {
      return false;
    }

    // Get relief info from outcome
    const reliefInfo = outcome.driveRelief || { relievedDrives: [] };

    return reliefInfo.relievedDrives.length > 0;
  }

  private computeACTRConfidence(params: ACTRParams): number {
    const { base, retrievalCount, hoursSinceRetrieval, decayRate } = params;
    const decay = decayRate * Math.log(hoursSinceRetrieval + 1);

    if (retrievalCount === 0) {
      return Math.min(0.60, base - decay);
    }

    return Math.min(1.0, base + 0.12 * Math.log(retrievalCount) - decay);
  }

  private generateReason(outcomePath: OutcomePath, change: number): string {
    if (outcomePath === 'COUNTER_INDICATED') {
      return 'Prediction failed; knowledge unreliable';
    }
    if (outcomePath === 'REINFORCED') {
      return `Action successful; gained ${(change * 100).toFixed(1)}% confidence`;
    }
    return 'Action succeeded but did not relieve drive';
  }
}
```

---

## 9. Dependencies on Other Epics

### 9.1 Hard Dependencies

**E2 (Events: TimescaleDB Backbone)**
- Decision Making writes decision events to TimescaleDB
- Reads prediction outcomes from TimescaleDB (for evaluation)
- Episodic Memory persists episodes to TimescaleDB
- IEventService interface must be implemented with methods:
  - `recordActionOutcome()`
  - `recordEpisode()`
  - `recordConfidenceUpdate()`
  - `recordExecutorStateChange()`

**E3 (Knowledge: WKG + Confidence)**
- Action Retriever queries WKG for Procedure nodes
- Confidence Updater reads/writes confidence values via IConfidenceService
- Arbitration Service reads action properties from WKG
- Prediction Service queries PRODUCES_OUTCOME edges
- IWkgService and IConfidenceService must be fully specified in E0

**E4 (Drive Engine: Drive State Reader)**
- Executor Engine reads current DriveSnapshot at every cycle
- Arbitration Service uses drive state to compute dynamic threshold
- Confidence Updater checks anxiety level for amplification
- IDriveStateReader interface must expose:
  - `getSnapshot(): Promise<DriveSnapshot>`
  - `driveState$: Observable<DriveSnapshot>`

### 9.2 Soft Dependencies (Can Work with Stubs)

**Communication Module:**
- Provides parsed input to Decision Making
- Must implement IInputParsingService

**Learning Module:**
- Subscribes to LearningEventEmitted from Executor
- Must implement ILearningService to handle episodic consolidation callbacks

---

## 10. Risks & Open Questions

### 10.1 Critical Risks

#### Risk 1: Dynamic Threshold Oscillation (MEDIUM)
**Problem:** If the dynamic threshold computation has too many modulations with strong amplitudes, the system can oscillate between IDLE and high-action states.

**Mitigation:**
- Cap all modulations at ±0.15
- Use smoothing: threshold(t) = 0.7 * threshold(t-1) + 0.3 * newThreshold
- Test with 1000+ cycles of recorded drive data

**Action for E5:** Implement threshold smoothing in ArbitrationThresholdService

#### Risk 2: Type 2 Addiction (HIGH)
**Problem:** If LLM-generated predictions always have high confidence, Type 1 never develops.

**Mitigation:**
- LLM predictions start with confidence = 0.35 (lower than SENSOR 0.40)
- Type 2 carries explicit latency cost reported to Drive Engine
- Confidence Updater must NOT boost LLM_GENERATED source faster than Type 1
- Monitor Type 1/Type 2 ratio; if Type 2 >80% after 100 cycles, investigate

**Action for E5:** Implement cost tracking; emit HighType2Ratio alert to telemetry

#### Risk 3: Episodic Memory Explosion (MEDIUM)
**Problem:** If every action is encoded to episodic memory, storage explodes.

**Mitigation:**
- Implement strict gating: only encode if attention > 0.5 OR arousal > 0.6 OR failure
- Consolidation cycle runs every 100 episodes or 1 hour
- Delete episodes older than 7 days
- Ring buffer of 50 recent episodes always kept in-memory

**Action for E5:** Implement consolidation cycle with TimescaleDB pruning

#### Risk 4: Shrug Overuse (LOW)
**Problem:** If threshold is too high, Sylphie signals incomprehension constantly.

**Mitigation:**
- Shrug is a valid action but tracked as a metric
- If SHRUG >20% of actions over 50-cycle window, lower threshold floor
- Monitor SHRUG frequency in telemetry dashboard

**Action for E5:** Add shrug counter to metrics; emit alert if >20%

### 10.2 Open Questions

**Q1: What is the correct MAE threshold for Type 1 graduation?**
- Current CANON spec: MAE < 0.10
- But MAE is measured by Levenshtein distance on outcome descriptions
- Is 0.10 (10% difference) achievable? Too strict?
- **Resolution:** Run pilot with prototype; adjust based on real data

**Q2: Should Inner Monologue prefer Type 1 candidates or diversify?**
- Current design: retrieve top 3 Type 1, generate Type 2, rank by confidence
- Alternative: force diversity (1 Type 1, 4 Type 2) to explore more
- **Resolution:** Implement preference control; test both in pilot

**Q3: How does prediction evaluation work for stochastic outcomes?**
- If action is "roll a die," prediction "you'll get 1-6" is always correct
- But prediction "you'll get a 3" is usually wrong
- MAE doesn't capture this
- **Resolution:** Classify some actions as inherently stochastic; use probabilistic MAE

**Q4: Episodic memory consolidation — when should episodes move between levels?**
- Current design: DETAIL_RICH (0h), CONSOLIDATING (0-24h), SEMANTIC (>24h)
- Is 24h the right threshold? Too fast?
- **Resolution:** Tunable parameter; start with 24h, adjust after pilot

### 10.3 Implementation Gotchas

**Gotcha 1: Episodic Memory Ring Buffer Thread Safety**
- Ring buffer is updated from Executor thread (LEARNING state)
- Retrieved by Prediction thread (Inner Monologue)
- **Mitigation:** Use immutable copy at retrieval; buffer never modified in-place

**Gotcha 2: ACT-R Confidence Decay Over Time**
- Confidence degrades if action not used (seen in WKG queries)
- But Executor may execute the same action multiple times per second
- Decay may not fire if all executions are rapid
- **Mitigation:** Decay is computed at query-time, not continuously; handles rapid reuse

**Gotcha 3: Prediction Generation Latency**
- Inner Monologue calls LLM, which has ~1-3s latency
- If latency exceeds budget (5s), fall back to Type 1 only
- But timeout handling in NestJS is tricky
- **Mitigation:** Use Promise.race() with timeout; catch timeout as LLM failure

---

## 11. v1 Code That Can Be Lifted

The Sylphie project has a predecessor (co-being) with working executor and confidence logic. The following services can be lifted with modification:

### 11.1 ExecutorEngineService

**Source:** `co-being/src/executor-engine.service.ts`
**Status:** ~80% usable

**Modifications needed:**
- Rename states (v1 has 6, v2 has 8; add CATEGORIZING and LEARNING)
- Add episodic memory gating in LEARNING state
- Update DriveSnapshot interface to match E4 (12 drives, not 6)
- Update ExecutorContext to include prediction objects

**Reusable logic:**
- State transition dispatch table (stateHandlers)
- State change emission (stateChanged$ Observable)
- Force-to-IDLE mechanism

### 11.2 ConfidenceUpdaterService

**Source:** `co-being/src/confidence-updater.service.ts`
**Status:** ~70% usable

**Modifications needed:**
- Add MAE-based prediction classification (v1 only had outcome success/failure)
- Add anxiety amplification check
- Add Type 1 graduation logic (confidence > 0.80 AND MAE < 0.10)
- Add Type 1 demotion logic (MAE > 0.15)
- Update ACT-R formula to match CANON (0.12 * ln(count))

**Reusable logic:**
- Three-path outcome logic (COUNTER_INDICATED / NO_RELIEF / REINFORCED)
- Counter-indication detection pattern
- ACT-R confidence computation function

### 11.3 ActionRetrieverService

**Source:** `co-being/src/action-retriever.service.ts`
**Status:** ~60% usable

**Modifications needed:**
- Update WKG query syntax (v1 uses different OGM; v2 uses Cypher)
- Add context fingerprinting (new in v2)
- Update Procedure node schema (confidence property, provenance, type1_graduated)
- Add bootstrapActionTree (new in v2)

**Reusable logic:**
- Category-based filtering
- Confidence threshold filtering
- Confidence-sorted result ordering

---

## 12. Implementation Priorities & Ticket Breakdown

**Phase 1: Core State Machine & Arbitration**
- E5-T001: ExecutorEngineService + 8-state state machine
- E5-T002: Arbitration Service + dynamic threshold computation
- E5-T003: Action Retriever Service + WKG queries

**Phase 2: Prediction & Evaluation**
- E5-T004: InnerMonologueService + Type 1/Type 2 prediction generation
- E5-T005: PredictionEvaluatorService + MAE computation
- E5-T006: ConfidenceUpdaterService + three-path outcome logic

**Phase 3: Episodic Memory (Highest Risk)**
- E5-T007: EpisodicMemoryService + encoding & consolidation
- E5-T008: Episode consolidator + semantic degradation
- E5-T009: Episode retrieval + context fingerprinting

**Phase 4: Integration & Testing**
- E5-T010: Decision Making main service + loop orchestration
- E5-T011: Integration with E2, E3, E4
- E5-T012: End-to-end tests + pilot run on recorded data

---

## 13. Validation Checklist

By end of E5, verify:

- [ ] Executor Engine completes 8-state cycle ~100ms per cycle (10Hz)
- [ ] Dynamic threshold oscillates <0.10 over 100 cycles
- [ ] Type 1 candidates appear within 50 cycles (graduation happens)
- [ ] Type 2 < 70% of actions after 200 cycles
- [ ] Episodic Memory consolidation completes in <100ms
- [ ] SHRUG appears <15% of the time
- [ ] Prediction MAE stabilizes after initial failures
- [ ] Confidence values increase monotonically for successful actions
- [ ] No memory leaks (episode buffer bounded)
- [ ] All state transitions properly logged
- [ ] All CANON immutable standards enforced (Theater, Contingency, Ceiling, Shrug, Guardian asymmetry, No self-modification)

---

## Conclusion

Epic 5 is the realization of Sylphie's core cognitive loop. It is large, architecturally complex, and carries significant execution risk (especially Episodic Memory). But it is the moment where Sylphie becomes more than a collection of databases—she becomes a cognitive agent that learns through prediction, experience, and drive-mediated behavior selection.

The design is sound but not over-specified. Implementation will reveal edge cases. The goal is to start with the provided architecture, implement each component methodically, test end-to-end, and document surprises as they emerge.

**Next step:** Begin E5-T001 (ExecutorEngineService) using the lifted code from co-being as a starting point. Expect 2-3 weeks of focused implementation work.
