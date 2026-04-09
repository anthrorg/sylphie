/**
 * CanProduceEdgesService — Step 6 of the Learning maintenance cycle.
 *
 * Extracts significant multi-word phrases from event content, MERGEs Word nodes
 * in Neo4j WORLD, and creates CAN_PRODUCE edges from the Conversation node to
 * those Word nodes.
 *
 * "Significant phrase" definition: two or more consecutive words, each at least
 * 3 characters long. Single-word entries are skipped because individual words
 * are too common to be meaningful anchors for phrase learning.
 *
 * CAN_PRODUCE semantics (CANON §Subsystem 3): these edges represent Sylphie's
 * capacity to produce a phrase — they are not observations about the world but
 * about Sylphie's own linguistic repertoire. The edge connects a temporal anchor
 * (Conversation) to a linguistic capability (Word/Phrase).
 *
 * Provenance for Word nodes: LLM_GENERATED — the phrase was produced by the LLM
 * (or user input that we are treating as a candidate phrase). Confidence starts
 * at 0.35.
 *
 * CAN_PRODUCE edges use INFERENCE provenance (0.30) because we are inferring from
 * co-occurrence that Sylphie can produce the phrase — we have not directly
 * observed a positive outcome yet.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Neo4jService, Neo4jInstanceName, verboseFor } from '@sylphie/shared';
import type { ICanProduceEdgesService, UnlearnedEvent } from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum word length for a token to count toward a significant phrase. */
const MIN_TOKEN_LENGTH = 3;

/** Minimum number of tokens in a phrase for it to be considered significant. */
const MIN_PHRASE_TOKENS = 2;

/** Maximum number of phrases to process per event (prevents runaway writes). */
const MAX_PHRASES_PER_EVENT = 15;

/** Provenance for Word nodes. */
const WORD_PROVENANCE = 'LLM_GENERATED' as const;
const WORD_CONFIDENCE = 0.35;

/** Provenance for CAN_PRODUCE edges. */
const CAN_PRODUCE_PROVENANCE = 'INFERENCE' as const;
const CAN_PRODUCE_CONFIDENCE = 0.30;

// ---------------------------------------------------------------------------
// CanProduceEdgesService
// ---------------------------------------------------------------------------

@Injectable()
export class CanProduceEdgesService implements ICanProduceEdgesService {
  private readonly logger = new Logger(CanProduceEdgesService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // ICanProduceEdgesService
  // ---------------------------------------------------------------------------

  async createEdges(
    conversationNodeId: string,
    event: UnlearnedEvent,
  ): Promise<number> {
    if (!conversationNodeId) return 0;

    const content = extractContent(event);
    if (!content) return 0;

    const phrases = extractSignificantPhrases(content);
    if (phrases.length === 0) return 0;

    vlog('canProduceEdges: phrases extracted', {
      conversationNodeId,
      eventId: event.id,
      phraseCount: phrases.length,
      phrases,
    });

    let created = 0;

    for (const phrase of phrases) {
      const wordNodeId = await this.mergeWordNode(phrase);
      if (!wordNodeId) continue;

      const edgeCreated = await this.mergeCanProduceEdge(conversationNodeId, phrase, wordNodeId);
      if (edgeCreated) created++;
    }

    vlog('canProduceEdges complete', {
      conversationNodeId,
      eventId: event.id,
      canProduceEdgesCreated: created,
    });

    this.logger.debug(
      `CanProduceEdges: conv ${conversationNodeId} → ${created} CAN_PRODUCE edges`,
    );
    return created;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async mergeWordNode(phrase: string): Promise<string> {
    const nodeId = `word-${randomUUID().substring(0, 8)}`;
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      const result = await session.run(
        `MERGE (w:Word {label: $label})
         ON CREATE SET
           w.node_id        = $nodeId,
           w.node_type      = 'Word',
           w.schema_level   = 'instance',
           w.provenance_type = $provenance,
           w.confidence     = $confidence,
           w.created_at     = datetime()
         ON MATCH SET
           w.confidence = CASE WHEN $confidence > w.confidence
                               THEN $confidence
                               ELSE w.confidence END,
           w.updated_at = datetime()
         RETURN w.node_id AS nodeId`,
        {
          label: phrase,
          nodeId,
          provenance: WORD_PROVENANCE,
          confidence: WORD_CONFIDENCE,
        },
      );

      const record = result.records[0];
      return record ? (record.get('nodeId') as string) : nodeId;
    } catch (err) {
      this.logger.warn(
        `mergeWordNode failed for phrase "${phrase}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
    } finally {
      await session.close();
    }
  }

  private async mergeCanProduceEdge(
    convNodeId: string,
    phraseLabel: string,
    _wordNodeId: string,
  ): Promise<boolean> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      await session.run(
        `MATCH (c:Conversation {node_id: $convId}), (w:Word {label: $label})
         MERGE (c)-[r:CAN_PRODUCE]->(w)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.created_at      = datetime()
         ON MATCH SET
           r.updated_at = datetime()`,
        {
          convId: convNodeId,
          label: phraseLabel,
          confidence: CAN_PRODUCE_CONFIDENCE,
          provenance: CAN_PRODUCE_PROVENANCE,
        },
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `mergeCanProduceEdge failed (${convNodeId} → "${phraseLabel}"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function extractContent(event: UnlearnedEvent): string | null {
  const payload = event.payload;
  if (typeof payload['content'] === 'string') return payload['content'];
  if (typeof payload['text'] === 'string') return payload['text'];
  return null;
}

/**
 * Extract multi-word phrases from text.
 *
 * Sliding-window approach: for each position in the token list, yield
 * window-2 and window-3 phrases where all tokens meet the length threshold.
 * This keeps the phrase space manageable while capturing bigrams and trigrams.
 */
function extractSignificantPhrases(text: string): string[] {
  const tokens = text
    .replace(/[.,!?;:'"()\[\]]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);

  if (tokens.length < MIN_PHRASE_TOKENS) return [];

  const seen = new Set<string>();
  const phrases: string[] = [];

  for (let i = 0; i <= tokens.length - MIN_PHRASE_TOKENS; i++) {
    // Bigram
    const bigram = tokens.slice(i, i + 2).join(' ');
    if (!seen.has(bigram)) {
      seen.add(bigram);
      phrases.push(bigram);
    }

    // Trigram (only when there are enough tokens)
    if (i + 3 <= tokens.length) {
      const trigram = tokens.slice(i, i + 3).join(' ');
      if (!seen.has(trigram)) {
        seen.add(trigram);
        phrases.push(trigram);
      }
    }

    if (phrases.length >= MAX_PHRASES_PER_EVENT) break;
  }

  return phrases;
}
