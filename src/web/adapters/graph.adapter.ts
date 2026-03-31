/**
 * Graph adapter — Sylphie-native graph DTOs → CoBeing wire format.
 *
 * Converts GraphNodeDto and GraphEdgeDto (camelCase, src/web/dtos/graph.dto.ts)
 * into the snake_case CoBeing_GraphNode, CoBeing_GraphEdge, and CoBeing_GraphDelta
 * shapes expected by co-being React frontends connecting with `?protocol=cobeing-v1`.
 *
 * This is a pure transformation layer. It applies no provenance modification,
 * no confidence ceilings, and no drive computation. Values are passed through
 * unchanged; only field names and structure differ.
 *
 * CANON §Provenance Is Sacred: provenance_type is always populated from the
 * source DTO's `provenance` field and is never stripped, upgraded, or defaulted
 * to a different value in this layer.
 *
 * CANON §Confidence Ceiling: confidence values are passed through as-is. The
 * ceiling is enforced at write time by WkgService; this adapter does not re-apply it.
 */

import type { GraphNodeDto, GraphEdgeDto } from '../dtos/graph.dto';
import type { GraphUpdateFrame, GraphUpdateEventType } from '../interfaces/websocket.interfaces';
import type {
  CoBeing_GraphNode,
  CoBeing_GraphEdge,
  CoBeing_GraphDelta,
} from './cobeing-types';

// ---------------------------------------------------------------------------
// Event type mapping
// ---------------------------------------------------------------------------

/**
 * Canonical mapping from Sylphie-native GraphUpdateEventType (kebab-case) to
 * the co-being CoBeing_GraphDelta type discriminator (snake_case).
 *
 * 'confidence-changed' maps to 'node_updated' because a confidence change
 * is a mutation of an existing node's attributes — no new node was created.
 *
 * The map is typed so the compiler enforces exhaustiveness if GraphUpdateEventType
 * gains new members in the future.
 */
const GRAPH_EVENT_TYPE_MAP: Record<
  GraphUpdateEventType,
  CoBeing_GraphDelta['type']
> = {
  'node-created': 'node_created',
  'node-updated': 'node_updated',
  'edge-created': 'edge_created',
  'edge-updated': 'edge_updated',
  'confidence-changed': 'node_updated',
} as const;

// ---------------------------------------------------------------------------
// Public adapter functions
// ---------------------------------------------------------------------------

/**
 * Adapt a Sylphie-native GraphNodeDto to a CoBeing_GraphNode.
 *
 * Field mapping:
 *   id          → node_id
 *   type        → node_type
 *   label       → label (unchanged)
 *   schema_level → schema_level (unchanged — added in E11-T002)
 *   properties  → properties (defaults to {} when absent)
 *   provenance  → provenance_type (never stripped per CANON §Provenance Is Sacred)
 *   confidence  → confidence (unchanged)
 *   createdAt   → created_at (ISO 8601, defaults to now when absent)
 *   updatedAt   → updated_at (ISO 8601 or null when absent)
 *
 * @param node - Source GraphNodeDto from the WKG query layer.
 * @returns CoBeing_GraphNode ready for wire serialisation.
 *
 * @throws Never. All optional fields are guarded with defaults.
 */
export function adaptGraphNode(node: GraphNodeDto): CoBeing_GraphNode {
  return {
    node_id: node.id,
    node_type: node.type,
    label: node.label,
    schema_level: node.schema_level,
    properties: node.properties ?? {},
    provenance_type: node.provenance,
    confidence: node.confidence,
    created_at: (node as NodeWithTimestamps).createdAt
      ? new Date((node as NodeWithTimestamps).createdAt as string | number | Date).toISOString()
      : new Date().toISOString(),
    updated_at: (node as NodeWithTimestamps).updatedAt
      ? new Date((node as NodeWithTimestamps).updatedAt as string | number | Date).toISOString()
      : null,
  };
}

/**
 * Adapt a Sylphie-native GraphEdgeDto to a CoBeing_GraphEdge.
 *
 * Field mapping:
 *   id           → edge_id
 *   sourceId     → source_node_id
 *   targetId     → target_node_id
 *   relationship → edge_type
 *   relationship → label (used as display label per co-being convention)
 *   properties   → properties (defaults to {} when absent)
 *   confidence   → confidence (unchanged)
 *   createdAt    → created_at (ISO 8601, defaults to now when absent)
 *
 * @param edge - Source GraphEdgeDto from the WKG query layer.
 * @returns CoBeing_GraphEdge ready for wire serialisation.
 *
 * @throws Never. All optional fields are guarded with defaults.
 */
export function adaptGraphEdge(edge: GraphEdgeDto): CoBeing_GraphEdge {
  return {
    edge_id: edge.id,
    source_node_id: edge.sourceId,
    target_node_id: edge.targetId,
    edge_type: edge.relationship,
    label: edge.relationship,
    properties: (edge as EdgeWithProperties).properties ?? {},
    confidence: edge.confidence,
    created_at: (edge as EdgeWithTimestamps).createdAt
      ? new Date((edge as EdgeWithTimestamps).createdAt as string | number | Date).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Adapt a Sylphie-native GraphUpdateFrame to a CoBeing_GraphDelta.
 *
 * Maps the native event type (kebab-case) to the co-being delta type
 * (snake_case) using GRAPH_EVENT_TYPE_MAP. Populates the `node` or `edge`
 * field from the frame's payload if a corresponding DTO is present.
 *
 * Returns null when the frame cannot be meaningfully translated — specifically
 * when a node_* delta has no node payload and an edge_* delta has no edge
 * payload. The gateway should skip null returns and not send them to clients.
 *
 * @param update - The Sylphie-native GraphUpdateFrame from the polling loop.
 * @returns A CoBeing_GraphDelta, or null if the frame carries insufficient data.
 */
export function adaptGraphUpdate(update: GraphUpdateFrame): CoBeing_GraphDelta | null {
  const cobeingType = GRAPH_EVENT_TYPE_MAP[update.event];

  const isNodeEvent =
    cobeingType === 'node_created' ||
    cobeingType === 'node_added' ||
    cobeingType === 'node_updated' ||
    cobeingType === 'node_removed';

  const isEdgeEvent =
    cobeingType === 'edge_created' ||
    cobeingType === 'edge_added' ||
    cobeingType === 'edge_updated' ||
    cobeingType === 'edge_removed';

  if (isNodeEvent) {
    if (!update.payload.node) {
      // No node data in this frame — skip rather than emitting an empty delta.
      return null;
    }
    return {
      type: cobeingType,
      node: adaptGraphNode(update.payload.node),
    };
  }

  if (isEdgeEvent) {
    if (!update.payload.edge) {
      // No edge data in this frame — skip rather than emitting an empty delta.
      return null;
    }
    return {
      type: cobeingType,
      edge: adaptGraphEdge(update.payload.edge),
    };
  }

  return null;
}

/**
 * Produce a full graph snapshot CoBeing_GraphDelta from lists of nodes and edges.
 *
 * Used by GraphUpdatesGateway when a cobeing-v1 client connects: the gateway
 * fetches the current WKG state and sends this as the first message so the
 * client can render the full graph before incremental deltas arrive.
 *
 * @param nodes - All nodes from the WKG snapshot query.
 * @param edges - All edges from the WKG snapshot query.
 * @returns A CoBeing_GraphDelta with type 'snapshot' and full node/edge arrays.
 */
export function adaptGraphSnapshot(
  nodes: GraphNodeDto[],
  edges: GraphEdgeDto[],
): CoBeing_GraphDelta {
  return {
    type: 'snapshot',
    snapshot: {
      nodes: nodes.map(adaptGraphNode),
      edges: edges.map(adaptGraphEdge),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal structural helpers
// ---------------------------------------------------------------------------

/**
 * GraphNodeDto extended with optional timestamp fields.
 *
 * GraphNodeDto does not declare createdAt/updatedAt because the REST layer
 * may omit them for performance. The gateway snapshot path uses a WKG query
 * that does include them. We use this narrowing interface rather than `any`
 * to keep the adapter strict-TypeScript-compatible.
 */
interface NodeWithTimestamps extends GraphNodeDto {
  readonly createdAt?: string | number | Date | null;
  readonly updatedAt?: string | number | Date | null;
}

/**
 * GraphEdgeDto extended with optional timestamp and properties fields.
 *
 * GraphEdgeDto does not declare createdAt or properties in the base interface.
 * When the gateway serialises full snapshot edges those fields may be present.
 */
interface EdgeWithTimestamps extends GraphEdgeDto {
  readonly createdAt?: string | number | Date | null;
}

interface EdgeWithProperties extends GraphEdgeDto {
  readonly properties?: Record<string, unknown>;
}
