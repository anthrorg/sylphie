/**
 * ExtractTypedEdgesService — Structured fact → typed WKG edge pipeline.
 *
 * Before the blind co-occurrence edge step, this service parses the event
 * text for structured (subject, predicate, object) patterns and creates
 * properly typed edges directly. This means "I like coffee" becomes
 * (Jim) -[LIKES]-> (Coffee) immediately, rather than creating a RELATED_TO
 * edge and hoping the refinement step guesses correctly.
 *
 * The typed edges go to BOTH the WKG (WORLD instance) and, for speaker
 * facts, the OKG (OTHER instance) to keep person models consistent.
 *
 * Fact key → edge type mapping:
 *   likes        → LIKES
 *   dislikes     → DISLIKES
 *   occupation   → WORKS_AS
 *   works_at     → WORKS_AT
 *   location     → LIVES_IN
 *   origin       → FROM
 *   name         → NAMED
 *   identity     → IS_A
 *   age          → HAS_AGE
 *   favorite_*   → HAS_FAVORITE
 *   *            → HAS_ATTRIBUTE (fallback for unmapped keys)
 *
 * Patterns reuse the same regex rules as person-model.service.ts
 * extractFactsFromText(), but adapted for WKG entity-to-entity edges
 * rather than Person → Attribute nodes.
 *
 * Returns a set of (sourceId, targetId) pairs that already have typed
 * edges, so the downstream co-occurrence step can skip them.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  verboseFor,
  CANDIDATE_PROVENANCE_TYPE,
  CANDIDATE_NODE_LABEL,
  CANDIDATE_CONFIDENCE_CAP,
  CANDIDATE_PERSON_ID_PROP,
  type ProvenanceSource,
} from '@sylphie/shared';
import type {
  IExtractTypedEdgesService,
  ExtractedEntity,
  ExtractedEdge,
  UnlearnedEvent,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Fact key → edge type mapping
// ---------------------------------------------------------------------------

const FACT_KEY_TO_EDGE_TYPE: ReadonlyMap<string, string> = new Map([
  ['likes', 'LIKES'],
  ['dislikes', 'DISLIKES'],
  ['occupation', 'WORKS_AS'],
  ['works_at', 'WORKS_AT'],
  ['location', 'LIVES_IN'],
  ['origin', 'FROM'],
  ['name', 'NAMED'],
  ['identity', 'IS_A'],
  ['age', 'HAS_AGE'],
]);

/** Prefix match for favorite_* keys. */
const FAVORITE_PREFIX = 'favorite_';

// ---------------------------------------------------------------------------
// Structured fact patterns (adapted from person-model.service.ts)
// ---------------------------------------------------------------------------

interface ParsedTriple {
  /**
   * Who or what the triple is about.
   *
   * - 'speaker'  — first-person statement ("I like X", "my dog is Max").
   * - 'sylphie'  — directed at or about Sylphie ("Sylphie, you are great").
   * - 'world'    — factual statement about a named entity that is neither the
   *               speaker nor Sylphie ("The Eiffel Tower is in Paris").
   *               C3 will branch on this value to route into `:Candidate` staging
   *               instead of a live `:Entity`.
   * - null       — third-person personal statement resolved via _subjectLabel
   *               (existing path, e.g. "Jim likes coffee").
   */
  readonly subjectHint: 'speaker' | 'sylphie' | 'world' | null;
  /** Fact key (maps to edge type). */
  readonly key: string;
  /** The object entity label (the value). */
  readonly objectLabel: string;
  /** Source reliability. */
  readonly source: 'self_reported' | 'observed';
}

// ---------------------------------------------------------------------------
// World-fact subject detection helpers
// ---------------------------------------------------------------------------

/**
 * Syllphie's own name variants used to identify Sylphie-directed statements.
 * Case-insensitive match against these before falling back to 'world'.
 */
const SYLPHIE_NAMES = /\bsylphie\b/i;

/**
 * First-person subject indicators — statements that start with these are
 * speaker facts regardless of what follows.
 */
const FIRST_PERSON_SUBJECT = /^\s*(?:i\b|my\b|i'm\b|i've\b|i'd\b|i'll\b)/i;

/**
 * Copula patterns for world-facts.
 * Matches: "is in", "is at", "is on", "is a", "is the", "is located", "is part of",
 *          "are in", "was in", "were in", "is [adjective]", etc.
 * The full pattern is: [article?] [CapWord(s)] COPULA [rest]
 *
 * Intentionally conservative: we require at least one capitalized word in the
 * subject position so we don't misclassify bare common-noun sentences.
 */
const WORLD_FACT_PATTERN = /^(?:the\s+|a\s+|an\s+)?([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}?)\s+(?:is|are|was|were)\s+(?:in|at|on|a|an|the|located|part\s+of|made\s+of|known\s+as|called|named|founded|built|created|invented|discovered)\s+(.+?)(?:\.|!|\?|,|$)/;

/**
 * Parse structured (subject, predicate, object) triples from text.
 *
 * This is the core extraction logic. Each pattern produces a triple
 * where the predicate becomes the edge type and both subject/object
 * become Entity nodes in the graph.
 */
export function parseTriples(text: string): ParsedTriple[] {
  const triples: ParsedTriple[] = [];
  const lower = text.toLowerCase();

  // ── Speaker patterns ("I ..." → about the speaker) ────────────────

  // "I like/love/enjoy X"
  const likeMatch = lower.match(/\bi (?:like|love|enjoy)\s+(.+?)(?:\.|!|,|$)/);
  if (likeMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'likes',
      objectLabel: capitalize(likeMatch[1].trim()),
      source: 'self_reported',
    });
  }

  // "I dislike/hate/can't stand X"
  const dislikeMatch = lower.match(/\bi (?:dislike|hate|can'?t\s+stand|detest)\s+(.+?)(?:\.|!|,|$)/);
  if (dislikeMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'dislikes',
      objectLabel: capitalize(dislikeMatch[1].trim()),
      source: 'self_reported',
    });
  }

  // "I work at/for X"
  const workAtMatch = lower.match(/\bi work (?:at|for)\s+(.+?)(?:\.|!|,|$)/);
  if (workAtMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'works_at',
      objectLabel: capitalize(workAtMatch[1].trim()),
      source: 'self_reported',
    });
  }

  // "I work as X" / "I am a X" (occupation)
  const workAsMatch = lower.match(/\bi work as (?:a |an )?(.+?)(?:\.|!|,|$)/);
  if (workAsMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'occupation',
      objectLabel: capitalize(workAsMatch[1].trim()),
      source: 'self_reported',
    });
  }

  // "I live in X"
  const liveMatch = lower.match(/\bi live in\s+(.+?)(?:\.|!|,|$)/);
  if (liveMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'location',
      objectLabel: capitalize(liveMatch[1].trim()),
      source: 'self_reported',
    });
  }

  // "I'm from X" / "I am from X"
  const fromMatch = lower.match(/\bi(?:'m| am) from\s+(.+?)(?:\.|!|,|$)/);
  if (fromMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'origin',
      objectLabel: capitalize(fromMatch[1].trim()),
      source: 'self_reported',
    });
  }

  // "My name is X"
  const nameMatch = lower.match(/\bmy name is\s+(\w+)/);
  if (nameMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'name',
      objectLabel: capitalize(nameMatch[1]),
      source: 'self_reported',
    });
  }

  // "I'm N years old"
  const ageMatch = lower.match(/\bi(?:'m| am)\s+(\d+)\s+years?\s+old/);
  if (ageMatch) {
    triples.push({
      subjectHint: 'speaker',
      key: 'age',
      objectLabel: ageMatch[1],
      source: 'self_reported',
    });
  }

  // "I have N kids/children/cats/dogs" → HAS_NUMBER_OF_X
  const haveCountMatch = lower.match(/\bi have\s+(\w+)\s+(kids?|children|cats?|dogs?|pets?|siblings?|brothers?|sisters?|cars?|houses?|jobs?)/);
  if (haveCountMatch) {
    const count = haveCountMatch[1];
    const thing = haveCountMatch[2].replace(/s$/, ''); // singularize
    triples.push({
      subjectHint: 'speaker',
      key: `number_of_${thing}`,
      objectLabel: capitalize(count),
      source: 'self_reported',
    });
  }

  // "I have a X named/called Y" → HAS_X
  const haveNamedMatch = lower.match(/\bi have (?:a |an )?(\w+(?:\s+\w+)?)\s+(?:named|called)\s+(\w+)/);
  if (haveNamedMatch) {
    const thingType = haveNamedMatch[1].trim().replace(/\s+/g, '_');
    triples.push({
      subjectHint: 'speaker',
      key: thingType,
      objectLabel: capitalize(haveNamedMatch[2]),
      source: 'self_reported',
    });
  }

  // "My favorite X is Y"
  const favMatch = lower.match(/\bmy favorite\s+(\w+(?:\s+\w+)?)\s+is\s+(.+?)(?:\.|!|,|$)/);
  if (favMatch) {
    const category = favMatch[1].trim().replace(/\s+/g, '_');
    triples.push({
      subjectHint: 'speaker',
      key: `favorite_${category}`,
      objectLabel: capitalize(favMatch[2].trim()),
      source: 'self_reported',
    });
  }

  // ── Third-person patterns ("X likes/works at/lives in Y") ─────────

  // "X likes/loves/enjoys Y"
  const thirdLikeMatch = text.match(/\b([A-Z]\w+)\s+(?:likes?|loves?|enjoys?)\s+(.+?)(?:\.|!|,|$)/);
  if (thirdLikeMatch) {
    triples.push({
      subjectHint: null,
      key: 'likes',
      objectLabel: capitalize(thirdLikeMatch[2].trim()),
      source: 'observed',
    });
    // Override subject with the actual name
    (triples[triples.length - 1] as any)._subjectLabel = thirdLikeMatch[1];
  }

  // "X works at/for Y"
  const thirdWorkMatch = text.match(/\b([A-Z]\w+)\s+works?\s+(?:at|for)\s+(.+?)(?:\.|!|,|$)/);
  if (thirdWorkMatch) {
    triples.push({
      subjectHint: null,
      key: 'works_at',
      objectLabel: capitalize(thirdWorkMatch[2].trim()),
      source: 'observed',
    });
    (triples[triples.length - 1] as any)._subjectLabel = thirdWorkMatch[1];
  }

  // "X lives in Y"
  const thirdLiveMatch = text.match(/\b([A-Z]\w+)\s+lives?\s+in\s+(.+?)(?:\.|!|,|$)/);
  if (thirdLiveMatch) {
    triples.push({
      subjectHint: null,
      key: 'location',
      objectLabel: capitalize(thirdLiveMatch[2].trim()),
      source: 'observed',
    });
    (triples[triples.length - 1] as any)._subjectLabel = thirdLiveMatch[1];
  }

  // "X knows Y"
  const thirdKnowMatch = text.match(/\b([A-Z]\w+)\s+knows?\s+([A-Z]\w+)/);
  if (thirdKnowMatch) {
    triples.push({
      subjectHint: null,
      key: 'knows',
      objectLabel: thirdKnowMatch[2],
      source: 'observed',
    });
    (triples[triples.length - 1] as any)._subjectLabel = thirdKnowMatch[1];
  }

  // ── World-fact patterns ─────────────────────────────────────────────
  //
  // A "world fact" is a copular statement about a named entity that is
  // neither the speaker (first-person) nor Sylphie.  Examples:
  //   "The Eiffel Tower is in Paris."
  //   "Mount Everest is the tallest mountain."
  //   "Python was created by Guido van Rossum."
  //
  // Classification priority (high to low):
  //   1. First-person subject → 'speaker'  (handled above; early-return via regex)
  //   2. Sylphie as subject   → 'sylphie'
  //   3. Capitalized proper-noun subject + copula → 'world'
  //
  // IMPORTANT: only fires if text does NOT start with a first-person subject
  // (those cases already produced a 'speaker' triple above).

  if (!FIRST_PERSON_SUBJECT.test(text)) {
    // Check for Sylphie-directed copula first.
    const sylphieCopula = text.match(/\bsylphie\s+(?:is|are|was|were)\s+(.+?)(?:\.|!|\?|,|$)/i);
    if (sylphieCopula) {
      triples.push({
        subjectHint: 'sylphie',
        key: 'identity',
        objectLabel: capitalize(sylphieCopula[1].trim()),
        source: 'observed',
      });
    }

    // World-fact copula ("The Eiffel Tower is in Paris").
    const worldFactMatch = text.match(WORLD_FACT_PATTERN);
    if (worldFactMatch) {
      const subjectLabel = worldFactMatch[1].trim();
      const objectLabel = worldFactMatch[2].trim();

      // Guard: if the subject is Sylphie, the block above already handled it.
      if (!SYLPHIE_NAMES.test(subjectLabel)) {
        triples.push({
          subjectHint: 'world',
          key: 'location',  // default fact key for "is in/at/on" world facts
          objectLabel: capitalize(objectLabel),
          source: 'observed',
        });
        // Store the actual subject label so C3 can use it when minting `:Candidate`.
        // C3: branch here on subjectHint === 'world' → mint `:Candidate {label: _subjectLabel}`
        //     in the WORLD Neo4j graph (scoped, capped at 0.60, grounding_person_id = speakerId).
        (triples[triples.length - 1] as any)._subjectLabel = subjectLabel;
      }
    }
  }

  return triples;
}

// ---------------------------------------------------------------------------
// ExtractTypedEdgesService
// ---------------------------------------------------------------------------

@Injectable()
export class ExtractTypedEdgesService implements IExtractTypedEdgesService {
  private readonly logger = new Logger(ExtractTypedEdgesService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IExtractTypedEdgesService
  // ---------------------------------------------------------------------------

  async extractTypedEdges(
    entities: ExtractedEntity[],
    event: UnlearnedEvent,
  ): Promise<{ edges: ExtractedEdge[]; typedPairs: Set<string> }> {
    const content = extractContent(event);
    if (!content) {
      return { edges: [], typedPairs: new Set() };
    }

    const triples = parseTriples(content);
    if (triples.length === 0) {
      vlog('extractTypedEdges: no structured triples found', { eventId: event.id });
      return { edges: [], typedPairs: new Set() };
    }

    // Build a label → entity lookup from the already-upserted entities.
    const entityByLabel = new Map<string, ExtractedEntity>();
    for (const e of entities) {
      entityByLabel.set(e.label.toLowerCase(), e);
    }

    const edges: ExtractedEdge[] = [];
    const typedPairs = new Set<string>();
    const speakerEntity = findSpeakerEntity(entities);
    // Wave 3 / C3: the speaker who introduced these triples. Used to person-scope
    // any `:Candidate` value nodes minted for SENSOR (non-guardian) facts.
    const speakerId = extractSpeakerId(event);

    for (const triple of triples) {
      // Wave 3 / C3: world-fact triples (subjectHint === 'world') are routed to
      // `:Candidate` staging in the WORLD Neo4j graph instead of being dropped or
      // written as live `:Entity`. A world candidate is UNSCOPED (no
      // grounding_person_id) — it is a candidate world-fact awaiting guardian
      // promotion (C4), not attributable to one speaker. CANON Std-1: staged
      // visibly, not silently dropped.
      if (triple.subjectHint === 'world') {
        const worldEdge = await this.stageWorldFactCandidate(triple, event);
        if (worldEdge) {
          edges.push(worldEdge);
          typedPairs.add(`${worldEdge.sourceId}:${worldEdge.targetId}`);
          typedPairs.add(`${worldEdge.targetId}:${worldEdge.sourceId}`);
        }
        continue;
      }

      // Resolve subject
      let subjectEntity: ExtractedEntity | undefined;
      if (triple.subjectHint === 'speaker' && speakerEntity) {
        subjectEntity = speakerEntity;
      } else if ((triple as any)._subjectLabel) {
        subjectEntity = entityByLabel.get(((triple as any)._subjectLabel as string).toLowerCase());
      }

      if (!subjectEntity) continue;

      // Resolve or create the object entity
      const objectLabel = triple.objectLabel.substring(0, 50);
      let objectEntity = entityByLabel.get(objectLabel.toLowerCase());

      if (!objectEntity) {
        // The object value may not have been extracted as an entity (e.g. "coffee"
        // is lowercase). Upsert it now.
        //
        // Wave 3 / C3: a SELF_REPORTED value from a NON-guardian speaker is a
        // conversation-derived value — stage it as a `:Candidate` (person-scoped),
        // never a live `:Entity`, so a leaked value proper noun ("Maxford") cannot
        // ground for another speaker. Guardian-sourced (self_reported here maps to
        // GUARDIAN provenance only when the subject is already a live entity) and
        // observed third-person values stay `:Entity` — the subject of a
        // third-person fact is itself an extracted entity already on the live graph.
        const valueAsCandidate =
          subjectEntity.isCandidate === true || triple.subjectHint === 'speaker';
        const nodeId = await this.upsertValueEntity(
          objectLabel,
          triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR',
          valueAsCandidate,
          valueAsCandidate ? speakerId : undefined,
        );
        if (!nodeId) continue;

        objectEntity = {
          nodeId,
          label: objectLabel,
          provenance: valueAsCandidate
            ? CANDIDATE_PROVENANCE_TYPE
            : triple.source === 'self_reported'
              ? 'GUARDIAN'
              : 'SENSOR',
          confidence: valueAsCandidate
            ? Math.min(CANDIDATE_CONFIDENCE_CAP, 0.4)
            : triple.source === 'self_reported'
              ? 0.6
              : 0.4,
          isCandidate: valueAsCandidate,
          groundingPersonId: valueAsCandidate ? speakerId : undefined,
        };
        entityByLabel.set(objectLabel.toLowerCase(), objectEntity);
      }

      // Determine edge type
      const edgeType = resolveEdgeType(triple.key);

      // Write the typed edge to WKG
      const ok = await this.writeTypedEdge(
        subjectEntity.nodeId,
        objectEntity.nodeId,
        edgeType,
        triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR',
        triple.source === 'self_reported' ? 0.60 : 0.40,
      );

      if (ok) {
        const pairKey = `${subjectEntity.nodeId}:${objectEntity.nodeId}`;
        typedPairs.add(pairKey);
        typedPairs.add(`${objectEntity.nodeId}:${subjectEntity.nodeId}`); // bidirectional

        edges.push({
          sourceId: subjectEntity.nodeId,
          sourceLabel: subjectEntity.label,
          targetId: objectEntity.nodeId,
          targetLabel: objectLabel,
          relType: edgeType,
          provenance: triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR',
          confidence: triple.source === 'self_reported' ? 0.60 : 0.40,
          sessionId: event.session_id,
        });

        vlog('typed edge created', {
          eventId: event.id,
          subject: subjectEntity.label,
          predicate: edgeType,
          object: objectLabel,
          source: triple.source,
        });
      }
    }

    this.logger.debug(
      `ExtractTypedEdges: event ${event.id} → ${edges.length} typed edges from ${triples.length} triples`,
    );

    return { edges, typedPairs };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Upsert a value node for a fact object (e.g. "Coffee", "Three", "Maxford").
   *
   * Wave 3 / C3: when `asCandidate` is true the value is staged as a `:Candidate`
   * (provenance 'CANDIDATE', confidence ≤0.60, optional grounding_person_id),
   * never a live `:Entity`. This closes the value-side of the §2.8 leak — a
   * conversation-introduced value proper noun must not become groundable for
   * another speaker. Otherwise the original live `:Entity` behaviour is preserved.
   */
  private async upsertValueEntity(
    label: string,
    provenance: ProvenanceSource,
    asCandidate = false,
    speakerId?: string,
  ): Promise<string> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      if (asCandidate) {
        const candidateId = `candidate-${randomId()}`;
        const result = await session.run(
          `MERGE (n:${CANDIDATE_NODE_LABEL} {label: $label})
           ON CREATE SET
             n.node_id         = $nodeId,
             n.node_type       = $nodeLabel,
             n.schema_level    = 'instance',
             n.provenance_type = $provenance,
             n.confidence      = $confidence,
             n.${CANDIDATE_PERSON_ID_PROP} = $speakerId,
             n.created_at      = datetime()
           ON MATCH SET
             n.${CANDIDATE_PERSON_ID_PROP} =
               coalesce(n.${CANDIDATE_PERSON_ID_PROP}, $speakerId),
             n.updated_at      = datetime()
           RETURN n.node_id AS nodeId`,
          {
            label,
            nodeId: candidateId,
            nodeLabel: CANDIDATE_NODE_LABEL,
            provenance: CANDIDATE_PROVENANCE_TYPE,
            confidence: Math.min(CANDIDATE_CONFIDENCE_CAP, 0.5),
            speakerId: speakerId ?? null,
          },
        );
        return (result.records[0]?.get('nodeId') as string) ?? candidateId;
      }

      const nodeId = `entity-${randomId()}`;
      const result = await session.run(
        `MERGE (n:Entity {label: $label})
         ON CREATE SET
           n.node_id       = $nodeId,
           n.node_type     = 'Entity',
           n.schema_level  = 'instance',
           n.provenance_type = $provenance,
           n.confidence    = 0.50,
           n.created_at    = datetime()
         ON MATCH SET
           n.updated_at    = datetime()
         RETURN n.node_id AS nodeId`,
        { label, nodeId, provenance },
      );

      return result.records[0]?.get('nodeId') as string ?? nodeId;
    } catch (err) {
      this.logger.warn(`upsertValueEntity failed for "${label}": ${err instanceof Error ? err.message : String(err)}`);
      return '';
    } finally {
      await session.close();
    }
  }

  /**
   * Wave 3 / C3 — stage a world-fact triple as `:Candidate` subject + object with
   * a typed edge between them, all in the WORLD graph.
   *
   * A "world fact" (e.g. "The Eiffel Tower is in Paris") is NOT attributable to
   * the speaker the way a person fact is, so its `:Candidate` nodes are UNSCOPED
   * (grounding_person_id = null). It still carries provenance 'CANDIDATE',
   * confidence ≤0.60, and is non-groundable until a guardian promotes it (C4).
   * Both nodes are minted as `:Candidate`, never `:Entity`.
   *
   * Returns the staged edge (so the cycle counts it and the co-occurrence step
   * skips the pair), or null on failure / missing subject label.
   */
  private async stageWorldFactCandidate(
    triple: ParsedTriple,
    event: UnlearnedEvent,
  ): Promise<ExtractedEdge | null> {
    const rawSubject = (triple as any)._subjectLabel as string | undefined;
    if (!rawSubject) {
      vlog('stageWorldFactCandidate: world triple missing _subjectLabel', {
        eventId: event.id,
        key: triple.key,
      });
      return null;
    }

    // Strip a leading article the WORLD_FACT_PATTERN may have captured.
    const subjectLabel = rawSubject.replace(/^(?:the|a|an)\s+/i, '').trim().substring(0, 50);
    const objectLabel = triple.objectLabel.trim().substring(0, 50);
    if (!subjectLabel || !objectLabel) return null;

    // World candidates are unscoped: a world fact is not one person's claim.
    const subjectId = await this.upsertValueEntity(subjectLabel, 'INFERENCE', true, undefined);
    const objectId = await this.upsertValueEntity(objectLabel, 'INFERENCE', true, undefined);
    if (!subjectId || !objectId) return null;

    const edgeType = resolveEdgeType(triple.key);
    const ok = await this.writeTypedEdge(
      subjectId,
      objectId,
      edgeType,
      CANDIDATE_PROVENANCE_TYPE,
      Math.min(CANDIDATE_CONFIDENCE_CAP, 0.4),
    );
    if (!ok) return null;

    vlog('world-fact candidate staged', {
      eventId: event.id,
      subject: subjectLabel,
      predicate: edgeType,
      object: objectLabel,
      provenance: CANDIDATE_PROVENANCE_TYPE,
    });

    return {
      sourceId: subjectId,
      sourceLabel: subjectLabel,
      targetId: objectId,
      targetLabel: objectLabel,
      relType: edgeType,
      provenance: CANDIDATE_PROVENANCE_TYPE,
      confidence: Math.min(CANDIDATE_CONFIDENCE_CAP, 0.4),
      sessionId: event.session_id,
    };
  }

  /** Write a typed edge between two entity nodes. */
  private async writeTypedEdge(
    sourceId: string,
    targetId: string,
    edgeType: string,
    provenance: ProvenanceSource,
    confidence: number,
  ): Promise<boolean> {
    const sanitized = edgeType.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      await session.run(
        `MATCH (a {node_id: $sourceId}), (b {node_id: $targetId})
         MERGE (a)-[r:${sanitized}]->(b)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.created_at      = datetime(),
           r.refined_from    = 'STRUCTURED'
         ON MATCH SET
           r.confidence = CASE WHEN $confidence > r.confidence THEN $confidence ELSE r.confidence END,
           r.updated_at = datetime()`,
        { sourceId, targetId, confidence, provenance },
      );
      return true;
    } catch (err) {
      this.logger.warn(`writeTypedEdge failed: ${err instanceof Error ? err.message : String(err)}`);
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
 * Wave 3 / C3 — read the speaker id (PostgreSQL User.id) off the event payload
 * (threaded by C2). Used to person-scope `:Candidate` value nodes. Returns
 * undefined when absent / not a non-empty string.
 */
function extractSpeakerId(event: UnlearnedEvent): string | undefined {
  const raw = event.payload['speakerId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function resolveEdgeType(factKey: string): string {
  const mapped = FACT_KEY_TO_EDGE_TYPE.get(factKey);
  if (mapped) return mapped;

  if (factKey.startsWith(FAVORITE_PREFIX)) return 'HAS_FAVORITE';

  // For unmapped keys like "number_of_kid", "cat", "dog" etc.,
  // generate a HAS_ prefixed edge type from the key itself.
  return `HAS_${factKey.toUpperCase().replace(/\s+/g, '_')}`;
}

/** Find the entity most likely representing the speaker (guardian). */
function findSpeakerEntity(entities: ExtractedEntity[]): ExtractedEntity | undefined {
  // Prefer GUARDIAN provenance entities (from guardian input events).
  // Wave 3 / C3: conversation-derived nouns now carry 'CANDIDATE' provenance
  // (no longer 'SENSOR'), so include candidates as the speaker fallback —
  // otherwise speaker facts ("I like X") would silently fail to attach an edge.
  return entities.find((e) => e.provenance === 'GUARDIAN')
    ?? entities.find((e) => e.provenance === 'SENSOR')
    ?? entities.find((e) => e.isCandidate === true);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 10);
}
