/**
 * Decision Making module interface contracts.
 *
 * CANON §Subsystem 1 (Decision Making): The central cognitive loop. Receives
 * categorized input, retrieves action candidates from the WKG, runs Type 1 /
 * Type 2 arbitration, executes, observes, and encodes the episode. These
 * interfaces define every public contract inside that loop.
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
 */

import type { DriveSnapshot } from '../../shared/types/drive.types';
import type {
  ActionCandidate,
  ArbitrationResult,
  ActionOutcome,
  ExecutorState,
} from '../../shared/types/action.types';

// ---------------------------------------------------------------------------
// Encoding Depth
// ---------------------------------------------------------------------------

/**
 * Controls how thoroughly an experience is encoded into episodic memory.
 *
 * DEEP:    Full encoding with prediction correlation, context fingerprint
 *          embedding, and high ageWeight. Reserved for high-salience episodes
 *          (guardian feedback, large prediction errors, novel context).
 * NORMAL:  Standard encoding. Most interactive exchanges land here.
 * SHALLOW: Minimal fields stored. Used for low-salience, routine events where
 *          storage overhead outweighs episodic value.
 * SKIP:    Do not encode. Applied when the executor loop determines no episodic
 *          value exists (e.g., no-op cycles, system health pings).
 */
export type EncodingDepth = 'DEEP' | 'NORMAL' | 'SHALLOW' | 'SKIP';

// ---------------------------------------------------------------------------
// Guardian Feedback Type (subset — Decision Making view)
// ---------------------------------------------------------------------------

/**
 * Guardian feedback classification as seen by Decision Making.
 * Mirrors GuardianFeedbackType from event.types.ts; redeclared here to keep
 * the Decision Making interface layer free of EventsModule imports.
 */
export type GuardianFeedbackType = 'confirmation' | 'correction' | 'none';

// ---------------------------------------------------------------------------
// Categorized Input
// ---------------------------------------------------------------------------

/**
 * Structured input delivered to the Decision Making module by Communication.
 *
 * CategorizedInput is the output of the Communication subsystem's InputParser.
 * It carries the parsed semantic content, extracted entities, any guardian
 * feedback signal, and the session/timing metadata required for the executor
 * loop to begin the decision cycle.
 *
 * CANON §Subsystem 2 (Communication): Input parsing produces CategorizedInput.
 * CANON §Subsystem 1 (Decision Making): IDecisionMakingService.processInput()
 * takes CategorizedInput as its single argument — this is the handoff point.
 */
export interface CategorizedInput {
  /**
   * Classification of the input type.
   *
   * Example values: 'TEXT_MESSAGE', 'VOICE_UTTERANCE', 'GUARDIAN_COMMAND',
   * 'SYSTEM_TRIGGER', 'DRIVE_SENSOR_TRIGGER'
   *
   * Drives both the executor path (which arbitration path is tried first) and
   * the encoding depth decision in episodic memory.
   */
  readonly inputType: string;

  /**
   * Normalized text content of the input.
   * For voice inputs: the Whisper transcription.
   * For system triggers: a machine-readable description of the event.
   */
  readonly content: string;

  /**
   * Entities extracted from the input by the InputParser.
   * Array of entity strings (names, topics, concepts). Used by
   * IActionRetrieverService to build the context fingerprint for WKG queries.
   */
  readonly entities: readonly string[];

  /**
   * Guardian feedback type if this input is a guardian response to a prior
   * Sylphie output. 'none' if this is a fresh user utterance.
   *
   * CANON Immutable Standard 5 (Guardian Asymmetry): confirmation = 2x weight,
   * correction = 3x weight. This field flows through to outcome reporting.
   */
  readonly guardianFeedbackType: GuardianFeedbackType;

  /** Wall-clock time the input was parsed and handed off to Decision Making. */
  readonly parsedAt: Date;

  /** Session identifier correlating this input with its TimescaleDB events. */
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Episode Input
// ---------------------------------------------------------------------------

/**
 * Raw experience data submitted to IEpisodicMemoryService for encoding.
 *
 * Created by the Executor Engine at the end of each decision cycle (the
 * LEARNING state). Carries the drive context, the action taken, the context
 * fingerprint, and the attentional salience that determines EncodingDepth.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory encodes experiences
 * during the LEARNING executor state. The predictionIds array links this
 * episode to the predictions made before action selection — required for
 * prediction MAE accumulation and Type 1 graduation tracking.
 */
export interface EpisodeInput {
  /**
   * Drive snapshot at the time of action selection.
   * Required for Theater Prohibition retrospective analysis and for learning
   * subsystem correlation of drive state with behavioral outcomes.
   */
  readonly driveSnapshot: DriveSnapshot;

  /**
   * One-sentence summary of the input that triggered this episode.
   * Stored verbatim in the Episode; used by context-based retrieval and
   * by the dashboard for human-readable episode display.
   */
  readonly inputSummary: string;

  /**
   * String identifier of the action that was executed.
   * Corresponds to ActionProcedureData.id (or a symbolic name for Type 2
   * novel responses with no existing procedure node).
   */
  readonly actionTaken: string;

  /**
   * Semantic context fingerprint computed from the input entities and drive
   * state at the moment of encoding. Used for cosine-similarity retrieval in
   * IEpisodicMemoryService.queryByContext().
   *
   * CANON §A.15: Context fingerprints with cosine similarity > 0.7 are treated
   * as the same context for guilt repair attribution.
   */
  readonly contextFingerprint: string;

  /**
   * Attentional weight in [0.0, 1.0] assigned by the executor at encoding time.
   * Higher attention = higher ageWeight on the resulting Episode, making it
   * more likely to be recalled in future context queries.
   *
   * Attention is elevated by: novel context, large prediction error, guardian
   * feedback presence, and high total drive pressure.
   */
  readonly attention: number;

  /**
   * Arousal level in [0.0, 1.0] derived from the drive snapshot.
   * High arousal (high total drive pressure) biases toward DEEP encoding.
   * Low arousal (near-zero total pressure) biases toward SHALLOW or SKIP.
   */
  readonly arousal: number;
}

// ---------------------------------------------------------------------------
// Episode
// ---------------------------------------------------------------------------

/**
 * A single encoded experience stored in episodic memory.
 *
 * Episodes are the in-memory experiential record that the Decision Making
 * subsystem uses to provide context to Communication (via CognitiveContext)
 * and to inform arbitration decisions.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory is distinct from the
 * WKG. Episodes capture the subjective experience of a moment; the WKG captures
 * durable world knowledge. The Learning subsystem may promote episode content
 * into WKG nodes over time, but the episode itself stays in the episodic store.
 */
export interface Episode {
  /** UUID v4. Unique identifier for this encoded episode. */
  readonly id: string;

  /** Wall-clock time this episode was encoded (not when the event occurred). */
  readonly timestamp: Date;

  /**
   * Drive snapshot at the time of action selection for this episode.
   * Required for Theater Prohibition retrospective analysis.
   */
  readonly driveSnapshot: DriveSnapshot;

  /** One-sentence summary of the triggering input. Human-readable. */
  readonly inputSummary: string;

  /**
   * Identifier of the action that was executed in this episode.
   * Corresponds to ActionProcedureData.id or a symbolic name for novel responses.
   */
  readonly actionTaken: string;

  /**
   * IDs of predictions that were generated before action selection for this
   * episode. Used to correlate episodes with IPredictionService evaluation
   * results and to populate prediction MAE for Type 1 graduation tracking.
   */
  readonly predictionIds: readonly string[];

  /**
   * Temporal recency weight in [0.0, 1.0]. Decays as the episode ages.
   * Newer, higher-attention episodes have higher ageWeight and are more
   * likely to be surfaced by IEpisodicMemoryService.getRecentEpisodes().
   *
   * This is the ageWeight field required by the acceptance criteria.
   */
  readonly ageWeight: number;

  /**
   * The encoding depth this episode was stored at.
   * Drives which fields have full vs. minimal data (e.g., SHALLOW episodes
   * may omit predictionIds).
   */
  readonly encodingDepth: EncodingDepth;

  /**
   * Context fingerprint computed at encoding time.
   * Used for cosine-similarity retrieval by queryByContext().
   * CANON §A.15: similarity > 0.7 = same context.
   */
  readonly contextFingerprint: string;
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/**
 * A prediction about the drive effects of an action candidate before execution.
 *
 * Predictions are generated before arbitration and evaluated after outcome
 * observation. Their accuracy over the last 10 uses drives the Type 1
 * graduation check (CANON §Confidence Dynamics: MAE < 0.10).
 */
export interface Prediction {
  /** UUID v4. Unique identifier for this prediction record. */
  readonly id: string;

  /**
   * The action candidate this prediction is for.
   * Predictions are per-candidate — there may be multiple predictions per
   * decision cycle (one per candidate evaluated).
   */
  readonly actionCandidate: ActionCandidate;

  /**
   * Predicted drive effects if this candidate is executed.
   * Partial map — only drives expected to change are included.
   * Values are predicted deltas (positive = pressure increase, negative = relief).
   *
   * These predicted effects are compared against ActionOutcome.driveEffectsObserved
   * in PredictionEvaluation to compute MAE.
   */
  readonly predictedDriveEffects: Partial<Record<string, number>>;

  /**
   * Confidence in this prediction in [0.0, 1.0].
   * Derived from the candidate's ACT-R confidence and the recency of similar
   * prior predictions in episodic memory.
   */
  readonly confidence: number;

  /** Wall-clock time this prediction was generated. */
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Prediction Evaluation
// ---------------------------------------------------------------------------

/**
 * The result of evaluating a prediction against the actual observed outcome.
 *
 * Created by IPredictionService.evaluatePrediction() during the OBSERVING state
 * of the executor loop. Feeds into the MAE accumulation for Type 1 graduation
 * checks and is emitted as a PREDICTION_EVALUATED TimescaleDB event.
 *
 * CANON §Confidence Dynamics: Type 1 graduation requires MAE < 0.10 over the
 * last 10 uses. This is the single evaluation record for one prediction.
 */
export interface PredictionEvaluation {
  /** ID of the prediction being evaluated. */
  readonly predictionId: string;

  /**
   * Mean absolute error for this prediction in [0.0, 1.0].
   * Computed as the mean of |predicted_delta - observed_delta| across all
   * drives that appeared in either predictedEffects or actualEffects.
   * 0.0 = perfect prediction. 1.0 = complete miss.
   */
  readonly mae: number;

  /**
   * Whether this prediction was considered accurate.
   * True if mae < CONFIDENCE_THRESHOLDS.graduationMAE (0.10).
   * This is the per-prediction accurate flag used in Type 1 graduation math.
   */
  readonly accurate: boolean;

  /**
   * Observed drive effects from the ActionOutcome.
   * Partial map — only drives that changed.
   */
  readonly actualEffects: Partial<Record<string, number>>;

  /**
   * The original predicted drive effects from the Prediction.
   * Stored here for comparison logging and retrospective analysis.
   */
  readonly predictedEffects: Partial<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Cognitive Context
// ---------------------------------------------------------------------------

/**
 * The current cognitive state of the Decision Making subsystem, provided to
 * Communication for LLM prompt assembly.
 *
 * CANON §Subsystem 2 (Communication): The LLM is Sylphie's voice, not her mind.
 * It receives CognitiveContext so it can speak authentically for her current
 * state — but it does NOT drive behavior. The decisions have already been made.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): The LLM must see the real
 * drive state (driveSnapshot) when generating responses. Without it, the LLM
 * could produce outputs that misrepresent her actual motivational state.
 */
export interface CognitiveContext {
  /**
   * Current executor state machine state.
   * Communication uses this to understand where in the decision cycle Sylphie
   * currently is (e.g., EXECUTING vs. IDLE affects response tone).
   */
  readonly currentState: ExecutorState;

  /**
   * Most recent episodes from episodic memory.
   * Provided to the LLM as working memory context so responses reflect recent
   * experience rather than only the current turn.
   *
   * The count is bounded by IDecisionMakingService.getCognitiveContext() —
   * typically the last 5–10 episodes per CANON §Subsystem 1 working memory spec.
   */
  readonly recentEpisodes: readonly Episode[];

  /**
   * Active predictions awaiting outcome evaluation.
   * Exposed so Communication knows what Sylphie "expects to happen" — relevant
   * when the LLM needs to phrase anticipatory or predictive statements.
   */
  readonly activePredictions: readonly Prediction[];

  /**
   * Current drive snapshot from the Drive Engine.
   *
   * Load-bearing for Theater Prohibition (CANON Standard 1): Communication must
   * correlate LLM output with actual drive state. This snapshot is the ground
   * truth at context assembly time.
   */
  readonly driveSnapshot: DriveSnapshot;
}

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
   * Trigger the full decision cycle for a categorized input.
   *
   * Transitions the Executor Engine through the full state sequence:
   * CATEGORIZING → RETRIEVING → PREDICTING → ARBITRATING → EXECUTING →
   * OBSERVING → LEARNING → IDLE
   *
   * The method returns once the cycle completes (LEARNING state exits).
   * It emits DECISION_CYCLE_STARTED and all downstream events to TimescaleDB.
   *
   * @param input - Structured input from the Communication subsystem.
   * @throws {DecisionMakingException} If the executor is not in IDLE state when
   *         called, or if a non-recoverable error occurs during the cycle.
   */
  processInput(input: CategorizedInput): Promise<void>;

  /**
   * Return the current cognitive context for LLM prompt assembly.
   *
   * Called by Communication before invoking the LLM for Type 2 deliberation or
   * response generation. Provides a snapshot of the executor state, recent
   * episodic memory, active predictions, and the current drive snapshot.
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
   * (derived from driveSnapshot.totalPressure). If the best Type 1 candidate
   * clears the threshold, returns TYPE_1. Otherwise invokes Type 2 LLM
   * deliberation. If neither produces an actionable result, returns SHRUG.
   *
   * CANON Standard 4 (Shrug Imperative): Returning SHRUG is the correct
   * behavior when no candidate is above threshold. This method never returns
   * a random low-confidence candidate — the discriminated union makes that
   * structurally impossible.
   *
   * Note: This method is synchronous on the interface. The Type 2 path (LLM call)
   * makes it effectively async in the real implementation — the stub throws
   * 'Not implemented' synchronously, and the real implementation will need to
   * be made async or the IPC handled internally.
   *
   * @param candidates    - Read-only array of candidates from IActionRetrieverService.
   * @param driveSnapshot - Current drive state for threshold computation.
   * @returns TYPE_1, TYPE_2, or SHRUG discriminated union.
   */
  arbitrate(candidates: readonly ActionCandidate[], driveSnapshot: DriveSnapshot): ArbitrationResult;
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
   * @param context       - Current cognitive context with drive snapshot and episodes.
   * @param maxCandidates - Maximum predictions to generate. Defaults to 3. Caps
   *                        the prediction workload per cycle.
   * @returns Array of Prediction records, one per evaluated candidate.
   * @throws {DecisionMakingException} If prediction generation fails.
   */
  generatePredictions(context: CognitiveContext, maxCandidates?: number): Promise<Prediction[]>;

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
   * Queries WKG procedure nodes with confidence ≥ 0.50 and contextual
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
 * Illegal transitions (e.g., IDLE → EXECUTING) throw a DecisionMakingException.
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
   * transitions (e.g., IDLE → EXECUTING, skipping intermediate states) throw.
   *
   * The legal transition sequence is:
   * IDLE → CATEGORIZING → RETRIEVING → PREDICTING → ARBITRATING →
   * EXECUTING → OBSERVING → LEARNING → IDLE
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
}
