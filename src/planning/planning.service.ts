/**
 * PlanningService — public facade implementation of IPlanningService.
 *
 * Facade that coordinates the full six-stage Planning pipeline:
 *   1. Rate-limit gate
 *   2. Opportunity research
 *   3. Outcome simulation
 *   4. Proposal assembly
 *   5. Constraint validation
 *   6. Procedure creation
 *
 * CANON §Subsystem 5 (Planning): Triggered by Opportunities from the Drive
 * Engine. Creates procedure nodes in the WKG with LLM_GENERATED provenance.
 *
 * Manages an in-memory priority queue of opportunities and processes them
 * through the planning pipeline in a background loop. Applies cold-start
 * dampening and rate limiting to prevent the Planning Runaway attractor.
 *
 * Provided under the PLANNING_SERVICE token by PlanningModule.
 */

import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DRIVE_STATE_READER } from '../drive-engine';
import type { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';
import type {
  IPlanningService,
  PlanningResult,
  QueuedOpportunity,
  PlanningState,
  IOpportunityQueueService,
  IPlanningRateLimiter,
} from './interfaces/planning.interfaces';
import type { Opportunity } from '../drive-engine/interfaces/drive-engine.interfaces';
import {
  OPPORTUNITY_QUEUE,
  PLANNING_RATE_LIMITER,
  PLANNING_PIPELINE_SERVICE,
} from './planning.tokens';

@Injectable()
export class PlanningService
  implements IPlanningService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlanningService.name);

  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private shutdownRequested = false;

  constructor(
    private readonly configService: ConfigService,
    @Inject(OPPORTUNITY_QUEUE)
    private readonly queue: IOpportunityQueueService,
    @Inject(PLANNING_RATE_LIMITER)
    private readonly rateLimiter: IPlanningRateLimiter,
    @Inject(PLANNING_PIPELINE_SERVICE)
    private readonly pipeline: any, // PlanningPipelineService
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Accept and process an Opportunity through the full planning pipeline.
   *
   * Steps:
   * 1. Enqueue the opportunity via this.queue.enqueue(opportunity)
   * 2. Trigger immediate processing (don't wait for background loop)
   * 3. Dequeue the highest-priority item
   * 4. If dequeued item exists, run it through pipeline.executePipeline()
   * 5. Return the PlanningResult
   *
   * Integration:
   *   - Receives Opportunity events from Drive Engine (via ACTION_OUTCOME_REPORTER).
   *   - Reads drive state via driveStateReader.getCurrentState() for simulation context.
   *
   * @param opportunity - The opportunity to process
   * @returns PlanningResult describing the pipeline outcome
   */
  async processOpportunity(opportunity: Opportunity): Promise<PlanningResult> {
    // Enqueue the opportunity
    this.queue.enqueue(opportunity);

    // Trigger immediate processing
    return this.processQueue();
  }

  /**
   * Return the current priority-sorted opportunity queue snapshot.
   *
   * Returns the array of queued opportunities from the queue service's getState() method.
   * The array is sorted by currentPriority descending (highest priority first).
   *
   * @returns Readonly snapshot of queued opportunities, sorted by priority
   */
  getOpportunityQueue(): readonly QueuedOpportunity[] {
    return this.queue.getState();
  }

  /**
   * Return a summary of the planning subsystem's current operational state.
   *
   * Combines queue contents, rate limiter state, and cold-start dampening status
   * for dashboard display and diagnostics.
   *
   * @returns PlanningState with all operational metrics
   */
  getState(): PlanningState {
    const queueItems = this.queue.getState();
    const rateLimiterState = this.rateLimiter.getState();

    // Derive cold-start dampening status: active if we have very few queued items
    // (indicating we're still in the early operation phase with initial dampening)
    const coldStartDampening = queueItems.length === 0;

    return {
      queueSize: queueItems.length,
      activePlans: rateLimiterState.activePlans,
      plansCreatedThisWindow: rateLimiterState.plansThisWindow,
      coldStartDampening,
      rateLimiterState,
    };
  }

  /**
   * Initialize the background processing loop.
   *
   * Starts a setInterval that periodically dequeues opportunities and
   * runs them through the planning pipeline. Interval duration is
   * configurable via config.planning.processingIntervalMs (default 5000).
   */
  async onModuleInit(): Promise<void> {
    const intervalMs =
      this.configService.get('app')?.planning?.processingIntervalMs ?? 5000;
    this.logger.log(
      `Planning service initialized with processing interval: ${intervalMs}ms`,
    );
    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, intervalMs);
  }

  /**
   * Clean up the background processing loop and wait for in-flight work.
   *
   * Signals shutdown, clears the interval, and blocks until any in-flight
   * pipeline execution completes.
   */
  async onModuleDestroy(): Promise<void> {
    this.shutdownRequested = true;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    // Wait for in-flight processing to complete
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.logger.log('Planning service shut down cleanly');
  }

  /**
   * Internal: Process the next opportunity from the queue.
   *
   * Executes one dequeue-and-process cycle:
   * 1. Guard against concurrent processing and shutdown
   * 2. Dequeue highest-priority opportunity
   * 3. Run it through pipeline.executePipeline()
   * 4. Log any errors (don't throw)
   *
   * @private
   */
  private async processQueue(): Promise<PlanningResult> {
    // Guard: Don't process if already processing or shutdown in progress
    if (this.isProcessing || this.shutdownRequested) {
      return { status: 'INSUFFICIENT_EVIDENCE' };
    }

    this.isProcessing = true;
    try {
      // Dequeue the highest-priority item
      const item = this.queue.dequeue();
      if (!item) {
        // Queue is empty
        return { status: 'INSUFFICIENT_EVIDENCE' };
      }

      // Run through the pipeline
      const result = await this.pipeline.executePipeline(item.opportunity);
      return result;
    } catch (err) {
      this.logger.error(
        'Planning queue processing error',
        err instanceof Error ? err.message : String(err),
      );
      return { status: 'INSUFFICIENT_EVIDENCE' };
    } finally {
      this.isProcessing = false;
    }
  }
}
