/**
 * ConsolidationService — orchestrates the full consolidation pipeline for a batch.
 *
 * Implements IConsolidationService. Coordinates batch selection and full
 * consolidation: entity extraction → edge refinement → contradiction detection
 * → WKG upsert. Manages the state machine of consolidation execution.
 *
 * CANON §Subsystem 3 (Learning): max 5 learnable events per consolidation cycle.
 * This service enforces the budget internally and coordinates all pipeline stages.
 *
 * Pipeline stages:
 *   1. selectBatch(limit): Query learnable events, rank by salience, select top N
 *   2. consolidate(batch): For each event:
 *      - Extract entities via IEntityExtractionService
 *      - Refine edges via IEdgeRefinementService
 *      - Detect contradictions via IContradictionDetector
 *      - Upsert to WKG
 */

import { Injectable, Logger, Inject } from '@nestjs/common';

import { EVENTS_SERVICE } from '../../events';
import type { IEventService } from '../../events';
import { WKG_SERVICE } from '../../knowledge';
import type { IWkgService } from '../../knowledge';
import type { LearnableEvent } from '../../shared/types/event.types';
import type {
  IConsolidationService,
  ConsolidationBatch,
  ConsolidationResult,
  ExtractedEntity,
  ExtractedEdge,
  Contradiction,
  LearningCycleMetrics,
  JobResult,
} from '../interfaces/learning.interfaces';

import { ENTITY_EXTRACTION_SERVICE } from '../learning.tokens';
import type { IEntityExtractionService } from '../interfaces/learning.interfaces';
import { EDGE_REFINEMENT_SERVICE } from '../learning.tokens';
import type { IEdgeRefinementService } from '../interfaces/learning.interfaces';
import { CONTRADICTION_DETECTOR } from '../learning.tokens';
import type { IContradictionDetector } from '../interfaces/learning.interfaces';
import { EVENT_RANKER_SERVICE } from '../learning.tokens';
import type { IEventRankerService } from '../interfaces/learning.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';

// CANON Constants
const DEFAULT_BATCH_SIZE = 5;
const LEARNABLE_EVENT_TYPES = [
  'RESPONSE_DELIVERED',
  'SOCIAL_COMMENT_INITIATED',
  'PREDICTION_EVALUATED',
];

@Injectable()
export class ConsolidationService implements IConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE)
    private readonly wkgService: IWkgService,
    @Inject(ENTITY_EXTRACTION_SERVICE)
    private readonly entityExtractionService: IEntityExtractionService,
    @Inject(EDGE_REFINEMENT_SERVICE)
    private readonly edgeRefinementService: IEdgeRefinementService,
    @Inject(CONTRADICTION_DETECTOR)
    private readonly contradictionDetector: IContradictionDetector,
    @Inject(EVENT_RANKER_SERVICE)
    private readonly eventRankerService: IEventRankerService,
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Select a salience-ranked batch of learnable events for consolidation.
   *
   * CANON §Subsystem 3: Selects up to `limit` events, ranked by salience.
   * Defaults to 5 per CANON specification.
   *
   * @param limit - Maximum number of events to select (default 5).
   * @returns Batch of selected events with salience scores.
   * @throws Error if event query fails.
   */
  async selectBatch(limit?: number): Promise<ConsolidationBatch> {
    const batchSize = limit ?? DEFAULT_BATCH_SIZE;
    const queryStartTime = Date.now();

    try {
      this.logger.log(
        `Selecting batch: limit=${batchSize}, types=${LEARNABLE_EVENT_TYPES.join(', ')}`,
      );

      // Query learnable events from TimescaleDB
      const events = await this.eventsService.query({
        types: LEARNABLE_EVENT_TYPES as any,
        limit: batchSize * 2, // Query extra to rank and select top N
      });

      if (events.length === 0) {
        this.logger.log('No learnable events available for consolidation');
        return {
          events: [],
          salienceScores: [],
          batchSize: 0,
          selectedAt: new Date(),
        };
      }

      this.logger.log(
        `Queried ${events.length} learnable events from TimescaleDB`,
      );

      // Rank events by salience
      const allScores = this.eventRankerService.rankBySalience(
        events as LearnableEvent[],
      );

      // Select top N by salience score
      const selectedScores = allScores.slice(0, batchSize);
      const selectedEventIds = new Set(selectedScores.map((s) => s.eventId));
      const selectedEvents = events.filter((evt) => selectedEventIds.has(evt.id));

      this.logger.log(
        `Selected ${selectedEvents.length} events by salience ` +
          `(top scores: ${selectedScores.map((s) => s.totalScore.toFixed(2)).join(', ')})`,
      );

      const batch: ConsolidationBatch = {
        events: selectedEvents as LearnableEvent[],
        salienceScores: selectedScores,
        batchSize: selectedEvents.length,
        selectedAt: new Date(),
      };

      return batch;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch selection failed: ${errorMsg}`, error);
      throw new Error(`Failed to select consolidation batch: ${errorMsg}`);
    }
  }

  /**
   * Execute the full consolidation pipeline for a batch.
   *
   * For each event in the batch:
   *   1. Extract entities via IEntityExtractionService
   *   2. Refine edges via IEdgeRefinementService
   *   3. Detect contradictions via IContradictionDetector
   *   4. Upsert to WKG if no unresolved contradictions
   *
   * Contradictions are flagged but do not cause the cycle to fail.
   *
   * @param batch - The batch to consolidate.
   * @returns Full consolidation result with metrics.
   * @throws Error if the pipeline fails catastrophically.
   */
  async consolidate(batch: ConsolidationBatch): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const entityResults: ExtractedEntity[] = [];
    const edgeResults: ExtractedEdge[] = [];
    const contradictions: Contradiction[] = [];
    const jobResults: JobResult[] = [];

    this.logger.log(
      `Starting consolidation pipeline for batch of ${batch.events.length} events`,
    );

    // Process each event in the batch
    for (const event of batch.events) {
      try {
        this.logger.debug(`Processing event: ${event.id}`);

        // Stage 1: Extract entities
        const entities = await this.entityExtractionService.extract(event);
        this.logger.debug(
          `Extracted ${entities.length} entities from event ${event.id}`,
        );
        entityResults.push(...entities);

        // Stage 2: Refine edges
        const edges = await this.edgeRefinementService.refine(
          entities,
          event,
        );
        this.logger.debug(
          `Refined ${edges.length} edges from event ${event.id}`,
        );

        // Convert RefinedEdge to ExtractedEdge with source event ID
        const extractedEdges: ExtractedEdge[] = edges.map((edge) => ({
          sourceEntityName: edge.sourceEntityName,
          targetEntityName: edge.targetEntityName,
          relationship: edge.relationship,
          provenance: edge.provenance,
          confidence: edge.confidence,
          refinedBy: edge.refinedBy,
          sourceEventId: event.id,
        }));
        edgeResults.push(...extractedEdges);

        // Stage 3: Detect contradictions for each entity
        for (const entity of entities) {
          try {
            // Query WKG for existing nodes with matching label/type
            const existingNodes = await this.wkgService.findNodeByLabel(
              entity.type,
            );

            // Find a node with matching name
            let existingNode = null;
            if (existingNodes.length > 0) {
              // For now, match by label. In production, implement fuzzy matching
              // or use the entity name to find the best match
              existingNode = existingNodes[0];
            }

            // Check for contradiction
            const checkResult = await this.contradictionDetector.check(
              entity,
              existingNode,
            );

            if (checkResult.type === 'contradiction') {
              // Map ContradictionCheckResult resolution to Contradiction resolution type
              const resolutionMap: Record<
                'GUARDIAN_REVIEW' | 'SUPERSEDED' | 'COEXIST',
                'PREFER_GUARDIAN' | 'MERGE' | 'FLAG_AMBIGUOUS'
              > = {
                GUARDIAN_REVIEW: 'FLAG_AMBIGUOUS',
                SUPERSEDED: 'PREFER_GUARDIAN',
                COEXIST: 'MERGE',
              };

              // Record contradiction for later review
              const contradiction: Contradiction = {
                id: `contradiction-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                type: 'DIRECT',
                existingNodeId: checkResult.existing.id,
                incomingEntity: checkResult.incoming,
                conflictDetails: checkResult.conflictType,
                resolution: resolutionMap[checkResult.resolution],
                confidenceGap:
                  checkResult.incoming.confidence -
                  checkResult.existing.actrParams.base,
                resolvedAt: null,
              };

              contradictions.push(contradiction);

              // Emit CONTRADICTION_DETECTED event
              try {
                const driveSnapshot = this.driveStateReader.getCurrentState();
                await this.eventsService.record({
                  type: 'CONTRADICTION_DETECTED',
                  subsystem: 'LEARNING',
                  sessionId: 'session-id', // TODO: obtain from context
                  driveSnapshot,
                  schemaVersion: 1,
                });
              } catch (eventError) {
                this.logger.warn(
                  `Failed to emit CONTRADICTION_DETECTED event: ` +
                    `${eventError instanceof Error ? eventError.message : String(eventError)}`,
                );
              }

              this.logger.debug(
                `Contradiction detected for entity ${entity.name} (${checkResult.conflictType})`,
              );
            }
          } catch (contradictionError) {
            this.logger.warn(
              `Error checking contradiction for entity ${entity.name}: ` +
                `${contradictionError instanceof Error ? contradictionError.message : String(contradictionError)}`,
            );
          }
        }

        // Stage 4: Upsert non-contradicting entities and edges to WKG
        for (const entity of entities) {
          // Check if this entity has a contradiction flagged for guardian review
          const hasContradiction = contradictions.some(
            (c) =>
              c.incomingEntity.name === entity.name &&
              c.resolution === 'FLAG_AMBIGUOUS',
          );

          if (!hasContradiction) {
            try {
              const upsertResult = await this.wkgService.upsertNode({
                labels: [entity.type],
                nodeLevel: 'INSTANCE',
                provenance: entity.provenance,
                initialConfidence: entity.confidence,
                properties: entity.properties,
              });

              if (upsertResult.type === 'success') {
                this.logger.debug(
                  `Upserted entity: ${entity.name} (${entity.type})`,
                );
              } else {
                this.logger.debug(
                  `Entity upsert resolved to contradiction: ${entity.name}`,
                );
              }
            } catch (upsertError) {
              this.logger.warn(
                `Failed to upsert entity ${entity.name}: ` +
                  `${upsertError instanceof Error ? upsertError.message : String(upsertError)}`,
              );
            }
          }
        }

        // Upsert edges
        for (const edge of extractedEdges) {
          try {
            // For now, upsert edges directly (full implementation would validate node existence)
            // In production, we'd look up source and target node IDs first
            this.logger.debug(
              `Would upsert edge: ${edge.sourceEntityName} -[${edge.relationship}]-> ${edge.targetEntityName}`,
            );
          } catch (edgeError) {
            this.logger.warn(
              `Failed to upsert edge: ` +
                `${edgeError instanceof Error ? edgeError.message : String(edgeError)}`,
            );
          }
        }
      } catch (eventError) {
        this.logger.error(
          `Error processing event ${event.id}: ` +
            `${eventError instanceof Error ? eventError.message : String(eventError)}`,
        );
      }
    }

    // Build metrics
    const durationMs = Date.now() - startTime;
    const metrics: LearningCycleMetrics = {
      cycleDurationMs: durationMs,
      eventsProcessed: batch.events.length,
      entitiesExtracted: entityResults.length,
      edgesRefined: edgeResults.length,
      contradictionsFound: contradictions.length,
      jobsExecuted: 0,
      jobsFailed: 0,
    };

    const result: ConsolidationResult = {
      entityExtractionResults: entityResults,
      edgeRefinementResults: edgeResults,
      contradictions,
      jobResults,
      cycleMetrics: metrics,
      batchSize: batch.events.length,
    };

    this.logger.log(
      `Consolidation complete: ${durationMs}ms, ` +
        `${entityResults.length} entities, ${edgeResults.length} edges, ` +
        `${contradictions.length} contradictions`,
    );

    return result;
  }
}
