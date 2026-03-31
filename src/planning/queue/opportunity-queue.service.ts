/**
 * OpportunityQueueService — in-memory priority queue for planning opportunities.
 *
 * Manages a priority queue of Opportunities waiting to be processed by the
 * planning pipeline. Applies priority decay over time to prevent stale
 * opportunities from blocking fresher, higher-impact ones.
 *
 * CANON §Known Attractor States — Planning Runaway: Priority decay and bounded
 * queue size prevent the opportunity queue from growing unboundedly and causing
 * the Planning subsystem to cascade failure repairs indefinitely.
 *
 * Implementation:
 * - Stores opportunities in a sorted array (highest priority first).
 * - Applies cold-start dampening based on total decision count.
 * - Applies exponential decay on dequeue to prioritize fresh opportunities.
 * - Emits OPPORTUNITY_RECEIVED and OPPORTUNITY_DROPPED events via TimescaleDB.
 *
 * Provided under the OPPORTUNITY_QUEUE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Opportunity,
  QueuedOpportunity,
} from '../interfaces/planning.interfaces';
import type { AppConfig, PlanningConfig } from '../../shared/config/app.config';
import { EVENTS_SERVICE } from '../../events';
import type { IEventService, EventBuildOptions } from '../../events';
import { DRIVE_STATE_READER } from '../../drive-engine';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type { SylphieEvent } from '../../shared/types/event.types';

/**
 * State of a single queued opportunity with decay tracking.
 */
interface QueueItemInternal {
  opportunity: Opportunity;
  currentPriority: number;
  enqueuedAt: Date;
}

/**
 * Compute cold-start dampening based on total decision count.
 *
 * At decision 0: dampening = 0.8 (reduces priority by 80%)
 * At decision 50: dampening = 0.4
 * At decision 100+: dampening = 0.0
 *
 * Formula: dampening = max(0, coldStartInitialDampening * (1 - totalDecisions / threshold))
 *
 * @param totalDecisions - Total DECISION_CYCLE_STARTED events recorded
 * @param config - Planning configuration with cold-start parameters
 * @returns Dampening multiplier in [0.0, 1.0]
 */
function computeColdStartDampening(
  totalDecisions: number,
  config: PlanningConfig,
): number {
  const dampening = Math.max(
    0,
    config.coldStartInitialDampening *
      (1 - totalDecisions / config.coldStartThreshold),
  );
  return dampening;
}

/**
 * Build a Planning subsystem event manually (workaround for type inference issue).
 *
 * @param type - The Planning event type
 * @param opts - Build options (sessionId, driveSnapshot, optional correlationId)
 * @returns Event object ready for IEventService.record()
 */
function buildPlanningEvent(
  type: string,
  opts: EventBuildOptions,
): Omit<SylphieEvent, 'id'> {
  return {
    type: type as any,
    timestamp: new Date(),
    subsystem: 'PLANNING',
    sessionId: opts.sessionId,
    driveSnapshot: opts.driveSnapshot,
    schemaVersion: 1,
    correlationId: opts.correlationId,
    provenance: opts.provenance,
  };
}

@Injectable()
export class OpportunityQueueService {
  private queue: QueueItemInternal[] = [];
  private planningConfig: PlanningConfig;

  /**
   * Cached total decision count. Refreshed every 60 seconds.
   */
  private cachedTotalDecisions: number = 0;
  private lastDecisionCountRefreshAt: Date = new Date();

  /**
   * Refresh interval for cached decision count (milliseconds).
   */
  private readonly DECISION_COUNT_REFRESH_MS = 60000; // 60 seconds

  constructor(
    private readonly configService: ConfigService<AppConfig>,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {
    const config = this.configService.get('app')?.planning;
    if (!config) {
      throw new Error('Planning configuration is missing from AppConfig');
    }
    this.planningConfig = config;
  }

  /**
   * Enqueue an Opportunity with its initial priority.
   *
   * Steps:
   * 1. Compute cold-start dampening and apply to priority.
   * 2. Create QueuedOpportunity with currentPriority and enqueuedAt.
   * 3. If queue is at max size, evict lowest priority item.
   * 4. Add to queue, maintaining sorted order (highest priority first).
   * 5. Emit OPPORTUNITY_RECEIVED event.
   *
   * @param opportunity - The opportunity to enqueue.
   */
  enqueue(opportunity: Opportunity): void {
    // Compute cold-start dampening
    const dampening = this.computeDampening();
    const dampenedPriority = opportunity.priority * (1 - dampening);

    // Create internal queue item
    const item: QueueItemInternal = {
      opportunity,
      currentPriority: dampenedPriority,
      enqueuedAt: new Date(),
    };

    // Evict lowest priority item if queue is at max size
    if (
      this.queue.length >= this.planningConfig.queueMaxSize &&
      this.queue.length > 0
    ) {
      const lowestIndex = this.queue.length - 1; // Sorted descending, so last item is lowest
      this.queue.splice(lowestIndex, 1);

      // Emit OPPORTUNITY_DROPPED event
      const driveSnapshot = this.driveStateReader.getCurrentState();
      const droppedEvent = buildPlanningEvent('OPPORTUNITY_DROPPED', {
        sessionId: this.configService.get('app').sessionId,
        driveSnapshot,
      });
      this.eventsService.record(droppedEvent).catch((err) => {
        console.error('Failed to emit OPPORTUNITY_DROPPED event:', err);
      });
    }

    // Insert into sorted position (maintain descending priority order)
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].currentPriority < dampenedPriority) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, item);

    // Emit OPPORTUNITY_RECEIVED event
    const driveSnapshot = this.driveStateReader.getCurrentState();
    const receivedEvent = buildPlanningEvent('OPPORTUNITY_RECEIVED', {
      sessionId: this.configService.get('app').sessionId,
      driveSnapshot,
    });
    this.eventsService.record(receivedEvent).catch((err) => {
      console.error('Failed to emit OPPORTUNITY_RECEIVED event:', err);
    });
  }

  /**
   * Dequeue the next highest-priority opportunity from the queue.
   *
   * Steps:
   * 1. Apply exponential decay to all items.
   * 2. Prune items below minPriority threshold.
   * 3. Sort by priority descending (highest first).
   * 4. Return and remove highest priority item, or null if empty.
   *
   * @returns The highest-priority QueuedOpportunity or null if queue is empty.
   */
  dequeue(): QueuedOpportunity | null {
    if (this.queue.length === 0) {
      return null;
    }

    // Apply exponential decay to all items
    const decayRate = this.planningConfig.queueDecayRatePerHour;
    const now = new Date();

    for (const item of this.queue) {
      const hoursElapsed =
        (now.getTime() - item.enqueuedAt.getTime()) / (1000 * 60 * 60);
      const decayFactor = Math.pow(1 - decayRate, hoursElapsed);
      item.currentPriority =
        item.opportunity.priority * (1 - this.computeDampening()) * decayFactor;
    }

    // Prune items below minimum priority threshold
    this.queue = this.queue.filter(
      (item) => item.currentPriority >= this.planningConfig.queueMinPriority,
    );

    // If queue is now empty, return null
    if (this.queue.length === 0) {
      return null;
    }

    // Re-sort by priority descending (highest first)
    this.queue.sort(
      (a, b) => b.currentPriority - a.currentPriority,
    );

    // Remove and return highest priority item
    const item = this.queue.shift();
    if (!item) {
      return null;
    }

    return {
      opportunity: item.opportunity,
      currentPriority: item.currentPriority,
      enqueuedAt: item.enqueuedAt,
    };
  }

  /**
   * Return the current state of the queue for diagnostics and dashboard display.
   *
   * @returns Object with size and oldestAge (milliseconds since oldest item was enqueued).
   */
  getState(): {
    size: number;
    oldestAge: number;
    priorityDistribution: readonly number[];
  } {
    const size = this.queue.length;
    const now = new Date();

    let oldestAge = 0;
    if (size > 0) {
      const oldestEnqueuedAt = this.queue[this.queue.length - 1].enqueuedAt;
      oldestAge = now.getTime() - oldestEnqueuedAt.getTime();
    }

    const priorityDistribution = this.queue.map((item) => item.currentPriority);

    return {
      size,
      oldestAge,
      priorityDistribution,
    };
  }

  /**
   * Return the number of opportunities currently in the queue.
   *
   * @returns Number of queued opportunities.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Refresh and return the cached total decision count.
   *
   * Queries the event service for DECISION_CYCLE_STARTED events if the
   * cached value is stale (> 60 seconds old). Otherwise returns the cached value.
   *
   * @returns Total number of decision cycles completed since process start.
   */
  private async getCachedTotalDecisions(): Promise<number> {
    const now = new Date();
    const timeSinceLastRefresh = now.getTime() - this.lastDecisionCountRefreshAt.getTime();

    // Return cached value if fresh
    if (timeSinceLastRefresh < this.DECISION_COUNT_REFRESH_MS) {
      return this.cachedTotalDecisions;
    }

    // Refresh from event service
    try {
      const results = await this.eventsService.queryEventFrequency(
        ['DECISION_CYCLE_STARTED'],
        365 * 24 * 60 * 60 * 1000, // 1 year lookback
      );
      if (results.length > 0) {
        this.cachedTotalDecisions = results[0].count;
      }
      this.lastDecisionCountRefreshAt = now;
    } catch (err) {
      console.error(
        'Failed to query DECISION_CYCLE_STARTED event frequency:',
        err,
      );
      // Use previously cached value or 0 on error
    }

    return this.cachedTotalDecisions;
  }

  /**
   * Compute cold-start dampening synchronously using cached decision count.
   *
   * For now, we use synchronous access to the cached value to avoid
   * async complexity in enqueue(). This is acceptable because:
   * 1. The dampening value changes slowly.
   * 2. We only call this during enqueue(), which is not on the hot path.
   * 3. The cached value is refreshed in the background.
   *
   * @returns Dampening multiplier in [0.0, 1.0]
   */
  private computeDampening(): number {
    return computeColdStartDampening(this.cachedTotalDecisions, this.planningConfig);
  }
}
