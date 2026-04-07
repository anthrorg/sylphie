import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, ModalityEncoder } from '@sylphie/shared';
import type { SceneSnapshot } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

/**
 * Same class vocabulary as VideoEncoder — kept in sync so class indices
 * have the same meaning across both encoders.
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
 * Feature vector layout (35 dimensions):
 *
 *  [0..19]  per-class count histogram (20 COCO classes)
 *  [20]     confirmed object count (normalized: count/20, clamped [0,1])
 *  [21]     person count (normalized: count/10, clamped [0,1])
 *  [22..25] primary person bbox (cx, cy, w, h — normalized 0-1)
 *  [26]     mean confidence across all confirmed objects
 *  [27]     scene stability (fraction of tracks persisting from events)
 *  [28]     new objects this frame (from events, normalized)
 *  [29]     lost objects this frame (from events, normalized)
 *  [30]     identified faces count (normalized: count/5, clamped [0,1])
 *  [31..34] quadrant density (TL, TR, BL, BR — fraction of objects per quadrant)
 */
const FEATURE_DIM = 35;
const SCENE_PROJECTION_SEED = 0x5ce0e;
const FRAME_W = 640;
const FRAME_H = 480;

/**
 * Encodes a SceneSnapshot (tracked objects + events) into a 768-dimensional
 * embedding vector. Unlike VideoEncoder which sees a flat bag of detections,
 * SceneEncoder has access to per-object tracking state, lifecycle events,
 * and face identification — enabling richer scene representation.
 */
@Injectable()
export class SceneEncoder
  implements ModalityEncoder<SceneSnapshot>, OnModuleInit
{
  private readonly logger = new Logger(SceneEncoder.name);
  private W!: number[][];
  private b!: number[];

  readonly modalityName = 'scene';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {}

  onModuleInit() {
    this.W = xavierMatrix(EMBEDDING_DIM, FEATURE_DIM, SCENE_PROJECTION_SEED);
    this.b = new Array(EMBEDDING_DIM).fill(0);
    this.logger.log(
      `Scene projection initialized: [${EMBEDDING_DIM}×${FEATURE_DIM}]`,
    );
    this.registry.register(this);
  }

  async encode(snapshot: SceneSnapshot): Promise<number[]> {
    const confirmed = snapshot.objects.filter(o => o.state === 'confirmed');
    this.logger.debug(
      `Encoding scene (${confirmed.length} confirmed, ${snapshot.events.length} events)`,
    );

    if (confirmed.length === 0) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    const features = this.extractFeatures(snapshot, confirmed);
    return linearProject(this.W, features, this.b);
  }

  private extractFeatures(
    snapshot: SceneSnapshot,
    confirmed: SceneSnapshot['objects'],
  ): number[] {
    const features = new Array(FEATURE_DIM).fill(0);
    const n = confirmed.length;

    // [0..19] Per-class count histogram
    for (const obj of confirmed) {
      const idx = CLASS_INDEX.get(obj.label);
      if (idx !== undefined) {
        features[idx] += 1 / n;
      }
    }

    // [20] Confirmed object count (normalized)
    features[20] = Math.min(n / 20, 1);

    // [21] Person count (normalized)
    const persons = confirmed.filter(o => o.label === 'person');
    features[21] = Math.min(persons.length / 10, 1);

    // [22..25] Primary person bbox (largest person by area)
    if (persons.length > 0) {
      let bestPerson = persons[0];
      let bestArea = 0;
      for (const p of persons) {
        const area = (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]);
        if (area > bestArea) {
          bestArea = area;
          bestPerson = p;
        }
      }
      const [x1, y1, x2, y2] = bestPerson.bbox;
      features[22] = (x1 + x2) / 2 / FRAME_W; // center X
      features[23] = (y1 + y2) / 2 / FRAME_H; // center Y
      features[24] = (x2 - x1) / FRAME_W;     // width
      features[25] = (y2 - y1) / FRAME_H;     // height
    }

    // [26] Mean confidence
    let sumConf = 0;
    for (const obj of confirmed) {
      sumConf += obj.confidence;
    }
    features[26] = sumConf / n;

    // [27] Scene stability (fraction of confirmed objects that persisted vs events)
    const appearedCount = snapshot.events.filter(
      e => e.type === 'object_appeared' || e.type === 'person_arrived',
    ).length;
    const disappearedCount = snapshot.events.filter(
      e => e.type === 'object_disappeared' || e.type === 'person_left',
    ).length;
    const changeCount = appearedCount + disappearedCount;
    features[27] = changeCount > 0 ? Math.max(0, 1 - changeCount / Math.max(n, 1)) : 1.0;

    // [28] New objects this frame (normalized)
    features[28] = Math.min(appearedCount / 5, 1);

    // [29] Lost objects this frame (normalized)
    features[29] = Math.min(disappearedCount / 5, 1);

    // [30] Identified faces count (normalized)
    const identifiedCount = confirmed.filter(o => o.personId).length;
    features[30] = Math.min(identifiedCount / 5, 1);

    // [31..34] Quadrant density (TL, TR, BL, BR)
    const quadrants = [0, 0, 0, 0]; // TL, TR, BL, BR
    const midX = FRAME_W / 2;
    const midY = FRAME_H / 2;
    for (const obj of confirmed) {
      const cx = (obj.bbox[0] + obj.bbox[2]) / 2;
      const cy = (obj.bbox[1] + obj.bbox[3]) / 2;
      const qIdx = (cx >= midX ? 1 : 0) + (cy >= midY ? 2 : 0);
      quadrants[qIdx]++;
    }
    for (let q = 0; q < 4; q++) {
      features[31 + q] = quadrants[q] / Math.max(n, 1);
    }

    return features;
  }
}
