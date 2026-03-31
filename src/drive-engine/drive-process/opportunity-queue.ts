/**
 * Priority queue for opportunities.
 *
 * Maintains active opportunities in priority order (highest first).
 * Bounded at MAX_QUEUE_SIZE. Emits top opportunities periodically to Planning.
 */

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
   * Maintains sorted order. If queue exceeds MAX_QUEUE_SIZE,
   * removes the lowest-priority item.
   *
   * @param opp - Opportunity to add
   */
  public add(opp: Opportunity): void {
    this.opportunities.push(opp);
    this.sort();

    // Enforce size limit by removing lowest priority
    if (this.opportunities.length > MAX_QUEUE_SIZE) {
      this.opportunities = this.opportunities.slice(0, MAX_QUEUE_SIZE);
    }
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
