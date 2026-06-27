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
 * Wave 3 / C3 — three-graph isolation (CANON Std-3 §2.8 person-fact WKG leak):
 *   Conversation-derived proper nouns (SENSOR provenance — INPUT_RECEIVED /
 *   INPUT_PARSED) are NO LONGER minted as live `:Entity`. They are minted as
 *   `:Candidate` nodes in the WORLD graph instead:
 *     - provenance_type = 'CANDIDATE'           (CANDIDATE_PROVENANCE_TYPE)
 *     - confidence      = min(base, 0.60)        (CANDIDATE_CONFIDENCE_CAP)
 *     - grounding_person_id = <speakerId>        (CANDIDATE_PERSON_ID_PROP)
 *   `:Candidate` is excluded from every WKG grounding read-path (C0), so a
 *   conversation-introduced proper noun can never produce a GROUNDED label for
 *   a DIFFERENT speaker. A guardian promotion (`:Candidate → :Entity`, C4) is the
 *   only path to groundable status.
 *
 *   Guardian-taught entities (GUARDIAN_CORRECTION / GUARDIAN_CONFIRMATION) keep
 *   minting as live `:Entity` — they are guardian-confirmed, not a leak.
 *
 *   `speakerId` is read off `event.payload['speakerId']` (= PostgreSQL User.id;
 *   threaded onto INPUT events by C2). When absent (no known speaker) the
 *   candidate is still minted but with a null `grounding_person_id`.
 *
 * MERGE pattern matches wkg-context.service.ts:writeEntity():
 *   ON CREATE: full property set
 *   ON MATCH:  confidence only increases, updated_at refreshed
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Session } from 'neo4j-driver';
import {
  Neo4jService,
  Neo4jInstanceName,
  resolveBaseConfidence,
  verboseFor,
  CANDIDATE_PROVENANCE_TYPE,
  CANDIDATE_NODE_LABEL,
  CANDIDATE_CONFIDENCE_CAP,
  CANDIDATE_PERSON_ID_PROP,
  type ProvenanceSource,
} from '@sylphie/shared';
import type {
  IUpsertEntitiesService,
  UnlearnedEvent,
  ExtractedEntity,
} from '../interfaces/learning.interfaces';
import { withTimeout } from '../util/llm-timeout';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entities to extract from a single event. */
const MAX_ENTITIES_PER_EVENT = 20;

/**
 * Maximum time (ms) a single Neo4j MERGE is allowed to run.
 *
 * At cold boot, Neo4j may hold a DDL schema lock while building indexes.
 * Without a deadline the MERGE blocks indefinitely, keeping `cycleInFlight`
 * true forever and silently killing all subsequent maintenance cycles.
 * 12 s is generous for a fast MERGE while remaining well inside the 60 s
 * cycle interval. On timeout `withTimeout` rejects; the per-label try/catch
 * in `mergeEntityNode` / `mergeCandidateNode` catches it, logs a warning,
 * and returns '' — the same graceful-skip path used for any other Neo4j error.
 */
const NEO4J_MERGE_TIMEOUT_MS = 12_000;

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

    // Wave 3 / C3: a SENSOR-provenance entity (conversation-derived proper noun)
    // is staged as a `:Candidate`, not a live `:Entity`. Guardian-taught entities
    // remain live `:Entity`. The candidate is person-scoped to the speaker so a
    // later guardian promotion / OKG cross-check can attribute it (and so it can
    // never ground a label for a DIFFERENT speaker — §2.8 isolation).
    const asCandidate = provenance === 'SENSOR';
    const effectiveProvenance: ProvenanceSource = asCandidate
      ? CANDIDATE_PROVENANCE_TYPE
      : provenance;
    const confidence = asCandidate
      ? Math.min(CANDIDATE_CONFIDENCE_CAP, resolveBaseConfidence(CANDIDATE_PROVENANCE_TYPE))
      : resolveBaseConfidence(provenance);
    const speakerId = asCandidate ? extractSpeakerId(event) : undefined;

    vlog('upsertEntities: extracting entities', {
      eventId: event.id,
      eventType: event.type,
      labels,
      provenance: effectiveProvenance,
      confidence,
      asCandidate,
      speakerId: speakerId ?? null,
    });

    const results: ExtractedEntity[] = [];
    let created = 0;
    let updated = 0;

    // Open a single WRITE session and reuse it for every entity label in this
    // event, instead of opening/closing a fresh session per label. With up to
    // MAX_ENTITIES_PER_EVENT (20) labels per event and up to 5 events per
    // maintenance cycle, this cuts ~100 session checkout/teardown round-trips
    // down to one per event. Per-entity error isolation is preserved inside
    // mergeEntityNode: one failing label does not abort the rest.
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      for (const label of labels) {
        const nodeId = await this.mergeEntityNode(
          session,
          label,
          effectiveProvenance,
          confidence,
          asCandidate,
          speakerId,
        );
        if (nodeId) {
          // Distinguish created vs updated by checking if nodeId matches the generated prefix.
          if (nodeId.startsWith('entity-') || nodeId.startsWith('candidate-')) {
            created++;
          } else {
            updated++;
          }
          results.push({
            nodeId,
            label,
            provenance: effectiveProvenance,
            confidence,
            isCandidate: asCandidate,
            groundingPersonId: speakerId,
          });
          vlog('entity upserted', {
            eventId: event.id,
            label,
            nodeId,
            provenance: effectiveProvenance,
            confidence,
            asCandidate,
          });
        }
      }
    } finally {
      await session.close();
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
   * MERGE an entity node into Neo4j WORLD using a caller-provided session.
   *
   * The session is owned and closed by the caller (upsertEntities), so all
   * labels from one event share a single session. Each call is still isolated
   * by its own try/catch: a failed label returns '' and the loop continues.
   *
   * Wave 3 / C3: when `asCandidate` is true the node is minted with the
   * `:Candidate` label (NOT `:Entity`), provenance 'CANDIDATE', a confidence
   * already clamped to ≤0.60 by the caller, and `grounding_person_id` set to the
   * speaker. Crucially the MERGE key is `(:Candidate {label})` so a candidate and
   * a live `:Entity` of the same name never collapse into one node — that would
   * silently re-promote a candidate to groundable. The two labels are disjoint by
   * construction; promotion (C4) is the only bridge between them.
   *
   * Returns the node_id of the created or matched node. Returns an empty string
   * if Neo4j is unavailable or the query fails.
   */
  private async mergeEntityNode(
    session: Session,
    label: string,
    provenance: ProvenanceSource,
    confidence: number,
    asCandidate: boolean,
    speakerId: string | undefined,
  ): Promise<string> {
    if (asCandidate) {
      return this.mergeCandidateNode(session, label, confidence, speakerId);
    }

    const nodeId = `entity-${randomUUID().substring(0, 8)}`;

    try {
      const result = await withTimeout(
        session.run(
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
        ),
        NEO4J_MERGE_TIMEOUT_MS,
        `mergeEntityNode(${label})`,
      );

      // If MERGE matched an existing node, return its id; otherwise the one we set.
      const record = result.records[0];
      return record ? (record.get('nodeId') as string) : nodeId;
    } catch (err) {
      this.logger.warn(
        `mergeEntityNode failed for label "${label}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
    }
  }

  /**
   * MERGE a `:Candidate` node — the Wave 3 / C3 staging form for a
   * conversation-derived proper noun (CANON Std-3 §2.8 isolation fix).
   *
   * INVARIANTS enforced here (the C0 contract):
   *   - label              = CANDIDATE_NODE_LABEL (`:Candidate`), NOT `:Entity`.
   *   - provenance_type    = CANDIDATE_PROVENANCE_TYPE ('CANDIDATE').
   *   - confidence         ≤ CANDIDATE_CONFIDENCE_CAP (clamped here defensively
   *                          even though the caller already clamps).
   *   - grounding_person_id = speakerId (CANDIDATE_PERSON_ID_PROP), or null when
   *                          no speaker is known.
   *
   * ON MATCH never lifts confidence above the cap. The node is excluded from all
   * WKG grounding read-paths (C0) so it can never produce a GROUNDED label.
   */
  private async mergeCandidateNode(
    session: Session,
    label: string,
    confidence: number,
    speakerId: string | undefined,
  ): Promise<string> {
    const nodeId = `candidate-${randomUUID().substring(0, 8)}`;
    const cappedConfidence = Math.min(CANDIDATE_CONFIDENCE_CAP, confidence);

    try {
      const result = await withTimeout(
        session.run(
          `MERGE (n:${CANDIDATE_NODE_LABEL} {label: $label})
           ON CREATE SET
             n.node_id          = $nodeId,
             n.node_type        = $nodeLabel,
             n.schema_level     = 'instance',
             n.provenance_type  = $provenance,
             n.confidence       = $confidence,
             n.${CANDIDATE_PERSON_ID_PROP} = $speakerId,
             n.created_at       = datetime()
           ON MATCH SET
             n.confidence = CASE
                              WHEN $confidence > n.confidence AND $confidence <= $cap
                              THEN $confidence
                              ELSE n.confidence
                            END,
             n.${CANDIDATE_PERSON_ID_PROP} =
               coalesce(n.${CANDIDATE_PERSON_ID_PROP}, $speakerId),
             n.updated_at = datetime()
           RETURN n.node_id AS nodeId`,
          {
            label,
            nodeId,
            nodeLabel: CANDIDATE_NODE_LABEL,
            provenance: CANDIDATE_PROVENANCE_TYPE,
            confidence: cappedConfidence,
            cap: CANDIDATE_CONFIDENCE_CAP,
            speakerId: speakerId ?? null,
          },
        ),
        NEO4J_MERGE_TIMEOUT_MS,
        `mergeCandidateNode(${label})`,
      );

      const record = result.records[0];
      return record ? (record.get('nodeId') as string) : nodeId;
    } catch (err) {
      this.logger.warn(
        `mergeCandidateNode failed for label "${label}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
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
 * Wave 3 / C3 — read the speaker id (PostgreSQL User.id) off the event payload.
 *
 * C2 threads `payload.speakerId` onto INPUT_RECEIVED / INPUT_PARSED events. It is
 * the `grounding_person_id` a conversation-derived `:Candidate` is scoped to.
 * Returns undefined when absent or not a non-empty string (e.g. an internal event
 * with no known speaker) — the candidate is still minted, just unscoped.
 */
function extractSpeakerId(event: UnlearnedEvent): string | undefined {
  const raw = event.payload['speakerId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
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
