/**
 * Mutable drive state representation for the Drive Engine tick loop.
 *
 * CANON §Subsystem 4 (Drive Engine): The drive state vector is mutable
 * within the child process but immutable once published as a DriveSnapshot.
 *
 * This module manages the working copy of the 12 drives that accumulate,
 * decay, and respond to outcomes on each tick.
 */

import {
  DriveName,
  DRIVE_INDEX_ORDER,
  PressureVector,
  PressureDelta,
  INITIAL_DRIVE_STATE,
  clampDriveValue,
} from '@sylphie/shared';

/**
 * Mutable drive state vector.
 * Updated on each tick, then frozen and published as DriveSnapshot.
 */
export interface MutableDriveState {
  [DriveName.SystemHealth]: number;
  [DriveName.MoralValence]: number;
  [DriveName.Integrity]: number;
  [DriveName.CognitiveAwareness]: number;
  [DriveName.Guilt]: number;
  [DriveName.Curiosity]: number;
  [DriveName.Boredom]: number;
  [DriveName.Anxiety]: number;
  [DriveName.Satisfaction]: number;
  [DriveName.Sadness]: number;
  [DriveName.Focus]: number;
  [DriveName.Social]: number;
}

/**
 * Manager for the mutable drive state vector.
 *
 * Provides methods for:
 * - Creating initial state from INITIAL_DRIVE_STATE
 * - Applying accumulation and decay
 * - Applying outcomes (driveEffects)
 * - Computing deltas (change since last tick)
 * - Freezing to immutable PressureVector
 */
export class DriveStateManager {
  private current: MutableDriveState;
  private previous: MutableDriveState;

  constructor(initialState?: PressureVector) {
    const initial = initialState || INITIAL_DRIVE_STATE;
    this.current = this.copyState(initial);
    this.previous = this.copyState(initial);
  }

  /**
   * Apply accumulation or decay to all drives.
   *
   * @param rates Map of per-drive rates (positive for accumulation, negative for decay)
   */
  applyRates(rates: Record<DriveName, number>): void {
    for (const drive of DRIVE_INDEX_ORDER) {
      const rate = rates[drive];
      if (rate !== 0) {
        this.current[drive] += rate;
      }
    }
  }

  /**
   * Apply outcome effects to specific drives.
   *
   * @param effects Partial map of drive deltas from an action outcome
   */
  applyOutcomeEffects(effects: Partial<Record<DriveName, number>>): void {
    for (const [drive, delta] of Object.entries(effects)) {
      const driveName = drive as DriveName;
      this.current[driveName] += delta;
    }
  }

  /**
   * Apply a delta to a single drive.
   *
   * @param drive The drive to modify
   * @param delta The amount to add/subtract
   */
  applyDelta(drive: DriveName, delta: number): void {
    if (delta !== 0) {
      this.current[drive] += delta;
    }
  }

  /**
   * Clamp all drives to [-10.0, 1.0].
   * Logs if any drive exceeds bounds (tuning issue).
   */
  clampAll(): void {
    for (const drive of DRIVE_INDEX_ORDER) {
      const clamped = clampDriveValue(this.current[drive]);
      if (clamped !== this.current[drive]) {
        // Log warning for tuning issue
        if (typeof process !== 'undefined' && process.stderr) {
          const excess = this.current[drive] - clamped;
          process.stderr.write(
            `[DriveState] ${drive} exceeded bounds by ${excess.toFixed(3)}\n`,
          );
        }
      }
      this.current[drive] = clamped;
    }
  }

  /**
   * Compute deltas (current - previous) for all drives.
   */
  computeDeltas(): PressureDelta {
    const deltas: Record<DriveName, number> = {} as Record<DriveName, number>;
    for (const drive of DRIVE_INDEX_ORDER) {
      deltas[drive] = this.current[drive] - this.previous[drive];
    }
    return deltas as PressureDelta;
  }

  /**
   * Freeze the current state to an immutable PressureVector.
   */
  freezeCurrent(): PressureVector {
    return Object.freeze({ ...this.current }) as PressureVector;
  }

  /**
   * Advance the tick: save current as previous, prepare for next update.
   */
  advanceTick(): void {
    this.previous = this.copyState(this.current);
  }

  /**
   * Get a copy of the current state (for testing/debugging).
   */
  getCurrent(): Readonly<MutableDriveState> {
    return { ...this.current };
  }

  /**
   * Get a mutable reference to the current state.
   * Used by cross-modulation and clamping which modify state in-place.
   */
  getCurrentMutable(): MutableDriveState {
    return this.current;
  }

  /**
   * Get the previous state (from last tick).
   */
  getPrevious(): Readonly<MutableDriveState> {
    return { ...this.previous };
  }

  /**
   * Copy a state object.
   */
  private copyState(state: MutableDriveState | PressureVector): MutableDriveState {
    const copy: Record<DriveName, number> = {} as Record<DriveName, number>;
    for (const drive of DRIVE_INDEX_ORDER) {
      copy[drive] = state[drive];
    }
    return copy as MutableDriveState;
  }
}
