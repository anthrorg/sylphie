/**
 * Knowledge module public API barrel.
 *
 * Consumers import from this barrel, never from internal file paths.
 * The internal implementation files (concrete service classes) are an
 * implementation detail — only the interfaces, tokens, and module class
 * are public.
 *
 * Usage:
 *   import { KnowledgeModule, WKG_SERVICE } from '../knowledge';
 *   import type { IWkgService, GraphStats } from '../knowledge';
 */

// Module
export { KnowledgeModule } from './knowledge.module';

// Injection tokens
// Note: NEO4J_DRIVER is an internal infrastructure token and is NOT exported.
// Only WkgService holds a reference to it. Consumers should use WKG_SERVICE instead.
export {
  WKG_SERVICE,
  SELF_KG_SERVICE,
  OTHER_KG_SERVICE,
  CONFIDENCE_SERVICE,
} from './knowledge.tokens';

// Interfaces and auxiliary types
export type {
  IWkgService,
  ISelfKgService,
  IOtherKgService,
  IConfidenceService,
  GraphStats,
  SelfModel,
  SelfCapability,
  SelfPattern,
  SelfEvaluation,
  PersonModel,
  PersonModelUpdate,
  PersonTrait,
  PersonInteraction,
} from './interfaces/knowledge.interfaces';

// Knowledge-specific domain types
export type {
  SelfConceptType,
  SelfConcept,
  SelfEdgeType,
  SelfEdge,
  SelfConflictType,
  SelfConflict,
  SelfKgQueryFilter,
  SelfEdgeQueryFilter,
  PersonConceptType,
  PersonConcept,
  PersonEdgeType,
  PersonEdge,
  PersonConflictType,
  PersonConflict,
  PersonQueryFilter,
  PersonEdgeQueryFilter,
  ContradictionType,
  NodeContradiction,
  EdgeContradiction,
  ContradictionCreateRequest,
  ContradictionStats,
} from './types';
