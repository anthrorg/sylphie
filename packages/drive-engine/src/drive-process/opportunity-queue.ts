/**
 * Priority queue for opportunities.
 *
 * Maintains active opportunities in priority order (highest first).
 * Bounded at MAX_QUEUE_SIZE. Emits top opportunities periodically to Planning.
 *
 * Hard-cap eviction: When the queue is at capacity, a newcomer is compared
 * against the lowest-priority item (the tail, since the queue is sorted
 * descending). If the newcomer's priority exceeds the tail's, the tail is
 * removed and the newcomer is inserted. If not, the newcomer is rejected
 * immediately without mutating the queue. guardianTriggered items carry
 * elevated priority from the scorer and will always displace normal items.
 */

import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

import {
  MAX_QUEUE_SIZE,
} from '../constants/opportunity-detection';
import type { Opportunity } from './opportunity';

/**
 * OpportunityQueue: Priority-ordered queue of active opportunities.
 *
 * Maintains sorted order: highest priority first. When queue exceeds
 * MAX_QUEUE_SIZE, removes lowest-priority items.
 */
export class OpportunityQueue {
  private opportunities: Opportunity[] = [];

  /**
   * Add an opportunity to the queue.
   *
   * Maintains sorted order (highest priority first). When the queue is at
   * MAX_QUEUE_SIZE, the newcomer is compared against the current tail:
   *   - If newcomer.priority > tail.priority: evict the tail, insert the newcomer.
   *   - If newcomer.priority <= tail.priority: reject the newcomer immediately.
   *
   * This avoids the old push-sort-truncate pattern when the newcomer would not
   * survive truncation anyway, and makes eviction explicit and logged.
   *
   * @param opp - Opportunity to add
   * @returns true if the opportunity was accepted, false if rejected
   */
  public add(opp: Opportunity): boolean {
    if (this.opportunities.length >= MAX_QUEUE_SIZE) {
      // Queue is full -- check whether the newcomer outranks the tail.
      // The array is sorted descending, so the tail is the lowest-priority item.
      const tail = this.opportunities[this.opportunities.length - 1];

      if (opp.priority <= tail.priority) {
        // Fast-path rejection: newcomer would be truncated anyway.
        vlog('opportunity queue: item rejected (below tail priority)', {
          id: opp.id,
          newcomerPriority: +opp.priority.toFixed(4),
          tailPriority: +tail.priority.toFixed(4),
          queueSize: this.opportunities.length,
        });
        return false;
      }

      // Evict the tail and insert the newcomer.
      const evicted = this.opportunities.pop()!;
      vlog('opportunity queue: item evicted by higher-priority newcomer', {
        evictedId: evicted.id,
        evictedPriority: +evicted.priority.toFixed(4),
        newcomerId: opp.id,
        newcomerPriority: +opp.priority.toFixed(4),
        queueSize: this.opportunities.length,
      });
    }

    this.opportunities.push(opp);
    this.sort();

    vlog('opportunity queue: item added', {
      id: opp.id,
      priority: +opp.priority.toFixed(4),
      queueSize: this.opportunities.length,
    });

    return true;
  }

  /**
   * Get top N opportunities by priority.
   *
   * Returns highest-priority items first, up to N items.
   *
   * @param n - Maximum number to return
   * @returns Array of top opportunities
   */
  public getTop(n: number): Opportunity[] {
    return this.opportunities.slice(0, n);
  }

  /**
   * Remove an opportunity by ID.
   *
   * @param id - Opportunity ID to remove
   * @returns true if found and removed, false if not found
   */
  public remove(id: string): boolean {
    const index = this.opportunities.findIndex((opp) => opp.id === id);
    if (index >= 0) {
      this.opportunities.splice(index, 1);
      vlog('opportunity queue: item removed', { id, queueSize: this.opportunities.length });
      return true;
    }
    return false;
  }

  /**
   * Get current queue size.
   */
  public size(): number {
    return this.opportunities.length;
  }

  /**
   * Get all opportunities (for debugging/monitoring).
   */
  public getAll(): Opportunity[] {
    return [...this.opportunities];
  }

  /**
   * Replace entire queue (used by decay circuit).
   *
   * @param newOpportunities - New opportunity list
   */
  public replaceAll(newOpportunities: Opportunity[]): void {
    this.opportunities = newOpportunities;
    this.sort();
  }

  /**
   * Sort opportunities by priority (highest first).
   */
  private sort(): void {
    this.opportunities.sort((a, b) => b.priority - a.priority);
  }
}
