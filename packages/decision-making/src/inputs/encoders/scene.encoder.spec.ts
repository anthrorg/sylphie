/**
 * SceneEncoder — P2.1 frame-dim plumbing (resolution invariance).
 *
 * Proves the primary-person bbox features (slots 22..25 = cx, cy, w, h) and the
 * quadrant assignment normalize by the REAL frame dims carried on the
 * SceneSnapshot, so a frame-CENTER person maps to ~0.5 regardless of camera
 * resolution — AND that ABSENT dims reproduce the legacy 640x480 behavior
 * byte-identically.
 */

import { SceneEncoder } from './scene.encoder';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import type {
  SceneSnapshot,
  TrackedObjectDTO,
  SceneSummary,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

function makeEncoder(): SceneEncoder {
  const enc = new SceneEncoder(new ModalityRegistryService());
  enc.onModuleInit();
  return enc;
}

function features(
  enc: SceneEncoder,
  snap: SceneSnapshot,
  confirmed: TrackedObjectDTO[],
): number[] {
  return (
    enc as unknown as {
      extractFeatures(s: SceneSnapshot, c: TrackedObjectDTO[]): number[];
    }
  ).extractFeatures(snap, confirmed);
}

function makeTrack(overrides: Partial<TrackedObjectDTO> = {}): TrackedObjectDTO {
  return {
    trackId: 1,
    state: 'confirmed',
    label: 'person',
    confidence: 0.9,
    bbox: [0, 0, 10, 10],
    framesSeen: 5,
    framesLost: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    embedding: null,
    ...overrides,
  };
}

/** Snapshot with one centered person; dims optional. */
function centeredPersonSnapshot(
  w: number,
  h: number,
  withDims: boolean,
): { snap: SceneSnapshot; confirmed: TrackedObjectDTO[] } {
  const bw = w / 4;
  const bh = h / 4;
  const cx = w / 2;
  const cy = h / 2;
  const person = makeTrack({
    bbox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
  });
  const summary: SceneSummary = {
    totalTracks: 1,
    confirmedCount: 1,
    lostCount: 0,
    newCount: 0,
    frameSequence: 1,
  };
  const snap: SceneSnapshot = {
    timestamp: 1,
    frameSequence: 1,
    objects: [person],
    events: [],
    summary,
    ...(withDims ? { frameWidth: w, frameHeight: h } : {}),
  };
  return { snap, confirmed: [person] };
}

describe('SceneEncoder — P2.1 resolution invariance', () => {
  const SLOT_PCX = 22;
  const SLOT_PCY = 23;
  const SLOT_PW = 24;
  const SLOT_PH = 25;

  it('center person → center ≈ 0.5 and width/height ≈ 0.25 regardless of resolution', () => {
    const enc = makeEncoder();

    const a = centeredPersonSnapshot(640, 480, true);
    const b = centeredPersonSnapshot(1280, 720, true);
    const fa = features(enc, a.snap, a.confirmed);
    const fb = features(enc, b.snap, b.confirmed);

    for (const f of [fa, fb]) {
      expect(f[SLOT_PCX]).toBeCloseTo(0.5, 6);
      expect(f[SLOT_PCY]).toBeCloseTo(0.5, 6);
      expect(f[SLOT_PW]).toBeCloseTo(0.25, 6);
      expect(f[SLOT_PH]).toBeCloseTo(0.25, 6);
    }
  });

  it('ABSENT dims → byte-identical to the legacy 640x480 default', () => {
    const enc = makeEncoder();

    const withDims = centeredPersonSnapshot(640, 480, true);
    const absent = centeredPersonSnapshot(640, 480, false);
    const fWith = features(enc, withDims.snap, withDims.confirmed);
    const fAbsent = features(enc, absent.snap, absent.confirmed);

    expect(fAbsent).toEqual(fWith);
    expect(fAbsent[SLOT_PCX]).toBeCloseTo(0.5, 6);
    expect(fAbsent[SLOT_PCY]).toBeCloseTo(0.5, 6);
  });
});
