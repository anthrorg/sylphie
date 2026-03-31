/**
 * Metrics module interfaces: health computation, drift detection, and attractor monitoring.
 *
 * CANON §Development Metrics: Seven primary health metrics measure system autonomy.
 * CANON §Drift Detection: Every 10 sessions, the system checks whether health
 * metrics are drifting toward known failure modes (attractors).
 *
 * IMetricsComputation calculates raw health metrics from event logs.
 * IDriftDetection identifies anomalies in metric trajectories.
 * IAttractorDetection assesses proximity to the six known attractor states.
 *
 * Zero dependencies preferred. All types carry temporal context (computedAt).
 */

import type { HealthMetrics } from '../../shared/types/metrics.types';

// ---------------------------------------------------------------------------
// Drift Detection Types
// ---------------------------------------------------------------------------

/**
 * Severity level for a detected drift anomaly.
 *
 * - 'INFO':     Observation for record; no immediate action needed
 * - 'WARNING':  Metric is drifting; monitor closely in next session
 * - 'CRITICAL': Metric has crossed a hard threshold; intervention recommended
 */
export type DriftSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * A single detected anomaly in a health metric trajectory.
 *
 * Drift detection compares current metrics against a baseline captured ~10 sessions ago.
 * When a metric falls outside expected bounds, an anomaly is recorded with:
 * - The metric name and observed value
 * - Expected range (min/max)
 * - Recommended action
 */
export interface DriftAnomaly {
  /**
   * The name of the metric in which drift was detected.
   * Example: 'type1Ratio', 'predictionMAE', 'guardianResponseRate'
   */
  readonly metric: string;

  /**
   * The actual observed value for this metric in the current session.
   */
  readonly observedValue: number;

  /**
   * The lower bound of the expected range for this metric (from baseline).
   */
  readonly expectedMin: number;

  /**
   * The upper bound of the expected range for this metric (from baseline).
   */
  readonly expectedMax: number;

  /**
   * Severity of the drift.
   * Used for triage and alerting priority.
   */
  readonly severity: DriftSeverity;

  /**
   * A human-readable recommendation for addressing this drift.
   * Example: "Type 1 ratio declining; check graduation threshold and Type 2 cost structure"
   */
  readonly recommendation: string;
}

/**
 * Comprehensive drift metrics: health trends and anomalies.
 *
 * CANON §Drift Detection: Every 10 sessions, the system compares the current
 * health snapshot against a baseline captured 10 sessions prior. If metrics
 * have drifted beyond expected bounds, anomalies are flagged.
 *
 * All five dimensions measure different aspects of autonomy:
 * 1. cumulativeRecordSlope: Is the session count growing? (meta-metric)
 * 2. behavioralDiversityTrend: Are we trying new actions or narrowing? (attractor risk)
 * 3. predictionAccuracyTrend: Is our world model improving? (learning signal)
 * 4. guardianInteractionQuality: Are our comments worth responding to? (social signal)
 * 5. sustainedDrivePatterns: Are drives cycling normally or stuck? (attractor risk)
 */
export interface DriftMetrics {
  /**
   * Slope of session count over the baseline window.
   * Typically 10 sessions / baseline period. Used to validate that samples
   * are meaningful (not just one stale session).
   */
  readonly cumulativeRecordSlope: number;

  /**
   * Trend in behavioral diversity index over the baseline window.
   * Positive = improving diversity. Negative = narrowing. Zero = stable.
   * Used to detect satisfaction habituation or behavioral rigidity.
   */
  readonly behavioralDiversityTrend: number;

  /**
   * Trend in prediction MAE over the baseline window.
   * Negative = improving accuracy. Positive = degrading. Zero = stable.
   * Used to detect whether the world model is converging or diverging.
   */
  readonly predictionAccuracyTrend: number;

  /**
   * Trend in guardian response rate over the baseline window.
   * Positive = improving response rate. Negative = declining engagement.
   * Used to detect whether Sylphie's comments are becoming more relevant.
   */
  readonly guardianInteractionQuality: number;

  /**
   * Sustained drive pressure patterns observed during the baseline window.
   * Each entry: { drive: DriveName, duration: milliseconds, value: mean pressure }
   * Used to detect stuck drives or depressive attractor patterns.
   */
  readonly sustainedDrivePatterns: readonly { readonly drive: string; readonly duration: number; readonly value: number }[];

  /**
   * All detected drift anomalies in this session (may be empty).
   * Each anomaly flagged outside baseline bounds is included.
   */
  readonly anomalies: readonly DriftAnomaly[];

  /** Wall-clock time when drift metrics were computed. */
  readonly computedAt: Date;

  /**
   * The observation window size (in sessions) used for trend computation.
   * Typically 10. Used to validate metric reliability.
   */
  readonly sessionWindow: number;
}

// ---------------------------------------------------------------------------
// Attractor Monitoring
// ---------------------------------------------------------------------------

/**
 * Assessment of proximity to a single known attractor state.
 *
 * CANON §Known Attractor States: Six dangerous failure modes have been identified.
 * Each has a characteristic metric signature. As the system approaches an attractor,
 * specific metrics exhibit telltale patterns. This type captures that proximity.
 *
 * attractorName is one of:
 * - 'type2Addict': LLM always wins; Type 1 never develops
 * - 'ruleDrift': Self-generated drive rules diverge from design intent
 * - 'hallucinatedKnowledge': LLM generates plausible but false graph content
 * - 'depressiveAttractor': Negative self-evaluations create feedback loop
 * - 'planningRunaway': Too many prediction failures create resource exhaustion
 * - 'predictionPessimist': Early failures flood system with low-quality procedures
 */
export interface AttractorProximity {
  /**
   * Name of the attractor this assessment tracks.
   */
  readonly attractorName: string;

  /**
   * Proximity score in [0.0, 1.0].
   * - 0.0: far from attractor (healthy)
   * - 0.5: approaching (warning zone)
   * - 1.0: in the attractor (critical)
   *
   * Derived from metric signature analysis.
   */
  readonly proximityScore: number;

  /**
   * Threshold at which a warning should be raised.
   * Typically 0.5–0.6. When proximityScore exceeds this, isWarning = true.
   */
  readonly warningThreshold: number;

  /**
   * Critical threshold. When proximityScore exceeds this, isCritical = true
   * and intervention is recommended.
   * Typically 0.75–0.85.
   */
  readonly criticalThreshold: number;

  /**
   * True if proximityScore exceeds warningThreshold.
   * Indicates the system is drifting toward this attractor.
   */
  readonly isWarning: boolean;

  /**
   * True if proximityScore exceeds criticalThreshold.
   * Indicates critical risk; immediate intervention recommended.
   */
  readonly isCritical: boolean;

  /**
   * List of specific metric anomalies contributing to proximity.
   * Example: ["type1Ratio stalled at 0.15", "predictionMAE increasing"]
   * Used for human-readable diagnosis.
   */
  readonly indicators: readonly string[];

  /**
   * Specific action recommended to avoid or escape this attractor.
   * Example: "Increase Type 2 latency cost or lower graduation threshold"
   */
  readonly recommendedAction: string;
}

/**
 * Comprehensive attractor report: proximity to all six known attractors.
 *
 * Computed every 10 sessions as part of drift detection. Guards against
 * the system silently drifting into a failure mode.
 *
 * Each field corresponds to one of the six attractors. The overallRisk field
 * is the worst-case severity across all attractors.
 */
export interface AttractorReport {
  /** Proximity to the Type 2 Addict attractor. */
  readonly type2Addict: AttractorProximity;

  /** Proximity to the Rule Drift attractor. */
  readonly ruleDrift: AttractorProximity;

  /** Proximity to the Hallucinated Knowledge attractor. */
  readonly hallucinatedKnowledge: AttractorProximity;

  /** Proximity to the Depressive Attractor. */
  readonly depressiveAttractor: AttractorProximity;

  /** Proximity to the Planning Runaway attractor. */
  readonly planningRunaway: AttractorProximity;

  /** Proximity to the Prediction Pessimist attractor. */
  readonly predictionPessimist: AttractorProximity;

  /** Wall-clock time when this report was computed. */
  readonly computedAt: Date;

  /**
   * Overall risk classification.
   * - 'LOW':      No attractors in critical zone
   * - 'MEDIUM':   One or more in warning zone
   * - 'HIGH':     One or more in critical zone
   * - 'CRITICAL': Multiple critical attractors or convergence detected
   */
  readonly overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

// ---------------------------------------------------------------------------
// Development Baseline
// ---------------------------------------------------------------------------

/**
 * A baseline snapshot of health metrics captured at a specific point.
 *
 * Used for drift detection. Every 10 sessions, a new baseline is captured.
 * Future metrics are compared against this baseline to detect drift.
 *
 * The sessionCount at capture time is used to validate that the baseline
 * represents a meaningful sample (e.g., at least 10 sessions of data).
 */
export interface DevelopmentBaseline {
  /**
   * The session count at the time this baseline was captured.
   * Used to validate baseline age and relevance.
   */
  readonly sessionCount: number;

  /** Wall-clock time when this baseline was captured. */
  readonly capturedAt: Date;

  /**
   * The health metrics snapshot at the time of capture.
   * All seven primary health metrics included.
   */
  readonly healthSnapshot: HealthMetrics;

  /**
   * Expected ranges (min/max) for each health metric.
   * Used by drift detection to flag anomalies.
   * Keyed by metric name (e.g., 'type1Ratio', 'predictionMAE').
   */
  readonly driftBaselines: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Metrics Computation Interface
// ---------------------------------------------------------------------------

/**
 * Service that computes the seven primary health metrics from event logs.
 *
 * IMetricsComputation reads events from TimescaleDB and synthesizes them into
 * first-class metric types. It is the source of truth for health status.
 *
 * Injection point: Provided by the Metrics module.
 */
export interface IMetricsComputation {
  /**
   * Compute all seven primary health metrics for a given session.
   *
   * Reads all relevant events from TimescaleDB for the session, aggregates them,
   * and returns a complete HealthMetrics snapshot. This is a heavy operation and
   * should typically be called once per session (or once per 10 sessions for
   * baseline snapshots).
   *
   * @param sessionId - The session to compute metrics for
   * @returns HealthMetrics with all seven primary metrics
   * @throws MetricsComputationError if event query or aggregation fails
   */
  computeHealthMetrics(sessionId: string): Promise<HealthMetrics>;

  /**
   * Compute drift metrics for the most recent session window.
   *
   * Compares current health metrics against a baseline captured ~sessionWindow
   * sessions ago. Returns the drift summary with anomalies and trend scores.
   *
   * @param sessionWindow - Number of sessions to compare (typically 10)
   * @returns DriftMetrics with anomalies and trend analysis
   * @throws MetricsComputationError if baseline lookup or comparison fails
   */
  computeDriftMetrics(sessionWindow: number): Promise<DriftMetrics>;
}

// ---------------------------------------------------------------------------
// Drift Detection Interface
// ---------------------------------------------------------------------------

/**
 * Service that detects health metric drift and anomalies.
 *
 * IDriftDetection implements the anomaly detection algorithm (CANON §Drift Detection).
 * It maintains baseline snapshots and compares new metrics against historical trends.
 *
 * Injection point: Provided by the Metrics module.
 */
export interface IDriftDetection {
  /**
   * Detect all anomalies in the provided drift metrics.
   *
   * Compares each metric in currentMetrics against baseline expectations.
   * Returns all detected anomalies (empty array if no anomalies found).
   *
   * @param currentMetrics - The DriftMetrics for the current session
   * @returns Array of detected DriftAnomaly objects (may be empty)
   */
  detectDrift(currentMetrics: DriftMetrics): DriftAnomaly[];

  /**
   * Get the currently active development baseline.
   *
   * Returns the most recent baseline snapshot, or null if no baseline
   * has been captured yet (e.g., system just started).
   *
   * @returns The active DevelopmentBaseline, or null if none exists
   */
  getBaseline(): DevelopmentBaseline | null;

  /**
   * Capture a new development baseline.
   *
   * Called every 10 sessions to establish new expectations for drift detection.
   * Stores the baseline in the Metrics module's persistent storage.
   *
   * @param metrics - The HealthMetrics to establish as the baseline
   * @param sessionCount - The session number at baseline capture time
   * @returns The captured DevelopmentBaseline
   * @throws MetricsComputationError if baseline persistence fails
   */
  captureBaseline(metrics: HealthMetrics, sessionCount: number): Promise<DevelopmentBaseline>;

  /**
   * Compare current drift metrics against the active baseline.
   *
   * Computes anomalies by comparing metrics to baseline expectations.
   * This is a convenience method combining getBaseline() + detectDrift().
   *
   * @param current - The DriftMetrics for the current session
   * @returns Array of detected DriftAnomaly objects
   */
  compareToBaseline(current: DriftMetrics): DriftAnomaly[];
}

// ---------------------------------------------------------------------------
// Attractor Detection Interface
// ---------------------------------------------------------------------------

/**
 * Service that assesses proximity to known attractor states.
 *
 * IAttractorDetection implements the attractor detection algorithm by analyzing
 * metric signatures against known patterns. It generates an AttractorReport every
 * 10 sessions as part of drift detection.
 *
 * Injection point: Provided by the Metrics module.
 */
export interface IAttractorDetection {
  /**
   * Assess proximity to all six known attractors.
   *
   * Analyzes the current health metrics and drift anomalies to compute proximity
   * scores for each attractor. Returns a comprehensive report with per-attractor
   * proximity, warnings, and recommendations.
   *
   * @returns AttractorReport with all six attractor assessments
   * @throws MetricsComputationError if metric analysis fails
   */
  assessProximity(): Promise<AttractorReport>;

  /**
   * Get all attractors currently in warning or critical zone.
   *
   * Convenience method for quick triage. Returns a list of AttractorProximity
   * objects for attractors where isWarning or isCritical is true.
   *
   * @returns Array of warned/critical AttractorProximity objects (may be empty)
   */
  getWarnings(): readonly AttractorProximity[];
}
