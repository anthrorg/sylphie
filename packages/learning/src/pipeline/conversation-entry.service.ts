/**
 * ConversationEntryService — Step 5 of the Learning maintenance cycle.
 *
 * Creates a :Conversation node in Neo4j WORLD for each processed event and
 * links it to the entities extracted in Step 3 via MENTIONS edges.
 *
 * The Conversation node is a temporal anchor: it records the raw content
 * (truncated to 500 chars), the originating event id, and the timestamp.
 * This makes the WKG queryable by time as well as by concept.
 *
 * Provenance is always SENSOR (0.40) because the Conversation node directly
 * represents a sensor observation — the user said something and we recorded it.
 *
 * MENTIONS edges carry no confidence or provenance of their own: they are
 * structural links derived from the entity extraction step. If the entity
 * extraction was SENSOR, the structural link inherits that trust transitively.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Neo4jService, Neo4jInstanceName, verboseFor } from '@sylphie/shared';
import type {
  IConversationEntryService,
  UnlearnedEvent,
  ExtractedEntity,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters stored in the Conversation node's content property. */
const MAX_CONTENT_CHARS = 500;

/** Provenance and confidence for Conversation nodes. */
const CONV_PROVENANCE = 'SENSOR' as const;
const CONV_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// ConversationEntryService
// ---------------------------------------------------------------------------

@Injectable()
export class ConversationEntryService implements IConversationEntryService {
  private readonly logger = new Logger(ConversationEntryService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IConversationEntryService
  // ---------------------------------------------------------------------------

  async createEntry(
    event: UnlearnedEvent,
    entities: ExtractedEntity[],
  ): Promise<string> {

    const convNodeId = `conv-${randomUUID().substring(0, 8)}`;
    const content = extractContent(event);
    const label = `conv:${event.id.substring(0, 8)}`;

    const created = await this.createConversationNode(
      convNodeId,
      label,
      content,
      event,
    );

    if (!created) {
      vlog('createEntry: conversation node creation failed', { eventId: event.id });
      return '';
    }

    // Write MENTIONS edges for each entity that was successfully upserted.
    const validEntities = entities.filter((e) => !!e.nodeId);
    await this.writeMentionsEdges(convNodeId, validEntities);

    vlog('conversation entry created', {
      eventId: event.id,
      convNodeId,
      entityLinks: validEntities.map((e) => ({ label: e.label, nodeId: e.nodeId })),
      mentionsCount: validEntities.length,
    });

    this.logger.debug(
      `ConversationEntry: created ${convNodeId} with ${validEntities.length} MENTIONS edges`,
    );
    return convNodeId;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async createConversationNode(
    nodeId: string,
    label: string,
    content: string,
    event: UnlearnedEvent,
  ): Promise<boolean> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      await session.run(
        `CREATE (c:Conversation {
           node_id:        $nodeId,
           label:          $label,
           content:        $content,
           event_id:       $eventId,
           timestamp:      datetime($timestamp),
           event_type:     $eventType,
           session_id:     $sessionId,
           provenance_type: $provenance,
           confidence:     $confidence,
           schema_level:   'instance',
           created_at:     datetime()
         })`,
        {
          nodeId,
          label,
          content: content.substring(0, MAX_CONTENT_CHARS),
          eventId: event.id,
          timestamp: event.timestamp.toISOString(),
          eventType: event.type,
          sessionId: event.session_id,
          provenance: CONV_PROVENANCE,
          confidence: CONV_CONFIDENCE,
        },
      );
      return true;
    } catch (err) {
      this.logger.error(
        `createConversationNode failed for event ${event.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    } finally {
      await session.close();
    }
  }

  private async writeMentionsEdges(
    convNodeId: string,
    entities: ExtractedEntity[],
  ): Promise<void> {
    if (entities.length === 0) return;

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      for (const entity of entities) {
        try {
          await session.run(
            `MATCH (c:Conversation {node_id: $convId}), (e {node_id: $entityId})
             MERGE (c)-[:MENTIONS]->(e)`,
            { convId: convNodeId, entityId: entity.nodeId },
          );
        } catch (err) {
          this.logger.warn(
            `MENTIONS edge failed (conv ${convNodeId} -> entity ${entity.nodeId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function extractContent(event: UnlearnedEvent): string {
  const payload = event.payload;
  if (typeof payload['content'] === 'string') return payload['content'];
  if (typeof payload['text'] === 'string') return payload['text'];
  return `[${event.type} event — no text content]`;
}
