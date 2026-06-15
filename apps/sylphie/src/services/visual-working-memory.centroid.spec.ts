/**
 * P1 #2 — Mutable instance centroids.
 *
 * Today a :VisualObject's embedding is written ONCE (at createUndiscoveredNode)
 * and never moves. #2 makes it a running mean: every confirmed re-sighting folds
 * the new embedding into the stored centroid (incremental mean, mirroring
 * FaceSnapshotService.updateCentroid) — bounded assimilation within the FIXED
 * EfficientNet space, NOT a learned-backbone drift (stability invariant #2).
 *
 * EXIT GATE (plan §5.1): "the stored centroid drifts toward the running mean
 * across N sightings with no duplicate node." This file proves both legs:
 *   (a) drift  — rigorously on the pure helper `foldObjectCentroid`;
 *   (b) no dup — via the public `updateScene` path: a re-sighted object that
 *       matches an existing row issues an UPDATE that carries a moved embedding
 *       and NEVER an INSERT (no second :VisualObject row).
 */

import {
  VisualWorkingMemoryService,
  foldObjectCentroid,
  parseVectorLiteral,
} from './visual-working-memory.service';
import { BindingService } from './binding.service';
import type { TrackedObjectDTO } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// (a) Pure helper — the centroid math IS the drift guarantee
// ---------------------------------------------------------------------------

describe('foldObjectCentroid — incremental-mean drift (#2)', () => {
  it('initializes from an empty centroid by copying the first sighting', () => {
    const next = [1, 2, 3];
    const out = foldObjectCentroid([], next, 1);
    expect(out).toEqual([1, 2, 3]);
    // a copy, not the same reference
    expect(out).not.toBe(next);
  });

  it('n=1 fold is the exact average of the two vectors', () => {
    expect(foldObjectCentroid([1, 0, 0, 0], [0, 1, 0, 0], 1)).toEqual([
      0.5, 0.5, 0, 0,
    ]);
  });

  it('drifts to the TRUE running mean across N sightings', () => {
    // centroid starts == first sighting with n=1 (the creation sighting is
    // already "in" the mean); folding e1..e_{k} must yield mean(e0..e_k).
    const sightings = [
      [0, 0, 0],
      [3, 3, 3],
      [6, 6, 6],
      [9, 9, 9],
    ];
    let centroid = sightings[0].slice();
    let n = 1;
    for (let k = 1; k < sightings.length; k++) {
      centroid = foldObjectCentroid(centroid, sightings[k], n);
      n += 1;
    }
    // naive mean of all four
    const mean = sightings[0].map(
      (_, i) =>
        sightings.reduce((acc, v) => acc + v[i], 0) / sightings.length,
    );
    centroid.forEach((c, i) => expect(c).toBeCloseTo(mean[i], 10));
    expect(mean).toEqual([4.5, 4.5, 4.5]);
  });

  it('converges to a constant repeated sighting', () => {
    let centroid = [10, -4, 0.5];
    let n = 1;
    const fixed = [10, -4, 0.5];
    for (let k = 0; k < 25; k++) {
      centroid = foldObjectCentroid(centroid, fixed, n);
      n += 1;
    }
    centroid.forEach((c, i) => expect(c).toBeCloseTo(fixed[i], 10));
  });

  it('matches an arbitrary running mean over many random-ish sightings', () => {
    // deterministic pseudo-data (no RNG): e_k[j] = (k*7 + j*13) % 17
    const N = 40;
    const dim = 5;
    const seq: number[][] = [];
    for (let k = 0; k < N; k++) {
      seq.push(Array.from({ length: dim }, (_, j) => (k * 7 + j * 13) % 17));
    }
    let centroid = seq[0].slice();
    let n = 1;
    for (let k = 1; k < N; k++) {
      centroid = foldObjectCentroid(centroid, seq[k], n);
      n += 1;
    }
    const mean = Array.from(
      { length: dim },
      (_, j) => seq.reduce((acc, v) => acc + v[j], 0) / N,
    );
    centroid.forEach((c, j) => expect(c).toBeCloseTo(mean[j], 8));
  });

  it('no-ops (returns the original) on dimension mismatch — never corrupts', () => {
    const centroid = [1, 2, 3];
    expect(foldObjectCentroid(centroid, [1, 2], 4)).toBe(centroid);
    expect(foldObjectCentroid(centroid, [1, 2, 3, 4], 4)).toBe(centroid);
  });

  it('no-ops on non-positive / NaN sighting count', () => {
    const centroid = [1, 2, 3];
    expect(foldObjectCentroid(centroid, [9, 9, 9], 0)).toBe(centroid);
    expect(foldObjectCentroid(centroid, [9, 9, 9], -3)).toBe(centroid);
    expect(foldObjectCentroid(centroid, [9, 9, 9], NaN)).toBe(centroid);
  });

  it('does not mutate the input centroid', () => {
    const centroid = [1, 1, 1];
    const snapshot = centroid.slice();
    foldObjectCentroid(centroid, [3, 3, 3], 1);
    expect(centroid).toEqual(snapshot);
  });
});

describe('parseVectorLiteral', () => {
  it('parses a pgvector text literal', () => {
    expect(parseVectorLiteral('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseVectorLiteral('[0.5,-1.25,3.75]')).toEqual([0.5, -1.25, 3.75]);
  });

  it('returns null on empty / nullish / malformed input', () => {
    expect(parseVectorLiteral(null)).toBeNull();
    expect(parseVectorLiteral(undefined)).toBeNull();
    expect(parseVectorLiteral('')).toBeNull();
    expect(parseVectorLiteral('[]')).toBeNull();
    expect(parseVectorLiteral('garbage')).toBeNull();
    expect(parseVectorLiteral('[1,2,NaN]')).toBeNull(); // NaN is invalid JSON
  });

  it('returns null when any element is non-numeric', () => {
    expect(parseVectorLiteral('[1,"a",3]')).toBeNull();
    expect(parseVectorLiteral('[1,null,3]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) Component path — re-sighting mutates the matched row, never inserts
// ---------------------------------------------------------------------------

const flush = () => new Promise((r) => setImmediate(r));

/** Records every query; answers the cosine SELECT with a fixed known match. */
class FakeTimescale {
  public queries: Array<{ sql: string; params?: unknown[] }> = [];
  /** The stored centroid the SELECT returns (dim 4 for a readable assertion). */
  public storedEmbedding = [1, 0, 0, 0];
  public sightingCount = 1;

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    if (/embedding <=> \$1::vector/.test(sql)) {
      // Nearest-neighbour candidate row; BindingService recomputes the real
      // cosine from these embeddings (the `distance` here is unused by #1).
      return {
        rows: [
          {
            id: 'row-1',
            node_id: 'vobj-known',
            label: 'cup',
            display_name: 'coffee mug',
            discovered: true,
            embedding: `[${this.storedEmbedding.join(',')}]`,
            sighting_count: this.sightingCount,
            last_seen_ms: null,
            distance: 0.1,
          } as unknown as T,
        ],
      };
    }
    return { rows: [] };
  }

  find(re: RegExp) {
    return this.queries.filter((q) => re.test(q.sql));
  }
}

function makeTrack(over: Partial<TrackedObjectDTO> = {}): TrackedObjectDTO {
  return {
    trackId: 1,
    label: 'cup',
    state: 'confirmed',
    bbox: [100, 100, 200, 200],
    confidence: 0.9,
    // High cosine to the stored [1,0,0,0] so BindingService re-IDs it, but
    // different enough that the folded centroid visibly moves.
    embedding: [0.9, 0.1, 0, 0],
    ...over,
  } as TrackedObjectDTO;
}

describe('VWM #2 — re-sighting folds the centroid without a duplicate node', () => {
  it('matches an existing row and UPDATEs a moved embedding (no INSERT)', async () => {
    const timescale = new FakeTimescale();
    const faceSnapshot = {
      identifyFace: jest.fn().mockReturnValue(null),
      matchFace: jest.fn().mockReturnValue(null),
      updateCentroid: jest.fn(),
    };
    const personModel = {};

    const vwm = new VisualWorkingMemoryService(
      timescale as any,
      null, // no Neo4j — TimescaleDB path is what #2 mutates
      faceSnapshot as any,
      personModel as any,
      new BindingService(),
    );
    await vwm.onModuleInit(); // ensureSchema → schemaReady

    // Drive enough confirmed frames of the SAME object to stabilize it to
    // 'present', which fires resolveEntityIdentity (the centroid update path).
    const snap = { objects: [makeTrack()] } as any;
    vwm.updateScene(snap); // create (entering)
    vwm.updateScene(snap); // ratio 1.0 ≥ ENTER_RATIO → present → resolve
    await flush();
    await flush();
    await flush();

    // No INSERT into visual_object_embeddings → no duplicate :VisualObject row.
    expect(timescale.find(/INSERT INTO visual_object_embeddings/i)).toHaveLength(
      0,
    );

    // Exactly the embedding-carrying UPDATE fired.
    const updates = timescale.find(/UPDATE visual_object_embeddings/i);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const embeddingUpdate = updates.find((q) =>
      /embedding = \$2::vector/.test(q.sql),
    );
    expect(embeddingUpdate).toBeDefined();

    // The written centroid is the incremental mean of stored [1,0,0,0] and the
    // sighting [0.9,0.1,0,0] at n=1 → [0.95,0.05,0,0]. The row is targeted by id.
    expect(embeddingUpdate!.params?.[0]).toBe('row-1');
    const written = parseVectorLiteral(
      embeddingUpdate!.params?.[1] as string,
    );
    expect(written).not.toBeNull();
    [0.95, 0.05, 0, 0].forEach((v, i) =>
      expect(written![i]).toBeCloseTo(v, 10),
    );
  });

  it('does NOT merge an orthogonal-embedding candidate with a matching label (#1 anchor)', async () => {
    const timescale = new FakeTimescale(); // stored centroid [1,0,0,0]
    const faceSnapshot = { identifyFace: jest.fn().mockReturnValue(null) };

    const vwm = new VisualWorkingMemoryService(
      timescale as any,
      null,
      faceSnapshot as any,
      {} as any,
      new BindingService(),
    );
    await vwm.onModuleInit();

    // A different physical object that happens to share the 'cup' label but is
    // visually ORTHOGONAL to the stored centroid. BindingService must not merge
    // on label alone (embedding is the anchor) → a new node is created instead.
    const snap = { objects: [makeTrack({ embedding: [0, 1, 0, 0] })] } as any;
    vwm.updateScene(snap);
    vwm.updateScene(snap);
    await flush();
    await flush();
    await flush();

    // No confident re-ID → a NEW node (INSERT); the existing centroid is NOT
    // folded (no embedding-carrying UPDATE).
    expect(
      timescale.find(/INSERT INTO visual_object_embeddings/i).length,
    ).toBeGreaterThanOrEqual(1);
    const updates = timescale.find(/UPDATE visual_object_embeddings/i);
    expect(updates.every((q) => !/embedding = \$2::vector/.test(q.sql))).toBe(
      true,
    );
  });
});
