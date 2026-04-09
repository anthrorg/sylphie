/**
 * OpportunityQueueService -- In-memory priority queue with time-decay.
 *
 * CANON SS Known Attractor States: "Opportunity queue must have decay to prevent
 * runaway." This service implements exponential priority decay, deduplication by
 * contextFingerprint, rate limiting (max plans per time window), and a hard cap
 * on queue size.
 *
 * The queue is sorted by currentPriority (descending). Decay is applied externally
 * by PlanningService on a timer. Items that fall below DROP_THRESHOLD are removed.
 *
 * Hard-cap eviction: When the queue is at MAX_QUEUE_SIZE, a newcomer is compared
 * against the lowest-priority item in the queue (the tail, since the queue is sorted
 * descending). If the newcomer outranks it, the tail is evicted and the newcomer is
 * inserted. If not, the newcomer is rejected. GUARDIAN_TEACHING items (priority 1.5)
 * always outrank every normal item and will never be the eviction loser.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { verboseFor } from '@sylphie/shared';
import type { OpportunityPriority } from '@sylphie/shared';
import type {
  IOpportunityQueue,
  QueuedOpportunity,
  OpportunityQueueStatus,
  IPlanningEventLogger,
} from '../interfaces/planning.interfaces';
import { PLANNING_EVENT_LOGGER } from '../planning.tokens';

const vlog = verboseFor('Planning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Numeric mapping from string priority to initial score. */
const PRIORITY_MAP: Record<OpportunityPriority, number> = {
  HIGH: 1.0,
  MEDIUM: 0.6,
  LOW: 0.3,
};

/** Exponential decay rate per hour. */
const PRIORITY_DECAY_RATE = 0.1;

/** Minimum priority before an opportunity is dropped from the queue. */
const DROP_THRESHOLD = 0.1;

/** Priority for guardian-initiated teaching (above HIGH=1.0 to ensure queue jump). */
const GUARDIAN_TEACHING_PRIORITY = 1.5;

/** Maximum items in the queue. */
const MAX_QUEUE_SIZE = 50;

/** Maximum plans that can be created per rate-limit window. */
const MAX_PLANS_PER_WINDOW = 3;

/** Rate-limit window in milliseconds (1 hour). */
const RATE_LIMIT_WINDOW_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class OpportunityQueueService implements IOpportunityQueue {
  private readonly logger = new Logger(OpportunityQueueService.name);

  /** Sorted by currentPriority descending. */
  private queue: QueuedOpportunity[] = [];

  /** Timestamps of plans created (for rate limiting). */
  private planCreationTimestamps: number[] = [];

  constructor(
    @Inject(PLANNING_EVENT_LOGGER)
    private readonly eventLogger: IPlanningEventLogger,
  ) {}

  enqueue(opportunity: QueuedOpportunity): boolean {
    // Duplicate check: same contextFingerprint already in queue.
    const isDuplicate = this.queue.some(
      (item) => item.payload.contextFingerprint === opportunity.payload.contextFingerprint,
    );
    if (isDuplicate) {
      vlog('opportunity enqueue rejected — duplicate', {
        opportunityId: opportunity.payload.id,
        contextFingerprint: opportunity.payload.contextFingerprint,
        queueSize: this.queue.length,
      });
      this.logger.debug(
        `Duplicate opportunity dropped: ${opportunity.payload.contextFingerprint}`,
      );
      return false;
    }

    // Rate-limit check -- GUARDIAN_TEACHING bypasses rate limiting.
    const isGuardianTeaching = opportunity.payload.classification === 'GUARDIAN_TEACHING';
    if (!isGuardianTeaching && this.isRateLimited()) {
      vlog('opportunity enqueue rejected — rate limited', {
        opportunityId: opportunity.payload.id,
        plansCreatedInWindow: this.planCreationTimestamps.length,
        max: MAX_PLANS_PER_WINDOW,
      });
      this.logger.debug('Planning rate-limited -- opportunity rejected');
      return false;
    }

    // Hard-cap eviction: when queue is full, compare newcomer against the
    // lowest-priority item (queue tail -- queue is sorted descending). If
    // newcomer outranks the tail, evict the tail and insert the newcomer.
    // GUARDIAN_TEACHING items (priority 1.5) always win this comparison.
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const tail = this.queue[this.queue.length - 1];

      if (opportunity.currentPriority <= tail.currentPriority) {
        // Newcomer loses -- reject it outright.
        vlog('opportunity enqueue rejected — outranked by queue tail', {
          opportunityId: opportunity.payload.id,
          newcomerPriority: opportunity.currentPriority,
          tailPriority: tail.currentPriority,
          queueSize: this.queue.length,
        });
        this.logger.debug(
          `Opportunity ${opportunity.payload.id} rejected: priority ` +
            `${opportunity.currentPriority.toFixed(2)} <= tail ${tail.currentPriority.toFixed(2)}`,
        );
        return false;
      }

      // Newcomer wins -- evict the tail and insert.
      const evicted = this.queue.pop()!;
      vlog('opportunity evicted by higher-priority newcomer', {
        evictedId: evicted.payload.id,
        evictedPriority: evicted.currentPriority,
        evictedClassification: evicted.payload.classification,
        replacedById: opportunity.payload.id,
        replacedByPriority: opportunity.currentPriority,
      });
      this.logger.debug(
        `Opportunity ${evicted.payload.id} evicted (priority=${evicted.currentPriority.toFixed(2)}) ` +
          `by newcomer ${opportunity.payload.id} (priority=${opportunity.currentPriority.toFixed(2)})`,
      );
      this.eventLogger.log('OPPORTUNITY_DROPPED', {
        opportunityId: evicted.payload.id,
        reason: 'evicted_by_higher_priority',
        evictedPriority: evicted.currentPriority,
        evictedClassification: evicted.payload.classification,
        replacedById: opportunity.payload.id,
        replacedByPriority: opportunity.currentPriority,
        queueSize: this.queue.length,
      });
    }

    this.queue.push(opportunity);
    this.sortQueue();

    vlog('opportunity enqueued', {
      opportunityId: opportunity.payload.id,
      classification: opportunity.payload.classification,
      priority: opportunity.currentPriority,
      queueSize: this.queue.length,
    });

    this.logger.debug(
      `Enqueued opportunity ${opportunity.payload.id} ` +
        `(priority=${opportunity.currentPriority.toFixed(2)}, queue=${this.queue.length})`,
    );

    return true;
  }

  dequeue(): QueuedOpportunity | null {
    if (this.queue.length === 0) return null;
    const item = this.queue.shift()!;
    vlog('opportunity dequeued', {
      opportunityId: item.payload.id,
      classification: item.payload.classification,
      priority: item.currentPriority,
      remainingQueueSize: this.queue.length,
    });
    return item;
  }

  applyDecay(): number {
    const now = Date.now();
    let droppedCount = 0;

    for (const item of this.queue) {
      const hoursElapsed = (now - item.enqueuedAt.getTime()) / 3_600_000;
      item.currentPriority = item.initialPriority * Math.exp(-PRIORITY_DECAY_RATE * hoursElapsed);
    }

    // Remove items below threshold.
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => item.currentPriority >= DROP_THRESHOLD);
    droppedCount = before - this.queue.length;

    if (droppedCount > 0) {
      this.sortQueue();
      vlog('decay sweep complete', { droppedCount, remainingQueueSize: this.queue.length });
      this.logger.debug(`Decay sweep: dropped ${droppedCount} opportunities`);
    }

    return droppedCount;
  }

  size(): number {
    return this.queue.length;
  }

  getStatus(): OpportunityQueueStatus {
    const now = Date.now();

    // Clean expired timestamps from the rate-limit window.
    this.pruneRateLimitTimestamps(now);

    const oldestItem = this.queue.length > 0
      ? this.queue[this.queue.length - 1]
      : null;

    return {
      queueSize: this.queue.length,
      plansCreatedInWindow: this.planCreationTimestamps.length,
      rateLimitMax: MAX_PLANS_PER_WINDOW,
      oldestItemAgeMs: oldestItem ? now - oldestItem.enqueuedAt.getTime() : null,
    };
  }

  recordPlanCreated(): void {
    this.planCreationTimestamps.push(Date.now());
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private isRateLimited(): boolean {
    this.pruneRateLimitTimestamps(Date.now());
    return this.planCreationTimestamps.length >= MAX_PLANS_PER_WINDOW;
  }

  private pruneRateLimitTimestamps(now: number): void {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    this.planCreationTimestamps = this.planCreationTimestamps.filter((ts) => ts > cutoff);
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.currentPriority - a.currentPriority);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OpportunityPriority string to a numeric initial priority.
 * GUARDIAN_TEACHING classification overrides to GUARDIAN_TEACHING_PRIORITY (1.5).
 */
export function priorityToNumeric(
  priority: OpportunityPriority,
  classification?: string,
): number {
  if (classification === 'GUARDIAN_TEACHING') {
    return GUARDIAN_TEACHING_PRIORITY;
  }
  return PRIORITY_MAP[priority] ?? PRIORITY_MAP.LOW;
}
