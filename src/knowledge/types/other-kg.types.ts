/**
 * Other Knowledge Graph (KG(Other_*)) types.
 *
 * CANON §Other KG isolation: Each person that Sylphie interacts with has
 * a completely isolated Knowledge Graph instance. No edges, nodes, or
 * references cross between people's KGs, between a person's KG and the WKG,
 * or between a person's KG and KG(Self).
 *
 * Structures here represent models of other people: their traits, beliefs,
 * preferences, patterns, and contradictions as Sylphie infers them.
 * These are used for person-specific interaction strategies and for
 * detecting when Sylphie's model of someone needs revision.
 */

import type { ACTRParams } from '../../shared/types/confidence.types';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Person Concept
// ---------------------------------------------------------------------------

/**
 * Type classification for concepts in a person's KG(Other).
 *
 * - trait:               A personality or behavioral characteristic
 * - belief:              Something we think this person believes
 * - preference:          Something this person prefers or dislikes
 * - fear:                Something this person is afraid of or avoids
 * - capability:          Something this person can do well
 * - value:               Something this person values or prioritizes
 */
export type PersonConceptType =
  | 'trait'
  | 'belief'
  | 'preference'
  | 'fear'
  | 'capability'
  | 'value';

/**
 * A concept node in a person's KG(Other).
 *
 * Person concepts are inferred observations about another person:
 * traits we've noticed, beliefs we think they hold, preferences they've
 * shown. They carry provenance (usually BEHAVIORAL_INFERENCE when inferred,
 * GUARDIAN when explicitly taught) and confidence dynamics.
 *
 * These nodes are completely isolated to this person's graph instance.
 * No person-concept IDs appear in the WKG or in another person's KG.
 */
export interface PersonConcept {
  /** Unique identifier within this person's KG(Other). */
  readonly id: string;

  /** Human-readable label for this concept. e.g., "prefers-directness". */
  readonly label: string;

  /** Classification of this person concept. */
  readonly type: PersonConceptType;

  /** Current confidence in this observation in [0.0, 1.0]. */
  readonly confidence: number;

  /** Who/what created or confirmed this observation. */
  readonly provenance: ProvenanceSource;

  /** ACT-R parameters for confidence dynamics. */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this concept was first recorded. */
  readonly createdAt: Date;

  /** Wall-clock time this concept was last updated. */
  readonly updatedAt: Date;

  /** Optional domain-specific properties (e.g., evidence, examples). */
  readonly properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Person Edges
// ---------------------------------------------------------------------------

/**
 * Relationship types for edges in a person's KG(Other).
 *
 * - HAS_TRAIT:           "This person has this trait"
 * - BELIEVES:            "This person believes X"
 * - PREFERS:             "This person prefers X over Y"
 * - FEARS:               "This person is afraid of X"
 * - ENJOYS:              "This person enjoys X"
 * - VALUES:              "This person values X"
 * - INCONSISTENT_WITH:   "This trait contradicts that trait"
 */
export type PersonEdgeType =
  | 'HAS_TRAIT'
  | 'BELIEVES'
  | 'PREFERS'
  | 'FEARS'
  | 'ENJOYS'
  | 'VALUES'
  | 'INCONSISTENT_WITH';

/**
 * A directed relationship between two concepts in a person's KG(Other).
 */
export interface PersonEdge {
  /** Unique identifier within this person's KG(Other). */
  readonly id: string;

  /** ID of the source (start) person concept. */
  readonly sourceId: string;

  /** ID of the target (end) person concept. */
  readonly targetId: string;

  /** Type of relationship. */
  readonly type: PersonEdgeType;

  /** Confidence in this relationship in [0.0, 1.0]. */
  readonly confidence: number;

  /** Who/what created this relationship. */
  readonly provenance: ProvenanceSource;

  /** ACT-R parameters for this edge. */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this edge was created. */
  readonly createdAt: Date;

  /** Optional properties (e.g., weight, context, evidence). */
  readonly properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Person Model
// ---------------------------------------------------------------------------

/**
 * Top-level model of a specific person, retrieved from KG(Other_<personId>).
 *
 * This is the summary interface returned when querying what we know about
 * a person. The underlying KG(Other) contains all the detailed nodes and
 * edges; this interface aggregates them into a convenient snapshot.
 */
export interface PersonModel {
  /** Stable, unique identifier for this person (e.g., "person_jim"). */
  readonly personId: string;

  /** Display name (e.g., "Jim"). */
  readonly name: string;

  /** All known person-concepts for this person. */
  readonly concepts: readonly PersonConcept[];

  /** Total number of recorded interactions with this person. */
  readonly interactionCount: number;

  /** Wall-clock time of the most recent interaction. */
  readonly lastInteractionAt: Date | null;

  /** Wall-clock time this person model was first created. */
  readonly createdAt: Date;

  /** Wall-clock time this person model was last updated. */
  readonly updatedAt: Date;

  /** Any detected contradictions in our model of this person. */
  readonly conflicts: readonly PersonConflict[];
}

// ---------------------------------------------------------------------------
// Person Conflicts
// ---------------------------------------------------------------------------

/**
 * A type of contradiction detected in Sylphie's model of a person.
 *
 * - trait_contradiction:         "We think they're X but they behaved like not-X"
 * - preference_reversal:         "They prefer A, but now prefer not-A"
 * - belief_contradiction:        "They claim to believe A but act like they believe not-A"
 * - capability_variance:         "They can do X sometimes but not other times"
 * - interaction_inconsistency:   "Their interaction style changed significantly"
 * - value_conflict:              "They seem to value A and not-A simultaneously"
 */
export type PersonConflictType =
  | 'trait_contradiction'
  | 'preference_reversal'
  | 'belief_contradiction'
  | 'capability_variance'
  | 'interaction_inconsistency'
  | 'value_conflict';

/**
 * A detected contradiction in Sylphie's model of a specific person.
 *
 * Person conflicts signal that our model is out of sync with reality.
 * The Planning subsystem uses these to adjust interaction strategies,
 * and the Learning subsystem emits them as update requests to the guardian.
 *
 * severity is in [0.0, 1.0]:
 *   - 0.0-0.3: Minor, can be noted and watched
 *   - 0.3-0.7: Moderate, affects interaction strategy
 *   - 0.7-1.0: Severe, requires guardian clarification
 */
export interface PersonConflict {
  /** Unique identifier for this conflict. */
  readonly id: string;

  /** Classification of the conflict. */
  readonly type: PersonConflictType;

  /** IDs of person-concepts involved in this conflict. */
  readonly conceptIds: readonly string[];

  /** Severity of the conflict in [0.0, 1.0]. */
  readonly severity: number;

  /** Provenance: usually BEHAVIORAL_INFERENCE. */
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
 * Filter criteria for querying person-concepts from KG(Other).
 *
 * All fields are optional. Providing multiple filters narrows the result set.
 */
export interface PersonQueryFilter {
  /** Filter by concept type. */
  readonly conceptType?: PersonConceptType;

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
 * Filter criteria for querying person-edges from KG(Other).
 */
export interface PersonEdgeQueryFilter {
  /** Filter to edges starting from this concept ID. */
  readonly sourceId?: string;

  /** Filter to edges ending at this concept ID. */
  readonly targetId?: string;

  /** Filter by relationship type. */
  readonly edgeType?: PersonEdgeType;

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
