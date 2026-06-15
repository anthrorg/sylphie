/**
 * P1 #0 ACCEPTANCE (live-measured) — visual_embedding modality.
 *
 * Runs the REAL VisualEmbeddingEncoder over REAL EfficientNet embeddings captured
 * live from the perception sidecar (test/fixtures/vision/real-object-embeddings.json:
 * bus scene = 4 person + bus + skateboard; zidane scene = 2 person + tie). It
 * asserts ONLY what cortex's live measurement (2026-06-14) proved, and
 * deliberately does NOT assert same-instance re-id — the fixture has no
 * same-instance re-presentation pair and EfficientNet classifier-feature cosine
 * bands overlap across class, so a re-id assertion would be theater. That is the
 * documented residual (a mug/book/desk same-instance capture; falls to the P3
 * DINOv2 swap if classifier features still overlap).
 *
 * Bounded-both-directions: Direction A (different scenes don't collapse) PASSES
 * and is asserted here; Direction B (same-instance separates) is the residual.
 *
 * cortex measurements this mirrors: cross-scene cosine <= 0.39; max off-target
 * cosine 0.563; all < the 0.80 similarity threshold; projected block norm ~0.87.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VisualEmbeddingEncoder } from './visual-embedding.encoder';
import { EMBEDDING_DIM } from '@sylphie/shared';
import type { SceneSnapshot } from '@sylphie/shared';

// Mirror of latent-space VISUAL_EMBEDDING_SIMILARITY_THRESHOLD (cortex-set).
const SIMILARITY_THRESHOLD = 0.8;

// Fixture lives at repo-root test/fixtures; jest runs with cwd = package dir.
const FIXTURE = path.resolve(
  process.cwd(),
  '../../test/fixtures/vision/real-object-embeddings.json',
);

type FixtureObj = { label: string; embedding: number[] };

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

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function sceneFrom(objs: Array<{ embedding: number[] | null }>): SceneSnapshot {
  return {
    objects: objs.map((o) => ({ state: 'confirmed', embedding: o.embedding })),
  } as unknown as SceneSnapshot;
}

describe('P1 #0 acceptance — visual_embedding (live-measured real EfficientNet)', () => {
  let enc: VisualEmbeddingEncoder;
  let data: Record<string, FixtureObj[]>;

  beforeAll(() => {
    const registry = { register: jest.fn() } as never;
    enc = new VisualEmbeddingEncoder(registry);
    enc.onModuleInit();
    data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  });

  it('precondition: fixture carries real 1280-D embeddings for >= 2 scenes', () => {
    expect(Object.keys(data).length).toBeGreaterThanOrEqual(2);
    for (const objs of Object.values(data)) {
      expect(objs.length).toBeGreaterThan(0);
      for (const o of objs) expect(o.embedding.length).toBe(1280);
    }
  });

  it('1. liveness: confirmed embeddings -> non-zero 768 vec; empty/all-null -> zero', async () => {
    const bus = await enc.encode(sceneFrom(data['bus']));
    expect(bus.length).toBe(EMBEDDING_DIM);
    expect(norm(bus)).toBeGreaterThan(0);

    expect(norm(await enc.encode(sceneFrom([])))).toBe(0);
    expect(norm(await enc.encode(sceneFrom([{ embedding: null }])))).toBe(0);
  });

  it('2. scene-separation (#0 collapse fix): two different real scenes are NOT collapsed', async () => {
    const bus = await enc.encode(sceneFrom(data['bus']));
    const zidane = await enc.encode(sceneFrom(data['zidane']));
    const c = cosine(bus, zidane);
    expect(c).toBeLessThan(SIMILARITY_THRESHOLD);
    // cortex measured cross-scene <= 0.39 — assert comfortably separated.
    expect(c).toBeLessThan(0.6);
  });

  it('3. no false-merge: every distinct-object pair has cosine < threshold', async () => {
    const all = [...data['bus'], ...data['zidane']];
    const vecs = await Promise.all(all.map((o) => enc.encode(sceneFrom([o]))));
    let maxOff = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        maxOff = Math.max(maxOff, cosine(vecs[i], vecs[j]));
      }
    }
    expect(maxOff).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('4. dominance: L2-normalized projection keeps the block norm bounded', async () => {
    const bus = await enc.encode(sceneFrom(data['bus']));
    // Unit input projected by the fixed Xavier matrix -> bounded norm (cortex ~0.87);
    // never a large magnitude that could swamp other modalities in fusion.
    expect(norm(bus)).toBeGreaterThan(0.3);
    expect(norm(bus)).toBeLessThanOrEqual(1.5);
  });

  it('RESIDUAL (documented, NOT asserted): same-instance re-id needs a mug/book/desk capture or P3 DINOv2', () => {
    // The fixture has no same-instance re-presentation pair, and EfficientNet
    // classifier-feature cosine bands overlap across class (cortex 2026-06-14:
    // same-class mean 0.31 vs different-class mean 0.19, overlapping). Asserting a
    // re-id hit (cosine >= threshold on re-presentation) would be theater. Tracked
    // as an open residual: revisit with a true same-instance capture, falling to
    // the P3 DINOv2 swap if classifier features still overlap.
    expect(SIMILARITY_THRESHOLD).toBe(0.8);
  });
});
