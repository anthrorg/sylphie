# Atlas Analysis: Epic 0 Knowledge Module Interface Surface

**Agent:** Atlas (Knowledge Graph Architect)
**Epic:** 0 -- Scaffold + Full Interface Skeleton
**Date:** 2026-03-28
**Status:** Complete

---

## Preamble

This analysis defines the complete interface surface for the Knowledge Module. The module covers three completely isolated graph stores: the World Knowledge Graph (Neo4j), the Self Knowledge Graph (Grafeo/KG(Self)), and per-person Other Knowledge Graphs (Grafeo/KG(Other)). These stores are the architectural center of gravity for the entire system. Every other module either writes to them or reads from them.

The interfaces defined here must be complete enough that Decision Making, Communication, Learning, Drive Engine, and Planning can all compile against them in Epic 0 without knowing anything about the Neo4j driver or Grafeo internals. Real implementations arrive in Epic 3.

All interface designs are validated against CANON principles, particularly: provenance discipline (CANON §7), confidence dynamics (CANON §Confidence Dynamics), the three-level schema system (CANON §3), and KG isolation (Rule 6 in the Atlas profile).

---

## 1. Shared Types Required Before Interfaces Compile

These types live in `src/shared/types/` and must exist before any knowledge interface can be declared. They are listed in dependency order -- a type that appears later depends on types that appear earlier.

### 1.1 `provenance.types.ts`

```typescript
export type ProvenanceSource = 'SENSOR' | 'GUARDIAN' | 'LLM_GENERATED' | 'INFERENCE';

export const PROVENANCE_BASE_CONFIDENCE: Record<ProvenanceSource, number> = {
  SENSOR: 0.40,
  GUARDIAN: 0.60,
  LLM_GENERATED: 0.35,
  INFERENCE: 0.30,
};
```

### 1.2 `confidence.types.ts`

```typescript
export interface ACTRParams {
  base: number;           // from ProvenanceSource
  retrievalCount: number; // successful retrieval-and-use events only
  hoursSinceRetrieval: number;
  decayRate: number;      // default ~0.05; per-node-type tunable
}

export const CONFIDENCE_THRESHOLDS = {
  RETRIEVAL: 0.50,       // below this, knowledge is not returned in normal queries
  CEILING_UNTESTED: 0.60, // max without at least one retrieval-and-use event
  TYPE1_GRADUATION: 0.80, // minimum confidence for Type 1 eligibility
} as const;

export const DEFAULT_DECAY_RATES: Record<string, number> = {
  Procedure: 0.07,  // procedures decay faster -- context-sensitive
  Concept: 0.04,
  Entity: 0.03,
  SchemaType: 0.02, // schema knowledge is more stable
};

/** Pure function -- no side effects, no I/O. Lives in shared/types. */
export function computeConfidence(params: ACTRParams): number {
  const { base, retrievalCount, hoursSinceRetrieval, decayRate } = params;
  const decay = decayRate * Math.log(hoursSinceRetrieval + 1);
  if (retrievalCount === 0) {
    return Math.min(CONFIDENCE_THRESHOLDS.CEILING_UNTESTED, base - decay);
  }
  return Math.min(1.0, base + 0.12 * Math.log(retrievalCount) - decay);
}
```

### 1.3 `knowledge.types.ts`

This is the largest dependency block. All four knowledge interfaces depend on these types.

```typescript
import { ProvenanceSource } from './provenance.types';

// -------------------------------------------------------------------------
// Graph level identifiers
// -------------------------------------------------------------------------

/** Distinguishes which of the three isolated stores a node belongs to. */
export type GraphStore = 'WKG' | 'SELF_KG' | 'OTHER_KG';

// -------------------------------------------------------------------------
// WKG node categories -- three-level system
// -------------------------------------------------------------------------

/**
 * High-level category for WKG nodes. Maps to Neo4j labels.
 * These are instance-level categories (ABox), not schema types (TBox).
 */
export type WkgNodeCategory =
  | 'Entity'        // physical objects, persons, places
  | 'Concept'       // abstract knowledge
  | 'Procedure'     // compiled behavioral sequences
  | 'Utterance'     // speech acts eligible for CAN_PRODUCE edges
  | 'SchemaType'    // schema-level type node (TBox)
  | 'SchemaRelType' // schema-level relationship type definition (TBox)
  | 'MetaRule'      // meta-schema rules governing TBox evolution
  | 'Observation'   // reified observation nodes (for contradiction tracking)
  | 'Inference'     // reified inference chains
  | 'StateChange';  // temporal state-change events

/**
 * Sub-labels that refine the category. Multiple are permitted on a single node
 * (polytypic classification). Maps to additional Neo4j labels.
 */
export type WkgNodeLabel =
  | 'PhysicalObject'
  | 'Person'
  | 'Place'
  | 'KitchenObject'
  | 'Container'
  | 'Surface'
  | string; // open-ended; schema evolution creates new labels at runtime

// -------------------------------------------------------------------------
// Core node and edge shapes
// -------------------------------------------------------------------------

/**
 * Required provenance envelope present on every WKG node.
 * Absence of any field is a write violation -- the service layer rejects it.
 */
export interface NodeProvenance {
  provenance: ProvenanceSource;
  confidence: number;          // current ACT-R value; recomputed on read
  created_at: Date;
  last_retrieved: Date | null; // null = never retrieved
  retrieval_count: number;     // successful retrieval-and-use events
}

/**
 * Required provenance envelope present on every WKG edge.
 * Same contract as NodeProvenance plus temporal validity window.
 */
export interface EdgeProvenance {
  provenance: ProvenanceSource;
  confidence: number;
  created_at: Date;
  last_retrieved: Date | null;
  retrieval_count: number;
  valid_from: Date;
  valid_to: Date | null; // null = currently held belief
}

/**
 * A node in the World Knowledge Graph.
 * Additional domain properties are stored in `properties`.
 */
export interface KnowledgeNode {
  node_id: string;
  category: WkgNodeCategory;
  labels: WkgNodeLabel[];   // polytypic -- can have multiple
  name: string;
  properties: Record<string, unknown>;
  provenance_envelope: NodeProvenance;
}

/**
 * An edge in the World Knowledge Graph.
 * `properties` holds domain-specific edge data beyond the provenance envelope.
 */
export interface KnowledgeEdge {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  rel_type: string;          // e.g. 'ON', 'IS_A', 'PREFERS', 'CAN_PRODUCE'
  properties: Record<string, unknown>;
  provenance_envelope: EdgeProvenance;
}

// -------------------------------------------------------------------------
// Write inputs -- callers supply these; service layer fills computed fields
// -------------------------------------------------------------------------

/**
 * Input for creating or updating a WKG node.
 * `node_id` is caller-assigned (deterministic from content hash or semantic key).
 * Service layer sets confidence from PROVENANCE_BASE_CONFIDENCE on first write.
 * Service layer rejects writes where provenance is absent.
 */
export interface UpsertNodeInput {
  node_id: string;
  category: WkgNodeCategory;
  labels?: WkgNodeLabel[];
  name: string;
  provenance: ProvenanceSource; // REQUIRED -- interface enforces via type, not runtime check
  properties?: Record<string, unknown>;
  /** Override base confidence. Validated: must not exceed CEILING_UNTESTED when count === 0. */
  confidence_override?: number;
}

/**
 * Input for creating or updating a WKG edge.
 * Service layer rejects edges where from_node_id or to_node_id do not exist.
 */
export interface UpsertEdgeInput {
  edge_id?: string;            // generated by service if omitted
  from_node_id: string;
  to_node_id: string;
  rel_type: string;
  provenance: ProvenanceSource; // REQUIRED
  properties?: Record<string, unknown>;
  confidence_override?: number;
  valid_from?: Date;            // defaults to now
  /** For temporal correction: close the prior edge before creating the new one. */
  supersedes_edge_id?: string;
}

// -------------------------------------------------------------------------
// Query filters
// -------------------------------------------------------------------------

export interface NodeFilter {
  node_id?: string;
  category?: WkgNodeCategory;
  labels?: WkgNodeLabel[];     // AND semantics: node must have all specified labels
  name_contains?: string;      // full-text search
  provenance?: ProvenanceSource;
  min_confidence?: number;     // defaults to RETRIEVAL threshold in normal queries
  include_below_threshold?: boolean; // override for schema/maintenance queries
}

export interface EdgeFilter {
  from_node_id?: string;
  to_node_id?: string;
  rel_type?: string;
  provenance?: ProvenanceSource;
  min_confidence?: number;
  currently_valid?: boolean;   // if true, filters to valid_to IS NULL only
  valid_at?: Date;             // returns edges valid at this specific time
}

// -------------------------------------------------------------------------
// Context assembly (for LLM prompt construction by Meridian)
// -------------------------------------------------------------------------

/**
 * A bounded subgraph returned to Communication or Decision Making for
 * LLM context assembly. Depth-limited -- never unbounded traversal.
 */
export interface ContextSubgraph {
  seed_node_id: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  depth: number;
  retrieval_timestamp: Date;
  /** Total nodes reachable beyond this subgraph -- signals incompleteness. */
  total_reachable_beyond: number;
}

// -------------------------------------------------------------------------
// Contradiction detection
// -------------------------------------------------------------------------

export type ContradictionSeverity = 'MINOR' | 'SIGNIFICANT' | 'CRITICAL';

export interface ContradictionReport {
  new_input: UpsertNodeInput | UpsertEdgeInput;
  conflicting_node_id?: string;
  conflicting_edge_id?: string;
  severity: ContradictionSeverity;
  description: string;
  /** Recommended resolution strategy. Implementation in Epic 3. */
  suggested_resolution: 'REPLACE' | 'COEXIST_WITH_LOWER_CONFIDENCE' | 'FLAG_FOR_GUARDIAN';
}

// -------------------------------------------------------------------------
// Type 1 graduation metadata on Procedure nodes
// -------------------------------------------------------------------------

export interface ProcedureType1Status {
  node_id: string;
  current_confidence: number;
  prediction_mae: number | null; // null = no predictions evaluated yet
  type1_eligible: boolean;       // confidence > 0.80 AND mae < 0.10
  last_evaluated: Date | null;
}

// -------------------------------------------------------------------------
// Self KG types (KG(Self) -- Grafeo)
// -------------------------------------------------------------------------

export interface SelfCapability {
  node_id: string;
  name: string;
  self_rated_confidence: number;
  actual_success_rate: number | null;
  last_assessed: Date;
  assessment_count: number;
}

export interface SelfStateSnapshot {
  snapshot_id: string;
  timestamp: Date;
  dominant_drive: string;
  drive_vector: Record<string, number>; // drive name -> value in [0,1]
  type1_ratio: number;
  prediction_accuracy: number | null;
}

export interface SelfKnowledgeDomain {
  node_id: string;
  name: string;
  estimated_coverage: number; // [0,1] -- Sylphie's self-assessment
  node_count: number;
  last_growth: Date;
}

export interface SelfModel {
  self_node_id: string;
  capabilities: SelfCapability[];
  recent_state_snapshots: SelfStateSnapshot[]; // last N snapshots
  knowledge_domains: SelfKnowledgeDomain[];
  /** interoceptive_accuracy: correlation between self_rated_confidence and actual_success_rate */
  interoceptive_accuracy: number | null;
}

// -------------------------------------------------------------------------
// Other KG types (per-person Grafeo instances)
// -------------------------------------------------------------------------

export interface PersonPreference {
  node_id: string;
  domain: string;
  value: string;
  context: string | null;
  confidence: number;
  observation_count: number;
  provenance: ProvenanceSource;
}

export interface PersonCommStyle {
  node_id: string;
  description: string;
  humor_receptivity: number;
  formality_level: number;
  patience_for_questions: number;
  confidence: number;
  observation_count: number;
}

export interface PersonObservedState {
  node_id: string;
  timestamp: Date;
  observed_affect: string;
  confidence: number;
  provenance: ProvenanceSource;
  cues: string[];
}

export interface PersonTopicInterest {
  node_id: string;
  topic: string;
  interest_level: number;
  engagement_indicators: string[];
  observation_count: number;
}

export interface PersonModel {
  person_id: string;
  name: string;
  role: string;
  first_interaction: Date;
  last_interaction: Date;
  interaction_count: number;
  preferences: PersonPreference[];
  comm_style: PersonCommStyle | null;
  recent_states: PersonObservedState[];
  topic_interests: PersonTopicInterest[];
}

export interface UpdatePersonModelInput {
  person_id: string;
  /** Partial update -- only provided fields are merged. */
  preference?: Omit<PersonPreference, 'node_id'>;
  comm_style_observation?: Partial<PersonCommStyle>;
  observed_state?: Omit<PersonObservedState, 'node_id'>;
  topic_interest?: Omit<PersonTopicInterest, 'node_id'>;
}
```

---

## 2. DI Tokens

These tokens live in `src/knowledge/knowledge.tokens.ts`. The token approach is the primary mechanism for three-graph isolation at the TypeScript level. No module can accidentally inject the wrong graph service if the tokens are different types.

```typescript
// src/knowledge/knowledge.tokens.ts

export const WKG_SERVICE = Symbol('WKG_SERVICE');
export const SELF_KG_SERVICE = Symbol('SELF_KG_SERVICE');
export const OTHER_KG_SERVICE = Symbol('OTHER_KG_SERVICE');
export const CONFIDENCE_SERVICE = Symbol('CONFIDENCE_SERVICE');

/**
 * The raw Neo4j driver is exposed for modules that need direct Cypher access
 * (e.g., Learning's contradiction detection, Planning's pattern research).
 * It is NOT the preferred access path -- prefer IWkgService.
 */
export const NEO4J_DRIVER = Symbol('NEO4J_DRIVER');
```

**Isolation enforcement pattern.** Each consuming module injects using the symbol token and types the injected value against the correct interface. The TypeScript compiler prevents cross-assignment:

```typescript
// In LearningModule -- correct
@Inject(WKG_SERVICE) private readonly wkg: IWkgService

// Attempting to use SELF_KG_SERVICE as IWkgService is a compile error
// because ISelfKgService and IWkgService are structurally incompatible.
// The token difference prevents accidental injection even if shapes were
// accidentally similar.
```

No module outside `src/knowledge/` ever receives a Neo4j driver reference or a raw Grafeo instance. They receive only the typed service interfaces.

---

## 3. IWkgService

**File:** `src/knowledge/interfaces/wkg.service.interface.ts`

This is the largest interface because the WKG is the primary store for all five subsystems. Every method specifies its provenance enforcement contract and confidence behavior.

```typescript
import {
  KnowledgeNode, KnowledgeEdge,
  UpsertNodeInput, UpsertEdgeInput,
  NodeFilter, EdgeFilter,
  ContextSubgraph,
  ContradictionReport,
  ProcedureType1Status,
} from '../../shared/types/knowledge.types';

export interface IWkgService {

  // -----------------------------------------------------------------------
  // Node CRUD
  // -----------------------------------------------------------------------

  /**
   * Upsert a node into the WKG.
   *
   * Provenance enforcement:
   * - `input.provenance` MUST be present. The type system ensures this at
   *   compile time; the implementation adds a runtime guard for untrusted
   *   callers (e.g., deserialized JSON from LLM output).
   *
   * Confidence ceiling:
   * - On creation (first write), confidence is set from PROVENANCE_BASE_CONFIDENCE.
   * - If `confidence_override` is provided and retrieval_count would be 0,
   *   the override is clamped to CEILING_UNTESTED (0.60). Immutable Standard 3.
   *
   * On update (node_id already exists):
   * - Properties are merged (not replaced). The provenance of the original
   *   node is preserved. If provenance differs, the higher-authority source
   *   wins (GUARDIAN > SENSOR > INFERENCE > LLM_GENERATED). A new provenance
   *   field is never silently overwritten.
   *
   * @throws ProvenanceMissingError if input.provenance is absent (runtime guard)
   * @throws ConfidenceCeilingViolationError if override exceeds ceiling for count=0
   */
  upsertNode(input: UpsertNodeInput): Promise<KnowledgeNode>;

  /**
   * Find a single node by its deterministic ID.
   * Returns null if the node does not exist (Open World Assumption -- absence
   * means "not yet observed," not "does not exist").
   *
   * Does NOT update retrieval metadata. Use `recordRetrievalAndUse` after
   * the retrieved knowledge is actually used in a decision or utterance.
   */
  findNode(nodeId: string): Promise<KnowledgeNode | null>;

  /**
   * Find nodes matching a filter.
   *
   * Default behavior applies the retrieval threshold (confidence >= 0.50).
   * Set `filter.include_below_threshold = true` for schema maintenance,
   * contradiction detection, and gap analysis queries. Below-threshold
   * knowledge is not surfaced to normal decision-making paths.
   *
   * Returns nodes ordered by confidence DESC, last_retrieved DESC.
   * Always applies a result limit (default 50, max 200) to prevent
   * hub-node explosion from pulling unbounded neighborhoods.
   */
  findNodes(filter: NodeFilter, limit?: number): Promise<KnowledgeNode[]>;

  /**
   * Delete a node by ID. Soft-delete only -- the node is marked inactive
   * but its history is preserved (CANON: schema deprecation, not deletion).
   * Associated edges are also soft-closed (valid_to set to now).
   *
   * Use case: guardian corrects a misidentification (the "mug" was actually
   * a vase). The old node is not erased -- it is evidence that the mistake
   * was made and corrected.
   */
  deprecateNode(nodeId: string, reason: string): Promise<void>;

  // -----------------------------------------------------------------------
  // Edge CRUD
  // -----------------------------------------------------------------------

  /**
   * Upsert an edge between two existing nodes.
   *
   * Provenance enforcement: same contract as upsertNode.
   *
   * Temporal correctness:
   * - If `input.supersedes_edge_id` is provided, the superseded edge has
   *   its valid_to set to now before the new edge is created. This is the
   *   correct pattern for guardian corrections.
   * - If an identical (from, to, rel_type) edge already exists and is
   *   currently valid (valid_to IS NULL), the implementation merges
   *   properties rather than creating a duplicate.
   *
   * @throws NodeNotFoundError if from_node_id or to_node_id do not exist
   * @throws ProvenanceMissingError if input.provenance is absent
   */
  upsertEdge(input: UpsertEdgeInput): Promise<KnowledgeEdge>;

  /**
   * Query edges by filter.
   *
   * `filter.currently_valid = true` is the default for operational queries
   * (returns only edges with valid_to IS NULL). Historical queries must
   * explicitly set this to false or provide `valid_at`.
   *
   * Temporal query: if `filter.valid_at` is set, returns edges where
   * valid_from <= valid_at AND (valid_to IS NULL OR valid_to > valid_at).
   *
   * Confidence threshold: same behavior as findNodes -- defaults to
   * RETRIEVAL threshold unless include_below_threshold is set via NodeFilter.
   * EdgeFilter should grow a matching `include_below_threshold` field in E3.
   */
  queryEdges(filter: EdgeFilter, limit?: number): Promise<KnowledgeEdge[]>;

  /**
   * Close an edge temporally (set valid_to = now).
   * Used when a spatial or relational fact changes.
   * The edge record is preserved -- temporal amnesia prevention.
   */
  closeEdge(edgeId: string, reason?: string): Promise<void>;

  // -----------------------------------------------------------------------
  // Context queries (for LLM context assembly -- called by Meridian/Vox)
  // -----------------------------------------------------------------------

  /**
   * Return a bounded subgraph centered on a seed node, suitable for
   * injection into an LLM prompt.
   *
   * Depth-limited traversal. The depth parameter is enforced hard -- the
   * implementation NEVER performs unbounded traversal. Default depth: 2.
   * Maximum permitted depth: 3.
   *
   * Only returns nodes and edges above the retrieval threshold (0.50).
   * Nodes below threshold are invisible to the LLM context path.
   *
   * Returns `total_reachable_beyond` so callers can signal incompleteness
   * to the LLM ("I know there is more context I cannot access right now").
   */
  queryContext(
    seedNodeId: string,
    depth?: number,
    relTypes?: string[],
  ): Promise<ContextSubgraph>;

  /**
   * Retrieve relevant procedures for a given action context.
   * Used by Decision Making's action retriever.
   *
   * Returns Procedure nodes with confidence >= threshold, ordered by
   * confidence DESC. Decision Making applies the dynamic threshold from
   * the current drive state.
   *
   * Only returns Type 1 eligible procedures when `type1Only` is true.
   */
  queryProcedures(
    contextLabels: string[],
    minConfidence: number,
    type1Only?: boolean,
    limit?: number,
  ): Promise<KnowledgeNode[]>;

  /**
   * Gap analysis: return nodes that have fewer than `minEdgeCount` outgoing
   * edges of any type. These are underdeveloped nodes -- candidates for
   * Curiosity-driven exploration.
   *
   * Used by Scout / Curiosity gap queries. Not for real-time decision paths.
   * Queries run against the full graph including below-threshold nodes.
   */
  queryGapNodes(minEdgeCount: number, limit?: number): Promise<KnowledgeNode[]>;

  /**
   * Provenance query: return the full provenance chain for a node or edge.
   * Used by the Lesion Test framework (Epic 10) and by Learning during
   * contradiction resolution.
   *
   * Returns all nodes and edges that contributed to the target's existence,
   * including superseded edges and deprecated nodes in the chain.
   */
  queryProvenanceChain(
    targetId: string,
    targetType: 'node' | 'edge',
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }>;

  // -----------------------------------------------------------------------
  // Confidence operations
  // -----------------------------------------------------------------------

  /**
   * Record a successful retrieval-and-use event for a node.
   *
   * This is the ONLY path through which a node's retrieval_count increments.
   * "Retrieval-and-use" means the knowledge was retrieved AND used in a
   * decision or utterance that was not negatively evaluated.
   *
   * Confidence is recomputed in the application layer after this call
   * using computeConfidence() from shared/types/confidence.types.ts.
   *
   * Immutable Standard 3: this is the gate through which confidence can
   * exceed 0.60.
   */
  recordNodeRetrievalAndUse(nodeId: string): Promise<void>;

  /**
   * Record a successful retrieval-and-use event for an edge.
   * Same contract as recordNodeRetrievalAndUse.
   */
  recordEdgeRetrievalAndUse(edgeId: string): Promise<void>;

  /**
   * Apply guardian confirmation to a node (2x weight per Immutable Standard 5).
   * Increases retrieval_count by 2 equivalent events and recomputes confidence.
   */
  applyGuardianConfirmation(nodeId: string): Promise<KnowledgeNode>;

  /**
   * Apply guardian correction to a node or edge (3x weight per Immutable Standard 5).
   * Reduces confidence on the corrected item and may trigger schema-level
   * updates if the correction implies a category error.
   *
   * This does NOT silently overwrite. It closes the incorrect edge/deprecated
   * the incorrect node, creates the corrected version, and records the
   * correction event in the provenance chain.
   */
  applyGuardianCorrection(
    targetId: string,
    targetType: 'node' | 'edge',
    correctionReason: string,
    replacement?: UpsertNodeInput | UpsertEdgeInput,
  ): Promise<void>;

  /**
   * Get Type 1 graduation status for a Procedure node.
   * Decision Making uses this to determine arbitration eligibility.
   */
  getProcedureType1Status(nodeId: string): Promise<ProcedureType1Status | null>;

  /**
   * Update prediction MAE for a Procedure node after evaluation.
   * Called by Decision Making's confidence updater after each prediction cycle.
   * If MAE > 0.15, the procedure is demoted (type1_eligible = false).
   */
  updateProcedurePredictionMae(nodeId: string, mae: number): Promise<ProcedureType1Status>;

  // -----------------------------------------------------------------------
  // Contradiction detection
  // -----------------------------------------------------------------------

  /**
   * Check whether a proposed upsert conflicts with existing WKG content.
   * Called by Learning before every upsertNode and upsertEdge.
   *
   * Contradictions are NOT suppressed (CANON: Piagetian disequilibrium).
   * This method returns the report. The caller decides how to proceed.
   *
   * Returns null if no contradiction detected.
   */
  checkContradiction(
    input: UpsertNodeInput | UpsertEdgeInput,
  ): Promise<ContradictionReport | null>;

  // -----------------------------------------------------------------------
  // Schema and graph health (used by Learning's maintenance cycles)
  // -----------------------------------------------------------------------

  /**
   * Return graph health metrics for the Learning and Drive Engine subsystems.
   * Includes: total node count, edge count, provenance distribution,
   * below-threshold node count, orphan subgraph count, hub node candidates.
   */
  getGraphHealthMetrics(): Promise<WkgHealthMetrics>;
}

/**
 * Graph health summary for monitoring and maintenance.
 * Returned by getGraphHealthMetrics().
 */
export interface WkgHealthMetrics {
  total_nodes: number;
  total_edges: number;
  provenance_distribution: Record<ProvenanceSource, number>;
  below_threshold_node_count: number;
  orphan_node_count: number;
  hub_node_candidates: Array<{ node_id: string; edge_count: number }>;
  type1_eligible_procedure_count: number;
  schema_type_count: number;
  last_maintenance_cycle: Date | null;
}
```

---

## 4. ISelfKgService

**File:** `src/knowledge/interfaces/self-kg.service.interface.ts`

The Self KG is read by the Drive Engine for self-evaluation on a slower timescale than drive ticks. It is written by the Learning subsystem during maintenance cycles. The interface is small and focused -- the Self KG is not a mirror of the WKG.

```typescript
import {
  SelfModel,
  SelfCapability,
  SelfStateSnapshot,
  SelfKnowledgeDomain,
} from '../../shared/types/knowledge.types';

export interface ISelfKgService {

  /**
   * Return the complete current self-model.
   * Called by the Drive Engine's self-evaluation component on the slower
   * timescale (not every drive tick -- every N ticks, configurable).
   *
   * Returns null if the self-model has not yet been initialized (very early
   * in operation). The Drive Engine must handle this gracefully.
   */
  getCurrentModel(): Promise<SelfModel | null>;

  /**
   * Record a capability assessment update.
   * Called by Learning after evaluating prediction accuracy for a domain.
   *
   * The Self KG update timescale is enforced by the caller (Learning),
   * not by this service. The service accepts all writes and applies them.
   */
  updateCapability(capability: Omit<SelfCapability, 'node_id'>): Promise<SelfCapability>;

  /**
   * Append a state snapshot.
   * Called by the Drive Engine's self-evaluation loop (slower timescale path).
   *
   * Snapshots accumulate over time. The service retains the last N snapshots
   * (configurable, default 50). Older snapshots are archived, not deleted.
   * Archiving strategy is deferred to Epic 3.
   */
  appendStateSnapshot(snapshot: Omit<SelfStateSnapshot, 'snapshot_id'>): Promise<SelfStateSnapshot>;

  /**
   * Update a knowledge domain self-assessment.
   * Called by Learning when the WKG grows in a recognizable domain.
   *
   * The Self KG's domain record is Sylphie's self-perception of her knowledge
   * coverage -- it may differ from actual WKG node counts. The gap between
   * estimated_coverage and actual coverage is the interoceptive accuracy metric.
   */
  updateKnowledgeDomain(domain: Omit<SelfKnowledgeDomain, 'node_id'>): Promise<SelfKnowledgeDomain>;

  /**
   * Return the most recent N state snapshots, ordered newest first.
   * Used by the Drive Engine for trend analysis.
   */
  getRecentSnapshots(limit: number): Promise<SelfStateSnapshot[]>;

  /**
   * Return interoceptive accuracy: correlation between self_rated_confidence
   * and actual_success_rate across all assessed capabilities.
   * Returns null if fewer than 3 capabilities have been assessed.
   */
  getInteroceptiveAccuracy(): Promise<number | null>;

  /**
   * Initialize the self-model on first run.
   * Creates the singleton Self node. No-op if already initialized.
   * Called by the Knowledge module's onApplicationBootstrap hook.
   */
  initialize(): Promise<void>;
}
```

---

## 5. IOtherKgService

**File:** `src/knowledge/interfaces/other-kg.service.interface.ts`

One Grafeo instance per person. The isolation pattern is enforced by requiring `personId` as the first parameter on every method. No cross-person query is permitted through this interface.

```typescript
import {
  PersonModel,
  UpdatePersonModelInput,
  PersonPreference,
  PersonCommStyle,
  PersonObservedState,
  PersonTopicInterest,
} from '../../shared/types/knowledge.types';

export interface IOtherKgService {

  /**
   * Return the full person model for a given person.
   * Returns null if no model exists (first interaction -- call `initializePerson` first).
   *
   * Per-person isolation: each call operates on the Grafeo instance keyed
   * by personId. No data crosses between persons.
   */
  getPersonModel(personId: string): Promise<PersonModel | null>;

  /**
   * Initialize a new person model.
   * Creates a new isolated Grafeo instance for this person if one does not
   * already exist. If the instance already exists, this is a no-op.
   *
   * Called by Communication when a new guardian or person is first encountered.
   */
  initializePerson(personId: string, name: string, role: string): Promise<PersonModel>;

  /**
   * Merge an observation update into an existing person model.
   * All fields in the input are optional -- only provided fields are updated.
   *
   * Provenance is supplied in the observation data itself (preferences and
   * observed states carry provenance tags). Comm style and topic interest
   * observations are always INFERENCE (derived from interaction patterns).
   *
   * @throws PersonNotFoundError if the person has not been initialized
   */
  updatePersonModel(input: UpdatePersonModelInput): Promise<PersonModel>;

  /**
   * Return inferred communication style for a person.
   * Returns null if fewer than `minObservations` interactions have occurred
   * (configurable, default 5 -- insufficient data for reliable inference).
   */
  getCommStyle(personId: string): Promise<PersonCommStyle | null>;

  /**
   * Return topics the person has shown interest in, ordered by interest_level DESC.
   * Used by Communication for response tailoring.
   */
  getTopicInterests(personId: string, limit?: number): Promise<PersonTopicInterest[]>;

  /**
   * Return the most recently observed state for a person.
   * Returns null if no states have been observed.
   * Used by Communication's Other Evaluation path before response generation.
   */
  getMostRecentState(personId: string): Promise<PersonObservedState | null>;

  /**
   * Increment interaction count and update last_interaction timestamp.
   * Called by Communication at the start of each interaction session.
   */
  recordInteraction(personId: string): Promise<void>;

  /**
   * Return a list of all known person IDs.
   * Used by the Web module's graph visualization API.
   */
  listPersonIds(): Promise<string[]>;

  /**
   * Return lightweight summary of all person models (no detailed observations).
   * Used for dashboard display.
   */
  listPersonSummaries(): Promise<Array<{
    person_id: string;
    name: string;
    role: string;
    interaction_count: number;
    last_interaction: Date;
  }>>;
}
```

---

## 6. IConfidenceService

**File:** `src/knowledge/interfaces/confidence.service.interface.ts`

Wraps the pure `computeConfidence()` function from shared types with stateful services: retrieval tracking, batch recomputation, and ceiling enforcement. The pure function in shared types handles the math. This service handles the I/O.

```typescript
import { ACTRParams } from '../../shared/types/confidence.types';
import { ProvenanceSource } from '../../shared/types/provenance.types';

export interface IConfidenceService {

  /**
   * Compute current confidence for a node or edge without modifying it.
   * Delegates to the pure computeConfidence() function from shared types.
   *
   * This is the read-only path -- callers can compute expected confidence
   * without triggering a write. Used by arbitration logic and threshold checks.
   */
  compute(params: ACTRParams): number;

  /**
   * Return the initialized base confidence for a given provenance source.
   * Wraps PROVENANCE_BASE_CONFIDENCE from shared types.
   */
  getBase(provenance: ProvenanceSource): number;

  /**
   * Record a retrieval-and-use event and recompute confidence.
   * This is the ONLY path through which retrieval_count increments.
   *
   * Validates:
   * - Ceiling enforcement: if resulting confidence would exceed 0.60 and
   *   this is the FIRST retrieval event, clamp to 0.60. The ceiling only
   *   applies to the first use; subsequent uses can exceed it.
   * - Guardian multipliers: if `guardianWeight` is 2 or 3, the count
   *   increment is multiplied accordingly (Immutable Standard 5).
   *
   * Returns the new confidence value.
   */
  recordUse(params: {
    currentBase: number;
    currentCount: number;
    hoursSinceRetrieval: number;
    decayRate: number;
    guardianWeight?: 1 | 2 | 3; // default 1; 2 = confirmation, 3 = correction
  }): { newCount: number; newConfidence: number };

  /**
   * Enforce the confidence ceiling (Immutable Standard 3).
   * Returns the clamped value. Does not modify the node -- pure enforcement.
   *
   * Rule: if retrieval_count === 0, confidence cannot exceed CEILING_UNTESTED (0.60).
   * This is called by upsertNode and upsertEdge before writing to the graph.
   */
  checkCeiling(confidence: number, retrievalCount: number): number;

  /**
   * Batch recompute confidence for all nodes/edges in the WKG.
   * Called by Learning's maintenance cycle to apply temporal decay across
   * the full graph (hoursSinceRetrieval has changed for all nodes).
   *
   * This is a potentially expensive operation -- restricted to maintenance
   * cycles, never called on real-time decision paths.
   *
   * Returns a summary: how many nodes updated, how many fell below threshold.
   */
  batchRecompute(): Promise<{ nodes_updated: number; fell_below_threshold: number }>;

  /**
   * Return nodes/edges whose confidence has decayed below the retrieval
   * threshold since the last maintenance cycle.
   * These are candidates for targeted re-retrieval or archival.
   */
  queryDecayedKnowledge(sinceDate: Date): Promise<Array<{
    id: string;
    type: 'node' | 'edge';
    old_confidence: number;
    new_confidence: number;
  }>>;
}
```

---

## 7. Three-Graph Isolation Enforcement

Isolation is enforced at four layers, which together prevent cross-contamination from compile time through runtime:

### Layer 1: Separate DI Token Symbols

`WKG_SERVICE`, `SELF_KG_SERVICE`, and `OTHER_KG_SERVICE` are distinct JavaScript Symbols. NestJS DI cannot accidentally satisfy a `WKG_SERVICE` injection point with a `SELF_KG_SERVICE` provider -- the tokens are unique.

### Layer 2: Structurally Incompatible Interfaces

`IWkgService`, `ISelfKgService`, and `IOtherKgService` have completely different method signatures. TypeScript structural typing cannot accidentally substitute one for another -- they share zero compatible method shapes.

### Layer 3: Separate Type Hierarchies

WKG types (`KnowledgeNode`, `KnowledgeEdge`) carry `GraphStore = 'WKG'` in their structure. Self KG types (`SelfModel`, `SelfCapability`) have no overlapping fields with WKG types. Other KG types (`PersonModel`) have no overlapping fields with WKG types. There is no shared generic base type that could be passed as either.

### Layer 4: Database-Level Isolation (Epic 3)

WKG lives in a dedicated Neo4j database. Each person's Other KG lives in its own Grafeo instance keyed by `personId`. The Self KG lives in a dedicated Grafeo instance separate from all person instances. The Knowledge module manages a `Map<string, GrafeoInstance>` for Other KG instances -- there is no global Other KG; there is only "Jim's KG," "Person_Alice's KG," etc. The module never passes an instance from that map to any WKG operation.

**Anti-pattern that the types prevent:** A developer could not, even accidentally, write:

```typescript
// This fails to compile -- PersonModel is not assignable to KnowledgeNode
const node: KnowledgeNode = await this.otherKg.getPersonModel('person_jim');
```

### Layer 5: Module Import Boundaries (compile-level)

The Knowledge module exposes only the interfaces and tokens. Consumers import from `src/knowledge/index.ts`. The barrel export includes the interfaces, tokens, and shared types -- but never the concrete service implementations. This prevents any module from doing `new WkgService()` and bypassing DI.

---

## 8. Type Dependency Tree

Types must exist before interfaces compile. Required creation order:

```
src/shared/types/
  provenance.types.ts     (no dependencies)
  confidence.types.ts     (no dependencies -- pure function)
  knowledge.types.ts      (depends on: provenance.types.ts)

src/knowledge/
  knowledge.tokens.ts     (no dependencies)
  interfaces/
    wkg.service.interface.ts       (depends on: knowledge.types.ts, provenance.types.ts)
    self-kg.service.interface.ts   (depends on: knowledge.types.ts)
    other-kg.service.interface.ts  (depends on: knowledge.types.ts, provenance.types.ts)
    confidence.service.interface.ts (depends on: confidence.types.ts, provenance.types.ts)
```

**Flagged missing types that other agents will also need:**

1. `WkgHealthMetrics` -- defined inline above in `wkg.service.interface.ts`. Consider whether this belongs in `knowledge.types.ts` instead (it is returned by a service method and may be consumed by the Web module for dashboard display). Recommendation: move it to `knowledge.types.ts` and re-export from the interfaces file.

2. `ProvenanceMissingError`, `ConfidenceCeilingViolationError`, `NodeNotFoundError`, `PersonNotFoundError` -- referenced in JSDoc above. These belong in `src/shared/exceptions/`. Sentinel or Forge should define the base `SylphieException` class that these extend. Epic 0 requires at least stub exception classes so the interface JSDoc comments are accurate.

3. `drive.types.ts` is referenced in `SelfStateSnapshot.drive_vector` (keyed by drive name). The interface currently uses `Record<string, number>` to avoid a circular dependency on drive types. In Epic 3, this should be tightened to `Partial<Record<DriveName, number>>` once `DriveName` is available from `src/shared/types/drive.types.ts`.

4. The `ContextSubgraph.total_reachable_beyond` field is sound but requires the WKG service to run a COUNT query beyond the depth limit. This is an additional Cypher query. Flag for Sentinel: two queries per `queryContext` call (the subgraph traversal plus the count query). If this proves too expensive in production, `total_reachable_beyond` can be demoted to optional.

---

## 9. Risks

### Risk 1: `UpsertEdgeInput.edge_id` Optional Field

Edge IDs are optional in the input (service generates them if absent). This is the common case for Learning's edge refinement pipeline. However, it creates a risk: if Learning calls `upsertEdge` twice for semantically identical edges (same from/to/rel_type), are they merged or duplicated? The interface contract says "merge if identical currently-valid edge exists." The implementation must enforce this with a graph-level uniqueness constraint on (from_node_id, to_node_id, rel_type, valid_to=null). If the constraint is missing in Epic 3, Learning will silently create duplicate edges that inflate retrieval counts.

**Mitigation:** Add a note in the stub implementation that this constraint must be enforced via a Neo4j composite index or uniqueness constraint in Epic 3. Flag it in the E3 planning document.

### Risk 2: `queryContext` Depth Limit Is Too Shallow for Planning

Planning's research service needs to identify event patterns around an opportunity, which may require traversing the WKG at depth 3-4 to find relevant procedural context. The current hard max of depth 3 may be insufficient. However, raising it for Planning's research path creates a performance risk on the real-time decision path.

**Mitigation:** Consider a separate `queryContextDeep` method or a `maxDepth` override parameter that requires the caller to explicitly acknowledge the performance cost. Planning's research path is not latency-sensitive (runs asynchronously), so a higher depth limit is acceptable there. This is a breaking change if added after Epic 3 unless the parameter is designed in now.

**Recommendation:** Add an optional `maxDepth: number` parameter to `queryContext` now, with the stub clamping it to 3. Epic 3 can then decide the actual ceiling for non-real-time callers.

### Risk 3: Self KG Update Timescale Is Caller-Enforced

The requirement that the Self KG updates on a slower timescale than drive ticks (CANON: Subsystem 4, drive.md Rule 8) is not enforced by `ISelfKgService` itself. The interface accepts all writes. The timescale discipline is the caller's (Drive Engine's) responsibility. If the Drive Engine implementation calls `appendStateSnapshot` on every tick, the Self KG will accumulate identity-locking data at tick frequency.

**Mitigation:** The interface could enforce minimum intervals (e.g., reject writes if the last snapshot was less than N seconds ago). However, this couples the service to a policy decision that belongs in configuration. Recommendation: document the timescale requirement in the interface JSDoc, expose a `getLastSnapshotTimestamp()` method so callers can check before writing, and enforce the interval in the Drive Engine's self-evaluation component rather than in the service.

**Additional method needed:** `getLastSnapshotTimestamp(): Promise<Date | null>` on `ISelfKgService`. This is missing from the current interface and should be added.

### Risk 4: Grafeo Technology Risk

The roadmap (Epic 1) explicitly flags this: "Key risk: Grafeo availability. If Grafeo doesn't exist as a mature library, evaluate alternatives." The `ISelfKgService` and `IOtherKgService` interfaces are designed to be technology-agnostic -- they hide all Grafeo internals. If Grafeo is replaced with an embedded SQLite-based graph or a Memgraph-based solution, the interfaces do not change. This is the primary reason the interfaces exist at all.

The interfaces will survive a Grafeo substitution cleanly. The only risk is if the alternative does not support Cypher, which would require changes to any Cypher strings embedded in stub comments. Recommendation: keep Cypher examples in JSDoc comments only (they are documentation, not code), so a substitution affects only the implementation, never the interface.

### Risk 5: `PersonModel` Returns All Observations

The current `getPersonModel()` returns the full `PersonModel` including all observations, all preferences, all state history. For a person with hundreds of interactions, this becomes a large payload that Communication must then filter for relevance.

**Mitigation:** Consider adding a lightweight `getPersonContext(personId: string, topicHint?: string)` method that returns a pre-filtered view of the person model relevant to a specific interaction context. This avoids Communication loading and discarding hundreds of observations on every response generation call. This is not a breaking change if added later but it is cleaner to design it in now as a second method, leaving `getPersonModel` for full access.

### Risk 6: Confidence Recomputation Timing

The ACT-R formula requires `hoursSinceRetrieval` as an input. This means confidence is computed lazily at read time (not stored as a static value). The `KnowledgeNode.provenance_envelope.confidence` field in the interface is therefore a snapshot value, not a live computed value. If a node is read, its confidence is computed at that moment and stored back. If it is never read, its stored confidence becomes stale.

The batch recomputation in `IConfidenceService.batchRecompute()` addresses stale values for nodes that have not been read recently. However, the stored value and the computed value can diverge between maintenance cycles.

**Implication for callers:** Any consumer that compares a stored `confidence` field to a threshold (e.g., Decision Making checking arbitration eligibility) must call `IConfidenceService.compute()` with the node's current params rather than trusting the stored value. This needs to be documented explicitly in the `KnowledgeNode` type definition with a JSDoc warning: "confidence is a snapshot value from last read or maintenance cycle; for arbitration, recompute using IConfidenceService.compute()."

### Risk 7: Contradiction Report Does Not Trigger Automatically

`checkContradiction()` is a method that Learning must call explicitly before every upsert. If Learning's implementation skips this check, contradictions silently overwrite knowledge. The interface cannot enforce mandatory pre-upsert contradiction checking.

**Mitigation:** `upsertNode` and `upsertEdge` could optionally accept a `skipContradictionCheck: boolean` parameter (default false), and when false, run the contradiction check internally before writing. This makes contradiction detection automatic rather than optional. The downside is that every write pays the contradiction check cost even when Learning has already run it.

Recommendation: run the contradiction check inside `upsertNode`/`upsertEdge` by default, return both the write result and any contradiction report in a discriminated union, and let Learning handle the report. This is a more robust design than relying on callers to remember to call `checkContradiction()` first. This requires changing the return type of `upsertNode` to `Promise<{ node: KnowledgeNode; contradiction: ContradictionReport | null }>`.

This is a potentially breaking change to the interface. Flag it now so it is resolved before Epic 3 implementation begins rather than after.

---

## Summary

**Interfaces defined:** `IWkgService`, `ISelfKgService`, `IOtherKgService`, `IConfidenceService`

**Types defined:** `KnowledgeNode`, `KnowledgeEdge`, `UpsertNodeInput`, `UpsertEdgeInput`, `NodeFilter`, `EdgeFilter`, `ContextSubgraph`, `ContradictionReport`, `ProcedureType1Status`, `WkgHealthMetrics`, `SelfModel`, `SelfCapability`, `SelfStateSnapshot`, `SelfKnowledgeDomain`, `PersonModel`, `PersonPreference`, `PersonCommStyle`, `PersonObservedState`, `PersonTopicInterest`, `UpdatePersonModelInput`, `NodeProvenance`, `EdgeProvenance`, `ACTRParams`, `ProvenanceSource`, `WkgNodeCategory`, `WkgNodeLabel`, `GraphStore`

**DI tokens defined:** `WKG_SERVICE`, `SELF_KG_SERVICE`, `OTHER_KG_SERVICE`, `CONFIDENCE_SERVICE`, `NEO4J_DRIVER`

**Missing types flagged:** `WkgHealthMetrics` (move to knowledge.types.ts), `ProvenanceMissingError`, `ConfidenceCeilingViolationError`, `NodeNotFoundError`, `PersonNotFoundError` (belong in shared/exceptions/), `DriveName` reference in SelfStateSnapshot (tighten in E3)

**Recommended interface changes before E3 begins:**
1. Add `maxDepth` parameter to `queryContext`
2. Add `getLastSnapshotTimestamp()` to `ISelfKgService`
3. Add `getPersonContext()` to `IOtherKgService`
4. Change `upsertNode`/`upsertEdge` return type to include optional contradiction report
5. Add `getPersonContext` lightweight method to `IOtherKgService`
