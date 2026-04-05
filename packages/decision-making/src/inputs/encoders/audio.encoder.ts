import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, ModalityEncoder } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

/**
 * Raw audio chunk passed from the AudioGateway.
 * Contains the binary Opus/WebM data and metadata from the stream.
 */
export interface AudioChunk {
  /** Raw binary audio data (WebM/Opus encoded) */
  data: Buffer;
  /** MIME type reported by the client (e.g. 'audio/webm;codecs=opus') */
  mimeType: string;
  /** Chunk sequence number within this connection */
  chunkIndex: number;
  /** Size of the chunk in bytes */
  byteLength: number;
}

/**
 * Feature vector layout:
 *  [0]     chunk presence (always 1.0 when audio present — binary signal)
 *  [1]     normalized chunk size (byteLength / 8192, clamped to [0,1])
 *  [2]     byte-level energy proxy (mean byte value / 255)
 *  [3]     byte-level peak (max byte value / 255)
 *  [4]     byte-level variance (normalized)
 *  [5]     byte distribution entropy (normalized by log2(256))
 *  [6..13] byte histogram (8 bins across 0-255, normalized)
 *  [14]    zero-crossing rate proxy (fraction of adjacent bytes that cross 128)
 *  [15]    chunk index recency (1 / (1 + chunkIndex/100))
 */
const FEATURE_DIM = 16;
const AUDIO_PROJECTION_SEED = 0xa0d10;

/**
 * Encodes raw audio chunks from the browser's MediaRecorder (Opus/WebM)
 * into a d-dimensional embedding vector.
 *
 * Pipeline: extract statistical features from the raw encoded bytes →
 * linear projection to EMBEDDING_DIM via Xavier-initialized weight matrix.
 *
 * These features operate on the encoded bitstream, not decoded PCM.
 * They capture: presence, volume proxy, spectral shape proxy (via byte
 * distribution), and temporal position. This is sufficient for the fusion
 * layer to know audio is active and distinguish silence from speech.
 */
@Injectable()
export class AudioEncoder
  implements ModalityEncoder<AudioChunk>, OnModuleInit
{
  private readonly logger = new Logger(AudioEncoder.name);
  private W!: number[][];
  private b!: number[];

  readonly modalityName = 'audio';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {}

  onModuleInit() {
    this.W = xavierMatrix(EMBEDDING_DIM, FEATURE_DIM, AUDIO_PROJECTION_SEED);
    this.b = new Array(EMBEDDING_DIM).fill(0);
    this.logger.log(
      `Audio projection initialized: [${EMBEDDING_DIM}×${FEATURE_DIM}]`,
    );
    this.registry.register(this);
  }

  async encode(chunk: AudioChunk): Promise<number[]> {
    if (!chunk.data || chunk.data.length === 0) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    const features = this.extractFeatures(chunk);
    return linearProject(this.W, features, this.b);
  }

  private extractFeatures(chunk: AudioChunk): number[] {
    const features = new Array(FEATURE_DIM).fill(0);
    const bytes = chunk.data;
    const n = bytes.length;

    // [0] Presence signal
    features[0] = 1.0;

    // [1] Normalized chunk size
    features[1] = Math.min(n / 8192, 1.0);

    // Byte statistics
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      sum += bytes[i];
      if (bytes[i] > max) max = bytes[i];
    }
    const mean = sum / n;

    // [2] Energy proxy (mean byte value)
    features[2] = mean / 255;

    // [3] Peak
    features[3] = max / 255;

    // [4] Variance
    let varSum = 0;
    for (let i = 0; i < n; i++) {
      const diff = bytes[i] - mean;
      varSum += diff * diff;
    }
    // Normalize: max variance for bytes is ~(127.5)^2 ≈ 16256
    features[4] = Math.min((varSum / n) / 16256, 1.0);

    // [5] Byte distribution entropy
    const counts = new Array(256).fill(0);
    for (let i = 0; i < n; i++) {
      counts[bytes[i]]++;
    }
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (counts[i] > 0) {
        const p = counts[i] / n;
        entropy -= p * Math.log2(p);
      }
    }
    features[5] = entropy / 8; // max entropy = log2(256) = 8

    // [6..13] Byte histogram (8 bins)
    const bins = new Array(8).fill(0);
    for (let i = 0; i < n; i++) {
      bins[Math.min(bytes[i] >> 5, 7)]++;
    }
    for (let i = 0; i < 8; i++) {
      features[6 + i] = bins[i] / n;
    }

    // [14] Zero-crossing rate proxy (crossings past 128)
    let crossings = 0;
    for (let i = 1; i < n; i++) {
      if ((bytes[i - 1] < 128) !== (bytes[i] < 128)) crossings++;
    }
    features[14] = n > 1 ? crossings / (n - 1) : 0;

    // [15] Chunk index recency
    features[15] = 1 / (1 + chunk.chunkIndex / 100);

    return features;
  }
}
