/**
 * CorrectionProcessingJob — processes guardian corrections into knowledge.
 *
 * Implements ILearningJob. A learnable job that ingests guardian corrections
 * (CORRECTED_BY edges, retractions, clarifications) and integrates them into
 * the WKG with elevated confidence and priority.
 *
 * CANON §Guardian Asymmetry (Standard 5): Guardian feedback outweighs
 * algorithmic evaluation (2x confirm, 3x correction). This job implements
 * the 3x correction mechanism by:
 *   1. Finding GUARDIAN_CORRECTION events
 *   2. Creating CORRECTED_BY edges (old phrase → new phrase)
 *   3. Penalizing incorrect CAN_PRODUCE edges (confidence *= 0.7)
 *   4. Boosting CORRECTED_BY edges with +0.15 to 0.50 confidence
 *
 * CANON §Immutable Standard 5 (Guardian Asymmetry): CORRECTED_BY edges
 * receive 3x weight, +0.15 confidence boost, and GUARDIAN provenance.
 *
 * CANON §Audit Trail: Original confidence preserved in metadata for lesion testing.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ILearningJob, JobResult } from '../interfaces/learning.interfaces';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { GuardianCorrectionEvent } from '../../shared/types/event.types';
import { computeConfidence } from '../../shared/types/confidence.types';

/**
 * A processed correction: the old phrase that was corrected and new phrase.
 */
interface ProcessedCorrection {
  readonly correctionEventId: string;
  readonly oldPhrase: string;
  readonly newPhrase: string;
  readonly timestamp: Date;
}

@Injectable()
export class CorrectionProcessingJob implements ILearningJob {
  private readonly logger = new Logger(CorrectionProcessingJob.name);

  /** Confidence penalty for penalizing incorrect CAN_PRODUCE edges. */
  private readonly INCORRECT_EDGE_PENALTY = 0.7; // confidence *= 0.7

  /** Confidence boost for CORRECTED_BY edges (from 0.35 base). */
  private readonly CORRECTED_BY_CONFIDENCE_BOOST = 0.15; // 0.35 + 0.15 = 0.50

  constructor(
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE)
    private readonly wkgService: IWkgService,
  ) {}

  /**
   * The human-readable name of this job.
   *
   * @returns Job name
   */
  get name(): string {
    return 'correction-processing';
  }

  /**
   * Determine whether this job should run in the current consolidation cycle.
   *
   * Checks if there are any GUARDIAN_CORRECTION events in the current cycle
   * that need processing.
   *
   * @returns True if guardian corrections are available; false to skip.
   */
  shouldRun(): boolean {
    // In a real implementation, this would check if there are recent GUARDIAN_CORRECTION
    // events pending processing. For now, we always attempt to run — the actual query
    // will find zero corrections and return success.
    return true;
  }

  /**
   * Execute the job and process guardian corrections.
   *
   * 1. Query for GUARDIAN_CORRECTION events
   * 2. Extract old phrase → new phrase mappings
   * 3. Create CORRECTED_BY edges in the WKG (old → new)
   * 4. Penalize any CAN_PRODUCE edges from the old phrase
   * 5. Return job result with artifact count and latency
   *
   * @returns Result of job execution with artifact count, issues, and latency.
   */
  async run(): Promise<JobResult> {
    const startTime = Date.now();
    const issues: string[] = [];
    let artifactCount = 0;

    try {
      this.logger.log(`Starting correction processing job`);

      // Query for guardian correction events from the last 24 hours.
      // In a real learning cycle, this would be bounded to the current consolidation window.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const correctionEvents = await this.eventsService.query({
        types: ['GUARDIAN_CORRECTION'],
        startTime: twentyFourHoursAgo,
        limit: 100,
      });

      if (correctionEvents.length === 0) {
        this.logger.log(`No guardian correction events found`);
        return {
          jobName: this.name,
          success: true,
          artifactCount: 0,
          issues: [],
          latencyMs: Date.now() - startTime,
        };
      }

      this.logger.log(`Found ${correctionEvents.length} correction events`);

      // Extract corrections from the events
      const corrections = this.extractCorrections(correctionEvents);

      if (corrections.length === 0) {
        this.logger.log(`No valid corrections extracted from events`);
        return {
          jobName: this.name,
          success: true,
          artifactCount: 0,
          issues: [],
          latencyMs: Date.now() - startTime,
        };
      }

      // Process each correction
      for (const correction of corrections) {
        try {
          const processedCount = await this.processCorrection(correction);
          artifactCount += processedCount;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          issues.push(`Failed to process correction ${correction.correctionEventId}: ${msg}`);
          this.logger.warn(`Correction processing error: ${msg}`);
        }
      }

      const latencyMs = Date.now() - startTime;

      this.logger.log(
        `Correction processing completed: ${artifactCount} artifacts, ` +
          `${issues.length} issues, ${latencyMs}ms`,
      );

      return {
        jobName: this.name,
        success: issues.length === 0,
        artifactCount,
        issues,
        latencyMs,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - startTime;

      this.logger.error(`Correction processing job failed: ${msg}`);

      return {
        jobName: this.name,
        success: false,
        artifactCount: 0,
        issues: [msg],
        latencyMs,
        error: msg,
      };
    }
  }

  /**
   * Extract corrections from GUARDIAN_CORRECTION events.
   *
   * Parses the content field to extract old phrase → new phrase.
   * The content is expected to contain both phrases in a structured format
   * or as plain text that can be interpreted.
   *
   * @param events - Array of GUARDIAN_CORRECTION events
   * @returns Array of extracted corrections
   */
  private extractCorrections(events: readonly any[]): ProcessedCorrection[] {
    const corrections: ProcessedCorrection[] = [];

    for (const event of events) {
      const correctionEvent = event as GuardianCorrectionEvent;

      // Extract the old and new phrases from the event content.
      // The format is: content may be "old_phrase | new_phrase" or similar.
      // For simplicity, we split on "|" if present, otherwise treat as a single phrase.
      const content = correctionEvent.content || '';
      const parts = content.split('|').map((s) => s.trim());

      if (parts.length >= 2) {
        corrections.push({
          correctionEventId: correctionEvent.id,
          oldPhrase: parts[0],
          newPhrase: parts[1],
          timestamp: correctionEvent.timestamp,
        });
      } else if (parts.length === 1 && parts[0].length > 0) {
        // Single phrase: treat as a new phrase, old phrase is unknown
        // Log as a warning and continue
        this.logger.warn(
          `Correction event ${correctionEvent.id} has no clear old phrase; skipping`,
        );
      }
    }

    return corrections;
  }

  /**
   * Process a single correction: create CORRECTED_BY edge and penalize incorrect edges.
   *
   * 1. Find or create phrase nodes for old and new phrases
   * 2. Create CORRECTED_BY edge from old → new with GUARDIAN provenance
   * 3. Query for CAN_PRODUCE edges from the old phrase
   * 4. Penalize each by reducing confidence (* 0.7)
   * 5. Store original confidence in metadata for audit trail
   *
   * @param correction - The correction to process
   * @returns Number of artifacts (edges/nodes) created or updated
   */
  private async processCorrection(correction: ProcessedCorrection): Promise<number> {
    let artifactCount = 0;

    // Step 1: Find or create phrase nodes.
    // For now, we assume phrase nodes exist as Entity nodes with properties.
    // If they don't exist, we create them.

    const oldPhraseNode = await this.findOrCreatePhraseNode(correction.oldPhrase);
    const newPhraseNode = await this.findOrCreatePhraseNode(correction.newPhrase);

    if (oldPhraseNode && newPhraseNode) {
      artifactCount += 2; // Counted both nodes (even if pre-existing)

      // Step 2: Create CORRECTED_BY edge from old → new.
      // CORRECTED_BY edges carry GUARDIAN provenance and 0.50 confidence (0.35 base + 0.15 boost).
      const correctedByResult = await this.wkgService.upsertEdge({
        sourceId: oldPhraseNode.id,
        targetId: newPhraseNode.id,
        relationship: 'CORRECTED_BY',
        provenance: 'GUARDIAN',
        initialConfidence: 0.35 + this.CORRECTED_BY_CONFIDENCE_BOOST,
        properties: {
          correctionEventId: correction.correctionEventId,
          correctionTimestamp: correction.timestamp.toISOString(),
          weight: 3, // Guardian asymmetry: 3x weight
          originalConfidenceMetadata: { boost: this.CORRECTED_BY_CONFIDENCE_BOOST },
        },
      });

      if (correctedByResult.type === 'success') {
        artifactCount += 1; // CORRECTED_BY edge created/updated
        this.logger.log(
          `Created CORRECTED_BY edge: ${correction.oldPhrase} → ${correction.newPhrase}`,
        );
      } else {
        this.logger.warn(
          `CORRECTED_BY edge creation contradicted for ${correction.oldPhrase} → ${correction.newPhrase}`,
        );
      }

      // Step 3: Penalize CAN_PRODUCE edges from the old phrase.
      // Query for all CAN_PRODUCE edges from the old phrase node.
      const canProduceEdges = await this.wkgService.queryEdges({
        sourceId: oldPhraseNode.id,
        relationship: 'CAN_PRODUCE',
      });

      if (canProduceEdges.length > 0) {
        this.logger.log(
          `Found ${canProduceEdges.length} CAN_PRODUCE edges from corrected phrase; penalizing`,
        );
      }

      for (const edge of canProduceEdges) {
        try {
          // Calculate the penalized confidence using the ACT-R formula.
          // Original confidence is computed from actrParams.
          const originalConfidence = computeConfidence(edge.actrParams);
          const penalizedConfidence = originalConfidence * this.INCORRECT_EDGE_PENALTY;

          // Re-upsert the edge with reduced confidence and audit metadata.
          const penaltyResult = await this.wkgService.upsertEdge({
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            relationship: 'CAN_PRODUCE',
            provenance: edge.provenance,
            initialConfidence: penalizedConfidence,
            properties: {
              ...edge.properties,
              penalizedDueToCorrection: true,
              originalConfidenceBeforePenalty: originalConfidence,
              penaltyFactor: this.INCORRECT_EDGE_PENALTY,
              correctionEventId: correction.correctionEventId,
              penaltyTimestamp: correction.timestamp.toISOString(),
            },
          });

          if (penaltyResult.type === 'success') {
            artifactCount += 1;
            this.logger.log(
              `Penalized CAN_PRODUCE edge: ${originalConfidence.toFixed(3)} → ` +
                `${penalizedConfidence.toFixed(3)}`,
            );
          } else {
            this.logger.warn(`Penalty upsert resulted in contradiction; skipping`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Failed to penalize CAN_PRODUCE edge: ${msg}`);
        }
      }
    }

    return artifactCount;
  }

  /**
   * Find an existing phrase node or create one if it doesn't exist.
   *
   * Phrase nodes are Entity nodes with a specific structure.
   * We search by name property matching the phrase text.
   *
   * @param phrase - The phrase text
   * @returns The phrase node, or null if creation failed
   */
  private async findOrCreatePhraseNode(
    phrase: string,
  ): Promise<{ id: string } | null> {
    try {
      // Query for existing phrase node by label and property.
      const existingNodes = await this.wkgService.findNodeByLabel('Entity');
      const phraseNode = existingNodes.find(
        (node) => node.properties?.name === phrase || node.properties?.text === phrase,
      );

      if (phraseNode) {
        return { id: phraseNode.id };
      }

      // Create a new phrase node.
      const createResult = await this.wkgService.upsertNode({
        labels: ['Entity', 'Phrase'],
        nodeLevel: 'INSTANCE',
        provenance: 'GUARDIAN',
        initialConfidence: 0.60,
        properties: {
          name: phrase,
          text: phrase,
          type: 'Phrase',
        },
      });

      if (createResult.type === 'success') {
        return { id: createResult.node.id };
      } else {
        this.logger.warn(`Contradiction creating phrase node for "${phrase}"`);
        return null;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to find/create phrase node for "${phrase}": ${msg}`);
      return null;
    }
  }
}
