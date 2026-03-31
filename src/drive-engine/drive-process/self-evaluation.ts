/**
 * Self-evaluation subsystem for the Drive Engine.
 *
 * Runs every N ticks to read KG(Self) and adjust drive baselines based on
 * self-assessed capabilities. Prevents identity lock-in ("system permanently
 * thinks it's bad at X").
 *
 * CANON §E4-T008: Self-evaluation with circuit breaker and gradual recovery.
 */

import { DriveName, DRIVE_INDEX_ORDER, INITIAL_DRIVE_STATE } from '../../shared/types/drive.types';
import {
  SELF_EVALUATION_INTERVAL_TICKS,
  SELF_KG_QUERY_TIMEOUT_MS,
} from '../constants/self-evaluation';
import { ISelfKgReader } from '../interfaces/self-kg.interfaces';
import { DriveStateManager } from './drive-state';
import { DriveBaselineAdjustment } from './drive-baseline-adjustment';
import { SelfEvaluationCircuitBreaker } from './self-evaluation-circuit-breaker';
import { getOrCreateSelfKgReader } from './database-clients';

/**
 * Self-evaluation evaluator.
 * Manages the slower-timescale read of KG(Self) and baseline adjustments.
 */
export class SelfEvaluator {
  private selfKgReader: ISelfKgReader;
  private baselineAdjustment: DriveBaselineAdjustment;
  private circuitBreaker: SelfEvaluationCircuitBreaker;
  private lastEvaluationTick: number = 0;
  private evaluationCount: number = 0;

  constructor() {
    this.selfKgReader = getOrCreateSelfKgReader();
    this.baselineAdjustment = new DriveBaselineAdjustment();
    this.circuitBreaker = new SelfEvaluationCircuitBreaker();
  }

  /**
   * Check if self-evaluation should run on this tick.
   *
   * Runs every N ticks, as defined by SELF_EVALUATION_INTERVAL_TICKS.
   *
   * @param currentTick The current tick number from the Drive Engine
   * @returns true if evaluation should run
   */
  public shouldEvaluate(currentTick: number): boolean {
    return (currentTick - this.lastEvaluationTick) >= SELF_EVALUATION_INTERVAL_TICKS;
  }

  /**
   * Execute a self-evaluation cycle.
   *
   * Non-blocking: queries KG(Self) with timeout, adjusts baselines,
   * records result in circuit breaker. Errors are logged but don't
   * crash the tick loop.
   *
   * @param currentTick Current tick number for tracking
   */
  async evaluate(currentTick: number): Promise<void> {
    // Check circuit breaker
    if (this.circuitBreaker.isOpen()) {
      return; // Self-evaluation paused
    }

    this.lastEvaluationTick = currentTick;

    try {
      // Skip if KG(Self) reader not ready
      if (!this.selfKgReader.isReady()) {
        return;
      }

      // Query capabilities with timeout
      const capabilities = await this.queryWithTimeout(
        () => this.selfKgReader.queryCapabilities(),
        SELF_KG_QUERY_TIMEOUT_MS,
      );

      // Assess whether results are negative or positive
      const hasNegativeAssessment = this.assessResults(capabilities || []);

      if (hasNegativeAssessment) {
        this.circuitBreaker.recordNegativeAssessment();
      } else {
        this.circuitBreaker.recordPositiveAssessment();
      }

      // Apply baseline adjustments
      this.baselineAdjustment.adjustBaselinesFromCapabilities(capabilities || []);
      this.evaluationCount++;

      if (typeof process !== 'undefined' && process.stderr) {
        const diag = this.baselineAdjustment.getDiagnostics();
        const capCount = capabilities ? capabilities.length : 0;
        process.stderr.write(
          `[SelfEvaluator] Eval #${this.evaluationCount} at tick ${currentTick}: ${capCount} capabilities assessed, CB state=${this.circuitBreaker.getState()}, adjusted=${diag.adjustedDrives.length}\n`,
        );
      }
    } catch (err) {
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(`[SelfEvaluator] Error during evaluation: ${err}\n`);
      }
      // Don't record this as negative assessment; it's an error, not a real assessment
    }
  }

  /**
   * Execute a promise with a timeout.
   * Returns null if timeout exceeded.
   *
   * @param fn Promise-returning function
   * @param timeoutMs Timeout in milliseconds
   * @returns Promise<T | null>
   */
  private async queryWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | null> {
    return Promise.race([
      fn(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  }

  /**
   * Assess whether the evaluation results indicate negative state.
   *
   * Negative assessment: any capability has successRate < 0.3
   * Positive assessment: all capabilities are >= 0.3 (or no data)
   *
   * @param capabilities Capabilities from KG(Self)
   * @returns true if negative assessment
   */
  private assessResults(capabilities: any[]): boolean {
    if (!capabilities || capabilities.length === 0) {
      return false; // No data = neutral, not negative
    }

    // Check if any capability is low
    for (const cap of capabilities) {
      if (cap.successRate !== undefined && cap.successRate < 0.3) {
        return true; // Found a low-capability capability
      }
    }

    return false; // All capabilities acceptable
  }

  /**
   * Get the current adjusted baselines as a map of drive -> baseline value.
   * These are used to initialize accumulation or override default rates.
   *
   * @returns Record mapping DriveName to baseline value
   */
  public getAdjustedBaselines(): Record<DriveName, number> {
    return this.baselineAdjustment.getAllAdjustedBaselines();
  }

  /**
   * Get baseline for a specific drive.
   *
   * @param drive The drive to get baseline for
   * @returns Baseline value (may be adjusted or default)
   */
  public getBaseline(drive: DriveName): number {
    return this.baselineAdjustment.getBaseline(drive);
  }

  /**
   * Get diagnostics about evaluation state.
   */
  public getDiagnostics(): {
    evaluationCount: number;
    lastEvaluationTick: number;
    circuitBreakerState: string;
    consecutiveNegatives: number;
    adjustedBaselines: { drive: DriveName; adjusted: number; default: number }[];
  } {
    const baselineDiag = this.baselineAdjustment.getDiagnostics();
    return {
      evaluationCount: this.evaluationCount,
      lastEvaluationTick: this.lastEvaluationTick,
      circuitBreakerState: this.circuitBreaker.getState(),
      consecutiveNegatives: this.circuitBreaker.getConsecutiveNegatives(),
      adjustedBaselines: baselineDiag.adjustedDrives,
    };
  }

  /**
   * Reset all state (for testing).
   */
  public reset(): void {
    this.baselineAdjustment.reset();
    this.circuitBreaker.reset();
    this.lastEvaluationTick = 0;
    this.evaluationCount = 0;
  }
}

/**
 * Global singleton instance.
 */
let evaluator: SelfEvaluator | null = null;

/**
 * Get or create the global SelfEvaluator instance.
 */
export function getOrCreateSelfEvaluator(): SelfEvaluator {
  if (!evaluator) {
    evaluator = new SelfEvaluator();
  }
  return evaluator;
}

/**
 * Set the global evaluator (for testing).
 */
export function setSelfEvaluator(e: SelfEvaluator): void {
  evaluator = e;
}

/**
 * Reset the global evaluator (for testing).
 */
export function resetSelfEvaluator(): void {
  evaluator = null;
}
