/**
 * Drive system types for Sylphie's motivational architecture.
 *
 * CANON §Subsystem 4 (Drive Engine): Computes motivational state via 12 drives
 * (4 core + 8 complement). Drive values range [-10.0, 1.0]:
 *   - Positive (0 to 1.0):   pressure — an unmet need pushing toward action.
 *   - Zero:                  neutral.
 *   - Negative (0 to -10.0): extended relief — a deeply satisfied drive that
 *                            stays quiet until natural accumulation returns it
 *                            toward zero. This creates organic behavioral
 *                            rhythms: periods of contentment, then gradual
 *                            re-emergence of need.
 *
 * Do NOT confuse this range with confidence values [0.0, 1.0].
 *
 * No cross-module imports. This file is a zero-dependency foundation.
 */

// ---------------------------------------------------------------------------
// Drive Names
// ---------------------------------------------------------------------------

/**
 * Canonical names for all 12 drives.
 *
 * Using a string enum rather than a union type so that the enum members can
 * be used as object keys directly (PressureVector, PressureDelta). The string
 * values are camelCase to match JSON serialization conventions throughout
 * the system.
 *
 * CANON §Subsystem 4 ordering: core drives (0–3), complement drives (4–11).
 */
export enum DriveName {
  // Core drives (indices 0–3)
  SystemHealth = 'systemHealth',
  MoralValence = 'moralValence',
  Integrity = 'integrity',
  CognitiveAwareness = 'cognitiveAwareness',

  // Complement drives (indices 4–11)
  Guilt = 'guilt',
  Curiosity = 'curiosity',
  Boredom = 'boredom',
  Anxiety = 'anxiety',
  Satisfaction = 'satisfaction',
  Sadness = 'sadness',
  InformationIntegrity = 'informationIntegrity',
  Social = 'social',
}

/**
 * Canonical drive ordering by index. Index-aligned with the Drive Engine's
 * internal vector representation. Use this when serializing a drive state as
 * an ordered array or when logging tick data.
 */
export const DRIVE_INDEX_ORDER: readonly DriveName[] = [
  DriveName.SystemHealth,
  DriveName.MoralValence,
  DriveName.Integrity,
  DriveName.CognitiveAwareness,
  DriveName.Guilt,
  DriveName.Curiosity,
  DriveName.Boredom,
  DriveName.Anxiety,
  DriveName.Satisfaction,
  DriveName.Sadness,
  DriveName.InformationIntegrity,
  DriveName.Social,
] as const;

// ---------------------------------------------------------------------------
// Drive Bounds
// ---------------------------------------------------------------------------

/**
 * Hard clamp bounds applied after every computation tick (CANON §A.14).
 *
 * min: -10.0  — lower bound allows significant relief buffering without
 *               unbounded negative accumulation.
 * max:   1.0  — upper bound caps pressure at 1.0 per drive.
 */
export const DRIVE_RANGE = {
  min: -10.0,
  max: 1.0,
} as const;

/**
 * Clamp a raw drive value to the valid range [-10.0, 1.0].
 *
 * Called by the Drive Engine after every individual drive update and after
 * cross-modulation (CANON §A.1). Not intended for use outside the Drive
 * Engine process — exported here as a pure utility so it can be tested
 * without spinning up the full engine.
 *
 * @param value - Unclamped drive value
 * @returns Value clamped to [DRIVE_RANGE.min, DRIVE_RANGE.max]
 */
export function clampDriveValue(value: number): number {
  return Math.min(DRIVE_RANGE.max, Math.max(DRIVE_RANGE.min, value));
}

// ---------------------------------------------------------------------------
// Drive Vectors
// ---------------------------------------------------------------------------

/**
 * All 12 drive values as a readonly snapshot. Values in [-10.0, 1.0].
 *
 * This is an immutable value object — the Drive Engine publishes a new
 * PressureVector on every tick. Nothing outside the Drive Engine process
 * may write to a PressureVector after publication.
 */
export interface PressureVector {
  readonly [DriveName.SystemHealth]: number;
  readonly [DriveName.MoralValence]: number;
  readonly [DriveName.Integrity]: number;
  readonly [DriveName.CognitiveAwareness]: number;
  readonly [DriveName.Guilt]: number;
  readonly [DriveName.Curiosity]: number;
  readonly [DriveName.Boredom]: number;
  readonly [DriveName.Anxiety]: number;
  readonly [DriveName.Satisfaction]: number;
  readonly [DriveName.Sadness]: number;
  readonly [DriveName.InformationIntegrity]: number;
  readonly [DriveName.Social]: number;
}

/**
 * Change in drive values since the previous tick, published alongside the
 * current PressureVector in each DriveSnapshot.
 *
 * Required for Ashby-style attractor state detection (CANON §A.10):
 * sustained high derivatives indicate a drive is not resolving.
 * Positive delta = pressure is increasing. Negative delta = pressure is
 * decreasing (drive relief is occurring).
 */
export interface PressureDelta {
  readonly [DriveName.SystemHealth]: number;
  readonly [DriveName.MoralValence]: number;
  readonly [DriveName.Integrity]: number;
  readonly [DriveName.CognitiveAwareness]: number;
  readonly [DriveName.Guilt]: number;
  readonly [DriveName.Curiosity]: number;
  readonly [DriveName.Boredom]: number;
  readonly [DriveName.Anxiety]: number;
  readonly [DriveName.Satisfaction]: number;
  readonly [DriveName.Sadness]: number;
  readonly [DriveName.InformationIntegrity]: number;
  readonly [DriveName.Social]: number;
}

// ---------------------------------------------------------------------------
// Rule Matching
// ---------------------------------------------------------------------------

/**
 * Result of attempting to match a behavioral event against Postgres drive
 * rules (CANON §Subsystem 4, step 3).
 *
 * ruleId:    The ID of the matched rule, or null if no rule matched and the
 *            Drive Engine fell back to Default Affect (CANON §A.14).
 * eventType: The event type string that was looked up.
 * matched:   True if a specific rule was found; false if default affect applied.
 */
export interface RuleMatchResult {
  readonly ruleId: string | null;
  readonly eventType: string;
  readonly matched: boolean;
}

// ---------------------------------------------------------------------------
// Drive Snapshot
// ---------------------------------------------------------------------------

/**
 * Enriched drive state snapshot published by the Drive Engine at every tick.
 *
 * Includes the current pressure vector, per-tick deltas for attractor
 * detection (Ashby analysis, CANON §A.10), the rule match that produced the
 * current update, and summary statistics. This is the single object that
 * other subsystems receive when they subscribe to drive state changes.
 *
 * CANON §Drive Isolation: Consumers receive DriveSnapshot as read-only data.
 * No subsystem may write back to the Drive Engine through this type.
 */
export interface DriveSnapshot {
  /** Current drive values after clamping. All values in [-10.0, 1.0]. */
  readonly pressureVector: PressureVector;

  /** Wall-clock time this snapshot was computed. */
  readonly timestamp: Date;

  /**
   * Monotonically increasing tick counter since Drive Engine process start.
   * Used to correlate TimescaleDB events with specific tick boundaries.
   */
  readonly tickNumber: number;

  /**
   * Per-drive change since the preceding tick.
   * Positive = pressure increasing. Negative = pressure decreasing (relief).
   * Required for attractor state detection.
   */
  readonly driveDeltas: PressureDelta;

  /** The rule match (or default affect fallback) that produced this update. */
  readonly ruleMatchResult: RuleMatchResult;

  /**
   * Sum of all positive drive values in the current pressureVector.
   * Represents total unmet need. Range [0.0, 12.0].
   * Drives at or below zero contribute nothing to this sum.
   */
  readonly totalPressure: number;

  /** Session ID for correlating snapshots with TimescaleDB session records. */
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Cold Start
// ---------------------------------------------------------------------------

/**
 * Initial drive state for cold start (CANON §A.14).
 *
 * Total initial pressure: 2.5 (20.8% of max 12.0). Curiosity (0.3) and
 * Social (0.5) are slightly elevated — she starts wanting to explore and
 * interact. Satisfaction and Sadness begin at zero because she has no history
 * to produce either. Guilt begins at zero — no corrections have occurred yet.
 */
export const INITIAL_DRIVE_STATE: Readonly<PressureVector> = {
  [DriveName.SystemHealth]: 0.2,
  [DriveName.MoralValence]: 0.2,
  [DriveName.Integrity]: 0.2,
  [DriveName.CognitiveAwareness]: 0.2,
  [DriveName.Guilt]: 0.0,
  [DriveName.Curiosity]: 0.3,
  [DriveName.Boredom]: 0.4,
  [DriveName.Anxiety]: 0.2,
  [DriveName.Satisfaction]: 0.0,
  [DriveName.Sadness]: 0.0,
  [DriveName.InformationIntegrity]: 0.1,
  [DriveName.Social]: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Drive Category Classification
// ---------------------------------------------------------------------------

/** The four core drives. Always accumulate; represent fundamental needs. */
export const CORE_DRIVES: readonly DriveName[] = [
  DriveName.SystemHealth,
  DriveName.MoralValence,
  DriveName.Integrity,
  DriveName.CognitiveAwareness,
] as const;

/** The eight complement drives. Mix of accumulating and event-only. */
export const COMPLEMENT_DRIVES: readonly DriveName[] = [
  DriveName.Guilt,
  DriveName.Curiosity,
  DriveName.Boredom,
  DriveName.Anxiety,
  DriveName.Satisfaction,
  DriveName.Sadness,
  DriveName.InformationIntegrity,
  DriveName.Social,
] as const;

/**
 * Compute the total pressure scalar for a given PressureVector.
 *
 * Sums only positive drive values. Drives in the negative range (extended
 * relief) are not counted as unmet need. The result is in [0.0, 12.0].
 *
 * This matches the totalPressure field on DriveSnapshot — exported here as
 * a pure function so tests and the Drive Engine can compute it identically.
 *
 * @param vector - A PressureVector to sum
 * @returns Total unmet pressure in [0.0, 12.0]
 */
export function computeTotalPressure(vector: PressureVector): number {
  let total = 0;
  for (const drive of DRIVE_INDEX_ORDER) {
    const value = vector[drive];
    if (value > 0) {
      total += value;
    }
  }
  return total;
}
