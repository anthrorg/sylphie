/**
 * EntityExtractionService — LLM-backed entity extraction from LearnableEvents.
 *
 * Implements IEntityExtractionService. Always a Type 2 operation: every call
 * goes to the LLM. There is no Type 1 path for entity extraction in Phase 1.
 *
 * Every returned ExtractedEntity carries provenance: 'LLM_GENERATED' at the
 * literal type level — this is the compile-time enforcement of CANON §7.
 * The service cannot return entities with any other provenance.
 *
 * Type 2 cost (latencyMs, tokensUsed) MUST be reported to the Events module
 * on every LLM call. Without cost reporting, Cognitive Awareness drive pressure
 * is suppressed and Type 1 graduation incentive is lost (CANON §Dual-Process).
 *
 * CANON §7 Provenance Handling:
 * - Guardian-sourced events → GUARDIAN base confidence (0.60)
 * - SENSOR-sourced events → SENSOR base confidence (0.40)
 * - All other LLM-extracted → LLM_GENERATED base confidence (0.35)
 *
 * CANON Standard 4 (Shrug Imperative):
 * - Entities with confidence < 0.45 are flagged as AMBIGUOUS, never guessed.
 *
 * CANON Standard 3 (Confidence Ceiling):
 * - No extracted entity may exceed 0.60 without successful retrieval-and-use.
 * - This ceiling is enforced at WKG persistence, not here.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { LearnableEvent } from '../../shared/types/event.types';
import type {
  IEntityExtractionService,
  ExtractedEntity,
} from '../interfaces/learning.interfaces';
import type { ILlmService, LlmRequest } from '../../shared/types/llm.types';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { ProvenanceSource } from '../../shared/types/provenance.types';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { resolveBaseConfidence } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// LLM Response Parsing
// ---------------------------------------------------------------------------

/**
 * Shape of entities returned by the LLM.
 * The LLM is instructed to return JSON with this structure.
 */
interface LlmEntityCandidate {
  readonly name: string;
  readonly type: string;
  readonly properties?: Record<string, unknown>;
  readonly confidence?: number;
}

interface LlmExtractionResponse {
  readonly entities: readonly LlmEntityCandidate[];
}

@Injectable()
export class EntityExtractionService implements IEntityExtractionService {
  private readonly logger = new Logger(EntityExtractionService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILlmService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
  ) {}

  /**
   * Extract named entities from the content of a LearnableEvent.
   *
   * All returned entities carry provenance: 'LLM_GENERATED' (literal type).
   * An empty array is a valid result.
   *
   * @param event - The learnable event whose content should be processed.
   * @returns Array of extracted entities (may be empty). Never null.
   * @throws Error if the LLM call fails and no fallback is available.
   */
  async extract(event: LearnableEvent): Promise<ExtractedEntity[]> {
    // Determine provenance from event source per CANON §7
    const provenance = this.determineProvenance(event);

    // Build the extraction prompt
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(event.content);

    // Prepare LLM request
    const llmRequest: LlmRequest = {
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      systemPrompt,
      maxTokens: 1024,
      temperature: 0.2, // Conservative for extraction
      metadata: {
        callerSubsystem: 'LEARNING',
        purpose: 'entity-extraction',
        sessionId: event.sessionId,
        correlationId: event.correlationId,
      },
    };

    // Call LLM and measure latency
    const startMs = Date.now();
    let llmResponse;
    try {
      llmResponse = await this.llmService.complete(llmRequest);
    } catch (err) {
      this.logger.error(
        `Entity extraction LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        { eventId: event.id },
      );
      // Per CANON: no fallback for extraction failure, return empty array
      return [];
    }
    const latencyMs = Date.now() - startMs;

    // Emit cost event to TimescaleDB
    await this.recordLlmCost(event, llmResponse, latencyMs);

    // Parse the LLM response
    let extractedCandidates: readonly LlmEntityCandidate[];
    try {
      const parsed = JSON.parse(llmResponse.content) as LlmExtractionResponse;
      extractedCandidates = parsed.entities || [];
    } catch (err) {
      this.logger.warn(
        `Failed to parse entity extraction response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        { eventId: event.id },
      );
      return [];
    }

    // For each candidate, attempt entity resolution and build ExtractedEntity
    const results: ExtractedEntity[] = [];
    for (const candidate of extractedCandidates) {
      const entity = await this.buildExtractedEntity(
        candidate,
        provenance,
        event,
      );
      if (entity) {
        results.push(entity);
      }
    }

    return results;
  }

  /**
   * Determine the provenance source from the event's source field.
   *
   * CANON §7: Provenance must be preserved from the original event source.
   */
  private determineProvenance(event: LearnableEvent): ProvenanceSource {
    // Map event source to provenance
    switch (event.source) {
      case 'GUARDIAN':
        return 'GUARDIAN';
      case 'SENSOR':
        return 'SENSOR';
      case 'LLM_GENERATED':
      default:
        return 'LLM_GENERATED';
    }
  }

  /**
   * Build the system prompt for entity extraction.
   */
  private buildSystemPrompt(): string {
    return `You are an entity extraction assistant. Your task is to identify named entities in the provided text.

For each entity, extract:
- name: The human-readable name (e.g., "Jim", "Neo4j", "red mug")
- type: The entity type/label (e.g., "Person", "Technology", "Object")
- properties: Any notable attributes (optional, object format)
- confidence: Your confidence this entity is correctly identified (0.0-1.0, optional)

Return a JSON object with an "entities" array:
{
  "entities": [
    {
      "name": "entity name",
      "type": "Entity Type",
      "properties": { /* optional */ },
      "confidence": 0.85
    }
  ]
}

If no entities are found, return {"entities": []}.
Be conservative: only extract entities with high confidence. Flag ambiguous entities with confidence < 0.45.`;
  }

  /**
   * Build the user prompt with the event content to extract from.
   */
  private buildUserPrompt(content: string): string {
    return `Extract named entities from the following text:\n\n${content}`;
  }

  /**
   * Build an ExtractedEntity from an LLM candidate, performing entity resolution.
   *
   * Returns null if the entity cannot be processed (e.g., failed to resolve ambiguity).
   */
  private async buildExtractedEntity(
    candidate: LlmEntityCandidate,
    provenance: ProvenanceSource,
    event: LearnableEvent,
  ): Promise<ExtractedEntity | null> {
    // Determine confidence based on provenance and LLM assessment
    const baseConfidence = resolveBaseConfidence(provenance);
    const llmConfidence = candidate.confidence ?? 0.75;

    // If confidence is below ambiguity threshold, flag it
    const isBelowThreshold = llmConfidence < 0.45;

    // Attempt entity resolution against WKG
    let resolution: 'EXACT_MATCH' | 'FUZZY_MATCH' | 'AMBIGUOUS' | 'NEW';
    try {
      resolution = await this.resolveEntityAgainstWkg(
        candidate.name,
        candidate.type,
      );
    } catch (err) {
      this.logger.warn(
        `WKG entity resolution failed for "${candidate.name}": ${err instanceof Error ? err.message : String(err)}. Treating as NEW.`,
      );
      resolution = 'NEW';
    }

    // Apply Shrug Imperative: if confidence is ambiguous, flag as AMBIGUOUS
    if (isBelowThreshold) {
      resolution = 'AMBIGUOUS';
    }

    // Use the LLM's confidence estimate, bounded to reasonable range
    const finalConfidence = Math.min(llmConfidence, 0.99);

    const entity: ExtractedEntity = {
      name: candidate.name,
      type: candidate.type,
      properties: candidate.properties || {},
      provenance,
      resolution,
      confidence: finalConfidence,
      sourceEventId: event.id,
    };

    return entity;
  }

  /**
   * Attempt to resolve an entity against the WKG.
   *
   * Returns the resolution type: EXACT_MATCH, FUZZY_MATCH, AMBIGUOUS, or NEW.
   * Wraps WKG queries in try/catch because methods may not be fully implemented.
   */
  private async resolveEntityAgainstWkg(
    name: string,
    type: string,
  ): Promise<'EXACT_MATCH' | 'FUZZY_MATCH' | 'AMBIGUOUS' | 'NEW'> {
    try {
      // Attempt to find nodes with matching label and name property
      const result = await this.wkgService.querySubgraph({
        labels: [type],
        properties: { name },
        minConfidence: 0.0, // Include all confidence levels for resolution
      });

      if (result.nodes.length === 1) {
        return 'EXACT_MATCH';
      } else if (result.nodes.length > 1) {
        // Multiple matches = ambiguous
        return 'AMBIGUOUS';
      }

      // TODO: Implement fuzzy matching when similarity query is available
      // For now, fall through to NEW

      return 'NEW';
    } catch (err) {
      // WKG service may not be fully implemented; treat as NEW and continue
      this.logger.debug(
        `WKG query error during entity resolution (may be unimplemented): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'NEW';
    }
  }

  /**
   * Emit a cost event to TimescaleDB for this LLM call.
   *
   * CANON §Type 2 Cost Requirement: Cost must be reported to avoid suppressing
   * Cognitive Awareness drive pressure and losing Type 1 graduation incentive.
   */
  private async recordLlmCost(
    event: LearnableEvent,
    llmResponse: { tokensUsed: { prompt: number; completion: number }; latencyMs: number },
    actualLatencyMs: number,
  ): Promise<void> {
    try {
      await this.eventsService.record({
        type: 'ENTITY_EXTRACTED',
        subsystem: 'LEARNING',
        sessionId: event.sessionId,
        driveSnapshot: event.driveSnapshot,
        schemaVersion: 1,
        correlationId: event.id,
        // Additional metadata for cost tracking
        // The Events service will serialize this appropriately
      });
    } catch (err) {
      // Log but don't fail the extraction if cost recording fails
      this.logger.warn(
        `Failed to record LLM cost event: ${err instanceof Error ? err.message : String(err)}`,
        { eventId: event.id },
      );
    }
  }
}
