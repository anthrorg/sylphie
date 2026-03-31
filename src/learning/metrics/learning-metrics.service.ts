/**
 * LearningMetricsService — tracks and aggregates learning cycle metrics.
 *
 * Records metrics from each consolidation cycle including entity extraction counts,
 * edge refinement counts, contradiction detections, job execution times, and
 * provenance health. Provides historical analytics and trend detection.
 *
 * CANON §Subsystem 3: Emits comprehensive metrics as the payload of
 * CONSOLIDATION_CYCLE_COMPLETED events. Enables decision making about
 * learning cycle frequency, batch sizes, and job prioritization.
 *
 * Maintains an in-memory rolling window of recent cycle metrics for quick access.
 * Full historical analysis would query TimescaleDB.
 */

import { Injectable, Logger } from '@nestjs/common';

import type { LearningCycleMetrics } from '../interfaces/learning.interfaces';

// Constants
const MAX_RECENT_METRICS = 100; // Keep 100 recent cycles in memory

@Injectable()
export class LearningMetricsService {
  private readonly logger = new Logger(LearningMetricsService.name);

  /**
   * Rolling window of recent cycle metrics (newest first).
   */
  private readonly recentMetrics: LearningCycleMetrics[] = [];

  /**
   * Aggregate statistics across all recorded cycles.
   */
  private aggregateStats = {
    totalCycles: 0,
    totalEntitiesExtracted: 0,
    totalEdgesRefined: 0,
    totalContradictionsFound: 0,
    averageCycleDurationMs: 0,
    totalDurationMs: 0,
  };

  /**
   * Record metrics from a completed consolidation cycle.
   *
   * Adds the metrics to the rolling window and updates aggregate statistics.
   *
   * @param metrics - The cycle metrics to record.
   */
  recordCycleMetrics(metrics: LearningCycleMetrics): void {
    // Add to rolling window
    this.recentMetrics.unshift(metrics); // newest first

    // Maintain size limit
    if (this.recentMetrics.length > MAX_RECENT_METRICS) {
      this.recentMetrics.pop();
    }

    // Update aggregate statistics
    this.aggregateStats.totalCycles++;
    this.aggregateStats.totalEntitiesExtracted += metrics.entitiesExtracted;
    this.aggregateStats.totalEdgesRefined += metrics.edgesRefined;
    this.aggregateStats.totalContradictionsFound +=
      metrics.contradictionsFound;
    this.aggregateStats.totalDurationMs += metrics.cycleDurationMs;
    this.aggregateStats.averageCycleDurationMs = Math.round(
      this.aggregateStats.totalDurationMs /
        this.aggregateStats.totalCycles,
    );

    this.logger.debug(
      `Recorded metrics: cycle ${this.aggregateStats.totalCycles}, ` +
        `duration=${metrics.cycleDurationMs}ms, ` +
        `entities=${metrics.entitiesExtracted}, ` +
        `edges=${metrics.edgesRefined}, ` +
        `contradictions=${metrics.contradictionsFound}`,
    );
  }

  /**
   * Get historical metrics for analysis and trending.
   *
   * Returns the most recent cycles from the in-memory rolling window.
   * For full historical analysis, query TimescaleDB directly.
   *
   * @param limit - Maximum number of recent cycles to retrieve (default 10).
   * @returns Array of recent cycle metrics (newest first).
   */
  getRecentMetrics(limit?: number): LearningCycleMetrics[] {
    const count = limit ?? 10;
    return this.recentMetrics.slice(0, count);
  }

  /**
   * Get the average cycle duration across all recorded cycles.
   *
   * @returns Average duration in milliseconds.
   */
  getCycleDurationAverage(): number {
    return this.aggregateStats.averageCycleDurationMs;
  }

  /**
   * Get the total number of cycles recorded.
   *
   * @returns Total cycle count.
   */
  getTotalCycles(): number {
    return this.aggregateStats.totalCycles;
  }

  /**
   * Get aggregate statistics for diagnostics.
   *
   * @returns Object with aggregate stats.
   */
  getAggregateStats() {
    return {
      totalCycles: this.aggregateStats.totalCycles,
      totalEntitiesExtracted: this.aggregateStats.totalEntitiesExtracted,
      totalEdgesRefined: this.aggregateStats.totalEdgesRefined,
      totalContradictionsFound: this.aggregateStats.totalContradictionsFound,
      averageCycleDurationMs: this.aggregateStats.averageCycleDurationMs,
      totalDurationMs: this.aggregateStats.totalDurationMs,
      entitiesPerCycle:
        this.aggregateStats.totalCycles > 0
          ? Math.round(
              this.aggregateStats.totalEntitiesExtracted /
                this.aggregateStats.totalCycles,
            )
          : 0,
      edgesPerCycle:
        this.aggregateStats.totalCycles > 0
          ? Math.round(
              this.aggregateStats.totalEdgesRefined /
                this.aggregateStats.totalCycles,
            )
          : 0,
      contradictionsPerCycle:
        this.aggregateStats.totalCycles > 0
          ? (
              this.aggregateStats.totalContradictionsFound /
              this.aggregateStats.totalCycles
            ).toFixed(2)
          : '0.00',
    };
  }
}
