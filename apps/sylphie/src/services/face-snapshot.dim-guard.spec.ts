/**
 * P3.2 — FaceSnapshotService.updateCentroid dim guard (atlas Part 4).
 *
 * Before P3.2 the runtime fold sites had NO guard: only the boot-time hydrate
 * guard protected the centroid. A cross-dim vector (e.g. a stray 1280-D
 * EfficientNet / 768-D DINOv2 body-track vector, or a degraded empty `[]` from a
 * failed ArcFace extract) could be folded in, corrupting the centroid and
 * desyncing snapshotCount from the effective N.
 *
 * P3.2 adds a guard: updateCentroid refuses to fold any embedding whose length
 * != FACE_EMBEDDING_DIM (512, ArcFace). This spec proves:
 *   • a correct 512-D vector folds (centroid count rises);
 *   • a wrong-dim vector is refused (no centroid created / no corruption);
 *   • a degraded empty vector is refused;
 *   • a cross-dim fold into an EXISTING centroid is refused (the stored centroid
 *     is unchanged, identification still works).
 *
 * Only the bare collaborators are needed (null Neo4j/Timescale, stub Config).
 */

import { FaceSnapshotService } from './face-snapshot.service';

const ARCFACE_DIM = 512;

function makeService(): FaceSnapshotService {
  const config = { get: (_k: string, d?: unknown) => d } as any;
  return new FaceSnapshotService(null, null, config);
}

/** A unit-ish vector of the given dim with a recognizable signal at index 0. */
function vec(dim: number, lead = 1): number[] {
  const v = new Array<number>(dim).fill(0);
  v[0] = lead;
  return v;
}

describe('P3.2 FaceSnapshotService.updateCentroid — dim guard', () => {
  it('folds a correct 512-D ArcFace vector (centroid created)', () => {
    const svc = makeService();
    expect(svc.getCentroidCount()).toBe(0);

    svc.updateCentroid('jim', vec(ARCFACE_DIM));

    expect(svc.getCentroidCount()).toBe(1);
    // The folded centroid is identifiable (cosine to itself = 1 >= threshold).
    expect(svc.identifyFace(vec(ARCFACE_DIM))).toBe('jim');
  });

  it('REFUSES a wrong-dim vector (1280-D legacy / 768-D body track): no centroid', () => {
    const svc = makeService();

    svc.updateCentroid('leak-1280', vec(1280));
    svc.updateCentroid('leak-768', vec(768));

    // Neither created a centroid — the cross-dim fold was refused.
    expect(svc.getCentroidCount()).toBe(0);
  });

  it('REFUSES a degraded empty vector', () => {
    const svc = makeService();

    svc.updateCentroid('degraded', []);

    expect(svc.getCentroidCount()).toBe(0);
  });

  it('REFUSES a cross-dim fold into an EXISTING centroid (stored value untouched)', () => {
    const svc = makeService();

    // Seed a real 512-D centroid for jim.
    svc.updateCentroid('jim', vec(ARCFACE_DIM, 1));
    expect(svc.getCentroidCount()).toBe(1);

    // Attempt to fold a wrong-dim vector into jim — must be refused, not folded.
    svc.updateCentroid('jim', vec(768, 5));

    // Still exactly one centroid, and jim is still identifiable by the original
    // 512-D signal (the bad fold did not corrupt or shrink the stored centroid).
    expect(svc.getCentroidCount()).toBe(1);
    expect(svc.identifyFace(vec(ARCFACE_DIM, 1))).toBe('jim');
  });
});
