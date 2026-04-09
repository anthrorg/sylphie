/**
 * Decision Making module interface contracts.
 *
 * CANON §Subsystem 1 (Decision Making): The central cognitive loop. Receives
 * sensory input (SensoryFrame), retrieves action candidates from the WKG, runs
 * Type 1 / Type 2 arbitration, executes, observes, and encodes the episode.
 * These interfaces define every public contract inside that loop.
 *
 * CANON §Dual-Process Cognition: All action selection starts as Type 2 (LLM-
 * assisted) and graduates to Type 1 (graph reflex) through successful repetition.
 * The IArbitrationService and IPredictionService are the structural enforcement
 * of that discipline.
 *
 * CANON Immutable Standard 4 (Shrug Imperative): IArbitrationService.arbitrate()
 * returns an ArbitrationResult whose SHRUG variant is the required response when
 * no candidate clears the dynamic action threshold. Random low-confidence action
 * selection is superstitious behavior and is structurally prevented here.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): CognitiveContext carries the
 * current DriveSnapshot so Communication can correlate output with actual drive
 * state without making an extra read call.
 *
 * Adaptation from sylphie-old:
 * - Input type changed from CategorizedInput to SensoryFrame (multimodal fusion)
 * - CognitiveContext enriched with recentGapTypes and dynamicThreshold
 * - IContradictionScannerService added (co-being Validation Phase improvement)
 * - IConsolidationService included for episodic memory consolidation
 */

import type { Observable } from 'rxjs';
import type {
  DriveSnapshot,
  SensoryFrame,
  ActionCandidate,
  ArbitrationResult,
  ActionOutcome,
  ExecutorState,
  Episode,
  EpisodeInput,
  EncodingDepth,
  Prediction,
  PredictionEvaluation,
  CognitiveContext,
  ThresholdResult,
  GapType,
  ContradictionScanResult,
  ConsolidationCandidate,
  SemanticConversion,
  ConsolidationResult,
  GraduationState,
  GraduationRecord,
  CycleResponse,
} from '@sylphie/shared';

// ---------------------------------------------------------------------------
// IDecisionMakingService — main facade
// ---------------------------------------------------------------------------

/**
 * Primary public interface for the Decision Making subsystem.
 *
 * This is the only interface exported from the module that other subsystems
 * interact with directly. Communication calls processInput() to begin a
 * decision cycle; it calls getCognitiveContext() to assemble LLM prompts;
 * it calls reportOutcome() to feed observed results back into the loop.
 *
 * CANON §Subsystem 1 (Decision Making): The cognitive loop runs entirely inside
 * this service. No other subsystem triggers arbitration, prediction, or episodic
 * encoding directly.
 *
 * Injection token: DECISION_MAKING_SERVICE (decision-making.tokens.ts)
 * Provided by:    DecisionMakingService
 */
export interface IDecisionMakingService {
  /**
   * Observable stream of cycle responses.
   *
   * Emits a CycleResponse at the end of every decision cycle. Communication
   * subscribes to this stream to receive executor output, assemble full
   * response context, validate Theater Prohibition, and deliver to clients.
   *
   * TYPE_1 and TYPE_2 results carry LLM-generated text. SHRUG results carry
   * empty text — Communication decides how to express incomprehension based
   * on the shrugDetail gap types in the ArbitrationResult.
   */
  readonly response$: Observable<CycleResponse>;

  /**
   * Trigger the full decision cycle for a sensory frame.
   *
   * Transitions the Executor Engine through the full state sequence:
   * CATEGORIZING -> RETRIEVING -> PREDICTING -> ARBITRATING -> EXECUTING ->
   * OBSERVING -> LEARNING -> IDLE
   *
   * The method returns once the cycle completes (LEARNING state exits).
   * It emits DECISION_CYCLE_STARTED and all downstream events to TimescaleDB.
   *
   * Adaptation from sylphie-old: Takes SensoryFrame (multimodal fused embedding
   * + raw modality data) instead of CategorizedInput (text + entities).
   *
   * @param frame - Fused sensory frame from the multimodal pipeline.
   * @throws {DecisionMakingException} If the executor is not in IDLE state when
   *         called, or if a non-recoverable error occurs during the cycle.
   */
  processInput(frame: SensoryFrame): Promise<void>;

  /**
   * Return the current cognitive context for LLM prompt assembly.
   *
   * Called by Communication before invoking the LLM for Type 2 deliberation or
   * response generation. Provides a snapshot of the executor state, recent
   * episodic memory, active predictions, the current drive snapshot, and recent
   * gap types from SHRUG outcomes.
   *
   * This method is synchronous because all source data is in-memory. It never
   * queries the WKG or TimescaleDB.
   *
   * CANON Standard 1 (Theater Prohibition): The driveSnapshot in the returned
   * CognitiveContext is the ground truth the LLM must use to speak authentically.
   *
   * @returns CognitiveContext — never null, never throws.
   */
  getCognitiveContext(): CognitiveContext;

  /**
   * Report the observed outcome of an executed action back into the loop.
   *
   * Called by Communication after an action's output has been delivered and
   * any guardian response has been collected. Triggers prediction evaluation,
   * confidence updates, and Type 1 graduation checks.
   *
   * CANON Standard 2 (Contingency Requirement): The actionId inside
   * outcome.selectedAction must be the WKG procedure node ID of the action
   * that was executed. Without it, contingency attribution is impossible.
   *
   * @param actionId - WKG procedure node ID of the executed action.
   * @param outcome  - The full observed outcome including drive effects.
   * @throws {DecisionMakingException} If actionId does not correspond to an
   *         action in the current or most recent decision cycle.
   */
  reportOutcome(actionId: string, outcome: ActionOutcome): Promise<void>;
}

// ---------------------------------------------------------------------------
// IEpisodicMemoryService
// ---------------------------------------------------------------------------

/**
 * Interface for storing and retrieving episodic experiences.
 *
 * Episodic memory is the in-process, in-memory record of recent experiences.
 * It is NOT the WKG. The Learning subsystem may eventually promote episode
 * content into WKG nodes, but the episodic store itself is local to
 * DecisionMakingModule.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory provides context for
 * the Executor loop (recent history for Type 1 candidate selection) and for
 * Communication (recentEpisodes in CognitiveContext).
 *
 * Injection token: EPISODIC_MEMORY_SERVICE (decision-making.tokens.ts)
 * Provided by:    EpisodicMemoryService
 */
export interface IEpisodicMemoryService {
  /**
   * Encode a new experience into episodic memory.
   *
   * The encodingDepth determines how much data is captured. SKIP returns null
   * immediately. SHALLOW stores minimal fields. DEEP stores all fields including
   * full prediction correlation.
   *
   * A EPISODE_ENCODED event is emitted to TimescaleDB for all depths except SKIP.
   *
   * @param input         - The raw experience data to encode.
   * @param encodingDepth - How thoroughly to encode this episode.
   * @returns The encoded Episode, or null if encodingDepth is SKIP.
   * @throws {DecisionMakingException} If encoding fails due to a storage error.
   */
  encode(input: EpisodeInput, encodingDepth: EncodingDepth): Promise<Episode | null>;

  /**
   * Return the most recent episodes in reverse-chronological order.
   *
   * Used to populate CognitiveContext.recentEpisodes for LLM prompt assembly.
   * The returned array is read-only — callers must not modify it.
   *
   * @param count - Maximum number of episodes to return. Defaults to 10.
   * @returns Read-only array of episodes, newest first. Empty if no episodes.
   */
  getRecentEpisodes(count?: number): readonly Episode[];

  /**
   * Query episodes by context fingerprint similarity.
   *
   * Returns episodes whose contextFingerprint has cosine similarity > 0.7
   * with the given fingerprint (CANON §A.15). Used by the guilt repair
   * attribution logic and by IActionRetrieverService to find relevant prior
   * episodes before candidate retrieval.
   *
   * @param contextFingerprint - The fingerprint to query against.
   * @param limit              - Maximum results to return. Defaults to 5.
   * @returns Read-only array of matching episodes, sorted by ageWeight descending.
   */
  queryByContext(contextFingerprint: string, limit?: number): readonly Episode[];

  /**
   * Return the total number of episodes currently stored.
   *
   * Used by the executor loop for capacity management decisions (e.g.,
   * evicting low-ageWeight episodes when storage pressure is high) and by
   * the dashboard for diagnostic display.
   *
   * @returns Non-negative integer count.
   */
  getEpisodeCount(): number;

  /** Clear all episodes from memory (e.g., on system reset). */
  clear(): void;
}

// ---------------------------------------------------------------------------
// IArbitrationService
// ---------------------------------------------------------------------------

/**
 * Interface for the Type 1 / Type 2 / SHRUG arbitration process.
 *
 * CANON §Dual-Process Cognition: Takes a set of action candidates and the
 * current drive snapshot, applies the dynamic action threshold, and returns
 * the arbitration decision. This is the structural boundary between graph-
 * based reflex (Type 1) and LLM-assisted deliberation (Type 2).
 *
 * CANON Immutable Standard 4 (Shrug Imperative): When no candidate exceeds
 * the threshold, the SHRUG variant is returned. This is not optional — the
 * caller must handle it, and random low-confidence selection is structurally
 * prevented by the ArbitrationResult discriminated union.
 *
 * Injection token: ARBITRATION_SERVICE (decision-making.tokens.ts)
 * Provided by:    ArbitrationService
 */
export interface IArbitrationService {
  /**
   * Select an action from the given candidates against the current drive state.
   *
   * Evaluates each candidate's confidence against the dynamic action threshold
   * (derived from driveSnapshot). If the best Type 1 candidate clears the
   * threshold, returns TYPE_1. Otherwise invokes Type 2 LLM deliberation.
   * If neither produces an actionable result, returns SHRUG.
   *
   * Before committing TYPE_1 or TYPE_2, runs contradiction scanning. If
   * contradictions are found, the result may be downgraded to SHRUG with
   * GapType.CONTRADICTION.
   *
   * CANON Standard 4 (Shrug Imperative): Returning SHRUG is the correct
   * behavior when no candidate is above threshold. This method never returns
   * a random low-confidence candidate — the discriminated union makes that
   * structurally impossible.
   *
   * @param candidates    - Read-only array of candidates from IActionRetrieverService.
   * @param driveSnapshot - Current drive state for threshold computation.
   * @returns TYPE_1, TYPE_2, or SHRUG discriminated union.
   */
  arbitrate(
    candidates: readonly ActionCandidate[],
    driveSnapshot: DriveSnapshot,
  ): Promise<ArbitrationResult>;
}

// ---------------------------------------------------------------------------
// IPredictionService
// ---------------------------------------------------------------------------

/**
 * Interface for generating and evaluating drive effect predictions.
 *
 * CANON §Dual-Process Cognition: Predictions are made before action selection
 * and evaluated after outcome observation. Their accuracy over the last 10 uses
 * drives the Type 1 graduation check (confidence > 0.80 AND MAE < 0.10).
 *
 * CANON §Known Attractor States: "Prediction Pessimist" — early failures should
 * not flood the system with low-quality procedures. The maxCandidates cap on
 * generatePredictions() is the structural guard.
 *
 * Injection token: PREDICTION_SERVICE (decision-making.tokens.ts)
 * Provided by:    PredictionService
 */
export interface IPredictionService {
  /**
   * Generate drive-effect predictions for the top action candidates.
   *
   * Called during the PREDICTING executor state. For each candidate, produces
   * a Prediction record with the expected drive deltas if that candidate is
   * executed.
   *
   * Emits PREDICTION_CREATED events to TimescaleDB for each generated prediction.
   *
   * @param candidates    - Action candidates to generate predictions for.
   * @param context       - Current cognitive context with drive snapshot and episodes.
   * @param maxCandidates - Maximum predictions to generate. Defaults to 3. Caps
   *                        the prediction workload per cycle.
   * @returns Array of Prediction records, one per evaluated candidate.
   * @throws {DecisionMakingException} If prediction generation fails.
   */
  generatePredictions(
    candidates: readonly ActionCandidate[],
    context: CognitiveContext,
    maxCandidates?: number,
  ): Promise<Prediction[]>;

  /**
   * Evaluate a single prediction against the observed outcome.
   *
   * Called during the OBSERVING executor state after an action completes.
   * Computes the MAE between predicted and actual drive effects. Emits a
   * PREDICTION_EVALUATED event to TimescaleDB.
   *
   * The resulting PredictionEvaluation feeds into:
   * - Type 1 graduation checks (MAE accumulation over last 10 uses)
   * - Opportunity detection by the Drive Engine
   * - Episode encoding (prediction accuracy is stored on the Episode indirectly
   *   via ageWeight calculation)
   *
   * @param predictionId  - The UUID of the Prediction to evaluate.
   * @param actualOutcome - The observed outcome from the executor.
   * @returns PredictionEvaluation with MAE and per-drive comparison.
   * @throws {DecisionMakingException} If predictionId is not found in the
   *         active predictions store.
   */
  evaluatePrediction(predictionId: string, actualOutcome: ActionOutcome): PredictionEvaluation;

  /**
   * Find the active (unevaluated) prediction for a given action ID.
   *
   * Returns the prediction UUID if an active prediction exists whose
   * actionCandidate.procedureData.id matches the given actionId. Returns
   * null if no match is found (e.g., the action was not among the top 3
   * candidates that received predictions, or the prediction was already
   * evaluated).
   *
   * Used by reportOutcome() to locate the prediction for the selected
   * action so it can be evaluated against the real observed outcome.
   *
   * @param actionId - WKG procedure node ID to search for.
   * @returns The prediction UUID, or null if not found.
   */
  getActivePredictionIdForAction(actionId: string): string | null;

  /**
   * Remove predictions older than maxAgeMs from the active store.
   *
   * Prevents unbounded growth of the active predictions map when
   * predictions for non-selected candidates are never evaluated via
   * reportOutcome(). Called at the start of each decision cycle.
   *
   * @param maxAgeMs - Maximum age in milliseconds before pruning.
   */
  pruneStale(maxAgeMs: number): void;
}

// ---------------------------------------------------------------------------
// IActionRetrieverService
// ---------------------------------------------------------------------------

/**
 * Interface for retrieving action candidates from the WKG.
 *
 * CANON §Subsystem 1 (Decision Making): Action retrieval queries the WKG for
 * procedure nodes that match the current context fingerprint and are above the
 * retrieval threshold (confidence > 0.50). The motivating drive for each
 * candidate is required for Ashby Loop 4 analysis.
 *
 * CANON §Confidence Dynamics: Retrieval threshold is 0.50. Nodes below this
 * are not returned by default WKG queries.
 *
 * Injection token: ACTION_RETRIEVER_SERVICE (decision-making.tokens.ts)
 * Provided by:    ActionRetrieverService
 */
export interface IActionRetrieverService {
  /**
   * Retrieve action candidates matching the given context from the WKG.
   *
   * Queries WKG procedure nodes with confidence >= 0.50 and contextual
   * similarity to the provided fingerprint. Each returned candidate carries
   * the motivating drive (highest-pressure drive at query time) for Ashby
   * Loop 4 analysis.
   *
   * An empty array is a valid return — it means no WKG candidates exist above
   * threshold for this context, which will trigger the Type 2 path.
   *
   * @param contextFingerprint - Semantic fingerprint of the current input context.
   * @param driveSnapshot      - Current drive state for motivating drive assignment.
   * @returns Array of ActionCandidate records. May be empty.
   * @throws {DecisionMakingException} If the WKG query fails.
   */
  retrieve(contextFingerprint: string, driveSnapshot: DriveSnapshot): Promise<ActionCandidate[]>;

  /**
   * Bootstrap the action tree with seed procedure nodes on cold start.
   *
   * Called once during module initialization (OnModuleInit) when the WKG
   * contains no procedure nodes. Seeds the action tree with SYSTEM_BOOTSTRAP
   * provenance nodes so the system has at least one Type 2 candidate on its
   * first decision cycle.
   *
   * CANON §Provenance: Bootstrap nodes carry 'SYSTEM_BOOTSTRAP' provenance
   * (base confidence 0.40). They are never elevated unless guardian-confirmed.
   *
   * @throws {DecisionMakingException} If the WKG seed write fails.
   */
  bootstrapActionTree(): Promise<void>;
}

// ---------------------------------------------------------------------------
// IConfidenceUpdaterService
// ---------------------------------------------------------------------------

/**
 * Interface for updating action procedure confidence after outcome observation.
 *
 * CANON §Confidence Dynamics (ACT-R): Confidence is updated via
 * min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1)). The update trigger
 * types map to ACT-R reinforcement semantics.
 *
 * CANON Immutable Standard 5 (Guardian Asymmetry): Guardian feedback carries
 * 2x (confirmation) or 3x (correction) weight on the confidence delta. The
 * guardianFeedback parameter is therefore load-bearing.
 *
 * CANON §Type 1 / Type 2 Discipline: After every confidence update, this
 * service checks graduation and demotion thresholds. If a behavior crosses a
 * threshold, a TYPE_1_GRADUATION or TYPE_1_DEMOTION event is emitted.
 *
 * Injection token: CONFIDENCE_UPDATER_SERVICE (decision-making.tokens.ts)
 * Provided by:    ConfidenceUpdaterService
 */
export interface IConfidenceUpdaterService {
  /**
   * Update the ACT-R confidence of an action procedure after outcome observation.
   *
   * 'reinforced':        Successful outcome. Increments count, updates
   *                      lastRetrievalAt. May trigger TYPE_1_GRADUATION.
   * 'decayed':           Time-based decay pass (no new use). Recomputes confidence
   *                      with updated time component. May trigger TYPE_1_DEMOTION.
   * 'counter_indicated': Outcome contradicted the expected result. Applies a
   *                      confidence reduction. If anxietyAtExecution > 0.7, the
   *                      Drive Engine's 1.5x anxiety amplification has already been
   *                      applied to the drive effects — but this updater still applies
   *                      the full ACT-R counter-indication reduction here.
   *
   * If guardianFeedback is provided, the applyGuardianWeight() multiplier is
   * applied to the confidence delta before writing (CANON Standard 5).
   *
   * @param actionId       - WKG procedure node ID of the action to update.
   * @param outcome        - The type of confidence update to apply.
   * @param guardianFeedback - Optional guardian feedback for weight multiplication.
   * @throws {DecisionMakingException} If actionId is not found in the WKG.
   */
  update(
    actionId: string,
    outcome: 'reinforced' | 'decayed' | 'counter_indicated',
    guardianFeedback?: 'confirmation' | 'correction',
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// IExecutorEngine
// ---------------------------------------------------------------------------

/**
 * Interface for the Executor Engine state machine.
 *
 * CANON §Subsystem 1 (Decision Making): The Executor Engine is a state machine
 * managing the phases of the cognitive loop. Only one state is active at a time.
 * Illegal transitions (e.g., IDLE -> EXECUTING) throw a DecisionMakingException.
 *
 * The state machine is internal to DecisionMakingModule; IExecutorEngine is
 * used by the other decision-making services to read and transition state. It
 * is NOT exported from the module barrel — Communication and other modules
 * never touch the state machine directly.
 *
 * Injection token: EXECUTOR_ENGINE (decision-making.tokens.ts)
 * Provided by:    ExecutorEngineService
 */
export interface IExecutorEngine {
  /**
   * Transition the executor to the given target state.
   *
   * Validates that the transition is legal from the current state. Illegal
   * transitions (e.g., IDLE -> EXECUTING, skipping intermediate states) throw.
   *
   * The legal transition sequence is:
   * IDLE -> CATEGORIZING -> RETRIEVING -> PREDICTING -> ARBITRATING ->
   * EXECUTING -> OBSERVING -> LEARNING -> IDLE
   *
   * forceIdle() is the only path to IDLE from a non-LEARNING state and is
   * reserved for error recovery.
   *
   * @param targetState - The state to transition to.
   * @throws {DecisionMakingException} If the transition is not legal from the
   *         current state.
   */
  transition(targetState: ExecutorState): void;

  /**
   * Force the executor to IDLE regardless of current state.
   *
   * Used for error recovery when the cognitive loop encounters an unrecoverable
   * error mid-cycle. Logs the forced reset and emits a diagnostic event.
   *
   * This must ONLY be called by the main DecisionMakingService error handler —
   * calling it from a sub-service would hide context about where the failure
   * occurred.
   */
  forceIdle(): void;

  /**
   * Return the current executor state without triggering a transition.
   *
   * Used by all decision-making sub-services to gate their logic on the
   * expected state. A sub-service that receives a call while the executor
   * is in an unexpected state should throw a DecisionMakingException.
   *
   * @returns The current ExecutorState. Never null.
   */
  getState(): ExecutorState;

  /**
   * Capture a drive snapshot for correlation with the current cycle.
   *
   * Called at the start of each decision cycle so that all events emitted
   * during the cycle carry the same drive context. The snapshot is held
   * until the cycle completes.
   *
   * @param snapshot - The drive state at cycle start.
   */
  captureSnapshot(snapshot: DriveSnapshot): void;

  /**
   * Return the drive snapshot captured for the current cycle.
   *
   * @returns The captured snapshot, or undefined if no cycle is active.
   */
  getCycleSnapshot(): DriveSnapshot | undefined;
}

// ---------------------------------------------------------------------------
// IThresholdComputationService
// ---------------------------------------------------------------------------

/**
 * Interface for computing dynamic action thresholds.
 *
 * CANON §Subsystem 1 (Decision Making): The action threshold gates which
 * Type 1 candidates are actionable during arbitration. It is computed from
 * the current drive state and clamped to [0.30, 0.70].
 *
 * Injection token: THRESHOLD_COMPUTATION_SERVICE (decision-making.tokens.ts)
 * Provided by:    ThresholdComputationService
 */
export interface IThresholdComputationService {
  /**
   * Compute the dynamic action threshold for the current drive state.
   *
   * Applies drive-based modulations:
   * - Anxiety > 0.70:              raise threshold (conservative)
   * - Guilt > 0.50:                raise threshold (moral caution)
   * - Curiosity + Boredom high:    lower threshold (exploration)
   *
   * Result is clamped to [0.30, 0.70].
   *
   * @param driveSnapshot - Current drive state for modulation.
   * @returns ThresholdResult with threshold and intermediate values.
   */
  computeThreshold(driveSnapshot: DriveSnapshot): ThresholdResult;
}

// ---------------------------------------------------------------------------
// IContradictionScannerService (NEW — co-being improvement)
// ---------------------------------------------------------------------------

/**
 * Interface for pre-commit coherence checking.
 *
 * Inspired by co-being's Validation Phase (Phase 3) which checked for
 * CONTRADICTS edges among activated nodes before allowing action. This
 * prevents acting on beliefs that the WKG already flags as contradictory.
 *
 * The Arbitration service calls this before returning TYPE_1 or TYPE_2.
 * If contradictions are found, the result may be downgraded to SHRUG with
 * GapType.CONTRADICTION.
 *
 * Injection token: CONTRADICTION_SCANNER (decision-making.tokens.ts)
 * Provided by:    ContradictionScannerService
 */
export interface IContradictionScannerService {
  /**
   * Scan for contradictions related to the given action candidate.
   *
   * Queries the WKG for CONTRADICTS edges connected to the candidate's
   * procedure node or the entities in its trigger context. Returns a
   * ContradictionScanResult indicating whether any contradictions were found.
   *
   * @param candidate     - The action candidate to check for contradictions.
   * @param driveSnapshot - Current drive state (for logging context).
   * @returns ContradictionScanResult with found contradictions, if any.
   */
  scan(candidate: ActionCandidate, driveSnapshot: DriveSnapshot): Promise<ContradictionScanResult>;
}

// ---------------------------------------------------------------------------
// IType1TrackerService
// ---------------------------------------------------------------------------

/**
 * Interface for tracking Type 1 graduation state of action procedures.
 *
 * CANON §Dual-Process Cognition: Actions graduate from Type 2 to Type 1
 * through earned confidence and prediction accuracy. The state machine is:
 * UNCLASSIFIED -> TYPE_2_ONLY -> TYPE_1_CANDIDATE -> TYPE_1_GRADUATED
 * with a demotion path: TYPE_1_GRADUATED -> TYPE_1_DEMOTED -> TYPE_2_ONLY
 *
 * Injection token: TYPE_1_TRACKER_SERVICE (decision-making.tokens.ts)
 * Provided by:    Type1TrackerService
 */
export interface IType1TrackerService {
  /**
   * Get the graduation record for a procedure, creating one if needed.
   *
   * @param procedureId - The WKG procedure node ID.
   * @returns The current GraduationRecord.
   */
  getRecord(procedureId: string): GraduationRecord;

  /**
   * Record a new MAE observation and evaluate graduation/demotion.
   *
   * Appends the MAE value to the rolling window (last 10), recomputes
   * the mean, and evaluates state transitions:
   * - If qualifiesForGraduation(): transition to TYPE_1_GRADUATED
   * - If qualifiesForDemotion(): transition to TYPE_1_DEMOTED
   *
   * Emits TYPE_1_GRADUATION or TYPE_1_DEMOTION events as appropriate.
   *
   * @param procedureId - The WKG procedure node ID.
   * @param mae         - The MAE from the latest PredictionEvaluation.
   * @param confidence  - The current ACT-R confidence of the procedure.
   */
  recordObservation(procedureId: string, mae: number, confidence: number): void;

  /**
   * Check whether a procedure is currently graduated to Type 1.
   *
   * @param procedureId - The WKG procedure node ID.
   * @returns True if the procedure is in TYPE_1_GRADUATED state.
   */
  isGraduated(procedureId: string): boolean;
}

// ---------------------------------------------------------------------------
// IConsolidationService
// ---------------------------------------------------------------------------

/**
 * Interface for episodic memory consolidation.
 *
 * Consolidation identifies mature episodes and extracts semantic content
 * for promotion to the World Knowledge Graph. The conversion does not
 * write to the WKG; it prepares data for the Learning subsystem.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory consolidation is
 * the bridge between in-memory episode storage and durable WKG knowledge.
 *
 * Injection token: CONSOLIDATION_SERVICE (decision-making.tokens.ts)
 * Provided by:    ConsolidationService
 */
export interface IConsolidationService {
  /**
   * Identify all episodes in episodic memory that are ready for consolidation.
   *
   * Consolidation candidates meet these criteria:
   *   - Age > 2 hours
   *   - Estimated confidence > 0.65
   *
   * Candidates are returned in descending order of estimated confidence
   * (highest confidence first).
   *
   * @returns Array of consolidation candidates. Empty if no episodes qualify.
   */
  findConsolidationCandidates(): readonly ConsolidationCandidate[];

  /**
   * Convert an episode into semantic WKG content.
   *
   * Extracts entities and relationships from the episode. Does not write
   * to the WKG; returns the conversion ready for Learning subsystem handoff.
   *
   * @param episode - The episode to convert.
   * @returns A SemanticConversion object with extracted entities and relationships.
   */
  convertToSemantic(episode: Episode): SemanticConversion;

  /**
   * Consolidate a single candidate episode.
   *
   * Converts the candidate to semantic content, logs the intent to the event
   * backbone, and tracks the result. Does not write to the WKG (Learning
   * subsystem owns WKG persistence).
   *
   * @param candidate - The consolidation candidate to process.
   * @returns ConsolidationResult with success flag and conversion count.
   */
  consolidate(candidate: ConsolidationCandidate): Promise<ConsolidationResult>;

  /**
   * Run a full consolidation cycle.
   *
   * Finds all candidates in episodic memory, consolidates each, and returns
   * aggregated results. This is typically called periodically (e.g., every
   * 30 minutes) to promote mature episodes to the WKG.
   *
   * @returns Array of ConsolidationResult, one per consolidated episode.
   */
  runConsolidationCycle(): Promise<readonly ConsolidationResult[]>;
}

// ---------------------------------------------------------------------------
// IDecisionEventLogger
// ---------------------------------------------------------------------------

/**
 * Interface for buffered event logging to TimescaleDB.
 *
 * Provides unified event emission for all decision-making services.
 * Buffers events and flushes periodically for efficiency.
 *
 * Injection token: DECISION_EVENT_LOGGER (decision-making.tokens.ts)
 * Provided by:    DecisionEventLoggerService
 */
export interface IDecisionEventLogger {
  /**
   * Log a decision-making event to TimescaleDB.
   *
   * Events are buffered and flushed every 10 events or 100ms, whichever
   * comes first.
   *
   * @param eventType     - The EventType to log.
   * @param payload       - Event-specific payload data.
   * @param driveSnapshot - Drive state at event time.
   * @param sessionId     - Current session identifier.
   * @param correlationId - Optional correlation ID for tracing causal chains.
   */
  log(
    eventType: string,
    payload: Record<string, unknown>,
    driveSnapshot: DriveSnapshot,
    sessionId: string,
    correlationId?: string,
  ): void;

  /**
   * Flush all buffered events immediately.
   * Called during cycle completion and error recovery.
   */
  flush(): Promise<void>;
}
