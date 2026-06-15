/**
 * FaceEncoder — P2.1 frame-dim plumbing (resolution invariance).
 *
 * Proves the primary-face bbox features (slots 1..4 = cx, cy, w, h) normalize by
 * the REAL frame dims carried on the FaceDetection, so a frame-CENTER face maps
 * to ~0.5 regardless of camera resolution — AND that ABSENT dims reproduce the
 * legacy 640x480 behavior byte-identically.
 */

import { FaceEncoder } from './face.encoder';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import type { FaceDetection } from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

function makeEncoder(): FaceEncoder {
  const enc = new FaceEncoder(new ModalityRegistryService());
  enc.onModuleInit();
  return enc;
}

function features(enc: FaceEncoder, faces: FaceDetection[]): number[] {
  return (
    enc as unknown as { extractFeatures(f: FaceDetection[]): number[] }
  ).extractFeatures(faces);
}

/** A single face whose bbox is exactly centered in a w×h frame. */
function centerFace(w: number, h: number, withDims: boolean): FaceDetection {
  const bw = w / 5;
  const bh = h / 5;
  const cx = w / 2;
  const cy = h / 2;
  return {
    confidence: 0.9,
    bbox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
    landmarks: null,
    blendshapes: null,
    ...(withDims ? { frameWidth: w, frameHeight: h } : {}),
  };
}

describe('FaceEncoder — P2.1 resolution invariance', () => {
  const SLOT_CX = 1;
  const SLOT_CY = 2;
  const SLOT_W = 3;
  const SLOT_H = 4;

  it('center face → center ≈ 0.5 and width/height ≈ 0.2 regardless of resolution', () => {
    const enc = makeEncoder();

    const f640 = features(enc, [centerFace(640, 480, true)]);
    const f1280 = features(enc, [centerFace(1280, 720, true)]);

    for (const f of [f640, f1280]) {
      expect(f[SLOT_CX]).toBeCloseTo(0.5, 6);
      expect(f[SLOT_CY]).toBeCloseTo(0.5, 6);
      expect(f[SLOT_W]).toBeCloseTo(0.2, 6);
      expect(f[SLOT_H]).toBeCloseTo(0.2, 6);
    }
  });

  it('ABSENT dims → byte-identical to the legacy 640x480 default', () => {
    const enc = makeEncoder();

    const withDims = features(enc, [centerFace(640, 480, true)]);
    const absent = features(enc, [centerFace(640, 480, false)]);

    expect(absent).toEqual(withDims);
    expect(absent[SLOT_CX]).toBeCloseTo(0.5, 6);
    expect(absent[SLOT_CY]).toBeCloseTo(0.5, 6);
  });
});
