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
  verboseFor,
  type ProvenanceSource,
} from '@sylphie/shared';
import type {
  IUpsertEntitiesService,
  UnlearnedEvent,
  ExtractedEntity,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

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
    if (labels.length === 0) {
      vlog('upsertEntities: no entity labels found', { eventId: event.id, eventType: event.type });
      return [];
    }

    const provenance = resolveProvenance(event);
    const confidence = resolveBaseConfidence(provenance);

    vlog('upsertEntities: extracting entities', {
      eventId: event.id,
      eventType: event.type,
      labels,
      provenance,
      confidence,
    });

    const results: ExtractedEntity[] = [];
    let created = 0;
    let updated = 0;

    for (const label of labels) {
      const nodeId = await this.mergeEntityNode(label, provenance, confidence);
      if (nodeId) {
        // Distinguish created vs updated by checking if nodeId matches the generated UUID prefix.
        if (nodeId.startsWith('entity-')) {
          created++;
        } else {
          updated++;
        }
        results.push({ nodeId, label, provenance, confidence });
        vlog('entity upserted', { eventId: event.id, label, nodeId, provenance, confidence });
      }
    }

    vlog('upsertEntities complete', {
      eventId: event.id,
      total: results.length,
      created,
      updated,
    });

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
        `MERGE (n:Entity {label: $label})
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
 * Common English words that are frequently title-cased at the start of
 * sentences but are not meaningful entities. Filtering these prevents the
 * WKG from accumulating noise like "The", "This", "What", etc.
 */
const STOPWORDS = new Set([
  // Determiners & pronouns
  'the', 'this', 'that', 'these', 'those', 'its', 'his', 'her', 'our',
  'your', 'their', 'my', 'she', 'he', 'they', 'we', 'it',
  // Question words & conjunctions
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'and', 'but',
  'or', 'so', 'if', 'because', 'since', 'while', 'although', 'unless',
  // Common sentence-initial adverbs & filler
  'here', 'there', 'then', 'now', 'just', 'also', 'only', 'even',
  'still', 'already', 'yet', 'very', 'really', 'actually', 'perhaps',
  'maybe', 'well', 'sure', 'okay', 'yes', 'yeah', 'no', 'not',
  // Prepositions that start sentences
  'about', 'after', 'before', 'during', 'between', 'through', 'above',
  'below', 'into', 'over', 'under', 'from', 'with', 'without',
  // Quantifiers & misc
  'each', 'every', 'some', 'any', 'all', 'both', 'other', 'another',
  'such', 'many', 'more', 'most', 'several', 'few', 'much',
  // Discourse markers
  'please', 'thanks', 'thank', 'sorry', 'hello', 'hey', 'wow',
  // Temporal words (not proper nouns)
  'today', 'tomorrow', 'yesterday', 'later', 'soon', 'never', 'always',
  // Verbs that start sentences
  'can', 'could', 'would', 'should', 'will', 'did', 'does', 'do',
  'has', 'have', 'had', 'was', 'were', 'are', 'is', 'am', 'been',
  'being', 'got', 'get', 'let', 'make', 'take', 'give', 'keep',
  // Additional common words
  'think', 'know', 'want', 'need', 'like', 'said', 'tell', 'told',
  'see', 'look', 'find', 'come', 'went', 'going', 'things', 'something',
  'everything', 'nothing', 'anything', 'someone', 'everyone',
]);

/**
 * Day names, month names, and other temporal/calendar words that appear
 * title-cased but are almost never meaningful entities for the WKG.
 */
const TEMPORAL_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'morning', 'afternoon', 'evening', 'night', 'midnight', 'noon',
  'spring', 'summer', 'autumn', 'fall', 'winter',
]);

/**
 * Extract entity names from free text with compound entity merging.
 *
 * Strategy:
 *   1. Split text into words, clean punctuation.
 *   2. Walk the word list looking for runs of consecutive capitalized words
 *      (e.g. "New York City" → one entity "New York City").
 *   3. Single capitalized words become entities on their own.
 *   4. Stopwords, temporal words, and ALL_CAPS abbreviations are filtered.
 *   5. A single capitalized word at position 0 in a sentence is only kept
 *      if it also appears capitalized elsewhere (not just sentence-initial).
 *
 * This replaces the old extractTitleCasedTokens which treated every
 * capitalized word as an independent entity.
 */
function extractTitleCasedTokens(text: string): string[] {
  // Split into sentences so we can detect sentence-initial words.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const seen = new Set<string>();
  const entities: string[] = [];

  // First pass: collect all capitalized words that appear mid-sentence
  // (these are almost certainly proper nouns, not sentence-initial noise).
  const midSentenceCapitals = new Set<string>();
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const clean = words[i].replace(/[.,!?;:'"()\[\]]/g, '');
      if (clean.length > 1 && /^[A-Z]/.test(clean) && !/^[A-Z]+$/.test(clean)) {
        midSentenceCapitals.add(clean.toLowerCase());
      }
    }
  }

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    let i = 0;

    while (i < words.length) {
      const clean = words[i].replace(/[.,!?;:'"()\[\]]/g, '');

      if (!isEntityCandidate(clean)) {
        i++;
        continue;
      }

      // Sentence-initial word: only keep if it also appears mid-sentence
      // somewhere in the text (confirming it's a proper noun, not just
      // capitalized because it starts a sentence).
      if (i === 0 && !midSentenceCapitals.has(clean.toLowerCase())) {
        i++;
        continue;
      }

      // Try to merge consecutive capitalized words into a compound entity.
      // "New York City" → one entity instead of three fragments.
      const compoundParts = [clean];
      let j = i + 1;
      while (j < words.length) {
        const nextClean = words[j].replace(/[.,!?;:'"()\[\]]/g, '');
        if (isEntityCandidate(nextClean)) {
          compoundParts.push(nextClean);
          j++;
        } else {
          break;
        }
      }

      const entity = compoundParts.join(' ');
      if (!seen.has(entity)) {
        seen.add(entity);
        entities.push(entity);
      }

      i = j;
    }
  }

  return entities;
}

/**
 * Check if a single cleaned word qualifies as an entity candidate.
 * Must be capitalized, > 1 char, not ALL_CAPS, not a stopword, not temporal.
 */
function isEntityCandidate(clean: string): boolean {
  return (
    clean.length > 1 &&
    /^[A-Z]/.test(clean) &&
    !/^[A-Z]+$/.test(clean) &&
    !STOPWORDS.has(clean.toLowerCase()) &&
    !TEMPORAL_WORDS.has(clean.toLowerCase())
  );
}
