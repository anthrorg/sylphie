/**
 * Unit tests for SelfModelWriterService.
 *
 * Covers:
 *   (a) Healthy window — ONE :Capability + ONE :PredictionAccuracy MERGE
 *       with success_rate computed over the FILTERED subset (non-empty
 *       predictedEffects only) and confidence clamped ≤ 0.60.
 *   (b) Zero-sample window — NO MERGE Cypher issued; DETACH DELETE issued
 *       for both stale node types.
 *   (c) Confidence clamp boundary — large sampleCount drives rawConfidence
 *       above 0.60; stored value must be exactly 0.60.
 *   (d) provenance_type = 'INFERENCE' in every write path.
 *
 * Strategy: fake TimescaleService returns controlled aggregate rows; a
 * Cypher-capturing fake Neo4jService records every (instance, cypher, params)
 * triple so we can assert exact graph writes without a live DB.
 */

import { Neo4jInstanceName } from '@sylphie/shared';
import { SelfModelWriterService } from './self-model-writer.service';

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

interface CapturedRun {
  instance: Neo4jInstanceName;
  cypher: string;
  params: Record<string, unknown>;
}

class CapturingNeo4j {
  readonly runs: CapturedRun[] = [];

  getSession(instance: Neo4jInstanceName, _mode: 'READ' | 'WRITE') {
    return {
      run: async (cypher: string, params: Record<string, unknown> = {}) => {
        this.runs.push({ instance, cypher, params });
        return { records: [] };
      },
      close: async () => {},
    };
  }
}

interface FakeStatsRow {
  sample_count: string;
  accurate_count: string;
  avg_mae: string | null;
}

interface FakeKnowledgeRow {
  sample_count: string;
  success_count: string;
}

/**
 * SQL-aware fake: the writer now issues TWO distinct aggregate queries in one
 * cycle — PREDICTION_EVALUATED (prediction_accuracy) and RESPONSE_GENERATED
 * (knowledge_retrieval). Route on the event type named in the SQL so each
 * capability sees its own controlled row. The knowledge row defaults to a
 * zero-sample window so the legacy prediction_accuracy tests are unaffected by
 * the second capability (its zero-sample path only DETACH DELETEs its own node).
 */
class FakeTimescale {
  constructor(
    private readonly predictionRow: FakeStatsRow,
    private readonly knowledgeRow: FakeKnowledgeRow = { sample_count: '0', success_count: '0' },
  ) {}

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes('RESPONSE_GENERATED')) {
      return { rows: [this.knowledgeRow as unknown as T] };
    }
    return { rows: [this.predictionRow as unknown as T] };
  }
}

function makeService(
  statsRow: FakeStatsRow,
  knowledgeRow?: FakeKnowledgeRow,
): { service: SelfModelWriterService; neo: CapturingNeo4j } {
  const neo = new CapturingNeo4j();
  const timescale = new FakeTimescale(statsRow, knowledgeRow);
  const service = new SelfModelWriterService(
    neo as unknown as never,
    timescale as unknown as never,
  );
  return { service, neo };
}

/**
 * Helper for knowledge_retrieval-focused tests: prediction defaults to a
 * zero-sample window (so it only DETACH DELETEs its own nodes), letting the
 * knowledge_retrieval assertions stand alone.
 */
function makeKnowledgeService(
  knowledgeRow: FakeKnowledgeRow,
): { service: SelfModelWriterService; neo: CapturingNeo4j } {
  return makeService({ sample_count: '0', accurate_count: '0', avg_mae: null }, knowledgeRow);
}

// ---------------------------------------------------------------------------
// Confidence formula mirror (matches service implementation)
// ---------------------------------------------------------------------------

const CONFIDENCE_K = 50;
const CONFIDENCE_CEILING = 0.60;

function expectedConfidence(sampleCount: number): number {
  const raw = sampleCount / (sampleCount + CONFIDENCE_K);
  return Math.min(CONFIDENCE_CEILING, raw);
}

// ---------------------------------------------------------------------------
// (a) Healthy window
// ---------------------------------------------------------------------------

describe('SelfModelWriterService — (a) healthy window', () => {
  const statsRow: FakeStatsRow = {
    sample_count: '20',
    accurate_count: '15',
    avg_mae: '0.12',
  };

  let service: SelfModelWriterService;
  let neo: CapturingNeo4j;

  beforeEach(() => {
    ({ service, neo } = makeService(statsRow));
  });

  it('returns wrote=true', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.wrote).toBe(true);
  });

  it('returns sampleCount=20', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.sampleCount).toBe(20);
  });

  it('computes success_rate = accurateCount / sampleCount', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.successRate).toBeCloseTo(15 / 20);
  });

  it('confidence is clamped <= 0.60', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.confidence).not.toBeNull();
    expect(result.confidence!).toBeLessThanOrEqual(0.60);
  });

  it('confidence matches formula: min(0.60, n/(n+50))', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.confidence).toBeCloseTo(expectedConfidence(20));
  });

  it('issues exactly ONE Capability MERGE to the SELF instance', () => {
    return service.runSelfModelCycle().then(() => {
      const capRuns = neo.runs.filter(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*Capability/.test(r.cypher),
      );
      expect(capRuns.length).toBe(1);
    });
  });

  it('issues exactly ONE PredictionAccuracy MERGE to the SELF instance', () => {
    return service.runSelfModelCycle().then(() => {
      const paRuns = neo.runs.filter(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*PredictionAccuracy/.test(r.cypher),
      );
      expect(paRuns.length).toBe(1);
    });
  });

  it('issues NO DETACH DELETE of the prediction_accuracy nodes in a healthy window', () => {
    // The knowledge_retrieval capability defaults to a zero-sample window here
    // (makeService default), which legitimately DETACH DELETEs its OWN node;
    // assert specifically that the prediction_accuracy + PredictionAccuracy
    // nodes are NOT deleted when the prediction window is healthy.
    return service.runSelfModelCycle().then(() => {
      const predictionDeletes = neo.runs.filter(
        (r) =>
          /DETACH DELETE/.test(r.cypher) &&
          (/self-cap-prediction_accuracy/.test(JSON.stringify(r.params)) ||
            /PredictionAccuracy/.test(r.cypher)),
      );
      expect(predictionDeletes.length).toBe(0);
    });
  });

  it('writes success_rate correctly to Capability params', () => {
    return service.runSelfModelCycle().then(() => {
      const capRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*Capability/.test(r.cypher),
      );
      expect(capRun).toBeDefined();
      expect(capRun!.params['successRate']).toBeCloseTo(15 / 20);
    });
  });

  it('writes name=prediction_accuracy in the Capability SET clause', () => {
    return service.runSelfModelCycle().then(() => {
      const capRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*Capability/.test(r.cypher),
      );
      expect(capRun!.cypher).toContain("'prediction_accuracy'");
    });
  });

  it('(d) provenance_type is INFERENCE in Capability Cypher', () => {
    return service.runSelfModelCycle().then(() => {
      const capRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*Capability/.test(r.cypher),
      );
      expect(capRun!.cypher).toContain("'INFERENCE'");
    });
  });

  it('writes domain=drive_effects in PredictionAccuracy params', () => {
    return service.runSelfModelCycle().then(() => {
      const paRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*PredictionAccuracy/.test(r.cypher),
      );
      expect(paRun).toBeDefined();
      expect(paRun!.params['domain']).toBe('drive_effects');
    });
  });

  it('writes sample_count to PredictionAccuracy params', () => {
    return service.runSelfModelCycle().then(() => {
      const paRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*PredictionAccuracy/.test(r.cypher),
      );
      expect(paRun!.params['sampleCount']).toBe(20);
    });
  });

  it('wasNoop=false in healthy window', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.wasNoop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) Zero-sample window
// ---------------------------------------------------------------------------

describe('SelfModelWriterService — (b) zero-sample window', () => {
  const statsRow: FakeStatsRow = {
    sample_count: '0',
    accurate_count: '0',
    avg_mae: null,
  };

  let service: SelfModelWriterService;
  let neo: CapturingNeo4j;

  beforeEach(() => {
    ({ service, neo } = makeService(statsRow));
  });

  it('returns wrote=false', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.wrote).toBe(false);
  });

  it('returns sampleCount=0', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.sampleCount).toBe(0);
  });

  it('returns successRate=null', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.successRate).toBeNull();
  });

  it('returns confidence=null', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.confidence).toBeNull();
  });

  it('issues NO MERGE Cypher (no fabricated nodes)', () => {
    return service.runSelfModelCycle().then(() => {
      const merges = neo.runs.filter((r) => /MERGE/.test(r.cypher));
      expect(merges.length).toBe(0);
    });
  });

  it('issues DETACH DELETE for stale Capability node', () => {
    return service.runSelfModelCycle().then(() => {
      const capDelete = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /DETACH DELETE/.test(r.cypher) &&
          /Capability/.test(r.cypher),
      );
      expect(capDelete).toBeDefined();
    });
  });

  it('issues DETACH DELETE for stale PredictionAccuracy node', () => {
    return service.runSelfModelCycle().then(() => {
      const paDelete = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /DETACH DELETE/.test(r.cypher) &&
          /PredictionAccuracy/.test(r.cypher),
      );
      expect(paDelete).toBeDefined();
    });
  });

  it('wasNoop=false (a zero-sample window is an intentional delete, not a skip)', async () => {
    const result = await service.runSelfModelCycle();
    expect(result.wasNoop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) Confidence clamp boundary
// ---------------------------------------------------------------------------

describe('SelfModelWriterService — (c) confidence clamp boundary', () => {
  // With sampleCount=10000, rawConfidence = 10000/10050 ≈ 0.9950 → clamped to 0.60
  const statsRow: FakeStatsRow = {
    sample_count: '10000',
    accurate_count: '9500',
    avg_mae: '0.05',
  };

  it('stores exactly 0.60 when rawConfidence would exceed ceiling', async () => {
    const { service, neo } = makeService(statsRow);
    const result = await service.runSelfModelCycle();

    // The returned value must be exactly the ceiling.
    expect(result.confidence).toBe(0.60);

    // The param written to Neo4j must also be exactly the ceiling.
    const capRun = neo.runs.find(
      (r) =>
        r.instance === Neo4jInstanceName.SELF &&
        /MERGE.*Capability/.test(r.cypher),
    );
    expect(capRun).toBeDefined();
    expect(capRun!.params['confidence']).toBe(0.60);
  });

  it('rawConfidence for n=10000 would exceed 0.60 without the clamp', () => {
    // Prove the clamp is doing real work.
    const raw = 10000 / (10000 + 50);
    expect(raw).toBeGreaterThan(0.60);
  });
});

// ---------------------------------------------------------------------------
// (d) provenance_type = 'INFERENCE' — also tested inline above per run;
//     this group verifies it on the PredictionAccuracy node too.
// ---------------------------------------------------------------------------

describe('SelfModelWriterService — (d) provenance is always INFERENCE', () => {
  const statsRow: FakeStatsRow = {
    sample_count: '5',
    accurate_count: '3',
    avg_mae: '0.20',
  };

  it('PredictionAccuracy node does NOT carry a provenance_type param (node has no provenance field in reader contract)', () => {
    // The :PredictionAccuracy reader (self-assessment.service.ts:readPredictionAccuracy)
    // does not query provenance_type on PredictionAccuracy nodes — provenance lives
    // on the :Capability node only. Verify we do not accidentally write one.
    const { service, neo } = makeService(statsRow);
    return service.runSelfModelCycle().then(() => {
      const paRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*PredictionAccuracy/.test(r.cypher),
      );
      expect(paRun).toBeDefined();
      // The SET clause should NOT set provenance_type on PredictionAccuracy.
      // (Provenance lives on the :Capability node per the reader contract.)
      expect(paRun!.cypher).not.toMatch(/provenance_type.*PredictionAccuracy/);
    });
  });

  it('Capability MERGE uses node_id=self-cap-prediction_accuracy (MERGE key)', () => {
    const { service, neo } = makeService(statsRow);
    return service.runSelfModelCycle().then(() => {
      const capRun = neo.runs.find(
        (r) =>
          r.instance === Neo4jInstanceName.SELF &&
          /MERGE.*Capability/.test(r.cypher),
      );
      expect(capRun!.params['nodeId']).toBe('self-cap-prediction_accuracy');
    });
  });

  it('all SELF writes go to Neo4jInstanceName.SELF (never WORLD)', async () => {
    const { service, neo } = makeService(statsRow);
    await service.runSelfModelCycle();
    const nonSelf = neo.runs.filter((r) => r.instance !== Neo4jInstanceName.SELF);
    expect(nonSelf.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (e) knowledge_retrieval — theater defense (CANON Std-1, the whole point)
// ---------------------------------------------------------------------------
//
// Conceptual seed set of RESPONSE_GENERATED rows in the 24h window:
//   3 × { knowledgeGrounding:'GROUNDED',      intent:'QUESTION' }   ← num + denom
//   1 × { knowledgeGrounding:'UNKNOWN',       intent:'QUESTION' }   ← denom only
//   5 × { knowledgeGrounding:'LLM_ASSISTED',  intent:'QUESTION' }   ← EXCLUDED (social)
//   2 × { knowledgeGrounding:'GROUNDED',      intent:'STATEMENT' }  ← EXCLUDED (not QUESTION)
//   2 × { knowledgeGrounding:null,            intent:'QUESTION' }   ← EXCLUDED (null)
//
// After the SQL FILTERs: sample_count=4 (3 GROUNDED + 1 UNKNOWN), success_count=3.
// successRate = 3/4 = 0.75.  We model what the DB would AGGREGATE for that seed
// set (the exclusion logic is SQL, asserted separately below) and verify the
// writer's arithmetic + write are honest.
describe('SelfModelWriterService — (e) knowledge_retrieval theater defense', () => {
  const knowledgeRow: FakeKnowledgeRow = { sample_count: '4', success_count: '3' };

  it('computes successRate = success_count / sample_count = 0.75', async () => {
    const { service } = makeKnowledgeService(knowledgeRow);
    const result = await service.runSelfModelCycle();
    expect(result.knowledgeRetrieval).toBeDefined();
    expect(result.knowledgeRetrieval!.wrote).toBe(true);
    expect(result.knowledgeRetrieval!.sampleCount).toBe(4);
    expect(result.knowledgeRetrieval!.successRate).toBeCloseTo(0.75);
  });

  it('writes name=knowledge_retrieval with success_rate=0.75 to the SELF instance', async () => {
    const { service, neo } = makeKnowledgeService(knowledgeRow);
    await service.runSelfModelCycle();
    const krRun = neo.runs.find(
      (r) =>
        r.instance === Neo4jInstanceName.SELF &&
        /MERGE.*Capability/.test(r.cypher) &&
        /'knowledge_retrieval'/.test(r.cypher),
    );
    expect(krRun).toBeDefined();
    expect(krRun!.params['nodeId']).toBe('self-cap-knowledge_retrieval');
    expect(krRun!.params['successRate']).toBeCloseTo(0.75);
    expect(krRun!.params['sampleCount']).toBe(4);
  });

  it('provenance_type is INFERENCE on the knowledge_retrieval node', async () => {
    const { service, neo } = makeKnowledgeService(knowledgeRow);
    await service.runSelfModelCycle();
    const krRun = neo.runs.find(
      (r) => /MERGE.*Capability/.test(r.cypher) && /'knowledge_retrieval'/.test(r.cypher),
    );
    expect(krRun!.cypher).toContain("'INFERENCE'");
  });

  it('writes NO paired node for knowledge_retrieval (only the :Capability node)', async () => {
    const { service, neo } = makeKnowledgeService(knowledgeRow);
    await service.runSelfModelCycle();
    // The only MERGE issued (prediction defaults to zero-sample here) is the
    // knowledge_retrieval Capability — no second paired-node MERGE.
    const merges = neo.runs.filter((r) => /MERGE/.test(r.cypher));
    expect(merges.length).toBe(1);
    expect(merges[0].cypher).toContain('knowledge_retrieval');
  });

  it('the SQL excludes LLM_ASSISTED, non-QUESTION, and null (theater filter)', async () => {
    // Capture the exact SQL the writer issues for the knowledge metric and
    // assert the exclusion predicates are present — this is the Std-1 guarantee.
    const captured: string[] = [];
    const neo = new CapturingNeo4j();
    const timescale = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        captured.push(sql);
        if (sql.includes('RESPONSE_GENERATED')) {
          return { rows: [knowledgeRow as unknown as T] };
        }
        return {
          rows: [{ sample_count: '0', accurate_count: '0', avg_mae: null } as unknown as T],
        };
      },
    };
    const service = new SelfModelWriterService(
      neo as unknown as never,
      timescale as unknown as never,
    );
    await service.runSelfModelCycle();

    const krSql = captured.find((s) => s.includes('RESPONSE_GENERATED'));
    expect(krSql).toBeDefined();
    // Denominator = GROUNDED|UNKNOWN (LLM_ASSISTED NOT in the IN-list → excluded).
    expect(krSql!).toMatch(/IN\s*\('GROUNDED','UNKNOWN'\)/);
    expect(krSql!).not.toContain('LLM_ASSISTED');
    // Option-A QUESTION gate.
    expect(krSql!).toContain("payload->>'intent' = 'QUESTION'");
    // Null exclusion.
    expect(krSql!).toContain("payload->>'knowledgeGrounding' IS NOT NULL");
    // Numerator = GROUNDED only.
    expect(krSql!).toMatch(/= 'GROUNDED'\)\s+AS success_count/);
  });
});

// ---------------------------------------------------------------------------
// (f) knowledge_retrieval — Std-3 clamp, zero-sample, idempotency
// ---------------------------------------------------------------------------

describe('SelfModelWriterService — (f) knowledge_retrieval Std-3 + zero-sample', () => {
  it('clamps confidence to exactly 0.60 when n large', async () => {
    const { service, neo } = makeKnowledgeService({ sample_count: '10000', success_count: '9000' });
    const result = await service.runSelfModelCycle();
    expect(result.knowledgeRetrieval!.confidence).toBe(0.60);
    const krRun = neo.runs.find(
      (r) => /MERGE.*Capability/.test(r.cypher) && /'knowledge_retrieval'/.test(r.cypher),
    );
    expect(krRun!.params['confidence']).toBe(0.60);
  });

  it('confidence matches min(0.60, n/(n+50)) for a small n', async () => {
    const { service } = makeKnowledgeService({ sample_count: '10', success_count: '7' });
    const result = await service.runSelfModelCycle();
    expect(result.knowledgeRetrieval!.confidence).toBeCloseTo(expectedConfidence(10));
  });

  it('zero-sample window writes NO knowledge_retrieval MERGE and DETACH DELETEs its node', async () => {
    const { service, neo } = makeKnowledgeService({ sample_count: '0', success_count: '0' });
    const result = await service.runSelfModelCycle();
    expect(result.knowledgeRetrieval!.wrote).toBe(false);
    expect(result.knowledgeRetrieval!.successRate).toBeNull();
    expect(result.knowledgeRetrieval!.confidence).toBeNull();

    const krMerge = neo.runs.find(
      (r) => /MERGE.*Capability/.test(r.cypher) && /'knowledge_retrieval'/.test(r.cypher),
    );
    expect(krMerge).toBeUndefined();

    const krDelete = neo.runs.find(
      (r) =>
        r.instance === Neo4jInstanceName.SELF &&
        /DETACH DELETE/.test(r.cypher) &&
        r.params['nodeId'] === 'self-cap-knowledge_retrieval',
    );
    expect(krDelete).toBeDefined();
  });

  it('is idempotent — MERGE on node_id, identical params across two runs', async () => {
    const { service, neo } = makeKnowledgeService({ sample_count: '4', success_count: '3' });
    await service.runSelfModelCycle();
    await service.runSelfModelCycle();
    const krMerges = neo.runs.filter(
      (r) => /MERGE.*Capability/.test(r.cypher) && /'knowledge_retrieval'/.test(r.cypher),
    );
    expect(krMerges.length).toBe(2); // one per run
    // MERGE key is node_id → same node, so re-runs upsert rather than duplicate.
    expect(krMerges[0].params['nodeId']).toBe('self-cap-knowledge_retrieval');
    expect(krMerges[1].params['nodeId']).toBe('self-cap-knowledge_retrieval');
    expect(krMerges[0].params['successRate']).toBe(krMerges[1].params['successRate']);
  });
});

// ---------------------------------------------------------------------------
// (g) both capabilities refresh together in one cycle
// ---------------------------------------------------------------------------

describe('SelfModelWriterService — (g) both capabilities in one cycle', () => {
  it('writes BOTH prediction_accuracy and knowledge_retrieval when both windows are healthy', async () => {
    const { service, neo } = makeService(
      { sample_count: '20', accurate_count: '15', avg_mae: '0.12' },
      { sample_count: '4', success_count: '3' },
    );
    const result = await service.runSelfModelCycle();

    // Top-level (back-compat) = prediction_accuracy.
    expect(result.wrote).toBe(true);
    expect(result.sampleCount).toBe(20);
    expect(result.successRate).toBeCloseTo(15 / 20);
    // Nested = knowledge_retrieval.
    expect(result.knowledgeRetrieval!.wrote).toBe(true);
    expect(result.knowledgeRetrieval!.successRate).toBeCloseTo(0.75);

    const predMerge = neo.runs.find(
      (r) => /MERGE.*Capability/.test(r.cypher) && /'prediction_accuracy'/.test(r.cypher),
    );
    const krMerge = neo.runs.find(
      (r) => /MERGE.*Capability/.test(r.cypher) && /'knowledge_retrieval'/.test(r.cypher),
    );
    expect(predMerge).toBeDefined();
    expect(krMerge).toBeDefined();
  });
});
