/**
 * TK-85 — PersonScopedFaceIndex: POC privacy-isolation regression spec.
 *
 * INVARIANTS UNDER TEST (AC-1 of TK-85):
 *
 *   1. A face embedding written for Person A is NEVER returned by a search
 *      keyed for Person B. Cross-person leakage is structurally impossible.
 *
 *   2. A face that recurs N times within a person scope graduates (i.e. its
 *      `graduated` flag becomes true after FACE_GRADUATION_THRESHOLD hits),
 *      and graduated faces are returned by searchFace(); non-graduated ones
 *      are NOT returned (preventing fresh / unproven reflexes).
 *
 *   3. writeMultiModal on LatentSpaceService routes face embeddings with a
 *      groundingPersonId to the person-scoped index (NOT the shared hotLayer),
 *      while faces without a person scope remain dropped and counted.
 *
 * These tests exercise the REAL implementations — no copies. TimescaleService
 * is undefined so LatentSpaceService runs hot-layer-only (in-memory), exactly
 * the path the AC regression asserts.
 */

import { PersonScopedFaceIndex, FACE_GRADUATION_THRESHOLD } from './person-scoped-face-index';
import { LatentSpaceService, type MultiModalWriteOpts } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';

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
// Unit tests: PersonScopedFaceIndex standalone
// ---------------------------------------------------------------------------

describe('PersonScopedFaceIndex — privacy isolation (TK-85 POC)', () => {
  let idx: PersonScopedFaceIndex;

  beforeEach(() => {
    idx = new PersonScopedFaceIndex();
  });

  it('AC-1 REGRESSION: face written for Person A is NOT found when searching for Person B', () => {
    idx.writeFace(PERSON_A, unitEmbedding(0));

    // Pump to graduation so Person A's face would return if the gate were absent.
    for (let i = 1; i < FACE_GRADUATION_THRESHOLD; i++) {
      idx.writeFace(PERSON_A, nearEmbedding(0));
    }
    expect(idx.graduatedCount(PERSON_A)).toBe(1);

    // Person B searches with the same embedding — must NOT find Person A's face.
    const result = idx.searchFace(PERSON_B, unitEmbedding(0));
    expect(result).toBeNull();
  });

  it('AC-1: a face seen with Person A can NEVER ground/reflex for Person B (scope boundary)', () => {
    // Write two different face axes — A owns axis 0, B owns axis 10.
    // Pump both to graduation.
    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      idx.writeFace(PERSON_A, nearEmbedding(0));
      idx.writeFace(PERSON_B, nearEmbedding(10));
    }

    // A can only find its own face.
    expect(idx.searchFace(PERSON_A, unitEmbedding(0))).not.toBeNull();
    expect(idx.searchFace(PERSON_A, unitEmbedding(10))).toBeNull();

    // B can only find its own face.
    expect(idx.searchFace(PERSON_B, unitEmbedding(10))).not.toBeNull();
    expect(idx.searchFace(PERSON_B, unitEmbedding(0))).toBeNull();
  });

  it('face graduates after FACE_GRADUATION_THRESHOLD recurrences within a person scope', () => {
    // First write creates the entry (recurrenceCount = 1).
    const id1 = idx.writeFace(PERSON_A, unitEmbedding(5));
    expect(id1).toBeTruthy();
    expect(idx.graduatedCount(PERSON_A)).toBe(0); // not graduated yet

    // Near-identical embeddings increment the same entry's recurrenceCount.
    for (let i = 1; i < FACE_GRADUATION_THRESHOLD; i++) {
      const id = idx.writeFace(PERSON_A, nearEmbedding(5));
      // Dedup: same entry id returned after the first write.
      expect(id).toBe(id1);
    }

    expect(idx.graduatedCount(PERSON_A)).toBe(1);
    // Now searchFace should return the graduated entry.
    const match = idx.searchFace(PERSON_A, unitEmbedding(5));
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe(id1);
    expect(match!.personId).toBe(PERSON_A);
  });

  it('non-graduated face is NOT returned by searchFace (prevents fresh/unproven reflexes)', () => {
    // Write below the graduation threshold.
    idx.writeFace(PERSON_A, unitEmbedding(7));
    expect(idx.graduatedCount(PERSON_A)).toBe(0);

    const result = idx.searchFace(PERSON_A, unitEmbedding(7));
    expect(result).toBeNull();
  });

  it('zero-vector embedding is rejected at write time', () => {
    const zeroVec = new Array<number>(EMBEDDING_DIM).fill(0);
    const id = idx.writeFace(PERSON_A, zeroVec);
    expect(id).toBe('');
    expect(idx.storeSize(PERSON_A)).toBe(0);
  });

  it('zero-vector embedding is rejected at search time', () => {
    // Pump a graduated face.
    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      idx.writeFace(PERSON_A, nearEmbedding(3));
    }
    const zeroVec = new Array<number>(EMBEDDING_DIM).fill(0);
    const result = idx.searchFace(PERSON_A, zeroVec);
    expect(result).toBeNull();
  });

  it('orthogonal faces (different people) in the same axis do not interfere', () => {
    // A and B each write a face at the SAME embedding axis (axis 0).
    // This is the worst case: the embeddings are identical, but they are in
    // separate person stores and must NEVER cross-contaminate.
    for (let i = 0; i < FACE_GRADUATION_THRESHOLD; i++) {
      idx.writeFace(PERSON_A, unitEmbedding(0));
      idx.writeFace(PERSON_B, unitEmbedding(0));
    }
    expect(idx.graduatedCount(PERSON_A)).toBe(1);
    expect(idx.graduatedCount(PERSON_B)).toBe(1);

    // Each person finds their own entry — NOT the other's.
    const aMatch = idx.searchFace(PERSON_A, unitEmbedding(0));
    const bMatch = idx.searchFace(PERSON_B, unitEmbedding(0));
    expect(aMatch).not.toBeNull();
    expect(bMatch).not.toBeNull();
    expect(aMatch!.entry.id).not.toBe(bMatch!.entry.id); // distinct entries
    expect(aMatch!.personId).toBe(PERSON_A);
    expect(bMatch!.personId).toBe(PERSON_B);
  });

  it('knownPersonIds lists persons with face stores, NOT their entries', () => {
    idx.writeFace(PERSON_A, unitEmbedding(1));
    idx.writeFace(PERSON_B, unitEmbedding(2));
    const ids = idx.knownPersonIds();
    expect(ids).toContain(PERSON_A);
    expect(ids).toContain(PERSON_B);
    expect(ids).toHaveLength(2);
  });

  it('clear() removes all person stores', () => {
    idx.writeFace(PERSON_A, unitEmbedding(1));
    idx.writeFace(PERSON_B, unitEmbedding(2));
    idx.clear();
    expect(idx.knownPersonIds()).toHaveLength(0);
    expect(idx.storeSize(PERSON_A)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: LatentSpaceService.writeMultiModal routing
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
