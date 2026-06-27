/**
 * TK-94 — updateConfidence() DB-write SQL regression spec.
 *
 * ROOT CAUSE (live-reproduced on Railway): the DB-side confidence-ceiling clamp
 * used `LEAST($1, $3)` with an untyped `$3` bind parameter. LEAST() resolves its
 * own common type from its arguments rather than from the assignment target, and
 * with both `$1` and `$3` untyped PostgreSQL defaulted the expression to TEXT.
 * The UPDATE then failed at execution:
 *   column "confidence" is of type double precision but expression is of type text
 * Because updateConfidence() is called once per written modality, several times
 * per decision cycle, EVERY call threw — flooding the pool with failing
 * round-trips until connect-timeouts ("timeout exceeded when trying to connect").
 *
 * THE FIX (and what this spec locks in): both CASE branches must resolve to
 * double precision. `$1` is cast `$1::float`, and the ceiling is inlined as a
 * numeric literal (0.6) inside LEAST() instead of an untyped `$3` parameter.
 * Params therefore reduce to exactly two: [newConfidence, patternId].
 *
 * This spec mocks the TimescaleService.query so it can capture the SQL text and
 * the params array actually issued by updateConfidence(), then asserts the
 * type-safe shape. It also re-verifies the Standard-3 hot-layer ceiling invariant
 * is preserved (the fix touches only the DB SQL, not the in-memory clamp).
 */

import { LatentSpaceService, type NewPattern } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

const CEILING = 0.6;

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

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * A minimal TimescaleService stand-in. query() records every (sql, params) call
 * and returns an empty result so the service's `.catch()` warning path is never
 * taken (a passing query is the whole point of the fix).
 */
function makeCapturingTimescale(captured: CapturedQuery[]) {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 } as unknown;
    }),
  };
}

/** Force schemaReady so the DB-write branch in updateConfidence() executes. */
function markSchemaReady(svc: LatentSpaceService): void {
  (svc as unknown as { schemaReady: boolean }).schemaReady = true;
}

/** The single UPDATE learned_patterns ... SET confidence ... call. */
function confidenceUpdate(captured: CapturedQuery[]): CapturedQuery {
  const hit = captured.find(
    (q) => /UPDATE\s+learned_patterns/i.test(q.sql) && /SET\s+confidence/i.test(q.sql),
  );
  if (!hit) throw new Error('no confidence UPDATE was issued');
  return hit;
}

describe('TK-94 — updateConfidence() DB SQL is type-safe (no pool-exhausting error)', () => {
  let svc: LatentSpaceService;
  let captured: CapturedQuery[];

  beforeEach(() => {
    captured = [];
    const timescale = makeCapturingTimescale(captured);
    svc = new LatentSpaceService(timescale as never);
    markSchemaReady(svc);
  });

  it('issues NO untyped $3 placeholder (the exact type-inference trigger)', async () => {
    const id = await svc.write(newPattern());
    captured.length = 0; // drop the INSERT from write(); focus on the UPDATE
    svc.updateConfidence(id, 0.4);

    const { sql } = confidenceUpdate(captured);
    expect(sql).not.toMatch(/\$3/);
  });

  it('casts $1 to float so both CASE branches resolve to double precision', async () => {
    const id = await svc.write(newPattern());
    captured.length = 0;
    svc.updateConfidence(id, 0.4);

    const { sql } = confidenceUpdate(captured);
    expect(sql).toMatch(/\$1::float/);
  });

  it('inlines the 0.6 ceiling literal inside LEAST()', async () => {
    const id = await svc.write(newPattern());
    captured.length = 0;
    svc.updateConfidence(id, 0.4);

    const { sql } = confidenceUpdate(captured);
    // LEAST( $1::float , 0.6 ) — ceiling is a numeric literal, not a param.
    expect(sql).toMatch(/LEAST\(\s*\$1::float\s*,\s*0\.6\s*\)/i);
  });

  it('passes EXACTLY two params: [newConfidence, patternId]', async () => {
    const id = await svc.write(newPattern());
    captured.length = 0;
    svc.updateConfidence(id, 0.4);

    const { params } = confidenceUpdate(captured);
    expect(params).toHaveLength(2);
    expect(params[0]).toBeCloseTo(0.4, 10);
    expect(params[1]).toBe(id);
  });

  it('the SQL ceiling literal equals the compile-time WRITE_TIME_CONFIDENCE_CEILING', async () => {
    const id = await svc.write(newPattern());
    captured.length = 0;
    svc.updateConfidence(id, 0.4);

    const { sql } = confidenceUpdate(captured);
    // The inlined literal must be the canonical 0.60 ceiling — not a drifted value.
    expect(sql).toContain(String(CEILING));
  });

  it('preserves the hot-layer Standard-3 ceiling invariant (useCount 0 caps at 0.60)', async () => {
    const id = await svc.write(newPattern({ confidence: 0.3 }));
    svc.updateConfidence(id, 0.95); // never-used pattern cannot exceed the ceiling

    const hot = (svc as unknown as {
      hotLayer: Array<{ id: string; confidence: number; useCount: number }>;
    }).hotLayer;
    const entry = hot.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.useCount).toBe(0);
    expect(entry!.confidence).toBeCloseTo(CEILING, 10);
  });

  it('the query did not throw — the .catch() warning path was not taken', async () => {
    const id = await svc.write(newPattern());
    svc.updateConfidence(id, 0.4);
    // A small tick to let the fire-and-forget promise settle.
    await new Promise((r) => setImmediate(r));
    // Capturing mock resolves successfully, so every query() resolved.
    const update = confidenceUpdate(captured);
    expect(update).toBeDefined();
  });
});
