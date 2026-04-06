/**
 * UpsertEntitiesService — Step 3 of the Learning maintenance cycle.
 *
 * Extracts entity names from an unlearned event and MERGEs them into the
 * Neo4j WORLD knowledge graph.
 *
 * Entity extraction uses the same title-cased token pattern as
 * CommunicationService.extractEntities() and WkgContextService.extractEntityNames():
 * words that begin with a capital letter and are longer than 1 character.
 *
 * For INPUT_RECEIVED events the text is in payload.content.
 * For INPUT_PARSED events the entity list is already in payload.entities (string[]).
 *
 * Provenance assignment (CANON §Provenance Is Sacred):
 *   INPUT_RECEIVED  → SENSOR   (raw sensor observation)
 *   INPUT_PARSED    → SENSOR   (derived from sensor input, no guardian involvement)
 *   GUARDIAN_*      → GUARDIAN (explicit guardian teaching / correction)
 *
 * MERGE pattern matches wkg-context.service.ts:writeEntity():
 *   ON CREATE: full property set
 *   ON MATCH:  confidence only increases, updated_at refreshed
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Neo4jService,
  Neo4jInstanceName,
  resolveBaseConfidence,
  type ProvenanceSource,
} from '@sylphie/shared';
import type {
  IUpsertEntitiesService,
  UnlearnedEvent,
  ExtractedEntity,
} from '../interfaces/learning.interfaces';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entities to extract from a single event. */
const MAX_ENTITIES_PER_EVENT = 20;

// ---------------------------------------------------------------------------
// UpsertEntitiesService
// ---------------------------------------------------------------------------

@Injectable()
export class UpsertEntitiesService implements IUpsertEntitiesService {
  private readonly logger = new Logger(UpsertEntitiesService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IUpsertEntitiesService
  // ---------------------------------------------------------------------------

  async upsertEntities(event: UnlearnedEvent): Promise<ExtractedEntity[]> {
    const labels = extractEntityLabels(event);
    if (labels.length === 0) return [];

    const provenance = resolveProvenance(event);
    const confidence = resolveBaseConfidence(provenance);

    const results: ExtractedEntity[] = [];

    for (const label of labels) {
      const nodeId = await this.mergeEntityNode(label, provenance, confidence);
      if (nodeId) {
        results.push({ nodeId, label, provenance, confidence });
      }
    }

    this.logger.debug(
      `UpsertEntities: event ${event.id} → ${results.length} entities upserted`,
    );
    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * MERGE an entity node into Neo4j WORLD.
   *
   * Returns the node_id of the created or matched node. Returns an empty string
   * if Neo4j is unavailable or the query fails.
   */
  private async mergeEntityNode(
    label: string,
    provenance: ProvenanceSource,
    confidence: number,
  ): Promise<string> {
    const nodeId = `entity-${randomUUID().substring(0, 8)}`;
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      const result = await session.run(
        `MERGE (n {label: $label})
         ON CREATE SET
           n.node_id       = $nodeId,
           n.node_type     = 'Entity',
           n.schema_level  = 'instance',
           n.provenance_type = $provenance,
           n.confidence    = $confidence,
           n.created_at    = datetime()
         ON MATCH SET
           n.confidence    = CASE WHEN $confidence > n.confidence
                                  THEN $confidence
                                  ELSE n.confidence END,
           n.updated_at    = datetime()
         RETURN n.node_id AS nodeId`,
        { label, nodeId, provenance, confidence },
      );

      // If MERGE matched an existing node, return its id; otherwise the one we set.
      const record = result.records[0];
      return record ? (record.get('nodeId') as string) : nodeId;
    } catch (err) {
      this.logger.error(
        `mergeEntityNode failed for label "${label}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Determine the provenance source for entities from a given event type.
 *
 * CANON §Provenance Is Sacred: the provenance reflects the epistemic origin
 * of the knowledge — not the current subsystem. Guardian feedback events carry
 * GUARDIAN provenance even though they arrive through Communication.
 */
function resolveProvenance(event: UnlearnedEvent): ProvenanceSource {
  if (
    event.type === 'GUARDIAN_CORRECTION' ||
    event.type === 'GUARDIAN_CONFIRMATION'
  ) {
    return 'GUARDIAN';
  }
  // INPUT_RECEIVED and INPUT_PARSED both originate from sensor (user text).
  return 'SENSOR';
}

/**
 * Extract unique entity labels from an unlearned event.
 *
 * For INPUT_PARSED: the payload already contains a parsed entities array —
 * use it directly to avoid double-parsing.
 *
 * For INPUT_RECEIVED and all other types: extract from payload.content using
 * the title-cased token heuristic.
 */
function extractEntityLabels(event: UnlearnedEvent): string[] {
  // Fast path: INPUT_PARSED carries pre-extracted entities.
  if (event.type === 'INPUT_PARSED') {
    const entities = event.payload['entities'];
    if (Array.isArray(entities)) {
      return (entities as unknown[])
        .filter((e): e is string => typeof e === 'string' && e.length > 1)
        .slice(0, MAX_ENTITIES_PER_EVENT);
    }
  }

  // General path: extract from raw content.
  const content = extractContent(event);
  if (!content) return [];

  return extractTitleCasedTokens(content).slice(0, MAX_ENTITIES_PER_EVENT);
}

/**
 * Pull the text content from a variety of event payload shapes.
 */
function extractContent(event: UnlearnedEvent): string | null {
  const payload = event.payload;

  if (typeof payload['content'] === 'string') {
    return payload['content'];
  }
  if (typeof payload['text'] === 'string') {
    return payload['text'];
  }
  return null;
}

/**
 * Extract title-cased tokens from free text (proper noun heuristic).
 *
 * Matches words that:
 *   - Start with an uppercase letter
 *   - Are longer than 1 character
 *   - Are not all-caps abbreviations (those tend to be noise)
 *
 * Strips punctuation before checking.
 */
function extractTitleCasedTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const word of text.split(/\s+/)) {
    const clean = word.replace(/[.,!?;:'"()\[\]]/g, '');
    if (
      clean.length > 1 &&
      /^[A-Z]/.test(clean) &&
      !/^[A-Z]+$/.test(clean)   // exclude ALL_CAPS abbreviations
    ) {
      if (!seen.has(clean)) {
        seen.add(clean);
        tokens.push(clean);
      }
    }
  }

  return tokens;
}
