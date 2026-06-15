/**
 * VideoEncoder — P2.1 frame-dim plumbing (resolution invariance).
 *
 * Proves the spatial features (bbox center X/Y, area) normalize by the REAL
 * frame dims carried on each `VideoDetection`, so a frame-CENTER detection maps
 * to ~0.5 regardless of camera resolution — AND that when the dims are ABSENT
 * the result equals the legacy 640x480 behavior (byte-identical default).
 *
 * Asserts on the extracted feature vector (slots 21/22 = mean center X/Y,
 * slot 23 = mean area fraction) rather than the projected embedding, so the
 * resolution invariance is read at the exact point it's computed.
 */

import { VideoEncoder } from './video.encoder';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import type { VideoDetection } from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

function makeEncoder(): VideoEncoder {
  const enc = new VideoEncoder(new ModalityRegistryService());
  enc.onModuleInit();
  return enc;
}

/** Extract the raw feature vector (private method, accessed for white-box test). */
function features(enc: VideoEncoder, dets: VideoDetection[]): number[] {
  return (enc as unknown as { extractFeatures(d: VideoDetection[]): number[] })
    .extractFeatures(dets);
}

/** A single detection whose bbox is exactly centered in a w×h frame. */
function centerDetection(
  w: number,
  h: number,
  withDims: boolean,
): VideoDetection {
  // A 1/10-frame box centered at (w/2, h/2).
  const bw = w / 10;
  const bh = h / 10;
  const cx = w / 2;
  const cy = h / 2;
  return {
    class: 'cup',
    confidence: 0.9,
    bbox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
    ...(withDims ? { frameWidth: w, frameHeight: h } : {}),
  };
}

describe('VideoEncoder — P2.1 resolution invariance', () => {
  const SLOT_CX = 21;
  const SLOT_CY = 22;
  const SLOT_AREA = 23;

  it('center bbox → center ≈ 0.5 regardless of resolution (640x480 vs 1280x720)', () => {
    const enc = makeEncoder();

    const f640 = features(enc, [centerDetection(640, 480, true)]);
    const f1280 = features(enc, [centerDetection(1280, 720, true)]);

    expect(f640[SLOT_CX]).toBeCloseTo(0.5, 6);
    expect(f640[SLOT_CY]).toBeCloseTo(0.5, 6);
    expect(f1280[SLOT_CX]).toBeCloseTo(0.5, 6);
    expect(f1280[SLOT_CY]).toBeCloseTo(0.5, 6);

    // Area fraction is also resolution-invariant (1/10 × 1/10 = 0.01 of frame).
    expect(f640[SLOT_AREA]).toBeCloseTo(0.01, 6);
    expect(f1280[SLOT_AREA]).toBeCloseTo(0.01, 6);
  });

  it('ABSENT dims → byte-identical to the legacy 640x480 default', () => {
    const enc = makeEncoder();

    // A center-of-640x480 detection WITHOUT dims must equal the SAME detection
    // WITH explicit 640x480 dims (the absent path defaults to 640x480).
    const withDims = features(enc, [centerDetection(640, 480, true)]);
    const absent = features(enc, [centerDetection(640, 480, false)]);

    expect(absent).toEqual(withDims);
    expect(absent[SLOT_CX]).toBeCloseTo(0.5, 6);
    expect(absent[SLOT_CY]).toBeCloseTo(0.5, 6);
  });

  it('absent dims on a 1280x720-pixel bbox uses the 640x480 default (NOT the real size)', () => {
    const enc = makeEncoder();

    // A bbox centered for 1280x720 but with NO dims is normalized by 640x480,
    // so its center reads > 0.5 (this is the legacy-behavior preservation: we do
    // NOT guess the real size when absent — exactly the cassette contract).
    const absent = features(enc, [centerDetection(1280, 720, false)]);
    expect(absent[SLOT_CX]).toBeGreaterThan(0.9); // (1280/2)/640 = 1.0 centroid
  });
});
