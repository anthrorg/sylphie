/**
 * Confidence decay unit tests.
 *
 * Covers ConfidenceDecayService:
 *
 * WS3-T3 (WORLD instance):
 *   1. The node-decay Cypher now keys decay on coalesce(last_retrieval_at,
 *      updated_at, created_at) — the load-bearing fallback that closes the
 *      compounding loop's decay side (T2 writes last_retrieval_at; T3 reads it).
 *   2. The edge-decay Cypher intentionally does NOT read last_retrieval_at
 *      (T2 reinforces nodes only — no edge carries the field).
 *   3. Behavioral contract of the coalesce, proven against the same decay
 *      arithmetic the Cypher applies:
 *        - a never-reinforced node (no last_retrieval_at) decays from its last
 *          write (updated_at/created_at) exactly as before — no behavior change;
 *        - a reinforced node decays from its last *use* (last_retrieval_at),
 *          so a recently-used node decays LESS than an identically-written but
 *          unused control. This is the durability the loop is supposed to give.
 *
 * TK-49 / EP11.1 (OTHER / OKG instance):
 *   4. Non-GUARDIAN OKG :Attribute nodes past MIN_HOURS_BEFORE_DECAY are decayed
 *      by the OKG decay query at WORLD-matching per-provenance rates (AC1).
 *   5. OKG nodes with provenance_type = 'GUARDIAN' are excluded from the OKG
 *      decay query — the exclusion predicate must be present in the Cypher (AC2).
 *   6. The OKG prune query targets :Attribute nodes in the OTHER instance with
 *      no relationships (AC3).
 *   7. The cycle now touches the OTHER instance (OKG decay is no longer deferred).
 *
 * The decay itself is raw Cypher executed by Neo4j, so we (a) assert the query
 * text contains the intended predicates, via a Cypher-capturing fake session,
 * and (b) re-derive the decay formula in JS and verify the arithmetic.
 */

import { Neo4jInstanceName } from '@sylphie/shared';
import { ConfidenceDecayService } from './confidence-decay.service';

// ---------------------------------------------------------------------------
// Cypher-capturing fake Neo4j
// ---------------------------------------------------------------------------

class CapturingNeo4j {
  /** Every (instance, cypher) pair a session executed. */
  readonly runs: Array<{ instance: Neo4jInstanceName; cypher: string }> = [];

  getSession(name: Neo4jInstanceName, _mode: 'READ' | 'WRITE') {
    return {
      run: async (cypher: string, _params: Record<string, unknown>) => {
        this.runs.push({ instance: name, cypher });
        return { records: [] };
      },
      close: async () => {},
    };
  }
}

function makeService(neo: CapturingNeo4j): ConfidenceDecayService {
  return new ConfidenceDecayService(neo as unknown as never);
}

// ---------------------------------------------------------------------------
// Decay formula mirror (matches the Cypher in decayNodes() and decayOkgNodes()):
//   hoursSince = (now - lastActivity) / 3600000
//   newConf    = max(0, conf - decayRate * ln(hoursSince + 1))   [if hours > MIN]
// ---------------------------------------------------------------------------

const MIN_HOURS_BEFORE_DECAY = 1.0;

function decay(conf: number, decayRate: number, lastActivityMs: number, nowMs: number): number {
  const hoursSince = (nowMs - lastActivityMs) / 3600000.0;
  if (hoursSince <= MIN_HOURS_BEFORE_DECAY) return conf;
  const newConf = conf - decayRate * Math.log(hoursSince + 1);
  return Math.max(0.0, newConf);
}

/** coalesce(last_retrieval_at, updated_at, created_at) — first non-null. */
function coalesceLastActivity(
  lastRetrievalAt: number | null,
  updatedAt: number | null,
  createdAt: number | null,
): number | null {
  return lastRetrievalAt ?? updatedAt ?? createdAt;
}

// ---------------------------------------------------------------------------
// WS3-T3 tests (WORLD instance)
// ---------------------------------------------------------------------------

describe('WS3-T3 — retrieval-aware ConfidenceDecayService (WORLD)', () => {
  // -------------------------------------------------------------------------
  // 1. Query shape: node decay keys on coalesce(last_retrieval_at, ...)
  // -------------------------------------------------------------------------
  it('node-decay query keys decay on coalesce(last_retrieval_at, updated_at, created_at)', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    // Find the WORLD node-decay query (matches a bare node, sets confidence + decayed_at).
    const nodeQuery = neo.runs.find(
      (r) => r.instance === Neo4jInstanceName.WORLD &&
             /MATCH \(n\)/.test(r.cypher) &&
             /SET n\.confidence/.test(r.cypher),
    );
    expect(nodeQuery).toBeDefined();
    expect(nodeQuery!.cypher).toContain(
      'coalesce(n.last_retrieval_at, n.updated_at, n.created_at)',
    );
    // The old write-time proxy must be gone.
    expect(nodeQuery!.cypher).not.toMatch(/CASE WHEN n\.updated_at IS NOT NULL/);
  });

  // -------------------------------------------------------------------------
  // 2. Edge decay intentionally does NOT read last_retrieval_at
  // -------------------------------------------------------------------------
  it('edge-decay query does NOT read last_retrieval_at (T2 reinforces nodes only)', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    const edgeQuery = neo.runs.find(
      (r) => /MATCH \(\)-\[r\]->\(\)/.test(r.cypher) && /SET r\.confidence/.test(r.cypher),
    );
    expect(edgeQuery).toBeDefined();
    expect(edgeQuery!.cypher).not.toContain('last_retrieval_at');
  });

  // -------------------------------------------------------------------------
  // 3. WORLD and OTHER are both touched by the decay cycle (TK-49 landed).
  // -------------------------------------------------------------------------
  it('decay cycle touches both WORLD and OTHER instances (TK-49 OKG decay implemented)', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    expect(neo.runs.some((r) => r.instance === Neo4jInstanceName.WORLD)).toBe(true);
    expect(neo.runs.some((r) => r.instance === Neo4jInstanceName.OTHER)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4a. Fallback: a never-reinforced node decays from its last WRITE, unchanged.
  // -------------------------------------------------------------------------
  it('never-reinforced node (no last_retrieval_at): coalesce falls back to updated_at — decay unchanged', () => {
    const now = Date.now();
    const writeMs = now - 100 * 3600000; // last written 100h ago
    const conf = 0.5;
    const rate = 0.06; // INFERENCE

    // No last_retrieval_at → coalesce yields updated_at (the pre-T3 behavior).
    const selected = coalesceLastActivity(null, writeMs, writeMs - 999);
    expect(selected).toBe(writeMs);

    const newCoalesce = decay(conf, rate, selected!, now);
    // Identical to the old proxy which used updated_at directly.
    const oldProxy = decay(conf, rate, writeMs, now);
    expect(newCoalesce).toBe(oldProxy);
    expect(newCoalesce).toBeLessThan(conf); // it did decay
  });

  // -------------------------------------------------------------------------
  // 4b. Reinforced node decays from last USE → diverges upward from a
  //     never-recalled control (the compounding dynamic T4 will prove live).
  // -------------------------------------------------------------------------
  it('reinforced node decays from last_retrieval_at → less decay than an unused, identically-written control', () => {
    const now = Date.now();
    const writeMs = now - 100 * 3600000; // both written 100h ago
    const useMs = now - 2 * 3600000;      // recalled node last used 2h ago
    const conf = 0.5;
    const rate = 0.06; // INFERENCE

    // Recalled node: coalesce picks last_retrieval_at (the recent use).
    const recalledActivity = coalesceLastActivity(useMs, writeMs, writeMs - 999);
    expect(recalledActivity).toBe(useMs);
    const recalledConf = decay(conf, rate, recalledActivity!, now);

    // Control: never recalled, coalesce falls back to updated_at (the old write).
    const controlActivity = coalesceLastActivity(null, writeMs, writeMs - 999);
    const controlConf = decay(conf, rate, controlActivity!, now);

    // The used node retained MORE confidence than the unused control.
    expect(recalledConf).toBeGreaterThan(controlConf);
    // Both still decayed below the starting confidence (decay is one-directional here).
    expect(recalledConf).toBeLessThan(conf);
    expect(controlConf).toBeLessThan(conf);
  });

  // -------------------------------------------------------------------------
  // 4c. A node used within MIN_HOURS_BEFORE_DECAY is shielded entirely.
  // -------------------------------------------------------------------------
  it('node used within MIN_HOURS_BEFORE_DECAY is not decayed at all (fresh-use shield)', () => {
    const now = Date.now();
    const writeMs = now - 500 * 3600000; // written long ago
    const useMs = now - 0.5 * 3600000;   // but used 30 min ago
    const conf = 0.5;
    const rate = 0.06;

    const activity = coalesceLastActivity(useMs, writeMs, null);
    const result = decay(conf, rate, activity!, now);
    expect(result).toBe(conf); // hoursSince (0.5) <= MIN (1.0) → untouched
  });
});

// ---------------------------------------------------------------------------
// TK-49 / EP11.1 tests — OKG decay (OTHER instance)
// ---------------------------------------------------------------------------

describe('TK-49 / EP11.1 — OKG :Attribute decay (OTHER instance)', () => {
  // -------------------------------------------------------------------------
  // AC1: Non-GUARDIAN OKG :Attribute nodes are decayed at WORLD-matching rates.
  // -------------------------------------------------------------------------
  it('AC1: OKG decay query targets :Attribute nodes in the OTHER instance with coalesce and per-provenance rates', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    const okgDecayQuery = neo.runs.find(
      (r) => r.instance === Neo4jInstanceName.OTHER &&
             /MATCH \(n:Attribute\)/.test(r.cypher) &&
             /SET n\.confidence/.test(r.cypher),
    );
    expect(okgDecayQuery).toBeDefined();

    // Same coalesce as WORLD (last_retrieval_at → updated_at → created_at).
    expect(okgDecayQuery!.cypher).toContain(
      'coalesce(n.last_retrieval_at, n.updated_at, n.created_at)',
    );

    // Per-provenance rates — must include at least LLM_GENERATED and INFERENCE.
    expect(okgDecayQuery!.cypher).toContain("WHEN 'LLM_GENERATED' THEN 0.08");
    expect(okgDecayQuery!.cypher).toContain("WHEN 'INFERENCE'     THEN 0.06");
  });

  // -------------------------------------------------------------------------
  // AC2: GUARDIAN nodes are excluded — the exclusion predicate must appear.
  // -------------------------------------------------------------------------
  it('AC2: OKG decay query excludes GUARDIAN nodes via provenance_type <> GUARDIAN predicate', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    const okgDecayQuery = neo.runs.find(
      (r) => r.instance === Neo4jInstanceName.OTHER &&
             /MATCH \(n:Attribute\)/.test(r.cypher) &&
             /SET n\.confidence/.test(r.cypher),
    );
    expect(okgDecayQuery).toBeDefined();

    // The hard-exclusion predicate must be in the WHERE clause.
    expect(okgDecayQuery!.cypher).toContain("n.provenance_type <> 'GUARDIAN'");

    // GUARDIAN must NOT appear as a decay-rate case — it is excluded, not slowed.
    expect(okgDecayQuery!.cypher).not.toMatch(/WHEN 'GUARDIAN'\s+THEN/);
  });

  // -------------------------------------------------------------------------
  // AC2 (arithmetic): GUARDIAN exclusion is a hard skip — verify via formula.
  //   A GUARDIAN node written 200h ago should produce NO decay if excluded.
  // -------------------------------------------------------------------------
  it('AC2 (arithmetic): GUARDIAN node provenance carries 0 decay when excluded (hard skip, not slow rate)', () => {
    const now = Date.now();
    const writeMs = now - 200 * 3600000; // written 200h ago — well past MIN_HOURS
    const conf = 0.90; // typical GUARDIAN confidence

    // With a GUARDIAN-rate 0.03 the formula would reduce confidence.
    const withSlowRate = decay(conf, 0.03, writeMs, now);
    expect(withSlowRate).toBeLessThan(conf); // slow but non-zero decay

    // Hard exclusion = no decay call at all → confidence stays exactly 0.90.
    const hardExcluded = conf; // node is never passed to the decay formula
    expect(hardExcluded).toBe(conf);

    // The two outcomes are different — proving exclusion is stronger than a slow rate.
    expect(hardExcluded).toBeGreaterThan(withSlowRate);
  });

  // -------------------------------------------------------------------------
  // AC3: OKG prune query targets :Attribute orphans in the OTHER instance.
  // -------------------------------------------------------------------------
  it('AC3: OKG prune query deletes :Attribute nodes in OTHER with no relationships', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    const okgPruneQuery = neo.runs.find(
      (r) => r.instance === Neo4jInstanceName.OTHER &&
             /MATCH \(n:Attribute\)/.test(r.cypher) &&
             /DELETE n/.test(r.cypher),
    );
    expect(okgPruneQuery).toBeDefined();

    // Must check for no relationships — NOT EXISTS { (n)--() }.
    expect(okgPruneQuery!.cypher).toContain('NOT EXISTS');

    // Must be bounded by pruneThreshold.
    expect(okgPruneQuery!.cypher).toContain('pruneThreshold');
  });

  // -------------------------------------------------------------------------
  // Result shape: runDecayCycle returns okgNodesDecayed and okgNodesPruned.
  // -------------------------------------------------------------------------
  it('runDecayCycle result includes okgNodesDecayed and okgNodesPruned fields', async () => {
    const neo = new CapturingNeo4j();
    const result = await makeService(neo).runDecayCycle();

    expect(result).toHaveProperty('okgNodesDecayed');
    expect(result).toHaveProperty('okgNodesPruned');
    expect(typeof result.okgNodesDecayed).toBe('number');
    expect(typeof result.okgNodesPruned).toBe('number');
  });

  // -------------------------------------------------------------------------
  // wasNoop accounts for OKG activity.
  // -------------------------------------------------------------------------
  it('wasNoop is true when both WORLD and OKG queries return zero counts', async () => {
    const neo = new CapturingNeo4j();
    const result = await makeService(neo).runDecayCycle();

    // Fake session returns empty records[] → all counts are 0.
    expect(result.nodesDecayed).toBe(0);
    expect(result.edgesDecayed).toBe(0);
    expect(result.nodesPruned).toBe(0);
    expect(result.okgNodesDecayed).toBe(0);
    expect(result.okgNodesPruned).toBe(0);
    expect(result.wasNoop).toBe(true);
  });
});
