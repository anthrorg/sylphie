import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, VideoDetection, ModalityEncoder } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

/**
 * Top COCO classes we track in the class histogram.
 * Order matters — each gets a fixed slot in the feature vector.
 */
const CLASS_VOCABULARY = [
  'person', 'car', 'chair', 'book', 'bottle',
  'cup', 'laptop', 'cell phone', 'tv', 'cat',
  'dog', 'bed', 'couch', 'dining table', 'potted plant',
  'backpack', 'handbag', 'keyboard', 'mouse', 'remote',
] as const;

const CLASS_INDEX: Map<string, number> = new Map(
  CLASS_VOCABULARY.map((c, i) => [c, i]),
);

/**
 * Feature vector layout:
 *  [0..19]  class histogram (20 slots, normalized by detection count)
 *  [20]     detection count (clamped to [0,1] via count/20)
 *  [21]     mean bbox center X (normalized 0-1, assumes 640px frame)
 *  [22]     mean bbox center Y (normalized 0-1, assumes 480px frame)
 *  [23]     mean bbox area (normalized 0-1, fraction of frame area)
 *  [24]     mean confidence
 *  [25]     max confidence
 */
const FEATURE_DIM = 26;
const VIDEO_PROJECTION_SEED = 0xa1de0;
const FRAME_W = 640;
const FRAME_H = 480;

/**
 * Encodes structured video detections from the Python sidecar (OpenCV + YOLO)
 * into a d-dimensional embedding vector.
 *
 * Pipeline: extract hand-crafted features from detections → linear projection
 * to EMBEDDING_DIM via Xavier-initialized weight matrix.
 *
 * Returns a zero vector when no detections are present.
 */
@Injectable()
export class VideoEncoder
  implements ModalityEncoder<VideoDetection[]>, OnModuleInit
{
  private readonly logger = new Logger(VideoEncoder.name);
  private W!: number[][];
  private b!: number[];

  readonly modalityName = 'video';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {}

  onModuleInit() {
    this.W = xavierMatrix(EMBEDDING_DIM, FEATURE_DIM, VIDEO_PROJECTION_SEED);
    this.b = new Array(EMBEDDING_DIM).fill(0);
    this.logger.log(
      `Video projection initialized: [${EMBEDDING_DIM}×${FEATURE_DIM}]`,
    );
    this.registry.register(this);
  }

  async encode(detections: VideoDetection[]): Promise<number[]> {
    this.logger.debug(`Encoding video (${detections.length} detections)`);

    if (detections.length === 0) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    const features = this.extractFeatures(detections);
    return linearProject(this.W, features, this.b);
  }

  private extractFeatures(detections: VideoDetection[]): number[] {
    const features = new Array(FEATURE_DIM).fill(0);
    const n = detections.length;

    // Class histogram (slots 0-19)
    for (const det of detections) {
      const idx = CLASS_INDEX.get(det.class);
      if (idx !== undefined) {
        features[idx] += 1 / n; // normalized by detection count
      }
    }

    // Detection count (slot 20), clamped to [0, 1]
    features[20] = Math.min(n / 20, 1);

    // Spatial features (slots 21-23)
    let sumCx = 0;
    let sumCy = 0;
    let sumArea = 0;
    const frameArea = FRAME_W * FRAME_H;

    for (const det of detections) {
      const [x1, y1, x2, y2] = det.bbox;
      sumCx += (x1 + x2) / 2 / FRAME_W;
      sumCy += (y1 + y2) / 2 / FRAME_H;
      sumArea += ((x2 - x1) * (y2 - y1)) / frameArea;
    }

    features[21] = sumCx / n; // mean center X [0, 1]
    features[22] = sumCy / n; // mean center Y [0, 1]
    features[23] = sumArea / n; // mean area fraction [0, 1]

    // Confidence stats (slots 24-25)
    let sumConf = 0;
    let maxConf = 0;
    for (const det of detections) {
      sumConf += det.confidence;
      if (det.confidence > maxConf) maxConf = det.confidence;
    }
    features[24] = sumConf / n; // mean confidence
    features[25] = maxConf; // max confidence

    return features;
  }
}
