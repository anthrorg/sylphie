import { Injectable, Logger } from '@nestjs/common';
import { EMBEDDING_DIM, SensoryFrame, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Perception');
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

const FUSION_PROJECTION_SEED = 0xf05e;

/**
 * Modalities whose encoders perform a blocking network call to produce their
 * embedding (currently only 'text', which embeds via the Ollama HTTP endpoint).
 *
 * CANON §The Lesion Test: when the LLM/embedding endpoint is known-unavailable
 * (Lesion Test or a tripped circuit breaker), fuse() is asked to skip these
 * encoders' network calls and substitute a deterministic zero embedding rather
 * than awaiting an inevitable socket timeout that would park the whole per-turn
 * decision cycle. The raw value is still preserved on the frame so the text
 * CONTENT still reaches retrieval (entity extraction) and the deliberation
 * degraded-SHRUG path — only the network-bound EMBEDDING is skipped.
 *
 * This is a named set (not a hardcoded string) so additional network-bound
 * modalities can be added without touching fuse() logic.
 */
const NETWORK_BOUND_MODALITIES: ReadonlySet<string> = new Set(['text']);

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
   * @param opts.skipNetworkEmbedding When true, encoders in
   *   NETWORK_BOUND_MODALITIES are NOT invoked; a deterministic zero embedding
   *   is substituted instead. The raw value is still preserved on the frame so
   *   text content reaches retrieval and deliberation. Used when the LLM/embed
   *   endpoint is known-unavailable to avoid a blocking network call that would
   *   stall the per-turn cycle (CANON §The Lesion Test).
   */
  async fuse(
    inputs: Map<string, unknown>,
    opts?: { readonly skipNetworkEmbedding?: boolean },
  ): Promise<SensoryFrame> {
    this.ensureProjection();

    const skipNetworkEmbedding = opts?.skipNetworkEmbedding === true;
    const zero = new Array(EMBEDDING_DIM).fill(0);

    const activeModalities: string[] = [];
    const modalityEmbeddings: Record<string, number[]> = {};
    const raw: Record<string, unknown> = {};

    const encodedModalityNames = new Set<string>();

    for (const encoder of this.registry.getAll()) {
      const rawValue = inputs.get(encoder.modalityName);
      if (rawValue !== undefined) {
        activeModalities.push(encoder.modalityName);
        if (skipNetworkEmbedding && NETWORK_BOUND_MODALITIES.has(encoder.modalityName)) {
          // Known-unavailable endpoint: skip the blocking encode() and use a
          // deterministic zero embedding. The raw value is still preserved below
          // so the content survives for retrieval/deliberation.
          modalityEmbeddings[encoder.modalityName] = [...zero];
          this.logger.debug(
            `Fusion: skipped network-bound encode for "${encoder.modalityName}" ` +
              `(embed endpoint known-unavailable) — using zero embedding.`,
          );
        } else {
          modalityEmbeddings[encoder.modalityName] =
            await encoder.encode(rawValue);
        }
        raw[encoder.modalityName] = rawValue;
        encodedModalityNames.add(encoder.modalityName);
      }
    }

    // Pass through any values that have no encoder (e.g. conversation_history,
    // person_model, speaker_name). These are metadata set via
    // TickSamplerService.update() that downstream services read from frame.raw
    // but that do not participate in the fused embedding.
    for (const [name, value] of inputs) {
      if (!encodedModalityNames.has(name)) {
        raw[name] = value;
      }
    }

    const fusedEmbedding = this.concatAndProject(modalityEmbeddings);

    vlog('sensory fusion', {
      activeModalities,
      fusedDim: fusedEmbedding.length,
      fusedNorm: +Math.sqrt(fusedEmbedding.reduce((s, v) => s + v * v, 0)).toFixed(4),
    });

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
