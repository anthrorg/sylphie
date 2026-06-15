/**
 * P1 #0 / P3.1 ACCEPTANCE (live-measured) — visual_embedding modality.
 *
 * Runs the REAL VisualEmbeddingEncoder over REAL 768-D DINOv2-base embeddings
 * captured live from the P3.1 perception sidecar
 * (test/fixtures/vision/real-object-embeddings-dinov2.json: bus scene = 4 person
 * + bus + skateboard; zidane scene = 2 person + tie). It asserts ONLY what
 * cortex's live measurement (2026-06-15, on the re-captured 768-D fixture)
 * proved, and deliberately does NOT assert same-instance re-id — the fixture has
 * no same-instance re-presentation pair (it has DISTINCT persons, not one person
 * from two angles), so a re-id assertion would be theater. That is the documented
 * residual (the mug/book/desk two-angle capture).
 *
 * Bounded-both-directions: Direction A (different scenes / different objects do
 * not collapse) PASSES and is asserted here; Direction B (same-instance
 * separates) is the residual — DINOv2 is the better substrate for it (it drives
 * unrelated objects toward orthogonality, lowering the non-match ceiling to
 * 0.266), but it is un-measurable on this fixture.
 *
 * cortex DINOv2-768 measurements this mirrors (2026-06-15): scene-level
 * cosine(bus, zidane) = 0.384; max single-object off-target pairwise = 0.589 (a
 * same-scene person-person pair); max inter-class (different-label) = 0.266; all
 * < the 0.80 similarity threshold. The encoder L2-normalizes and (P3.1) returns
 * the unit vector DIRECTLY (JL projection deleted), so the emitted block norm is
 * exactly 1.0 by construction — the dominance guard is now structural, not
 * approximate.
 *
 * (For reference, the prior 1280-D EfficientNet fixture measured cross-scene
 * <= 0.39, max off-target 0.563; DINOv2 is the cleaner geometry — same-vs-
 * different mean gap +0.172 vs +0.135 — driven by suppressing the inter-class
 * tail toward orthogonality, e.g. person-vs-bus ~0.03.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VisualEmbeddingEncoder } from './visual-embedding.encoder';
import { EMBEDDING_DIM } from '@sylphie/shared';
import type { SceneSnapshot } from '@sylphie/shared';

// Mirror of latent-space VISUAL_EMBEDDING_SIMILARITY_THRESHOLD (cortex-set,
// unchanged at P3.1 — DINOv2's tighter geometry leaves more headroom under it).
const SIMILARITY_THRESHOLD = 0.8;

// Fixture lives at repo-root test/fixtures; jest runs with cwd = package dir.
// P3.1 — the re-captured 768-D DINOv2-base fixture (the prior 1280-D EfficientNet
// fixture real-object-embeddings.json is retained for the comparison record).
const FIXTURE = path.resolve(
  process.cwd(),
  '../../test/fixtures/vision/real-object-embeddings-dinov2.json',
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

describe('P1 #0 / P3.1 acceptance — visual_embedding (live-measured real DINOv2-768)', () => {
  let enc: VisualEmbeddingEncoder;
  let data: Record<string, FixtureObj[]>;

  beforeAll(() => {
    const registry = { register: jest.fn() } as never;
    enc = new VisualEmbeddingEncoder(registry);
    enc.onModuleInit();
    data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  });

  it('precondition: fixture carries real 768-D DINOv2 embeddings for >= 2 scenes', () => {
    expect(Object.keys(data).length).toBeGreaterThanOrEqual(2);
    for (const objs of Object.values(data)) {
      expect(objs.length).toBeGreaterThan(0);
      for (const o of objs) expect(o.embedding.length).toBe(768);
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
    // cortex measured scene-level cross-scene 0.384 (DINOv2) — assert comfortably
    // separated (a tighter call than EfficientNet's 0.436, still well under 0.6).
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
    // cortex measured max single-object pairwise 0.589 (DINOv2); far under 0.80.
    expect(maxOff).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('4. dominance: the emitted block is a UNIT vector (norm == 1.0 by construction)', async () => {
    const bus = await enc.encode(sceneFrom(data['bus']));
    // P3.1 — the JL projection is DELETED: encode() L2-normalizes the pooled
    // vector and returns it directly, so the block norm is EXACTLY 1.0 (not the
    // old ~0.87 Xavier-projected norm). The dominance guard is now structural —
    // a unit-norm block can never swamp the other modalities in the fused concat.
    expect(norm(bus)).toBeCloseTo(1.0, 6);
  });

  it('RESIDUAL (documented, NOT asserted): same-instance re-id still needs a mug/book/desk two-angle capture', () => {
    // This fixture has DISTINCT persons (same-label, different-instance), not one
    // object/person from two angles, so it cannot test same-instance re-id.
    // DINOv2 is the BETTER substrate for it than EfficientNet — it drives
    // unrelated objects toward orthogonality (person-vs-bus ~0.03), lowering the
    // non-match ceiling to 0.266, so a true same-instance pair (typically 0.6-0.8+
    // for self-supervised re-presentations) would sit on a separable knee well
    // above that ceiling. But that is a HYPOTHESIS this fixture cannot verify;
    // asserting a re-id hit here would be theater. Tracked as the open residual:
    // capture a true same-instance two-angle pair (mug/book/desk) and add the
    // intra > inter assertion then.
    expect(SIMILARITY_THRESHOLD).toBe(0.8);
  });
});
