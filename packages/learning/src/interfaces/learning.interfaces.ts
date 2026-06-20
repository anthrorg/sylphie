/**
 * Learning subsystem interfaces.
 *
 * CANON §Subsystem 3 (Learning): The consolidation pipeline converts raw
 * experience (TimescaleDB events) into durable knowledge (WKG nodes and edges).
 *
 * ILearningService is the sole public facade. All other interfaces are internal
 * to LearningModule and define the contracts between pipeline steps.
 */

import type { ProvenanceSource } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/**
 * The public interface for the Learning subsystem.
 * Injected via LEARNING_SERVICE token.
 *
 * Consumers (e.g., health-check controllers) can call runMaintenanceCycle()
 * to trigger a cycle manually, but under normal operation the LearningService
 * drives itself via setInterval.
 */
export interface ILearningService {
  /**
   * Run a single maintenance cycle.
   *
   * Fetches up to 5 unlearned events, runs each through the pipeline,
   * marks them as learned, and logs cycle results.
   *
   * @returns Summary of what the cycle did.
   */
  runMaintenanceCycle(): Promise<MaintenanceCycleResult>;

  /**
   * Run a single reflection cycle.
   *
   * Finds one completed conversation session (quiet for ≥10 min, ≥4 events,
   * not yet reflected), analyzes it holistically via LLM, and persists
   * extracted insights as Insight nodes in the WKG.
   *
   * @returns Summary of what the reflection cycle did.
   */
  runReflectionCycle(): Promise<ReflectionResult>;

  /**
   * Run a single cross-session synthesis cycle.
   *
   * Finds pairs of INSIGHT nodes from different sessions that share entity
   * references, sends each pair to the LLM (deep tier) to detect cross-session
   * patterns, and persists any found patterns as new Insight nodes with
   * SYNTHESIZES edges back to the source insights.
   *
   * @returns Summary of what the synthesis cycle did.
   */
  runSynthesisCycle(): Promise<SynthesisCycleResult>;

  /**
   * Request an immediate maintenance cycle driven by external pressure.
   *
   * Called by the learning-pressure bridge when CognitiveAwareness drive
   * pressure exceeds the configured threshold. If a cycle is already in
   * flight the call is a no-op (the overlap guard fires).
   *
   * @returns Summary of what the cycle did, or a no-op summary if skipped.
   */
  forceCycle(): Promise<MaintenanceCycleResult>;

  /**
   * Run a single confidence-decay + pruning cycle on the WORLD knowledge graph.
   *
   * Normally fired on the internal decay timer; exposed on the facade so the
   * Provability Gate's WS3 C3 compounding seam can trigger a deterministic decay
   * pass (it is the same production T3 path — ConfidenceDecayService.runDecayCycle
   * reading coalesce(last_retrieval_at, updated_at, created_at)).
   *
   * @returns Summary of decay and pruning actions.
   */
  runDecayCycle(): Promise<DecayCycleResult>;
}

// ---------------------------------------------------------------------------
// Cycle result
// ---------------------------------------------------------------------------

/**
 * Summary of a completed maintenance cycle.
 */
export interface MaintenanceCycleResult {
  /** Number of events processed in this cycle. */
  readonly eventsProcessed: number;
  /** Total entity nodes upserted (created or updated) in Neo4j. */
  readonly entitiesUpserted: number;
  /** Total edges upserted in Neo4j. */
  readonly edgesUpserted: number;
  /** Number of Conversation nodes created. */
  readonly conversationsCreated: number;
  /** Number of CAN_PRODUCE edges created. */
  readonly canProduceEdgesCreated: number;
  /** Number of edges refined by the LLM. */
  readonly edgesRefined: number;
  /** Number of contradictions detected between new and existing edges. */
  readonly contradictionsDetected: number;
  /** Whether this cycle was a no-op (no unlearned events found). */
  readonly wasNoop: boolean;
}

// ---------------------------------------------------------------------------
// Unlearned event (raw row from TimescaleDB events table)
// ---------------------------------------------------------------------------

/**
 * A row from the TimescaleDB events table that has not yet been processed
 * by the Learning subsystem (has_learned = false).
 *
 * The payload column is JSONB — its shape varies by event type. The fields
 * we care about are content (for INPUT_RECEIVED) and entities (for INPUT_PARSED).
 * Both INPUT_RECEIVED and INPUT_PARSED also carry payload.speakerId (= the
 * PostgreSQL User.id of the speaker; Wave 3 C2). C3 reads it to person-scope
 * conversation-derived entities as :Candidate nodes (grounding_person_id =
 * speakerId) instead of shared :Entity — CANON Std-3 isolation, §2.8 leak fix.
 */
export interface UnlearnedEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: Date;
  readonly subsystem: string;
  readonly session_id: string;
  /** Raw JSONB payload — typed loosely because schema varies by event type. */
  readonly payload: Record<string, unknown>;
  readonly schema_version: number;
}

// ---------------------------------------------------------------------------
// Extracted entity (output of Step 3)
// ---------------------------------------------------------------------------

/**
 * An entity extracted from an unlearned event and upserted into Neo4j.
 */
export interface ExtractedEntity {
  /** The node_id assigned in Neo4j (or the pre-existing one if MERGE matched). */
  readonly nodeId: string;
  /** The human-readable label used for the MERGE key. */
  readonly label: string;
  /** Provenance determined from the source event. */
  readonly provenance: ProvenanceSource;
  /** Base confidence at upsert time. */
  readonly confidence: number;
  /**
   * Wave 3 C3 — true when this node was minted as a `:Candidate` (a
   * conversation-derived proper noun staged in the WORLD graph, NOT a live
   * `:Entity`). Candidates carry provenance 'CANDIDATE', confidence ≤0.60, and a
   * `grounding_person_id`; they are excluded from every WKG grounding read-path
   * (CANON Std-3 §2.8). Downstream edge writers read this so they MATCH the node
   * by `node_id` alone (label-agnostic) rather than `(:Entity {node_id})`, which
   * would silently fail to bind a `:Candidate`. Absent/false for guardian-taught
   * `:Entity` nodes.
   */
  readonly isCandidate?: boolean;
  /**
   * Wave 3 C3 — the speaker/person id (PostgreSQL User.id) under which a
   * `:Candidate` was scoped (`grounding_person_id`). Present only when
   * `isCandidate` is true and a speaker was known; undefined for unscoped world
   * candidates and for live `:Entity` nodes. Read by the guardian promotion
   * path (C4).
   */
  readonly groundingPersonId?: string;
}

// ---------------------------------------------------------------------------
// Extracted edge (output of Step 4)
// ---------------------------------------------------------------------------

/**
 * A RELATED_TO edge between two entities, created during Step 4.
 * These are candidates for LLM refinement in Step 7.
 */
export interface ExtractedEdge {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly targetId: string;
  readonly targetLabel: string;
  /** Edge type — initially 'RELATED_TO', may be refined to a more specific type. */
  relType: string;
  readonly provenance: ProvenanceSource;
  readonly confidence: number;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Internal service interfaces
// ---------------------------------------------------------------------------

/**
 * Step 2: UpdateWkgService interface.
 * Manages schema migration and queries unlearned events.
 */
export interface IUpdateWkgService {
  /**
   * Ensure the has_learned column and its partial index exist on the events table.
   * Safe to call multiple times (idempotent DDL).
   */
  ensureSchema(): Promise<void>;

  /**
   * Ensure the failed_learning_events hypertable exists.
   * Safe to call multiple times (idempotent DDL).
   */
  ensureDeadLetterSchema(): Promise<void>;

  /**
   * Fetch up to `limit` events that have not yet been processed by Learning.
   * Orders by timestamp ASC so oldest events are processed first.
   */
  fetchUnlearnedEvents(limit: number): Promise<UnlearnedEvent[]>;

  /**
   * Mark an event as processed so it is not fetched again.
   */
  markAsLearned(eventId: string): Promise<void>;

  /**
   * Record a failed event to the dead-letter table so data loss is auditable.
   * Fire-and-forget from the pipeline catch block; errors are swallowed so the
   * dead-letter write never causes a secondary failure.
   */
  writeDeadLetter(
    eventId: string,
    pipelineStep: string,
    errorMessage: string,
  ): Promise<void>;
}

/**
 * Step 3: UpsertEntitiesService interface.
 */
export interface IUpsertEntitiesService {
  /**
   * Extract entities from the event content and upsert them into Neo4j WORLD.
   * Returns the list of upserted entities with their node IDs.
   */
  upsertEntities(event: UnlearnedEvent): Promise<ExtractedEntity[]>;
}

/**
 * Step 3b: ExtractTypedEdgesService interface.
 *
 * Before blind co-occurrence edges, extracts structured (subject, predicate,
 * object) triples from the event text and creates properly typed edges
 * directly. Returns the set of entity pairs that already have typed edges
 * so the downstream co-occurrence step can skip them.
 */
export interface IExtractTypedEdgesService {
  /**
   * Parse structured facts from event text and create typed edges in the WKG.
   *
   * @returns The typed edges created and a set of entity pair keys that
   *          should be excluded from RELATED_TO co-occurrence creation.
   */
  extractTypedEdges(
    entities: ExtractedEntity[],
    event: UnlearnedEvent,
  ): Promise<{ edges: ExtractedEdge[]; typedPairs: Set<string> }>;
}

/**
 * Step 4: ExtractEdgesService interface.
 */
export interface IExtractEdgesService {
  /**
   * Create RELATED_TO edges between entity pairs that co-occur in the same
   * sentence. Skips pairs that already have typed edges from the structured
   * extractor (typedPairs).
   *
   * @param typedPairs - Set of "sourceId:targetId" keys that already have
   *                     typed edges and should be skipped.
   */
  extractEdges(
    entities: ExtractedEntity[],
    event: UnlearnedEvent,
    typedPairs?: Set<string>,
  ): Promise<ExtractedEdge[]>;
}

/**
 * Step 5: ConversationEntryService interface.
 */
export interface IConversationEntryService {
  /**
   * Create a Conversation node in Neo4j WORLD for this event and write
   * MENTIONS edges to each extracted entity.
   *
   * @returns The node_id of the created Conversation node.
   */
  createEntry(
    event: UnlearnedEvent,
    entities: ExtractedEntity[],
  ): Promise<string>;
}

/**
 * Step 6: CanProduceEdgesService interface.
 */
export interface ICanProduceEdgesService {
  /**
   * Extract significant multi-word phrases from the event content, MERGE Word
   * nodes for each phrase, and create CAN_PRODUCE edges from the Conversation
   * node to those Word nodes.
   *
   * @returns Number of CAN_PRODUCE edges created.
   */
  createEdges(conversationNodeId: string, event: UnlearnedEvent): Promise<number>;
}

/**
 * Step 7: RefineEdgesService interface.
 */
export interface IRefineEdgesService {
  /**
   * Use the LLM to classify generic RELATED_TO edges into more specific types.
   * Skips gracefully if LLM is unavailable (isAvailable() === false).
   *
   * @returns Number of edges that were successfully refined.
   */
  refineEdges(
    edges: ExtractedEdge[],
    event: UnlearnedEvent,
  ): Promise<number>;
}

/**
 * Post-refinement step: DetectContradictionsService interface.
 *
 * After edge refinement classifies RELATED_TO edges into typed relationships,
 * checks whether any newly typed edge contradicts an existing edge between
 * the same entity pair (e.g., LIKES + DISLIKES). Creates CONTRADICTS edges
 * consumed by the ContradictionScannerService in decision-making.
 */
export interface IDetectContradictionsService {
  /**
   * Check refined edges for contradictions against existing graph knowledge.
   * Creates CONTRADICTS edges for any detected conflicts.
   *
   * @returns Number of contradictions detected and persisted.
   */
  detectContradictions(
    edges: ExtractedEdge[],
    event: UnlearnedEvent,
  ): Promise<number>;
}

/**
 * Periodic cycle: ConfidenceDecayService interface.
 *
 * Applies time-based confidence decay using per-provenance rates and prunes
 * orphaned low-confidence Entity nodes. Runs as a separate timer cycle,
 * not per-event.
 */
export interface IConfidenceDecayService {
  /**
   * Run a single decay + pruning cycle on the WORLD knowledge graph.
   *
   * @returns Summary of decay and pruning actions.
   */
  runDecayCycle(): Promise<DecayCycleResult>;
}

/**
 * Summary of a completed confidence decay + pruning cycle.
 */
export interface DecayCycleResult {
  /** Number of nodes whose confidence was reduced by time-based decay. */
  readonly nodesDecayed: number;
  /** Number of edges whose confidence was reduced by time-based decay. */
  readonly edgesDecayed: number;
  /** Number of orphaned low-confidence Entity nodes removed from the graph. */
  readonly nodesPruned: number;
  /**
   * Number of OKG :Attribute nodes (Neo4jInstanceName.OTHER) whose confidence
   * was reduced by time-based decay (TK-49 / EP11.1). Only non-GUARDIAN nodes
   * are decayed; GUARDIAN identity facts are always skipped.
   */
  readonly okgNodesDecayed: number;
  /**
   * Number of OKG :Attribute nodes below PRUNE_THRESHOLD with no relationships
   * that were deleted (TK-49 / EP11.1).
   */
  readonly okgNodesPruned: number;
  /** Whether this cycle was a no-op (nothing decayed or pruned). */
  readonly wasNoop: boolean;
}

/**
 * LearningEventLoggerService interface.
 */
export interface ILearningEventLogger {
  /**
   * Fire-and-forget: log a Learning subsystem event to TimescaleDB.
   * Errors are caught and logged as warnings; callers never await this path.
   */
  log(
    eventType: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): void;
}

// ---------------------------------------------------------------------------
// Conversation Reflection (holistic session analysis)
// ---------------------------------------------------------------------------

/**
 * The six categories of insight that reflection can extract from a
 * completed conversation. Each represents a class of understanding that
 * emerges only when viewing the conversation as a whole.
 */
export type InsightType =
  | 'DELAYED_REALIZATION'
  | 'MISSED_CONNECTION'
  | 'IMPLICIT_INSTRUCTION'
  | 'CONTRADICTION'
  | 'THEMATIC_THREAD'
  | 'TONAL_SHIFT';

/**
 * A single insight parsed from the LLM's reflection response.
 */
export interface ReflectionInsight {
  readonly insightType: InsightType;
  readonly description: string;
  /** LLM self-assessed confidence [0.0, 1.0]. Capped at INFERENCE base (0.30) for WKG writes. */
  readonly confidence: number;
  readonly referencedEntities: readonly string[];
  readonly suggestedEdge: {
    readonly source: string;
    readonly target: string;
    readonly relType: string;
  } | null;
}

/**
 * Summary of a completed reflection cycle.
 */
export interface ReflectionResult {
  readonly sessionId: string;
  readonly insightsCreated: number;
  readonly edgesCreated: number;
  readonly wasNoop: boolean;
}

/**
 * A session candidate returned by findReflectableSessions().
 */
export interface SessionCandidate {
  readonly sessionId: string;
  readonly lastEventAt: Date;
  readonly eventCount: number;
}

/**
 * Conversation Reflection service interface.
 *
 * Analyzes completed conversations holistically to extract insights that
 * no single event could reveal: delayed realizations, missed connections,
 * implicit instructions, contradictions, thematic threads, tonal shifts.
 *
 * LLM-assisted; skips gracefully when unavailable (Lesion Test support).
 */
export interface IConversationReflectionService {
  /**
   * Ensure the reflected_sessions tracking table exists (idempotent DDL).
   */
  ensureSchema(): Promise<void>;

  /**
   * Find sessions that are eligible for reflection: quiet for ≥ threshold,
   * at least MIN_EVENTS events, and not yet reflected.
   */
  findReflectableSessions(): Promise<SessionCandidate[]>;

  /**
   * Analyze a completed session holistically and persist insights to WKG.
   */
  reflectOnSession(sessionId: string): Promise<ReflectionResult>;

  /**
   * Re-grounding sweep: find Insight nodes with grounded:false and
   * referenced_entities populated, attempt to create REVEALS edges for
   * any entity that now exists in the WKG, and recompute confidence.
   * Sets grounded:true when the grounding ratio reaches 1.0.
   *
   * Runs on the 30-minute synthesis cadence, after the synthesis pass.
   * Safe to call repeatedly — MERGE semantics make it idempotent.
   *
   * @returns Summary of how many insights were examined and updated.
   */
  regroundUngroundedInsights(): Promise<RegroundResult>;
}

/**
 * Summary of a completed re-grounding sweep.
 */
export interface RegroundResult {
  /** Number of grounded:false insights examined. */
  readonly insightsExamined: number;
  /** Number of insights that had at least one new REVEALS edge created. */
  readonly insightsUpdated: number;
  /** Number of new REVEALS edges created across all insights. */
  readonly edgesCreated: number;
  /** Whether the sweep was a no-op (no eligible insights found). */
  readonly wasNoop: boolean;
}

// ---------------------------------------------------------------------------
// Cross-Session Insight Synthesis
// ---------------------------------------------------------------------------

/**
 * A pair of Insight nodes from different sessions that share entity references
 * and are candidates for synthesis.
 */
export interface InsightPair {
  readonly insight1Id: string;
  readonly insight1Description: string;
  readonly insight1Type: InsightType;
  readonly insight1SessionId: string;
  readonly insight1Confidence: number;
  readonly insight2Id: string;
  readonly insight2Description: string;
  readonly insight2Type: InsightType;
  readonly insight2SessionId: string;
  readonly insight2Confidence: number;
  /** Entity labels shared across both insights (via REVEALS edges). */
  readonly sharedEntities: readonly string[];
}

/**
 * A synthesized meta-insight produced by cross-session synthesis.
 */
export interface SynthesisResult {
  /** node_id of the new synthesis Insight node, or null if no node was created. */
  readonly nodeId: string | null;
  /** The source insight node_ids that were synthesized. */
  readonly sourceInsightIds: readonly string[];
  /** Confidence assigned to the synthesis node. */
  readonly confidence: number;
  /** Whether the LLM found a meaningful pattern (false → noop). */
  readonly patternFound: boolean;
}

/**
 * Summary of a completed synthesis cycle.
 */
export interface SynthesisCycleResult {
  /** Number of insight pairs examined. */
  readonly pairsExamined: number;
  /** Number of synthesis nodes created. */
  readonly synthesesCreated: number;
  /** Whether this cycle was a no-op (no eligible pairs found). */
  readonly wasNoop: boolean;
}

/**
 * Cross-session synthesis service interface.
 *
 * Compares INSIGHT nodes across different sessions to detect recurring themes,
 * evolving patterns, and contradictions that no single-session reflection can
 * surface. Produces higher-confidence "meta-insight" nodes with SYNTHESIZES
 * edges back to source insights.
 *
 * LLM-assisted (deep tier); skips gracefully when unavailable (Lesion Test).
 * Provenance: INFERENCE. Confidence cap: 0.45 (1.5× base, below 0.60 ceiling).
 */
export interface ICrossSessionSynthesisService {
  /**
   * Ensure the synthesized_insight_pairs tracking table exists (idempotent DDL).
   */
  ensureSchema(): Promise<void>;

  /**
   * Find insight pairs eligible for synthesis: from different sessions, sharing
   * entity references via REVEALS edges, not yet synthesized together.
   */
  findSynthesizablePairs(limit: number): Promise<InsightPair[]>;

  /**
   * Synthesize a single insight pair and persist the result to WKG.
   * Returns a SynthesisResult regardless of whether a node was created.
   */
  synthesizePair(pair: InsightPair): Promise<SynthesisResult>;

  /**
   * Run a full synthesis cycle: find pairs, synthesize each, log results.
   */
  runSynthesisCycle(): Promise<SynthesisCycleResult>;
}

// ---------------------------------------------------------------------------
// Self-Model Writer
// ---------------------------------------------------------------------------

/**
 * Outcome of a single capability's self-model write within a cycle.
 *
 * One :Capability node is governed by one of these. Reused for both
 * prediction_accuracy and knowledge_retrieval so each capability reports its
 * own honest sample window independently.
 */
export interface CapabilityWriteResult {
  /**
   * Whether this capability wrote nodes. False when sample_count = 0 (no honest
   * telemetry in the 24-hour window) — in which case its stale node is
   * DETACH DELETE'd rather than written.
   */
  readonly wrote: boolean;
  /** Number of qualifying rows in this capability's query window. */
  readonly sampleCount: number;
  /** Computed success rate, or null when sampleCount = 0. */
  readonly successRate: number | null;
  /** Stored confidence (clamped ≤ 0.60), or null when sampleCount = 0. */
  readonly confidence: number | null;
}

/**
 * Result of a single self-model write cycle.
 *
 * The top-level fields (wrote/sampleCount/successRate/confidence) report the
 * prediction_accuracy capability — preserved for backward compatibility with
 * existing callers and tests. The knowledge_retrieval capability is reported
 * additively in the nested `knowledgeRetrieval` field. Both capabilities refresh
 * together in the same cycle (each with its own honest 24-hour sample window).
 */
export interface SelfModelCycleResult {
  /**
   * Whether the prediction_accuracy capability wrote nodes. False when its
   * sample_count = 0 (no honest telemetry available in the 24-hour window) — in
   * which case stale nodes are DETACH DELETE'd rather than written.
   */
  readonly wrote: boolean;
  /** Number of non-empty PREDICTION_EVALUATED rows in the query window. */
  readonly sampleCount: number;
  /** Computed prediction_accuracy success rate, or null when sampleCount = 0. */
  readonly successRate: number | null;
  /** Stored prediction_accuracy confidence (clamped ≤ 0.60), or null when sampleCount = 0. */
  readonly confidence: number | null;
  /** Whether this cycle was a no-op due to an in-flight guard or error. */
  readonly wasNoop: boolean;
  /**
   * Outcome of the knowledge_retrieval capability write within this same cycle.
   * Optional/back-compatible: absent when the whole cycle errored before the
   * knowledge_retrieval block ran (wasNoop=true path).
   */
  readonly knowledgeRetrieval?: CapabilityWriteResult;
  /**
   * Outcome of the social_interaction capability write within this same cycle.
   * Optional/back-compatible: absent when the whole cycle errored before the
   * social_interaction block ran (wasNoop=true path). Metric = proactive
   * (self-initiated, no-originator) SOCIAL_COMMENT_INITIATED bids that earned a
   * guardian reply in the same session within 30 seconds, over all such bids.
   */
  readonly socialInteraction?: CapabilityWriteResult;
}

/**
 * SelfModelWriterService interface.
 *
 * Aggregates PREDICTION_EVALUATED events from TimescaleDB and writes a single
 * :Capability {name:'prediction_accuracy'} + paired :PredictionAccuracy
 * {domain:'drive_effects'} node to the SELF Neo4j graph.
 *
 * CANON compliance:
 *   - Std-1 (theater prohibition): only rows with non-empty predictedEffects
 *     are counted. Rows with empty predictedEffects are trivially "accurate"
 *     (random-delta novel predictions) and are excluded from success_rate.
 *   - Std-2 (provenance required): provenance_type = 'INFERENCE' (system-
 *     computed aggregate, not a guardian judgment).
 *   - Std-3 (confidence ceiling): confidence = min(0.60, n/(n+50)). Stored
 *     at the source so the SELF graph is honest before the reader reads it.
 *   - When sampleCount = 0, NO nodes are written and stale nodes are
 *     DETACH DELETE'd so the reader never serves a fabricated rate.
 *
 * Now SHIPPED:
 *   - prediction_accuracy: from PREDICTION_EVALUATED telemetry.
 *   - knowledge_retrieval: from RESPONSE_GENERATED knowledgeGrounding + intent
 *     (GROUNDED / GROUNDED|UNKNOWN over intent='QUESTION' turns).
 *   - social_interaction: from SOCIAL_COMMENT_INITIATED (proactive, no-originator
 *     bids) self-joined to GUARDIAN_CONFIRMATION / GUARDIAN_INPUT_RECEIVED replies
 *     in the same session within 30 seconds.
 *
 * Deliberately OMITTED capabilities (no honest telemetry today):
 *   - error_correction: unblock by persisting a contradiction-resolution event.
 *   - :DrivePattern nodes: unblock by persisting observed drive-stimulus pairs.
 */
export interface ISelfModelWriterService {
  /**
   * Run one self-model write cycle.
   *
   * Queries TimescaleDB for PREDICTION_EVALUATED events in the last 24 hours
   * (filtered to non-empty predictedEffects), computes success_rate, writes
   * :Capability + :PredictionAccuracy MERGE to SELF, or DETACH DELETEs stale
   * nodes when sample_count = 0.
   */
  runSelfModelCycle(): Promise<SelfModelCycleResult>;
}
