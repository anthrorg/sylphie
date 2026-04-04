import { Injectable, Logger } from '@nestjs/common';
import { EMBEDDING_DIM, SensoryFrame } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

const FUSION_PROJECTION_SEED = 0xf05e;

/**
 * Combines encoder outputs into a unified SensoryFrame.
 *
 * Discovers available modalities through the registry — never references
 * specific encoders. Adding a modality never touches this service.
 *
 * Strategy: concatenation + linear projection (per research doc).
 * All N modality embeddings are concatenated into an (N * d) vector,
 * then projected back to d via a Xavier-initialized weight matrix.
 * Missing modalities contribute zero vectors in their slot.
 */
@Injectable()
export class SensoryFusionService {
  private readonly logger = new Logger(SensoryFusionService.name);

  private W: number[][] | null = null;
  private b: number[] | null = null;
  private modalityOrder: string[] | null = null;

  constructor(private readonly registry: ModalityRegistryService) {}

  /**
   * Lazily initialize the projection matrix on first call.
   * Cannot be done in constructor because encoders register during onModuleInit,
   * which runs after all providers are instantiated. By the first tick() call,
   * the registry is fully populated.
   */
  private ensureProjection(): void {
    if (this.W !== null) return;

    this.modalityOrder = this.registry.getModalityNames();
    const concatDim = this.modalityOrder.length * EMBEDDING_DIM;

    this.W = xavierMatrix(EMBEDDING_DIM, concatDim, FUSION_PROJECTION_SEED);
    this.b = new Array(EMBEDDING_DIM).fill(0);

    this.logger.log(
      `Fusion projection initialized: [${EMBEDDING_DIM}×${concatDim}] ` +
        `for ${this.modalityOrder.length} modalities: [${this.modalityOrder.join(', ')}]`,
    );
  }

  /**
   * Fuse raw modality inputs into a single SensoryFrame.
   * @param inputs Map of modality name → raw value (only present modalities included)
   */
  async fuse(inputs: Map<string, unknown>): Promise<SensoryFrame> {
    this.ensureProjection();

    const activeModalities: string[] = [];
    const modalityEmbeddings: Record<string, number[]> = {};
    const raw: Record<string, unknown> = {};

    for (const encoder of this.registry.getAll()) {
      const rawValue = inputs.get(encoder.modalityName);
      if (rawValue !== undefined) {
        activeModalities.push(encoder.modalityName);
        modalityEmbeddings[encoder.modalityName] =
          await encoder.encode(rawValue);
        raw[encoder.modalityName] = rawValue;
      }
    }

    const fusedEmbedding = this.concatAndProject(modalityEmbeddings);

    return {
      timestamp: Date.now(),
      fused_embedding: fusedEmbedding,
      modality_embeddings: modalityEmbeddings,
      active_modalities: activeModalities,
      raw,
    };
  }

  /**
   * Concatenate all registered modality embeddings in deterministic order,
   * then project via W * concat + b.
   */
  private concatAndProject(embeddings: Record<string, number[]>): number[] {
    const zero = new Array(EMBEDDING_DIM).fill(0);

    // Build concatenated vector in registry order
    const concat: number[] = [];
    for (const name of this.modalityOrder!) {
      const emb = embeddings[name] ?? zero;
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        concat.push(emb[i]);
      }
    }

    return linearProject(this.W!, concat, this.b!);
  }
}
