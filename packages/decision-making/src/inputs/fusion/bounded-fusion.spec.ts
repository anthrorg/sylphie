/**
 * Structural bounded-fusion test (P1 #0, HR2 dominance guard — ashby).
 *
 * The visual_embedding encoder L2-normalizes its pooled vector to unit norm
 * BEFORE projection, so a high-magnitude raw pooled embedding cannot dominate
 * the fused concat: its projected 768-block is magnitude-independent (direction
 * only). This test verifies the MECHANISM end-to-end through the real
 * SensoryFusionService with synthetic vectors — a high-magnitude raw embedding
 * and a unit one with the SAME direction fuse to the IDENTICAL frame.
 *
 * NOTE: the REAL mug-vs-book cosine-gap acceptance is a LIVE measurement,
 * deferred to the measurement phase — this is the structural mechanism only.
 */

import { SensoryFusionService } from './sensory-fusion';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { VisualEmbeddingEncoder } from '../encoders/visual-embedding.encoder';
import { OBJECT_EMBEDDING_DIM } from '@sylphie/shared';
import type { SceneSnapshot, TrackedObjectDTO, SceneSummary } from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

function makeTrack(embedding: number[] | null): TrackedObjectDTO {
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
    embedding,
  };
}

function makeSnapshot(embedding: number[] | null): SceneSnapshot {
  const summary: SceneSummary = {
    totalTracks: 1,
    confirmedCount: 1,
    lostCount: 0,
    newCount: 0,
    frameSequence: 1,
  };
  return {
    timestamp: 1,
    frameSequence: 1,
    objects: [makeTrack(embedding)],
    events: [],
    summary,
  };
}

function rawEmbedding(scale: number): number[] {
  const v = new Array(OBJECT_EMBEDDING_DIM);
  for (let i = 0; i < OBJECT_EMBEDDING_DIM; i++) {
    v[i] = scale * Math.sin((i + 1) * 0.013 + 0.3);
  }
  return v;
}

function buildFusion(): { fusion: SensoryFusionService } {
  const registry = new ModalityRegistryService();
  // Register ONLY the visual_embedding encoder so the fused vector is driven
  // entirely by that modality — isolating the bounded-contribution mechanism.
  const enc = new VisualEmbeddingEncoder(registry);
  enc.onModuleInit();
  const fusion = new SensoryFusionService(registry);
  return { fusion };
}

describe('Bounded fusion — visual_embedding L2-normalize dominance guard (P1 #0 / HR2)', () => {
  it('a 1000× high-magnitude raw embedding fuses identically to its unit-direction twin', async () => {
    const { fusion } = buildFusion();

    const unit = await fusion.fuse(
      new Map<string, unknown>([['visual_embedding', makeSnapshot(rawEmbedding(1))]]),
    );
    const huge = await fusion.fuse(
      new Map<string, unknown>([['visual_embedding', makeSnapshot(rawEmbedding(1000))]]),
    );

    // Same DIRECTION, 1000× magnitude gap → identical fused frame (the raw
    // magnitude is discarded by the unit-normalize before projection, so it
    // cannot dominate the fused concat).
    expect(huge.fused_embedding).toHaveLength(unit.fused_embedding.length);
    for (let i = 0; i < unit.fused_embedding.length; i++) {
      expect(huge.fused_embedding[i]).toBeCloseTo(unit.fused_embedding[i], 6);
    }

    // And the fused contribution is BOUNDED — not an exploding magnitude that
    // would swamp other modalities in a real multi-modality concat.
    const fusedNorm = Math.sqrt(
      huge.fused_embedding.reduce((s, v) => s + v * v, 0),
    );
    expect(Number.isFinite(fusedNorm)).toBe(true);
    expect(fusedNorm).toBeLessThan(100); // generous structural ceiling
  });

  it('an all-null-embedding scene contributes a zero visual_embedding block', async () => {
    const { fusion } = buildFusion();
    const frame = await fusion.fuse(
      new Map<string, unknown>([['visual_embedding', makeSnapshot(null)]]),
    );
    // visual_embedding modality is active (slot present) but its embedding is the
    // zero vector (no confirmed embedding) → fused vector is all-zero here.
    expect(frame.active_modalities).toContain('visual_embedding');
    expect(frame.modality_embeddings['visual_embedding'].every((v) => v === 0)).toBe(true);
    expect(frame.fused_embedding.every((v) => v === 0)).toBe(true);
  });
});
