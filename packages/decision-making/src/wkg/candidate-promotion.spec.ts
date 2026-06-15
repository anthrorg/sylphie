/**
 * Wave 3 / chunk C4 — guardian candidate-promotion unit tests.
 *
 * Closes ws5-t1 (world-fact promotion). A staged `:Candidate` proper noun
 * (provenance_type 'CANDIDATE', confidence ≤0.60, non-groundable by construction —
 * proven in candidate-grounding-exclusion.spec.ts) is promoted by a guardian to a
 * live `:Entity`, which:
 *   - is RELABELED `:Candidate → :Entity`,
 *   - carries provenance_type 'GUARDIAN_APPROVED_INFERENCE' (CANON Std-2),
 *   - is lifted to GUARDIAN_CONFIRMED_CONFIDENCE (0.90 — the Std-5 guardian
 *     exception to the 0.60 ceiling), and
 *   - is now RETURNED by matchEntities (i.e. grounding-eligible).
 *
 * CANON Std-5 (guardian asymmetry) — the load-bearing standard for C4: a
 * non-guardian promotion attempt MUST be rejected as a no-op and MUST NOT touch
 * the graph (the candidate stays a candidate, still non-groundable).
 *
 * The fake Neo4j below is LABEL-AWARE and MUTATING: its `run()` interprets the
 * promotion Cypher (`REMOVE n:Candidate SET n:Entity SET n.provenance_type=… …`)
 * by actually mutating the in-memory node's labels/props, AND interprets the
 * `NOT node:Candidate` grounding-exclusion on matchEntities — so the same fake
 * graph proves both the write and the resulting grounding-eligibility against the
 * REAL Cypher in wkg-context.service.ts. A dropped REMOVE/SET or a dropped
 * exclusion clause fails an assertion.
 */

import {
  Neo4jInstanceName,
  CANDIDATE_NODE_LABEL,
  CANDIDATE_PROVENANCE_TYPE,
  CANDIDATE_PROMOTION_PROVENANCE_TYPE,
  GUARDIAN_CONFIRMED_CONFIDENCE,
  CANDIDATE_CONFIDENCE_CAP,
} from '@sylphie/shared';
import { WkgContextService } from './wkg-context.service';

// ---------------------------------------------------------------------------
// Label-aware, MUTATING in-memory WORLD graph + a Cypher-interpreting fake.
// ---------------------------------------------------------------------------

interface GraphNode {
  node_id: string;
  label: string;
  labels: string[];
  confidence: number;
  provenance_type: string;
  props: Record<string, unknown>;
}

class FakeWorldGraph {
  readonly nodes = new Map<string, GraphNode>();

  addNode(n: Partial<GraphNode> & { node_id: string; label: string; labels: string[] }): void {
    this.nodes.set(n.node_id, {
      confidence: 0.5,
      provenance_type: 'INFERENCE',
      props: {},
      ...n,
    });
  }

  private hasLabel(n: GraphNode, label: string): boolean {
    return n.labels.includes(label);
  }

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
          case 'provenanceType':
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
        // --- promoteCandidate: REMOVE :Candidate SET :Entity … --------------
        if (/REMOVE n:Candidate/.test(cypher) && /SET n:Entity/.test(cypher)) {
          // Selector: by node_id or by label, both `:Candidate`-scoped.
          const byId = typeof params['candidateId'] === 'string' && /\{node_id:/.test(cypher);
          let target: GraphNode | undefined;
          if (byId) {
            const id = params['candidateId'] as string;
            const n = graph.nodes.get(id);
            if (n && graph.hasLabel(n, CANDIDATE_NODE_LABEL)) target = n;
          } else {
            const label = params['label'] as string;
            target = [...graph.nodes.values()].find(
              (n) => n.label === label && graph.hasLabel(n, CANDIDATE_NODE_LABEL),
            );
          }
          if (!target) return { records: [] }; // :Candidate-scoped MATCH miss.

          // Apply the relabel + provenance/confidence stamp (the real SET clause).
          target.labels = target.labels.filter((l) => l !== CANDIDATE_NODE_LABEL);
          if (!target.labels.includes('Entity')) target.labels.push('Entity');
          target.provenance_type = params['provenanceType'] as string;
          target.confidence = params['newConfidence'] as number;
          target.props.promoted_by = 'guardian';
          target.props.promoted_from = params['candidateProvenance'];

          return { records: [graph.rowFromNode(target)] };
        }

        // --- matchEntities: fulltext branch ---------------------------------
        if (/db\.index\.fulltext\.queryNodes/.test(cypher)) {
          const query = String(params['query'] ?? '');
          const terms = query
            .split(/\s+OR\s+/)
            .map((t) => t.replace(/\\(.)/g, '$1').toLowerCase())
            .filter(Boolean);
          const records = [...graph.nodes.values()]
            .filter((n) => terms.some((t) => n.label.toLowerCase().includes(t)))
            .filter((n) => graph.isGroundingEligible(n))
            .map((n) => graph.rowFromNode(n));
          return { records };
        }

        return { records: [] };
      },
      close: async () => {},
    };
  }
}

function makeService(graph: FakeWorldGraph): WkgContextService {
  return new WkgContextService(graph as unknown as never, null as unknown as never);
}

function seedCandidate(graph: FakeWorldGraph): void {
  graph.addNode({
    node_id: 'candidate-maxford',
    label: 'Maxford',
    labels: [CANDIDATE_NODE_LABEL],
    confidence: CANDIDATE_CONFIDENCE_CAP, // staged at the cap (≤0.60).
    provenance_type: CANDIDATE_PROVENANCE_TYPE,
    props: { grounding_person_id: 'person-guest' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave3-C4 — guardian candidate promotion :Candidate → :Entity (CANON Std-5)', () => {
  it('(a) guardian promotion: relabels to :Entity, stamps GUARDIAN_APPROVED_INFERENCE, lifts confidence, and is now grounding-eligible', async () => {
    const graph = new FakeWorldGraph();
    seedCandidate(graph);
    const svc = makeService(graph);

    // Pre-condition: the seeded node is NOT grounding-eligible (it's a :Candidate).
    const before = await svc.queryEntities('Maxford');
    expect(before.map((e) => e.nodeId)).not.toContain('candidate-maxford');

    // Guardian promotes by id.
    const res = await svc.promoteCandidate({ candidateId: 'candidate-maxford' }, true);

    expect(res.promoted).toBe(true);
    expect(res.nodeId).toBe('candidate-maxford');
    expect(res.label).toBe('Maxford');
    expect(res.provenanceType).toBe(CANDIDATE_PROMOTION_PROVENANCE_TYPE); // GUARDIAN_APPROVED_INFERENCE
    expect(res.newConfidence).toBe(GUARDIAN_CONFIRMED_CONFIDENCE); // 0.90, the Std-5 exception
    expect(res.newConfidence! > CANDIDATE_CONFIDENCE_CAP).toBe(true); // cap lifted

    // The node itself is now :Entity with the new provenance/confidence.
    const node = graph.nodes.get('candidate-maxford')!;
    expect(node.labels).toContain('Entity');
    expect(node.labels).not.toContain(CANDIDATE_NODE_LABEL);
    expect(node.provenance_type).toBe('GUARDIAN_APPROVED_INFERENCE');

    // Post-condition: matchEntities NOW returns it (grounding-eligible).
    const after = await svc.queryEntities('Maxford');
    const hit = after.find((e) => e.nodeId === 'candidate-maxford');
    expect(hit).toBeDefined();
    expect(hit!.provenance).toBe('GUARDIAN_APPROVED_INFERENCE');
  });

  it('(a-by-label) guardian promotion by label works the same', async () => {
    const graph = new FakeWorldGraph();
    seedCandidate(graph);
    const svc = makeService(graph);

    const res = await svc.promoteCandidate({ label: 'Maxford' }, true);
    expect(res.promoted).toBe(true);
    expect(res.nodeId).toBe('candidate-maxford');

    const after = await svc.queryEntities('Maxford');
    expect(after.map((e) => e.nodeId)).toContain('candidate-maxford');
  });

  it('(b) CANON Std-5: a non-guardian promotion is REJECTED and never touches the graph', async () => {
    const graph = new FakeWorldGraph();
    seedCandidate(graph);
    const svc = makeService(graph);

    const res = await svc.promoteCandidate({ candidateId: 'candidate-maxford' }, false);

    expect(res.promoted).toBe(false);
    expect(res.reason).toBe('not_guardian');

    // The candidate is UNCHANGED — still :Candidate, still capped, still non-groundable.
    const node = graph.nodes.get('candidate-maxford')!;
    expect(node.labels).toContain(CANDIDATE_NODE_LABEL);
    expect(node.labels).not.toContain('Entity');
    expect(node.provenance_type).toBe(CANDIDATE_PROVENANCE_TYPE);
    expect(node.confidence).toBeLessThanOrEqual(CANDIDATE_CONFIDENCE_CAP);

    const after = await svc.queryEntities('Maxford');
    expect(after.map((e) => e.nodeId)).not.toContain('candidate-maxford');
  });

  it('idempotent: re-promoting an already-promoted (:Entity) node is a not_found no-op (no second cap-lift)', async () => {
    const graph = new FakeWorldGraph();
    seedCandidate(graph);
    const svc = makeService(graph);

    await svc.promoteCandidate({ candidateId: 'candidate-maxford' }, true);
    // Now it is :Entity. A second guardian confirm finds no :Candidate.
    const second = await svc.promoteCandidate({ candidateId: 'candidate-maxford' }, true);
    expect(second.promoted).toBe(false);
    expect(second.reason).toBe('not_found');
    // Confidence stayed at the single guardian-confirmed value, not re-lifted.
    expect(graph.nodes.get('candidate-maxford')!.confidence).toBe(GUARDIAN_CONFIRMED_CONFIDENCE);
  });

  it('not_found: promoting a label that has no :Candidate is an honest no-op', async () => {
    const graph = new FakeWorldGraph();
    const svc = makeService(graph);
    const res = await svc.promoteCandidate({ label: 'Nonexistent' }, true);
    expect(res.promoted).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('no selector: neither candidateId nor label → not_found no-op (guardian still gated first)', async () => {
    const graph = new FakeWorldGraph();
    const svc = makeService(graph);
    // Non-guardian with no selector is still rejected as not_guardian (Std-5 asserted first).
    const rejected = await svc.promoteCandidate({}, false);
    expect(rejected.reason).toBe('not_guardian');
    // Guardian with no selector is a not_found no-op.
    const guardian = await svc.promoteCandidate({}, true);
    expect(guardian.reason).toBe('not_found');
  });
});
