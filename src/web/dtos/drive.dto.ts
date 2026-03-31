/**
 * Drive-related DTOs for exposing drive state over HTTP/WebSocket.
 *
 * CANON §Subsystem 4 (Drive Engine): Drives are the core motivational
 * engine. These DTOs serialize drive state for telemetry and real-time
 * visualization on the frontend.
 *
 * All drive values are in the range [-10.0, 1.0]:
 * - Positive (0 to 1.0): unmet need (pressure)
 * - Zero: neutral
 * - Negative (0 to -10.0): satisfied (relief) that decays over time
 */

// ---------------------------------------------------------------------------
// Drive Values
// ---------------------------------------------------------------------------

/**
 * A single drive's current name and value.
 *
 * Serializes one element of the 12-drive state. Used in arrays
 * to represent a complete pressure vector.
 */
export interface DriveValueDto {
  /**
   * The drive name (camelCase string from DriveName enum).
   * Examples: 'systemHealth', 'curiosity', 'satisfaction'
   */
  readonly name: string;

  /** Current drive value in [-10.0, 1.0]. */
  readonly value: number;
}

// ---------------------------------------------------------------------------
// Drive Snapshots
// ---------------------------------------------------------------------------

/**
 * DriveSnapshotDto — serialized drive state snapshot.
 *
 * A complete snapshot of all 12 drives at a specific moment in time.
 * Used in telemetry frames, conversation messages, and as part of
 * the health/metrics response.
 *
 * drives is an array of all 12 drive values (ordered by DriveName enum).
 * totalPressure is the sum of all positive drive values (unmet need).
 * tickNumber is the Drive Engine's monotonic counter for correlation with TimescaleDB.
 */
export interface DriveSnapshotDto {
  /** All 12 drive values at this snapshot time. */
  readonly drives: readonly DriveValueDto[];

  /**
   * Sum of all positive drive values in the snapshot.
   * Represents total unmet need. Range [0.0, 12.0].
   * Used by the Theater Prohibition validator and for overall pressure visualization.
   */
  readonly totalPressure: number;

  /** Drive Engine's monotonic tick counter for correlation. */
  readonly tickNumber: number;

  /** Wall-clock timestamp in milliseconds since epoch. */
  readonly timestamp: number;
}

/**
 * DriveStateResponse — current drive state endpoint.
 *
 * Returned by GET /api/drives/current. Provides a snapshot view
 * of the current drive state without history.
 */
export interface DriveStateResponse {
  /** The current drive snapshot. */
  readonly current: DriveSnapshotDto;
}

// ---------------------------------------------------------------------------
// Drive History
// ---------------------------------------------------------------------------

/**
 * A single data point in drive history.
 *
 * Represents the drive state at a specific moment, used for
 * graphing drive trends over time.
 */
export interface DriveHistoryPoint {
  /** Wall-clock timestamp in milliseconds since epoch. */
  readonly timestamp: number;

  /** All 12 drive values at this point in time. */
  readonly drives: readonly DriveValueDto[];

  /** Total pressure (sum of positive values) at this point. */
  readonly totalPressure: number;
}

/**
 * DriveHistoryResponse — historical drive state data.
 *
 * Returned by GET /api/drives/history?from={ts}&to={ts}&resolution={unit}.
 * Provides a time-series view for charting drive trends.
 *
 * resolution indicates the aggregation granularity ('minute', 'hour', 'day').
 */
export interface DriveHistoryResponse {
  /** Array of drive history points, chronologically ordered. */
  readonly points: readonly DriveHistoryPoint[];

  /** Start timestamp (milliseconds since epoch) of the requested range. */
  readonly from: number;

  /** End timestamp (milliseconds since epoch) of the requested range. */
  readonly to: number;

  /** Aggregation resolution used ('minute', 'hour', 'day'). */
  readonly resolution: string;
}
