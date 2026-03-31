/**
 * Health metrics types: first-class TypeScript types for all 7 CANON health metrics.
 *
 * CANON §Development Metrics: Sylphie communicates fluently from session 1.
 * Development is measured by AUTONOMY, not capability. These seven metrics
 * are the primary instrument panel for tracking whether the system is developing
 * or stagnating.
 *
 * Ashby analysis: Each metric is a first-class type (not a stringly-typed blob)
 * because the drift detection system (CANON §Drift Detection) needs to compare
 * metric trajectories across sessions. Type safety here prevents measurement
 * errors from corrupting health analysis.
 *
 * All metric types include computedAt for temporal tracking and windowSize
 * where applicable for sample validity assessment.
 *
 * Zero dependencies — this file has no imports.
 */

// ---------------------------------------------------------------------------
// Type 1 / Type 2 Ratio
// ---------------------------------------------------------------------------

/**
 * Ratio of Type 1 (graph reflex) to Type 2 (LLM-assisted) decisions.
 *
 * CANON §Development Metrics: "Type 1 / Type 2 ratio — Autonomy from LLM — Increasing over time"
 *
 * The ratio is type1Count / (type1Count + type2Count). A healthy trajectory
 * shows this ratio increasing over sessions as behaviors graduate to Type 1.
 *
 * CANON §Known Attractor States (Type 2 Addict): If ratio is not increasing
 * over time, the Type 2 cost structure or graduation thresholds need examination.
 */
export interface Type1Type2Ratio {
  /** Number of Type 1 decisions in the observation window. */
  readonly type1Count: number;

  /** Number of Type 2 decisions in the observation window. */
  readonly type2Count: number;

  /**
   * Computed ratio: type1Count / (type1Count + type2Count).
   * Range [0.0, 1.0]. 0.0 = all Type 2. 1.0 = all Type 1.
   * NaN if both counts are zero (no decisions in window).
   */
  readonly ratio: number;

  /**
   * Number of decisions in the measurement window.
   * Metric is unreliable if windowSize < 10.
   */
  readonly windowSize: number;

  /** Wall-clock time this metric was computed. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Prediction MAE
// ---------------------------------------------------------------------------

/**
 * Mean Absolute Error of Sylphie's predictions over a window of evaluations.
 *
 * CANON §Development Metrics: "Prediction MAE — World model accuracy — Decreasing, then stabilizing"
 *
 * Lower MAE = more accurate world model. The expected trajectory is declining
 * MAE in early sessions as the WKG builds substance, stabilizing when predictions
 * are accurate and the environment is understood.
 *
 * CANON §Confidence Dynamics: Type 1 graduation requires MAE < 0.10 over last 10 uses.
 * Type 1 demotion triggers when MAE > 0.15.
 */
export interface PredictionMAEMetric {
  /**
   * Mean absolute error across the sample window.
   * Range [0.0, 1.0]. 0.0 = perfect predictions. 1.0 = completely wrong.
   */
  readonly mae: number;

  /**
   * Number of prediction evaluations in this measurement window.
   * Metric is unreliable if sampleCount < 10.
   */
  readonly sampleCount: number;

  /**
   * Size of the rolling window these samples were drawn from.
   * E.g., windowSize=10 means the last 10 prediction evaluations.
   */
  readonly windowSize: number;

  /** Wall-clock time this metric was computed. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Experiential Provenance Ratio
// ---------------------------------------------------------------------------

/**
 * Breakdown of WKG knowledge by provenance source.
 *
 * CANON §Development Metrics: "Experiential provenance ratio — Self-constructed vs
 * LLM-provided knowledge — Increasing over time"
 *
 * Experiential knowledge = SENSOR + GUARDIAN + INFERENCE.
 * LLM-provided = LLM_GENERATED.
 *
 * experientialRatio = (sensor + guardian + inference) / total.
 *
 * If the graph is overwhelmingly LLM_GENERATED, the system is being populated
 * rather than developing (CANON §Learning).
 */
export interface ProvenanceRatio {
  /** Count of SENSOR provenance nodes/edges in the WKG. */
  readonly sensor: number;

  /** Count of GUARDIAN provenance nodes/edges in the WKG. */
  readonly guardian: number;

  /** Count of LLM_GENERATED provenance nodes/edges in the WKG. */
  readonly llmGenerated: number;

  /** Count of INFERENCE provenance nodes/edges in the WKG. */
  readonly inference: number;

  /**
   * Total count of all nodes/edges measured.
   * sensor + guardian + llmGenerated + inference + any extended provenance types.
   */
  readonly total: number;

  /**
   * Ratio of experiential (SENSOR + GUARDIAN + INFERENCE) to total.
   * Range [0.0, 1.0]. Healthy trend: increasing over sessions.
   * NaN if total is zero.
   */
  readonly experientialRatio: number;

  /** Wall-clock time this metric was computed. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Behavioral Diversity Index
// ---------------------------------------------------------------------------

/**
 * Unique action types used within a rolling window of N actions.
 *
 * CANON §Development Metrics: "Behavioral diversity index — Unique action types
 * per 20-action window — Stable at 4-8"
 *
 * CANON §A.15 (Satisfaction Habituation): Satisfaction requires behavioral
 * diversity — repeating the same successful action produces diminishing returns.
 * The diversity index measures whether this pressure is working.
 *
 * Healthy range: 4–8 unique action types per 20-action window.
 * Below 4: behavioral narrowing (see Known Attractor States).
 * Above 8: possible behavioral fragmentation or novelty-seeking runaway.
 */
export interface BehavioralDiversityIndex {
  /** Number of unique action type categories used in the measurement window. */
  readonly uniqueActionTypes: number;

  /**
   * Number of actions in the measurement window.
   * CANON specifies 20-action window for primary health tracking.
   */
  readonly windowSize: number;

  /**
   * The diversity index value.
   * Computed as: uniqueActionTypes / windowSize. Range (0.0, 1.0].
   * Healthy range corresponds to 4–8 unique types in a 20-window: index 0.20–0.40.
   */
  readonly index: number;

  /** Wall-clock time this metric was computed. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Guardian Response Rate
// ---------------------------------------------------------------------------

/**
 * Rate at which the guardian responds to Sylphie-initiated comments.
 *
 * CANON §Development Metrics: "Guardian response rate to comments — Quality of
 * self-initiated conversation — Increasing over time"
 *
 * CANON §A.15 (Social Comment Quality): Guardian response within 30 seconds
 * produces reinforcement. The response rate measures whether Sylphie is saying
 * things worth responding to.
 *
 * A healthy trajectory shows increasing response rate as Sylphie learns to
 * initiate comments that are relevant and engaging to the guardian.
 */
export interface GuardianResponseRate {
  /**
   * Number of Sylphie-initiated comments (SOCIAL_COMMENT_INITIATED events)
   * in the measurement window.
   */
  readonly initiated: number;

  /**
   * Number of guardian responses within 30 seconds of initiation.
   * Drawn from GUARDIAN_CONFIRMATION or any guardian input following initiation.
   */
  readonly responded: number;

  /**
   * Response rate: responded / initiated.
   * Range [0.0, 1.0]. Healthy trend: increasing over sessions.
   * NaN if initiated is zero.
   */
  readonly rate: number;

  /** Wall-clock time this metric was computed. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Interoceptive Accuracy
// ---------------------------------------------------------------------------

/**
 * Accuracy of Sylphie's self-reported emotional state vs actual drive state.
 *
 * CANON §Development Metrics: "Interoceptive accuracy — Self-awareness fidelity
 * — Improving toward >0.6"
 *
 * CANON Standard 1 (Theater Prohibition): Expressions must correlate with actual
 * drive state. Interoceptive accuracy measures how often Sylphie's KG(Self)
 * self-model accurately reflects the Drive Engine's output.
 *
 * selfReported: the drive values Sylphie's self-evaluation believes are active.
 * actual: the Drive Engine's PressureVector at the same timestamp.
 * accuracy: mean absolute deviation between the two, converted to [0.0, 1.0].
 *
 * A value of 1.0 means perfect self-awareness. 0.0 means complete disconnection
 * between self-model and actual drive state (maximum theater risk).
 */
export interface InteroceptiveAccuracy {
  /**
   * The self-evaluation score from KG(Self) at the measurement time.
   * Represents Sylphie's belief about her own drive state. Range [0.0, 1.0].
   */
  readonly selfReported: number;

  /**
   * The actual drive state score from the Drive Engine at the measurement time.
   * Derived from PressureVector.totalPressure normalized to [0.0, 1.0].
   */
  readonly actual: number;

  /**
   * Accuracy as 1.0 - |selfReported - actual|.
   * Range [0.0, 1.0]. Healthy target: > 0.6 (per CANON §Development Metrics).
   */
  readonly accuracy: number;

  /** Wall-clock time this measurement was taken. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Mean Drive Resolution Time
// ---------------------------------------------------------------------------

/**
 * Average time for a specific drive to move from elevated pressure to neutral.
 *
 * CANON §Development Metrics: "Mean drive resolution time — Efficiency of need
 * satisfaction — Decreasing over time"
 *
 * A decreasing resolution time indicates Sylphie is getting better at satisfying
 * her drives efficiently — she's learning what works and doing it faster.
 *
 * A stagnant or increasing resolution time for a specific drive may indicate
 * that the actions available for that drive are insufficient, or that a drive
 * is in the Depressive Attractor pattern (CANON §Known Attractor States).
 */
export interface MeanDriveResolutionTime {
  /**
   * The drive this metric tracks.
   * Each drive has its own resolution time profile.
   */
  readonly drive: string;

  /**
   * Mean time in milliseconds from when this drive exceeded 0.5 pressure
   * to when it returned below 0.3 pressure (resolved).
   */
  readonly meanMs: number;

  /**
   * Number of drive resolution events sampled to compute this mean.
   * Metric is unreliable if sampleCount < 5.
   */
  readonly sampleCount: number;

  /** Wall-clock time this metric was computed. */
  readonly computedAt: Date;
}

// ---------------------------------------------------------------------------
// Aggregate Health Metrics
// ---------------------------------------------------------------------------

/**
 * All seven CANON primary health metrics collected into a single snapshot.
 *
 * CANON §Development Metrics (7 primary health metrics):
 * 1. Type 1 / Type 2 ratio
 * 2. Prediction MAE
 * 3. Experiential provenance ratio
 * 4. Behavioral diversity index
 * 5. Guardian response rate to comments
 * 6. Interoceptive accuracy
 * 7. Mean drive resolution time (per drive)
 *
 * This aggregate is what the telemetry dashboard displays and what the drift
 * detection algorithm compares across sessions (CANON §Drift Detection: every 10 sessions).
 *
 * meanDriveResolutionTimes is a partial map — drives with insufficient data
 * (sampleCount < 5) are omitted rather than presenting unreliable metrics.
 */
export interface HealthMetrics {
  /** When this health snapshot was assembled. */
  readonly computedAt: Date;

  /** Session ID this health snapshot covers. */
  readonly sessionId: string;

  /** Metric 1: Type 1 / Type 2 decision ratio. */
  readonly type1Type2Ratio: Type1Type2Ratio;

  /** Metric 2: Prediction mean absolute error. */
  readonly predictionMAE: PredictionMAEMetric;

  /** Metric 3: Ratio of experiential to LLM-generated WKG knowledge. */
  readonly provenanceRatio: ProvenanceRatio;

  /** Metric 4: Behavioral diversity in a 20-action window. */
  readonly behavioralDiversityIndex: BehavioralDiversityIndex;

  /** Metric 5: Rate of guardian responses to Sylphie-initiated comments. */
  readonly guardianResponseRate: GuardianResponseRate;

  /** Metric 6: Self-awareness fidelity (self-model vs Drive Engine state). */
  readonly interoceptiveAccuracy: InteroceptiveAccuracy;

  /**
   * Metric 7: Mean drive resolution time, keyed by DriveName string value.
   * Partial — only drives with sufficient sample data (sampleCount >= 5) are included.
   */
  readonly meanDriveResolutionTimes: Readonly<Partial<Record<string, MeanDriveResolutionTime>>>;
}
