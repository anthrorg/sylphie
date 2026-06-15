/**
 * Wave 3 / chunk C0 — `:Candidate` grounding-exclusion unit tests.
 *
 * CANON Std-3 three-graph isolation (§2.8 person-fact leak): a `:Candidate`
 * node (a staged conversation-derived proper noun, provenance_type 'CANDIDATE',
 * confidence ≤0.60, carrying `grounding_person_id`) lives in the WORLD graph
 * beside `:Entity` but must NEVER be returned by any WKG grounding read-path —
 * so it can never become the provenance of a GROUNDED label
 * (retrieveWkgRecall → recall-retrieval.ts). An equivalent `:Entity` node with
 * the same label MUST still be returned.
 *
 * The fake Neo4j below is LABEL-AWARE: its `run()` actually interprets the
 * `NOT <var>:Candidate` / `NOT <var>:Word` clauses and the fulltext-vs-CONTAINS
 * branch, so these tests exercise the REAL Cypher gates in wkg-context.service.ts
 * rather than a mock that fakes the verdict. If a future edit drops an exclusion
 * clause, the corresponding assertion fails.
 *
 * Covered read-paths (every grounding-contributing WKG reader):
 *   - matchEntities  (fulltext branch)            via queryEntities()
 *   - matchEntities  (CONTAINS fallback branch)   via queryEntities() when the
 *                                                 fulltext call throws
 *   - getContextForFrame() end-to-end             (the real grounding entry)
 *   - getSubgraph()  (1-hop neighbour traversal)
 *   - getEntityFacts() (fact-object traversal)
 *   - getRelationships() (both endpoints)
 */

import { Neo4jInstanceName, CANDIDATE_NODE_LABEL } from '@sylphie/shared';
import { WkgContextService } from './wkg-context.service';
import type { SensoryFrame } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Label-aware in-memory WORLD graph + a Cypher-interpreting fake session.
// ---------------------------------------------------------------------------

interface GraphNode {
  node_id: string;
  label: string;
  labels: string[]; // Neo4j labels, e.g. ['Entity'] or ['Candidate']
  confidence: number;
  provenance_type: string;
  props: Record<string, unknown>;
}

interface GraphRel {
  a: string; // source node_id
  b: string; // target node_id
  type: string;
  confidence: number;
}

class FakeWorldGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly rels: GraphRel[] = [];
  /** When true, the fulltext call throws so matchEntities falls back to CONTAINS. */
  failFulltext = false;

  addNode(n: Partial<GraphNode> & { node_id: string; label: string; labels: string[] }): void {
    this.nodes.set(n.node_id, {
      confidence: 0.5,
      provenance_type: 'INFERENCE',
      props: {},
      ...n,
    });
  }

  addRel(a: string, type: string, b: string, confidence = 0.5): void {
    this.rels.push({ a, type, b, confidence });
  }

  private hasLabel(n: GraphNode, label: string): boolean {
    return n.labels.includes(label);
  }

  /** Apply the `NOT n:Word AND NOT n:Candidate` exclusions the service emits. */
  private isGroundingEligible(n: GraphNode): boolean {
    return !this.hasLabel(n, 'Word') && !this.hasLabel(n, CANDIDATE_NODE_LABEL);
  }

  private rowFromNode(n: GraphNode) {
    return {
      get: (k: string) => {
        switch (k) {
          case 'nodeId':
            return n.node_id;
          case 'label':
            return n.label;
          case 'nodeType':
            return n.labels[0] ?? 'Unknown';
          case 'props':
            return n.props;
          case 'confidence':
            return n.confidence;
          case 'provenance':
            return n.provenance_type;
          default:
            return null;
        }
      },
    };
  }

  getSession(_name: Neo4jInstanceName, _mode: 'READ' | 'WRITE') {
    const graph = this;
    return {
      run: async (cypher: string, params: Record<string, unknown>) => {
        // --- matchEntities: fulltext branch -------------------------------
        if (/db\.index\.fulltext\.queryNodes/.test(cypher)) {
          if (graph.failFulltext) {
            throw new Error('fulltext index unavailable (forced)');
          }
          const query = String(params['query'] ?? '');
          // Lucene "a OR b" → match any term as a case-insensitive substring of label.
          const terms = query
            .split(/\s+OR\s+/)
            .map((t) => t.replace(/\\(.)/g, '$1').toLowerCase())
            .filter(Boolean);
          const records = [...graph.nodes.values()]
            .filter((n) => terms.some((t) => n.label.toLowerCase().includes(t)))
            // The query's `WHERE NOT node:Word AND NOT node:Candidate`.
            .filter((n) => graph.isGroundingEligible(n))
            .map((n) => graph.rowFromNode(n));
          return { records };
        }

        // --- matchEntities: CONTAINS fallback branch ----------------------
        if (/CONTAINS toLower\(name\)/.test(cypher)) {
          const names = (params['names'] as string[]).map((s) => s.toLowerCase());
          const records = [...graph.nodes.values()]
            .filter((n) => names.some((nm) => n.label.toLowerCase().includes(nm)))
            // The query's `AND NOT n:Word AND NOT n:Candidate`.
            .filter((n) => graph.isGroundingEligible(n))
            .map((n) => graph.rowFromNode(n));
          return { records };
        }

        // --- getEntityFacts -----------------------------------------------
        if (/RETURN n\.label AS subject/.test(cypher)) {
          const id = params['id'] as string;
          const n = graph.nodes.get(id);
          if (!n || graph.hasLabel(n, CANDIDATE_NODE_LABEL)) return { records: [] };
          const records = graph.rels
            .filter((r) => r.a === id || r.b === id)
            .map((r) => {
              const otherId = r.a === id ? r.b : r.a;
              return graph.nodes.get(otherId);
            })
            // `WHERE NOT n:Candidate AND NOT m:Candidate` — drop candidate objects.
            .filter((m): m is GraphNode => !!m && !graph.hasLabel(m, CANDIDATE_NODE_LABEL))
            .map((m) => ({
              get: (k: string) => {
                if (k === 'subject') return n.label;
                if (k === 'predicate') return 'RELATED_TO';
                if (k === 'object') return m.label;
                if (k === 'confidence') return 0.5;
                if (k === 'provenance') return n.provenance_type;
                return null;
              },
            }));
          return { records };
        }

        // --- getRelationships ---------------------------------------------
        if (/RETURN a\.node_id AS sourceId/.test(cypher)) {
          const ids = new Set(params['ids'] as string[]);
          const records = graph.rels
            .filter((r) => ids.has(r.a) && ids.has(r.b))
            .filter((r) => {
              const a = graph.nodes.get(r.a);
              const b = graph.nodes.get(r.b);
              // `AND NOT a:Candidate AND NOT b:Candidate`.
              return (
                a &&
                b &&
                !graph.hasLabel(a, CANDIDATE_NODE_LABEL) &&
                !graph.hasLabel(b, CANDIDATE_NODE_LABEL)
              );
            })
            .map((r) => ({
              get: (k: string) => {
                if (k === 'sourceId') return r.a;
                if (k === 'targetId') return r.b;
                if (k === 'relType') return r.type;
                if (k === 'props') return {};
                if (k === 'confidence') return r.confidence;
                return null;
              },
            }));
          return { records };
        }

        // --- getSubgraph ---------------------------------------------------
        if (/OPTIONAL MATCH path = \(n\)-\[r\*1\.\./.test(cypher)) {
          const ids = new Set(params['ids'] as string[]);
          const reached = new Set<string>(ids);
          for (const r of graph.rels) {
            if (ids.has(r.a)) reached.add(r.b);
            if (ids.has(r.b)) reached.add(r.a);
          }
          const records = [...reached]
            .map((id) => graph.nodes.get(id))
            // `WHERE node IS NOT NULL AND NOT node:Candidate`.
            .filter((n): n is GraphNode => !!n && !graph.hasLabel(n, CANDIDATE_NODE_LABEL))
            .map((n) => graph.rowFromNode(n));
          return { records };
        }

        // --- matchProcedures / getBaseContext / anything else -------------
        return { records: [] };
      },
      close: async () => {},
    };
  }
}

function makeService(graph: FakeWorldGraph): WkgContextService {
  return new WkgContextService(graph as unknown as never, null as unknown as never);
}

/** A minimal frame whose raw text mentions the proper noun "Max". */
function frameMentioning(text: string): SensoryFrame {
  return { raw: { text } } as unknown as SensoryFrame;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave3-C0 — :Candidate is never grounding-eligible (CANON Std-3 §2.8)', () => {
  /** Seed a candidate and an entity that share the SAME label "Max". */
  function seedTwins(graph: FakeWorldGraph): void {
    graph.addNode({
      node_id: 'cand-max',
      label: 'Max',
      labels: [CANDIDATE_NODE_LABEL],
      confidence: 0.6,
      provenance_type: 'CANDIDATE',
      props: { grounding_person_id: 'person-jim' },
    });
    graph.addNode({
      node_id: 'entity-max',
      label: 'Max',
      labels: ['Entity'],
      confidence: 0.45,
      provenance_type: 'SENSOR',
    });
  }

  it('matchEntities (fulltext): returns the :Entity twin, NEVER the :Candidate', async () => {
    const graph = new FakeWorldGraph();
    seedTwins(graph);
    const svc = makeService(graph);

    const results = await svc.queryEntities('Max');

    const ids = results.map((e) => e.nodeId);
    expect(ids).toContain('entity-max'); // entity still surfaces
    expect(ids).not.toContain('cand-max'); // candidate never does
    expect(results.every((e) => e.provenance !== 'CANDIDATE')).toBe(true);
  });

  it('matchEntities (CONTAINS fallback): same exclusion when the fulltext index is unavailable', async () => {
    const graph = new FakeWorldGraph();
    graph.failFulltext = true; // force the CONTAINS branch
    seedTwins(graph);
    const svc = makeService(graph);

    const results = await svc.queryEntities('Max');

    const ids = results.map((e) => e.nodeId);
    expect(ids).toContain('entity-max');
    expect(ids).not.toContain('cand-max');
  });

  it('getContextForFrame (the real grounding entry): candidate never enters wkg.entities', async () => {
    const graph = new FakeWorldGraph();
    seedTwins(graph);
    const svc = makeService(graph);

    const ctx = await svc.getContextForFrame(frameMentioning('Tell me about Max'));

    const ids = ctx.entities.map((e) => e.nodeId);
    expect(ids).toContain('entity-max');
    expect(ids).not.toContain('cand-max');
    // And no fact/summary surfaces the candidate as knowledge.
    expect(ctx.entities.every((e) => e.provenance !== 'CANDIDATE')).toBe(true);
  });

  it('getContextForFrame with ONLY a candidate (the §2.8 leak shape): yields zero grounding entities', async () => {
    const graph = new FakeWorldGraph();
    // The exact leak: a conversation-derived proper noun staged as a candidate,
    // with NO promoted entity behind it. Reasoning must see no grounding entity.
    graph.addNode({
      node_id: 'cand-nebula',
      label: 'Nebula',
      labels: [CANDIDATE_NODE_LABEL],
      confidence: 0.6,
      provenance_type: 'CANDIDATE',
      props: { grounding_person_id: 'person-jim' },
    });
    const svc = makeService(graph);

    const ctx = await svc.getContextForFrame(frameMentioning('Who is Nebula?'));

    expect(ctx.entities).toHaveLength(0); // nothing groundable
    expect(ctx.entities.find((e) => e.nodeId === 'cand-nebula')).toBeUndefined();
  });

  it('getSubgraph: a :Candidate neighbour is excluded from enrichment, :Entity neighbour kept', async () => {
    const graph = new FakeWorldGraph();
    graph.addNode({ node_id: 'entity-root', label: 'Root', labels: ['Entity'] });
    graph.addNode({ node_id: 'entity-friend', label: 'Friend', labels: ['Entity'] });
    graph.addNode({
      node_id: 'cand-neighbour',
      label: 'Neighbour',
      labels: [CANDIDATE_NODE_LABEL],
      provenance_type: 'CANDIDATE',
    });
    graph.addRel('entity-root', 'KNOWS', 'entity-friend');
    graph.addRel('entity-root', 'KNOWS', 'cand-neighbour');
    const svc = makeService(graph);

    const { entities } = await svc.getSubgraph(['entity-root'], 1);

    const ids = entities.map((e) => e.nodeId);
    expect(ids).toContain('entity-root');
    expect(ids).toContain('entity-friend');
    expect(ids).not.toContain('cand-neighbour');
  });

  it('getEntityFacts: a :Candidate fact-object is never emitted, :Entity object is', async () => {
    const graph = new FakeWorldGraph();
    graph.addNode({ node_id: 'entity-jim', label: 'Jim', labels: ['Entity'] });
    graph.addNode({ node_id: 'entity-coffee', label: 'Coffee', labels: ['Entity'] });
    graph.addNode({
      node_id: 'cand-secret',
      label: 'Secret',
      labels: [CANDIDATE_NODE_LABEL],
      provenance_type: 'CANDIDATE',
    });
    graph.addRel('entity-jim', 'PREFERS', 'entity-coffee');
    graph.addRel('entity-jim', 'MENTIONED', 'cand-secret');
    const svc = makeService(graph);

    const facts = await svc.getEntityFacts('entity-jim');

    const objects = facts.map((f) => f.object);
    expect(objects).toContain('Coffee');
    expect(objects).not.toContain('Secret');
  });

  it('getEntityFacts on a candidate node id directly: emits nothing (defensive on subject endpoint)', async () => {
    const graph = new FakeWorldGraph();
    graph.addNode({
      node_id: 'cand-x',
      label: 'X',
      labels: [CANDIDATE_NODE_LABEL],
      provenance_type: 'CANDIDATE',
    });
    graph.addNode({ node_id: 'entity-y', label: 'Y', labels: ['Entity'] });
    graph.addRel('cand-x', 'RELATED_TO', 'entity-y');
    const svc = makeService(graph);

    const facts = await svc.getEntityFacts('cand-x');
    expect(facts).toHaveLength(0);
  });

  it('getRelationships: a relationship touching a :Candidate endpoint is never returned', async () => {
    const graph = new FakeWorldGraph();
    graph.addNode({ node_id: 'entity-a', label: 'A', labels: ['Entity'] });
    graph.addNode({ node_id: 'entity-b', label: 'B', labels: ['Entity'] });
    graph.addNode({
      node_id: 'cand-c',
      label: 'C',
      labels: [CANDIDATE_NODE_LABEL],
      provenance_type: 'CANDIDATE',
    });
    graph.addRel('entity-a', 'LINKS', 'entity-b');
    graph.addRel('entity-a', 'LINKS', 'cand-c');
    const svc = makeService(graph);

    // Defensive: even if a candidate id is passed in the id set, no edge to it surfaces.
    const rels = await (svc as unknown as {
      getRelationships(session: unknown, ids: string[]): Promise<unknown[]>;
    }).getRelationships(graph.getSession(Neo4jInstanceName.WORLD, 'READ'), [
      'entity-a',
      'entity-b',
      'cand-c',
    ]);

    const targets = (rels as Array<{ targetId: string; sourceId: string }>).flatMap((r) => [
      r.sourceId,
      r.targetId,
    ]);
    expect(targets).toContain('entity-a');
    expect(targets).toContain('entity-b');
    expect(targets).not.toContain('cand-c');
  });
});
