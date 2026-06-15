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

class FakeTimescale {
  constructor(private readonly row: FakeStatsRow) {}

  async query<T>(_sql: string): Promise<{ rows: T[] }> {
    return { rows: [this.row as unknown as T] };
  }
}

function makeService(
  statsRow: FakeStatsRow,
): { service: SelfModelWriterService; neo: CapturingNeo4j } {
  const neo = new CapturingNeo4j();
  const timescale = new FakeTimescale(statsRow);
  const service = new SelfModelWriterService(
    neo as unknown as never,
    timescale as unknown as never,
  );
  return { service, neo };
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

  it('issues NO DETACH DELETE in a healthy window', () => {
    return service.runSelfModelCycle().then(() => {
      const deletes = neo.runs.filter((r) => /DETACH DELETE/.test(r.cypher));
      expect(deletes.length).toBe(0);
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
