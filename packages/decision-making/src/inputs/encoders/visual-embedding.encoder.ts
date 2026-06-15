import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, OBJECT_EMBEDDING_DIM, ModalityEncoder } from '@sylphie/shared';
import type { SceneSnapshot } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';

/**
 * VisualEmbeddingEncoder — P1 #0 (mythos-corrected topology), P3.1 backbone swap.
 *
 * The richest visual signal in the pipeline is the per-CONFIRMED-track
 * embedding (P3.1 — the 768-D DINOv2-base CLS vector; was the 1280-D
 * EfficientNet vector). It rides on `TrackedObjectDTO.embedding`, a SEPARATE
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
 * Pipeline (P3.1 — the JL projection is DELETED):
 *   pool (mean across CONFIRMED tracks)  ← poolVisualEmbeddings()
 *     → L2-normalize the pooled OBJECT_EMBEDDING_DIM vector to UNIT norm
 *     → return that unit vector DIRECTLY as the modality embedding.
 *
 * Why no projection any more: at P3.1 OBJECT_EMBEDDING_DIM (768, DINOv2-base) ==
 * EMBEDDING_DIM (768). A 768→768 random Johnson–Lindenstrauss projection is an
 * identity-sized matrix that is NOT identity — it is a random rotation that
 * DISTORTS the cosine geometry it was only ever a stopgap for. Strictly worse
 * than identity. So we drop the projection entirely and feed the unit-normalized
 * pooled vector straight into fusion (an honest identity passthrough: a 768-D
 * unit input emerges unchanged → cosine with itself is exactly 1.0).
 *
 * The L2-normalize is the DOMINANCE GUARD (ashby's bounded-both-directions): a
 * high-magnitude raw pooled embedding is renormalized to unit norm, so its fused
 * contribution is bounded and cannot swamp the other modalities — and two inputs
 * that differ ONLY in magnitude collapse to the IDENTICAL output (direction is
 * all that survives).
 *
 * Returns a zero vector when no CONFIRMED track carries a usable embedding
 * (empty scene, all-tentative tracks, all-null embeddings, pre-M0 prod where the
 * sidecar embedder is absent → every embedding is null).
 */
@Injectable()
export class VisualEmbeddingEncoder
  implements ModalityEncoder<SceneSnapshot>, OnModuleInit
{
  private readonly logger = new Logger(VisualEmbeddingEncoder.name);

  readonly modalityName = 'visual_embedding';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {
    // FAIL-LOUD (P3.1): the projection was deleted precisely because the object
    // dim now equals the fused dim. If a future backbone makes them diverge
    // again, the unit pooled vector would be the WRONG length for fusion and
    // there is no longer a projection to reconcile it — so refuse to construct
    // rather than silently feed a mis-length vector into the fused latent.
    if (OBJECT_EMBEDDING_DIM !== EMBEDDING_DIM) {
      throw new Error(
        `VisualEmbeddingEncoder requires OBJECT_EMBEDDING_DIM === EMBEDDING_DIM ` +
          `(the JL projection was deleted at P3.1 when both became 768), but got ` +
          `OBJECT_EMBEDDING_DIM=${OBJECT_EMBEDDING_DIM}, EMBEDDING_DIM=${EMBEDDING_DIM}. ` +
          `A non-${EMBEDDING_DIM} object backbone must re-introduce a projection ` +
          `(or pad/truncate deliberately) before feeding fusion.`,
      );
    }
  }

  onModuleInit() {
    // No projection matrix to build any more (P3.1): the unit-normalized pooled
    // OBJECT_EMBEDDING_DIM vector IS the EMBEDDING_DIM modality vector.
    this.logger.log(
      `Visual-embedding modality initialized: identity passthrough at ${EMBEDDING_DIM}-D ` +
        `(JL projection deleted at P3.1, OBJECT_EMBEDDING_DIM === EMBEDDING_DIM).`,
    );
    this.registry.register(this);
  }

  async encode(snapshot: SceneSnapshot): Promise<number[]> {
    const pooled = poolVisualEmbeddings(snapshot);
    if (pooled === null) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    // L2-normalize the pooled vector to unit norm (the dominance guard), then
    // return it DIRECTLY — no projection (deleted at P3.1; see class doc).
    const unit = l2Normalize(pooled);
    if (unit === null) {
      // Degenerate (all-zero) pooled vector — no semantic content.
      return new Array(EMBEDDING_DIM).fill(0);
    }

    return unit;
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
