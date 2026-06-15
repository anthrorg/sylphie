import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, OBJECT_EMBEDDING_DIM, ModalityEncoder } from '@sylphie/shared';
import type { SceneSnapshot } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

/**
 * VisualEmbeddingEncoder — P1 #0 (mythos-corrected topology).
 *
 * The richest visual signal in the pipeline is the per-CONFIRMED-track
 * embedding (today the 1280-D EfficientNet vector; OBJECT_EMBEDDING_DIM →
 * DINOv2 1024-D at P3). It rides on `TrackedObjectDTO.embedding`, a SEPARATE
 * array from the `VideoDetection[]` ({class,confidence,bbox}) the VideoEncoder
 * consumes — so it reached NestJS, flowed to VWM/SceneEventDetector, but was
 * NEVER handed to the fusion encoders. Two visually-distinct same-COCO scenes
 * (mug-on-desk vs book-on-desk) therefore collapsed to near-identical latents.
 *
 * This encoder closes that cross-array discard: it is a NEW self-registering
 * modality (`visual_embedding`) fed the SAME `SceneSnapshot` as SceneEncoder,
 * but it reads `objects[].embedding`. The fusion/registry are modality-agnostic
 * — registration is `registry.register(this)` in onModuleInit; nothing in the
 * fusion DISPATCH changes (the per-modality fusion SCALE lives in the fusion
 * service, applied generically). VideoEncoder/SceneEncoder are kept for COUNTS
 * and GEOMETRY; this modality adds the appearance signal additively.
 *
 * Pipeline (HARD REQUIREMENT 2 — L2-normalize before projection):
 *   pool (mean across CONFIRMED tracks)  ← poolVisualEmbeddings()
 *     → L2-normalize the pooled OBJECT_EMBEDDING_DIM vector to UNIT norm
 *     → JL-project OBJECT_EMBEDDING_DIM → EMBEDDING_DIM via a fixed-seed Xavier
 *       matrix (Johnson–Lindenstrauss preserves cosine neighborhoods, so a
 *       random projection is a legitimate no-training stopgap).
 *
 * The L2-normalize is the DOMINANCE GUARD (ashby's bounded-both-directions): a
 * high-magnitude raw pooled embedding is renormalized to unit norm BEFORE
 * projection, so its fused contribution is bounded and cannot swamp the other
 * modalities — and two inputs that differ ONLY in magnitude project to the
 * IDENTICAL output (direction is all that survives).
 *
 * Returns a zero vector when no CONFIRMED track carries a usable embedding
 * (empty scene, all-tentative tracks, all-null embeddings, pre-M0 prod where
 * onnxruntime is absent → every embedding is null).
 */

/** Deterministic seed for the 1280→768 JL projection (stable across restarts). */
const VISUAL_EMBEDDING_PROJECTION_SEED = 0x71e0e;

@Injectable()
export class VisualEmbeddingEncoder
  implements ModalityEncoder<SceneSnapshot>, OnModuleInit
{
  private readonly logger = new Logger(VisualEmbeddingEncoder.name);
  private W!: number[][];
  private b!: number[];

  readonly modalityName = 'visual_embedding';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {}

  onModuleInit() {
    // JL projection OBJECT_EMBEDDING_DIM (1280, → 1024 at P3) → EMBEDDING_DIM (768).
    this.W = xavierMatrix(
      EMBEDDING_DIM,
      OBJECT_EMBEDDING_DIM,
      VISUAL_EMBEDDING_PROJECTION_SEED,
    );
    this.b = new Array(EMBEDDING_DIM).fill(0);
    this.logger.log(
      `Visual-embedding projection initialized: [${EMBEDDING_DIM}×${OBJECT_EMBEDDING_DIM}]`,
    );
    this.registry.register(this);
  }

  async encode(snapshot: SceneSnapshot): Promise<number[]> {
    const pooled = poolVisualEmbeddings(snapshot);
    if (pooled === null) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    // HR2: L2-normalize the pooled vector to unit norm BEFORE projection.
    const unit = l2Normalize(pooled);
    if (unit === null) {
      // Degenerate (all-zero) pooled vector — no semantic content.
      return new Array(EMBEDDING_DIM).fill(0);
    }

    return linearProject(this.W, unit, this.b);
  }
}

/**
 * Mean-pool the per-object embeddings across CONFIRMED tracks of a scene.
 *
 * Named (per HR2) so attention/max-pool can replace mean-pool later WITHOUT
 * touching the fusion or the encoder's project step. Ignores:
 *   - non-`confirmed` tracks (tentative/lost/deleted carry no stable embedding),
 *   - null embeddings (pre-M0 prod where onnxruntime is absent → all null),
 *   - embeddings whose length ≠ OBJECT_EMBEDDING_DIM (shape mismatch guard).
 *
 * @returns The OBJECT_EMBEDDING_DIM mean vector, or null when no confirmed track
 *          contributes a usable embedding (caller emits a zero vector).
 */
export function poolVisualEmbeddings(snapshot: SceneSnapshot): number[] | null {
  const sum = new Array(OBJECT_EMBEDDING_DIM).fill(0);
  let n = 0;

  for (const obj of snapshot.objects) {
    if (obj.state !== 'confirmed') continue;
    const emb = obj.embedding;
    if (!Array.isArray(emb) || emb.length !== OBJECT_EMBEDDING_DIM) continue;
    for (let i = 0; i < OBJECT_EMBEDDING_DIM; i++) {
      sum[i] += emb[i];
    }
    n++;
  }

  if (n === 0) return null;

  for (let i = 0; i < OBJECT_EMBEDDING_DIM; i++) {
    sum[i] /= n;
  }
  return sum;
}

/**
 * L2-normalize a vector to unit norm. Returns null for a zero-norm vector (no
 * direction to normalize toward → no semantic content).
 */
function l2Normalize(v: number[]): number[] | null {
  let normSq = 0;
  for (let i = 0; i < v.length; i++) normSq += v[i] * v[i];
  if (normSq === 0) return null;
  const inv = 1 / Math.sqrt(normSq);
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}
