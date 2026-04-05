import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Shape expected by the frontend (mirrors frontend/src/types/index.ts)
// ---------------------------------------------------------------------------

export interface GraphNodeDto {
  node_id: string;
  node_type: string;
  label: string;
  schema_level: string;
  properties: Record<string, unknown>;
  provenance_type: string;
  confidence: number;
  created_at: string;
  updated_at: string | null;
}

export interface GraphEdgeDto {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  label: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
}

export interface GraphSnapshotDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

// Properties that are promoted to top-level fields on GraphNodeDto and should
// not be duplicated into the generic `properties` bag.
const NODE_META_KEYS = new Set([
  'node_id',
  'node_type',
  'label',
  'schema_level',
  'provenance_type',
  'confidence',
  'created_at',
  'updated_at',
]);

const EDGE_META_KEYS = new Set([
  'edge_id',
  'label',
  'confidence',
  'created_at',
]);

@Injectable()
export class WkgQueryService {
  private readonly logger = new Logger(WkgQueryService.name);

  constructor(private readonly neo4j: Neo4jService) {}

  /**
   * Fetch a full snapshot of the World Knowledge Graph — all nodes and edges.
   * Capped at 5 000 nodes / 10 000 edges to avoid overwhelming the frontend.
   */
  async getSnapshot(): Promise<GraphSnapshotDto> {
    // Each session.run() opens an implicit transaction, so parallel queries
    // require separate sessions to avoid "open transaction" errors.
    const nodeSession = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    const edgeSession = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');

    try {
      const [nodeResult, edgeResult] = await Promise.all([
        nodeSession.run(
          `MATCH (n)
           RETURN n, labels(n) AS labels, elementId(n) AS eid
           LIMIT 5000`,
        ),
        edgeSession.run(
          `MATCH (a)-[r]->(b)
           RETURN r, type(r) AS rel_type,
                  elementId(r) AS eid,
                  a.node_id AS source_node_id,
                  b.node_id AS target_node_id,
                  elementId(a) AS source_eid,
                  elementId(b) AS target_eid
           LIMIT 10000`,
        ),
      ]);

      const nodes: GraphNodeDto[] = nodeResult.records.map((rec) => {
        const n = rec.get('n');
        const labels: string[] = rec.get('labels');
        const eid: string = rec.get('eid');
        const props = n.properties as Record<string, unknown>;

        const nodeId = asString(props.node_id) || eid;
        const nodeType = asString(props.node_type) || labels[0] || 'Unknown';

        // Build the generic properties bag, excluding promoted fields.
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (!NODE_META_KEYS.has(k)) {
            properties[k] = toPlain(v);
          }
        }

        return {
          node_id: nodeId,
          node_type: nodeType,
          label: asString(props.label) || asString(props.name) || asString(props.normalized_text) || nodeId,
          schema_level: asString(props.schema_level) || 'instance',
          properties,
          provenance_type: asString(props.provenance_type) || 'SYSTEM_BOOTSTRAP',
          confidence: asNumber(props.confidence, 0.5),
          created_at: asString(props.created_at) || new Date().toISOString(),
          updated_at: asString(props.updated_at) || null,
        };
      });

      // Build a lookup from Neo4j elementId → node_id so edges can reference
      // nodes even when the node_id property is missing on one side.
      const eidToNodeId = new Map<string, string>();
      nodeResult.records.forEach((rec, i) => {
        eidToNodeId.set(rec.get('eid') as string, nodes[i].node_id);
      });

      const edges: GraphEdgeDto[] = edgeResult.records.map((rec) => {
        const r = rec.get('r');
        const relType: string = rec.get('rel_type');
        const eid: string = rec.get('eid');
        const rProps = r.properties as Record<string, unknown>;

        const sourceNodeId =
          asString(rec.get('source_node_id')) ||
          eidToNodeId.get(rec.get('source_eid') as string) ||
          (rec.get('source_eid') as string);
        const targetNodeId =
          asString(rec.get('target_node_id')) ||
          eidToNodeId.get(rec.get('target_eid') as string) ||
          (rec.get('target_eid') as string);

        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rProps)) {
          if (!EDGE_META_KEYS.has(k)) {
            properties[k] = toPlain(v);
          }
        }

        return {
          edge_id: asString(rProps.edge_id) || eid,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          edge_type: relType,
          label: asString(rProps.label) || relType,
          properties,
          confidence: asNumber(rProps.confidence, 0.5),
          created_at: asString(rProps.created_at) || new Date().toISOString(),
        };
      });

      this.logger.log(
        `WKG snapshot: ${nodes.length} nodes, ${edges.length} edges`,
      );

      return { nodes, edges };
    } finally {
      await Promise.all([nodeSession.close(), edgeSession.close()]);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — Neo4j driver returns Integer objects for longs, Date objects, etc.
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && 'toString' in v) return String(v);
  return '';
}

function asNumber(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  // neo4j-driver Integer
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  const parsed = Number(v);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Convert Neo4j driver value types (Integer, Date, etc.) to plain JSON. */
function toPlain(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  if (Array.isArray(v)) return v.map(toPlain);
  return v;
}
