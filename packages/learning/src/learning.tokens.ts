/**
 * NestJS injection tokens for the LearningModule.
 *
 * EXPORTED tokens (public API — re-exported from index.ts):
 *   LEARNING_SERVICE    — ILearningService, main facade
 *
 * INTERNAL tokens (NOT exported from index.ts):
 *   All pipeline step tokens are internal to LearningModule only.
 *   No other module should ever inject them.
 */

/**
 * Injection token for ILearningService.
 * The sole public API token for the Learning subsystem.
 * Re-exported from index.ts.
 */
export const LEARNING_SERVICE = Symbol('LEARNING_SERVICE');

/**
 * Injection token for UpdateWkgService (Step 2).
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Handles schema migration (has_learned column) and fetches unlearned events
 * from TimescaleDB for each maintenance cycle.
 */
export const UPDATE_WKG_SERVICE = Symbol('UPDATE_WKG_SERVICE');

/**
 * Injection token for UpsertEntitiesService (Step 3).
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Extracts entities from event content and MERGEs them into Neo4j WORLD
 * with correct provenance and base confidence.
 */
export const UPSERT_ENTITIES_SERVICE = Symbol('UPSERT_ENTITIES_SERVICE');

/**
 * Injection token for ExtractEdgesService (Step 4).
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Derives RELATED_TO relationship edges from entity pairs found in the same
 * event and MERGEs them into Neo4j WORLD.
 */
export const EXTRACT_EDGES_SERVICE = Symbol('EXTRACT_EDGES_SERVICE');

/**
 * Injection token for ConversationEntryService (Step 5).
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Creates Conversation nodes in Neo4j WORLD and writes MENTIONS edges
 * from each Conversation node to the entities it references.
 */
export const CONVERSATION_ENTRY_SERVICE = Symbol('CONVERSATION_ENTRY_SERVICE');

/**
 * Injection token for CanProduceEdgesService (Step 6).
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Extracts significant phrases from event content, MERGEs Word nodes,
 * and creates CAN_PRODUCE edges from Conversation nodes to Word nodes.
 */
export const CAN_PRODUCE_EDGES_SERVICE = Symbol('CAN_PRODUCE_EDGES_SERVICE');

/**
 * Injection token for RefineEdgesService (Step 7).
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * LLM-assisted edge refinement: classifies generic RELATED_TO edges into
 * more specific types (LIKES, WORKS_AT, KNOWS, etc.). Skips gracefully when
 * LLM is unavailable (Lesion Test support).
 */
export const REFINE_EDGES_SERVICE = Symbol('REFINE_EDGES_SERVICE');

/**
 * Injection token for LearningEventLoggerService.
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Fire-and-forget event logger that writes LEARNING subsystem events to
 * TimescaleDB. All pipeline steps use this for cycle observability.
 */
export const LEARNING_EVENT_LOGGER = Symbol('LEARNING_EVENT_LOGGER');

/**
 * Injection token for ConversationReflectionService.
 * INTERNAL TO LearningModule ONLY. Not exported from index.ts.
 *
 * Holistic conversation analysis: after a session goes quiet, reflects on
 * the full conversation to extract insights not visible from individual events.
 * LLM-assisted, skipped if unavailable (Lesion Test support).
 */
export const CONVERSATION_REFLECTION_SERVICE = Symbol('CONVERSATION_REFLECTION_SERVICE');
