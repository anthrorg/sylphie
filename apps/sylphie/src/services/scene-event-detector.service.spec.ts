import {
  SceneEventType,
  type TrackedObjectDTO,
  type FaceDetection,
  type SceneSummary,
} from '@sylphie/shared';
import { SceneEventDetectorService } from './scene-event-detector.service';
import type { FaceSnapshotService } from './face-snapshot.service';

/**
 * Pure-diff unit tests for SceneEventDetectorService.
 *
 * The detector is a stateful frame-to-frame differ: it keeps the previous
 * frame's confirmed tracks in memory and emits semantic events on the
 * transitions. These tests exercise that diff logic with plain-object inputs
 * and zero I/O. Face identification is stubbed to always return null so the
 * appearance/disappearance edges are tested in isolation.
 */
describe('SceneEventDetectorService (pure diff)', () => {
  let detector: SceneEventDetectorService;

  /** A FaceSnapshotService that never identifies anyone (keeps diff logic pure). */
  const faceSnapshotStub = {
    identifyFace: (_embedding: number[]): string | null => null,
  } as unknown as FaceSnapshotService;

  beforeEach(() => {
    detector = new SceneEventDetectorService(faceSnapshotStub);
  });

  // --- Builders ----------------------------------------------------------

  function makeSummary(frameSequence = 0): SceneSummary {
    return {
      totalTracks: 0,
      confirmedCount: 0,
      lostCount: 0,
      newCount: 0,
      frameSequence,
    };
  }

  function makeObject(
    overrides: Partial<TrackedObjectDTO> & { trackId: number },
  ): TrackedObjectDTO {
    return {
      state: 'confirmed',
      label: 'cup',
      confidence: 0.9,
      bbox: [10, 10, 50, 50],
      framesSeen: 5,
      framesLost: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      embedding: null,
      ...overrides,
    };
  }

  /** No faces in any of these pure-object scenes. */
  const NO_FACES: FaceDetection[] = [];

  // --- OBJECT_APPEARED ---------------------------------------------------

  it('emits OBJECT_APPEARED for a new confirmed non-person object', () => {
    const cup = makeObject({ trackId: 1, label: 'cup' });

    const snap = detector.detectEvents([cup], NO_FACES, makeSummary(1));

    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].type).toBe(SceneEventType.OBJECT_APPEARED);
    expect(snap.events[0].trackId).toBe(1);
    expect(snap.events[0].label).toBe('cup');
  });

  // --- OBJECT_DISAPPEARED ------------------------------------------------

  it('emits OBJECT_DISAPPEARED when an object present in frame N is gone in frame N+1', () => {
    const cup = makeObject({ trackId: 1, label: 'cup' });

    // Frame N: cup appears (consume the APPEARED event).
    detector.detectEvents([cup], NO_FACES, makeSummary(1));

    // Frame N+1: cup is gone.
    const snap = detector.detectEvents([], NO_FACES, makeSummary(2));

    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].type).toBe(SceneEventType.OBJECT_DISAPPEARED);
    expect(snap.events[0].trackId).toBe(1);
    expect(snap.events[0].label).toBe('cup');
  });

  // --- PERSON_ARRIVED ----------------------------------------------------

  it('emits PERSON_ARRIVED for a newly confirmed person track', () => {
    // Person path requires a truthy embedding to enter the person branch.
    const person = makeObject({
      trackId: 7,
      label: 'person',
      embedding: [0.1, 0.2, 0.3],
    });

    const snap = detector.detectEvents([person], NO_FACES, makeSummary(1));

    // identifyFace stub returns null, so no FACE_IDENTIFIED — just the arrival.
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].type).toBe(SceneEventType.PERSON_ARRIVED);
    expect(snap.events[0].trackId).toBe(7);
    expect(snap.events[0].label).toBe('person');
  });

  // --- PERSON_LEFT -------------------------------------------------------

  it('emits PERSON_LEFT when a confirmed person leaves the scene', () => {
    const person = makeObject({
      trackId: 7,
      label: 'person',
      embedding: [0.1, 0.2, 0.3],
    });

    // Frame N: person arrives.
    detector.detectEvents([person], NO_FACES, makeSummary(1));

    // Frame N+1: person gone.
    const snap = detector.detectEvents([], NO_FACES, makeSummary(2));

    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].type).toBe(SceneEventType.PERSON_LEFT);
    expect(snap.events[0].trackId).toBe(7);
    expect(snap.events[0].label).toBe('person');
  });

  // --- NO EVENTS ON IDENTICAL SCENES -------------------------------------

  it('emits NO events for two identical consecutive scenes', () => {
    const cup = makeObject({ trackId: 1, label: 'cup' });
    const person = makeObject({
      trackId: 7,
      label: 'person',
      embedding: [0.1, 0.2, 0.3],
    });

    // Frame N: both confirmed for the first time (events expected, ignored here).
    const first = detector.detectEvents(
      [cup, person],
      NO_FACES,
      makeSummary(1),
    );
    expect(first.events.length).toBeGreaterThan(0);

    // Frame N+1: identical set of confirmed tracks — pure no-op diff.
    const second = detector.detectEvents(
      [cup, person],
      NO_FACES,
      makeSummary(2),
    );

    expect(second.events).toHaveLength(0);
  });

  // --- Tentative tracks are not "present" --------------------------------

  it('ignores tentative (non-confirmed) tracks when diffing', () => {
    const tentative = makeObject({
      trackId: 2,
      label: 'cup',
      state: 'tentative',
    });

    const snap = detector.detectEvents([tentative], NO_FACES, makeSummary(1));

    expect(snap.events).toHaveLength(0);
    // The non-confirmed object is still echoed back in the raw objects list.
    expect(snap.objects).toHaveLength(1);
  });

  // --- Snapshot shape -----------------------------------------------------

  it('carries frameSequence and summary through to the snapshot', () => {
    const summary = makeSummary(42);
    const snap = detector.detectEvents([], NO_FACES, summary);

    expect(snap.frameSequence).toBe(42);
    expect(snap.summary).toBe(summary);
    expect(snap.objects).toEqual([]);
    expect(typeof snap.timestamp).toBe('number');
  });
});
