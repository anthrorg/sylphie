/**
 * Self Knowledge Graph (KG(Self)) types.
 *
 * CANON §Self KG isolation: This knowledge graph is completely isolated from
 * the World Knowledge Graph and from all Other KG instances. No cross-graph
 * references, no shared edges. Nodes in KG(Self) never appear in the WKG,
 * and vice versa.
 *
 * Structures defined here represent Sylphie's self-model: capabilities,
 * behavioral patterns, meta-cognitive awareness, and internal conflicts.
 * These are used by the Planning subsystem to generate self-aware behaviors
 * and by the Learning subsystem to consolidate stable capabilities.
 */

import type { ACTRParams } from '../../shared/types/confidence.types';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Self Concept
// ---------------------------------------------------------------------------

/**
 * Type classification for self-concept nodes in KG(Self).
 *
 * - capability:              A learned skill or competency ("I can X")
 * - drive_pattern:           A recognized pattern of drive dynamics
 * - prediction_accuracy:     A tracked metric about forecasting reliability
 * - behavioral_pattern:      A tendency in behavior ("I tend to X when Y")
 * - identity_proposition:    A core identity claim ("I am X")
 */
export type SelfConceptType =
  | 'capability'
  | 'drive_pattern'
  | 'prediction_accuracy'
  | 'behavioral_pattern'
  | 'identity_proposition';

/**
 * A self-concept node in KG(Self).
 *
 * Self-concepts are discrete observations Sylphie has about herself:
 * capabilities she has demonstrated, patterns she recognizes, identity
 * propositions she holds. They carry provenance (usually BEHAVIORAL_INFERENCE
 * or GUARDIAN when confirmed) and confidence dynamics via ACTRParams.
 *
 * These are never shared with the WKG. Each node is local to KG(Self).
 */
export interface SelfConcept {
  /** Unique identifier within KG(Self). */
  readonly id: string;

  /** Human-readable label for this self-concept. e.g., "respond-in-french". */
  readonly label: string;

  /** Classification of this self-concept. */
  readonly type: SelfConceptType;

  /** Current confidence in this self-concept in [0.0, 1.0]. */
  readonly confidence: number;

  /** Who/what created or confirmed this self-concept. */
  readonly provenance: ProvenanceSource;

  /** ACT-R parameters for confidence dynamics. */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this concept was first recorded. */
  readonly createdAt: Date;

  /** Wall-clock time this concept was last updated. */
  readonly updatedAt: Date;

  /** Optional domain-specific properties (e.g., metadata, tags). */
  readonly properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Self Edges
// ---------------------------------------------------------------------------

/**
 * Relationship types for edges in KG(Self).
 *
 * - ENABLES:              "This capability enables that one" or
 *                         "This pattern depends on this capability"
 * - UNDERMINES:           "This conflict undermines this capability"
 * - PREDICTS:             "This pattern predicts this outcome"
 * - CORRELATES_WITH:      "This pattern correlates with that pattern"
 * - CONFLICTS_WITH:       "This self-concept conflicts with that one"
 * - SUPPORTS:             "This evidence supports this concept"
 */
export type SelfEdgeType =
  | 'ENABLES'
  | 'UNDERMINES'
  | 'PREDICTS'
  | 'CORRELATES_WITH'
  | 'CONFLICTS_WITH'
  | 'SUPPORTS';

/**
 * A directed relationship between two self-concepts in KG(Self).
 */
export interface SelfEdge {
  /** Unique identifier within KG(Self). */
  readonly id: string;

  /** ID of the source (start) self-concept. */
  readonly sourceId: string;

  /** ID of the target (end) self-concept. */
  readonly targetId: string;

  /** Type of relationship. */
  readonly type: SelfEdgeType;

  /** Confidence in this relationship in [0.0, 1.0]. */
  readonly confidence: number;

  /** Who/what created this relationship. */
  readonly provenance: ProvenanceSource;

  /** ACT-R parameters for this edge. */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this edge was created. */
  readonly createdAt: Date;

  /** Optional properties (e.g., weight, context). */
  readonly properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Self Conflicts
// ---------------------------------------------------------------------------

/**
 * A type of internal conflict that Sylphie recognizes about herself.
 *
 * - behavioral_inconsistency:    "I sometimes do X, sometimes do not-X"
 * - capability_limitation:       "I claim capability C but failed at it"
 * - identity_contradiction:      "I claim identity A but behave like not-A"
 * - drive_conflict:              "Drive A and Drive B pull me in opposite directions"
 * - temporal_inconsistency:      "My behavior changed but I haven't acknowledged why"
 */
export type SelfConflictType =
  | 'behavioral_inconsistency'
  | 'capability_limitation'
  | 'identity_contradiction'
  | 'drive_conflict'
  | 'temporal_inconsistency';

/**
 * Represents an internal conflict that Sylphie has recognized.
 *
 * Self-conflicts are developmental signals (Piagetian disequilibrium)
 * that drive learning and personality adjustment. They are flagged for
 * guardian review and serve as probes for deeper self-understanding.
 *
 * severity is in [0.0, 1.0]:
 *   - 0.0-0.3: Minor, can be ignored
 *   - 0.3-0.7: Moderate, warrants attention
 *   - 0.7-1.0: Severe, requires guardian intervention
 */
export interface SelfConflict {
  /** Unique identifier for this conflict. */
  readonly id: string;

  /** Classification of the conflict. */
  readonly type: SelfConflictType;

  /** IDs of self-concepts involved in this conflict. */
  readonly nodeIds: readonly string[];

  /** Severity of the conflict in [0.0, 1.0]. */
  readonly severity: number;

  /** Provenance: usually BEHAVIORAL_INFERENCE or GUARDIAN. */
  readonly provenance: ProvenanceSource;

  /** Wall-clock time this conflict was detected. */
  readonly detectedAt: Date;

  /** Natural-language description of the conflict. */
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Query Filters
// ---------------------------------------------------------------------------

/**
 * Filter criteria for querying self-concepts from KG(Self).
 *
 * All fields are optional. Providing multiple filters narrows the result set.
 */
export interface SelfKgQueryFilter {
  /** Filter by self-concept type. */
  readonly conceptType?: SelfConceptType;

  /** Filter by provenance source. */
  readonly provenance?: ProvenanceSource;

  /**
   * Minimum confidence threshold.
   * Defaults to CONFIDENCE_THRESHOLDS.retrieval (0.50) if not provided.
   */
  readonly minConfidence?: number;

  /** Filter by label (substring match). */
  readonly labelSubstring?: string;

  /** Maximum number of results to return. */
  readonly limit?: number;
}

/**
 * Filter criteria for querying self-edges from KG(Self).
 */
export interface SelfEdgeQueryFilter {
  /** Filter to edges starting from this concept ID. */
  readonly sourceId?: string;

  /** Filter to edges ending at this concept ID. */
  readonly targetId?: string;

  /** Filter by relationship type. */
  readonly edgeType?: SelfEdgeType;

  /** Filter by provenance. */
  readonly provenance?: ProvenanceSource;

  /**
   * Minimum confidence threshold.
   * Defaults to CONFIDENCE_THRESHOLDS.retrieval (0.50) if not provided.
   */
  readonly minConfidence?: number;

  /** Maximum number of results to return. */
  readonly limit?: number;
}
