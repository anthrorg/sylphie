/**
 * FaceSnapshotService.classifyAngle — P2.1 frame-dim plumbing.
 *
 * The pitch proxy (nose offset relative to the eye line) is normalized by the
 * frame height. This proves a head pose at the SAME FRACTION of the frame
 * classifies identically regardless of camera resolution (the real height is
 * passed in), AND that the default (480) reproduces the legacy classification.
 *
 * Only the bare collaborators are needed — classifyAngle is pure landmark math
 * and touches no DB. We construct the service with null Neo4j/Timescale and a
 * stub ConfigService (its constructor only reads PERCEPTION_HOST).
 */

import { FaceSnapshotService } from './face-snapshot.service';

function makeService(): FaceSnapshotService {
  const config = { get: (_k: string, d?: unknown) => d } as any;
  return new FaceSnapshotService(null, null, config);
}

/**
 * Build a landmark array sized for classifyAngle (needs indices up to 454).
 * - yaw is a dimensionless cheek-asymmetry ratio: symmetric cheeks → yaw 0.
 * - pitch = (noseY - eyeLineY) / frameH. We place the nose a fixed FRACTION of
 *   the frame height BELOW the eye line so pitch is constant across resolutions.
 *
 * pitchFrac > 0 → looking down (pitch > 0.08 classifies 'down').
 */
function landmarks(w: number, h: number, pitchFrac: number): number[][] {
  const arr: number[][] = new Array(455);
  for (let i = 0; i < 455; i++) arr[i] = [0, 0];

  const cx = w / 2;
  const eyeY = h / 2;
  const noseY = eyeY + pitchFrac * h;

  arr[1] = [cx, noseY]; // nose tip (symmetric in X → yaw 0)
  arr[234] = [cx - w * 0.1, eyeY]; // left cheek
  arr[454] = [cx + w * 0.1, eyeY]; // right cheek (symmetric → yaw 0)
  arr[159] = [cx - w * 0.05, eyeY]; // left eye
  arr[386] = [cx + w * 0.05, eyeY]; // right eye
  return arr;
}

describe('FaceSnapshotService.classifyAngle — P2.1 resolution invariance', () => {
  // pitchFrac 0.1 → pitch 0.1 > 0.08 → 'down' at any resolution.
  const PITCH_FRAC = 0.1;

  it('same pitch fraction → same angle regardless of resolution', () => {
    const svc = makeService();

    const a = svc.classifyAngle(landmarks(640, 480, PITCH_FRAC), 480);
    const b = svc.classifyAngle(landmarks(1280, 720, PITCH_FRAC), 720);

    expect(a).toBe('down');
    expect(b).toBe('down');
    expect(a).toBe(b);
  });

  it('ABSENT height arg → uses the legacy 480 default (byte-identical)', () => {
    const svc = makeService();

    // Landmarks laid out for a 640x480 frame; omitting the height arg must give
    // the SAME result as passing 480 explicitly.
    const lm = landmarks(640, 480, PITCH_FRAC);
    const withDefault = svc.classifyAngle(lm);
    const explicit = svc.classifyAngle(lm, 480);

    expect(withDefault).toBe(explicit);
    expect(withDefault).toBe('down');
  });

  it('frontal pose is stable across resolutions (small pitch fraction)', () => {
    const svc = makeService();

    // pitchFrac 0.0 → pitch 0 < 0.06 and yaw 0 < 0.15 → 'frontal'.
    const a = svc.classifyAngle(landmarks(640, 480, 0), 480);
    const b = svc.classifyAngle(landmarks(1920, 1080, 0), 1080);
    expect(a).toBe('frontal');
    expect(b).toBe('frontal');
  });
});
