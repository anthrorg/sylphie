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
/**
 * Hard ceiling on the embed network call. The `ollama` client passes no
 * AbortSignal on non-streaming POSTs, and undici `fetch` has no default total
 * timeout — so a dead/severed Ollama endpoint would otherwise park the call
 * (and the whole per-turn decision cycle, which awaits this synchronously)
 * until an OS socket timeout. A local embed of a short string is sub-second;
 * 3s is generous. On timeout we fall back to the zero vector, the same as any
 * other embed failure, so the tick loop degrades instead of hanging.
 */
const DEFAULT_EMBED_TIMEOUT_MS = 3000;

/**
 * nomic-embed-text task instruction prefixes.
 *
 * nomic-embed-text is an INSTRUCTION-TUNED retrieval model: it expects every
 * input to be prefixed with the task it is serving. Search queries and the
 * documents they retrieve are embedded into DIFFERENT sub-spaces via different
 * prefixes, so a query only scores highly against a document about the SAME
 * topic. Without the prefixes, the model falls back to generic sentence
 * similarity, where unrelated short English sentences sit at cosine 0.7–0.9 —
 * which is exactly how nonsense was clearing the latent-space 0.80 threshold
 * against an over-general stored pattern (the confabulation root cause).
 *
 * Asymmetry is mandatory: the per-turn live input is the QUERY
 * (`search_query:`) and a stored learned pattern is the DOCUMENT
 * (`search_document:`). Prefixing both sides the same way collapses the
 * retrieval asymmetry the model was trained on.
 */
const QUERY_PREFIX = 'search_query: ';
const DOCUMENT_PREFIX = 'search_document: ';

/**
 * Structural marker for encoders that can also produce a DOCUMENT-side
 * embedding (for write-back / pattern storage). The generic ModalityEncoder
 * contract only exposes encode() — which the fusion layer drives for the
 * per-turn QUERY embedding — so the document path is surfaced separately and
 * discovered by a runtime type guard at the write-back call site.
 */
export interface DocumentEncoder {
  encodeDocument(text: string): Promise<number[]>;
}

/** Runtime type guard for {@link DocumentEncoder}. */
export function isDocumentEncoder(value: unknown): value is DocumentEncoder {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DocumentEncoder).encodeDocument === 'function'
  );
}

@Injectable()
export class TextEncoder
  implements ModalityEncoder<string>, DocumentEncoder, OnModuleInit
{
  private readonly logger = new Logger(TextEncoder.name);
  private client!: Ollama;
  private model!: string;
  private embedTimeoutMs = DEFAULT_EMBED_TIMEOUT_MS;

  readonly modalityName = 'text';
  readonly eventDriven = true;

  constructor(
    private readonly registry: ModalityRegistryService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const host = this.config.get<string>('ollama.host', 'http://localhost:11434');
    this.model = this.config.get<string>('ollama.embedModel', 'nomic-embed-text');
    this.embedTimeoutMs = this.config.get<number>(
      'ollama.embedTimeoutMs',
      DEFAULT_EMBED_TIMEOUT_MS,
    );
    this.client = new Ollama({ host });
    this.logger.log(
      `Ollama embed configured: ${host} / ${this.model} (timeout ${this.embedTimeoutMs}ms)`,
    );
    this.registry.register(this);
  }

  /**
   * Encode the per-turn live input as a nomic QUERY (`search_query:`).
   *
   * This is the ModalityEncoder contract method the fusion layer drives every
   * tick, and the per-turn input it carries is always the SEARCH side of
   * retrieval — never a stored document. The document side is produced by
   * {@link encodeDocument} on the write-back path.
   */
  async encode(text: string): Promise<number[]> {
    return this.embedWithPrefix(text, QUERY_PREFIX, 'query');
  }

  /**
   * Encode text as a nomic DOCUMENT (`search_document:`) for storage as a
   * learned latent-space pattern. Used by the write-back path so a stored
   * pattern lives in the document sub-space and is correctly retrievable by a
   * later `search_query:`-prefixed input.
   */
  async encodeDocument(text: string): Promise<number[]> {
    return this.embedWithPrefix(text, DOCUMENT_PREFIX, 'document');
  }

  /** Shared embed implementation: prepend the nomic task prefix, then embed. */
  private async embedWithPrefix(
    text: string,
    prefix: string,
    kind: 'query' | 'document',
  ): Promise<number[]> {
    this.logger.debug(`Encoding text as ${kind} (${text.length} chars)`);
    try {
      const response = await this.withTimeout(
        this.client.embed({ model: this.model, input: `${prefix}${text}` }),
        this.embedTimeoutMs,
      );
      return response.embeddings[0];
    } catch (err) {
      this.logger.warn(
        `Ollama embed failed/timed out, returning zero vector: ${(err as Error).message}`,
      );
      return new Array(EMBEDDING_DIM).fill(0);
    }
  }

  /**
   * Resolve with `p`, or reject once `ms` elapses — whichever is first. The
   * underlying embed promise is left to settle and be ignored on timeout; the
   * point is to unblock the awaiting caller, not to cancel the socket.
   */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`embed timed out after ${ms}ms`)),
        ms,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}
