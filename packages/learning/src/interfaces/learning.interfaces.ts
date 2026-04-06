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
   * Fetch up to `limit` events that have not yet been processed by Learning.
   * Orders by timestamp ASC so oldest events are processed first.
   */
  fetchUnlearnedEvents(limit: number): Promise<UnlearnedEvent[]>;

  /**
   * Mark an event as processed so it is not fetched again.
   */
  markAsLearned(eventId: string): Promise<void>;
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
 * Step 4: ExtractEdgesService interface.
 */
export interface IExtractEdgesService {
  /**
   * Create RELATED_TO edges between each pair of entities from the same event.
   * Returns the list of created/updated edges for downstream refinement.
   */
  extractEdges(
    entities: ExtractedEntity[],
    event: UnlearnedEvent,
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
