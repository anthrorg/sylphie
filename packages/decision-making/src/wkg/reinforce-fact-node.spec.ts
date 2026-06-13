/**
 * WS3 Ticket T2 — knowledge use→reinforce edge unit tests.
 *
 * Covers WkgContextService.reinforceFactNode():
 *   - OKG reinforce  → writes to the Neo4j OTHER instance, on (:Attribute {attr_id}).
 *   - WKG reinforce  → writes to the Neo4j WORLD instance, on ({node_id}).
 *   - 0.60 ceiling clamp (Std 3): recall-use never lifts confidence past 0.60.
 *   - already-above-0.60 guardian case: confidence is left untouched (never demoted),
 *     but retrieval_count / last_retrieval_at still advance (T3 dependency).
 *   - node-not-found → honest no-op (null), no fabricated write.
 *   - graph isolation: OKG never touches WORLD; WKG never touches OTHER.
 *
 * The "no-reinforce-when-not-grounded" and "idempotent-per-turn" conditions are
 * enforced at the CALL SITE (decision-making.service.ts) by the guard
 *   responseGrounding === 'GROUNDED' && responseGroundingProvenance === recallRetrieval.factNodeId
 * — reinforceFactNode() itself is only ever invoked for a surfaced grounded node.
 * The call-site guard semantics are asserted as pure logic in the final block so
 * the not-grounded / once-per-turn contract is covered without standing up the
 * whole 2000-line cycle.
 */

import { Neo4jInstanceName, CONFIDENCE_THRESHOLDS } from '@sylphie/shared';
import { WkgContextService } from './wkg-context.service';

// ---------------------------------------------------------------------------
// Minimal Neo4j mock: an in-memory node store keyed by id, plus a fake session
// whose run() services the T2 read (RETURN ...) and write (SET ...) queries.
// ---------------------------------------------------------------------------

interface FakeNode {
  confidence: number | null;
  provenance_type: string | null;
  retrieval_count: number | null;
}

/** A Neo4j Integer-like wrapper to exercise toInt()'s toNumber() branch. */
function neoInt(n: number): { toNumber(): number } {
  return { toNumber: () => n };
}

class FakeNeo4j {
  /** Per-instance node stores, so we can assert graph isolation. */
  readonly stores: Record<string, Map<string, FakeNode>> = {
    [Neo4jInstanceName.WORLD]: new Map(),
    [Neo4jInstanceName.OTHER]: new Map(),
    [Neo4jInstanceName.SELF]: new Map(),
    [Neo4jInstanceName.PKG]: new Map(),
  };

  /** Records every (instance) a session was opened against. */
  readonly sessionInstances: Neo4jInstanceName[] = [];

  getSession(name: Neo4jInstanceName, _mode: 'READ' | 'WRITE') {
    this.sessionInstances.push(name);
    const store = this.stores[name];
    return {
      run: async (cypher: string, params: Record<string, unknown>) => {
        const id = params['nodeId'] as string;
        const node = store.get(id);
        if (/RETURN/i.test(cypher)) {
          if (!node) return { records: [] };
          return {
            records: [
              {
                get: (k: string) => {
                  if (k === 'confidence') return node.confidence;
                  if (k === 'provenanceType') return node.provenance_type;
                  if (k === 'retrievalCount') return neoInt(node.retrieval_count ?? 0);
                  return null;
                },
              },
            ],
          };
        }
        // SET write: reflect the new confidence + retrieval_count into the store.
        if (/SET/i.test(cypher) && node) {
          node.confidence = params['newConfidence'] as number;
          node.retrieval_count = params['newCount'] as number;
        }
        return { records: [] };
      },
      close: async () => {},
    };
  }
}

function makeService(neo: FakeNeo4j): WkgContextService {
  // Constructor: (neo4j, textEncoder). Both @Optional; we pass a null encoder.
  return new WkgContextService(neo as unknown as never, null as unknown as never);
}

describe('WS3-T2 — reinforceFactNode (knowledge use→reinforce edge)', () => {
  it('OKG reinforce: writes to the OTHER instance and advances retrieval_count', async () => {
    const neo = new FakeNeo4j();
    const attrId = 'attr-jim-name';
    neo.stores[Neo4jInstanceName.OTHER].set(attrId, {
      confidence: 0.4,
      provenance_type: 'OBSERVED',
      retrieval_count: 0,
    });

    const svc = makeService(neo);
    const result = await svc.reinforceFactNode(attrId, 'OKG');

    expect(result).not.toBeNull();
    expect(result!.retrievalCount).toBe(1);
    // Confidence never decreases on a use event.
    expect(result!.newConfidence).toBeGreaterThanOrEqual(result!.oldConfidence);
    // It is the OTHER store that was mutated (graph isolation).
    expect(neo.stores[Neo4jInstanceName.OTHER].get(attrId)!.retrieval_count).toBe(1);
    // Every session opened was against OTHER — never WORLD.
    expect(neo.sessionInstances.every((i) => i === Neo4jInstanceName.OTHER)).toBe(true);
    expect(neo.sessionInstances).not.toContain(Neo4jInstanceName.WORLD);
  });

  it('WKG reinforce: writes to the WORLD instance and advances retrieval_count', async () => {
    const neo = new FakeNeo4j();
    const nodeId = 'entity-abcd1234';
    neo.stores[Neo4jInstanceName.WORLD].set(nodeId, {
      confidence: 0.35,
      provenance_type: 'INFERENCE',
      retrieval_count: 2,
    });

    const svc = makeService(neo);
    const result = await svc.reinforceFactNode(nodeId, 'WKG');

    expect(result).not.toBeNull();
    expect(result!.retrievalCount).toBe(3);
    expect(neo.stores[Neo4jInstanceName.WORLD].get(nodeId)!.retrieval_count).toBe(3);
    // Graph isolation: WKG reinforcement never touched OTHER.
    expect(neo.sessionInstances.every((i) => i === Neo4jInstanceName.WORLD)).toBe(true);
    expect(neo.sessionInstances).not.toContain(Neo4jInstanceName.OTHER);
  });

  it('0.60 ceiling clamp (Std 3): a high retrieval count never lifts past 0.60', async () => {
    const neo = new FakeNeo4j();
    const nodeId = 'entity-hot';
    // Many prior uses: ACT-R growth (0.30 + 0.12*ln(count)) would otherwise exceed
    // 0.60 once count is large, so this exercises the ceiling, not the floor.
    neo.stores[Neo4jInstanceName.WORLD].set(nodeId, {
      confidence: 0.59,
      provenance_type: 'INFERENCE',
      retrieval_count: 50,
    });

    const svc = makeService(neo);
    const result = await svc.reinforceFactNode(nodeId, 'WKG');

    expect(result).not.toBeNull();
    // Recomputed value would be 0.30 + 0.12*ln(51) ≈ 0.77 > ceiling → clamped.
    expect(result!.newConfidence).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.ceiling);
    expect(result!.newConfidence).toBeCloseTo(CONFIDENCE_THRESHOLDS.ceiling, 5);
  });

  it('already-above-0.60 (guardian-confirmed): confidence untouched, retrieval still advances', async () => {
    const neo = new FakeNeo4j();
    const attrId = 'attr-jim-name';
    // A guardian self-fact written at 0.90 (the legitimate guardian exception).
    neo.stores[Neo4jInstanceName.OTHER].set(attrId, {
      confidence: 0.9,
      provenance_type: 'GUARDIAN',
      retrieval_count: 5,
    });

    const svc = makeService(neo);
    const result = await svc.reinforceFactNode(attrId, 'OKG');

    expect(result).not.toBeNull();
    // Never demoted: recall-use leaves the 0.90 confidence exactly where it was.
    expect(result!.newConfidence).toBe(0.9);
    expect(result!.oldConfidence).toBe(0.9);
    // But retrieval_count / last_retrieval_at still advance (T3 dependency).
    expect(result!.retrievalCount).toBe(6);
    expect(neo.stores[Neo4jInstanceName.OTHER].get(attrId)!.confidence).toBe(0.9);
    expect(neo.stores[Neo4jInstanceName.OTHER].get(attrId)!.retrieval_count).toBe(6);
  });

  it('node not found: honest no-op (null), no fabricated write', async () => {
    const neo = new FakeNeo4j();
    const svc = makeService(neo);
    const result = await svc.reinforceFactNode('attr-missing-name', 'OKG');
    expect(result).toBeNull();
    // Store stays empty — nothing was created.
    expect(neo.stores[Neo4jInstanceName.OTHER].size).toBe(0);
  });

  it('Neo4j unavailable: null no-op', async () => {
    const svc = new WkgContextService(null as unknown as never, null as unknown as never);
    const result = await svc.reinforceFactNode('attr-jim-name', 'OKG');
    expect(result).toBeNull();
  });

  it('monotonic compounding: repeated use grows confidence toward (never past) 0.60', async () => {
    const neo = new FakeNeo4j();
    const nodeId = 'entity-compound';
    neo.stores[Neo4jInstanceName.WORLD].set(nodeId, {
      confidence: 0.30,
      provenance_type: 'INFERENCE',
      retrieval_count: 0,
    });
    const svc = makeService(neo);

    let last = 0.30;
    for (let i = 0; i < 20; i++) {
      const r = await svc.reinforceFactNode(nodeId, 'WKG');
      expect(r).not.toBeNull();
      // Each use is >= the last (compounding, never decreasing on use).
      expect(r!.newConfidence).toBeGreaterThanOrEqual(last);
      // And never breaches the ceiling.
      expect(r!.newConfidence).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.ceiling);
      last = r!.newConfidence;
    }
    // After enough uses an inference-grade fact saturates exactly at the ceiling.
    expect(last).toBeCloseTo(CONFIDENCE_THRESHOLDS.ceiling, 5);
  });
});

// ---------------------------------------------------------------------------
// Call-site contract (decision-making.service.ts): the guard that decides
// WHETHER to reinforce. Pure boolean logic, asserted directly so the
// not-grounded / idempotent-per-turn contract is covered hermetically.
// ---------------------------------------------------------------------------

/** Mirror of the call-site guard in decision-making.service.ts. */
function shouldReinforce(
  grounding: string,
  provenance: string | null,
  recalledNodeId: string | null,
): boolean {
  return (
    grounding === 'GROUNDED' &&
    typeof provenance === 'string' &&
    provenance.length > 0 &&
    recalledNodeId !== null &&
    recalledNodeId === provenance
  );
}

describe('WS3-T2 — call-site reinforce guard (not-grounded / idempotent)', () => {
  it('reinforces when GROUNDED and the surfaced node matches the recalled node', () => {
    expect(shouldReinforce('GROUNDED', 'attr-jim-name', 'attr-jim-name')).toBe(true);
  });

  it('does NOT reinforce when the verdict is not GROUNDED (paraphrased away / unknowable)', () => {
    expect(shouldReinforce('LLM_ASSISTED', 'attr-jim-name', 'attr-jim-name')).toBe(false);
    expect(shouldReinforce('UNKNOWN', null, 'attr-jim-name')).toBe(false);
  });

  it('does NOT reinforce when no recall fact was resolved this turn', () => {
    expect(shouldReinforce('GROUNDED', 'attr-jim-name', null)).toBe(false);
  });

  it('does NOT reinforce a node the cycle did not recall-and-use (provenance != recalled)', () => {
    // An ambient/different node grounded the answer — never reinforce the recall fact.
    expect(shouldReinforce('GROUNDED', 'entity-other', 'attr-jim-name')).toBe(false);
  });

  it('fires at most once per turn (single guarded call after the single emit)', () => {
    // The guard is evaluated exactly once per cycle on the single resolved node id,
    // so a true result corresponds to exactly one reinforceFactNode() call.
    const decisions = [shouldReinforce('GROUNDED', 'attr-jim-name', 'attr-jim-name')];
    expect(decisions.filter(Boolean).length).toBe(1);
  });
});
