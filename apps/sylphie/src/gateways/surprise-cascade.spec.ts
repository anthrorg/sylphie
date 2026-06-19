/**
 * TK-23 (P4.4) — surprise-cascade property (cooldown leg): N distinct salient
 * changes cannot enqueue an unbounded number of SYSTEM_TRIGGER cycles. The
 * gateway dedups scene-change nudges against SCENE_CYCLE_COOLDOWN_MS
 * (perception.gateway.ts:322-326), so a burst of appear/disappear events fires at
 * most one cognitive cycle per cooldown window.
 *
 * INVARIANT under test (AC2): given N=10 distinct salient changes within
 * SCENE_CYCLE_COOLDOWN_MS*10 ms, the number of `nudgeSceneChange()` calls (the
 * SYSTEM_TRIGGER enqueue) is at most ceil(elapsed / SCENE_CYCLE_COOLDOWN_MS).
 *
 * Each frame introduces a DISTINCT new track (fresh trackId), so the real
 * SceneEventDetectorService produces a genuine OBJECT_APPEARED (and an
 * OBJECT_DISAPPEARED for the previous track) — i.e. every frame is a true scene
 * change, the worst case for the cooldown. Time is driven deterministically via a
 * mocked Date.now so the elapsed window is exact.
 *
 * The clock is seeded at a BASE >= SCENE_CYCLE_COOLDOWN_MS so the FIRST frame
 * clears both the frame-rate gate (MIN_FRAME_INTERVAL_MS) and the scene-cycle
 * cooldown (`lastSceneCycleAt` starts at 0) — reproducing live wall-clock
 * semantics, where `Date.now()` is always far above the cooldown on the first
 * frame.
 *
 * The real SceneEventDetectorService is used; heavier collaborators are mocked,
 * mirroring perception.gateway.spec.ts.
 */

import { SceneEventType } from '@sylphie/shared';
import { PerceptionGateway } from './perception.gateway';
import { SceneEventDetectorService } from '../services/scene-event-detector.service';

/** MUST stay in lockstep with SCENE_CYCLE_COOLDOWN_MS in perception.gateway.ts. */
const SCENE_CYCLE_COOLDOWN_MS = 5_000;
/** MUST stay in lockstep with MIN_FRAME_INTERVAL_MS (1000 / MAX_FPS=15). */
const MIN_FRAME_INTERVAL_MS = 1000 / 15;

function makeConfig(): any {
  return { get: (_k: string, d?: unknown) => d };
}

/** Capture-only TickSampler double — counts the SYSTEM_TRIGGER nudges. */
class FakeTickSampler {
  updateVideoDetections = jest.fn();
  updateFaces = jest.fn();
  updateScene = jest.fn();
  updateVisualEmbedding = jest.fn();
  updateSceneDescription = jest.fn();
  updateUndiscoveredCount = jest.fn();
  updateUnknownPersonCount = jest.fn();
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
 * A /detect payload carrying ONE confirmed track with the given trackId/label.
 * A fresh trackId each frame = a distinct salient change (appear + the prior
 * track disappears).
 */
function detectPayloadWithTrack(trackId: number, label: string) {
  return {
    detections: [],
    faces: [],
    tracked_objects: [
      {
        track_id: trackId,
        state: 'confirmed',
        label,
        confidence: 0.95,
        bbox: [10, 10, 50, 50],
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

/**
 * Drive N distinct-track frames through handleFrame at evenly-spaced timestamps
 * starting at BASE, advancing the mocked Date.now by stepMs each frame. Returns
 * the recorded nudge / updateScene counts plus the elapsed span (first→last
 * timestamp).
 */
async function driveFrames(
  n: number,
  stepMs: number,
  idBase: number,
): Promise<{ nudges: number; scenes: number; elapsedMs: number }> {
  const BASE = SCENE_CYCLE_COOLDOWN_MS; // first frame clears rate-gate AND cooldown
  let frameIdx = 0;
  global.fetch = jest.fn(async () =>
    ({
      ok: true,
      json: async () => detectPayloadWithTrack(idBase + frameIdx, `obj-${frameIdx}`),
    }) as any,
  );

  const { gateway, tickSampler } = buildGateway();
  const client = fakeClient();

  let clock = 0;
  const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);

  for (frameIdx = 0; frameIdx < n; frameIdx++) {
    clock = BASE + frameIdx * stepMs;
    await (gateway as any).handleFrame(client, Buffer.from([0xff, 0xd8, 0xff]));
  }
  nowSpy.mockRestore();

  return {
    nudges: tickSampler.nudgeSceneChange.mock.calls.length,
    scenes: tickSampler.updateScene.mock.calls.length,
    elapsedMs: stepMs * (n - 1),
  };
}

describe('TK-23 surprise-cascade — N distinct changes are cooldown-bounded', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('N=10 distinct changes within SCENE_CYCLE_COOLDOWN_MS*10 ms → nudges <= ceil(window/cooldown)', async () => {
    const N = 10;
    const WINDOW_MS = SCENE_CYCLE_COOLDOWN_MS * 10; // AC2: the 50_000ms window
    // Spread the N frames evenly across the window, strictly INSIDE it (N frames
    // over N+1 slots so the last lands before the window edge). stepMs must clear
    // the frame-rate gate so no frame is dropped (which would mask the bound).
    const stepMs = Math.floor(WINDOW_MS / (N + 1)); // ~4545ms → all frames are real
    expect(stepMs).toBeGreaterThan(MIN_FRAME_INTERVAL_MS);
    expect(stepMs * (N - 1)).toBeLessThan(WINDOW_MS); // span fits in the window

    const { nudges, scenes } = await driveFrames(N, stepMs, 1000);

    // Every frame was a genuine scene change (the detector + tick path ran).
    expect(scenes).toBe(N);

    // AC2 bound: at most ceil(window / cooldown) SYSTEM_TRIGGER nudges.
    const expectedMax = Math.ceil(WINDOW_MS / SCENE_CYCLE_COOLDOWN_MS); // 10
    expect(nudges).toBeLessThanOrEqual(expectedMax);
    // Tighter: frames packed at < cooldown apart yield FEWER than N nudges — the
    // cooldown genuinely throttles (it is not a no-op pass-through of all 10).
    expect(nudges).toBeLessThan(N);
  });

  it('a BURST of N=10 changes within ONE cooldown window fires at most ONE nudge', async () => {
    const N = 10;
    // Pack all N frames inside a single SCENE_CYCLE_COOLDOWN_MS window → ceil = 1,
    // while keeping each step above the frame-rate gate so no frame is dropped.
    const stepMs = Math.floor(SCENE_CYCLE_COOLDOWN_MS / (N + 2)); // ~384ms
    expect(stepMs).toBeGreaterThan(MIN_FRAME_INTERVAL_MS);

    const { nudges, scenes, elapsedMs } = await driveFrames(N, stepMs, 2000);

    expect(scenes).toBe(N);
    const expectedMax = Math.ceil(elapsedMs / SCENE_CYCLE_COOLDOWN_MS);
    expect(expectedMax).toBe(1);
    // At most one — and exactly one: the cooldown throttles the burst, it does
    // not suppress the loop entirely (the first change DID nudge).
    expect(nudges).toBe(1);
  });

  it('each driven frame is a genuine scene change (OBJECT_APPEARED present)', async () => {
    global.fetch = jest.fn(async () =>
      ({ ok: true, json: async () => detectPayloadWithTrack(3001, 'single') }) as any,
    );
    const { gateway, tickSampler } = buildGateway();
    let clock = SCENE_CYCLE_COOLDOWN_MS;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);

    await (gateway as any).handleFrame(fakeClient(), Buffer.from([0xff, 0xd8, 0xff]));

    const snap = tickSampler.updateScene.mock.calls[0][0] as any;
    expect(snap.events.some((e: any) => e.type === SceneEventType.OBJECT_APPEARED)).toBe(true);
    // First-ever change always nudges (cooldown starts at 0, clock seeded above it).
    expect(tickSampler.nudgeSceneChange).toHaveBeenCalledTimes(1);
  });
});
