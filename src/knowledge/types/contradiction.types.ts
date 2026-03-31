/**
 * Contradiction types for the World Knowledge Graph.
 *
 * CANON §Contradiction detection (Atlas risk 7): Contradictions are not
 * errors to suppress. They are developmental catalysts (Piagetian
 * disequilibrium) that drive learning and understanding. The system detects
 * contradictions, flags them for guardian review, and continues to accept
 * the new knowledge while marking the conflict.
 *
 * Every contradiction carries provenance to enable the Lesion Test:
 * we can replay events and understand which knowledge source produced
 * the conflicting claims.
 */

import type { KnowledgeNode, KnowledgeEdge } from '../../shared/types/knowledge.types';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Contradiction Types
// ---------------------------------------------------------------------------

/**
 * Classification of how two pieces of knowledge conflict.
 *
 * - BINARY_OPPOSITE:         The new edge directly negates the existing one
 *                             (e.g., IS_A('cat', 'dog') contradicts IS_A('cat', 'feline'))
 * - LOGICAL_CONFLICT:        The two propositions cannot both be true
 *                             (e.g., 'X > 10' contradicts 'X < 5')
 * - TEMPORAL_INCONSISTENCY:  Both were true at different times but no explanation for the change
 *                             (e.g., "Jim prefers coffee" then "Jim prefers tea" with no context)
 * - PROVENANCE_CONFLICT:     Two edges with the same semantic content but different provenances
 *                             disagree on a factual claim (which source is correct?)
 * - CONFIDENCE_CONFLICT:     Same relationship exists with substantially different confidence,
 *                             suggesting conflicting evidence sources (0.8 vs 0.3)
 */
export type ContradictionType =
  | 'BINARY_OPPOSITE'
  | 'LOGICAL_CONFLICT'
  | 'TEMPORAL_INCONSISTENCY'
  | 'PROVENANCE_CONFLICT'
  | 'CONFIDENCE_CONFLICT';

// ---------------------------------------------------------------------------
// Node-Level Contradictions
// ---------------------------------------------------------------------------

/**
 * A contradiction detected between two nodes in the WKG.
 *
 * Node contradictions can arise from competing property values, conflicting
 * labels, or property keys that appear with incompatible values.
 *
 * severity is in [0.0, 1.0]:
 *   - 0.0-0.3: Minor, can be merged or ignored
 *   - 0.3-0.7: Moderate, requires guardian review before resolution
 *   - 0.7-1.0: Severe, indicates fundamental knowledge conflict
 */
export interface NodeContradiction {
  /** Unique identifier for this contradiction record. */
  readonly id: string;

  /** Classification of how the nodes conflict. */
  readonly type: ContradictionType;

  /** ID of the existing node in the WKG. */
  readonly existingNodeId: string;

  /** ID of the incoming node attempting to be upserted (if it exists, null if new). */
  readonly incomingNodeId: string | null;

  /** Provenance of the existing node. */
  readonly existingProvenance: ProvenanceSource;

  /** Provenance of the incoming knowledge. */
  readonly incomingProvenance: ProvenanceSource;

  /** Confidence of the existing node's content. */
  readonly existingConfidence: number;

  /** Confidence of the incoming content. */
  readonly incomingConfidence: number;

  /** Severity of the conflict in [0.0, 1.0]. */
  readonly severity: number;

  /**
   * Natural-language description of what conflicts.
   * e.g., "Property 'age' is 25 in existing node but 30 in incoming data."
   */
  readonly description: string;

  /** Wall-clock time this contradiction was detected. */
  readonly detectedAt: Date;

  /** Whether a guardian has reviewed this contradiction. */
  readonly reviewed: boolean;

  /** Guardian's resolution (if reviewed): 'accept_incoming', 'reject_incoming', 'merge', null if unreviewed. */
  readonly resolution: 'accept_incoming' | 'reject_incoming' | 'merge' | null;

  /** Guardian's notes on the contradiction (if reviewed). */
  readonly guardianNotes?: string;
}

// ---------------------------------------------------------------------------
// Edge-Level Contradictions
// ---------------------------------------------------------------------------

/**
 * A contradiction detected between two edges in the WKG.
 *
 * Edge contradictions typically arise from schema-level conflicts
 * (e.g., two different IS_A hierarchies) or temporal inconsistencies
 * (e.g., "X causes Y" vs "Y causes X").
 *
 * severity is in [0.0, 1.0]:
 *   - 0.0-0.3: Minor, can often be resolved by merging confidence
 *   - 0.3-0.7: Moderate, requires guardian review
 *   - 0.7-1.0: Severe, indicates ontology-level conflict
 */
export interface EdgeContradiction {
  /** Unique identifier for this contradiction record. */
  readonly id: string;

  /** Classification of how the edges conflict. */
  readonly type: ContradictionType;

  /** ID of the existing edge in the WKG. */
  readonly existingEdgeId: string;

  /** ID of the incoming edge attempting to be upserted (if it exists, null if new). */
  readonly incomingEdgeId: string | null;

  /** Source node ID (shared by both edges). */
  readonly sourceNodeId: string;

  /** Target node ID (shared by both edges). */
  readonly targetNodeId: string;

  /** Relationship type (same for both edges, or conflicting types). */
  readonly relationship: string;

  /** Relationship type of the incoming edge (if different from existing). */
  readonly incomingRelationship?: string;

  /** Provenance of the existing edge. */
  readonly existingProvenance: ProvenanceSource;

  /** Provenance of the incoming edge. */
  readonly incomingProvenance: ProvenanceSource;

  /** Confidence of the existing edge. */
  readonly existingConfidence: number;

  /** Confidence of the incoming edge. */
  readonly incomingConfidence: number;

  /** Severity of the conflict in [0.0, 1.0]. */
  readonly severity: number;

  /**
   * Natural-language description of what conflicts.
   * e.g., "IS_A(cat, feline) conflicts with IS_A(cat, dog)."
   */
  readonly description: string;

  /** Wall-clock time this contradiction was detected. */
  readonly detectedAt: Date;

  /** Whether a guardian has reviewed this contradiction. */
  readonly reviewed: boolean;

  /** Guardian's resolution (if reviewed): 'accept_incoming', 'reject_incoming', 'both_true', null if unreviewed. */
  readonly resolution: 'accept_incoming' | 'reject_incoming' | 'both_true' | null;

  /** Guardian's notes on the contradiction (if reviewed). */
  readonly guardianNotes?: string;
}

// ---------------------------------------------------------------------------
// Contradiction Store
// ---------------------------------------------------------------------------

/**
 * A data transfer object for creating or updating contradiction records.
 *
 * This DTO is used when persisting contradictions to TimescaleDB or
 * another audit log. It omits audit fields (id, detectedAt) which are
 * assigned at persistence time.
 */
export interface ContradictionCreateRequest {
  /** Type of contradiction. */
  readonly type: ContradictionType;

  /** Severity in [0.0, 1.0]. */
  readonly severity: number;

  /** Natural-language description of the conflict. */
  readonly description: string;

  /** IDs of the conflicting entities (nodes or edges). */
  readonly entityIds: readonly string[];

  /** Provenances of the conflicting entities. */
  readonly provenances: readonly ProvenanceSource[];

  /** Confidence values of the conflicting entities. */
  readonly confidences: readonly number[];

  /** Domain-specific properties (e.g., which graph, extra context). */
  readonly properties?: Record<string, unknown>;
}

/**
 * Summary statistics about contradictions in the WKG.
 *
 * Used by dashboards and health-check systems to gauge the rate of
 * conflicts and identify areas that need guardian attention.
 */
export interface ContradictionStats {
  /** Total number of detected contradictions (all time). */
  readonly totalDetected: number;

  /** Number currently awaiting guardian review. */
  readonly pendingReview: number;

  /** Count of contradictions by type. */
  readonly byType: Readonly<Record<ContradictionType, number>>;

  /** Count of contradictions by severity band: [0-0.3], [0.3-0.7], [0.7-1.0]. */
  readonly bySeverity: Readonly<{
    minor: number;
    moderate: number;
    severe: number;
  }>;

  /** Average time from detection to guardian resolution (in hours). */
  readonly avgResolutionTimeHours: number | null;

  /** Most common contradiction type. */
  readonly mostCommonType: ContradictionType | null;
}
