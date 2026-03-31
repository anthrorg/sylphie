/**
 * ConfidenceService — Real implementation of IConfidenceService.
 *
 * Wraps the pure computeConfidence() formula with stateful side effects:
 * - Persists ACT-R params and retrieval counts to Neo4j
 * - Enforces the Confidence Ceiling (CANON Standard 3)
 * - Applies Guardian Asymmetry multipliers (CANON Standard 5)
 * - Emits KNOWLEDGE_RETRIEVAL_AND_USE events to TimescaleDB
 *
 * CANON Standard 6 (No Self-Modification of Evaluation): compute() and
 * checkCeiling() are transparent wrappers over pure formulas that this
 * service cannot modify.
 *
 * Provided under the CONFIDENCE_SERVICE token by KnowledgeModule.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { Driver, Session } from 'neo4j-driver';
import {
  computeConfidence,
  applyGuardianWeight,
  CONFIDENCE_THRESHOLDS,
  DEFAULT_DECAY_RATES,
  type ACTRParams,
} from '../shared/types/confidence.types';
import { resolveBaseConfidence, type ProvenanceSource } from '../shared/types/provenance.types';
import type { SylphieEvent } from '../shared/types/event.types';
import { INITIAL_DRIVE_STATE, type DriveSnapshot, computeTotalPressure } from '../shared/types/drive.types';
import type { IConfidenceService } from './interfaces/knowledge.interfaces';
import type { IEventService } from '../events/interfaces/events.interfaces';
import { NEO4J_DRIVER } from './knowledge.tokens';
import { EVENTS_SERVICE } from '../events/events.tokens';

// Debug info returned by getConfidenceDebugInfo
export interface ConfidenceDebugInfo {
  readonly nodeId: string;
  readonly base: number;
  readonly provenance: ProvenanceSource;
  readonly retrievalCount: number;
  readonly lastRetrievedAt: Date | null;
  readonly hoursElapsed: number;
  readonly computed: number;
  readonly ceiling: number;
  readonly isAtCeiling: boolean;
  readonly decayRate: number;
  readonly lnCountTerm: number;
  readonly lnTimeTerm: number;
}

@Injectable()
export class ConfidenceService implements IConfidenceService {
  private readonly logger = new Logger(ConfidenceService.name);

  constructor(
    @Inject(NEO4J_DRIVER) private readonly driver: Driver,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
  ) {}

  /**
   * Transparent wrapper over the pure computeConfidence() formula.
   * Synchronous. No side effects.
   *
   * CANON Standard 6: This method is never altered to produce different
   * values based on system state.
   */
  compute(params: ACTRParams): number {
    return computeConfidence(params);
  }

  /**
   * Record a retrieval-and-use event for a WKG node.
   *
   * Loads the node's current ACT-R parameters, increments count if success
   * is true, updates lastRetrievedAt, recomputes confidence, and persists
   * updated params back to Neo4j.
   *
   * If success is false, count is not incremented but lastRetrievedAt is
   * still updated to trigger natural decay.
   *
   * Emits KNOWLEDGE_RETRIEVAL_AND_USE event to TimescaleDB.
   *
   * This is the primary mechanism for lifting the Confidence Ceiling
   * (Standard 3): count grows from 0 to 1+ only through this method.
   *
   * @param nodeId - Neo4j element ID of the node
   * @param success - Whether the retrieval produced a correct, useful result
   * @throws KnowledgeException if nodeId not found or persistence fails
   */
  async recordUse(nodeId: string, success: boolean): Promise<void> {
    const session = this.driver.session();

    try {
      // Step 1: Fetch current node and ACT-R params
      const fetchResult = await session.run(
        `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        RETURN {
          id: elementId(n),
          provenance: n.provenance,
          actrBase: n.actr_base,
          actrCount: n.actr_count,
          actrDecayRate: n.actr_decay_rate,
          actrLastRetrievedAt: n.actr_last_retrieved_at
        } as node_data
        `,
        { nodeId },
      );

      if (fetchResult.records.length === 0) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      const nodeData = fetchResult.records[0].get('node_data');
      const provenance = nodeData.provenance as ProvenanceSource;
      const base = nodeData.actrBase as number;
      let count = nodeData.actrCount as number;
      const decayRate = nodeData.actrDecayRate as number;
      const lastRetrievedAt = nodeData.actrLastRetrievedAt as Date | null;

      // Step 2: Increment count only if success is true
      if (success) {
        count += 1;
      }

      // Step 3: Update lastRetrievedAt to now (regardless of success)
      const now = new Date();

      // Step 4: Recompute confidence with new params
      const newParams: ACTRParams = {
        base,
        count,
        decayRate,
        lastRetrievalAt: now,
      };
      const newConfidence = computeConfidence(newParams);

      // Step 5: Persist updated ACT-R params to Neo4j
      await session.run(
        `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        SET
          n.actr_count = $count,
          n.actr_last_retrieved_at = $lastRetrievedAt,
          n.confidence = $confidence
        RETURN true
        `,
        {
          nodeId,
          count,
          lastRetrievedAt: now.toISOString(),
          confidence: newConfidence,
        },
      );

      // Step 6: Emit KNOWLEDGE_RETRIEVAL_AND_USE event to TimescaleDB
      // Only emit if success is true (no event for failed retrievals)
      if (success) {
        await this.eventsService.record(
          {
            type: 'KNOWLEDGE_RETRIEVAL_AND_USE',
            subsystem: 'LEARNING',
            sessionId: 'unknown',
            provenance,
            // LearnableEvent properties
            hasLearnable: true,
            content: `Retrieved node ${nodeId} with updated confidence ${newConfidence.toFixed(3)}`,
            guardianFeedbackType: 'none',
            source: 'SENSOR',
            salience: newConfidence,
            // Drive snapshot: use default since KnowledgeModule cannot import
            // DriveEngineModule per CANON §Drive Isolation. This is a system event
            // (not user-facing), so a default snapshot is acceptable.
            driveSnapshot: this.getDefaultDriveSnapshot(),
            schemaVersion: 1,
          } as unknown as Omit<SylphieEvent, 'id' | 'timestamp'>,
        );
      }

      this.logger.debug(
        `Recorded retrieval for node ${nodeId}: success=${success}, count=${count}, confidence=${newConfidence.toFixed(3)}`,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Enforce the Confidence Ceiling (CANON Standard 3).
   *
   * If retrievalCount is 0, confidence is clamped to CONFIDENCE_THRESHOLDS.ceiling
   * (0.60). If retrievalCount >= 1, the ceiling does not apply; the value is
   * still clamped to [0.0, 1.0].
   *
   * Synchronous pure function — no I/O.
   *
   * @param confidence - Raw computed or proposed confidence value
   * @param retrievalCount - Number of successful retrieval-and-use events
   * @returns Confidence clamped per Ceiling rule
   */
  checkCeiling(confidence: number, retrievalCount: number): number {
    const clamped = Math.min(1.0, Math.max(0.0, confidence));
    if (retrievalCount === 0) {
      return Math.min(CONFIDENCE_THRESHOLDS.ceiling, clamped);
    }
    return clamped;
  }

  /**
   * Transparent wrapper over the pure applyGuardianWeight() function.
   * Synchronous. No side effects.
   *
   * CANON Standard 5 (Guardian Asymmetry):
   *   - confirmation: 2x weight
   *   - correction: 3x weight
   */
  applyGuardianWeight(
    delta: number,
    feedbackType: 'confirmation' | 'correction',
  ): number {
    return applyGuardianWeight(delta, feedbackType);
  }

  /**
   * Batch-recompute confidence for a set of WKG nodes.
   *
   * Used by the Learning subsystem's maintenance cycle to refresh confidence
   * values for nodes that have not been retrieved recently (ACT-R decay).
   *
   * Loads ACT-R params for all nodeIds, recomputes confidence, and persists
   * updated values in a single write pass.
   *
   * @param nodeIds - Array of Neo4j element IDs to recompute
   * @returns Map from nodeId to updated confidence value
   * @throws Error if batch read or write fails
   */
  async batchRecompute(nodeIds: string[]): Promise<Map<string, number>> {
    if (nodeIds.length === 0) {
      return new Map();
    }

    const session = this.driver.session();

    try {
      // Step 1: Fetch all nodes and their current ACT-R params in one pass
      const fetchResult = await session.run(
        `
        MATCH (n)
        WHERE elementId(n) IN $nodeIds
        RETURN {
          id: elementId(n),
          actrBase: n.actr_base,
          actrCount: n.actr_count,
          actrDecayRate: n.actr_decay_rate,
          actrLastRetrievedAt: n.actr_last_retrieved_at
        } as node_data
        `,
        { nodeIds },
      );

      // Step 2: Recompute confidence for each node
      const updates: Array<{
        readonly nodeId: string;
        readonly confidence: number;
      }> = [];

      for (const record of fetchResult.records) {
        const nodeData = record.get('node_data');
        const nodeId = nodeData.id as string;
        const base = nodeData.actrBase as number;
        const count = nodeData.actrCount as number;
        const decayRate = nodeData.actrDecayRate as number;
        const lastRetrievedAt = nodeData.actrLastRetrievedAt as Date | null;

        const params: ACTRParams = {
          base,
          count,
          decayRate,
          lastRetrievalAt: lastRetrievedAt,
        };

        const confidence = computeConfidence(params);
        updates.push({ nodeId, confidence });
      }

      // Step 3: Persist all updates in a single transaction
      if (updates.length > 0) {
        const updateQueries = updates
          .map(
            (u, idx) =>
              `
          MATCH (n) WHERE elementId(n) = $nodeId${idx}
          SET n.confidence = $confidence${idx}
          `,
          )
          .join('\n');

        const params: Record<string, unknown> = {};
        updates.forEach((u, idx) => {
          params[`nodeId${idx}`] = u.nodeId;
          params[`confidence${idx}`] = u.confidence;
        });

        await session.run(`${updateQueries} RETURN true`, params);
      }

      // Step 4: Return map of nodeId -> confidence
      const result = new Map<string, number>();
      for (const update of updates) {
        result.set(update.nodeId, update.confidence);
      }

      this.logger.debug(`Batch-recomputed confidence for ${updates.length} nodes`);
      return result;
    } finally {
      await session.close();
    }
  }

  /**
   * Get detailed debug information about a node's confidence computation.
   *
   * Useful for understanding why a particular confidence value is what it is.
   * Returns all ACT-R parameters, computed value, ceiling state, and intermediate
   * terms from the formula.
   *
   * @param nodeId - Neo4j element ID of the node
   * @returns ConfidenceDebugInfo with all computation details
   * @throws Error if nodeId not found
   */
  async getConfidenceDebugInfo(nodeId: string): Promise<ConfidenceDebugInfo> {
    const session = this.driver.session();

    try {
      const fetchResult = await session.run(
        `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        RETURN {
          id: elementId(n),
          provenance: n.provenance,
          actrBase: n.actr_base,
          actrCount: n.actr_count,
          actrDecayRate: n.actr_decay_rate,
          actrLastRetrievedAt: n.actr_last_retrieved_at
        } as node_data
        `,
        { nodeId },
      );

      if (fetchResult.records.length === 0) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      const nodeData = fetchResult.records[0].get('node_data');
      const provenance = nodeData.provenance as ProvenanceSource;
      const base = nodeData.actrBase as number;
      const count = nodeData.actrCount as number;
      const decayRate = nodeData.actrDecayRate as number;
      const lastRetrievedAt = nodeData.actrLastRetrievedAt as Date | null;

      // Compute debug terms
      const now = Date.now();
      const hoursElapsed =
        lastRetrievedAt !== null
          ? (now - lastRetrievedAt.getTime()) / (1000 * 60 * 60)
          : 0;

      const lnCountTerm = count > 0 ? Math.log(count) : 0;
      const lnTimeTerm = Math.log(hoursElapsed + 1);

      const params: ACTRParams = {
        base,
        count,
        decayRate,
        lastRetrievalAt: lastRetrievedAt,
      };
      const computed = computeConfidence(params);
      const ceiling = this.checkCeiling(computed, count);
      const isAtCeiling = ceiling < computed;

      return {
        nodeId,
        base,
        provenance,
        retrievalCount: count,
        lastRetrievedAt,
        hoursElapsed,
        computed,
        ceiling,
        isAtCeiling,
        decayRate,
        lnCountTerm,
        lnTimeTerm,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Create a default DriveSnapshot for system events that occur outside
   * the normal decision-making cycle.
   *
   * CANON §Drive Isolation: KnowledgeModule cannot import DriveEngineModule,
   * so system events like KNOWLEDGE_RETRIEVAL_AND_USE use this default snapshot
   * built from INITIAL_DRIVE_STATE.
   *
   * @returns A valid DriveSnapshot with initial pressure values
   * @private
   */
  private getDefaultDriveSnapshot(): DriveSnapshot {
    return {
      pressureVector: INITIAL_DRIVE_STATE,
      timestamp: new Date(),
      tickNumber: 0,
      driveDeltas: {
        systemHealth: 0,
        moralValence: 0,
        integrity: 0,
        cognitiveAwareness: 0,
        guilt: 0,
        curiosity: 0,
        boredom: 0,
        anxiety: 0,
        satisfaction: 0,
        sadness: 0,
        informationIntegrity: 0,
        social: 0,
      },
      ruleMatchResult: {
        ruleId: null,
        eventType: 'SYSTEM_KNOWLEDGE_RETRIEVAL',
        matched: false,
      },
      totalPressure: computeTotalPressure(INITIAL_DRIVE_STATE),
      sessionId: 'system',
    };
  }
}
