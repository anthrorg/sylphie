/**
 * Unit tests for VisualEmbeddingEncoder (P1 #0, P3.1 backbone swap).
 *
 * P3.1 deleted the JL projection: OBJECT_EMBEDDING_DIM (768, DINOv2-base) now
 * equals EMBEDDING_DIM (768), so the encoder L2-normalizes the pooled vector and
 * returns it DIRECTLY (identity passthrough). These specs prove:
 *   1. empty / null → zero vector (no confirmed track, all-tentative, all-null
 *      embeddings, wrong-dim embeddings)
 *   2. output dimensionality is EMBEDDING_DIM (768)
 *   3. IDENTITY PASSTHROUGH (no projection): a 768-D L2-unit input emerges
 *      unchanged → cosine with itself == 1.0 exactly; the output IS the unit
 *      of the pooled input (cosine geometry preserved, no random rotation)
 *   4. L2-normalize dominance guard: two inputs that differ ONLY in magnitude
 *      collapse to the IDENTICAL output (unit-normalized → direction only)
 *   5. poolVisualEmbeddings ignores null / tentative / wrong-dim tracks and means
 *      across CONFIRMED tracks only
 *   6. FAIL-LOUD: the constructor throws when OBJECT_EMBEDDING_DIM !== EMBEDDING_DIM
 */

import { VisualEmbeddingEncoder, poolVisualEmbeddings } from './visual-embedding.encoder';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { EMBEDDING_DIM, OBJECT_EMBEDDING_DIM } from '@sylphie/shared';
import type { SceneSnapshot, TrackedObjectDTO, SceneSummary } from '@sylphie/shared';

// Suppress verbose logging during tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrack(overrides: Partial<TrackedObjectDTO> = {}): TrackedObjectDTO {
  return {
    trackId: 1,
    state: 'confirmed',
    label: 'cup',
    confidence: 0.9,
    bbox: [0, 0, 10, 10],
    framesSeen: 5,
    framesLost: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    embedding: null,
    ...overrides,
  };
}

function makeSnapshot(objects: TrackedObjectDTO[]): SceneSnapshot {
  const summary: SceneSummary = {
    totalTracks: objects.length,
    confirmedCount: objects.filter((o) => o.state === 'confirmed').length,
    lostCount: 0,
    newCount: 0,
    frameSequence: 1,
  };
  return { timestamp: 1, frameSequence: 1, objects, events: [], summary };
}

/** A deterministic OBJECT_EMBEDDING_DIM vector seeded by `s`. */
function rawEmbedding(s: number, scale = 1): number[] {
  const v = new Array(OBJECT_EMBEDDING_DIM);
  for (let i = 0; i < OBJECT_EMBEDDING_DIM; i++) {
    v[i] = scale * Math.sin((i + 1) * 0.01 + s);
  }
  return v;
}

function makeEncoder(): VisualEmbeddingEncoder {
  const enc = new VisualEmbeddingEncoder(new ModalityRegistryService());
  enc.onModuleInit(); // self-registers (no W/b to initialize any more)
  return enc;
}

function isZeroVector(v: number[]): boolean {
  return v.every((x) => x === 0);
}

function l2(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function l2Unit(v: number[]): number[] {
  const inv = 1 / l2(v);
  return v.map((x) => x * inv);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VisualEmbeddingEncoder (P1 #0, P3.1 identity passthrough)', () => {
  describe('empty / null → zero vector', () => {
    it('returns a zero vector for an empty scene', async () => {
      const out = await makeEncoder().encode(makeSnapshot([]));
      expect(out).toHaveLength(EMBEDDING_DIM);
      expect(isZeroVector(out)).toBe(true);
    });

    it('returns a zero vector when all tracks are tentative (no confirmed)', async () => {
      const snap = makeSnapshot([
        makeTrack({ state: 'tentative', embedding: rawEmbedding(1) }),
        makeTrack({ state: 'lost', embedding: rawEmbedding(2) }),
      ]);
      const out = await makeEncoder().encode(snap);
      expect(isZeroVector(out)).toBe(true);
    });

    it('returns a zero vector when confirmed tracks all have null embeddings (pre-M0 prod)', async () => {
      const snap = makeSnapshot([
        makeTrack({ state: 'confirmed', embedding: null }),
        makeTrack({ state: 'confirmed', embedding: null }),
      ]);
      const out = await makeEncoder().encode(snap);
      expect(isZeroVector(out)).toBe(true);
    });

    it('ignores wrong-dimension embeddings (shape mismatch guard)', async () => {
      const snap = makeSnapshot([
        makeTrack({ state: 'confirmed', embedding: [0.1, 0.2, 0.3] }), // wrong dim
      ]);
      const out = await makeEncoder().encode(snap);
      expect(isZeroVector(out)).toBe(true);
    });
  });

  describe('output dimensionality', () => {
    it('emits EMBEDDING_DIM (768)', async () => {
      const snap = makeSnapshot([makeTrack({ embedding: rawEmbedding(1) })]);
      const out = await makeEncoder().encode(snap);
      expect(out).toHaveLength(EMBEDDING_DIM);
      expect(isZeroVector(out)).toBe(false);
    });
  });

  describe('identity passthrough (P3.1 — no projection)', () => {
    it('is byte-identical across two calls on the same input (deterministic)', async () => {
      const snap = makeSnapshot([makeTrack({ embedding: rawEmbedding(3) })]);
      const a = await makeEncoder().encode(snap);
      const b = await makeEncoder().encode(snap);
      expect(a).toEqual(b);
    });

    it('a 768-D unit input emerges UNCHANGED (identity) → self-cosine == 1.0 exactly', async () => {
      // Feed a single confirmed track whose embedding is ALREADY a 768-D unit
      // vector. With the projection deleted, the encoder output must be that
      // exact same unit vector (pool of one = itself; L2-normalize of a unit
      // vector = itself). Cosine of the output with the input is exactly 1.0.
      const unitInput = l2Unit(rawEmbedding(7));
      const out = await makeEncoder().encode(
        makeSnapshot([makeTrack({ embedding: unitInput })]),
      );
      expect(out).toHaveLength(EMBEDDING_DIM);
      // Exact identity passthrough, element-wise (no random rotation distorts it).
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        expect(out[i]).toBeCloseTo(unitInput[i], 12);
      }
      // Self-cosine is exactly 1.0 (the strongest statement of "unchanged").
      expect(cosine(out, unitInput)).toBeCloseTo(1.0, 12);
    });

    it('output is the L2-unit of the pooled raw input (norm 1.0, cosine geometry preserved)', async () => {
      // A non-unit raw input: output is its unit-normalized direction, with the
      // SAME cosine to the raw input (normalization preserves direction).
      const raw = rawEmbedding(2);
      const out = await makeEncoder().encode(
        makeSnapshot([makeTrack({ embedding: raw })]),
      );
      expect(l2(out)).toBeCloseTo(1.0, 9);
      expect(cosine(out, raw)).toBeCloseTo(1.0, 12);
    });

    it('preserves PAIRWISE cosine geometry between two distinct inputs (no random rotation)', async () => {
      // The deleted JL projection was a random rotation that perturbed cosines.
      // Identity passthrough preserves them exactly: cos(out_a, out_b) ==
      // cos(raw_a, raw_b).
      const enc = makeEncoder();
      const rawA = rawEmbedding(1);
      const rawB = rawEmbedding(4);
      const outA = await enc.encode(makeSnapshot([makeTrack({ embedding: rawA })]));
      const outB = await enc.encode(makeSnapshot([makeTrack({ embedding: rawB })]));
      expect(cosine(outA, outB)).toBeCloseTo(cosine(rawA, rawB), 9);
    });
  });

  describe('L2-normalize dominance guard', () => {
    it('two inputs differing ONLY in magnitude → identical output', async () => {
      const enc = makeEncoder();
      const small = makeSnapshot([makeTrack({ embedding: rawEmbedding(5, 1) })]);
      const huge = makeSnapshot([makeTrack({ embedding: rawEmbedding(5, 1000) })]);
      const a = await enc.encode(small);
      const b = await enc.encode(huge);
      // Unit-normalized → magnitude is discarded, direction survives → identical
      // output despite the 1000× raw-magnitude gap.
      expect(a.length).toBe(EMBEDDING_DIM);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBeCloseTo(b[i], 9);
      }
    });

    it('the emitted vector is unit-norm (bounded contribution to fusion)', async () => {
      // A high-magnitude raw embedding emerges at norm 1.0, so it cannot swamp
      // the other modalities in the fused concat.
      const out = await makeEncoder().encode(
        makeSnapshot([makeTrack({ embedding: rawEmbedding(2, 500) })]),
      );
      expect(l2(out)).toBeCloseTo(1.0, 9);
    });
  });

  describe('poolVisualEmbeddings (mean across CONFIRMED only)', () => {
    it('means across confirmed tracks, ignoring tentative/lost/null/wrong-dim', () => {
      const eA = rawEmbedding(1);
      const eB = rawEmbedding(2);
      const snap = makeSnapshot([
        makeTrack({ trackId: 1, state: 'confirmed', embedding: eA }),
        makeTrack({ trackId: 2, state: 'confirmed', embedding: eB }),
        makeTrack({ trackId: 3, state: 'tentative', embedding: rawEmbedding(9) }), // ignored
        makeTrack({ trackId: 4, state: 'confirmed', embedding: null }), // ignored
        makeTrack({ trackId: 5, state: 'confirmed', embedding: [1, 2, 3] }), // wrong dim, ignored
      ]);
      const pooled = poolVisualEmbeddings(snap);
      expect(pooled).not.toBeNull();
      expect(pooled).toHaveLength(OBJECT_EMBEDDING_DIM);
      // Mean of exactly eA and eB (the two valid confirmed tracks).
      for (let i = 0; i < OBJECT_EMBEDDING_DIM; i++) {
        expect(pooled![i]).toBeCloseTo((eA[i] + eB[i]) / 2, 12);
      }
    });

    it('returns null when no confirmed track contributes a usable embedding', () => {
      expect(poolVisualEmbeddings(makeSnapshot([]))).toBeNull();
      expect(
        poolVisualEmbeddings(
          makeSnapshot([makeTrack({ state: 'tentative', embedding: rawEmbedding(1) })]),
        ),
      ).toBeNull();
    });
  });

  describe('FAIL-LOUD: OBJECT_EMBEDDING_DIM === EMBEDDING_DIM assertion', () => {
    // The mismatch (throws) case lives in its own spec file
    // (visual-embedding.encoder.assertion.spec.ts) because it needs a
    // file-level mock of @sylphie/shared with diverging dims — a per-test
    // re-mock is shadowed by THIS file's top-level jest.mock factory.
    it('does NOT throw at the real shipped dims (both 768)', () => {
      expect(OBJECT_EMBEDDING_DIM).toBe(EMBEDDING_DIM);
      expect(OBJECT_EMBEDDING_DIM).toBe(768);
      expect(() => makeEncoder()).not.toThrow();
    });
  });
});
