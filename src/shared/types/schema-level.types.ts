/**
 * Schema level types and utilities for the World Knowledge Graph.
 *
 * The WKG operates on three structural levels (CANON §The World Knowledge Graph
 * Is the Brain):
 *
 *   instance    — Individual nodes ("this mug", "Jim", "greet_jim_morning")
 *   schema      — Type/category definitions ("Mug is a Container")
 *   meta_schema — Rules governing schema evolution ("promote 3+ similar instances")
 *
 * This module provides the canonical mapping from Neo4j node labels to their
 * schema level. It is the single source of truth for this mapping — import from
 * here rather than duplicating the lookup table.
 *
 * Atlas: used by WkgService (writes schema_level onto each node as a Neo4j
 * property) and by GraphController (populates GraphNodeDto.schema_level,
 * falling back to label inference for legacy nodes that predate the property).
 */

/**
 * The three structural levels of the World Knowledge Graph.
 *
 * These values are stored as Neo4j node properties AND surfaced on
 * GraphNodeDto so the frontend can filter and colorize by level.
 *
 * Note: these are lower-case to align with the frontend's filter convention
 * ('instance' | 'schema' | 'meta_schema') and to keep the DTO readable.
 * They differ deliberately from NodeLevel (INSTANCE | SCHEMA | META_SCHEMA),
 * which is an internal UPPER_SNAKE_CASE enum used inside KnowledgeNode.
 */
export type SchemaLevel = 'instance' | 'schema' | 'meta_schema';

/**
 * Canonical set of Neo4j labels that map to each SchemaLevel.
 *
 * SCHEMA_LEVEL_LABELS is the single source of truth. If a new node label is
 * introduced in Neo4jInitService, it must be added here in the correct bucket.
 *
 * instance labels   — Entity, Concept, Procedure, Utterance
 * schema labels     — SchemaType, SchemaRelType
 * meta_schema label — MetaRule
 */
export const SCHEMA_LEVEL_LABELS: Record<SchemaLevel, readonly string[]> = {
  schema: ['SchemaType', 'SchemaRelType'],
  meta_schema: ['MetaRule'],
  instance: ['Entity', 'Concept', 'Procedure', 'Utterance'],
};

/**
 * Derive the SchemaLevel for a node from one of its Neo4j labels.
 *
 * Accepts any single label string (e.g., the primary label from
 * `node.labels[0]`, or each label in `node.labels` to pick the most
 * specific). When a node carries multiple labels, callers should iterate
 * and take the first non-'instance' result, or simply pass the primary label.
 *
 * Falls back to 'instance' for any unrecognised label — in practice all
 * domain nodes are instance-level, and unknown labels should never be schema
 * or meta_schema.
 *
 * @param label - A single Neo4j node label string.
 * @returns The SchemaLevel for that label.
 */
export function schemaLevelFromLabel(label: string): SchemaLevel {
  if (SCHEMA_LEVEL_LABELS.meta_schema.includes(label)) return 'meta_schema';
  if (SCHEMA_LEVEL_LABELS.schema.includes(label)) return 'schema';
  return 'instance';
}

/**
 * Derive the SchemaLevel for a node from its full labels array.
 *
 * Iterates all labels and returns the most specific (non-instance) level
 * found. If no label maps to schema or meta_schema, returns 'instance'.
 *
 * Use this when a node may carry compound labels (e.g., ['Action', 'Procedure'])
 * and you want to ensure no schema-level label is missed.
 *
 * @param labels - The full array of Neo4j labels on a node.
 * @returns The most specific SchemaLevel present across all labels.
 */
export function schemaLevelFromLabels(labels: readonly string[]): SchemaLevel {
  for (const label of labels) {
    if (SCHEMA_LEVEL_LABELS.meta_schema.includes(label)) return 'meta_schema';
  }
  for (const label of labels) {
    if (SCHEMA_LEVEL_LABELS.schema.includes(label)) return 'schema';
  }
  return 'instance';
}
