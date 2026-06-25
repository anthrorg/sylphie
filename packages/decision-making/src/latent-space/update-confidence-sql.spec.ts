/**
 * TK-94 regression spec — updateConfidence() SQL type correctness.
 *
 * Root cause (TK-94): the previous query passed WRITE_TIME_CONFIDENCE_CEILING as
 * a positional parameter ($3). PostgreSQL inferred it as TEXT in the LEAST($1,$3)
 * CASE branch, producing:
 *   "column confidence is of type double precision but expression is of type text"
 * This error caused every updateConfidence DB write to fail, holding the connection
 * until the error was returned, which compounded into pool exhaustion and the
 * "timeout exceeded when trying to connect" flood seen in production logs.
 *
 * Fix: the ceiling is inlined as a numeric literal in the SQL template string
 * (0.6) and $1 is explicitly cast to ::float. This spec verifies:
 *   1. The SQL issued to the DB does NOT have a $3 placeholder for the ceiling.
 *   2. The SQL contains $1::float so PostgreSQL resolves the CASE branches as float.
 *   3. The ceiling literal (0.6) appears in the SQL as a plain number, not a parameter.
 *   4. Only 2 parameters are passed (newConfidence + patternId), not 3.
 *   5. The hot-layer ceiling invariant is preserved (sanity: not a regression).
 */

import { LatentSpaceService, type NewPattern } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

function unitEmbedding(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis % EMBEDDING_DIM] = 1;
  return v;
}

function newPattern(overrides: Partial<NewPattern> = {}): NewPattern {
  return {
    modality: 'text',
    stimulusEmbedding: unitEmbedding(0),
    responseText: 'cached reflex response',
    confidence: 0.5,
    entityIds: [],
    ...overrides,
  };
}

/** Minimal mock for TimescaleService — captures query calls for inspection. */
function createMockTimescale() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

describe('TK-94 — updateConfidence() SQL type fix', () => {
  let mockTimescale: ReturnType<typeof createMockTimescale>;
  let svc: LatentSpaceService;

  beforeEach(async () => {
    mockTimescale = createMockTimescale();
    svc = new LatentSpaceService(mockTimescale as any);
    // Manually mark schemaReady so updateConfidence issues the DB write.
    (svc as any).schemaReady = true;
  });

  it('passes exactly 2 parameters to the DB query (no $3 for the ceiling)', async () => {
    const id = await svc.write(newPattern());
    mockTimescale.query.mockClear(); // clear the INSERT from write()

    svc.updateConfidence(id, 0.7);

    // Let the fire-and-forget promise settle.
    await new Promise((r) => setImmediate(r));

    expect(mockTimescale.query).toHaveBeenCalledTimes(1);
    const [, params] = mockTimescale.query.mock.calls[0] as [string, unknown[]];
    // Only [newConfidence, patternId] — the ceiling must NOT be a parameter.
    expect(params).toHaveLength(2);
  });

  it('SQL contains $1::float cast (both CASE branches resolve to float)', async () => {
    const id = await svc.write(newPattern());
    mockTimescale.query.mockClear();

    svc.updateConfidence(id, 0.7);
    await new Promise((r) => setImmediate(r));

    const [sql] = mockTimescale.query.mock.calls[0] as [string, unknown[]];
    // Both branches must cast $1 to float — no ambiguous untyped parameter.
    expect(sql).toContain('$1::float');
    // The SQL must NOT reference $3 at all.
    expect(sql).not.toContain('$3');
  });

  it('SQL inlines the 0.6 ceiling as a numeric literal in LEAST()', async () => {
    const id = await svc.write(newPattern());
    mockTimescale.query.mockClear();

    svc.updateConfidence(id, 0.7);
    await new Promise((r) => setImmediate(r));

    const [sql] = mockTimescale.query.mock.calls[0] as [string, unknown[]];
    // The ceiling must appear as the literal 0.6 inside LEAST, not as $3.
    expect(sql).toMatch(/LEAST\(\$1::float,\s*0\.6\)/);
  });

  it('first parameter is the newConfidence value, second is the patternId', async () => {
    const id = await svc.write(newPattern());
    mockTimescale.query.mockClear();

    const newConf = 0.42;
    svc.updateConfidence(id, newConf);
    await new Promise((r) => setImmediate(r));

    const [, params] = mockTimescale.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(newConf);
    expect(params[1]).toBe(id);
  });

  it('hot-layer ceiling is still enforced at useCount 0 (regression guard)', async () => {
    const id = await svc.write(newPattern({ confidence: 0.3 }));
    svc.updateConfidence(id, 0.95);

    const hot = (svc as any).hotLayer as Array<{ id: string; confidence: number }>;
    const entry = hot.find((e) => e.id === id);
    expect(entry?.confidence).toBeCloseTo(0.6, 10);
  });
});
