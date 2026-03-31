/**
 * MaintenanceCycleService — full cycle orchestrator for learning consolidation.
 *
 * Implements IMaintenanceCycleService. Encapsulates the state machine and full
 * lifecycle of a maintenance and consolidation cycle: selecting events,
 * running consolidation, emitting lifecycle events, and tracking metrics.
 *
 * CANON §Subsystem 3 (Learning): The maintenance cycle is triggered by Decision Making
 * when Cognitive Awareness drive pressure exceeds threshold. This service executes
 * the complete cycle logic and prevents concurrent execution.
 *
 * Responsibilities:
 * 1. Enforce rate limiting (minimum 30s between cycles)
 * 2. Prevent concurrent cycle execution
 * 3. Select batch via ConsolidationService
 * 4. Run consolidation pipeline
 * 5. Execute learning jobs via JobRegistryService
 * 6. Update provenance health
 * 7. Emit TimescaleDB lifecycle events (STARTED/COMPLETED)
 * 8. Enforce 60s timeout per cycle
 * 9. Apply adaptive batch sizing (5 normal, 3 when contradictions >= 2)
 * 10. Track cycle metrics and state
 */

import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';

import { CONSOLIDATION_SERVICE, LEARNING_JOB_REGISTRY, PROVENANCE_HEALTH_SERVICE } from '../learning.tokens';
import type { IConsolidationService, ConsolidationResult } from '../interfaces/learning.interfaces';
import type {
  IMaintenanceCycleService,
  LearningCycleMetrics,
  ILearningJob,
} from '../interfaces/learning.interfaces';
import { JobRegistryService } from '../jobs/job-registry.service';
import { ProvenanceHealthService } from '../metrics/provenance-health.service';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { DriveName } from '../../shared/types/drive.types';

// CANON Constants
const RATE_LIMIT_MS = 30_000; // Minimum 30s between cycles
const CYCLE_TIMEOUT_MS = 60_000; // Maximum 60s per cycle
const DEFAULT_BATCH_SIZE = 5; // Max 5 events per CANON §Subsystem 3
const ADAPTIVE_BATCH_SIZE = 3; // Reduce to 3 when contradictions >= 2
const COGNITIVE_AWARENESS_THRESHOLD = 0.6; // Trigger threshold
const TIMER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class MaintenanceCycleService implements IMaintenanceCycleService, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceCycleService.name);

  // State tracking
  private running = false;
  private lastCycleTime: Date | null = null;
  private cycleCount = 0;
  private lastContradictionCount = 0;

  // Timer for periodic cycles (5-minute fallback)
  private timerHandle: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CONSOLIDATION_SERVICE)
    private readonly consolidationService: IConsolidationService,
    @Inject(LEARNING_JOB_REGISTRY)
    private readonly jobRegistry: JobRegistryService,
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: IEventService,
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    @Inject(PROVENANCE_HEALTH_SERVICE)
    private readonly provenanceHealthService: ProvenanceHealthService,
  ) {
    // Start the periodic timer on initialization
    this.startPeriodicTimer();
  }

  /**
   * Execute a full maintenance and consolidation cycle.
   *
   * 1. Check rate limit (min 30s between cycles)
   * 2. Prevent concurrent execution
   * 3. Emit CONSOLIDATION_CYCLE_STARTED
   * 4. Select batch with adaptive sizing
   * 5. Run consolidation pipeline
   * 6. Execute learning jobs
   * 7. Update provenance health
   * 8. Emit CONSOLIDATION_CYCLE_COMPLETED with metrics
   * 9. Apply 60s timeout
   *
   * CANON Constraint: max 5 events per cycle, 30s rate limit, 60s timeout.
   *
   * @returns Comprehensive metrics from the completed cycle.
   * @throws Error if the cycle fails or times out.
   */
  async executeCycle(): Promise<LearningCycleMetrics> {
    // Rate limiting: enforce minimum 30s between cycles
    if (this.lastCycleTime !== null) {
      const timeSinceLastCycle = Date.now() - this.lastCycleTime.getTime();
      if (timeSinceLastCycle < RATE_LIMIT_MS) {
        this.logger.debug(
          `Rate limit active: ${RATE_LIMIT_MS - timeSinceLastCycle}ms remaining`,
        );
        throw new Error(
          `Rate limit: minimum ${RATE_LIMIT_MS}ms between cycles`,
        );
      }
    }

    // Prevent concurrent execution
    if (this.running) {
      this.logger.warn('Cycle already running; rejecting concurrent attempt');
      throw new Error('Cycle already in progress');
    }

    this.running = true;
    const cycleStartTime = Date.now();

    try {
      // Get current drive state for trigger validation and metrics
      const currentDrive = this.driveStateReader.getCurrentState();

      // Emit CONSOLIDATION_CYCLE_STARTED event
      const startEventRecord = await this.eventsService.record({
        type: 'CONSOLIDATION_CYCLE_STARTED',
        subsystem: 'LEARNING',
        sessionId: 'session-id', // TODO: obtain from context
        driveSnapshot: currentDrive,
        schemaVersion: 1,
      });

      this.logger.log(`Cycle started: event ID ${startEventRecord.eventId}`);

      // Determine adaptive batch size based on previous contradiction count
      const batchSize =
        this.lastContradictionCount >= 2
          ? ADAPTIVE_BATCH_SIZE
          : DEFAULT_BATCH_SIZE;

      // Select batch via ConsolidationService
      const batch = await this.consolidationService.selectBatch(batchSize);

      if (batch.events.length === 0) {
        this.logger.debug('No learnable events available; skipping consolidation');
        // Still emit COMPLETED event with zero metrics
        const metrics: LearningCycleMetrics = {
          cycleDurationMs: Date.now() - cycleStartTime,
          eventsProcessed: 0,
          entitiesExtracted: 0,
          edgesRefined: 0,
          contradictionsFound: 0,
          jobsExecuted: 0,
          jobsFailed: 0,
        };

        await this.eventsService.record({
          type: 'CONSOLIDATION_CYCLE_COMPLETED',
          subsystem: 'LEARNING',
          sessionId: 'session-id', // TODO: obtain from context
          driveSnapshot: currentDrive,
          schemaVersion: 1,
        });

        this.lastCycleTime = new Date();
        this.cycleCount++;
        return metrics;
      }

      this.logger.log(`Selected ${batch.events.length} events for consolidation`);

      // Run consolidation pipeline with timeout
      const consolidationPromise = this.consolidationService.consolidate(
        batch,
      );
      const timeoutPromise = new Promise<ConsolidationResult>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Consolidation timeout exceeded (${CYCLE_TIMEOUT_MS}ms)`,
              ),
            ),
          CYCLE_TIMEOUT_MS,
        ),
      );

      const consolidationResult: ConsolidationResult = await Promise.race([
        consolidationPromise,
        timeoutPromise,
      ]);

      this.logger.log(
        `Consolidation complete: ${consolidationResult.entityExtractionResults.length} entities, ` +
          `${consolidationResult.edgeRefinementResults.length} edges, ` +
          `${consolidationResult.contradictions.length} contradictions`,
      );

      // Store contradiction count for next cycle's batch sizing
      this.lastContradictionCount =
        consolidationResult.contradictions.length;

      // Execute learning jobs via JobRegistryService
      const jobResults = await this.jobRegistry.executeJobsForCycle();
      const jobsExecuted = jobResults.length;
      const jobsFailed = jobResults.filter((r) => !r.success).length;

      // Update provenance health
      try {
        const health = await this.provenanceHealthService.assessHealth();
        this.logger.debug(
          `Provenance health: ${health.healthStatus} (sensor: ${(health.sensorRatio * 100).toFixed(1)}%, ` +
            `guardian: ${(health.guardianRatio * 100).toFixed(1)}%, ` +
            `llm: ${(health.llmRatio * 100).toFixed(1)}%)`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to update provenance health: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Build metrics for completion event
      const metrics: LearningCycleMetrics = {
        cycleDurationMs: Date.now() - cycleStartTime,
        eventsProcessed: batch.events.length,
        entitiesExtracted:
          consolidationResult.entityExtractionResults.length,
        edgesRefined: consolidationResult.edgeRefinementResults.length,
        contradictionsFound: consolidationResult.contradictions.length,
        jobsExecuted,
        jobsFailed,
      };

      // Emit CONSOLIDATION_CYCLE_COMPLETED with metrics
      const completionEventRecord = await this.eventsService.record({
        type: 'CONSOLIDATION_CYCLE_COMPLETED',
        subsystem: 'LEARNING',
        sessionId: 'session-id', // TODO: obtain from context
        driveSnapshot: currentDrive,
        schemaVersion: 1,
      });

      this.logger.log(
        `Cycle completed (event ID ${completionEventRecord.eventId}): ` +
          `${metrics.eventsProcessed} events, ` +
          `${metrics.entitiesExtracted} entities, ` +
          `${metrics.edgesRefined} edges, ` +
          `${metrics.contradictionsFound} contradictions, ` +
          `${metrics.jobsExecuted} jobs executed`,
      );

      // Update internal state
      this.lastCycleTime = new Date();
      this.cycleCount++;

      return metrics;
    } catch (error) {
      this.logger.error(
        `Cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Check whether a cycle is currently running.
   *
   * Used to prevent concurrent cycle execution.
   *
   * @returns True if a cycle is in progress.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Return the timestamp of the last completed cycle, or null if none.
   *
   * Used by Decision Making to avoid rapid re-triggering.
   *
   * @returns Timestamp of last completion, or null.
   */
  getLastCycleTime(): Date | null {
    return this.lastCycleTime;
  }

  /**
   * Start the periodic timer for 5-minute fallback cycles.
   *
   * CANON Constraint: Trigger cycle every 5 minutes OR when Cognitive Awareness > 0.6.
   * This timer implements the 5-minute fallback. The 0.6 threshold is checked externally
   * by Decision Making.
   *
   * @private
   */
  private startPeriodicTimer(): void {
    this.timerHandle = setInterval(() => {
      if (!this.running) {
        const currentDrive = this.driveStateReader.getCurrentState();
        // Only trigger if Cognitive Awareness is above threshold
        // (otherwise Decision Making will trigger on demand)
        if (currentDrive.pressureVector[DriveName.CognitiveAwareness] > COGNITIVE_AWARENESS_THRESHOLD) {
          this.executeCycle().catch((error) => {
            this.logger.warn(
              `Periodic cycle failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }
    }, TIMER_INTERVAL_MS);

    this.logger.log('Periodic maintenance cycle timer started (5 minutes)');
  }

  /**
   * Cleanup: stop the periodic timer.
   *
   * Called when the module is destroyed.
   *
   * @private
   */
  onModuleDestroy(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
      this.logger.log('Periodic maintenance cycle timer stopped');
    }
  }
}
