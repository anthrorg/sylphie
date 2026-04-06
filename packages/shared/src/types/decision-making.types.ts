/**
 * Decision-making types: episodic memory, predictions, cognitive context, and
 * the enriched Shrug Imperative types.
 *
 * CANON §Subsystem 1 (Decision Making): The central cognitive loop operates as
 * an 8-state FSM: IDLE -> CATEGORIZING -> RETRIEVING -> PREDICTING ->
 * ARBITRATING -> EXECUTING -> OBSERVING -> LEARNING -> IDLE. These types
 * represent the data flowing between those states.
 *
 * CANON §Dual-Process Cognition: Type 1 (graph reflex) and Type 2 (LLM
 * deliberation) produce ActionCandidates that are arbitrated. The CognitiveContext
 * is the working memory assembled for Type 2 LLM prompt construction.
 *
 * Improvement over sylphie-old: Named gap types on SHRUG provide actionable
 * downstream information. Contradiction scanning prevents acting on conflicting
 * beliefs.
 *
 * Dependencies: drive.types.ts, action.types.ts, provenance.types.ts
 */

import type { DriveSnapshot } from './drive.types';
import type { ActionCandidate, ExecutorState } from './action.types';
import type { ProvenanceSource } from './provenance.types';

// ---------------------------------------------------------------------------
// Encoding Depth
// ---------------------------------------------------------------------------

/**
 * Controls how thoroughly an episode is encoded into episodic memory.
 *
 * CANON §Episodic Memory: The encoding gate uses attention and arousal to
 * determine depth. SKIP means the episode is discarded (below encoding gate).
 * DEEP is reserved for high-salience episodes (guardian interaction, prediction
 * failures, novel contexts).
 */
export type EncodingDepth = 'DEEP' | 'NORMAL' | 'SHALLOW' | 'SKIP';

// ---------------------------------------------------------------------------
// Episode Types
// ---------------------------------------------------------------------------

/**
 * Raw experience data submitted for episodic encoding.
 *
 * Created by the OBSERVING state of the executor after an action completes.
 * The encoding gate in the episodic memory service decides whether to store
 * it (and at what depth) based on attention and arousal values.
 *
 * Matches sylphie-old's EpisodeInput: lightweight string references, not
 * full object embeddings. Keeps the ring buffer memory-efficient.
 */
export interface EpisodeInput {
  /** Drive state at the moment of action selection. */
  readonly driveSnapshot: DriveSnapshot;

  /** One-sentence summary of the input that triggered this episode. */
  readonly inputSummary: string;

  /** String identifier of the action that was executed (procedure ID or symbolic name). */
  readonly actionTaken: string;

  /** Context fingerprint for similarity matching on retrieval. */
  readonly contextFingerprint: string;

  /**
   * Attention level at encoding time. In [0.0, 1.0].
   * Used by the encoding gate: attention > 0.60 passes the gate.
   */
  readonly attention: number;

  /**
   * Arousal level at encoding time. In [0.0, 1.0].
   * Used by the encoding gate: arousal > 0.60 passes the gate.
   * Either attention OR arousal exceeding 0.60 is sufficient.
   */
  readonly arousal: number;
}

/**
 * An encoded episode stored in the episodic memory ring buffer.
 *
 * Episodes are the experiential records that form Sylphie's working memory
 * context. They decay exponentially via ageWeight and are used for context
 * similarity matching during action retrieval and CognitiveContext assembly.
 *
 * CANON §Episodic Memory: Ring buffer of 50 episodes. ageWeight =
 * attention * exp(-0.1 * hoursSinceEncoding). Episodes with ageWeight below
 * a threshold are candidates for consolidation into the WKG.
 *
 * Matches sylphie-old's Episode: lightweight string fields for memory efficiency.
 */
export interface Episode {
  /** Unique identifier for this episode. UUID v4. */
  readonly id: string;

  /** Wall-clock time this episode was encoded. */
  readonly timestamp: Date;

  /** Drive state at the time of action selection. */
  readonly driveSnapshot: DriveSnapshot;

  /** One-sentence summary of the triggering input. Human-readable. */
  readonly inputSummary: string;

  /** Identifier of the action that was executed. */
  readonly actionTaken: string;

  /** IDs of predictions generated before action selection for this episode. */
  readonly predictionIds: readonly string[];

  /**
   * Temporal recency weight in [0.0, 1.0]. Decays as the episode ages.
   * Formula: attention * exp(-0.1 * hoursSinceEncoding)
   */
  readonly ageWeight: number;

  /** The encoding depth that was applied when this episode was stored. */
  readonly encodingDepth: EncodingDepth;

  /** Context fingerprint for Jaccard/cosine similarity matching. */
  readonly contextFingerprint: string;
}

// ---------------------------------------------------------------------------
// Prediction Types
// ---------------------------------------------------------------------------

/**
 * A prediction about the drive effects of executing a candidate action.
 *
 * CANON §Predict-Act-Evaluate Cycle: Predictions are generated BEFORE action
 * selection (in the PREDICTING state). After execution, predictions are
 * evaluated against observed outcomes. The MAE over the last 10 uses drives
 * Type 1 graduation and demotion.
 *
 * Matches sylphie-old: stores the full ActionCandidate reference for correlation.
 */
export interface Prediction {
  /** Unique identifier for this prediction. UUID v4. */
  readonly id: string;

  /** The action candidate this prediction was generated for. */
  readonly actionCandidate: ActionCandidate;

  /**
   * Predicted drive effect deltas. Keyed by drive name string, values are the
   * expected changes. Partial map — only drives expected to change are included.
   */
  readonly predictedDriveEffects: Partial<Record<string, number>>;

  /**
   * Confidence in this prediction. In [0.0, 1.0].
   * Typically candidate.confidence * 0.8 (predictions are weaker than retrieval).
   */
  readonly confidence: number;

  /** When this prediction was generated. */
  readonly timestamp: Date;
}

/**
 * The result of evaluating a prediction against observed outcomes.
 *
 * Created during the OBSERVING state by comparing predicted drive effects
 * against actual drive effects. The MAE feeds into graduation/demotion logic.
 *
 * Matches sylphie-old: carries both predicted and actual effects for logging.
 */
export interface PredictionEvaluation {
  /** ID of the prediction that was evaluated. */
  readonly predictionId: string;

  /** Mean absolute error across all predicted drive effects. In [0.0, 1.0]. */
  readonly mae: number;

  /** Whether the prediction was considered accurate (mae < graduationMAE threshold). */
  readonly accurate: boolean;

  /** Observed drive effects from the ActionOutcome. */
  readonly actualEffects: Partial<Record<string, number>>;

  /** Original predicted drive effects from the Prediction. */
  readonly predictedEffects: Partial<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Gap Types (Improvement: Named gaps for SHRUG)
// ---------------------------------------------------------------------------

/**
 * Classification of epistemic gaps that caused a SHRUG.
 *
 * When arbitration produces SHRUG, the system classifies WHY no candidate
 * exceeded the threshold. This gives downstream systems (Communication,
 * Planning) actionable information instead of a bare incomprehension signal.
 *
 * Inspired by co-being's Reasoning Circle (Phase 1 Decomposition) which
 * identified specific gap types during semantic processing.
 *
 * MISSING_INTENT:       Input was parsed but no intent could be derived.
 * MISSING_SUBJECT:      Intent was clear but the subject/target is unknown.
 * UNGROUNDED_INPUT:     Input modalities could not be mapped to known concepts.
 * AMBIGUOUS_REFERENCE:  Multiple equally-plausible interpretations exist.
 * MISSING_CONTEXT:      No candidates retrieved — the situation is entirely novel.
 * LOW_CONFIDENCE:       Candidates exist but all fell below the dynamic threshold.
 * CONTRADICTION:        Candidates exist but activated contradictory beliefs.
 */
export type GapType =
  | 'MISSING_INTENT'
  | 'MISSING_SUBJECT'
  | 'UNGROUNDED_INPUT'
  | 'AMBIGUOUS_REFERENCE'
  | 'MISSING_CONTEXT'
  | 'LOW_CONFIDENCE'
  | 'CONTRADICTION';

/**
 * Detailed breakdown of why a SHRUG was produced.
 *
 * Enriches the SHRUG variant of ArbitrationResult with structured diagnostic
 * information. The gap types tell Communication how to express the
 * incomprehension (e.g., "I don't understand what you mean" for MISSING_INTENT
 * vs "I'm not sure what to do here" for MISSING_CONTEXT).
 */
export interface ShrugDetail {
  /** One or more gap types that contributed to the SHRUG. */
  readonly gapTypes: readonly GapType[];

  /** Confidence values of all candidates that were considered but rejected. */
  readonly candidateConfidences: readonly number[];

  /** The dynamic threshold that candidates were measured against. */
  readonly threshold: number;

  /** Human-readable reason string (same as ArbitrationResult.reason). */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Contradiction Scan Result (Improvement: Pre-commit coherence check)
// ---------------------------------------------------------------------------

/**
 * Result of scanning for CONTRADICTS edges before committing an action.
 *
 * Inspired by co-being's Validation Phase (Phase 3) which checked for
 * CONTRADICTS edges among activated nodes before allowing action. This
 * prevents acting on beliefs that the WKG already flags as contradictory.
 *
 * The Arbitration service runs this check before returning TYPE_1 or TYPE_2.
 * If contradictions are found, the result may be downgraded to SHRUG with
 * GapType.CONTRADICTION.
 */
export interface ContradictionScanResult {
  /** Whether any contradictions were found. */
  readonly hasContradictions: boolean;

  /** The specific contradictions detected, if any. */
  readonly contradictions: readonly ContradictionEntry[];
}

/**
 * A single contradiction detected between a candidate's activated knowledge
 * and existing WKG beliefs.
 */
export interface ContradictionEntry {
  /** The claim or fact that the candidate's action would rely on. */
  readonly claim: string;

  /** The existing WKG fact that contradicts it. */
  readonly existingFact: string;

  /** Confidence of the CONTRADICTS edge in the WKG. In [0.0, 1.0]. */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Threshold Result
// ---------------------------------------------------------------------------

/**
 * Output of the dynamic threshold computation.
 *
 * The dynamic action threshold determines which candidates pass arbitration.
 * It is modulated by drive state: anxiety tightens it (conservative), curiosity
 * + boredom loosen it (exploratory). Clamped to [0.30, 0.70].
 *
 * CANON §Confidence Dynamics: The threshold starts at retrieval threshold (0.50)
 * and is modulated by drive pressure. This is pure computation — reads drive
 * state but does not mutate it.
 */
export interface ThresholdResult {
  /** The computed threshold value, clamped to [0.30, 0.70]. */
  readonly threshold: number;

  /** Base threshold before drive modulation (CONFIDENCE_THRESHOLDS.retrieval = 0.50). */
  readonly baseThreshold: number;

  /** Multiplier from anxiety drive. 1.0 = no effect, >1.0 = more conservative. */
  readonly anxietyMultiplier: number;

  /** Multiplier from moral valence / guilt. 1.0 = no effect, >1.0 = more cautious. */
  readonly moralMultiplier: number;

  /** Reduction factor from curiosity + boredom. 1.0 = no effect, <1.0 = more exploratory. */
  readonly curiosityReduction: number;

  /** Whether the threshold was clamped (hit the [0.30, 0.70] boundary). */
  readonly clamped: boolean;
}

// ---------------------------------------------------------------------------
// Cognitive Context
// ---------------------------------------------------------------------------

/**
 * The assembled cognitive context for the current decision cycle.
 *
 * This is the "implicit inner monologue" — the working memory contents that
 * the Communication subsystem uses to construct LLM prompts for Type 2
 * deliberation. It carries the real drive state (Theater Prohibition), recent
 * episodes (experiential context), active predictions (expectations), and gap
 * types from recent SHRUGs (epistemic state).
 *
 * CANON Standard 1 (Theater Prohibition): The driveSnapshot is ground truth.
 * The LLM receives the real drive state, not a theatrical mask.
 */
export interface CognitiveContext {
  /** Current state of the executor FSM. */
  readonly currentState: ExecutorState;

  /** Recent episodes from the episodic memory ring buffer, ordered by ageWeight descending. */
  readonly recentEpisodes: readonly Episode[];

  /** Active predictions for the current cycle's candidates. */
  readonly activePredictions: readonly Prediction[];

  /** Current drive state. Ground truth for Theater Prohibition. */
  readonly driveSnapshot: DriveSnapshot;

  /**
   * Gap types from recent SHRUG outcomes.
   * Tells the LLM what kinds of incomprehension Sylphie is experiencing,
   * enabling more authentic and specific expressions of uncertainty.
   */
  readonly recentGapTypes: readonly GapType[];

  /**
   * The dynamic action threshold for this cycle.
   * Included so the LLM can understand the current selectivity level.
   */
  readonly dynamicThreshold: number;
}

// ---------------------------------------------------------------------------
// Consolidation Types
// ---------------------------------------------------------------------------

/**
 * An episode identified as a candidate for consolidation into the WKG.
 *
 * CANON §Subsystem 3 (Learning): Episodes with decayed ageWeight below a
 * threshold are candidates for consolidation — their experiential content
 * is converted into durable semantic knowledge (WKG nodes and edges).
 */
export interface ConsolidationCandidate {
  /** The episode ready for consolidation. */
  readonly episode: Episode;

  /** Age of the episode in hours since encoding. */
  readonly ageHours: number;

  /**
   * Estimated confidence in the episode's semantic value [0.0, 1.0].
   * Derived from ageWeight and encoding depth:
   *   DEEP:   min(1.0, ageWeight * 1.2)
   *   NORMAL: ageWeight
   *   SHALLOW: max(0.4, ageWeight * 0.8)
   */
  readonly estimatedConfidence: number;
}

/**
 * A semantic relationship extracted from episode content during consolidation.
 * Subject-predicate-object triple with provenance and confidence.
 */
export interface SemanticRelationship {
  /** The subject entity (e.g., "Sylphie", "guardian", a concept name). */
  readonly subject: string;

  /** The predicate (e.g., "likes", "is_a", "causes"). */
  readonly predicate: string;

  /** The object entity. */
  readonly object: string;

  /** Confidence in this relationship. Derived from episode encoding depth and guardian feedback. */
  readonly confidence: number;

  /** Provenance of the extraction. */
  readonly provenance: ProvenanceSource;
}

/**
 * Result of converting an episode into semantic WKG content.
 * Matches sylphie-old's SemanticConversion.
 */
export interface SemanticConversion {
  /** UUID of the source episode. */
  readonly sourceEpisodeId: string;

  /** Extracted entities (noun phrases, named concepts). */
  readonly entities: readonly string[];

  /** Semantic relationships derived from the episode's action context. */
  readonly relationships: readonly SemanticRelationship[];

  /** Provenance of the extraction (inherited from episode context). */
  readonly provenance: ProvenanceSource;

  /** Overall confidence in this semantic conversion [0.0, 1.0]. */
  readonly confidence: number;
}

/**
 * Outcome of a single consolidation operation.
 * Matches sylphie-old's ConsolidationResult.
 */
export interface ConsolidationResult {
  /** UUID of the source episode. */
  readonly episodeId: string;

  /** Whether the consolidation succeeded. */
  readonly success: boolean;

  /** Number of semantic conversions created. */
  readonly conversionsCreated: number;

  /** Error message if consolidation failed. */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Type 1 Tracker Types
// ---------------------------------------------------------------------------

/**
 * Graduation state of an action procedure in the Type 1 tracker.
 *
 * CANON §Dual-Process Cognition: Actions graduate from Type 2 to Type 1
 * through earned confidence and prediction accuracy. The state machine is:
 * UNCLASSIFIED -> TYPE_2_ONLY -> TYPE_1_CANDIDATE -> TYPE_1_GRADUATED
 * with a demotion path: TYPE_1_GRADUATED -> TYPE_1_DEMOTED -> TYPE_2_ONLY
 */
export type GraduationState =
  | 'UNCLASSIFIED'
  | 'TYPE_2_ONLY'
  | 'TYPE_1_CANDIDATE'
  | 'TYPE_1_GRADUATED'
  | 'TYPE_1_DEMOTED';

/**
 * Tracking record for an action procedure's graduation state.
 */
export interface GraduationRecord {
  /** The action procedure ID being tracked. */
  readonly procedureId: string;

  /** Current graduation state. */
  readonly state: GraduationState;

  /** Rolling MAE over the last 10 uses. */
  readonly recentMAE: number;

  /** Number of entries in the MAE history (max 10). */
  readonly maeHistoryLength: number;

  /** When this record was last updated. */
  readonly lastUpdatedAt: Date;

  /** When the procedure graduated to Type 1 (null if never graduated). */
  readonly graduatedAt: Date | null;

  /** When the procedure was last demoted (null if never demoted). */
  readonly demotedAt: Date | null;
}
