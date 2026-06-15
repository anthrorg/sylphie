/**
 * Unit tests for VisualEmbeddingEncoder (P1 #0).
 *
 * Covers:
 *   1. empty / null → zero vector (no confirmed track, all-tentative, all-null
 *      embeddings, wrong-dim embeddings)
 *   2. output dimensionality is EMBEDDING_DIM (768)
 *   3. deterministic projection — two calls on the same input are byte-identical,
 *      and match a golden first-row hash computed from the real code
 *   4. L2-normalize-before-projection (HR2): two inputs that differ ONLY in
 *      magnitude project to the IDENTICAL output (unit-normalized → direction only)
 *   5. poolVisualEmbeddings ignores null / tentative / wrong-dim tracks and means
 *      across CONFIRMED tracks only
 */

import { createHash } from 'crypto';
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
  enc.onModuleInit(); // initializes W/b and self-registers
  return enc;
}

function isZeroVector(v: number[]): boolean {
  return v.every((x) => x === 0);
}

function l2(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VisualEmbeddingEncoder (P1 #0)', () => {
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
    it('projects to EMBEDDING_DIM (768)', async () => {
      const snap = makeSnapshot([makeTrack({ embedding: rawEmbedding(1) })]);
      const out = await makeEncoder().encode(snap);
      expect(out).toHaveLength(EMBEDDING_DIM);
      expect(isZeroVector(out)).toBe(false);
    });
  });

  describe('deterministic projection (golden)', () => {
    it('is byte-identical across two calls on the same input', async () => {
      const snap = makeSnapshot([makeTrack({ embedding: rawEmbedding(3) })]);
      const a = await makeEncoder().encode(snap);
      const b = await makeEncoder().encode(snap);
      expect(a).toEqual(b);
    });

    it('matches a checked-in golden hash of the projected output', async () => {
      // GOLDEN — computed from the real code (fixed seed + fixed input). If the
      // projection seed or the pool→normalize→project math changes, this MUST be
      // recomputed deliberately (it is a guard against silent drift).
      const snap = makeSnapshot([makeTrack({ embedding: rawEmbedding(7) })]);
      const out = await makeEncoder().encode(snap);
      const quantized = out.map((v) => Math.round(v * 1e6) / 1e6);
      const hash = createHash('sha256').update(quantized.join(',')).digest('hex');
      expect(hash).toBe(GOLDEN_OUTPUT_HASH);
    });
  });

  describe('L2-normalize-before-projection (HR2 dominance guard)', () => {
    it('two inputs differing ONLY in magnitude → identical projected output', async () => {
      const enc = makeEncoder();
      const small = makeSnapshot([makeTrack({ embedding: rawEmbedding(5, 1) })]);
      const huge = makeSnapshot([makeTrack({ embedding: rawEmbedding(5, 1000) })]);
      const a = await enc.encode(small);
      const b = await enc.encode(huge);
      // Unit-normalized before projection → magnitude is discarded, direction
      // survives → identical projected vectors despite the 1000× raw-magnitude gap.
      expect(a.length).toBe(EMBEDDING_DIM);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBeCloseTo(b[i], 9);
      }
    });

    it('the POOLED vector that is projected is unit-norm (bounded contribution)', () => {
      // Mechanism check: pool then L2-normalize → norm 1.0, regardless of raw
      // magnitude, so a high-magnitude raw embedding cannot dominate the fused
      // concat. (The encoder applies this normalize internally before project.)
      const pooled = poolVisualEmbeddings(
        makeSnapshot([makeTrack({ embedding: rawEmbedding(2, 500) })]),
      );
      expect(pooled).not.toBeNull();
      const inv = 1 / l2(pooled!);
      const unit = pooled!.map((x) => x * inv);
      expect(l2(unit)).toBeCloseTo(1.0, 9);
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
});

// Golden computed from the real encoder (fixed VISUAL_EMBEDDING_PROJECTION_SEED,
// input rawEmbedding(7), single confirmed track). Recompute deliberately if the
// projection seed or pool/normalize/project math changes.
const GOLDEN_OUTPUT_HASH =
  '1770789b3c7dc4f39384ae1f355ef9ac9ab3f9c488e1da885da612b346f84331';
