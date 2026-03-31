/**
 * Health metrics DTOs for dashboard and telemetry.
 *
 * CANON §Development Metrics: These DTOs serialize the seven primary
 * health metrics for display on the frontend and for drift detection
 * analysis across sessions.
 *
 * Metrics are computed by the Decision Making subsystem and persisted
 * in PostgreSQL for historical analysis.
 */

// ---------------------------------------------------------------------------
// Metric Value with History
// ---------------------------------------------------------------------------

/**
 * A single data point in a metric's history.
 *
 * Used to chart metric trends over time (e.g., Type 1/Type 2 ratio
 * increasing session-over-session, or prediction MAE decreasing).
 */
export interface MetricHistoryPoint {
  /** Wall-clock timestamp in milliseconds since epoch. */
  readonly timestamp: number;

  /** Metric value at this timestamp. */
  readonly value: number;
}

/**
 * MetricValue — a single metric with trend data.
 *
 * CANON §Development Metrics: Includes the metric name, current value,
 * trend indicator (improving/stable/declining), and a history of
 * recent measurements for charting.
 */
export interface MetricValue {
  /**
   * Metric name, one of the seven CANON metrics:
   * - Type1Type2Ratio
   * - PredictionMAE
   * - ProvenanceRatio
   * - BehavioralDiversityIndex
   * - GuardianResponseRate
   * - InteroceptiveAccuracy
   * - MeanDriveResolutionTime
   */
  readonly name: string;

  /** Current value of the metric. */
  readonly value: number;

  /**
   * Trend indicator based on recent history.
   * - 'improving': metric moving in positive direction
   * - 'stable': metric not changing significantly
   * - 'declining': metric moving in negative direction
   */
  readonly trend: 'improving' | 'stable' | 'declining';

  /** Recent history points for charting (typically last 10-20 measurements). */
  readonly history: readonly MetricHistoryPoint[];
}

// ---------------------------------------------------------------------------
// Metrics Response
// ---------------------------------------------------------------------------

/**
 * MetricsResponse — all seven CANON health metrics.
 *
 * Returned by GET /api/metrics or streamed over WebSocket.
 * Provides a complete snapshot of Sylphie's development state
 * for the frontend dashboard.
 *
 * CANON §Development Metrics: The seven metrics are:
 * 1. Type 1 / Type 2 ratio — autonomy from LLM
 * 2. Prediction MAE — world model accuracy
 * 3. Experiential provenance ratio — self-constructed vs LLM-provided knowledge
 * 4. Behavioral diversity index — unique action types per 20-action window
 * 5. Guardian response rate — quality of self-initiated conversation
 * 6. Interoceptive accuracy — self-awareness fidelity
 * 7. Mean drive resolution time — efficiency of need satisfaction
 */
export interface MetricsResponse {
  /** Array of all available metrics with current values and trends. */
  readonly metrics: readonly MetricValue[];

  /** Wall-clock timestamp in milliseconds when this metrics snapshot was computed. */
  readonly timestamp: number;
}
