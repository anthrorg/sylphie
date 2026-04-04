/**
 * Drive baseline adjustment logic for self-evaluation.
 *
 * Based on self-assessed capabilities, adjusts drive baselines to prevent
 * identity lock-in. The baseline is the starting point for accumulation each tick.
 *
 * CANON §E4-T008: Gradual baseline recovery prevents permanent depression
 * from transient failures.
 */

import {
  DriveName,
  INITIAL_DRIVE_STATE,
  PressureVector,
} from '@sylphie/shared';
import {
  CAPABILITY_TO_DRIVE_MAP,
  BASELINE_REDUCTION_RATE,
  BASELINE_RECOVERY_RATE,
  LOW_CAPABILITY_THRESHOLD,
  HIGH_CAPABILITY_THRESHOLD,
} from '../constants/self-evaluation';
import { SelfCapability } from '../interfaces/self-kg.interfaces';

/**
 * Tracks baseline adjustments per drive to enable gradual recovery.
 * Stores the current adjusted baseline (may be below the default).
 */
export class DriveBaselineAdjustment {
  /**
   * Current baseline overrides per drive.
   * undefined = use default (INITIAL_DRIVE_STATE)
   * number = current adjusted baseline (may be negative of default)
   */
  private adjustedBaselines: Partial<Record<DriveName, number>> = {};

  /**
   * Compute the effective baseline for a drive.
   * Returns the adjusted baseline if one exists, otherwise the default.
   *
   * @param drive The drive to get the baseline for
   * @returns The baseline value for that drive
   */
  public getBaseline(drive: DriveName): number {
    const adjusted = this.adjustedBaselines[drive];
    if (adjusted !== undefined) {
      return adjusted;
    }
    return INITIAL_DRIVE_STATE[drive];
  }

  /**
   * Set the baseline for a drive.
   * Used internally by adjustment logic.
   *
   * @param drive The drive to adjust
   * @param baseline The new baseline value
   */
  private setBaseline(drive: DriveName, baseline: number): void {
    this.adjustedBaselines[drive] = baseline;
  }

  /**
   * Apply baseline adjustments based on self-assessed capabilities.
   *
   * Logic:
   * - If capability < LOW_CAPABILITY_THRESHOLD: reduce baseline by BASELINE_REDUCTION_RATE
   * - If capability >= HIGH_CAPABILITY_THRESHOLD: maintain default baseline
   * - Otherwise: no change needed
   *
   * @param capabilities Array of capabilities from KG(Self)
   */
  public adjustBaselinesFromCapabilities(capabilities: SelfCapability[]): void {
    for (const capability of capabilities) {
      // Look up which drive(s) this capability affects
      const driveName = CAPABILITY_TO_DRIVE_MAP[capability.name];
      if (!driveName) {
        continue; // Unknown capability, skip
      }

      const successRate = capability.successRate;

      if (successRate < LOW_CAPABILITY_THRESHOLD) {
        // Low capability: reduce baseline
        const current = this.getBaseline(driveName);
        const adjusted = Math.max(-10.0, current - BASELINE_REDUCTION_RATE);
        this.setBaseline(driveName, adjusted);

        if (typeof process !== 'undefined' && process.stderr) {
          process.stderr.write(
            `[DriveBaselineAdjustment] ${driveName}: ${capability.name} low (${successRate.toFixed(2)}), reducing baseline from ${current.toFixed(3)} to ${adjusted.toFixed(3)}\n`,
          );
        }
      } else if (successRate >= HIGH_CAPABILITY_THRESHOLD) {
        // High capability: restore toward default
        const current = this.getBaseline(driveName);
        const defaultBaseline = INITIAL_DRIVE_STATE[driveName];

        if (current < defaultBaseline) {
          // Gradually recover
          const recovered = Math.min(defaultBaseline, current + BASELINE_RECOVERY_RATE);
          this.setBaseline(driveName, recovered);

          if (typeof process !== 'undefined' && process.stderr) {
            process.stderr.write(
              `[DriveBaselineAdjustment] ${driveName}: ${capability.name} high (${successRate.toFixed(2)}), recovering baseline from ${current.toFixed(3)} to ${recovered.toFixed(3)}\n`,
            );
          }
        }
      }
    }

    // For all unmapped drives, apply gradual recovery
    this.applyGeneralRecovery();
  }

  /**
   * Apply general baseline recovery for drives not recently assessed.
   * Slowly restores all adjusted baselines back toward their defaults.
   * This prevents permanent identity lock-in from past failures.
   */
  private applyGeneralRecovery(): void {
    for (const drive of Object.keys(this.adjustedBaselines) as DriveName[]) {
      const current = this.adjustedBaselines[drive]!;
      const defaultBaseline = INITIAL_DRIVE_STATE[drive];

      if (current < defaultBaseline) {
        const recovered = Math.min(defaultBaseline, current + BASELINE_RECOVERY_RATE);
        this.adjustedBaselines[drive] = recovered;

        if (typeof process !== 'undefined' && process.stderr) {
          process.stderr.write(
            `[DriveBaselineAdjustment] ${drive}: general recovery from ${current.toFixed(3)} to ${recovered.toFixed(3)}\n`,
          );
        }
      } else if (current > defaultBaseline) {
        // If somehow above default (shouldn't happen), decay back
        const recovered = Math.max(defaultBaseline, current - BASELINE_RECOVERY_RATE);
        this.adjustedBaselines[drive] = recovered;
      }
    }
  }

  /**
   * Get all current adjusted baselines as a record.
   * Used for creating a modified accumulation rates map.
   *
   * @returns Record of drive -> baseline value
   */
  public getAllAdjustedBaselines(): Record<DriveName, number> {
    const result = { ...INITIAL_DRIVE_STATE };
    for (const [drive, baseline] of Object.entries(this.adjustedBaselines) as [
      DriveName,
      number,
    ][]) {
      result[drive] = baseline;
    }
    return result;
  }

  /**
   * Get diagnostics about current adjustments.
   */
  public getDiagnostics(): {
    adjustedDrives: { drive: DriveName; adjusted: number; default: number }[];
    allAtDefault: boolean;
  } {
    const adjustedDrives = Object.entries(this.adjustedBaselines).map(([drive, adjusted]) => ({
      drive: drive as DriveName,
      adjusted,
      default: INITIAL_DRIVE_STATE[drive as DriveName],
    }));

    return {
      adjustedDrives,
      allAtDefault: adjustedDrives.length === 0,
    };
  }

  /**
   * Reset all adjustments (for testing or forced recovery).
   */
  public reset(): void {
    this.adjustedBaselines = {};
  }
}
