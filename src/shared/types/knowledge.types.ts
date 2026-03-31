/**
 * Knowledge graph types: nodes, edges, filters, and upsert results.
 *
 * CANON §The World Knowledge Graph Is the Brain: The WKG is not a feature —
 * it IS the system. Everything either writes to or reads from it.
 *
 * CANON §7 (Provenance Is Sacred): Every node and edge carries a provenance
 * tag. The distinction is never erased. Provenance is required (not optional)
 * on all upsert operations.
 *
 * CANON §Confidence Dynamics: ACTRParams are stored on every node and edge
 * and updated on each successful retrieval-and-use event.
 *
 * Atlas risk 7 (contradiction detection): UpsertResult is a discriminated
 * union rather than an exception-throwing pattern. Contradictions are
 * developmental catalysts (Piagetian disequilibrium), not errors to suppress.
 */

import type { ProvenanceSource } from './provenance.types';
import type { ACTRParams } from './confidence.types';

// ---------------------------------------------------------------------------
// Node Level
// ---------------------------------------------------------------------------

/**
 * The three structural levels of the World Knowledge Graph (CANON §WKG).
 *
 * INSTANCE:    Individual entities ("this mug on this desk")
 * SCHEMA:      Types and categories ("mugs are containers")
 * META_SCHEMA: Rules governing how schemas evolve
 */
export type NodeLevel = 'INSTANCE' | 'SCHEMA' | 'META_SCHEMA';

// ---------------------------------------------------------------------------
// Core Knowledge Structures
// ---------------------------------------------------------------------------

/**
 * A node in the World Knowledge Graph.
 *
 * Labels are an array to support Neo4j's multi-label model. Every node has
 * at least one label; procedure nodes typically have two (e.g., ['Action', 'Procedure']).
 * The nodeLevel determines how queries traverse from specifics to generics.
 *
 * ACTRParams are stored on the node and updated by the Knowledge module on
 * every successful retrieval. The Confidence Ceiling (Standard 3) is enforced
 * at the persistence layer: no node exits creation with confidence > 0.60.
 *
 * properties: Open bag for domain-specific fields. Use Record<string, unknown>
 * rather than any — consumers narrow at the call site.
 */
export interface KnowledgeNode {
  /** Neo4j element ID (string in Neo4j 5+). */
  readonly id: string;

  /**
   * Neo4j labels. Always at least one entry.
   * Example: ['Entity', 'Person'], ['Action', 'Procedure']
   */
  readonly labels: readonly string[];

  /**
   * Structural level of this node in the WKG hierarchy.
   * Determines how the graph traversal resolves generalizations.
   */
  readonly nodeLevel: NodeLevel;

  /**
   * Who or what created this knowledge.
   * CANON §7: This tag is never erased or silently upgraded.
   */
  readonly provenance: ProvenanceSource;

  /**
   * ACT-R parameters for confidence dynamics.
   * Updated on each successful retrieval-and-use event by IConfidenceService.
   */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this node was first created. */
  readonly createdAt: Date;

  /** Wall-clock time of last modification (property update or label change). */
  readonly updatedAt: Date;

  /** Domain-specific properties. Narrow to a concrete type at the call site. */
  readonly properties: Record<string, unknown>;
}

/**
 * A directed edge in the World Knowledge Graph.
 *
 * Edges carry the same provenance and confidence semantics as nodes.
 * The relationship string is a Neo4j relationship type (e.g., 'IS_A',
 * 'CAN_PRODUCE', 'LOCATED_IN', 'TEACHES').
 *
 * CANON §Learning: CAN_PRODUCE edges are created during Learning consolidation
 * to record which phrases Sylphie produced. These carry LLM_GENERATED provenance.
 */
export interface KnowledgeEdge {
  /** Neo4j relationship element ID. */
  readonly id: string;

  /** Element ID of the source (start) node. */
  readonly sourceId: string;

  /** Element ID of the target (end) node. */
  readonly targetId: string;

  /**
   * Neo4j relationship type string.
   * By convention, UPPER_SNAKE_CASE. E.g., 'IS_A', 'CAN_PRODUCE', 'TAUGHT_BY'.
   */
  readonly relationship: string;

  /**
   * Who or what created this edge.
   * CANON §7: Never erased. LLM_GENERATED edges remain LLM_GENERATED
   * until a guardian explicitly confirms them (upgrading to GUARDIAN provenance).
   */
  readonly provenance: ProvenanceSource;

  /**
   * ACT-R parameters for this edge's confidence dynamics.
   * Updated on each use of this relationship in a successful retrieval.
   */
  readonly actrParams: ACTRParams;

  /** Domain-specific edge properties (e.g., weight, context, timestamp range). */
  readonly properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Query Filters
// ---------------------------------------------------------------------------

/**
 * Filters for querying nodes from the WKG.
 *
 * All fields are optional. Providing more filters narrows the result set.
 * Consumers compose filters rather than writing raw Cypher.
 */
export interface NodeFilter {
  /** Filter by one or more Neo4j labels (AND semantics — node must have all). */
  readonly labels?: readonly string[];

  /** Filter by structural level. */
  readonly nodeLevel?: NodeLevel;

  /** Filter by provenance source. */
  readonly provenance?: ProvenanceSource;

  /**
   * Minimum confidence threshold for returned nodes.
   * Defaults to CONFIDENCE_THRESHOLDS.retrieval (0.50) if not provided.
   * Pass 0.0 to retrieve nodes below the retrieval threshold (diagnostic use only).
   */
  readonly minConfidence?: number;

  /** Filter to nodes whose properties match these key-value pairs. */
  readonly properties?: Record<string, unknown>;

  /** Maximum number of nodes to return. */
  readonly limit?: number;
}

/**
 * Filters for querying edges from the WKG.
 *
 * All fields are optional. sourceId and/or targetId are typically provided
 * to anchor the traversal.
 */
export interface EdgeFilter {
  /** Filter to edges starting from this node ID. */
  readonly sourceId?: string;

  /** Filter to edges ending at this node ID. */
  readonly targetId?: string;

  /** Filter by relationship type string. */
  readonly relationship?: string;

  /** Filter by provenance source. */
  readonly provenance?: ProvenanceSource;

  /**
   * Minimum confidence threshold for returned edges.
   * Defaults to CONFIDENCE_THRESHOLDS.retrieval (0.50) if not provided.
   */
  readonly minConfidence?: number;

  /** Maximum number of edges to return. */
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Upsert Result — Discriminated Union
// ---------------------------------------------------------------------------

/**
 * Classification of how two contradicting edges conflict.
 *
 * BINARY_OPPOSITE: The new edge directly negates the existing one
 *   (e.g., IS_A('cat', 'dog') vs IS_A('cat', 'feline')).
 * CONFIDENCE_CONFLICT: Same relationship exists with substantially different
 *   confidence, suggesting conflicting evidence sources.
 * PROVENANCE_CONFLICT: Two edges with the same semantic content but different
 *   provenances disagree on a factual claim.
 */
export type ConflictType = 'BINARY_OPPOSITE' | 'CONFIDENCE_CONFLICT' | 'PROVENANCE_CONFLICT';

/**
 * Result of a node upsert operation — discriminated union.
 *
 * Atlas risk 7: Contradiction detection returns a discriminated union, not an
 * exception. Contradictions are developmental signals — the Learning subsystem
 * emits CONTRADICTION_DETECTED events and flags them for guardian review.
 * Silently suppressing a contradiction would violate CANON §Learning.
 *
 * SUCCESS: The node was created or updated without conflict.
 * CONTRADICTION: A conflict was detected with existing knowledge.
 *   The caller must decide whether to overwrite, defer, or emit an event.
 */
export type NodeUpsertResult =
  | {
      readonly type: 'success';
      /** The node as it exists after the upsert. */
      readonly node: KnowledgeNode;
    }
  | {
      readonly type: 'contradiction';
      /** The node that already exists in the graph. */
      readonly existing: KnowledgeNode;
      /** The node data that was being upserted (not yet persisted). */
      readonly incoming: Omit<KnowledgeNode, 'id' | 'createdAt' | 'updatedAt'>;
      /** How the two nodes conflict. */
      readonly conflictType: ConflictType;
    };

/**
 * Result of an edge upsert operation — discriminated union.
 *
 * Same semantics as NodeUpsertResult. Edge contradictions are particularly
 * important for ontology integrity — e.g., if the WKG believes X IS_A Y and
 * new knowledge asserts X IS_A Z, that is a schema-level conflict.
 */
export type EdgeUpsertResult =
  | {
      readonly type: 'success';
      /** The edge as it exists after the upsert. */
      readonly edge: KnowledgeEdge;
    }
  | {
      readonly type: 'contradiction';
      /** The edge that already exists in the graph. */
      readonly existing: KnowledgeEdge;
      /** The edge data that was being upserted (not yet persisted). */
      readonly incoming: Omit<KnowledgeEdge, 'id'>;
      /** How the two edges conflict. */
      readonly conflictType: ConflictType;
    };

/**
 * Convenience union for callers that handle both node and edge upserts generically.
 */
export type UpsertResult = NodeUpsertResult | EdgeUpsertResult;

// ---------------------------------------------------------------------------
// Upsert Request Types
// ---------------------------------------------------------------------------

/**
 * Request payload for upserting a node into the WKG.
 *
 * provenance is REQUIRED — not optional. Every WKG write must carry explicit
 * provenance. Omitting it is a data-integrity violation (CANON §7).
 */
export interface NodeUpsertRequest {
  /** Neo4j labels to assign. At least one required. */
  readonly labels: readonly string[];

  /** Structural level of this node. */
  readonly nodeLevel: NodeLevel;

  /**
   * Provenance of this knowledge.
   * REQUIRED. Never defaults. The caller must know where this knowledge came from.
   */
  readonly provenance: ProvenanceSource;

  /**
   * Initial confidence override. If not provided, resolveBaseConfidence(provenance)
   * is used. Cannot exceed CONFIDENCE_THRESHOLDS.ceiling (0.60) at creation.
   */
  readonly initialConfidence?: number;

  /** Domain-specific properties. */
  readonly properties?: Record<string, unknown>;
}

/**
 * Request payload for upserting an edge into the WKG.
 *
 * provenance is REQUIRED on edges just as on nodes.
 */
export interface EdgeUpsertRequest {
  /** Source node ID (must already exist). */
  readonly sourceId: string;

  /** Target node ID (must already exist). */
  readonly targetId: string;

  /** Neo4j relationship type. UPPER_SNAKE_CASE by convention. */
  readonly relationship: string;

  /**
   * Provenance of this relationship.
   * REQUIRED. Never defaults.
   */
  readonly provenance: ProvenanceSource;

  /** Initial confidence override. Cannot exceed ceiling at creation. */
  readonly initialConfidence?: number;

  /** Domain-specific edge properties. */
  readonly properties?: Record<string, unknown>;
}
