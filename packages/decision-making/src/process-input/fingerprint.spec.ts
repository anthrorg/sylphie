/**
 * Unit tests for ProcessInputService.generateFingerprint (P1 #3 + HR1).
 *
 * The fingerprint is the SHA-256 of a documented preimage:
 *   `${EMBEDDING_VERSION}::${category}::${quantized2dp(FULL fused vector)}::${dominantDrive}`
 *
 * Covers:
 *   1. version-in-preimage (HR1): the SAME fused vector under EMBEDDING_VERSION N
 *      vs N+1 → DIFFERENT fingerprints (referenced via the const, never literal 2)
 *   2. full-vector widening (#3): two vectors differing ONLY beyond index 64 →
 *      DIFFERENT fingerprints (these were the SAME under the old slice(0,64))
 *   3. 2dp-quantize still collapses near-identical vectors → SAME fingerprint
 *
 * `generateFingerprint` is private, so (2)/(3) are exercised through the public
 * `processInput` (which returns `contextFingerprint`). (1) is exercised via a
 * preimage reimplementation that is BOUND to the real code: it is asserted to
 * reproduce the real fingerprint at the current EMBEDDING_VERSION, then the only
 * variable changed is the version.
 */

import { createHash } from 'crypto';
import { ProcessInputService } from './process-input.service';
import {
  EMBEDDING_DIM,
  EMBEDDING_VERSION,
  DRIVE_INDEX_ORDER,
  type SensoryFrame,
  type DriveSnapshot,
  type DriveName,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): ProcessInputService {
  // All constructor deps are @Optional — pass null for a pure fingerprint test.
  return new ProcessInputService(null, null, null);
}

/** Minimal DriveSnapshot — generateFingerprint only reads `pressureVector`. */
function makeSnapshot(dominant: DriveName = DRIVE_INDEX_ORDER[0]): DriveSnapshot {
  const pressureVector: Record<string, number> = {};
  for (const d of DRIVE_INDEX_ORDER) pressureVector[d] = 0;
  pressureVector[dominant] = 1; // make `dominant` the highest-pressure drive
  return { pressureVector } as unknown as DriveSnapshot;
}

/** A frame whose fused vector is `fused`, with no text/scene raw (UNKNOWN cat). */
function makeFrame(fused: number[]): SensoryFrame {
  return {
    timestamp: 1,
    fused_embedding: fused,
    modality_embeddings: {},
    active_modalities: [],
    raw: {},
  };
}

function zeros(): number[] {
  return new Array(EMBEDDING_DIM).fill(0);
}

/**
 * Preimage reimplementation BOUND to the real code (asserted below). `version`
 * is the only knob, so a cross-version test changes nothing else.
 */
function fingerprintPreimage(
  version: number,
  category: string,
  fused: number[],
  dominantDrive: string,
): string {
  const quantized = fused.map((v) => Math.round(v * 100) / 100);
  const preimage = `${version}::${category}::${quantized.join(',')}::${dominantDrive}`;
  return createHash('sha256').update(preimage).digest('hex');
}

async function fingerprintOf(svc: ProcessInputService, frame: SensoryFrame): Promise<string> {
  const result = await svc.processInput(frame, makeSnapshot());
  return result.contextFingerprint;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessInputService.generateFingerprint (P1 #3 + HR1)', () => {
  it('binds the preimage reimplementation to the real code at EMBEDDING_VERSION', async () => {
    const svc = makeService();
    const fused = zeros();
    fused[10] = 0.42;
    const real = await fingerprintOf(svc, makeFrame(fused));
    // An empty-modality frame categorizes UNKNOWN; dominant drive is the first
    // in DRIVE_INDEX_ORDER (we set it to 1 above).
    const expected = fingerprintPreimage(
      EMBEDDING_VERSION,
      'UNKNOWN',
      fused,
      DRIVE_INDEX_ORDER[0],
    );
    expect(real).toBe(expected);
  });

  it('HR1: same fused vector under EMBEDDING_VERSION N vs N+1 → DIFFERENT fingerprints', () => {
    const fused = zeros();
    fused[5] = 0.9;
    const vN = fingerprintPreimage(EMBEDDING_VERSION, 'UNKNOWN', fused, DRIVE_INDEX_ORDER[0]);
    const vNplus1 = fingerprintPreimage(EMBEDDING_VERSION + 1, 'UNKNOWN', fused, DRIVE_INDEX_ORDER[0]);
    expect(vN).not.toBe(vNplus1);
  });

  it('#3 widening: two vectors differing ONLY beyond index 64 → DIFFERENT fingerprints', async () => {
    const svc = makeService();
    const a = zeros();
    const b = zeros();
    // Identical in [0,64); differ at index 200 — under the OLD slice(0,64) these
    // produced the SAME fingerprint (the visual-collision bug). Full-vector hash
    // now distinguishes them.
    b[200] = 0.77;
    const fa = await fingerprintOf(svc, makeFrame(a));
    const fb = await fingerprintOf(svc, makeFrame(b));
    expect(fa).not.toBe(fb);
  });

  it('2dp-quantize still collapses near-identical vectors → SAME fingerprint', async () => {
    const svc = makeService();
    const a = zeros();
    const b = zeros();
    a[30] = 0.501;
    b[30] = 0.5008; // both round to 0.50 at 2dp
    a[400] = 0.123;
    b[400] = 0.1234; // both round to 0.12
    const fa = await fingerprintOf(svc, makeFrame(a));
    const fb = await fingerprintOf(svc, makeFrame(b));
    expect(fa).toBe(fb);
  });
});
