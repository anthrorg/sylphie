/**
 * PersonScopedFaceIndex: TK-85 (isolation) + TK-91 (DB persistence) spec.
 *
 * INVARIANTS UNDER TEST:
 *
 *   TK-85 (preserved, AC-1):
 *     1. A face written for Person A is NEVER returned by a search keyed for
 *        Person B. Cross-person leakage is structurally impossible at both the
 *        in-memory Map layer and the DB layer.
 *     2. A face that recurs N times within a person scope graduates after
 *        FACE_GRADUATION_THRESHOLD hits; graduated faces are returned by
 *        searchFace(); non-graduated ones are NOT.
 *     3. writeMultiModal on LatentSpaceService routes face embeddings with a
 *        groundingPersonId to the person-scoped index (NOT the shared hotLayer),
 *        while faces without a person scope remain dropped and counted.
 *
 *   TK-91 (new, AC-1 + AC-2):
 *     4. After a restart simulation (clear() + reload from a mock DB), a
 *        graduated face entry is found by searchFace(PersonA) and NOT by
 *        searchFace(PersonB) — isolation preserved at the DB layer.
 *     5. Zero-vector and wrong-dim embeddings are rejected and never persisted
 *        (existing guard retained). A blank/no-personId face is dropped-with-
 *        warning and never persisted or added to the shared index.
 *
 * All tests exercise the REAL implementations — no copies. The mock
 * TimescaleService in the DB tests replaces only the network I/O, so the
 * application-layer logic (load, insert, update paths) is fully exercised.
 */

import { PersonScopedFaceIndex, FACE_GRADUATION_THRESHOLD } from './person-scoped-face-index';
import { LatentSpaceService, type MultiModalWriteOpts } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';
import type { TimescaleService } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unit-norm embedding along `axis` — two different axes are orthogonal. */
function unitEmbedding(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis % EMBEDDING_DIM] = 1;
  return v;
}

/**
 * Near-identical embedding to `axis` (cosine ≈ 0.9999). Used to verify
 * that the similarity gate accepts clearly-the-same-face.
 */
function nearEmbedding(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis % EMBEDDING_DIM] = 1;
  v[(axis + 1) % EMBEDDING_DIM] = 0.01; // tiny jitter, still nearly identical
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const PERSON_A = 'person-a-uuid';
const PERSON_B = 'person-b-uuid';

// ---------------------------------------------------------------------------
// Unit tests: PersonScopedFaceIndex standalone (in-memory, no DB)
// ---------------------------------------------------------------------------

describe('PersonScopedFaceIndex — privacy isolation (TK-85 POC, preserved)', () => {
  let idx: PersonScopedFaceIndex;

  beforeEach(() => {
    idx = new PersonScopedFaceIndex();
  });

  it('AC-1 REGRESSION: face written for Person A is NOT found when searching for Person B', async () => {
    await idx.writeFace(PERSON_A, unitEmbedding(0));

    // Pump to graduation so Person A's face would return if the gate were absent.
    for (let i = 1; i < FACE_GRADUATION_THRESHOLD; i++) {
      await idx.writeFace(PERSON_A, nearEmbedding(0));
    }
    expect(idx.graduatedCount(PERSON_A)).toBe(1);

    // Person B searches with the same embedding — must NOT find Person A's face.
    const result = await idx.searchFace(PERSON_B, unitEmbedding(0));
    expect(result).toBeNull();
  });

  it('AC-1: a face seen with Person A can NEVER ground/reflex for Person B (scope boundary)', async () => {
    // Write two different face axes — A owns axis 0, B owns axis 10.
    // Pump both to graduation.
    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      await idx.writeFace(PERSON_A, nearEmbedding(0));
      await idx.writeFace(PERSON_B, nearEmbedding(10));
    }

    // A can only find its own face.
    expect(await idx.searchFace(PERSON_A, unitEmbedding(0))).not.toBeNull();
    expect(await idx.searchFace(PERSON_A, unitEmbedding(10))).toBeNull();

    // B can only find its own face.
    expect(await idx.searchFace(PERSON_B, unitEmbedding(10))).not.toBeNull();
    expect(await idx.searchFace(PERSON_B, unitEmbedding(0))).toBeNull();
  });

  it('face graduates after FACE_GRADUATION_THRESHOLD recurrences within a person scope', async () => {
    // First write creates the entry (recurrenceCount = 1).
    const id1 = await idx.writeFace(PERSON_A, unitEmbedding(5));
    expect(id1).toBeTruthy();
    expect(idx.graduatedCount(PERSON_A)).toBe(0); // not graduated yet

    // Near-identical embeddings increment the same entry's recurrenceCount.
    for (let i = 1; i < FACE_GRADUATION_THRESHOLD; i++) {
      const id = await idx.writeFace(PERSON_A, nearEmbedding(5));
      // Dedup: same entry id returned after the first write.
      expect(id).toBe(id1);
    }

    expect(idx.graduatedCount(PERSON_A)).toBe(1);
    // Now searchFace should return the graduated entry.
    const match = await idx.searchFace(PERSON_A, unitEmbedding(5));
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe(id1);
    expect(match!.personId).toBe(PERSON_A);
  });

  it('non-graduated face is NOT returned by searchFace (prevents fresh/unproven reflexes)', async () => {
    // Write below the graduation threshold.
    await idx.writeFace(PERSON_A, unitEmbedding(7));
    expect(idx.graduatedCount(PERSON_A)).toBe(0);

    const result = await idx.searchFace(PERSON_A, unitEmbedding(7));
    expect(result).toBeNull();
  });

  it('AC-2: zero-vector embedding is rejected at write time and never persisted', async () => {
    const zeroVec = new Array<number>(EMBEDDING_DIM).fill(0);
    const id = await idx.writeFace(PERSON_A, zeroVec);
    expect(id).toBe('');
    expect(idx.storeSize(PERSON_A)).toBe(0);
  });

  it('zero-vector embedding is rejected at search time', async () => {
    // Pump a graduated face.
    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      await idx.writeFace(PERSON_A, nearEmbedding(3));
    }
    const zeroVec = new Array<number>(EMBEDDING_DIM).fill(0);
    const result = await idx.searchFace(PERSON_A, zeroVec);
    expect(result).toBeNull();
  });

  it('AC-2: wrong-dim embedding is rejected at write time and never persisted', async () => {
    const wrongDim = new Array<number>(EMBEDDING_DIM - 1).fill(0.5);
    const id = await idx.writeFace(PERSON_A, wrongDim);
    expect(id).toBe('');
    expect(idx.storeSize(PERSON_A)).toBe(0);
  });

  it('orthogonal faces (different people) in the same axis do not interfere', async () => {
    // A and B each write a face at the SAME embedding axis (axis 0).
    // This is the worst case: the embeddings are identical, but they are in
    // separate person stores and must NEVER cross-contaminate.
    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      await idx.writeFace(PERSON_A, unitEmbedding(0));
      await idx.writeFace(PERSON_B, unitEmbedding(0));
    }
    expect(idx.graduatedCount(PERSON_A)).toBe(1);
    expect(idx.graduatedCount(PERSON_B)).toBe(1);

    // Each person finds their own entry — NOT the other's.
    const aMatch = await idx.searchFace(PERSON_A, unitEmbedding(0));
    const bMatch = await idx.searchFace(PERSON_B, unitEmbedding(0));
    expect(aMatch).not.toBeNull();
    expect(bMatch).not.toBeNull();
    expect(aMatch!.entry.id).not.toBe(bMatch!.entry.id); // distinct entries
    expect(aMatch!.personId).toBe(PERSON_A);
    expect(bMatch!.personId).toBe(PERSON_B);
  });

  it('knownPersonIds lists persons with face stores, NOT their entries', async () => {
    await idx.writeFace(PERSON_A, unitEmbedding(1));
    await idx.writeFace(PERSON_B, unitEmbedding(2));
    const ids = idx.knownPersonIds();
    expect(ids).toContain(PERSON_A);
    expect(ids).toContain(PERSON_B);
    expect(ids).toHaveLength(2);
  });

  it('clear() removes all person stores', async () => {
    await idx.writeFace(PERSON_A, unitEmbedding(1));
    await idx.writeFace(PERSON_B, unitEmbedding(2));
    idx.clear();
    expect(idx.knownPersonIds()).toHaveLength(0);
    expect(idx.storeSize(PERSON_A)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TK-91: DB persistence — restart simulation via mock TimescaleService
// ---------------------------------------------------------------------------

/**
 * A minimal mock of TimescaleService that records INSERT/UPDATE calls and
 * replays stored rows on SELECT. Simulates the real DB contract:
 *   - SELECT returns rows previously stored via INSERT.
 *   - INSERT is recorded and replayed.
 *   - UPDATE mutates the stored row (recurrence_count / graduated / last_matched_at).
 *   - ensureSchema queries (CREATE TABLE, CREATE INDEX) are no-ops.
 */
function makeMockTimescale() {
  // In-memory store keyed by face id.
  const rows: Map<
    string,
    {
      id: string;
      person_id: string;
      embedding: string;
      recurrence_count: number;
      graduated: boolean;
      created_at: string;
      last_matched_at: string | null;
    }
  > = new Map();

  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const timescale = {
    rows,
    calls,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });

      // SELECT — return rows for the given person_id.
      if (/^\s*SELECT/i.test(sql)) {
        const personId = params?.[0] as string | undefined;
        const matchingRows = personId
          ? [...rows.values()].filter((r) => r.person_id === personId)
          : [...rows.values()];
        return { rows: matchingRows, rowCount: matchingRows.length };
      }

      // INSERT — record new row.
      if (/^\s*INSERT/i.test(sql) && params) {
        const [id, person_id, embedding, recurrence_count, graduated, created_at, last_matched_at] =
          params as [string, string, string, number, boolean, Date, Date | null];
        if (!rows.has(id as string)) {
          // The application passes embedding as a pgvector literal `[1,2,3]`.
          // The real DB stores it and returns it via `embedding::text`. The mock
          // stores the literal as-is so parseVectorLiteral can round-trip it.
          rows.set(id as string, {
            id: id as string,
            person_id: person_id as string,
            embedding: embedding as string, // keep the [1,...] literal intact
            recurrence_count: Number(recurrence_count),
            graduated: Boolean(graduated),
            created_at: (created_at as Date).toISOString(),
            last_matched_at: last_matched_at ? (last_matched_at as Date).toISOString() : null,
          });
        }
        return { rows: [], rowCount: 1 };
      }

      // UPDATE — mutate the stored row.
      if (/^\s*UPDATE/i.test(sql) && params) {
        const [id, recurrence_count, graduated, last_matched_at] = params as [
          string,
          number,
          boolean,
          Date | null,
        ];
        const existing = rows.get(id as string);
        if (existing) {
          existing.recurrence_count = Number(recurrence_count);
          existing.graduated = Boolean(graduated);
          existing.last_matched_at = last_matched_at ? (last_matched_at as Date).toISOString() : null;
        }
        return { rows: [], rowCount: 1 };
      }

      // CREATE TABLE / CREATE INDEX / etc. — no-op.
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as TimescaleService & { rows: typeof rows; calls: typeof calls };

  return timescale;
}

describe('PersonScopedFaceIndex — DB persistence (TK-91)', () => {
  it('AC-1: after restart simulation, graduated face for Person A is found; Person B returns null', async () => {
    const timescale = makeMockTimescale();

    // --- Session 1: write and graduate a face for Person A ---
    const idx1 = new PersonScopedFaceIndex(timescale);
    await idx1.ensureSchema();

    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      await idx1.writeFace(PERSON_A, nearEmbedding(0));
    }
    expect(idx1.graduatedCount(PERSON_A)).toBe(1);

    // Confirm that DB INSERT and UPDATE calls happened.
    const inserts = timescale.calls.filter((c) => /INSERT/i.test(c.sql));
    const updates = timescale.calls.filter((c) => /UPDATE/i.test(c.sql));
    expect(inserts.length).toBeGreaterThanOrEqual(1); // at least the initial INSERT
    expect(updates.length).toBeGreaterThanOrEqual(1); // recurrence bumps

    // --- Session 2: new index instance (restart simulation) ---
    const idx2 = new PersonScopedFaceIndex(timescale);
    await idx2.ensureSchema();

    // AC-1 isolation: Person B returns null even with the same query embedding.
    const bResult = await idx2.searchFace(PERSON_B, unitEmbedding(0));
    expect(bResult).toBeNull();

    // AC-1 restoration: Person A's graduated entry is recovered from DB.
    const aResult = await idx2.searchFace(PERSON_A, unitEmbedding(0));
    expect(aResult).not.toBeNull();
    expect(aResult!.entry.graduated).toBe(true);
    expect(aResult!.entry.recurrenceCount).toBe(FACE_GRADUATION_THRESHOLD);
    expect(aResult!.personId).toBe(PERSON_A);
  });

  it('AC-1: DB SELECT is always person_id-scoped (isolation at the DB layer)', async () => {
    const timescale = makeMockTimescale();
    const idx = new PersonScopedFaceIndex(timescale);
    await idx.ensureSchema();

    // Write a face for Person A (generates DB INSERT).
    await idx.writeFace(PERSON_A, unitEmbedding(2));

    // Trigger a DB load for Person B (forces a SELECT).
    const idx2 = new PersonScopedFaceIndex(timescale);
    await idx2.ensureSchema();
    await idx2.searchFace(PERSON_B, unitEmbedding(2));

    // Every SELECT must carry a WHERE person_id = $1 param.
    const selects = timescale.calls.filter((c) => /SELECT/i.test(c.sql));
    for (const sel of selects) {
      // The first param is the personId — must never be undefined/null.
      expect(sel.params[0]).toBeTruthy();
      // The SELECT SQL must contain the person_id scoping clause.
      expect(sel.sql).toMatch(/WHERE\s+person_id\s*=\s*\$1/i);
    }
  });

  it('AC-1: recurrenceCount and graduated state are persisted and restored correctly', async () => {
    const timescale = makeMockTimescale();
    const idx1 = new PersonScopedFaceIndex(timescale);
    await idx1.ensureSchema();

    // Write once (recurrenceCount = 1, not graduated).
    const faceId = await idx1.writeFace(PERSON_A, unitEmbedding(1));
    expect(faceId).toBeTruthy();
    expect(idx1.graduatedCount(PERSON_A)).toBe(0);

    // Pump to exactly graduation threshold.
    for (let i = 1; i < FACE_GRADUATION_THRESHOLD; i++) {
      await idx1.writeFace(PERSON_A, nearEmbedding(1));
    }
    expect(idx1.graduatedCount(PERSON_A)).toBe(1);

    // Restart: new instance, same mock DB.
    const idx2 = new PersonScopedFaceIndex(timescale);
    await idx2.ensureSchema();

    // Load is lazy — trigger it via searchFace.
    const match = await idx2.searchFace(PERSON_A, unitEmbedding(1));
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe(faceId);
    expect(match!.entry.graduated).toBe(true);
    expect(match!.entry.recurrenceCount).toBe(FACE_GRADUATION_THRESHOLD);
  });

  it('AC-2: zero-vector is rejected and DB INSERT is never called for it', async () => {
    const timescale = makeMockTimescale();
    const idx = new PersonScopedFaceIndex(timescale);
    await idx.ensureSchema();

    const zeroVec = new Array<number>(EMBEDDING_DIM).fill(0);
    const id = await idx.writeFace(PERSON_A, zeroVec);

    expect(id).toBe('');
    expect(idx.storeSize(PERSON_A)).toBe(0);

    // No INSERT should have been issued.
    const inserts = timescale.calls.filter((c) => /INSERT/i.test(c.sql));
    expect(inserts).toHaveLength(0);
  });

  it('AC-2: wrong-dim embedding is rejected and DB INSERT is never called for it', async () => {
    const timescale = makeMockTimescale();
    const idx = new PersonScopedFaceIndex(timescale);
    await idx.ensureSchema();

    const wrongDim = new Array<number>(EMBEDDING_DIM + 5).fill(0.1);
    const id = await idx.writeFace(PERSON_A, wrongDim);

    expect(id).toBe('');
    expect(idx.storeSize(PERSON_A)).toBe(0);

    const inserts = timescale.calls.filter((c) => /INSERT/i.test(c.sql));
    expect(inserts).toHaveLength(0);
  });

  it('DB load is skipped for a person already loaded (no redundant SELECT)', async () => {
    const timescale = makeMockTimescale();
    const idx = new PersonScopedFaceIndex(timescale);
    await idx.ensureSchema();

    // First call: triggers a SELECT load.
    await idx.writeFace(PERSON_A, unitEmbedding(3));
    const selectsAfterFirst = timescale.calls.filter((c) => /SELECT/i.test(c.sql)).length;

    // Second call: same person — should NOT trigger another SELECT.
    await idx.writeFace(PERSON_A, unitEmbedding(4));
    const selectsAfterSecond = timescale.calls.filter((c) => /SELECT/i.test(c.sql)).length;

    expect(selectsAfterSecond).toBe(selectsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Integration: LatentSpaceService.writeMultiModal routing (TK-85 preserved)
// ---------------------------------------------------------------------------

describe('LatentSpaceService.writeMultiModal — face routing (TK-85 POC)', () => {
  const OPTS_WITH_PERSON: MultiModalWriteOpts = {
    confidence: 0.9,
    entityIds: [],
    groundingPersonId: PERSON_A,
  } as MultiModalWriteOpts;

  const OPTS_NO_PERSON: MultiModalWriteOpts = {
    confidence: 0.9,
    entityIds: [],
  } as MultiModalWriteOpts;

  let svc: LatentSpaceService;

  beforeEach(() => {
    svc = new LatentSpaceService(undefined as never);
  });

  it('AC-1: face with groundingPersonId goes to personScopedFaceIndex, NOT the shared hotLayer', async () => {
    const ids = await svc.writeMultiModal(
      { text: unitEmbedding(0), faces: unitEmbedding(1) },
      'response text',
      OPTS_WITH_PERSON,
    );

    // The text pattern went to hotLayer; the face went to personScopedFaceIndex.
    expect(svc.hotLayerSize).toBe(1); // only the text pattern
    expect(svc.personScopedFaceIndex.storeSize(PERSON_A)).toBe(1);
    // Both produced an id.
    expect(ids).toHaveLength(2);
  });

  it('face WITHOUT a groundingPersonId is still dropped and counted (Wave 3 C6 preserved)', async () => {
    const ids = await svc.writeMultiModal(
      { text: unitEmbedding(0), faces: unitEmbedding(1) },
      'response text',
      OPTS_NO_PERSON,
    );

    // Text wrote to hotLayer; face was dropped.
    expect(svc.hotLayerSize).toBe(1);
    expect(svc.personScopedFaceIndex.knownPersonIds()).toHaveLength(0);
    expect(svc.getDroppedModalityWriteCounts()).toEqual({ faces: 1 });
    // Only the text id is returned.
    expect(ids).toHaveLength(1);
  });

  it('drives modality remains dropped regardless of groundingPersonId (Wave 3 C6)', async () => {
    await svc.writeMultiModal(
      { drives: unitEmbedding(2) },
      'response',
      OPTS_WITH_PERSON,
    );
    expect(svc.getDroppedModalityWriteCounts()).toEqual({ drives: 1 });
  });

  it('face with groundingPersonId is NOT counted as a dropped modality write', async () => {
    await svc.writeMultiModal(
      { faces: unitEmbedding(1) },
      'response',
      OPTS_WITH_PERSON,
    );
    // face was routed to the person-scoped index, NOT dropped.
    expect(svc.getDroppedModalityWriteCounts()).not.toHaveProperty('faces');
  });
});
