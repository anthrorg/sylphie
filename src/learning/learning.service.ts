/**
 * LearningService — main public facade for the Learning subsystem.
 *
 * Implements ILearningService. Orchestrates the full consolidation pipeline:
 * fetch learnable events → entity extraction → edge refinement → contradiction
 * detection → WKG upsert. Emits CONSOLIDATION_CYCLE_STARTED and
 * CONSOLIDATION_CYCLE_COMPLETED events to TimescaleDB.
 *
 * CANON §Subsystem 3 (Learning): max 5 learnable events per cycle to prevent
 * catastrophic interference. The cycle is triggered by Decision Making when
 * Cognitive Awareness drive pressure exceeds threshold — this service does not
 * self-trigger.
 *
 * Integration points:
 *   - Decision Making: calls shouldConsolidate() to gate cycle triggering,
 *     then calls runMaintenanceCycle() to execute.
 *   - Drive Engine: reads drive state via DRIVE_STATE_READER to inform
 *     contradiction severity and learning prioritization.
 *   - Events: reads LearnableEvents from TimescaleDB and emits consolidation
 *     lifecycle events.
 *   - Knowledge: writes extracted entities and edges to the WKG.
 *   - Communication: uses LLM_SERVICE for entity extraction and edge refinement.
 *
 * Drive state check (shouldConsolidate):
 *   - Cognitive Awareness drive pressure > 0.6 triggers consolidation
 *   - Per CANON §Learning: threshold gate for cycle execution
 */

import { Injectable, Logger, Inject } from '@nestjs/common';

import { DRIVE_STATE_READER } from '../drive-engine';
import type { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';
import { DriveName } from '../shared/types/drive.types';
import { MAINTENANCE_CYCLE_SERVICE, LEARNING_METRICS_SERVICE } from './learning.tokens';
import type { IMaintenanceCycleService } from './interfaces/learning.interfaces';
import type {
  ILearningService,
  MaintenanceCycleResult,
} from './interfaces/learning.interfaces';
import { LearningMetricsService } from './metrics/learning-metrics.service';

// CANON Constants
const COGNITIVE_AWARENESS_THRESHOLD = 0.6;

@Injectable()
export class LearningService implements ILearningService {
  private readonly logger = new Logger(LearningService.name);

  /** Track cycle count for diagnostics. */
  private cycleCount = 0;

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    @Inject(MAINTENANCE_CYCLE_SERVICE)
    private readonly maintenanceCycleService: IMaintenanceCycleService,
    @Inject(LEARNING_METRICS_SERVICE)
    private readonly metricsService: LearningMetricsService,
  ) {
    this.logger.log('LearningService initialized');
  }

  /**
   * Execute a full maintenance and consolidation cycle.
   *
   * Delegates to MaintenanceCycleService which orchestrates:
   * 1. Batch selection via ConsolidationService
   * 2. Entity extraction, edge refinement, contradiction detection
   * 3. WKG upsert
   * 4. Learning job execution via JobRegistryService
   * 5. Provenance health assessment
   * 6. Metrics recording and event emission
   *
   * Integration:
   *   - Reads drive state to inform contradiction severity
   *   - Records metrics via LearningMetricsService
   *   - Emits CONSOLIDATION_CYCLE_STARTED/COMPLETED events
   *
   * @returns Summary of what was processed, extracted, refined, and flagged.
   * @throws Error if the cycle cannot start or execution fails.
   */
  async runMaintenanceCycle(): Promise<MaintenanceCycleResult> {
    const cycleStartTime = Date.now();

    try {
      this.logger.log('Starting maintenance cycle via MaintenanceCycleService');

      // Delegate to MaintenanceCycleService for full cycle execution
      const metrics = await this.maintenanceCycleService.executeCycle();

      // Record metrics for diagnostics and trending
      this.metricsService.recordCycleMetrics(metrics);

      // Update cycle count
      this.cycleCount++;

      // Convert LearningCycleMetrics to MaintenanceCycleResult
      const result: MaintenanceCycleResult = {
        eventsProcessed: metrics.eventsProcessed,
        entitiesExtracted: metrics.entitiesExtracted,
        edgesRefined: metrics.edgesRefined,
        contradictionsFound: metrics.contradictionsFound,
        durationMs: metrics.cycleDurationMs,
      };

      this.logger.log(
        `Maintenance cycle completed: ${metrics.eventsProcessed} events, ` +
          `${metrics.entitiesExtracted} entities, ${metrics.edgesRefined} edges`,
      );

      return result;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Maintenance cycle failed: ${errorMsg}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Check whether the Cognitive Awareness drive pressure currently exceeds the
   * consolidation threshold.
   *
   * This is a pure synchronous check against the last received DriveSnapshot.
   * It does not fetch a new snapshot. Used by Decision Making to gate cycle
   * triggering.
   *
   * CANON §Learning: Cognitive Awareness > 0.6 indicates consolidation should run.
   *
   * @returns True if Cognitive Awareness drive pressure exceeds threshold.
   */
  shouldConsolidate(): boolean {
    try {
      const currentDrive = this.driveStateReader.getCurrentState();

      // Get Cognitive Awareness drive pressure
      const cognitiveAwareness =
        currentDrive.pressureVector[DriveName.CognitiveAwareness];

      const shouldRun = cognitiveAwareness > COGNITIVE_AWARENESS_THRESHOLD;

      this.logger.debug(
        `shouldConsolidate check: CognitiveAwareness=${cognitiveAwareness.toFixed(2)}, ` +
          `threshold=${COGNITIVE_AWARENESS_THRESHOLD}, shouldRun=${shouldRun}`,
      );

      return shouldRun;
    } catch (error) {
      this.logger.error(
        `Error checking shouldConsolidate: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Default to false on error to prevent cascade failures
      return false;
    }
  }

  /**
   * Return the timestamp of the last completed maintenance cycle, or null if
   * no cycle has run since service initialization.
   *
   * Used by Decision Making to avoid triggering redundant cycles in rapid
   * succession.
   *
   * @returns Timestamp of last cycle completion, or null.
   */
  getLastCycleTimestamp(): Date | null {
    try {
      return this.maintenanceCycleService.getLastCycleTime();
    } catch (error) {
      this.logger.warn(
        `Error getting last cycle timestamp: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Return the total number of maintenance cycles completed since service
   * initialization.
   *
   * Used for diagnostics and metrics logging.
   *
   * @returns Count of completed cycles (0 on cold start).
   */
  getCycleCount(): number {
    return this.cycleCount;
  }
}
