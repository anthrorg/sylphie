/**
 * Knowledge module type exports.
 *
 * This barrel export consolidates all knowledge types used across the
 * Self KG, Other KG, and WKG subsystems. Import from this index rather
 * than from individual type files.
 */

// Self KG types
export type {
  SelfConceptType,
  SelfConcept,
  SelfEdgeType,
  SelfEdge,
  SelfConflictType,
  SelfConflict,
  SelfKgQueryFilter,
  SelfEdgeQueryFilter,
} from './self-kg.types';

// Other KG types
export type {
  PersonConceptType,
  PersonConcept,
  PersonEdgeType,
  PersonEdge,
  PersonModel,
  PersonConflictType,
  PersonConflict,
  PersonQueryFilter,
  PersonEdgeQueryFilter,
} from './other-kg.types';

// Contradiction types
export type {
  ContradictionType,
  NodeContradiction,
  EdgeContradiction,
  ContradictionCreateRequest,
  ContradictionStats,
} from './contradiction.types';
