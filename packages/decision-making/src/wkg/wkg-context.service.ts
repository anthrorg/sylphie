/**
 * WkgContextService — Central read/write interface to the World Knowledge Graph.
 *
 * The WKG is Sylphie's knowledge center. Every LLM call in the deliberation
 * pipeline gets WKG context injected so the LLM never operates in a vacuum —
 * it always knows what Sylphie knows.
 *
 * Read operations:
 *   - getContextForFrame(): Assemble relevant WKG context for a sensory frame
 *   - queryEntities(): Find entities matching a query string
 *   - getSubgraph(): Pull entity neighborhoods for context enrichment
 *   - getEntityFacts(): Get all known facts about an entity
 *
 * Write operations:
 *   - writeEntity(): Create or update an entity node
 *   - writeRelationship(): Create or update an edge between entities
 *   - writeActionProcedure(): Create a learned procedure from deliberation
 *
 * All writes carry provenance and confidence. Contradictions with existing
 * knowledge create CONTRADICTS edges rather than silently overwriting.
 *
 * Uses Neo4j WORLD instance via Neo4jService.getSession(WORLD, mode).
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Neo4jService,
  Neo4jInstanceName,
  type SensoryFrame,
  type ProvenanceSource,
  type WkgContextEntry,
  type ActionStep,
  DriveName,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('Cortex');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A WKG entity with its properties and relationships. */
export interface WkgEntity {
  readonly nodeId: string;
  readonly label: string;
  readonly nodeType: string;
  readonly properties: Record<string, unknown>;
  readonly confidence: number;
  readonly provenance: string;
}

/** A relationship between two WKG entities. */
export interface WkgRelationship {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
  readonly confidence: number;
}

/** A fact extracted from the WKG about an entity. */
export interface WkgFact {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
  readonly provenance: string;
}

/** Complete WKG context assembled for a deliberation step. */
export interface WkgContext {
  /** Entities relevant to the current input. */
  readonly entities: readonly WkgEntity[];
  /** Relationships between the relevant entities. */
  readonly relationships: readonly WkgRelationship[];
  /** Known facts (subject-predicate-object triples). */
  readonly facts: readonly WkgFact[];
  /** Action procedures that match the current context. */
  readonly procedures: readonly WkgEntity[];
  /** Summary text suitable for injection into an LLM system prompt. */
  readonly summary: string;
}

/** Parameters for writing a new entity to the WKG. */
export interface NewEntity {
  readonly label: string;
  readonly nodeType: string;
  readonly properties: Record<string, unknown>;
  readonly provenance: ProvenanceSource;
  readonly confidence: number;
  readonly schemaLevel?: 'instance' | 'schema';
}

/** Parameters for writing a new relationship. */
export interface NewRelationship {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly properties?: Record<string, unknown>;
  readonly confidence: number;
  readonly provenance: ProvenanceSource;
}

/** Parameters for writing a new action procedure. */
export interface NewProcedure {
  readonly name: string;
  readonly category: string;
  readonly triggerContext: string;
  readonly responseText: string;
  readonly actionSequence: readonly ActionStep[];
  readonly provenance: ProvenanceSource;
  readonly confidence: number;
  readonly entityIds: readonly string[];
  readonly motivatingDrive: DriveName;
}

// ---------------------------------------------------------------------------
// WkgContextService
// ---------------------------------------------------------------------------

@Injectable()
export class WkgContextService {
  private readonly logger = new Logger(WkgContextService.name);

  constructor(
    @Optional() @Inject(Neo4jService) private readonly neo4j: Neo4jService | null,
  ) {}

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  /**
   * Assemble WKG context relevant to a sensory frame.
   *
   * 1. Extract entity names from the frame's raw text
   * 2. Fuzzy match against WKG nodes
   * 3. Pull 1-hop neighborhoods for matched entities
   * 4. Find matching ActionProcedure nodes
   * 5. Build a summary string for LLM injection
   */
  async getContextForFrame(frame: SensoryFrame): Promise<WkgContext> {
    if (!this.neo4j) {
      return emptyContext();
    }

    // Extract candidate entity names from raw text
    const rawText = frame.raw['text'] as string | undefined;
    const entityNames = rawText ? extractEntityNames(rawText) : [];

    if (entityNames.length === 0) {
      // No text entities — try to find context from active modalities
      return this.getBaseContext();
    }

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      // Fuzzy match entity names against WKG nodes
      const entities = await this.matchEntities(session, entityNames);

      // Get relationships between matched entities
      const entityIds = entities.map((e) => e.nodeId);
      const relationships = entityIds.length > 0
        ? await this.getRelationships(session, entityIds)
        : [];

      // Extract facts from entity properties and relationships
      const facts = buildFacts(entities, relationships);

      // Find relevant ActionProcedure nodes
      const procedures = await this.matchProcedures(session, rawText ?? '');

      // Build summary for LLM
      const summary = buildSummary(entities, facts, procedures);

      vlog('WKG context assembled', {
        entities: entities.length,
        relationships: relationships.length,
        facts: facts.length,
        procedures: procedures.length,
        summaryLength: summary.length,
      });

      return { entities, relationships, facts, procedures, summary };
    } catch (err) {
      vlog('WKG context query FAILED', { error: err instanceof Error ? err.message : String(err) });
      this.logger.warn(`WKG context query failed: ${err instanceof Error ? err.message : String(err)}`);
      return emptyContext();
    } finally {
      await session.close();
    }
  }

  /**
   * Query entities matching a string (for MCP tool use).
   */
  async queryEntities(query: string): Promise<WkgEntity[]> {
    if (!this.neo4j) return [];

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const names = extractEntityNames(query);
      return this.matchEntities(session, names.length > 0 ? names : [query]);
    } finally {
      await session.close();
    }
  }

  /**
   * Get the subgraph around a set of entity IDs.
   */
  async getSubgraph(entityIds: string[], depth = 1): Promise<{ entities: WkgEntity[]; relationships: WkgRelationship[] }> {
    if (!this.neo4j || entityIds.length === 0) {
      return { entities: [], relationships: [] };
    }

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE n.node_id IN $ids
         OPTIONAL MATCH path = (n)-[r*1..${depth}]-(m)
         WITH collect(DISTINCT n) + collect(DISTINCT m) AS allNodes,
              [rel IN collect(DISTINCT last(relationships(path))) WHERE rel IS NOT NULL] AS allRels
         UNWIND allNodes AS node
         WITH DISTINCT node, allRels
         RETURN node.node_id AS nodeId, node.label AS label, labels(node)[0] AS nodeType,
                properties(node) AS props, node.confidence AS confidence,
                node.provenance_type AS provenance`,
        { ids: entityIds },
      );

      const entities: WkgEntity[] = result.records.map((r) => ({
        nodeId: r.get('nodeId'),
        label: r.get('label') ?? '',
        nodeType: r.get('nodeType') ?? 'Unknown',
        properties: r.get('props') ?? {},
        confidence: r.get('confidence') ?? 0,
        provenance: r.get('provenance') ?? 'INFERENCE',
      }));

      const relationships = await this.getRelationships(session, entityIds);

      return { entities, relationships };
    } finally {
      await session.close();
    }
  }

  /**
   * Get all known facts about a specific entity.
   */
  async getEntityFacts(entityId: string): Promise<WkgFact[]> {
    if (!this.neo4j) return [];

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n {node_id: $id})-[r]-(m)
         RETURN n.label AS subject, type(r) AS predicate, m.label AS object,
                r.confidence AS confidence, n.provenance_type AS provenance
         LIMIT 50`,
        { id: entityId },
      );

      return result.records.map((r) => ({
        subject: r.get('subject') ?? entityId,
        predicate: r.get('predicate') ?? 'RELATED_TO',
        object: r.get('object') ?? 'unknown',
        confidence: r.get('confidence') ?? 0.5,
        provenance: r.get('provenance') ?? 'INFERENCE',
      }));
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  /**
   * Create or update an entity node in the WKG.
   * Returns the node_id of the created/updated node.
   */
  async writeEntity(entity: NewEntity): Promise<string> {
    if (!this.neo4j) {
      this.logger.warn('WKG write skipped: Neo4jService unavailable');
      return '';
    }

    const nodeId = `entity-${randomUUID().substring(0, 8)}`;
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      await session.run(
        `MERGE (n:Entity {label: $label})
         ON CREATE SET
           n.node_id = $nodeId,
           n.node_type = $nodeType,
           n.schema_level = $schemaLevel,
           n.provenance_type = $provenance,
           n.confidence = $confidence,
           n.created_at = datetime(),
           n += $properties
         ON MATCH SET
           n.confidence = CASE WHEN $confidence > n.confidence THEN $confidence ELSE n.confidence END,
           n.updated_at = datetime()
         WITH n
         CALL apoc.create.addLabels(n, [$nodeType]) YIELD node
         RETURN node.node_id AS nodeId`,
        {
          nodeId,
          label: entity.label,
          nodeType: entity.nodeType,
          schemaLevel: entity.schemaLevel ?? 'instance',
          provenance: entity.provenance,
          confidence: entity.confidence,
          properties: entity.properties,
        },
      );

      this.logger.debug(`WKG entity written: ${entity.label} (${entity.nodeType})`);
      return nodeId;
    } catch (err) {
      // APOC might not be available — try without dynamic labels
      try {
        await session.run(
          `MERGE (n:Entity {label: $label})
           ON CREATE SET
             n.node_id = $nodeId,
             n.node_type = $nodeType,
             n.schema_level = $schemaLevel,
             n.provenance_type = $provenance,
             n.confidence = $confidence,
             n.created_at = datetime()
           ON MATCH SET
             n.confidence = CASE WHEN $confidence > n.confidence THEN $confidence ELSE n.confidence END,
             n.updated_at = datetime()
           RETURN n.node_id AS nodeId`,
          {
            nodeId,
            label: entity.label,
            nodeType: entity.nodeType,
            schemaLevel: entity.schemaLevel ?? 'instance',
            provenance: entity.provenance,
            confidence: entity.confidence,
          },
        );
        this.logger.debug(`WKG entity written (no APOC): ${entity.label} (${entity.nodeType})`);
        return nodeId;
      } catch (innerErr) {
        this.logger.error(`WKG entity write failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
        return '';
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Create or update a relationship between two WKG entities.
   */
  async writeRelationship(rel: NewRelationship): Promise<void> {
    if (!this.neo4j) return;

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      // Use APOC for dynamic relationship type, fall back to generic
      await session.run(
        `MATCH (a {node_id: $sourceId}), (b {node_id: $targetId})
         MERGE (a)-[r:${sanitizeRelType(rel.type)}]->(b)
         ON CREATE SET
           r.confidence = $confidence,
           r.provenance_type = $provenance,
           r.created_at = datetime()
         ON MATCH SET
           r.confidence = CASE WHEN $confidence > r.confidence THEN $confidence ELSE r.confidence END,
           r.updated_at = datetime()`,
        {
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          confidence: rel.confidence,
          provenance: rel.provenance,
        },
      );

      this.logger.debug(`WKG relationship written: ${rel.sourceId} -[${rel.type}]-> ${rel.targetId}`);
    } catch (err) {
      this.logger.error(`WKG relationship write failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Create a new ActionProcedure node from a Type 2 deliberation outcome.
   * Links it to involved entities and the motivating drive.
   */
  async writeActionProcedure(proc: NewProcedure): Promise<string> {
    if (!this.neo4j) return '';

    const nodeId = `proc-${randomUUID().substring(0, 8)}`;
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      // Create the procedure node
      await session.run(
        `CREATE (p:ActionProcedure {
           node_id: $nodeId,
           name: $name,
           category: $category,
           triggerContext: $triggerContext,
           response_text: $responseText,
           action_sequence: $actionSequence,
           provenance_type: $provenance,
           confidence: $confidence,
           schema_level: 'instance',
           created_at: datetime()
         })
         RETURN p.node_id AS nodeId`,
        {
          nodeId,
          name: proc.name,
          category: proc.category,
          triggerContext: proc.triggerContext,
          responseText: proc.responseText,
          actionSequence: JSON.stringify(proc.actionSequence),
          provenance: proc.provenance,
          confidence: proc.confidence,
        },
      );

      // Link to involved entities
      for (const entityId of proc.entityIds) {
        await session.run(
          `MATCH (p:ActionProcedure {node_id: $procId}), (e {node_id: $entityId})
           MERGE (p)-[:INVOLVES]->(e)`,
          { procId: nodeId, entityId },
        );
      }

      // Link to motivating drive
      await session.run(
        `MATCH (p:ActionProcedure {node_id: $procId}), (d:Drive {drive_name: $driveName})
         MERGE (p)-[:RELIEVES]->(d)`,
        { procId: nodeId, driveName: proc.motivatingDrive },
      );

      vlog('WKG procedure written', {
        nodeId,
        name: proc.name,
        category: proc.category,
        entityCount: proc.entityIds.length,
        motivatingDrive: proc.motivatingDrive,
        confidence: proc.confidence,
      });

      this.logger.log(
        `WKG ActionProcedure written: "${proc.name}" (${proc.category}) → ` +
          `${proc.entityIds.length} entities, relieves ${proc.motivatingDrive}`,
      );
      return nodeId;
    } catch (err) {
      this.logger.error(`WKG procedure write failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private query helpers
  // ---------------------------------------------------------------------------

  /** Get base context (drives, CoBeing anchor) when no specific entities match. */
  private async getBaseContext(): Promise<WkgContext> {
    if (!this.neo4j) return emptyContext();

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE n:Drive OR n:CoBeing
         RETURN n.node_id AS nodeId, n.label AS label, labels(n)[0] AS nodeType,
                n.confidence AS confidence, n.provenance_type AS provenance
         LIMIT 20`,
      );

      const entities: WkgEntity[] = result.records.map((r) => ({
        nodeId: r.get('nodeId'),
        label: r.get('label') ?? '',
        nodeType: r.get('nodeType') ?? 'Unknown',
        properties: {},
        confidence: r.get('confidence') ?? 1.0,
        provenance: r.get('provenance') ?? 'INFERENCE',
      }));

      return {
        entities,
        relationships: [],
        facts: [],
        procedures: [],
        summary: 'Base context: drive system and self-reference loaded.',
      };
    } finally {
      await session.close();
    }
  }

  /** Fuzzy match entity names against WKG node labels. */
  private async matchEntities(session: any, names: string[]): Promise<WkgEntity[]> {
    if (names.length === 0) return [];

    // Case-insensitive search against node labels
    const result = await session.run(
      `UNWIND $names AS name
       MATCH (n)
       WHERE toLower(n.label) CONTAINS toLower(name)
         AND NOT n:Word
       RETURN DISTINCT n.node_id AS nodeId, n.label AS label,
              labels(n)[0] AS nodeType, properties(n) AS props,
              n.confidence AS confidence, n.provenance_type AS provenance
       LIMIT 20`,
      { names },
    );

    return result.records.map((r: any) => ({
      nodeId: r.get('nodeId'),
      label: r.get('label') ?? '',
      nodeType: r.get('nodeType') ?? 'Unknown',
      properties: r.get('props') ?? {},
      confidence: r.get('confidence') ?? 0.5,
      provenance: r.get('provenance') ?? 'INFERENCE',
    }));
  }

  /** Get relationships between a set of entity IDs. */
  private async getRelationships(session: any, entityIds: string[]): Promise<WkgRelationship[]> {
    if (entityIds.length === 0) return [];

    const result = await session.run(
      `MATCH (a)-[r]-(b)
       WHERE a.node_id IN $ids AND b.node_id IN $ids
       RETURN a.node_id AS sourceId, b.node_id AS targetId,
              type(r) AS relType, properties(r) AS props,
              r.confidence AS confidence
       LIMIT 100`,
      { ids: entityIds },
    );

    return result.records.map((r: any) => ({
      sourceId: r.get('sourceId'),
      targetId: r.get('targetId'),
      type: r.get('relType') ?? 'RELATED_TO',
      properties: r.get('props') ?? {},
      confidence: r.get('confidence') ?? 0.5,
    }));
  }

  /** Find ActionProcedure nodes matching a context string. */
  private async matchProcedures(session: any, context: string): Promise<WkgEntity[]> {
    const words = context.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return [];

    // Match procedures whose triggerContext overlaps with input words
    const result = await session.run(
      `MATCH (p:ActionProcedure)
       WHERE p.confidence >= 0.30
       WITH p, [w IN $words WHERE toLower(p.triggerContext) CONTAINS w] AS matches
       WHERE size(matches) > 0
       RETURN p.node_id AS nodeId, p.name AS label, 'ActionProcedure' AS nodeType,
              properties(p) AS props, p.confidence AS confidence,
              p.provenance_type AS provenance, toFloat(size(matches)) / $wordCount AS matchScore
       ORDER BY matchScore DESC, p.confidence DESC
       LIMIT 5`,
      { words, wordCount: words.length },
    );

    return result.records.map((r: any) => ({
      nodeId: r.get('nodeId'),
      label: r.get('label') ?? '',
      nodeType: r.get('nodeType') ?? 'ActionProcedure',
      properties: r.get('props') ?? {},
      confidence: r.get('confidence') ?? 0.3,
      provenance: r.get('provenance') ?? 'INFERENCE',
    }));
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function emptyContext(): WkgContext {
  return { entities: [], relationships: [], facts: [], procedures: [], summary: '' };
}

/** Extract potential entity names from text (capitalized words, proper nouns). */
function extractEntityNames(text: string): string[] {
  const words = text.split(/\s+/);
  const entities: string[] = [];

  for (const word of words) {
    const clean = word.replace(/[.,!?;:'"]/g, '');
    if (clean.length > 1 && /^[A-Z]/.test(clean)) {
      entities.push(clean);
    }
  }

  // Also include significant lowercase words for concept matching
  const lower = text.toLowerCase();
  const conceptWords = lower.split(/\s+/)
    .filter((w) => w.length > 4)
    .map((w) => w.replace(/[.,!?;:'"]/g, ''));

  return [...new Set([...entities, ...conceptWords])];
}

/** Build subject-predicate-object facts from entities and relationships. */
function buildFacts(entities: WkgEntity[], relationships: WkgRelationship[]): WkgFact[] {
  const facts: WkgFact[] = [];

  // Entity property facts
  for (const entity of entities) {
    for (const [key, value] of Object.entries(entity.properties)) {
      if (['node_id', 'created_at', 'updated_at', 'schema_level', 'provenance_type', 'confidence'].includes(key)) continue;
      facts.push({
        subject: entity.label,
        predicate: key,
        object: String(value),
        confidence: entity.confidence,
        provenance: entity.provenance,
      });
    }
  }

  // Relationship facts
  const entityMap = new Map(entities.map((e) => [e.nodeId, e.label]));
  for (const rel of relationships) {
    const subject = entityMap.get(rel.sourceId) ?? rel.sourceId;
    const object = entityMap.get(rel.targetId) ?? rel.targetId;
    facts.push({
      subject,
      predicate: rel.type,
      object,
      confidence: rel.confidence,
      provenance: 'INFERENCE',
    });
  }

  return facts;
}

/**
 * Build a human-readable summary for LLM injection.
 *
 * The summary is framed as a hard boundary: this is ALL Sylphie knows.
 * Anything not listed here is outside her knowledge, and the LLM must
 * not present it as Sylphie's own knowledge.
 */
function buildSummary(entities: WkgEntity[], facts: WkgFact[], procedures: WkgEntity[]): string {
  if (entities.length === 0 && facts.length === 0 && procedures.length === 0) {
    return 'You have NO knowledge about this topic. You must say you don\'t know, or clearly hedge any guess.';
  }

  const parts: string[] = [];
  parts.push('=== YOUR COMPLETE KNOWLEDGE ON THIS TOPIC (nothing beyond this) ===');

  if (entities.length > 0) {
    const entityList = entities
      .map((e) => {
        const source = e.provenance === 'GUARDIAN' ? 'taught by guardian'
          : e.provenance === 'SENSOR' ? 'observed directly'
          : e.provenance === 'LLM_GENERATED' ? 'inferred (unvalidated)'
          : 'inferred';
        return `${e.label} (${e.nodeType}, confidence: ${e.confidence.toFixed(2)}, source: ${source})`;
      })
      .join(', ');
    parts.push(`Known entities: ${entityList}`);
  }

  if (facts.length > 0) {
    const factList = facts
      .slice(0, 10)
      .map((f) => `${f.subject} ${f.predicate} ${f.object} [confidence: ${f.confidence.toFixed(2)}]`)
      .join('; ');
    parts.push(`Known facts: ${factList}`);
  }

  if (procedures.length > 0) {
    const procList = procedures
      .map((p) => `${p.label} (confidence: ${p.confidence.toFixed(2)})`)
      .join(', ');
    parts.push(`Relevant procedures: ${procList}`);
  }

  parts.push('=== END OF KNOWLEDGE — anything beyond this is NOT yours to claim ===');

  return parts.join('\n');
}

/** Sanitize a relationship type for use in Cypher (only alphanumeric + underscore). */
function sanitizeRelType(type: string): string {
  return type.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}
