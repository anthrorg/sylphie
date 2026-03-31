/**
 * Drive value clamping and boundary checks.
 *
 * CANON §A.1: All drives are clamped to [-10.0, 1.0] after every
 * individual drive update and after cross-modulation.
 *
 * If any drive exceeds bounds, it indicates a tuning issue in
 * accumulation rates or cross-modulation coefficients.
 */

import {
  DriveName,
  DRIVE_RANGE,
  DRIVE_INDEX_ORDER,
  clampDriveValue,
} from '../../shared/types/drive.types';

/**
 * Check if a raw drive value is within valid bounds.
 *
 * @param value - The raw drive value
 * @returns true if value is in [-10.0, 1.0], false otherwise
 */
export function isWithinBounds(value: number): boolean {
  return value >= DRIVE_RANGE.min && value <= DRIVE_RANGE.max;
}

/**
 * Clamp a single drive value to [-10.0, 1.0].
 *
 * If the value exceeds bounds, logs a warning for tuning investigation.
 *
 * @param drive - The drive name (for logging)
 * @param value - The raw value to clamp
 * @param logger - Optional log function (defaults to stderr)
 * @returns The clamped value
 */
export function clampDrive(
  drive: DriveName,
  value: number,
  logger?: (msg: string) => void,
): number {
  const clamped = clampDriveValue(value);

  if (clamped !== value) {
    const msg = `[DriveClamp] ${drive} exceeded bounds: ${value.toFixed(3)} → ${clamped.toFixed(3)}`;
    if (logger) {
      logger(msg);
    } else if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(msg + '\n');
    }
  }

  return clamped;
}

/**
 * Clamp all drives in a state object.
 *
 * @param state - Mutable drive state object
 * @param logger - Optional log function for out-of-bounds warnings
 */
export function clampAllDrives(
  state: Record<DriveName, number>,
  logger?: (msg: string) => void,
): void {
  for (const drive of DRIVE_INDEX_ORDER) {
    state[drive] = clampDrive(drive, state[drive], logger);
  }
}

/**
 * Check for out-of-range drives and return diagnostic info.
 *
 * Useful for health checks or test verification.
 *
 * @param state - The drive state to check
 * @returns Object with out-of-bounds drives and count
 */
export function checkBounds(state: Record<DriveName, number>): {
  outOfBounds: Array<{ drive: DriveName; value: number; excess: number }>;
  count: number;
} {
  const outOfBounds: Array<{ drive: DriveName; value: number; excess: number }> = [];

  for (const drive of DRIVE_INDEX_ORDER) {
    const value = state[drive];
    if (!isWithinBounds(value)) {
      const excess =
        value > DRIVE_RANGE.max
          ? value - DRIVE_RANGE.max
          : DRIVE_RANGE.min - value;
      outOfBounds.push({ drive, value, excess });
    }
  }

  return { outOfBounds, count: outOfBounds.length };
}
