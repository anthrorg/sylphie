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
  /** The subject entity label (e.g. the speaker's name, or "Sylphie"). */
  readonly subjectHint: 'speaker' | 'sylphie' | null;
  /** Fact key (maps to edge type). */
  readonly key: string;
  /** The object entity label (the value). */
  readonly objectLabel: string;
  /** Source reliability. */
  readonly source: 'self_reported' | 'observed';
}

/**
 * Parse structured (subject, predicate, object) triples from text.
 *
 * This is the core extraction logic. Each pattern produces a triple
 * where the predicate becomes the edge type and both subject/object
 * become Entity nodes in the graph.
 */
function parseTriples(text: string): ParsedTriple[] {
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

    for (const triple of triples) {
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
        const nodeId = await this.upsertValueEntity(objectLabel, triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR');
        if (!nodeId) continue;

        objectEntity = {
          nodeId,
          label: objectLabel,
          provenance: triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR',
          confidence: triple.source === 'self_reported' ? 0.60 : 0.40,
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

  /** Upsert a value entity node (for objects like "Coffee", "Three", etc.). */
  private async upsertValueEntity(
    label: string,
    provenance: ProvenanceSource,
  ): Promise<string> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    const nodeId = `entity-${randomId()}`;

    try {
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
  return entities.find((e) => e.provenance === 'GUARDIAN')
    ?? entities.find((e) => e.provenance === 'SENSOR');
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 10);
}
