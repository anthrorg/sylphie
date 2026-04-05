/**
 * DriveSnapshot coherence validation.
 *
 * Validates each incoming snapshot from the Drive Engine child process
 * before it is cached by DriveReaderService. Coherence validation ensures
 * the child process is producing valid state and catches crashes or hangs.
 *
 * CANON §Drive Isolation: The snapshot represents immutable state from an
 * isolated process. Validation at the IPC boundary is the only opportunity
 * to detect child process failures before inconsistency propagates.
 */

import { DriveSnapshot, DRIVE_RANGE, computeTotalPressure } from '@sylphie/shared';
import { DriveCoherenceError } from '@sylphie/shared';

/**
 * Coherence validation result.
 *
 * On success, contains no error — the caller proceeds with caching.
 * On failure, contains the specific reason and diagnostic context.
 */
export interface CoherenceResult {
  readonly valid: boolean;
  readonly error?: DriveCoherenceError;
}

/**
 * Validate a DriveSnapshot for coherence before caching.
 *
 * Checks:
 * 1. All drive values in pressureVector are within [-10.0, 1.0]
 * 2. Not all drives are zero (would indicate child crash before initialization)
 * 3. totalPressure matches the sum of positive values in pressureVector
 * 4. Snapshot is not stale (timestamp is not more than 1s old from now)
 *
 * @param snapshot - The snapshot to validate
 * @param lastValidTimestamp - Timestamp of the last valid snapshot, for staleness detection
 * @returns CoherenceResult with valid=true on success, error details on failure
 */
export function validateDriveSnapshotCoherence(
  snapshot: DriveSnapshot,
  lastValidTimestamp?: Date,
): CoherenceResult {
  // Check 1: All drive values within bounds
  for (const [driveName, value] of Object.entries(snapshot.pressureVector)) {
    if (value < DRIVE_RANGE.min || value > DRIVE_RANGE.max) {
      return {
        valid: false,
        error: new DriveCoherenceError(
          `Drive value out of bounds: ${driveName} = ${value}, valid range is [${DRIVE_RANGE.min}, ${DRIVE_RANGE.max}]`,
          {
            driveName,
            value,
            validMin: DRIVE_RANGE.min,
            validMax: DRIVE_RANGE.max,
          },
        ),
      };
    }
  }

  // Check 2: Not all drives are zero (catch child crash)
  const allZero = Object.values(snapshot.pressureVector).every((v) => v === 0);
  if (allZero && snapshot.tickNumber > 0) {
    // Allow all-zero on cold start (tick 0), but not after the child has started
    return {
      valid: false,
      error: new DriveCoherenceError(
        'All drives are zero after initialization — child process may have crashed',
        {
          tickNumber: snapshot.tickNumber,
          timestamp: snapshot.timestamp.toISOString(),
        },
      ),
    };
  }

  // Check 3: totalPressure consistency
  const expectedTotalPressure = computeTotalPressure(snapshot.pressureVector);
  if (Math.abs(snapshot.totalPressure - expectedTotalPressure) > 0.001) {
    // Allow small floating-point error (0.001)
    return {
      valid: false,
      error: new DriveCoherenceError(
        `Total pressure mismatch: snapshot claims ${snapshot.totalPressure}, computed from pressureVector is ${expectedTotalPressure}`,
        {
          snapshotTotalPressure: snapshot.totalPressure,
          computedTotalPressure: expectedTotalPressure,
          tickNumber: snapshot.tickNumber,
        },
      ),
    };
  }

  // Check 4: Snapshot not stale (not hanging for >1s without update)
  // Skip staleness check when lastValidTimestamp is the cold-start epoch sentinel (new Date(0)).
  // The first real snapshot from the child process will always have a huge gap from epoch.
  if (lastValidTimestamp) {
    const lastValidMs = lastValidTimestamp instanceof Date ? lastValidTimestamp.getTime() : Number(lastValidTimestamp);
    if (lastValidMs > 0) {
      const snapshotMs = snapshot.timestamp instanceof Date ? snapshot.timestamp.getTime() : Number(snapshot.timestamp);
      const timeSinceLastValid = snapshotMs - lastValidMs;
      if (timeSinceLastValid > 1000) {
        return {
          valid: false,
          error: new DriveCoherenceError(
            `Snapshot is stale: ${timeSinceLastValid}ms since last valid snapshot — child process may be hung`,
            {
              snapshotTimestamp: snapshot.timestamp.toISOString(),
              lastValidTimestamp: lastValidTimestamp.toISOString(),
              staleDurationMs: timeSinceLastValid,
            },
          ),
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Create a deep JSON copy of a DriveSnapshot to prevent external mutation.
 *
 * The returned snapshot is a completely independent object. Modifications to
 * the returned snapshot will not affect the internal cached snapshot or vice versa.
 *
 * This is the defensive copy mechanism required by IDriveStateReader.getCurrentState().
 *
 * @param snapshot - The snapshot to copy
 * @returns A defensive JSON copy of the snapshot
 */
export function defensiveCopySnapshot(snapshot: DriveSnapshot): DriveSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}
