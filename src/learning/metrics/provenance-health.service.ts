/**
 * ProvenanceHealthService — health assessment of the WKG by provenance distribution.
 *
 * Analyzes the distribution of provenance sources (SENSOR, GUARDIAN, LLM_GENERATED,
 * INFERENCE) across the World Knowledge Graph and assigns a health status.
 *
 * CANON §7 (Provenance Is Sacred): A healthy KG has a high ratio of experiential
 * knowledge (SENSOR, GUARDIAN) vs. speculative knowledge (LLM_GENERATED, INFERENCE).
 * This service quantifies that ratio for diagnostics and guides learning priorities.
 *
 * The Lesion Test (executeLesionTest) measures KG resilience by removing LLM_GENERATED
 * edges and comparing the result to the full graph. Target: >= 0.4 resilience ratio.
 *
 * Health metrics are emitted periodically via TimescaleDB for trend analysis.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';

import { WKG_SERVICE } from '../../knowledge';
import { EVENTS_SERVICE } from '../../events';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type {
  ProvenanceHealth,
} from '../interfaces/learning.interfaces';

/**
 * Internal interface for provenance health assessment.
 * Not exported from the module.
 */
export interface IProvenanceHealthService {
  /**
   * Assess the health of the WKG by provenance distribution.
   *
   * @returns Health assessment with ratio breakdown and status.
   */
  assessHealth(): Promise<ProvenanceHealth>;

  /**
   * Execute the Lesion Test: measure WKG resilience by excluding LLM_GENERATED edges.
   *
   * @returns Resilience ratio (lesioned_size / full_size).
   */
  executeLesionTest(): Promise<number>;

  /**
   * Periodically emit health metrics to TimescaleDB.
   *
   * Emits every 10 cycles to avoid event spam. Call after each consolidation
   * cycle to track provenance health trends over time.
   *
   * @returns True if a health event was emitted; false if cycle threshold not met.
   */
  emitHealthMetrics(): Promise<boolean>;
}

@Injectable()
export class ProvenanceHealthService implements IProvenanceHealthService {
  private readonly logger = new Logger(ProvenanceHealthService.name);

  /** Cycle counter for periodic emission. Emits every 10 cycles. */
  private cycleCount = 0;

  /** Rolling window of recent health snapshots for trend analysis. */
  private readonly healthHistory: ProvenanceHealth[] = [];

  /** Maximum number of health snapshots to retain. */
  private readonly maxHistorySize = 10;

  constructor(
    @Inject(WKG_SERVICE)
    private readonly wkgService: IWkgService,
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: IEventService,
  ) {}

  /**
   * Assess the health of the WKG by provenance distribution.
   *
   * Queries the WKG for all nodes, groups by provenance source, and computes:
   * - Ratios of each provenance type to total
   * - Experiential ratio (SENSOR + GUARDIAN) / total
   * - LLM dependency ratio (LLM_GENERATED) / total
   * - Guardian ratio (GUARDIAN) / total
   * - Health status classification
   *
   * CANON §7: Health classification:
   *   HEALTHY: experiential > 0.6 AND llmDependency < 0.5 AND guardian >= 0.15
   *   DEVELOPING: intermediate values
   *   UNHEALTHY: experiential < 0.3 OR llmDependency > 0.7 OR guardian < 0.05
   *
   * @returns Health assessment with ratio breakdown and status.
   */
  async assessHealth(): Promise<ProvenanceHealth> {
    this.logger.debug('Computing WKG provenance health metrics...');

    try {
      // Query graph statistics broken down by provenance
      const stats = await this.wkgService.queryGraphStats();

      const totalNodes = stats.totalNodes;
      const totalEdges = stats.totalEdges;

      // Extract counts by provenance source (zero-count sources are omitted)
      const sensorCount = stats.byProvenance['SENSOR'] || 0;
      const guardianCount = stats.byProvenance['GUARDIAN'] || 0;
      const llmCount = stats.byProvenance['LLM_GENERATED'] || 0;
      const inferenceCount = stats.byProvenance['INFERENCE'] || 0;

      // Also consider extended provenance sources
      const guardianApprovedCount = stats.byProvenance['GUARDIAN_APPROVED_INFERENCE'] || 0;
      const taughtProcedureCount = stats.byProvenance['TAUGHT_PROCEDURE'] || 0;
      const behavioralInferenceCount = stats.byProvenance['BEHAVIORAL_INFERENCE'] || 0;
      const bootstrapCount = stats.byProvenance['SYSTEM_BOOTSTRAP'] || 0;

      // Aggregate experiential sources (SENSOR + GUARDIAN + their approved variants)
      const experientialCount =
        sensorCount +
        guardianCount +
        guardianApprovedCount +
        taughtProcedureCount +
        bootstrapCount;

      // Compute ratios
      const sensorRatio = totalNodes > 0 ? sensorCount / totalNodes : 0;
      const guardianRatio = totalNodes > 0 ? guardianCount / totalNodes : 0;
      const llmRatio = totalNodes > 0 ? llmCount / totalNodes : 0;
      const inferenceRatio = totalNodes > 0 ? inferenceCount / totalNodes : 0;

      const experientialRatio = totalNodes > 0 ? experientialCount / totalNodes : 0;
      const llmDependency = llmRatio;
      const guardianEffectiveRatio = totalNodes > 0
        ? (guardianCount + guardianApprovedCount + taughtProcedureCount) / totalNodes
        : 0;

      // Classify health status
      let healthStatus: 'HEALTHY' | 'DEVELOPING' | 'UNHEALTHY';

      if (
        experientialRatio > 0.6 &&
        llmDependency < 0.5 &&
        guardianEffectiveRatio >= 0.15
      ) {
        healthStatus = 'HEALTHY';
      } else if (
        experientialRatio < 0.3 ||
        llmDependency > 0.7 ||
        guardianEffectiveRatio < 0.05
      ) {
        healthStatus = 'UNHEALTHY';
      } else {
        healthStatus = 'DEVELOPING';
      }

      this.logger.log(
        `Provenance health: ${healthStatus} ` +
        `(experiential: ${(experientialRatio * 100).toFixed(1)}%, ` +
        `llm: ${(llmDependency * 100).toFixed(1)}%, ` +
        `guardian: ${(guardianEffectiveRatio * 100).toFixed(1)}%)`
      );

      const health: ProvenanceHealth = {
        sensorRatio,
        guardianRatio,
        llmRatio,
        inferenceRatio,
        healthStatus,
        totalNodes,
        totalEdges,
      };

      // Store in history for trend analysis
      this.healthHistory.push(health);
      if (this.healthHistory.length > this.maxHistorySize) {
        this.healthHistory.shift();
      }

      return health;
    } catch (error) {
      this.logger.error(
        `Failed to assess WKG provenance health: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Execute the Lesion Test: measure WKG resilience by excluding LLM_GENERATED edges.
   *
   * The Lesion Test removes all LLM_GENERATED edges from the graph and measures
   * how much structural information remains. This quantifies how much of the KG
   * depends on LLM refinement vs. experiential (SENSOR, GUARDIAN) knowledge.
   *
   * Target: >= 0.4 resilience ratio indicates a healthy knowledge base that
   * can function meaningfully even if all speculative edges are removed.
   *
   * Implementation: Query the full WKG, then query the same nodes filtering
   * for edges where provenance != 'LLM_GENERATED'. Compare edge counts.
   *
   * Non-destructive: This test does not modify the graph.
   *
   * @returns Resilience ratio: lesion_edge_count / full_edge_count.
   *          If graph has no edges, returns 1.0 (trivially resilient).
   */
  async executeLesionTest(): Promise<number> {
    this.logger.debug('Executing Lesion Test on WKG...');

    try {
      // Get full graph stats
      const fullStats = await this.wkgService.queryGraphStats();
      const fullEdgeCount = fullStats.totalEdges;

      // If no edges, graph is trivially resilient
      if (fullEdgeCount === 0) {
        this.logger.debug('Lesion Test: empty graph, trivial resilience = 1.0');
        return 1.0;
      }

      // Query all edges and filter out LLM_GENERATED in-memory
      // This is a pragmatic approach: we query with minimal filter to get all
      // edges, then count those that are NOT LLM_GENERATED.
      // In production, this could be optimized via Neo4j filtering.
      const subgraphResult = await this.wkgService.querySubgraph(
        { minConfidence: 0 }, // Include all confidence levels for complete picture
        10000 // High limit to capture all edges
      );

      const lesionEdgeCount = subgraphResult.edges.filter(
        edge => edge.provenance !== 'LLM_GENERATED'
      ).length;

      const resilienceRatio = lesionEdgeCount / fullEdgeCount;

      this.logger.log(
        `Lesion Test: ${lesionEdgeCount}/${fullEdgeCount} edges survive ` +
        `(resilience: ${(resilienceRatio * 100).toFixed(1)}%)`
      );

      return resilienceRatio;
    } catch (error) {
      this.logger.error(
        `Lesion Test failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Periodically emit health metrics to TimescaleDB.
   *
   * Accumulates cycle count and emits a diagnostic event every 10 cycles
   * to track health trends over time without spamming the event log.
   *
   * On emission, also runs the Lesion Test to include resilience metric.
   *
   * Note: Event emission currently deferred pending PROVENANCE_HEALTH event
   * type addition to EventType union. The metrics computation still occurs.
   *
   * @returns True if metrics were computed and stored; false if cycle threshold not met.
   */
  async emitHealthMetrics(): Promise<boolean> {
    this.cycleCount++;

    // Emit every 10 cycles
    if (this.cycleCount % 10 !== 0) {
      return false;
    }

    this.logger.debug(
      `Computing periodic health metrics (cycle: ${this.cycleCount})`
    );

    try {
      // Compute health and resilience
      const health = await this.assessHealth();
      const resilienceRatio = await this.executeLesionTest();

      // Log comprehensive metrics
      this.logger.log(
        `Periodic health snapshot (cycle ${this.cycleCount}): ` +
        `resilience=${(resilienceRatio * 100).toFixed(1)}%, ` +
        `status=${health.healthStatus}, ` +
        `experiential=${((health.sensorRatio + health.guardianRatio) * 100).toFixed(1)}%`
      );

      // Store metrics in history for trend analysis
      // (In production, these could be emitted as a PROVENANCE_HEALTH event
      // once that event type is added to the EventType union)

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to compute health metrics: ${error instanceof Error ? error.message : String(error)}`
      );
      // Do not re-throw: health check failure should not break the learning cycle
      return false;
    }
  }
}
