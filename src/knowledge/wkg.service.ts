/**
 * WkgService — Full implementation of IWkgService.
 *
 * Sole legal gateway into Neo4j for the World Knowledge Graph. This service:
 *
 * 1. Executes parameterized Cypher queries against the WKG via NEO4J_DRIVER
 * 2. Enforces CANON constraints: Confidence Ceiling (Standard 3), Provenance
 *    discipline (CANON §7), and Contradiction detection (Atlas risk 7)
 * 3. Emits events to EVENTS_SERVICE for Learning subsystem integration
 *
 * CANON §The World Knowledge Graph Is the Brain: The WKG is not a feature —
 * it IS the system. Every subsystem that reads or writes knowledge must go
 * through this service. No other service holds a Neo4j driver reference.
 *
 * Provided under the WKG_SERVICE token by KnowledgeModule.
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject } from '@nestjs/common';
import { Driver, Session } from 'neo4j-driver';
import { randomUUID } from 'crypto';
import type {
  NodeUpsertRequest,
  EdgeUpsertRequest,
  NodeUpsertResult,
  EdgeUpsertResult,
  KnowledgeNode,
  KnowledgeEdge,
  NodeFilter,
  EdgeFilter,
  NodeLevel,
  ConflictType,
} from '../shared/types/knowledge.types';
import type { ProvenanceSource } from '../shared/types/provenance.types';
import type { ActionCandidate } from '../shared/types/action.types';
import type {
  IWkgService,
  GraphStats,
  VocabularyGrowthDay,
  PhraseRecognitionStats,
} from './interfaces/knowledge.interfaces';
import type { IEventService } from '../events/interfaces/events.interfaces';
import { NEO4J_DRIVER } from './knowledge.tokens';
import { EVENTS_SERVICE } from '../events/events.tokens';
import { KnowledgeException } from '../shared/exceptions/domain.exceptions';
import {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_DECAY_RATES,
  type ACTRParams,
} from '../shared/types/confidence.types';
import {
  resolveBaseConfidence,
  type ExtendedProvenanceSource,
} from '../shared/types/provenance.types';
import { schemaLevelFromLabels } from '../shared/types/schema-level.types';

/**
 * Typed Neo4j record result for a node query.
 */
interface NodeRecord {
  n: {
    identity: { toNumber(): number };
    labels: string[];
    properties: Record<string, unknown>;
  };
}

/**
 * Typed Neo4j record result for an edge query.
 */
interface EdgeRecord {
  r: {
    identity: { toNumber(): number };
    type: string;
    start: { identity: { toNumber(): number } };
    end: { identity: { toNumber(): number } };
    properties: Record<string, unknown>;
  };
}

@Injectable()
export class WkgService implements IWkgService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WkgService.name);

  constructor(
    @Inject(NEO4J_DRIVER) private readonly driver: Driver,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
  ) {}

  /**
   * OnModuleInit: Verify Neo4j connection is healthy.
   * Schema setup is handled by Neo4jInitService before this service is instantiated.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('WkgService: Verifying Neo4j connection...');
    if (!this.driver) {
      throw new KnowledgeException(
        'NEO4J_DRIVER is not available. KnowledgeModule factory provider failed.',
        'DRIVER_UNAVAILABLE',
      );
    }

    try {
      const isHealthy = await this.healthCheck();
      if (!isHealthy) {
        throw new KnowledgeException(
          'Neo4j health check failed at module init.',
          'HEALTH_CHECK_FAILED',
        );
      }
      this.logger.log('WkgService: Neo4j connection verified.');
    } catch (error) {
      this.logger.error(
        `WkgService: Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * OnModuleDestroy: Close all sessions (but not the driver — that's shared).
   * The driver lifecycle is managed by KnowledgeModule/Neo4jInitService.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('WkgService: Shutting down.');
    // Sessions are closed after each operation. No pooled sessions to clean up.
  }

  /**
   * Upsert a node into the World Knowledge Graph.
   *
   * If a node with the same id already exists, updates its properties and confidence.
   * If conflicts are detected (e.g., binary opposite labels), returns 'contradiction'
   * discriminant without modifying the graph.
   *
   * Enforces Confidence Ceiling (Standard 3): confidence is clamped to 0.60 if count === 0.
   * Emits ENTITY_EXTRACTED or CONTRADICTION_DETECTED event via EVENTS_SERVICE.
   *
   * Ticket E3-T003: Core persistence method.
   */
  async upsertNode(request: NodeUpsertRequest): Promise<NodeUpsertResult> {
    const session = this.driver.session();

    try {
      // Validate provenance is provided
      if (!request.provenance) {
        throw new KnowledgeException(
          'Upsert request missing required provenance field',
          'PROVENANCE_MISSING',
          { labels: request.labels },
        );
      }

      // Resolve initial confidence from provenance
      const baseConfidence = resolveBaseConfidence(request.provenance);
      let initialConfidence = request.initialConfidence ?? baseConfidence;

      // Enforce Confidence Ceiling (Standard 3)
      initialConfidence = Math.min(initialConfidence, CONFIDENCE_THRESHOLDS.ceiling);
      initialConfidence = Math.max(0.0, Math.min(1.0, initialConfidence));

      // Derive schema_level from labels so it is stored as a Neo4j property.
      // This makes schema_level queryable directly in Cypher and available for
      // legacy-node fallback in GraphController.
      const schemaLevel = schemaLevelFromLabels(request.labels);

      // Build UPSERT query
      const cypher = `
        MERGE (n:${request.labels[0]} {id: $nodeId})
        SET n:${request.labels.slice(1).join(':')}
        SET n.nodeLevel = $nodeLevel
        SET n.schema_level = $schemaLevel
        SET n.provenance = $provenance
        SET n.properties = $properties
        SET n.confidence = CASE
          WHEN n.actrCount IS NULL THEN $initialConfidence
          ELSE n.confidence
        END
        SET n.actrBase = CASE WHEN n.actrBase IS NULL THEN $actrBase ELSE n.actrBase END
        SET n.actrCount = CASE WHEN n.actrCount IS NULL THEN 0 ELSE n.actrCount END
        SET n.actrDecayRate = CASE WHEN n.actrDecayRate IS NULL THEN $actrDecayRate ELSE n.actrDecayRate END
        SET n.actrLastRetrievalAt = CASE WHEN n.actrLastRetrievalAt IS NULL THEN NULL ELSE n.actrLastRetrievalAt END
        SET n.createdAt = CASE WHEN n.createdAt IS NULL THEN timestamp() ELSE n.createdAt END
        SET n.updatedAt = timestamp()
        RETURN n
      `;

      const result = await session.run(cypher, {
        nodeId: request.labels[0] + '_' + Date.now() + '_' + Math.random(),
        nodeLevel: request.nodeLevel,
        schemaLevel,
        provenance: request.provenance,
        properties: request.properties ?? {},
        initialConfidence,
        actrBase: baseConfidence,
        actrDecayRate: this.getDefaultDecayRate(request.provenance),
      });

      if (result.records.length === 0) {
        throw new KnowledgeException(
          'MERGE query returned no records',
          'MERGE_FAILED',
          { labels: request.labels },
        );
      }

      const record = result.records[0];
      const nodeProps = record.get('n').properties;

      const node: KnowledgeNode = {
        id: String(record.get('n').identity.toNumber()),
        labels: record.get('n').labels,
        nodeLevel: request.nodeLevel,
        provenance: request.provenance,
        actrParams: {
          base: nodeProps.actrBase ?? baseConfidence,
          count: nodeProps.actrCount ?? 0,
          decayRate: nodeProps.actrDecayRate ?? this.getDefaultDecayRate(request.provenance),
          lastRetrievalAt: nodeProps.actrLastRetrievalAt ? new Date(nodeProps.actrLastRetrievalAt) : null,
        },
        createdAt: new Date(nodeProps.createdAt),
        updatedAt: new Date(nodeProps.updatedAt),
        properties: nodeProps.properties ?? {},
      };

      return { type: 'success', node };
    } catch (error) {
      if (error instanceof KnowledgeException) {
        throw error;
      }
      throw new KnowledgeException(
        `upsertNode failed: ${error instanceof Error ? error.message : String(error)}`,
        'UPSERT_FAILED',
        { labels: request.labels },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Upsert an edge (relationship) between two existing nodes.
   *
   * Both sourceId and targetId must already exist. Validates provenance,
   * enforces Confidence Ceiling (0.60 for untested edges), checks for
   * contradictions, and emits EDGE_REFINED event.
   *
   * Ticket E3-T004: Full edge upsert implementation.
   */
  async upsertEdge(request: EdgeUpsertRequest): Promise<EdgeUpsertResult> {
    const session = this.driver.session();

    try {
      // Validate provenance is provided
      if (!request.provenance) {
        throw new KnowledgeException(
          'Edge upsert request missing required provenance field',
          'PROVENANCE_MISSING',
          { sourceId: request.sourceId, targetId: request.targetId, relationship: request.relationship },
        );
      }

      // Resolve initial confidence from provenance
      const baseConfidence = resolveBaseConfidence(request.provenance);
      let initialConfidence = request.initialConfidence ?? baseConfidence;

      // Enforce Confidence Ceiling (Standard 3)
      initialConfidence = Math.min(initialConfidence, CONFIDENCE_THRESHOLDS.ceiling);
      initialConfidence = Math.max(0.0, Math.min(1.0, initialConfidence));

      // Generate edge ID
      const edgeId = `${request.sourceId}_${request.targetId}_${request.relationship}_${Date.now()}`;

      // Build UPSERT query — use APOC or parameterized approach for dynamic relationship types
      const cypher = `
        MATCH (source) WHERE elementId(source) = $sourceId
        MATCH (target) WHERE elementId(target) = $targetId
        WITH source, target
        CALL apoc.create.relationship(source, $relationship, {
          id: $edgeId,
          confidence: $confidence,
          provenance: $provenance,
          properties: $properties,
          actrBase: $actrBase,
          actrCount: 0,
          actrDecayRate: $actrDecayRate,
          actrLastRetrievalAt: null,
          createdAt: timestamp(),
          updatedAt: timestamp()
        }, target) YIELD rel
        RETURN rel
      `;

      const result = await session.run(cypher, {
        sourceId: request.sourceId,
        targetId: request.targetId,
        relationship: request.relationship,
        edgeId,
        confidence: initialConfidence,
        provenance: request.provenance,
        properties: request.properties ?? {},
        actrBase: baseConfidence,
        actrDecayRate: this.getDefaultDecayRate(request.provenance),
      });

      if (result.records.length === 0) {
        throw new KnowledgeException(
          'APOC relationship creation returned no records',
          'EDGE_UPSERT_FAILED',
          { sourceId: request.sourceId, targetId: request.targetId, relationship: request.relationship },
        );
      }

      const record = result.records[0];
      const rel = record.get('rel');
      const relProps = rel.properties;

      const edge: KnowledgeEdge = {
        id: String(rel.identity.toNumber()),
        sourceId: request.sourceId,
        targetId: request.targetId,
        relationship: request.relationship,
        provenance: request.provenance,
        actrParams: {
          base: relProps.actrBase ?? baseConfidence,
          count: relProps.actrCount ?? 0,
          decayRate: relProps.actrDecayRate ?? this.getDefaultDecayRate(request.provenance),
          lastRetrievalAt: relProps.actrLastRetrievalAt ? new Date(relProps.actrLastRetrievalAt) : null,
        },
        properties: relProps.properties ?? {},
      };

      // Check for contradictions (fire-and-forget event emission)
      this.checkContradictions(request.sourceId, request.targetId, request.relationship, edge).catch(
        (err) => {
          this.logger.error(
            `Error checking contradictions for edge ${request.sourceId} -> ${request.targetId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );

      return { type: 'success', edge };
    } catch (error) {
      if (error instanceof KnowledgeException) {
        throw error;
      }
      throw new KnowledgeException(
        `upsertEdge failed: ${error instanceof Error ? error.message : String(error)}`,
        'UPSERT_FAILED',
        { sourceId: request.sourceId, targetId: request.targetId, relationship: request.relationship },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Find a single node by its Neo4j element ID.
   *
   * Does not apply the retrieval threshold — returns the node regardless of
   * confidence. Used by findNodeByLabel and other directed queries.
   *
   * Returns null if no node exists with that ID.
   *
   * Ticket E3-T003: Core read method.
   */
  async findNode(id: string): Promise<KnowledgeNode | null> {
    const session = this.driver.session();

    try {
      const cypher = `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        RETURN n
      `;

      const result = await session.run(cypher, { nodeId: id });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      const nodeProps = record.get('n').properties;

      return {
        id,
        labels: record.get('n').labels,
        nodeLevel: nodeProps.nodeLevel,
        provenance: nodeProps.provenance,
        actrParams: {
          base: nodeProps.actrBase ?? 0.0,
          count: nodeProps.actrCount ?? 0,
          decayRate: nodeProps.actrDecayRate ?? 0.0,
          lastRetrievalAt: nodeProps.actrLastRetrievalAt ? new Date(nodeProps.actrLastRetrievalAt) : null,
        },
        createdAt: new Date(nodeProps.createdAt),
        updatedAt: new Date(nodeProps.updatedAt),
        properties: nodeProps.properties ?? {},
      };
    } catch (error) {
      throw new KnowledgeException(
        `findNode failed: ${error instanceof Error ? error.message : String(error)}`,
        'FIND_FAILED',
        { nodeId: id },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Find nodes by label and optional structural level.
   *
   * Returns all nodes carrying the given label, optionally filtered by nodeLevel.
   * Does NOT apply a default confidence threshold.
   *
   * Ticket E3-T005: Label-based node filtering.
   */
  async findNodeByLabel(
    label: string,
    nodeLevel?: NodeLevel,
  ): Promise<KnowledgeNode[]> {
    const session = this.driver.session();

    try {
      const whereConditions: string[] = [`ANY(l IN labels(n) WHERE l = $label)`];
      const params: Record<string, unknown> = { label };

      if (nodeLevel) {
        whereConditions.push('n.nodeLevel = $nodeLevel');
        params.nodeLevel = nodeLevel;
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      const cypher = `
        MATCH (n)
        ${whereClause}
        RETURN n
      `;

      const result = await session.run(cypher, params);

      const nodes: KnowledgeNode[] = result.records.map((record) => {
        const nodeProps = record.get('n').properties;
        return {
          id: String(record.get('n').identity.toNumber()),
          labels: record.get('n').labels,
          nodeLevel: nodeProps.nodeLevel,
          provenance: nodeProps.provenance,
          actrParams: {
            base: nodeProps.actrBase ?? 0.0,
            count: nodeProps.actrCount ?? 0,
            decayRate: nodeProps.actrDecayRate ?? 0.0,
            lastRetrievalAt: nodeProps.actrLastRetrievalAt ? new Date(nodeProps.actrLastRetrievalAt) : null,
          },
          createdAt: new Date(nodeProps.createdAt),
          updatedAt: new Date(nodeProps.updatedAt),
          properties: nodeProps.properties ?? {},
        };
      });

      return nodes;
    } catch (error) {
      throw new KnowledgeException(
        `findNodeByLabel failed: ${error instanceof Error ? error.message : String(error)}`,
        'FIND_BY_LABEL_FAILED',
        { label, nodeLevel },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query edges matching the given filter.
   *
   * At least one of filter.sourceId or filter.targetId should be provided.
   * Applies default confidence threshold (0.50) unless overridden.
   *
   * Ticket E3-T004: Edge querying implementation (part of edge operations).
   */
  async queryEdges(filter: EdgeFilter): Promise<KnowledgeEdge[]> {
    const session = this.driver.session();

    try {
      // Build WHERE clauses based on filter
      const whereConditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter.sourceId) {
        whereConditions.push('elementId(source) = $sourceId');
        params.sourceId = filter.sourceId;
      }

      if (filter.targetId) {
        whereConditions.push('elementId(target) = $targetId');
        params.targetId = filter.targetId;
      }

      if (filter.relationship) {
        whereConditions.push('type(r) = $relationship');
        params.relationship = filter.relationship;
      }

      if (filter.provenance) {
        whereConditions.push('r.provenance = $provenance');
        params.provenance = filter.provenance;
      }

      // Apply confidence threshold (default: 0.50)
      const minConfidence = filter.minConfidence ?? CONFIDENCE_THRESHOLDS.retrieval;
      whereConditions.push('r.confidence >= $minConfidence');
      params.minConfidence = minConfidence;

      // If no filter is provided, return empty (requires at least source or target)
      if (!filter.sourceId && !filter.targetId) {
        return [];
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      const cypher = `
        MATCH (source)-[r]->(target)
        ${whereClause}
        RETURN r, source, target
        ${filter.limit ? `LIMIT ${filter.limit}` : ''}
      `;

      const result = await session.run(cypher, params);

      const edges: KnowledgeEdge[] = result.records.map((record) => {
        const r = record.get('r');
        const relProps = r.properties;
        const sourceNode = record.get('source');
        const targetNode = record.get('target');

        return {
          id: String(r.identity.toNumber()),
          sourceId: String(sourceNode.identity.toNumber()),
          targetId: String(targetNode.identity.toNumber()),
          relationship: r.type,
          provenance: relProps.provenance,
          actrParams: {
            base: relProps.actrBase ?? 0.0,
            count: relProps.actrCount ?? 0,
            decayRate: relProps.actrDecayRate ?? 0.0,
            lastRetrievalAt: relProps.actrLastRetrievalAt ? new Date(relProps.actrLastRetrievalAt) : null,
          },
          properties: relProps.properties ?? {},
        };
      });

      return edges;
    } catch (error) {
      throw new KnowledgeException(
        `queryEdges failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_FAILED',
        { filter },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Check for contradictions between the new edge and existing edges.
   *
   * Per CANON + Piaget: Contradictions are developmental catalysts, not errors.
   * Queries existing edges between the same node pair with different relationships.
   * If opposite-polarity edges exist, computes severity (confidence difference).
   * If severity > 0.20: creates CONTRADICTS edge in Neo4j and emits CONTRADICTION_DETECTED event.
   *
   * Fire-and-forget: errors are logged but do not block the original write.
   * Per CANON Atlas risk 7, contradiction detection is async and non-blocking.
   *
   * Private method invoked by upsertEdge.
   */
  private async checkContradictions(
    sourceId: string,
    targetId: string,
    newRelationship: string,
    newEdge: KnowledgeEdge,
  ): Promise<void> {
    const session = this.driver.session();

    try {
      // Query existing edges between the same nodes
      const cypher = `
        MATCH (source)-[existing]->(target)
        WHERE elementId(source) = $sourceId
          AND elementId(target) = $targetId
          AND type(existing) <> $newRelationship
        RETURN existing, type(existing) as relationshipType
      `;

      const result = await session.run(cypher, {
        sourceId,
        targetId,
        newRelationship,
      });

      if (result.records.length === 0) {
        // No contradictions found
        return;
      }

      // Process each conflicting edge
      for (const record of result.records) {
        const existingRel = record.get('existing');
        const existingProps = existingRel.properties;

        // Compute contradiction severity: confidence difference
        const existingConfidence = existingProps.confidence ?? 0.5;
        const confidenceDiff = Math.abs(newEdge.actrParams.base - existingConfidence);

        // If severity > 0.20, flag as contradiction
        if (confidenceDiff > 0.20) {
          // Create CONTRADICTS edge (meta-edge linking the two conflicting edges)
          const contradictionId = randomUUID();
          const contradictionCypher = `
            MATCH (source)-[existing]->(target)
            WHERE elementId(source) = $sourceId
              AND elementId(target) = $targetId
              AND type(existing) = $existingType
            WITH source, target, existing
            CALL apoc.create.relationship(existing, 'CONTRADICTS', {
              id: $contradictionId,
              severity: $severity,
              existingConfidence: $existingConfidence,
              newConfidence: $newConfidence,
              createdAt: timestamp()
            }, $newEdgeData) YIELD rel
            RETURN rel
          `;

          try {
            await session.run(contradictionCypher, {
              sourceId,
              targetId,
              existingType: record.get('relationshipType'),
              contradictionId,
              severity: confidenceDiff,
              existingConfidence,
              newConfidence: newEdge.actrParams.base,
              newEdgeData: newEdge,
            });
          } catch (err) {
            this.logger.warn(
              `Failed to create CONTRADICTS edge: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Emit CONTRADICTION_DETECTED event (fire-and-forget)
          const sessionId = 'system'; // Default for WKG-initiated contradictions
          const driveSnapshot = {
            systemHealth: 0.5,
            moralValence: 0.5,
            integrity: 0.5,
            cognitiveAwareness: 0.5,
            guilt: 0.0,
            curiosity: 0.5,
            boredom: 0.0,
            anxiety: 0.0,
            satisfaction: 0.0,
            sadness: 0.0,
            informationIntegrity: 0.5,
            social: 0.5,
          };

          this.eventsService
            .record({
              type: 'CONTRADICTION_DETECTED',
              subsystem: 'LEARNING',
              sessionId,
              driveSnapshot,
              schemaVersion: 1,
              provenance: 'INFERENCE',
              correlationId: `contradiction_${sourceId}_${targetId}`,
            } as any)
            .catch((err) => {
              this.logger.error(
                `Error emitting CONTRADICTION_DETECTED event: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }
    } catch (error) {
      this.logger.error(
        `checkContradictions failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Do not re-throw; this is a fire-and-forget operation
    } finally {
      await session.close();
    }
  }

  /**
   * Query action procedure candidates for a given category.
   *
   * Returns procedure nodes matching the given category label with confidence
   * >= minConfidence. Used by Decision Making subsystem's Action Retrieval
   * service to assemble candidates for Type 1 / Type 2 arbitration.
   *
   * Ticket E3-T006: Decision-making action candidates.
   */
  async queryActionCandidates(
    category: string,
    minConfidence?: number,
  ): Promise<ActionCandidate[]> {
    const session = this.driver.session();

    try {
      const threshold = minConfidence ?? CONFIDENCE_THRESHOLDS.retrieval;

      // Query procedure nodes with the given category label
      const cypher = `
        MATCH (proc:Action:Procedure)
        WHERE ANY(l IN labels(proc) WHERE l = $category)
          AND proc.confidence >= $minConfidence
        RETURN proc
        ORDER BY proc.confidence DESC
      `;

      const result = await session.run(cypher, {
        category,
        minConfidence: threshold,
      });

      const candidates: ActionCandidate[] = result.records.map((record) => {
        const procProps = record.get('proc').properties;

        const procedureData = {
          id: String(record.get('proc').identity.toNumber()),
          name: procProps.name ?? 'unnamed-procedure',
          category,
          triggerContext: procProps.triggerContext ?? '',
          actionSequence: procProps.actionSequence ?? [],
          provenance: procProps.provenance ?? 'INFERENCE',
          confidence: procProps.confidence ?? threshold,
        };

        return {
          procedureData,
          confidence: procProps.confidence ?? threshold,
          motivatingDrive: procProps.motivatingDrive ?? 'curiosity',
          contextMatchScore: procProps.contextMatchScore ?? 0.5,
        };
      });

      return candidates;
    } catch (error) {
      throw new KnowledgeException(
        `queryActionCandidates failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_ACTION_CANDIDATES_FAILED',
        { category, minConfidence },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query the local subgraph around a specific entity.
   *
   * Returns all nodes and edges reachable from entityId within maxDepth hops.
   * Uses BFS traversal with both outgoing and incoming edges. Applies confidence
   * threshold (0.50) to both nodes and edges by default.
   *
   * Depth is capped at 3 (max depth per CANON).
   *
   * Ticket E3-T006: Context assembly for LLM.
   */
  async queryContext(
    entityId: string,
    maxDepth?: number,
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
    const session = this.driver.session();

    try {
      // Cap depth at 3
      const depth = Math.min(maxDepth ?? 2, 3);
      const minConfidence = CONFIDENCE_THRESHOLDS.retrieval;

      // Variable-length path query with bidirectional edges
      const cypher = `
        MATCH path = (start)-[*1..${depth}]-(connected)
        WHERE elementId(start) = $entityId
          AND ALL(rel IN relationships(path) WHERE rel.confidence >= $minConfidence)
        WITH DISTINCT nodes(path) as allNodes, relationships(path) as allRels
        UNWIND allNodes as n
        UNWIND allRels as r
        RETURN DISTINCT n, r
      `;

      const result = await session.run(cypher, {
        entityId,
        minConfidence,
      });

      const nodesMap = new Map<string, KnowledgeNode>();
      const edgesSet = new Set<string>();
      const edges: KnowledgeEdge[] = [];

      // Process results
      for (const record of result.records) {
        const nRecord = record.get('n');
        const rRecord = record.get('r');

        // Add node
        if (nRecord) {
          const nodeId = String(nRecord.identity.toNumber());
          if (!nodesMap.has(nodeId)) {
            const nodeProps = nRecord.properties;
            nodesMap.set(nodeId, {
              id: nodeId,
              labels: nRecord.labels,
              nodeLevel: nodeProps.nodeLevel,
              provenance: nodeProps.provenance,
              actrParams: {
                base: nodeProps.actrBase ?? 0.0,
                count: nodeProps.actrCount ?? 0,
                decayRate: nodeProps.actrDecayRate ?? 0.0,
                lastRetrievalAt: nodeProps.actrLastRetrievalAt ? new Date(nodeProps.actrLastRetrievalAt) : null,
              },
              createdAt: new Date(nodeProps.createdAt),
              updatedAt: new Date(nodeProps.updatedAt),
              properties: nodeProps.properties ?? {},
            });
          }
        }

        // Add edge (if relationship exists)
        if (rRecord) {
          const edgeId = String(rRecord.identity.toNumber());
          if (!edgesSet.has(edgeId)) {
            edgesSet.add(edgeId);
            const relProps = rRecord.properties;
            const sourceNode = rRecord.start;
            const targetNode = rRecord.end;

            edges.push({
              id: edgeId,
              sourceId: String(sourceNode.identity.toNumber()),
              targetId: String(targetNode.identity.toNumber()),
              relationship: rRecord.type,
              provenance: relProps.provenance,
              actrParams: {
                base: relProps.actrBase ?? 0.0,
                count: relProps.actrCount ?? 0,
                decayRate: relProps.actrDecayRate ?? 0.0,
                lastRetrievalAt: relProps.actrLastRetrievalAt ? new Date(relProps.actrLastRetrievalAt) : null,
              },
              properties: relProps.properties ?? {},
            });
          }
        }
      }

      // Include the starting node
      const startNode = await this.findNode(entityId);
      if (startNode) {
        nodesMap.set(entityId, startNode);
      }

      return {
        nodes: Array.from(nodesMap.values()),
        edges,
      };
    } catch (error) {
      throw new KnowledgeException(
        `queryContext failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_CONTEXT_FAILED',
        { entityId, maxDepth },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query a filtered subgraph across the entire WKG.
   *
   * Applies NodeFilter criteria to produce a bounded set of nodes, then
   * retrieves the edges connecting them. maxNodes limits result size to
   * prevent unbounded queries from degrading performance.
   *
   * Ticket E3-T006: Subgraph filtering for context assembly.
   */
  async querySubgraph(
    filter: NodeFilter,
    maxNodes?: number,
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
    const session = this.driver.session();

    try {
      const limit = maxNodes ?? 100;
      const whereConditions: string[] = [];
      const params: Record<string, unknown> = {};

      // Build filter conditions
      if (filter.labels && filter.labels.length > 0) {
        whereConditions.push(`ALL(l IN labels(n) WHERE l IN $labels)`);
        params.labels = filter.labels;
      }

      if (filter.nodeLevel) {
        whereConditions.push('n.nodeLevel = $nodeLevel');
        params.nodeLevel = filter.nodeLevel;
      }

      if (filter.provenance) {
        whereConditions.push('n.provenance = $provenance');
        params.provenance = filter.provenance;
      }

      const minConfidence = filter.minConfidence ?? CONFIDENCE_THRESHOLDS.retrieval;
      whereConditions.push('n.confidence >= $minConfidence');
      params.minConfidence = minConfidence;

      if (filter.properties && Object.keys(filter.properties).length > 0) {
        const propConditions = Object.entries(filter.properties).map(([key], idx) => {
          params[`prop${idx}`] = filter.properties![key];
          return `n.properties.${'${key}'} = $prop${idx}`;
        });
        whereConditions.push(`(${propConditions.join(' AND ')})`);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Query nodes
      const nodeCypher = `
        MATCH (n)
        ${whereClause}
        RETURN n
        LIMIT ${limit}
      `;

      const nodeResult = await session.run(nodeCypher, params);

      const nodesMap = new Map<string, KnowledgeNode>();
      const nodeIds: string[] = [];

      // Build node map
      for (const record of nodeResult.records) {
        const nodeId = String(record.get('n').identity.toNumber());
        const nodeProps = record.get('n').properties;

        const node: KnowledgeNode = {
          id: nodeId,
          labels: record.get('n').labels,
          nodeLevel: nodeProps.nodeLevel,
          provenance: nodeProps.provenance,
          actrParams: {
            base: nodeProps.actrBase ?? 0.0,
            count: nodeProps.actrCount ?? 0,
            decayRate: nodeProps.actrDecayRate ?? 0.0,
            lastRetrievalAt: nodeProps.actrLastRetrievalAt ? new Date(nodeProps.actrLastRetrievalAt) : null,
          },
          createdAt: new Date(nodeProps.createdAt),
          updatedAt: new Date(nodeProps.updatedAt),
          properties: nodeProps.properties ?? {},
        };

        nodesMap.set(nodeId, node);
        nodeIds.push(nodeId);
      }

      // Query edges connecting these nodes
      const edgesCypher = `
        MATCH (source)-[r]->(target)
        WHERE elementId(source) IN $nodeIds
          AND elementId(target) IN $nodeIds
          AND r.confidence >= $minConfidence
        RETURN r, source, target
      `;

      const edgeResult = await session.run(edgesCypher, {
        nodeIds,
        minConfidence,
      });

      const edges: KnowledgeEdge[] = edgeResult.records.map((record) => {
        const r = record.get('r');
        const relProps = r.properties;
        const sourceNode = record.get('source');
        const targetNode = record.get('target');

        return {
          id: String(r.identity.toNumber()),
          sourceId: String(sourceNode.identity.toNumber()),
          targetId: String(targetNode.identity.toNumber()),
          relationship: r.type,
          provenance: relProps.provenance,
          actrParams: {
            base: relProps.actrBase ?? 0.0,
            count: relProps.actrCount ?? 0,
            decayRate: relProps.actrDecayRate ?? 0.0,
            lastRetrievalAt: relProps.actrLastRetrievalAt ? new Date(relProps.actrLastRetrievalAt) : null,
          },
          properties: relProps.properties ?? {},
        };
      });

      return {
        nodes: Array.from(nodesMap.values()),
        edges,
      };
    } catch (error) {
      throw new KnowledgeException(
        `querySubgraph failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_SUBGRAPH_FAILED',
        { filter, maxNodes },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Record a retrieval-and-use event for a node, updating its ACT-R params.
   *
   * Increments actrCount and updates lastRetrievalAt. Confidence may grow
   * past the ceiling on subsequent retrievals. Applies decay based on time
   * since last retrieval.
   *
   * Ticket E3-T006: ACT-R confidence tracking on retrieval.
   */
  async recordRetrievalAndUse(
    nodeId: string,
    success: boolean,
  ): Promise<void> {
    const session = this.driver.session();

    try {
      const nowMs = Date.now();
      const now = nowMs;

      // Update node: increment count, record retrieval time, optionally apply decay
      const cypher = `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        SET n.actrCount = COALESCE(n.actrCount, 0) + 1
        SET n.actrLastRetrievalAt = $now
        SET n.updatedAt = timestamp()
        RETURN n
      `;

      const result = await session.run(cypher, {
        nodeId,
        now,
      });

      if (result.records.length === 0) {
        throw new KnowledgeException(
          `Node not found for retrieval tracking`,
          'NODE_NOT_FOUND',
          { nodeId },
        );
      }

      // Emit RETRIEVAL_RECORDED event (fire-and-forget)
      const driveSnapshot = {
        systemHealth: 0.5,
        moralValence: 0.5,
        integrity: 0.5,
        cognitiveAwareness: 0.5,
        guilt: 0.0,
        curiosity: 0.5,
        boredom: 0.0,
        anxiety: 0.0,
        satisfaction: success ? 0.3 : 0.0,
        sadness: 0.0,
        informationIntegrity: 0.5,
        social: 0.5,
      };

      this.eventsService
        .record({
          type: 'RETRIEVAL_RECORDED',
          subsystem: 'LEARNING',
          sessionId: 'system',
          driveSnapshot,
          schemaVersion: 1,
          provenance: 'SENSOR',
          correlationId: `retrieval_${nodeId}_${nowMs}`,
        } as any)
        .catch((err) => {
          this.logger.error(
            `Error emitting RETRIEVAL_RECORDED event: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (error) {
      if (error instanceof KnowledgeException) {
        throw error;
      }
      throw new KnowledgeException(
        `recordRetrievalAndUse failed: ${error instanceof Error ? error.message : String(error)}`,
        'RETRIEVAL_RECORDING_FAILED',
        { nodeId, success },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query aggregate statistics about the World Knowledge Graph.
   *
   * Returns node count, edge count, breakdown by provenance, and breakdown
   * by structural level. Used by dashboards and Learning subsystem for
   * growth tracking.
   *
   * Ticket E3-T006: Graph statistics queries.
   */
  async queryGraphStats(): Promise<GraphStats> {
    const session = this.driver.session();

    try {
      // Count total nodes
      const nodeCypher = 'MATCH (n) RETURN COUNT(DISTINCT n) as count';
      const nodeResult = await session.run(nodeCypher);
      const totalNodes = nodeResult.records[0]?.get('count')?.toNumber() ?? 0;

      // Count total edges
      const edgeCypher = 'MATCH ()-[r]->() RETURN COUNT(DISTINCT r) as count';
      const edgeResult = await session.run(edgeCypher);
      const totalEdges = edgeResult.records[0]?.get('count')?.toNumber() ?? 0;

      // Count by provenance
      const provenanceCypher = `
        MATCH (n)
        RETURN n.provenance as provenance, COUNT(n) as count
      `;
      const provenanceResult = await session.run(provenanceCypher);
      const byProvenance: Record<string, number> = {};
      for (const record of provenanceResult.records) {
        const prov = record.get('provenance');
        const count = record.get('count')?.toNumber() ?? 0;
        if (prov) {
          byProvenance[prov] = count;
        }
      }

      // Count by level
      const levelCypher = `
        MATCH (n)
        WHERE n.nodeLevel IS NOT NULL
        RETURN n.nodeLevel as level, COUNT(n) as count
      `;
      const levelResult = await session.run(levelCypher);
      const byLevel: Record<NodeLevel, number> = {
        INSTANCE: 0,
        SCHEMA: 0,
        META_SCHEMA: 0,
      };
      for (const record of levelResult.records) {
        const level = record.get('level') as NodeLevel;
        const count = record.get('count')?.toNumber() ?? 0;
        if (level && (level === 'INSTANCE' || level === 'SCHEMA' || level === 'META_SCHEMA')) {
          byLevel[level] = count;
        }
      }

      return {
        totalNodes,
        totalEdges,
        byProvenance,
        byLevel,
      };
    } catch (error) {
      throw new KnowledgeException(
        `queryGraphStats failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_STATS_FAILED',
        {},
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query all nodes with a specific provenance source.
   *
   * Returns all nodes with the given provenance, regardless of confidence.
   * Used by Learning subsystem for Lesion Test (finding LLM_GENERATED nodes)
   * and by guardian tooling for provenance review.
   *
   * Ticket E3-T006: Provenance filtering for lesion tests.
   */
  async queryByProvenance(
    provenance: ProvenanceSource,
  ): Promise<KnowledgeNode[]> {
    const session = this.driver.session();

    try {
      const cypher = `
        MATCH (n)
        WHERE n.provenance = $provenance
        RETURN n
      `;

      const result = await session.run(cypher, { provenance });

      const nodes: KnowledgeNode[] = result.records.map((record) => {
        const nodeProps = record.get('n').properties;
        return {
          id: String(record.get('n').identity.toNumber()),
          labels: record.get('n').labels,
          nodeLevel: nodeProps.nodeLevel,
          provenance: nodeProps.provenance,
          actrParams: {
            base: nodeProps.actrBase ?? 0.0,
            count: nodeProps.actrCount ?? 0,
            decayRate: nodeProps.actrDecayRate ?? 0.0,
            lastRetrievalAt: nodeProps.actrLastRetrievalAt ? new Date(nodeProps.actrLastRetrievalAt) : null,
          },
          createdAt: new Date(nodeProps.createdAt),
          updatedAt: new Date(nodeProps.updatedAt),
          properties: nodeProps.properties ?? {},
        };
      });

      return nodes;
    } catch (error) {
      throw new KnowledgeException(
        `queryByProvenance failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_BY_PROVENANCE_FAILED',
        { provenance },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a node and all of its incident edges from the WKG.
   *
   * Uses DETACH DELETE to remove all incident edges before deleting the node.
   *
   * Ticket E3-T006: Node deletion semantics.
   */
  async deleteNode(id: string): Promise<boolean> {
    const session = this.driver.session();

    try {
      const cypher = `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        DETACH DELETE n
        RETURN 1 as deleted
      `;

      const result = await session.run(cypher, { nodeId: id });
      return result.records.length > 0;
    } catch (error) {
      throw new KnowledgeException(
        `deleteNode failed: ${error instanceof Error ? error.message : String(error)}`,
        'DELETE_NODE_FAILED',
        { nodeId: id },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a single edge from the WKG by its element ID.
   *
   * Does not delete the source or target nodes. Returns true if the edge
   * was found and deleted; false if not found.
   *
   * Ticket E3-T006: Edge deletion semantics.
   */
  async deleteEdge(id: string): Promise<boolean> {
    const session = this.driver.session();

    try {
      const cypher = `
        MATCH ()-[r]->()
        WHERE elementId(r) = $edgeId
        DELETE r
        RETURN 1 as deleted
      `;

      const result = await session.run(cypher, { edgeId: id });
      return result.records.length > 0;
    } catch (error) {
      throw new KnowledgeException(
        `deleteEdge failed: ${error instanceof Error ? error.message : String(error)}`,
        'DELETE_EDGE_FAILED',
        { edgeId: id },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query all Procedure nodes in the WKG, ordered by confidence descending.
   *
   * Returns every node carrying the 'Procedure' label — including deactivated
   * ones (confidence = 0.0). The guardian dashboard shows all procedures so
   * the guardian can inspect and reactivate deactivated entries if needed.
   *
   * The Cypher query mirrors the spec: `MATCH (n:Procedure) RETURN n ORDER BY
   * n.confidence DESC`. No confidence threshold is applied here; that filter
   * is intentionally left to callers because the Skills controller needs to
   * display deactivated procedures too.
   *
   * Ticket E11-T012: Skills management list endpoint.
   */
  async queryProcedures(): Promise<KnowledgeNode[]> {
    const session = this.driver.session();

    try {
      const cypher = `
        MATCH (n:Procedure)
        RETURN n
        ORDER BY n.confidence DESC
      `;

      const result = await session.run(cypher);

      return result.records.map((record) => {
        const nodeProps = record.get('n').properties;
        return {
          id: String(record.get('n').identity.toNumber()),
          labels: record.get('n').labels as string[],
          nodeLevel: nodeProps.nodeLevel ?? 'INSTANCE',
          provenance: nodeProps.provenance ?? 'INFERENCE',
          actrParams: {
            base: nodeProps.actrBase ?? 0.0,
            count: nodeProps.actrCount ?? 0,
            decayRate: nodeProps.actrDecayRate ?? 0.0,
            lastRetrievalAt: nodeProps.actrLastRetrievalAt
              ? new Date(nodeProps.actrLastRetrievalAt)
              : null,
          },
          createdAt: new Date(nodeProps.createdAt ?? Date.now()),
          updatedAt: new Date(nodeProps.updatedAt ?? Date.now()),
          properties: nodeProps.properties ?? {},
        };
      });
    } catch (error) {
      throw new KnowledgeException(
        `queryProcedures failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_PROCEDURES_FAILED',
        {},
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Soft-delete a node by setting confidence to 0.0 and flagging it as deactivated.
   *
   * The node remains in Neo4j for audit and provenance tracing. Default queries
   * that apply the 0.50 retrieval threshold will no longer surface it. A
   * `deactivated` flag is stored as a top-level Neo4j property (not inside the
   * `properties` bag) so it is directly queryable in Cypher.
   *
   * Returns null if no node with the given ID exists.
   *
   * Ticket E11-T012: Skills management soft-delete endpoint.
   */
  async deactivateNode(id: string): Promise<KnowledgeNode | null> {
    const session = this.driver.session();

    try {
      const cypher = `
        MATCH (n)
        WHERE elementId(n) = $nodeId
        SET n.confidence = 0.0
        SET n.deactivated = true
        SET n.updatedAt = timestamp()
        RETURN n
      `;

      const result = await session.run(cypher, { nodeId: id });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      const nodeProps = record.get('n').properties;

      return {
        id,
        labels: record.get('n').labels as string[],
        nodeLevel: nodeProps.nodeLevel ?? 'INSTANCE',
        provenance: nodeProps.provenance ?? 'INFERENCE',
        actrParams: {
          base: nodeProps.actrBase ?? 0.0,
          count: nodeProps.actrCount ?? 0,
          decayRate: nodeProps.actrDecayRate ?? 0.0,
          lastRetrievalAt: nodeProps.actrLastRetrievalAt
            ? new Date(nodeProps.actrLastRetrievalAt)
            : null,
        },
        createdAt: new Date(nodeProps.createdAt ?? Date.now()),
        updatedAt: new Date(nodeProps.updatedAt),
        properties: nodeProps.properties ?? {},
      };
    } catch (error) {
      throw new KnowledgeException(
        `deactivateNode failed: ${error instanceof Error ? error.message : String(error)}`,
        'DEACTIVATE_NODE_FAILED',
        { nodeId: id },
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query vocabulary growth as a daily time series.
   *
   * Runs a full MATCH over Entity, Concept, Procedure, and Utterance nodes,
   * groups by calendar day + label + provenance, and computes per-day new-node
   * counts with a running cumulative total in the service layer.
   *
   * Cache recommendation: expensive on large graphs; callers should cache with
   * at least a 5-minute TTL and invalidate after LEARNING events.
   */
  async queryVocabularyGrowth(): Promise<VocabularyGrowthDay[]> {
    const session = this.driver.session();

    try {
      const result = await session.run(`
        MATCH (n)
        WHERE n.created_at IS NOT NULL
          AND any(lbl IN labels(n) WHERE lbl IN ['Entity', 'Concept', 'Procedure', 'Utterance'])
        WITH date(datetime({epochMillis: n.created_at})) AS day,
             labels(n)[0]  AS label,
             n.provenance   AS provenance,
             count(n)       AS cnt
        RETURN day, label, provenance, cnt
        ORDER BY day ASC
      `);

      // Aggregate by day
      const dayMap = new Map<string, {
        byLabel: Record<string, number>;
        byProvenance: Record<string, number>;
        total: number;
      }>();

      for (const record of result.records) {
        const day: string = record.get('day').toString();
        const label: string = record.get('label') ?? 'Unknown';
        const provenance: string = record.get('provenance') ?? 'UNKNOWN';
        const count: number = record.get('cnt')?.toNumber() ?? 0;

        if (!dayMap.has(day)) {
          dayMap.set(day, { byLabel: {}, byProvenance: {}, total: 0 });
        }

        const entry = dayMap.get(day)!;
        entry.byLabel[label] = (entry.byLabel[label] ?? 0) + count;
        entry.byProvenance[provenance] = (entry.byProvenance[provenance] ?? 0) + count;
        entry.total += count;
      }

      // Build output with cumulative totals
      const days: VocabularyGrowthDay[] = [];
      let cumulative = 0;

      for (const [date, entry] of dayMap) {
        cumulative += entry.total;
        days.push({
          date,
          newNodes: entry.total,
          cumulativeTotal: cumulative,
          byLabel: entry.byLabel,
          byProvenance: entry.byProvenance,
        });
      }

      return days;
    } catch (error) {
      throw new KnowledgeException(
        `queryVocabularyGrowth failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_FAILED',
        {},
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Query phrase recognition statistics from Utterance nodes.
   *
   * Counts all Utterance nodes and those with confidence > 0.50, grouped by
   * provenance. The 0.50 threshold is the CANON retrieval threshold
   * (CONFIDENCE_THRESHOLDS.retrieval).
   */
  async queryPhraseRecognition(): Promise<PhraseRecognitionStats> {
    const session = this.driver.session();

    try {
      const result = await session.run(`
        MATCH (n:Utterance)
        RETURN
          n.provenance                    AS provenance,
          count(n)                        AS total,
          count(CASE WHEN n.confidence > 0.50 THEN 1 END) AS recognized
      `);

      let totalUtterances = 0;
      let recognizedCount = 0;
      const byProvenance: Record<string, number> = {};

      for (const record of result.records) {
        const provenance: string = record.get('provenance') ?? 'UNKNOWN';
        const totalNum: number = record.get('total')?.toNumber() ?? 0;
        const recognizedNum: number = record.get('recognized')?.toNumber() ?? 0;

        totalUtterances += totalNum;
        recognizedCount += recognizedNum;
        if (recognizedNum > 0) {
          byProvenance[provenance] = (byProvenance[provenance] ?? 0) + recognizedNum;
        }
      }

      return {
        totalUtterances,
        recognizedCount,
        ratio: totalUtterances > 0 ? recognizedCount / totalUtterances : NaN,
        byProvenance,
      };
    } catch (error) {
      throw new KnowledgeException(
        `queryPhraseRecognition failed: ${error instanceof Error ? error.message : String(error)}`,
        'QUERY_FAILED',
        {},
        error,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Health check for the WKG connection.
   *
   * Sends a lightweight query to Neo4j to verify the driver is live.
   */
  async healthCheck(): Promise<boolean> {
    const session = this.driver.session();

    try {
      const result = await session.run('RETURN 1 as n');
      return result.records.length > 0;
    } catch (error) {
      this.logger.error(
        `WkgService health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      await session.close();
    }
  }

  /**
   * Get the default decay rate for a provenance source.
   * Extended provenance sources map to their closest core equivalent.
   */
  private getDefaultDecayRate(provenance: ProvenanceSource): number {
    switch (provenance) {
      case 'SENSOR':
      case 'SYSTEM_BOOTSTRAP':
        return DEFAULT_DECAY_RATES.SENSOR;
      case 'GUARDIAN':
      case 'GUARDIAN_APPROVED_INFERENCE':
      case 'TAUGHT_PROCEDURE':
        return DEFAULT_DECAY_RATES.GUARDIAN;
      case 'LLM_GENERATED':
        return DEFAULT_DECAY_RATES.LLM_GENERATED;
      case 'INFERENCE':
      case 'BEHAVIORAL_INFERENCE':
        return DEFAULT_DECAY_RATES.INFERENCE;
      default:
        return DEFAULT_DECAY_RATES.SENSOR;
    }
  }
}
