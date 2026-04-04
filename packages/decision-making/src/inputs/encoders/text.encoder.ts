import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';
import { EMBEDDING_DIM, ModalityEncoder } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';

/**
 * Encodes text input into a d-dimensional embedding vector via Ollama.
 *
 * Calls the local Ollama embed API with a configurable model
 * (default: nomic-embed-text, 768-dim output). If Ollama is
 * unreachable, logs a warning and returns a zero vector so the
 * tick loop doesn't crash during development.
 */
@Injectable()
export class TextEncoder implements ModalityEncoder<string>, OnModuleInit {
  private readonly logger = new Logger(TextEncoder.name);
  private client!: Ollama;
  private model!: string;

  readonly modalityName = 'text';
  readonly eventDriven = true;

  constructor(
    private readonly registry: ModalityRegistryService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const host = this.config.get<string>('ollama.host', 'http://localhost:11434');
    this.model = this.config.get<string>('ollama.embedModel', 'nomic-embed-text');
    this.client = new Ollama({ host });
    this.logger.log(`Ollama embed configured: ${host} / ${this.model}`);
    this.registry.register(this);
  }

  async encode(text: string): Promise<number[]> {
    this.logger.debug(`Encoding text (${text.length} chars)`);
    try {
      const response = await this.client.embed({
        model: this.model,
        input: text,
      });
      return response.embeddings[0];
    } catch (err) {
      this.logger.warn(
        `Ollama embed failed, returning zero vector: ${(err as Error).message}`,
      );
      return new Array(EMBEDDING_DIM).fill(0);
    }
  }
}
