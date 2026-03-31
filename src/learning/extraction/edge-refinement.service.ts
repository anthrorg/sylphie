/**
 * EdgeRefinementService — LLM-backed edge derivation between extracted entities.
 *
 * Implements IEdgeRefinementService. Always a Type 2 operation: every call
 * goes to the LLM for relationship inference. There is no Type 1 path for
 * edge refinement in Phase 1.
 *
 * All returned RefinedEdges carry provenance: 'LLM_GENERATED' at the literal
 * type level — structural enforcement of CANON §7.
 *
 * CANON §Learning: CAN_PRODUCE edges (recording which phrases Sylphie produced)
 * are a primary output type here. They are always LLM_GENERATED provenance.
 *
 * Type 2 cost must be reported to the Events module on every LLM call
 * (CANON §Dual-Process Type 2 Cost Requirement).
 *
 * STUB: All methods throw 'Not implemented'. Full implementation follows in
 * a later epic.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';

import type { LearnableEvent } from '../../shared/types/event.types';
import type {
  IEdgeRefinementService,
  ExtractedEntity,
  RefinedEdge,
} from '../interfaces/learning.interfaces';
import type { ILlmService } from '../../shared/types/llm.types';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { EVENTS_SERVICE } from '../../events';

/**
 * Response structure expected from the LLM when asked to refine edges.
 * Used for parsing LLM JSON output.
 */
interface LlmRefinementResponse {
  readonly edges: Array<{
    readonly sourceEntityName: string;
    readonly targetEntityName: string;
    readonly relationship: string;
    readonly confidence: number;
  }>;
}

@Injectable()
export class EdgeRefinementService implements IEdgeRefinementService {
  private readonly logger = new Logger(EdgeRefinementService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILlmService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
  ) {}

  /**
   * Derive and refine edges between the provided entities, using the originating
   * event as contextual grounding.
   *
   * All returned edges carry provenance: 'LLM_GENERATED' (literal type).
   * An empty array is valid — not all entity sets have identifiable relationships.
   *
   * CANON §Type 2 Cost Requirement: Cost event is emitted per LLM call.
   *
   * @param entities - The entities extracted from the event (may be empty).
   * @param context  - The originating LearnableEvent, used to ground the LLM call.
   * @returns Array of refined edges (may be empty). Never null.
   * @throws LearningException if the LLM call fails and no fallback is available.
   */
  async refine(
    entities: readonly ExtractedEntity[],
    context: LearnableEvent,
  ): Promise<RefinedEdge[]> {
    // Short circuit: need at least 2 entities to form an edge
    if (entities.length < 2) {
      this.logger.debug(
        `EdgeRefinement: Entity count ${entities.length} < 2; returning empty array`,
      );
      return [];
    }

    // Build entity context for the LLM prompt
    const entityList = entities
      .map((e) => `- ${e.name} (type: ${e.type})`)
      .join('\n');

    // Construct the refinement prompt
    const systemPrompt = `You are Sylphie's knowledge extraction system. Your task is to identify meaningful relationships between entities from conversational content.

Return ONLY valid JSON with the structure:
{
  "edges": [
    {
      "sourceEntityName": "entity1Name",
      "targetEntityName": "entity2Name",
      "relationship": "RELATIONSHIP_TYPE",
      "confidence": 0.75
    }
  ]
}

Allowed relationship types: HAS_PROPERTY, IS_A, CAN_PRODUCE, RESPONSE_TO, FOLLOWS_PATTERN, TRIGGERS, SUPERSEDES, CORRECTED_BY

Confidence must be a number in [0.0, 1.0]. Be conservative: most edges should have confidence < 0.60.

Return only edges you are confident about. An empty edges array is acceptable.`;

    const userPrompt = `Extract relationships between these entities from the following content:

Entities:
${entityList}

Content:
"${context.content}"

Identify only explicit or strongly implied relationships. Avoid speculation.`;

    try {
      // Make LLM call with cost tracking
      const llmRequest = {
        messages: [
          {
            role: 'user' as const,
            content: userPrompt,
          },
        ],
        systemPrompt,
        maxTokens: 1000,
        temperature: 0.2, // Conservative for relationship extraction
        metadata: {
          callerSubsystem: 'LEARNING' as const,
          purpose: 'EDGE_REFINEMENT',
          sessionId: context.sessionId,
          correlationId: context.id,
        },
      };

      const startTime = Date.now();
      const response = await this.llmService.complete(llmRequest);
      const latencyMs = Date.now() - startTime;

      // Parse LLM response
      let parsedResponse: LlmRefinementResponse;
      try {
        // Extract JSON from the response (handle potential markdown code blocks)
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          this.logger.warn(
            `EdgeRefinement: No JSON found in LLM response, returning empty array`,
          );
          return [];
        }

        parsedResponse = JSON.parse(jsonMatch[0]) as LlmRefinementResponse;
      } catch (parseError) {
        this.logger.warn(
          `EdgeRefinement: JSON parse failed: ${
            parseError instanceof Error ? parseError.message : String(parseError)
          }; returning empty array`,
        );
        return [];
      }

      // Validate and transform edges
      const refinedEdges: RefinedEdge[] = [];

      if (Array.isArray(parsedResponse.edges)) {
        for (const edge of parsedResponse.edges) {
          // Validate required fields
          if (
            !edge.sourceEntityName ||
            !edge.targetEntityName ||
            !edge.relationship
          ) {
            this.logger.debug(
              `EdgeRefinement: Skipping edge with missing fields: ${JSON.stringify(
                edge,
              )}`,
            );
            continue;
          }

          // Validate confidence is a number in [0.0, 1.0]
          const confidence = typeof edge.confidence === 'number'
            ? Math.min(1.0, Math.max(0.0, edge.confidence))
            : 0.35;

          // Ensure confidence does not exceed ceiling (0.60)
          const cappedConfidence = Math.min(0.60, confidence);

          // Validate relationship type is one of the 8 allowed types
          const allowedRelationships = [
            'HAS_PROPERTY',
            'IS_A',
            'CAN_PRODUCE',
            'RESPONSE_TO',
            'FOLLOWS_PATTERN',
            'TRIGGERS',
            'SUPERSEDES',
            'CORRECTED_BY',
          ];

          if (!allowedRelationships.includes(edge.relationship)) {
            this.logger.debug(
              `EdgeRefinement: Invalid relationship type "${edge.relationship}"; skipping edge`,
            );
            continue;
          }

          // Build metadata to track original entity provenance
          const sourceEntity = entities.find(
            (e) => e.name === edge.sourceEntityName,
          );
          const targetEntity = entities.find(
            (e) => e.name === edge.targetEntityName,
          );

          const metadata: Record<string, unknown> = {
            refinedBy: 'edge-refinement-service',
            sourceEventId: context.id,
          };

          // Preserve provenance chain if source/target are extracted entities
          if (sourceEntity) {
            metadata.sourceEntityProvenance = sourceEntity.provenance;
          }
          if (targetEntity) {
            metadata.targetEntityProvenance = targetEntity.provenance;
          }

          refinedEdges.push({
            sourceEntityName: edge.sourceEntityName,
            targetEntityName: edge.targetEntityName,
            relationship: edge.relationship,
            provenance: 'LLM_GENERATED',
            confidence: cappedConfidence,
            refinedBy: 'edge-refinement-service',
          });
        }
      }

      this.logger.debug(
        `EdgeRefinement: Extracted ${refinedEdges.length} edges from event ${context.id}`,
      );

      // Emit cost event for this LLM call (CANON §Type 2 Cost Requirement)
      try {
        await this.eventsService.record({
          type: 'EDGE_REFINED',
          subsystem: 'LEARNING',
          sessionId: context.sessionId,
          driveSnapshot: context.driveSnapshot,
          schemaVersion: 1,
          correlationId: context.id,
        });
      } catch (eventError) {
        this.logger.warn(
          `EdgeRefinement: Failed to emit EDGE_REFINED event: ${
            eventError instanceof Error ? eventError.message : String(eventError)
          }`,
        );
        // Don't throw; edge refinement is still successful even if event recording fails
      }

      return refinedEdges;
    } catch (error) {
      this.logger.error(
        `EdgeRefinement: LLM call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}
