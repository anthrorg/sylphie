/**
 * Contract for a sensory modality encoder.
 *
 * Each modality (text, video, drives, audio, etc.) implements this once
 * and self-registers with the ModalityRegistryService at startup.
 * The fusion layer and tick sampler discover encoders through the registry
 * rather than hardcoded references — adding a modality never touches
 * existing code.
 */
export interface ModalityEncoder<TRaw = unknown> {
  /** Unique name for this modality (e.g. 'text', 'drives', 'video') */
  readonly modalityName: string;

  /**
   * Whether this modality's raw value is cleared after each tick.
   * true  = event-driven (e.g. text — consumed once, then gone until new input)
   * false = persistent   (e.g. drives — always holds latest value)
   */
  readonly eventDriven: boolean;

  /** Encode the raw input into a d-dimensional (EMBEDDING_DIM) embedding vector. */
  encode(raw: TRaw): Promise<number[]>;
}
