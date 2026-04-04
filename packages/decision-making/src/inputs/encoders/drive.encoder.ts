import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, ModalityEncoder } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

const DRIVE_VECTOR_SIZE = 12;
const DRIVE_PROJECTION_SEED = 0xd41e;

/**
 * Encodes the 12-float drive pressure vector into a d-dimensional embedding.
 *
 * Pipeline: z-score normalize → linear projection (W[768×12] * x + b).
 * Pure math — no model calls, no external processes.
 * The projection matrix is Xavier-initialized with a deterministic seed
 * so embeddings are stable across restarts.
 */
@Injectable()
export class DriveEncoder implements ModalityEncoder<number[]>, OnModuleInit {
  private readonly logger = new Logger(DriveEncoder.name);
  private W!: number[][];
  private b!: number[];

  readonly modalityName = 'drives';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {}

  onModuleInit() {
    this.W = xavierMatrix(EMBEDDING_DIM, DRIVE_VECTOR_SIZE, DRIVE_PROJECTION_SEED);
    this.b = new Array(EMBEDDING_DIM).fill(0);
    this.logger.log(
      `Drive projection initialized: [${EMBEDDING_DIM}×${DRIVE_VECTOR_SIZE}]`,
    );
    this.registry.register(this);
  }

  async encode(driveVector: number[]): Promise<number[]> {
    this.logger.debug('Encoding drive vector');
    const normalized = this.zScoreNormalize(driveVector);
    return linearProject(this.W, normalized, this.b);
  }

  private zScoreNormalize(values: number[]): number[] {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length,
    );
    if (std === 0) return values.map(() => 0);
    return values.map((v) => (v - mean) / std);
  }
}
