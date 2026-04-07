import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EMBEDDING_DIM, FaceDetection, ModalityEncoder } from '@sylphie/shared';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { xavierMatrix, linearProject } from '../linear-algebra';

// ---------------------------------------------------------------------------
// Blendshape groupings (MediaPipe face landmarker output names)
// ---------------------------------------------------------------------------

/** Jaw-related blendshapes */
const JAW_SHAPES = ['jawOpen', 'jawForward', 'jawLeft', 'jawRight'] as const;

/** Brow-related blendshapes */
const BROW_SHAPES = [
  'browDownLeft', 'browDownRight',
  'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
] as const;

/** Eye-related blendshapes */
const EYE_SHAPES = [
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
] as const;

/** Mouth-related blendshapes */
const MOUTH_SHAPES = [
  'mouthClose', 'mouthFunnel', 'mouthPucker',
  'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper',
  'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
] as const;

/** Cheek-related blendshapes */
const CHEEK_SHAPES = ['cheekPuff', 'cheekSquintLeft', 'cheekSquintRight'] as const;

/** Nose-related blendshapes */
const NOSE_SHAPES = ['noseSneerLeft', 'noseSneerRight'] as const;

const BLENDSHAPE_GROUPS = [
  JAW_SHAPES, BROW_SHAPES, EYE_SHAPES,
  MOUTH_SHAPES, CHEEK_SHAPES, NOSE_SHAPES,
] as const;

// ---------------------------------------------------------------------------
// Feature vector layout
// ---------------------------------------------------------------------------

/**
 * Feature vector layout (20 dimensions):
 *  [0]      face count (clamped to [0,1] via count/5)
 *  [1]      primary face bbox center X (normalized 0-1)
 *  [2]      primary face bbox center Y (normalized 0-1)
 *  [3]      primary face bbox width (normalized 0-1)
 *  [4]      primary face bbox height (normalized 0-1)
 *  [5]      primary face confidence
 *  [6..11]  blendshape group means (jaw, brows, eyes, mouth, cheeks, nose)
 *  [12]     landmark mean X (normalized 0-1)
 *  [13]     landmark mean Y (normalized 0-1)
 *  [14]     landmark X spread (std dev, normalized)
 *  [15]     landmark Y spread (std dev, normalized)
 *  [16]     head yaw proxy (left-right asymmetry from landmarks)
 *  [17]     head pitch proxy (vertical center offset)
 *  [18]     head roll proxy (eye-level tilt)
 *  [19]     expression intensity (mean of all blendshape values)
 */
const FEATURE_DIM = 20;
const FACE_PROJECTION_SEED = 0xface0;
const FRAME_W = 640;
const FRAME_H = 480;

@Injectable()
export class FaceEncoder
  implements ModalityEncoder<FaceDetection[]>, OnModuleInit
{
  private readonly logger = new Logger(FaceEncoder.name);
  private W!: number[][];
  private b!: number[];

  readonly modalityName = 'faces';
  readonly eventDriven = false;

  constructor(private readonly registry: ModalityRegistryService) {}

  onModuleInit() {
    this.W = xavierMatrix(EMBEDDING_DIM, FEATURE_DIM, FACE_PROJECTION_SEED);
    this.b = new Array(EMBEDDING_DIM).fill(0);
    this.logger.log(
      `Face projection initialized: [${EMBEDDING_DIM}×${FEATURE_DIM}]`,
    );
    this.registry.register(this);
  }

  async encode(faces: FaceDetection[]): Promise<number[]> {
    this.logger.debug(`Encoding faces (${faces.length} detections)`);

    if (faces.length === 0) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    const features = this.extractFeatures(faces);
    return linearProject(this.W, features, this.b);
  }

  private extractFeatures(faces: FaceDetection[]): number[] {
    const features = new Array(FEATURE_DIM).fill(0);

    // [0] Face count
    features[0] = Math.min(faces.length / 5, 1);

    // Use the highest-confidence face as primary
    const primary = faces.reduce((best, f) =>
      f.confidence > best.confidence ? f : best,
    );

    // [1-4] Primary face bounding box
    const [x1, y1, x2, y2] = primary.bbox;
    features[1] = ((x1 + x2) / 2) / FRAME_W; // center X
    features[2] = ((y1 + y2) / 2) / FRAME_H; // center Y
    features[3] = (x2 - x1) / FRAME_W;        // width
    features[4] = (y2 - y1) / FRAME_H;        // height

    // [5] Confidence
    features[5] = primary.confidence;

    // [6-11] Blendshape group means
    const bs: Record<string, number> | null | undefined = primary.blendshapes;
    if (bs) {
      for (let g = 0; g < BLENDSHAPE_GROUPS.length; g++) {
        const group = BLENDSHAPE_GROUPS[g];
        let sum = 0;
        let count = 0;
        for (const name of group) {
          if (bs[name] !== undefined) {
            sum += bs[name];
            count++;
          }
        }
        features[6 + g] = count > 0 ? sum / count : 0;
      }
    }

    // [12-15] Landmark geometry stats (2D pixel coords, normalized to frame)
    const landmarks = primary.landmarks;
    if (landmarks && landmarks.length > 0) {
      let sumX = 0, sumY = 0;
      const n = landmarks.length;

      for (const lm of landmarks) {
        sumX += (lm[0] ?? 0) / FRAME_W;
        sumY += (lm[1] ?? 0) / FRAME_H;
      }

      const meanX = sumX / n;
      const meanY = sumY / n;

      features[12] = meanX;
      features[13] = meanY;

      // Spread (standard deviation, normalized)
      let varX = 0, varY = 0;
      for (const lm of landmarks) {
        varX += ((lm[0] ?? 0) / FRAME_W - meanX) ** 2;
        varY += ((lm[1] ?? 0) / FRAME_H - meanY) ** 2;
      }

      features[14] = Math.sqrt(varX / n);
      features[15] = Math.sqrt(varY / n);

      // [16-18] Head pose proxies from landmarks
      // Yaw: asymmetry between left and right face halves
      // Landmarks 234 (left cheek) and 454 (right cheek) relative to 1 (nose tip)
      if (landmarks.length >= 455) {
        const noseTip = landmarks[1];
        const leftCheek = landmarks[234];
        const rightCheek = landmarks[454];
        if (noseTip && leftCheek && rightCheek) {
          const distLeft = Math.abs((noseTip[0] ?? 0) - (leftCheek[0] ?? 0));
          const distRight = Math.abs((noseTip[0] ?? 0) - (rightCheek[0] ?? 0));
          const totalDist = distLeft + distRight;
          features[16] = totalDist > 0
            ? (distRight - distLeft) / totalDist
            : 0;
        }

        // Pitch: vertical offset of nose relative to eye line
        const leftEye = landmarks[159];
        const rightEye = landmarks[386];
        if (noseTip && leftEye && rightEye) {
          const eyeLineY = ((leftEye[1] ?? 0) + (rightEye[1] ?? 0)) / 2;
          // Normalize by frame height; positive = looking down
          features[17] = ((noseTip[1] ?? 0) - eyeLineY) / FRAME_H;
        }

        // Roll: tilt of the eye line
        if (leftEye && rightEye) {
          const dx = (rightEye[0] ?? 0) - (leftEye[0] ?? 0);
          const dy = (rightEye[1] ?? 0) - (leftEye[1] ?? 0);
          features[18] = dx !== 0
            ? Math.max(-1, Math.min(1, Math.atan2(dy, dx) / (Math.PI / 4)))
            : 0;
        }
      }
    }

    // [19] Overall expression intensity (mean of all blendshape values)
    if (bs) {
      const bsValues = Object.values(bs);
      if (bsValues.length > 0) {
        let sum = 0;
        for (const v of bsValues) sum += v;
        features[19] = sum / bsValues.length;
      }
    }

    return features;
  }
}
