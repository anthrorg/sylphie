import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Knowledge');

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

// Properties too heavy for graph snapshot payloads (code body text).
const SNAPSHOT_STRIP_KEYS = new Set([
  'bodyText',
  'args',
  'properties',
]);

// ---------------------------------------------------------------------------
// PKG snapshot cache — the codebase graph rarely changes at runtime.
// ---------------------------------------------------------------------------

const PKG_CACHE_TTL_MS = 60_000;

interface PkgCache {
  snapshot: GraphSnapshotDto;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Neo4j index definitions for the knowledge graphs (WORLD, SELF, OTHER).
//
// The PKG has its own indexes created by initial-seed.ts. These cover the
// three Grafeo-style graphs used at runtime by the decision-making,
// learning, communication, and planning subsystems.
//
// NOTE: Entities created via `MERGE (n {label: $label})` without a Neo4j
// label cannot benefit from label-scoped property indexes. The full-text
// index partially covers this gap. A future refactor should ensure all
// WKG nodes carry at least an :Entity label.
// ---------------------------------------------------------------------------

const KG_INDEX_STATEMENTS = [
  // ActionProcedure — queried by action-retriever (confidence threshold),
  // contradiction-scanner (by id), wkg-context (by node_id, triggerContext).
  'CREATE CONSTRAINT ap_id_unique IF NOT EXISTS FOR (p:ActionProcedure) REQUIRE p.id IS UNIQUE',
  'CREATE INDEX ap_node_id IF NOT EXISTS FOR (p:ActionProcedure) ON (p.node_id)',
  'CREATE INDEX ap_confidence IF NOT EXISTS FOR (p:ActionProcedure) ON (p.confidence)',

  // Conversation — queried by conversation-reflection (by session_id).
  'CREATE INDEX conversation_session IF NOT EXISTS FOR (c:Conversation) ON (c.session_id)',

  // Insight — queried by conversation-reflection (by node_id).
  'CREATE INDEX insight_node_id IF NOT EXISTS FOR (i:Insight) ON (i.node_id)',

  // Drive — queried by wkg-context writeActionProcedure (by drive_name).
  'CREATE INDEX drive_name IF NOT EXISTS FOR (d:Drive) ON (d.drive_name)',

  // CoBeing — queried by communication (by label).
  'CREATE INDEX cobeing_label IF NOT EXISTS FOR (c:CoBeing) ON (c.label)',

  // Entity — the most common node type in the WKG. Covers upsert-entities,
  // communication, and wkg-context MERGE operations.
  'CREATE INDEX entity_label IF NOT EXISTS FOR (e:Entity) ON (e.label)',
  'CREATE INDEX entity_node_id IF NOT EXISTS FOR (e:Entity) ON (e.node_id)',

  // Word nodes — excluded from matchEntities via WHERE NOT n:Word.
  // The label-based exclusion is fast with the token lookup index (auto).

  // Full-text index for fuzzy label searches (wkg-context matchEntities).
  // Spans all common knowledge-bearing labels.
  `CREATE FULLTEXT INDEX kg_label_fulltext IF NOT EXISTS
   FOR (n:Entity|ActionProcedure|CoBeing|Drive|Insight|Conversation|Attribute)
   ON EACH [n.label]`,
];

// One-time migration: add :Entity label to existing unlabeled nodes that have
// a `label` property. Without a Neo4j label, property indexes cannot be used.
// Safe to run repeatedly — nodes that already have a label are excluded.
const LABEL_MIGRATION_CYPHER = `
  MATCH (n)
  WHERE n.label IS NOT NULL
    AND size(labels(n)) = 0
  SET n:Entity
  RETURN count(n) AS migrated
`;

@Injectable()
export class WkgQueryService implements OnModuleInit {
  private readonly logger = new Logger(WkgQueryService.name);
  private pkgCache: PkgCache | null = null;

  constructor(private readonly neo4j: Neo4jService) {}

  async onModuleInit(): Promise<void> {
    // Create indexes for WORLD, SELF, and OTHER in parallel.
    // Failures are non-fatal — queries just run slower without indexes.
    await Promise.all([
      this.ensureKgIndexes(Neo4jInstanceName.WORLD),
      this.ensureKgIndexes(Neo4jInstanceName.SELF),
      this.ensureKgIndexes(Neo4jInstanceName.OTHER),
    ]);
  }

  /**
   * Fetch a full snapshot of the World Knowledge Graph — all nodes and edges.
   * Capped at 5 000 nodes / 10 000 edges to avoid overwhelming the frontend.
   */
  async getSnapshot(): Promise<GraphSnapshotDto> {
    const t0 = Date.now();
    vlog('WKG query: getSnapshot', { instance: 'WORLD' });
    const result = await this.getInstanceSnapshot(Neo4jInstanceName.WORLD);
    vlog('WKG query: getSnapshot complete', { instance: 'WORLD', nodes: result.nodes.length, edges: result.edges.length, latencyMs: Date.now() - t0 });
    return result;
  }

  /**
   * Fetch a full snapshot of the Other Knowledge Graph (person models).
   */
  async getOkgSnapshot(): Promise<GraphSnapshotDto> {
    const t0 = Date.now();
    vlog('WKG query: getOkgSnapshot', { instance: 'OTHER' });
    const result = await this.getInstanceSnapshot(Neo4jInstanceName.OTHER, 1000, 5000);
    vlog('WKG query: getOkgSnapshot complete', { instance: 'OTHER', nodes: result.nodes.length, edges: result.edges.length, latencyMs: Date.now() - t0 });
    return result;
  }

  /**
   * Fetch a full snapshot of the Self Knowledge Graph (Sylphie's self-model).
   */
  async getSkgSnapshot(): Promise<GraphSnapshotDto> {
    const t0 = Date.now();
    vlog('WKG query: getSkgSnapshot', { instance: 'SELF' });
    const result = await this.getInstanceSnapshot(Neo4jInstanceName.SELF, 1000, 5000);
    vlog('WKG query: getSkgSnapshot complete', { instance: 'SELF', nodes: result.nodes.length, edges: result.edges.length, latencyMs: Date.now() - t0 });
    return result;
  }

  /**
   * Fetch a snapshot of the Package Knowledge Graph (codebase structure).
   *
   * Optimizations vs the generic getInstanceSnapshot path:
   *   1. Cached in-memory (60s TTL) — PKG only changes on code sync.
   *   2. Excludes CodeBlock nodes — they carry bodyText up to 8KB each and
   *      are an implementation detail for code search, not graph visualization.
   *   3. Strips heavy properties (bodyText, args, properties JSON) from
   *      remaining nodes to reduce payload size.
   *
   * Returns empty snapshot if PKG Neo4j is not configured.
   */
  async getPkgSnapshot(): Promise<GraphSnapshotDto> {
    // Serve from cache if fresh.
    if (this.pkgCache && Date.now() < this.pkgCache.expiresAt) {
      return this.pkgCache.snapshot;
    }

    try {
      const snapshot = await this.getPkgSnapshotFresh();
      this.pkgCache = { snapshot, expiresAt: Date.now() + PKG_CACHE_TTL_MS };
      return snapshot;
    } catch (err) {
      this.logger.warn(`PKG snapshot failed (instance may not be configured): ${(err as Error).message}`);
      return { nodes: [], edges: [] };
    }
  }

  /** Invalidate the PKG snapshot cache (call after code sync). */
  invalidatePkgCache(): void {
    this.pkgCache = null;
  }

  // -----------------------------------------------------------------------
  // Paginated queries — used by the progressive-loading frontend
  // -----------------------------------------------------------------------

  /** Fast count-only query for a given instance. */
  async getCount(instance: Neo4jInstanceName): Promise<{ nodes: number; edges: number }> {
    const t0 = Date.now();
    vlog('WKG query: getCount', { instance });
    const session = this.neo4j.getSession(instance, 'READ');
    try {
      const result = await session.run(
        `CALL {
           MATCH (n) RETURN count(n) AS nc
         }
         CALL {
           MATCH ()-[r]->() RETURN count(r) AS ec
         }
         RETURN nc, ec`,
      );
      const rec = result.records[0];
      const counts = {
        nodes: asNumber(rec?.get('nc'), 0),
        edges: asNumber(rec?.get('ec'), 0),
      };
      vlog('WKG query: getCount complete', { instance, ...counts, latencyMs: Date.now() - t0 });
      return counts;
    } finally {
      await session.close();
    }
  }

  /** Fetch a page of nodes from any instance. */
  async getNodePage(
    instance: Neo4jInstanceName,
    skip: number,
    limit: number,
  ): Promise<{ nodes: GraphNodeDto[]; total: number }> {
    const t0 = Date.now();
    const countSession = this.neo4j.getSession(instance, 'READ');
    const dataSession = this.neo4j.getSession(instance, 'READ');
    try {
      const [countResult, dataResult] = await Promise.all([
        countSession.run('MATCH (n) RETURN count(n) AS total'),
        dataSession.run(
          `MATCH (n)
           RETURN n, labels(n) AS labels, elementId(n) AS eid
           SKIP ${skip} LIMIT ${limit}`,
        ),
      ]);
      const total = asNumber(countResult.records[0]?.get('total'), 0);
      const nodes = dataResult.records.map((rec) => this.mapNodeRecord(rec));
      vlog('WKG query: getNodePage', { instance, skip, limit, returned: nodes.length, total, latencyMs: Date.now() - t0 });
      return { nodes, total };
    } finally {
      await Promise.all([countSession.close(), dataSession.close()]);
    }
  }

  /** Fetch a page of edges from any instance. */
  async getEdgePage(
    instance: Neo4jInstanceName,
    skip: number,
    limit: number,
  ): Promise<{ edges: GraphEdgeDto[]; total: number }> {
    const t0 = Date.now();
    const countSession = this.neo4j.getSession(instance, 'READ');
    const dataSession = this.neo4j.getSession(instance, 'READ');
    try {
      const [countResult, dataResult] = await Promise.all([
        countSession.run('MATCH ()-[r]->() RETURN count(r) AS total'),
        dataSession.run(
          `MATCH (a)-[r]->(b)
           RETURN r, type(r) AS rel_type,
                  elementId(r) AS eid,
                  a.node_id AS source_node_id,
                  b.node_id AS target_node_id,
                  elementId(a) AS source_eid,
                  elementId(b) AS target_eid
           SKIP ${skip} LIMIT ${limit}`,
        ),
      ]);
      const total = asNumber(countResult.records[0]?.get('total'), 0);
      // We need node eid→id mapping. Fetch all node eids referenced by this edge page.
      const sourceEids = new Set<string>();
      const targetEids = new Set<string>();
      for (const rec of dataResult.records) {
        sourceEids.add(rec.get('source_eid') as string);
        targetEids.add(rec.get('target_eid') as string);
      }
      // Build a partial eid→nodeId map from the edges' own endpoint properties
      const eidToNodeId = new Map<string, string>();
      for (const rec of dataResult.records) {
        const srcId = asString(rec.get('source_node_id'));
        const tgtId = asString(rec.get('target_node_id'));
        if (srcId) eidToNodeId.set(rec.get('source_eid') as string, srcId);
        if (tgtId) eidToNodeId.set(rec.get('target_eid') as string, tgtId);
      }

      const edges = dataResult.records.map((rec) => {
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
          if (!EDGE_META_KEYS.has(k)) properties[k] = toPlain(v);
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
      vlog('WKG query: getEdgePage', { instance, skip, limit, returned: edges.length, total, latencyMs: Date.now() - t0 });
      return { edges, total };
    } finally {
      await Promise.all([countSession.close(), dataSession.close()]);
    }
  }

  /** Resolve a Neo4jInstanceName from a string slug. */
  resolveInstance(slug: string): Neo4jInstanceName | null {
    switch (slug) {
      case 'wkg': return Neo4jInstanceName.WORLD;
      case 'okg': return Neo4jInstanceName.OTHER;
      case 'skg': return Neo4jInstanceName.SELF;
      case 'pkg': return Neo4jInstanceName.PKG;
      default: return null;
    }
  }

  // -----------------------------------------------------------------------
  // Record mappers (reused by both full-snapshot and paginated paths)
  // -----------------------------------------------------------------------

  private mapNodeRecord(rec: any): GraphNodeDto {
    const n = rec.get('n');
    const labels: string[] = rec.get('labels');
    const eid: string = rec.get('eid');
    const props = n.properties as Record<string, unknown>;
    const nodeId = asString(props.node_id) || eid;
    const nodeType = asString(props.node_type) || labels[0] || 'Unknown';
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!NODE_META_KEYS.has(k)) properties[k] = toPlain(v);
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
  }

  // -----------------------------------------------------------------------
  // KG index creation
  // -----------------------------------------------------------------------

  /**
   * Create indexes and constraints for a knowledge graph instance.
   * Idempotent — uses IF NOT EXISTS. Non-fatal on failure.
   */
  private async ensureKgIndexes(instance: Neo4jInstanceName): Promise<void> {
    const session = this.neo4j.getSession(instance, 'WRITE');
    try {
      // Create indexes and constraints.
      for (const stmt of KG_INDEX_STATEMENTS) {
        try {
          await session.run(stmt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // "already exists" or "equivalent index" are expected on repeat runs.
          if (!msg.includes('already exists') && !msg.includes('An equivalent')) {
            this.logger.warn(`[${instance}] index creation warning: ${msg}`);
          }
        }
      }

      // Migrate existing unlabeled nodes → :Entity so indexes cover them.
      try {
        const result = await session.run(LABEL_MIGRATION_CYPHER);
        const migrated = result.records[0]?.get('migrated');
        const count = typeof migrated === 'number' ? migrated
          : (migrated && typeof migrated.toNumber === 'function') ? migrated.toNumber() : 0;
        if (count > 0) {
          this.logger.log(`[${instance.toUpperCase()}] Migrated ${count} unlabeled nodes → :Entity`);
        }
      } catch (err) {
        this.logger.warn(
          `[${instance}] Label migration warning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.logger.log(`[${instance.toUpperCase()}] KG indexes ensured`);
    } catch (err) {
      this.logger.warn(
        `[${instance}] KG index creation failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Queries will still work but may be slower.`,
      );
    } finally {
      await session.close();
    }
  }

  // -----------------------------------------------------------------------
  // PKG optimized snapshot (excludes CodeBlock, strips heavy props, cached)
  // -----------------------------------------------------------------------

  private async getPkgSnapshotFresh(): Promise<GraphSnapshotDto> {
    const nodeSession = this.neo4j.getSession(Neo4jInstanceName.PKG, 'READ');
    const edgeSession = this.neo4j.getSession(Neo4jInstanceName.PKG, 'READ');

    try {
      const [nodeResult, edgeResult] = await Promise.all([
        // Exclude CodeBlock nodes — they carry large bodyText and are only
        // used by the searchContent MCP tool, not graph visualization.
        nodeSession.run(
          `MATCH (n)
           WHERE NOT n:CodeBlock
           RETURN n, labels(n) AS labels, elementId(n) AS eid
           LIMIT 8000`,
        ),
        // Exclude edges touching CodeBlock nodes (HAS_CODE edges).
        edgeSession.run(
          `MATCH (a)-[r]->(b)
           WHERE NOT a:CodeBlock AND NOT b:CodeBlock
           RETURN r, type(r) AS rel_type,
                  elementId(r) AS eid,
                  a.node_id AS source_node_id,
                  b.node_id AS target_node_id,
                  elementId(a) AS source_eid,
                  elementId(b) AS target_eid
           LIMIT 15000`,
        ),
      ]);

      const nodes: GraphNodeDto[] = nodeResult.records.map((rec) => {
        const n = rec.get('n');
        const labels: string[] = rec.get('labels');
        const eid: string = rec.get('eid');
        const props = n.properties as Record<string, unknown>;
        const nodeId = asString(props.node_id) || eid;
        const nodeType = asString(props.node_type) || labels[0] || 'Unknown';

        // Build properties bag, stripping promoted fields AND heavy content.
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (!NODE_META_KEYS.has(k) && !SNAPSHOT_STRIP_KEYS.has(k)) {
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
          if (!EDGE_META_KEYS.has(k)) properties[k] = toPlain(v);
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

      this.logger.log(`PKG snapshot: ${nodes.length} nodes, ${edges.length} edges`);
      return { nodes, edges };
    } finally {
      await Promise.all([nodeSession.close(), edgeSession.close()]);
    }
  }

  // -----------------------------------------------------------------------
  // Full snapshot (legacy — still used by WebSocket and old endpoints)
  // -----------------------------------------------------------------------

  /**
   * Generic snapshot fetcher for any Neo4j instance.
   */
  private async getInstanceSnapshot(
    instance: Neo4jInstanceName,
    nodeLimit = 5000,
    edgeLimit = 10000,
  ): Promise<GraphSnapshotDto> {
    // Each session.run() opens an implicit transaction, so parallel queries
    // require separate sessions to avoid "open transaction" errors.
    const nodeSession = this.neo4j.getSession(instance, 'READ');
    const edgeSession = this.neo4j.getSession(instance, 'READ');

    try {
      const [nodeResult, edgeResult] = await Promise.all([
        nodeSession.run(
          `MATCH (n)
           RETURN n, labels(n) AS labels, elementId(n) AS eid
           LIMIT ${nodeLimit}`,
        ),
        edgeSession.run(
          `MATCH (a)-[r]->(b)
           RETURN r, type(r) AS rel_type,
                  elementId(r) AS eid,
                  a.node_id AS source_node_id,
                  b.node_id AS target_node_id,
                  elementId(a) AS source_eid,
                  elementId(b) AS target_eid
           LIMIT ${edgeLimit}`,
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
        `${instance.toUpperCase()} snapshot: ${nodes.length} nodes, ${edges.length} edges`,
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
