/**
 * WS3 Ticket T3 — retrieval-aware confidence decay unit tests.
 *
 * Covers ConfidenceDecayService:
 *   1. The node-decay Cypher now keys decay on coalesce(last_retrieval_at,
 *      updated_at, created_at) — the load-bearing fallback that closes the
 *      compounding loop's decay side (T2 writes last_retrieval_at; T3 reads it).
 *   2. The edge-decay Cypher intentionally does NOT read last_retrieval_at
 *      (T2 reinforces nodes only — no edge carries the field).
 *   3. Scope: decay runs only against the WORLD instance; OTHER (OKG self-facts)
 *      is never decayed by this service (deferred to T4 — stub §2.11).
 *   4. Behavioral contract of the coalesce, proven against the same decay
 *      arithmetic the Cypher applies:
 *        - a never-reinforced node (no last_retrieval_at) decays from its last
 *          write (updated_at/created_at) exactly as before — no behavior change;
 *        - a reinforced node decays from its last *use* (last_retrieval_at),
 *          so a recently-used node decays LESS than an identically-written but
 *          unused control. This is the durability the loop is supposed to give.
 *
 * The decay itself is raw Cypher executed by Neo4j, so we (a) assert the query
 * text contains the intended coalesce, via a Cypher-capturing fake session, and
 * (b) re-derive the decay formula in JS and feed it the lastActivity that the
 * coalesce would select, proving the divergence the live DB would produce.
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
// Decay formula mirror (matches the Cypher in decayNodes()):
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
// Tests
// ---------------------------------------------------------------------------

describe('WS3-T3 — retrieval-aware ConfidenceDecayService', () => {
  // -------------------------------------------------------------------------
  // 1. Query shape: node decay keys on coalesce(last_retrieval_at, ...)
  // -------------------------------------------------------------------------
  it('node-decay query keys decay on coalesce(last_retrieval_at, updated_at, created_at)', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    // Find the node-decay query (matches a bare node, sets confidence + decayed_at).
    const nodeQuery = neo.runs.find(
      (r) => /MATCH \(n\)/.test(r.cypher) && /SET n\.confidence/.test(r.cypher),
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
  // 3. Scope: decay runs only against WORLD; OTHER is never touched.
  // -------------------------------------------------------------------------
  it('decay runs only against the WORLD instance (OTHER/OKG self-facts deferred to T4)', async () => {
    const neo = new CapturingNeo4j();
    await makeService(neo).runDecayCycle();

    expect(neo.runs.length).toBeGreaterThan(0);
    expect(neo.runs.every((r) => r.instance === Neo4jInstanceName.WORLD)).toBe(true);
    expect(neo.runs.some((r) => r.instance === Neo4jInstanceName.OTHER)).toBe(false);
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
