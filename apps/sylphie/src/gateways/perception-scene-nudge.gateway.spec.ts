/**
 * TK-22 (P4.3) — the scene-change CYCLE TRIGGER cooldown seam (AC2).
 *
 * PerceptionGateway.handleFrame fires a cognitive-cycle nudge
 * (tickSampler.nudgeSceneChange) on a confirmed-object scene change, but ONLY
 * once per SCENE_CYCLE_COOLDOWN_MS (5000) window — the dedup at
 * perception.gateway.ts:323. This spec proves the TRIGGER-vs-SIGNAL split:
 *
 *   - Two scene changes WITHIN the cooldown window fire the cycle TRIGGER
 *     (nudgeSceneChange) exactly ONCE — the second is suppressed.
 *   - A scene change AFTER the window elapses fires the TRIGGER again.
 *   - The SIGNAL side (the scene SNAPSHOT itself, which carries the surprise the
 *     drive engine consumes via routeScenePredictionErrors) is fed on EVERY
 *     processed frame regardless of the trigger cooldown — i.e. updateScene runs
 *     each frame even when the nudge is suppressed. (The drive-signal emit path
 *     itself is owned by scene-prediction-drive-signal.spec.ts.)
 *
 * AD-0004: no new IPC, no new field — asserts against the existing nudge dedup.
 *
 * Time is controlled by stubbing Date.now() so the MIN_FRAME_INTERVAL_MS frame
 * guard and the SCENE_CYCLE_COOLDOWN_MS dedup can be exercised deterministically.
 */

import { SceneEventType } from '@sylphie/shared';
import { PerceptionGateway } from './perception.gateway';
import { SceneEventDetectorService } from '../services/scene-event-detector.service';

const SCENE_CYCLE_COOLDOWN_MS = 5_000;

function makeConfig(): any {
  return { get: (_k: string, d?: unknown) => d };
}

/** Capture-only TickSampler double — records nudge + scene-slot writes. */
class FakeTickSampler {
  public scene: any = undefined;
  updateVideoDetections = jest.fn();
  updateFaces = jest.fn();
  updateScene = jest.fn((snap: any) => {
    this.scene = snap;
  });
  updateVisualEmbedding = jest.fn();
  updateSceneDescription = jest.fn();
  updateUndiscoveredCount = jest.fn();
  updateUnknownPersonCount = jest.fn();
  updateUndiscoveredIds = jest.fn();
  updateUnknownPersonIds = jest.fn();
  nudgeSceneChange = jest.fn();
}

function makeFaceSnapshot(): any {
  return { identifyFace: () => null, processFaceFrame: async () => {} };
}

function makeVwm(): any {
  return {
    updateScene: jest.fn(),
    getSceneDescription: () => '',
    getUndiscoveredEntities: () => [],
    getUnknownPersons: () => [],
    getVisibleEntities: () => [],
  };
}

function makePersonModel(): any {
  return { getActivePersonId: () => null };
}

/**
 * A /detect payload with a confirmed track at the given id/bbox. A track that
 * APPEARS (new id) produces an OBJECT_APPEARED event → hasSceneChange true,
 * which is the trigger condition the cooldown guards.
 */
function detectPayload(trackId: number, bbox: [number, number, number, number]) {
  return {
    detections: [],
    faces: [],
    tracked_objects: [
      {
        track_id: trackId,
        state: 'confirmed',
        label: 'cup',
        confidence: 0.92,
        bbox,
        frames_seen: 6,
        frames_lost: 0,
        first_seen_at: null,
        last_seen_at: null,
        embedding: null,
        synthetic: false,
      },
    ],
    scene_summary: {
      total_tracks: 1,
      confirmed_count: 1,
      lost_count: 0,
      new_count: 1,
      frame_sequence: trackId,
    },
  };
}

function buildGateway() {
  const tickSampler = new FakeTickSampler();
  const sceneEventDetector = new SceneEventDetectorService(makeFaceSnapshot());
  const gateway = new PerceptionGateway(
    makeConfig(),
    tickSampler as any,
    makePersonModel(),
    makeFaceSnapshot(),
    sceneEventDetector as any,
    makeVwm(),
  );
  return { gateway, tickSampler };
}

function fakeClient() {
  return { readyState: 1, send: jest.fn(), on: jest.fn() } as any;
}

/** Drive one frame whose /detect response is `payload`, at wall-clock `nowMs`. */
async function frameAt(
  gateway: PerceptionGateway,
  nowMs: number,
  payload: unknown,
): Promise<void> {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload })) as any;
  try {
    await (gateway as any).handleFrame(fakeClient(), Buffer.from([0xff, 0xd8, 0xff]));
  } finally {
    spy.mockRestore();
  }
}

describe('PerceptionGateway — scene-change cycle TRIGGER cooldown (TK-22 AC2)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('suppresses the cycle TRIGGER for a second scene change within SCENE_CYCLE_COOLDOWN_MS', async () => {
    const { gateway, tickSampler } = buildGateway();

    // Frame 1 @ t=10000: a new confirmed track → OBJECT_APPEARED → trigger fires.
    await frameAt(gateway, 10_000, detectPayload(1, [10, 10, 50, 50]));

    // Frame 2 @ t=12000 (2s later, WITHIN the 5s window): a different new track →
    // OBJECT_APPEARED again, but the cooldown suppresses the SECOND trigger.
    await frameAt(gateway, 12_000, detectPayload(2, [200, 200, 240, 240]));

    expect(tickSampler.nudgeSceneChange).toHaveBeenCalledTimes(1);
  });

  it('fires the cycle TRIGGER again once the cooldown window has elapsed', async () => {
    const { gateway, tickSampler } = buildGateway();

    await frameAt(gateway, 10_000, detectPayload(1, [10, 10, 50, 50]));
    // Just past the window (>= 5000ms after the last nudge).
    await frameAt(gateway, 10_000 + SCENE_CYCLE_COOLDOWN_MS, detectPayload(2, [200, 200, 240, 240]));

    expect(tickSampler.nudgeSceneChange).toHaveBeenCalledTimes(2);
  });

  it('still feeds the scene SNAPSHOT (the SIGNAL source) on the trigger-suppressed frame', async () => {
    const { gateway, tickSampler } = buildGateway();

    await frameAt(gateway, 10_000, detectPayload(1, [10, 10, 50, 50]));
    expect(tickSampler.updateScene).toHaveBeenCalledTimes(1);

    // Second frame inside the window: trigger suppressed, but updateScene STILL
    // runs — the surprise the drive engine consumes is independent of the nudge.
    await frameAt(gateway, 12_000, detectPayload(2, [200, 200, 240, 240]));
    expect(tickSampler.nudgeSceneChange).toHaveBeenCalledTimes(1);
    expect(tickSampler.updateScene).toHaveBeenCalledTimes(2);

    // Sanity: the suppressed frame really did carry a scene change (so the
    // suppression — not a missing event — is what stopped the second trigger).
    const lastSnap = tickSampler.scene;
    expect(
      lastSnap.events.some((e: any) => e.type === SceneEventType.OBJECT_APPEARED),
    ).toBe(true);
  });

  it('resetCooldown() lets the very next scene change re-fire the trigger inside the window', async () => {
    const { gateway, tickSampler } = buildGateway();

    await frameAt(gateway, 10_000, detectPayload(1, [10, 10, 50, 50]));
    expect(tickSampler.nudgeSceneChange).toHaveBeenCalledTimes(1);

    // Without reset, a frame at t=11000 would be suppressed (see test above).
    gateway.resetCooldown();
    await frameAt(gateway, 11_000, detectPayload(2, [200, 200, 240, 240]));

    expect(tickSampler.nudgeSceneChange).toHaveBeenCalledTimes(2);
  });
});
