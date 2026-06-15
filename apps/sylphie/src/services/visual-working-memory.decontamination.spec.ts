/**
 * P3.2 — OPEN-12 four-pronged decontamination (VWM side).
 *
 * Person identity must be end-to-end FACE-CROP ArcFace (`track.faceEmbedding`,
 * 512-D). The body-track object vector (`track.embedding`, 768-D DINOv2) must
 * NEVER reach the face identity path. This spec proves all FOUR prongs at the
 * VWM call sites by giving a `person` track a DISTINCT body-track `embedding`
 * and a DISTINCT `faceEmbedding`, then asserting:
 *
 *   PRONG 4 (query, createEntity / updateScene sticky / resolveEntityIdentity
 *            matchFace): identifyFace/matchFace receive the FACE embedding,
 *            never the body track.
 *   PRONG 3 (fold on match path): updateCentroid(match) folds the FACE embedding.
 *   PRONGS 1+2 (createUnknownPersonNode INSERT + fold): the face_embeddings
 *            INSERT and the centroid fold both carry the FACE embedding, never
 *            the body track; and with NO faceEmbedding, NOTHING is written.
 *
 * The two embeddings are deliberately different lengths/values so a leak is
 * unambiguous: body = a 3-vector, face = a distinct 4-vector. (Real dims are
 * 768 vs 512; the test only needs them DISTINCT to detect a leak.)
 */

import { VisualWorkingMemoryService } from './visual-working-memory.service';
import { BindingService } from './binding.service';
import type { TrackedObjectDTO } from '@sylphie/shared';

const flush = () => new Promise((r) => setImmediate(r));

const BODY_VEC = [9, 9, 9]; // body-track object vector — MUST NOT reach identity
const FACE_VEC = [1, 2, 3, 4]; // ArcFace face vector — the ONLY identity signal

class FakeTimescale {
  public queries: Array<{ sql: string; params?: unknown[] }> = [];
  public selectRow: Record<string, unknown> | null = null;

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    if (/embedding <=> \$1::vector/.test(sql)) {
      return { rows: (this.selectRow ? [this.selectRow] : []) as T[] };
    }
    return { rows: [] };
  }

  find(re: RegExp) {
    return this.queries.filter((q) => re.test(q.sql));
  }
}

function makeFaceSnapshot() {
  return {
    identifyFace: jest.fn().mockReturnValue(null),
    matchFace: jest.fn().mockReturnValue(null),
    updateCentroid: jest.fn(),
  };
}

function makeVwm(timescale: FakeTimescale, faceSnapshot: any) {
  return new VisualWorkingMemoryService(
    timescale as any,
    null, // no Neo4j — the TimescaleDB face_embeddings path is what we assert
    faceSnapshot as any,
    {} as any,
    new BindingService(),
  );
}

function makePersonTrack(
  over: Partial<TrackedObjectDTO> = {},
): TrackedObjectDTO {
  return {
    trackId: 7,
    label: 'person',
    state: 'confirmed',
    bbox: [100, 100, 200, 200],
    confidence: 0.9,
    embedding: [...BODY_VEC], // body-track object vector
    faceEmbedding: [...FACE_VEC], // ArcFace face vector
    framesSeen: 5,
    framesLost: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    ...over,
  } as TrackedObjectDTO;
}

/** Drive a track through two frames so it stabilizes → resolveEntityIdentity. */
async function sight(vwm: VisualWorkingMemoryService, track: TrackedObjectDTO) {
  const snap = { objects: [track] } as any;
  vwm.updateScene(snap); // create (entering) — createEntity identity attempt
  vwm.updateScene(snap); // ratio 1.0 → present → resolveEntityIdentity
  await flush();
  await flush();
  await flush();
}

describe('P3.2 PRONG 4 — VWM identifies on the FACE embedding, never the body track', () => {
  it('createEntity calls identifyFace with faceEmbedding (NOT entity.embedding)', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = makeFaceSnapshot();
    const vwm = makeVwm(timescale, faceSnapshot);
    await vwm.onModuleInit();

    await sight(vwm, makePersonTrack());

    // Every identifyFace call must have received the FACE vector.
    expect(faceSnapshot.identifyFace).toHaveBeenCalled();
    for (const call of faceSnapshot.identifyFace.mock.calls) {
      expect(call[0]).toEqual(FACE_VEC);
      expect(call[0]).not.toEqual(BODY_VEC);
    }
  });

  it('resolveEntityIdentity calls matchFace with faceEmbedding (NOT entity.embedding)', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = makeFaceSnapshot();
    const vwm = makeVwm(timescale, faceSnapshot);
    await vwm.onModuleInit();

    await sight(vwm, makePersonTrack());

    expect(faceSnapshot.matchFace).toHaveBeenCalled();
    for (const call of faceSnapshot.matchFace.mock.calls) {
      expect(call[0]).toEqual(FACE_VEC);
      expect(call[0]).not.toEqual(BODY_VEC);
    }
  });

  it('a person track with NO faceEmbedding makes NO identity attempt (no body-track fallback)', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = makeFaceSnapshot();
    const vwm = makeVwm(timescale, faceSnapshot);
    await vwm.onModuleInit();

    // Body track present, but no face crop this frame.
    await sight(vwm, makePersonTrack({ faceEmbedding: null }));

    // identifyFace/matchFace must NEVER be called on the body track.
    expect(faceSnapshot.identifyFace).not.toHaveBeenCalled();
    expect(faceSnapshot.matchFace).not.toHaveBeenCalled();
  });
});

describe('P3.2 PRONG 3 — match-path fold uses the FACE embedding', () => {
  it('updateCentroid on a matched existing person folds faceEmbedding (NOT body track)', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = makeFaceSnapshot();
    // matchFace returns an existing known person → the match-path fold fires.
    faceSnapshot.matchFace.mockReturnValue({ personId: 'jim', similarity: 0.9 });
    const vwm = makeVwm(timescale, faceSnapshot);
    await vwm.onModuleInit();

    await sight(vwm, makePersonTrack());

    expect(faceSnapshot.updateCentroid).toHaveBeenCalledWith('jim', FACE_VEC);
    // The body track was never folded.
    for (const call of faceSnapshot.updateCentroid.mock.calls) {
      expect(call[1]).not.toEqual(BODY_VEC);
    }
  });
});

describe('P3.2 PRONGS 1+2 — createUnknownPersonNode uses the FACE embedding', () => {
  it('INSERTs the FACE embedding into face_embeddings and folds it (NOT the body track)', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = makeFaceSnapshot(); // matchFace → null → unknown-person path
    const vwm = makeVwm(timescale, faceSnapshot);
    await vwm.onModuleInit();

    await sight(vwm, makePersonTrack());

    // PRONG 1 — exactly one face_embeddings INSERT, carrying the FACE vector.
    const faceInserts = timescale.find(/INSERT INTO face_embeddings/i);
    expect(faceInserts).toHaveLength(1);
    const literal = faceInserts[0].params?.[2] as string; // $3 = embedding literal
    expect(literal).toBe(`[${FACE_VEC.join(',')}]`);
    expect(literal).not.toBe(`[${BODY_VEC.join(',')}]`);
    // Version stamped 2 (ArcFace) in the INSERT SQL.
    expect(faceInserts[0].sql).toMatch(/embedding_version/);

    // PRONG 2 — the unknown-person centroid fold used the FACE vector.
    const foldCalls = faceSnapshot.updateCentroid.mock.calls;
    expect(foldCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of foldCalls) {
      expect(call[1]).toEqual(FACE_VEC);
      expect(call[1]).not.toEqual(BODY_VEC);
    }
  });

  it('with NO faceEmbedding, createUnknownPersonNode writes NOTHING to face_embeddings', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = makeFaceSnapshot();
    const vwm = makeVwm(timescale, faceSnapshot);
    await vwm.onModuleInit();

    await sight(vwm, makePersonTrack({ faceEmbedding: null }));

    // No face crop → no face_embeddings INSERT (no body-track contamination),
    // and no centroid fold (the placeholder Person node still exists in OKG for
    // the proper face-crop snapshot path to fill in later).
    expect(timescale.find(/INSERT INTO face_embeddings/i)).toHaveLength(0);
    expect(faceSnapshot.updateCentroid).not.toHaveBeenCalled();
  });
});
