import { Injectable, Logger } from '@nestjs/common';
import { ModalityEncoder } from '@sylphie/shared';

/**
 * Central registry for sensory modality encoders.
 *
 * Encoders self-register via onModuleInit by calling registry.register(this).
 * The fusion service and tick sampler consume this registry rather than
 * referencing encoders directly — adding a modality never touches these services.
 */
@Injectable()
export class ModalityRegistryService {
  private readonly logger = new Logger(ModalityRegistryService.name);
  private readonly encoders = new Map<string, ModalityEncoder>();

  /** Register a modality encoder. Called by each encoder in onModuleInit. */
  register(encoder: ModalityEncoder): void {
    if (this.encoders.has(encoder.modalityName)) {
      throw new Error(
        `Modality '${encoder.modalityName}' is already registered`,
      );
    }
    this.encoders.set(encoder.modalityName, encoder);
    this.logger.log(`Registered modality: ${encoder.modalityName}`);
  }

  /** Get all registered encoders in deterministic order (alphabetical by name). */
  getAll(): ModalityEncoder[] {
    return [...this.encoders.values()].sort((a, b) =>
      a.modalityName.localeCompare(b.modalityName),
    );
  }

  /** Get a specific encoder by modality name. */
  get(name: string): ModalityEncoder | undefined {
    return this.encoders.get(name);
  }

  /** Get all registered modality names in deterministic order. */
  getModalityNames(): string[] {
    return this.getAll().map((e) => e.modalityName);
  }

  /** Number of registered modalities. */
  get count(): number {
    return this.encoders.size;
  }

  /** Names of event-driven modalities (cleared after each tick). */
  getEventDrivenNames(): Set<string> {
    return new Set(
      this.getAll()
        .filter((e) => e.eventDriven)
        .map((e) => e.modalityName),
    );
  }
}
