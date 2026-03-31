/**
 * Knowledge module interface contracts.
 *
 * Four interfaces govern all knowledge graph access in Sylphie:
 *
 * - IWkgService:        World Knowledge Graph (Neo4j). The shared brain.
 * - ISelfKgService:     Self Knowledge Graph (Grafeo). Sylphie's self-model.
 * - IOtherKgService:    Per-person Knowledge Graphs (Grafeo). Models of others.
 * - IConfidenceService: Stateful ACT-R confidence tracking across the WKG.
 *
 * CANON §The World Knowledge Graph Is the Brain: Everything either writes to
 * or reads from the WKG. These interfaces are the only legal access points.
 *
 * CANON §7 (Provenance Is Sacred): provenance is REQUIRED on every upsert
 * method. No upsert request type has an optional provenance field. Omitting
 * provenance is a compile error, not a runtime warning.
 *
 * CANON §Confidence Dynamics: Every node and edge carries ACTRParams.
 * IConfidenceService wraps the pure computeConfidence() function with the
 * stateful side effects required by the Confidence Ceiling (Standard 3) and
 * Guardian Asymmetry (Standard 5).
 *
 * Module isolation: Self KG and Other KG are completely isolated from the WKG
 * and from each other. No shared edges, no cross-contamination. These are
 * modeled as separate interfaces (and in production, separate Grafeo instances).
 */

import type { ACTRParams } from '../../shared/types/confidence.types';
import type {
  KnowledgeNode,
  KnowledgeEdge,
  NodeFilter,
  EdgeFilter,
  NodeUpsertRequest,
  EdgeUpsertRequest,
  NodeUpsertResult,
  EdgeUpsertResult,
  NodeLevel,
} from '../../shared/types/knowledge.types';
import type { ProvenanceSource } from '../../shared/types/provenance.types';
import type { ActionCandidate } from '../../shared/types/action.types';

// ---------------------------------------------------------------------------
// Auxiliary types for WKG statistics
// ---------------------------------------------------------------------------

/**
 * Aggregate statistics about the current state of the World Knowledge Graph.
 *
 * Used by health-check dashboards and the Learning subsystem to gauge graph
 * growth rate across provenance sources and structural levels.
 */
export interface GraphStats {
  /** Total number of nodes currently in the WKG. */
  readonly totalNodes: number;

  /** Total number of edges (relationships) currently in the WKG. */
  readonly totalEdges: number;

  /**
   * Node count broken down by provenance source.
   * Key is a ProvenanceSource string value. Zero-count provenances are omitted.
   */
  readonly byProvenance: Readonly<Record<string, number>>;

  /**
   * Node count broken down by structural level.
   * All three NodeLevel values are always present (zero if none at that level).
   */
  readonly byLevel: Readonly<Record<NodeLevel, number>>;
}

/**
 * A single daily bucket in the vocabulary growth time series.
 *
 * Used by the Observatory vocabulary-growth endpoint to render a graph of
 * how many WKG nodes were created each day, broken down by label and provenance.
 */
export interface VocabularyGrowthDay {
  /** ISO 8601 date string for this bucket (YYYY-MM-DD). */
  readonly date: string;

  /** Number of new nodes created on this day. */
  readonly newNodes: number;

  /** Running total of all nodes created on or before this day. */
  readonly cumulativeTotal: number;

  /** New node count keyed by Neo4j label ('Entity', 'Concept', etc.). */
  readonly byLabel: Readonly<Record<string, number>>;

  /** New node count keyed by provenance source. */
  readonly byProvenance: Readonly<Record<string, number>>;
}

/**
 * Phrase recognition summary drawn from WKG Utterance nodes.
 *
 * Used by the Observatory phrase-recognition endpoint to show what fraction
 * of Utterance nodes have confidence above the retrieval threshold (0.50).
 */
export interface PhraseRecognitionStats {
  /** Total number of Utterance nodes in the WKG. */
  readonly totalUtterances: number;

  /** Number of Utterance nodes with confidence > 0.50 (retrieval threshold). */
  readonly recognizedCount: number;

  /** recognizedCount / totalUtterances. NaN if totalUtterances is zero. */
  readonly ratio: number;

  /** Recognized utterance count keyed by provenance source. */
  readonly byProvenance: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Auxiliary types for Self KG
// ---------------------------------------------------------------------------

/**
 * Sylphie's self-model as persisted in KG(Self).
 *
 * Describes her current self-concept: capabilities, identity propositions,
 * and meta-cognitive awareness. The Planning subsystem consults this when
 * generating plans that require self-awareness (e.g., "I can do X").
 *
 * CANON §Self KG isolation: This model is completely separate from the WKG.
 * No WKG node IDs appear here; no Self KG node IDs appear in the WKG.
 */
export interface SelfModel {
  /** The primary self-concept proposition. e.g., "I am an AI companion." */
  readonly primaryConcept: string;

  /** Confidence in the primary concept in [0.0, 1.0]. */
  readonly primaryConceptConfidence: number;

  /** Provenance of the primary concept node. */
  readonly primaryConceptProvenance: ProvenanceSource;

  /** All known capabilities as of the last snapshot. */
  readonly capabilities: readonly SelfCapability[];

  /** All active self-patterns as of the last snapshot. */
  readonly patterns: readonly SelfPattern[];

  /** Wall-clock time of the most recent self-evaluation. */
  readonly lastEvaluatedAt: Date | null;
}

/**
 * A discrete capability node in KG(Self).
 *
 * A capability is a stable learned skill: "I can respond in French",
 * "I can produce plan summaries", "I can recognize Jim's tone".
 * Capabilities are created by Learning consolidation when a behavior has
 * been Type 1–graduated and confirmed by guardian feedback at least once.
 */
export interface SelfCapability {
  /** Unique ID within KG(Self). */
  readonly id: string;

  /** Human-readable capability name. e.g., "respond-in-french". */
  readonly name: string;

  /** Confidence that this capability is currently reliable in [0.0, 1.0]. */
  readonly confidence: number;

  /** Provenance of this capability node. */
  readonly provenance: ProvenanceSource;

  /** ACT-R parameters for confidence dynamics on this capability. */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this capability was first recorded. */
  readonly createdAt: Date;
}

/**
 * A behavioral pattern Sylphie has recognized about herself.
 *
 * Patterns are higher-order observations: "I tend to express curiosity when
 * Jim asks open-ended questions." They are produced by Learning consolidation
 * and carry BEHAVIORAL_INFERENCE provenance unless confirmed by a guardian.
 */
export interface SelfPattern {
  /** Unique ID within KG(Self). */
  readonly id: string;

  /** Natural-language description of the pattern. */
  readonly description: string;

  /** Provenance of this pattern observation. */
  readonly provenance: ProvenanceSource;

  /** How many times this pattern has been observed. Drives ACT-R confidence. */
  readonly observationCount: number;

  /** Confidence in this pattern's accuracy in [0.0, 1.0]. */
  readonly confidence: number;

  /** Wall-clock time this pattern was first recorded. */
  readonly createdAt: Date;

  /** Wall-clock time this pattern was most recently updated. */
  readonly updatedAt: Date;
}

/**
 * A structured self-evaluation event for KG(Self).
 *
 * Emitted by the Learning subsystem after each Observation phase to record
 * Sylphie's own assessment of how an episode went. These feed the
 * Depressive Attractor detection (CANON Known Attractor States) — if
 * self-evaluations trend consistently negative, that is a behavioral signal.
 */
export interface SelfEvaluation {
  /**
   * Correlation ID linking this evaluation to the original event (from
   * TimescaleDB) that triggered it.
   */
  readonly correlationId: string;

  /**
   * Summary of the evaluation in natural language.
   * e.g., "Response was accurate; Jim confirmed the information."
   */
  readonly summary: string;

  /**
   * Overall valence of this evaluation: positive, neutral, or negative.
   * Drives the Depressive Attractor watchdog.
   */
  readonly valence: 'positive' | 'neutral' | 'negative';

  /**
   * Drive effects this episode produced, keyed by drive name.
   * Partial — only drives with non-zero effects are included.
   */
  readonly driveEffects: Readonly<Record<string, number>>;

  /** Whether this episode was flagged for guardian review. */
  readonly flaggedForReview: boolean;

  /** Wall-clock time of this evaluation. */
  readonly evaluatedAt: Date;
}

// ---------------------------------------------------------------------------
// Auxiliary types for Other KG
// ---------------------------------------------------------------------------

/**
 * A model of a specific person, stored in their dedicated KG(Other_<personId>).
 *
 * Each person Sylphie interacts with has an isolated Grafeo instance.
 * PersonModel is the top-level summary retrieved from that instance.
 *
 * CANON §Other KG isolation: No KG(Other_Jim) nodes appear in the WKG or
 * in KG(Self). These are completely separate graph instances.
 */
export interface PersonModel {
  /** Stable identifier for this person. e.g., "person_jim". */
  readonly personId: string;

  /** Display name. e.g., "Jim". */
  readonly name: string;

  /** All known personality traits and their confidence values. */
  readonly traits: readonly PersonTrait[];

  /** Number of recorded interactions with this person. */
  readonly interactionCount: number;

  /** Wall-clock time of the most recent recorded interaction. */
  readonly lastInteractionAt: Date | null;

  /** Wall-clock time this person model was first created. */
  readonly createdAt: Date;
}

/**
 * A personality or behavioral trait for a specific person.
 *
 * Traits are inferred from interaction history (BEHAVIORAL_INFERENCE) and
 * confirmed or corrected by guardian feedback (GUARDIAN). Examples:
 * "prefers-direct-answers", "responds-well-to-humour", "dislikes-repetition".
 */
export interface PersonTrait {
  /** Unique ID within this person's KG(Other). */
  readonly id: string;

  /** Name of the trait. Human-readable slug. e.g., "prefers-direct-answers". */
  readonly name: string;

  /** Confidence in this trait being accurate in [0.0, 1.0]. */
  readonly confidence: number;

  /** Provenance of this trait observation. */
  readonly provenance: ProvenanceSource;

  /** ACT-R parameters tracking confidence dynamics for this trait. */
  readonly actrParams: ACTRParams;

  /** Wall-clock time this trait was first recorded. */
  readonly createdAt: Date;
}

/**
 * Update payload for modifying a person model.
 *
 * All fields are optional — only supplied fields are updated. At least one
 * field must be present. Callers should use `Partial` semantics and let the
 * implementation merge with the existing model.
 */
export interface PersonModelUpdate {
  /** New display name, if changed. */
  readonly name?: string;

  /**
   * Traits to upsert (add or update). Existing traits not present in this
   * array are left untouched. Provenance of new traits is required.
   */
  readonly traitsToUpsert?: ReadonlyArray<
    Omit<PersonTrait, 'id' | 'actrParams' | 'createdAt'>
  >;

  /**
   * IDs of traits to remove from this person's model.
   * Used when guardian corrects a wrongly inferred trait.
   */
  readonly traitIdsToRemove?: readonly string[];
}

/**
 * A recorded interaction event for a specific person.
 *
 * Interactions are the raw history log within KG(Other). The Learning
 * subsystem uses them to infer and update PersonTrait nodes via
 * consolidation cycles.
 */
export interface PersonInteraction {
  /** Unique ID of this interaction record. Assigned at persistence time. */
  readonly id: string;

  /**
   * Short label describing what kind of interaction occurred.
   * e.g., "guardian-correction", "open-ended-question", "positive-response",
   * "clarification-request"
   */
  readonly interactionType: string;

  /** Summary of what happened. Human-readable for audit trail. */
  readonly summary: string;

  /**
   * Observed drive effects on Sylphie during this interaction.
   * Partial — only non-zero effects. Used to correlate interaction types
   * with drive outcomes for trait inference.
   */
  readonly driveEffectsObserved: Readonly<Record<string, number>>;

  /** Correlation ID linking this interaction to the originating TimescaleDB event. */
  readonly correlationId: string;

  /** Wall-clock time this interaction was recorded. */
  readonly recordedAt: Date;
}

// ---------------------------------------------------------------------------
// IWkgService
// ---------------------------------------------------------------------------

/**
 * Interface for all World Knowledge Graph operations.
 *
 * CANON §The World Knowledge Graph Is the Brain: The WKG is not a feature —
 * it IS the system. IWkgService is the single legal gateway into Neo4j.
 * No subsystem may hold a direct Neo4j driver; all graph access is through
 * this interface.
 *
 * Injection token: WKG_SERVICE (see knowledge.tokens.ts).
 *
 * Provenance discipline: every upsert method receives a request that
 * requires provenance. The implementation enforces the Confidence Ceiling
 * (Standard 3): no node or edge is created with confidence > 0.60.
 *
 * Contradiction handling: upsertNode and upsertEdge return discriminated
 * union results (NodeUpsertResult, EdgeUpsertResult) rather than throwing on
 * conflict. Callers must handle the 'contradiction' branch — typically by
 * emitting a CONTRADICTION_DETECTED event and deferring resolution to a
 * guardian review queue.
 */
export interface IWkgService {
  /**
   * Upsert a node into the World Knowledge Graph.
   *
   * If a node with matching labels+properties already exists, its properties
   * and confidence are updated according to ACT-R dynamics. If the incoming
   * node conflicts with existing knowledge, the result discriminant is
   * 'contradiction' and no write is performed.
   *
   * The Confidence Ceiling (Standard 3) is enforced at write time: even if
   * initialConfidence exceeds 0.60, it will be clamped to the ceiling for
   * any node with count === 0.
   *
   * @param request - Node upsert payload. provenance is REQUIRED.
   * @returns NodeUpsertResult discriminated union: 'success' or 'contradiction'.
   * @throws KnowledgeException if the Neo4j write fails.
   */
  upsertNode(request: NodeUpsertRequest): Promise<NodeUpsertResult>;

  /**
   * Upsert an edge (relationship) between two existing nodes.
   *
   * Both sourceId and targetId must already exist in the WKG. If either
   * node is missing, throws KnowledgeException with NodeNotFoundError context.
   *
   * If an edge of the same relationship type between these nodes exists but
   * conflicts, the result discriminant is 'contradiction'.
   *
   * @param request - Edge upsert payload. provenance is REQUIRED.
   * @returns EdgeUpsertResult discriminated union: 'success' or 'contradiction'.
   * @throws KnowledgeException if either node is missing or the Neo4j write fails.
   */
  upsertEdge(request: EdgeUpsertRequest): Promise<EdgeUpsertResult>;

  /**
   * Retrieve a single node by its Neo4j element ID.
   *
   * Does not apply the retrieval threshold — returns the node regardless of
   * confidence. Use querySubgraph with a minConfidence filter to enforce the
   * threshold in bulk retrieval scenarios.
   *
   * @param id - Neo4j element ID string.
   * @returns The node, or null if no node with that ID exists.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  findNode(id: string): Promise<KnowledgeNode | null>;

  /**
   * Find nodes by label and optional structural level.
   *
   * Returns all nodes carrying the given label, optionally filtered by
   * nodeLevel. Does NOT apply a default confidence threshold — callers that
   * want retrieval-threshold filtering should pass minConfidence via querySubgraph.
   *
   * Used by the Communication subsystem for fast label-based context lookups.
   *
   * @param label      - A Neo4j label to match (e.g., 'Person', 'Action').
   * @param nodeLevel  - Optional structural level filter.
   * @returns All matching nodes, unordered.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  findNodeByLabel(label: string, nodeLevel?: NodeLevel): Promise<KnowledgeNode[]>;

  /**
   * Query edges matching the given filter.
   *
   * At least one of filter.sourceId or filter.targetId should be provided to
   * anchor the traversal. An unanchored edge query is permissible but may be
   * slow on large graphs.
   *
   * The default confidence threshold (CONFIDENCE_THRESHOLDS.retrieval = 0.50)
   * is applied unless filter.minConfidence explicitly overrides it.
   *
   * @param filter - Edge filter criteria.
   * @returns Matching edges, unordered.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  queryEdges(filter: EdgeFilter): Promise<KnowledgeEdge[]>;

  /**
   * Query action procedure candidates for a given category.
   *
   * Used by the Decision Making subsystem's Action Retrieval service to
   * assemble candidates for Type 1 / Type 2 arbitration. Only procedures
   * at or above minConfidence (default: CONFIDENCE_THRESHOLDS.retrieval) are
   * returned — this is the mechanism that prevents low-confidence procedures
   * from entering the candidate pool (Shrug Imperative, Standard 4).
   *
   * @param category      - Procedure category (e.g., 'ConversationalResponse').
   * @param minConfidence - Minimum confidence threshold. Defaults to 0.50.
   * @returns ActionCandidate array, ordered by confidence descending.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  queryActionCandidates(
    category: string,
    minConfidence?: number,
  ): Promise<ActionCandidate[]>;

  /**
   * Query the local subgraph around a specific entity.
   *
   * Returns all nodes and edges reachable from entityId within maxDepth hops.
   * Used by the Communication subsystem to build a context window for response
   * generation — the LLM receives the context subgraph, not raw Cypher results.
   *
   * The retrieval threshold (0.50) is applied to both nodes and edges unless
   * a caller-level override is implemented in the concrete service.
   *
   * @param entityId  - WKG node ID to traverse from.
   * @param maxDepth  - Maximum traversal depth. Defaults to 2.
   * @returns Object with arrays of reachable nodes and edges.
   * @throws KnowledgeException if the traversal query fails.
   */
  queryContext(
    entityId: string,
    maxDepth?: number,
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }>;

  /**
   * Query a filtered subgraph across the entire WKG.
   *
   * Applies NodeFilter criteria to produce a bounded set of nodes, then
   * retrieves the edges connecting them. maxNodes limits the result size to
   * prevent unbounded queries from degrading performance.
   *
   * Used by the Dashboard and by Planning's SimulationService for broad
   * subgraph exploration.
   *
   * @param filter   - Node filter criteria.
   * @param maxNodes - Maximum number of nodes to return. Defaults to 100.
   * @returns Object with filtered nodes and their connecting edges.
   * @throws KnowledgeException if the query fails.
   */
  querySubgraph(
    filter: NodeFilter,
    maxNodes?: number,
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }>;

  /**
   * Record a retrieval-and-use event for a node, updating its ACT-R params.
   *
   * This is the mechanism by which the Confidence Ceiling (Standard 3) is
   * lifted: after a successful retrieval-and-use, count increments and
   * confidence can grow past 0.60 over time.
   *
   * If success is false, the decay component of the formula is applied more
   * aggressively (per CANON §Anxiety Amplification if anxiety was high at
   * execution time — the Drive Engine handles that weighting via the events
   * backbone; this method records the raw success signal only).
   *
   * @param nodeId  - WKG element ID of the node that was retrieved and used.
   * @param success - Whether the retrieval produced a useful, accurate result.
   * @throws KnowledgeException if the update fails or nodeId is not found.
   */
  recordRetrievalAndUse(nodeId: string, success: boolean): Promise<void>;

  /**
   * Query aggregate statistics about the World Knowledge Graph.
   *
   * Used by the Dashboard and by Learning to track graph growth. The counts
   * are computed at query time — no cached values. Callers that need low
   * latency should cache the result externally.
   *
   * @returns GraphStats with total counts, provenance breakdown, and level breakdown.
   * @throws KnowledgeException if the aggregation query fails.
   */
  queryGraphStats(): Promise<GraphStats>;

  /**
   * Query all nodes with a specific provenance source.
   *
   * Used by the Learning subsystem to find LLM_GENERATED nodes that have
   * not yet had a successful retrieval-and-use event (potential candidates for
   * the Lesion Test). Also used by guardian tooling to review pending nodes.
   *
   * Does not apply a confidence threshold — returns all nodes regardless of
   * confidence so the guardian can review low-confidence provenance nodes.
   *
   * @param provenance - The ProvenanceSource to filter by.
   * @returns All nodes with that provenance, unordered.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  queryByProvenance(provenance: ProvenanceSource): Promise<KnowledgeNode[]>;

  /**
   * Delete a node and all of its incident edges from the WKG.
   *
   * Requires the node to have no edges that would leave dangling references
   * in the graph — the implementation detaches all incident edges before
   * deleting the node (DETACH DELETE semantics).
   *
   * @param id - Neo4j element ID of the node to delete.
   * @returns True if the node was found and deleted; false if not found.
   * @throws KnowledgeException if the delete fails.
   */
  deleteNode(id: string): Promise<boolean>;

  /**
   * Delete a single edge from the WKG by its element ID.
   *
   * Does not delete the source or target nodes. The source and target nodes
   * remain with whatever other edges they have.
   *
   * @param id - Neo4j relationship element ID of the edge to delete.
   * @returns True if the edge was found and deleted; false if not found.
   * @throws KnowledgeException if the delete fails.
   */
  deleteEdge(id: string): Promise<boolean>;

  /**
   * Query all Procedure nodes in the WKG, ordered by confidence descending.
   *
   * Returns all nodes carrying the 'Procedure' label regardless of confidence,
   * including deactivated nodes (confidence = 0.0). The caller decides whether
   * to filter deactivated entries. Used by the Skills management controller to
   * list all known procedures for the guardian dashboard.
   *
   * The result is ordered by n.confidence DESC so the most reliable procedures
   * appear first.
   *
   * @returns All Procedure nodes, ordered by confidence descending.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  queryProcedures(): Promise<KnowledgeNode[]>;

  /**
   * Soft-delete a node by lowering its confidence below the retrieval threshold.
   *
   * Sets confidence to 0.0 and adds a `deactivated: true` flag to the node's
   * properties. The node is NOT removed from Neo4j — it remains for audit and
   * provenance tracing. Default queries (which apply the 0.50 retrieval
   * threshold) will no longer return it.
   *
   * CANON §Guardian Asymmetry: This operation is guardian-initiated and
   * irreversible through normal channels. Only the guardian can reactivate a
   * node by clearing the deactivated flag and restoring confidence.
   *
   * @param id - Neo4j element ID of the node to deactivate.
   * @returns The updated node, or null if no node with that ID exists.
   * @throws KnowledgeException if the Neo4j write fails.
   */
  deactivateNode(id: string): Promise<KnowledgeNode | null>;

  /**
   * Query vocabulary growth as a daily time series.
   *
   * Returns one VocabularyGrowthDay per calendar day on which at least one
   * node was created, plus a running cumulative total. The series is ordered
   * oldest-first. Nodes without a created_at property are excluded.
   *
   * This query is expensive on large graphs. Callers should cache the result
   * with at least a 5-minute TTL and only recompute after Learning runs.
   *
   * Labels covered: Entity, Concept, Procedure, Utterance.
   *
   * @returns Ordered list of daily growth buckets.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  queryVocabularyGrowth(): Promise<VocabularyGrowthDay[]>;

  /**
   * Query phrase recognition statistics from Utterance nodes.
   *
   * Counts all Utterance nodes, then counts those with confidence > 0.50
   * (the retrieval threshold), broken down by provenance. This is the
   * Observatory's proxy for how many phrases Sylphie can reliably produce.
   *
   * @returns PhraseRecognitionStats snapshot.
   * @throws KnowledgeException if the Neo4j read fails.
   */
  queryPhraseRecognition(): Promise<PhraseRecognitionStats>;

  /**
   * Health check for the WKG connection.
   *
   * Sends a lightweight query to Neo4j to verify the driver is live. Used
   * by the application health endpoint and by OnModuleInit to fail fast if
   * Neo4j is unreachable at startup.
   *
   * @returns True if Neo4j is reachable and responsive; false otherwise.
   */
  healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// ISelfKgService
// ---------------------------------------------------------------------------

/**
 * Interface for Sylphie's Self Knowledge Graph (KG(Self)).
 *
 * KG(Self) is a Grafeo graph instance entirely separate from the WKG.
 * No WKG node IDs appear in KG(Self); no KG(Self) IDs appear in the WKG.
 * This isolation is structural and must never be violated.
 *
 * The Self KG models Sylphie's self-concept, capabilities, and behavioral
 * patterns. It is written by the Learning subsystem and read by Decision
 * Making (for capability-aware action selection) and Planning (for
 * self-aware plan generation).
 *
 * Injection token: SELF_KG_SERVICE (see knowledge.tokens.ts).
 */
export interface ISelfKgService {
  /**
   * Retrieve Sylphie's complete current self-model.
   *
   * Assembles the primary concept node, all capability nodes, and all active
   * pattern nodes into a SelfModel snapshot. Returns the last-snapshotted
   * model if called before any evaluations have been recorded.
   *
   * @returns Current SelfModel. The model is always non-null — cold start
   *          returns a SYSTEM_BOOTSTRAP model with default values.
   * @throws KnowledgeException if the Grafeo read fails.
   */
  getCurrentModel(): Promise<SelfModel>;

  /**
   * Update a self-concept proposition and its confidence.
   *
   * Creates or updates the self-concept node in KG(Self). If a node with the
   * same concept string already exists, its confidence and provenance are
   * updated according to Guardian Asymmetry rules (Standard 5) if the caller
   * provides GUARDIAN provenance.
   *
   * CANON Standard 3 (Confidence Ceiling): confidence is clamped to 0.60 at
   * creation and can grow past the ceiling only after recordSelfEvaluation()
   * records successful uses.
   *
   * @param concept     - The self-concept proposition string.
   * @param confidence  - Initial or updated confidence in [0.0, 1.0].
   * @param provenance  - Provenance of this self-knowledge.
   * @throws KnowledgeException if the Grafeo write fails.
   */
  updateSelfConcept(
    concept: string,
    confidence: number,
    provenance: ProvenanceSource,
  ): Promise<void>;

  /**
   * Retrieve all capability nodes from KG(Self).
   *
   * Returns capabilities above the retrieval threshold (0.50) by default.
   * Decision Making uses this to assess whether Sylphie can handle a given
   * class of request without LLM assistance.
   *
   * @returns Array of SelfCapability nodes, ordered by confidence descending.
   * @throws KnowledgeException if the Grafeo read fails.
   */
  getCapabilities(): Promise<SelfCapability[]>;

  /**
   * Get the timestamp of the most recent KG(Self) snapshot.
   *
   * Used by the Learning subsystem to determine whether a new consolidation
   * cycle is needed. If null, no snapshot has been taken since cold start.
   *
   * @returns Timestamp of the last snapshot, or null if no snapshot exists.
   * @throws KnowledgeException if the Grafeo read fails.
   */
  getLastSnapshotTimestamp(): Promise<Date | null>;

  /**
   * Query KG(Self) for patterns matching a natural-language query.
   *
   * Used by the Planning subsystem to check whether Sylphie has recognized
   * a behavioral pattern relevant to a proposed plan. The query string is
   * matched against pattern descriptions using Grafeo's full-text search.
   *
   * @param query - Natural-language search string.
   * @returns Array of matching SelfPattern nodes, ordered by confidence descending.
   * @throws KnowledgeException if the Grafeo query fails.
   */
  queryPatterns(query: string): Promise<SelfPattern[]>;

  /**
   * Record a self-evaluation episode to KG(Self).
   *
   * Called by the Learning subsystem at the end of each Observation phase.
   * Increments ACT-R use counts on the relevant capability nodes and creates
   * a new SelfEvaluation record. If the evaluation valence is 'negative' and
   * this is the third consecutive negative evaluation, flags for guardian review.
   *
   * CANON Known Attractor States (Depressive Attractor): the implementation
   * must track consecutive negative evaluations and emit a guardian alert if
   * the count exceeds the threshold.
   *
   * @param evaluation - Structured self-evaluation data.
   * @throws KnowledgeException if the Grafeo write fails.
   */
  recordSelfEvaluation(evaluation: SelfEvaluation): Promise<void>;

  /**
   * Health check for the Self KG connection.
   *
   * @returns True if Grafeo (Self KG instance) is reachable; false otherwise.
   */
  healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// IOtherKgService
// ---------------------------------------------------------------------------

/**
 * Interface for per-person Knowledge Graph operations.
 *
 * Each person Sylphie interacts with has a dedicated, isolated Grafeo graph
 * instance (KG(Other_<personId>)). IOtherKgService provides a uniform API
 * over all such instances, routing operations to the correct instance by
 * personId.
 *
 * EVERY method in this interface requires personId as its first parameter.
 * This is structural enforcement of the isolation requirement — there is no
 * method that operates across all person graphs simultaneously. If cross-person
 * analysis is ever needed, it must go through the WKG, not this service.
 *
 * CANON §Other KG isolation: No KG(Other) nodes appear in the WKG or KG(Self).
 * No shared edges, no cross-contamination between person instances.
 *
 * Injection token: OTHER_KG_SERVICE (see knowledge.tokens.ts).
 */
export interface IOtherKgService {
  /**
   * Retrieve the complete model for a specific person.
   *
   * Returns null if no model exists for this personId. Callers should call
   * createPerson() before interacting with a new person.
   *
   * @param personId - Stable identifier for the person (e.g., "person_jim").
   * @returns PersonModel if the person exists, null otherwise.
   * @throws KnowledgeException if the Grafeo read fails.
   */
  getPersonModel(personId: string): Promise<PersonModel | null>;

  /**
   * Create a new person model in a dedicated KG(Other_<personId>) instance.
   *
   * Initializes a fresh Grafeo graph for this personId. If a graph for this
   * personId already exists, returns the existing PersonModel without
   * overwriting it.
   *
   * @param personId - Stable identifier for the person.
   * @param name     - Display name for the person.
   * @returns The newly created (or existing) PersonModel.
   * @throws KnowledgeException if the Grafeo initialization fails.
   */
  createPerson(personId: string, name: string): Promise<PersonModel>;

  /**
   * Apply a partial update to an existing person model.
   *
   * Updates only the fields supplied in the update payload. Fields not
   * present in the update are left unchanged. Trait upserts follow the same
   * Guardian Asymmetry rules (Standard 5) as self-concept updates.
   *
   * @param personId - Stable identifier for the person.
   * @param update   - Partial update payload. At least one field required.
   * @throws KnowledgeException if personId does not exist or the write fails.
   */
  updatePersonModel(personId: string, update: PersonModelUpdate): Promise<void>;

  /**
   * Query all personality and behavioral traits for a specific person.
   *
   * Returns traits above the retrieval threshold (0.50) by default. The
   * Communication subsystem uses this to adapt Sylphie's response style to
   * the known traits of the person she is speaking with.
   *
   * @param personId - Stable identifier for the person.
   * @returns Array of PersonTrait nodes, ordered by confidence descending.
   * @throws KnowledgeException if personId does not exist or the read fails.
   */
  queryPersonTraits(personId: string): Promise<PersonTrait[]>;

  /**
   * Query the interaction history for a specific person.
   *
   * Returns the most recent `limit` interactions, ordered by recordedAt
   * descending (most recent first). Used by Learning consolidation to
   * infer trait updates from recent interaction patterns.
   *
   * @param personId - Stable identifier for the person.
   * @param limit    - Maximum number of interactions to return. Defaults to 20.
   * @returns Array of PersonInteraction records, most recent first.
   * @throws KnowledgeException if personId does not exist or the read fails.
   */
  queryInteractionHistory(
    personId: string,
    limit?: number,
  ): Promise<PersonInteraction[]>;

  /**
   * Record a new interaction with a specific person.
   *
   * Appends a PersonInteraction record to KG(Other_<personId>). Also
   * increments the interactionCount on the root PersonModel node. The
   * Learning subsystem calls this during the Observation phase after each
   * completed interaction.
   *
   * @param personId    - Stable identifier for the person.
   * @param interaction - Interaction data. The id field is assigned at write time.
   * @throws KnowledgeException if personId does not exist or the write fails.
   */
  recordInteraction(
    personId: string,
    interaction: Omit<PersonInteraction, 'id'>,
  ): Promise<void>;

  /**
   * Get the list of all known person IDs.
   *
   * Returns the set of personIds for which a KG(Other) instance exists.
   * Used by the Communication subsystem during startup to pre-warm any
   * necessary person model caches.
   *
   * @returns Array of known personId strings, unordered.
   * @throws KnowledgeException if the registry lookup fails.
   */
  getKnownPersonIds(): Promise<string[]>;

  /**
   * Delete a person and their entire KG(Other) instance.
   *
   * Permanently removes the Grafeo graph instance for this personId and
   * all data it contains. This operation is irreversible. Requires guardian
   * authorization at the application level (enforced outside this interface).
   *
   * @param personId - Stable identifier for the person to delete.
   * @returns True if the person existed and was deleted; false if not found.
   * @throws KnowledgeException if the delete fails.
   */
  deletePerson(personId: string): Promise<boolean>;

  /**
   * Health check for the Other KG connection.
   *
   * If personId is provided, verifies that the specific KG(Other_<personId>)
   * instance is accessible. If omitted, verifies the Grafeo router that
   * manages all person instances.
   *
   * @param personId - Optional. If provided, checks this specific person's KG.
   * @returns True if the target Grafeo instance is reachable; false otherwise.
   */
  healthCheck(personId?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// IConfidenceService
// ---------------------------------------------------------------------------

/**
 * Interface for stateful ACT-R confidence tracking across the WKG.
 *
 * IConfidenceService wraps the pure computeConfidence() function from
 * confidence.types.ts and adds the stateful operations needed by the
 * Knowledge module: persisting use counts, enforcing ceilings at write
 * time, and batch-recomputing confidence for maintenance cycles.
 *
 * CANON Standard 3 (Confidence Ceiling): checkCeiling() enforces that no
 * knowledge exceeds 0.60 without at least one successful retrieval-and-use.
 * This is called at every upsert by IWkgService before persisting a node.
 *
 * CANON Standard 5 (Guardian Asymmetry): applyGuardianWeight() enforces
 * 2x/3x guardian multipliers. It wraps the pure function of the same name
 * from confidence.types.ts so callers have a single injection point.
 *
 * CANON Standard 6 (No Self-Modification of Evaluation): the compute()
 * method wraps computeConfidence(), which is a pure function and must never
 * be modified by the system. This interface does not expose any method to
 * change the formula or its constants.
 *
 * Injection token: CONFIDENCE_SERVICE (see knowledge.tokens.ts).
 */
export interface IConfidenceService {
  /**
   * Compute current ACT-R confidence from parameters.
   *
   * Wraps the pure computeConfidence() function from confidence.types.ts.
   * Synchronous — no I/O. This is a stateless calculation; for side-effecting
   * use recording, call recordUse() separately.
   *
   * CANON Standard 6: This method must not be altered to produce different
   * values based on system state. It is a transparent pass-through to the
   * pure formula.
   *
   * @param params - ACT-R parameters (base, count, decayRate, lastRetrievalAt).
   * @returns Confidence score in [0.0, 1.0].
   */
  compute(params: ACTRParams): number;

  /**
   * Record a retrieval-and-use event for a WKG node, persisting updated ACT-R params.
   *
   * Loads the node's current ACTRParams, increments count if success is true,
   * updates lastRetrievalAt to now, recomputes confidence, and persists the
   * updated params back to Neo4j. If success is false, count is not incremented
   * but lastRetrievalAt is still updated to trigger natural decay.
   *
   * This is the primary mechanism for lifting the Confidence Ceiling
   * (Standard 3): count grows from 0 to 1+ only through this method.
   *
   * @param nodeId  - Neo4j element ID of the node being used.
   * @param success - Whether the retrieval produced a correct, useful result.
   * @throws KnowledgeException if nodeId is not found or the persistence fails.
   */
  recordUse(nodeId: string, success: boolean): Promise<void>;

  /**
   * Enforce the Confidence Ceiling (CANON Standard 3).
   *
   * Returns the input confidence value clamped to the ceiling (0.60) if
   * retrievalCount is 0. If retrievalCount is >= 1, the ceiling does not
   * apply and the raw confidence value is returned unchanged (still clamped
   * to 1.0 overall).
   *
   * Called by IWkgService at upsert time before persisting node confidence.
   * Also called by the Learning consolidation cycle when proposing confidence
   * updates for newly extracted entities.
   *
   * @param confidence    - Raw computed or proposed confidence value.
   * @param retrievalCount - Number of prior successful retrieval-and-use events.
   * @returns Confidence clamped per the Confidence Ceiling rule.
   */
  checkCeiling(confidence: number, retrievalCount: number): number;

  /**
   * Apply the Guardian Asymmetry multiplier to a confidence delta.
   *
   * Wraps the pure applyGuardianWeight() function from confidence.types.ts.
   * Confirmation feedback is weighted 2x; correction feedback is weighted 3x
   * (CANON Standard 5). Synchronous — no I/O.
   *
   * @param delta        - Raw confidence change before guardian weighting.
   * @param feedbackType - 'confirmation' (2x) or 'correction' (3x).
   * @returns Weighted confidence delta.
   */
  applyGuardianWeight(
    delta: number,
    feedbackType: 'confirmation' | 'correction',
  ): number;

  /**
   * Batch-recompute confidence for a set of WKG nodes.
   *
   * Used by the Learning subsystem's maintenance cycle to refresh confidence
   * values for nodes that have not been retrieved recently (ACT-R decay).
   * Loads ACTRParams for all nodeIds in a single read pass, recomputes
   * confidence for each, and persists the updated values in a single write pass.
   *
   * Returns a Map from nodeId to recomputed confidence. Nodes not found in
   * the WKG are omitted from the result (not an error — they may have been
   * deleted between the Learning cycle queuing them and this call executing).
   *
   * @param nodeIds - Array of WKG element IDs to recompute.
   * @returns Map from nodeId to updated confidence value.
   * @throws KnowledgeException if the batch read or write fails.
   */
  batchRecompute(nodeIds: string[]): Promise<Map<string, number>>;
}
