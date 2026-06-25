/**
 * PerceptionGateway — embedding-flow contract (P1 #0, the BL.2 discard contract).
 *
 * BEFORE P1 #0 the per-CONFIRMED-track embedding (now 768-D DINOv2-base after
 * P3.1; was 1280-D EfficientNet) rode on
 * `tracked_objects[].embedding`, reached NestJS, flowed to VWM/SceneEventDetector
 * — but was STRUCTURALLY ABSENT from fusion: no `visual_embedding` modality
 * consumed it, so the richest visual signal was discarded at the cross-array
 * fusion boundary.
 *
 * AFTER P1 #0 the gateway feeds the SAME SceneSnapshot (whose `objects[]` carry
 * those embeddings) into the `visual_embedding` modality slot via
 * `tickSampler.updateVisualEmbedding(...)`. These assertions FLIP the old
 * "embedding is discarded / no visual_embedding modality" contract to assert the
 * new reality: the embedding now flows into a registered visual_embedding path.
 *
 * The real SceneEventDetectorService is used (its detectEvents preserves the
 * embedding on the snapshot objects); the heavier collaborators are mocked.
 */

import { SceneEventType } from '@sylphie/shared';
import type { TrackedObjectDTO } from '@sylphie/shared';
import { PerceptionGateway } from './perception.gateway';

// Real, dependency-light scene event detector so the snapshot is built honestly.
import { SceneEventDetectorService } from '../services/scene-event-detector.service';

function makeConfig(): any {
  return { get: (_k: string, d?: unknown) => d };
}

/** Capture-only TickSampler double — records the slots the gateway writes. */
class FakeTickSampler {
  public scene: any = undefined;
  public visualEmbedding: any = undefined;
  updateVideoDetections = jest.fn();
  updateFaces = jest.fn();
  updateScene = jest.fn((snap: any) => {
    this.scene = snap;
  });
  updateVisualEmbedding = jest.fn((snap: any) => {
    this.visualEmbedding = snap;
  });
  updateSceneDescription = jest.fn();
  updateUndiscoveredCount = jest.fn();
  updateUnknownPersonCount = jest.fn();
  updateUndiscoveredIds = jest.fn();
  updateUnknownPersonIds = jest.fn();
  nudgeSceneChange = jest.fn();
}

function makeFaceSnapshot(): any {
  return {
    identifyFace: () => null,
    processFaceFrame: async () => {},
  };
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

/** A sidecar /detect payload with a CONFIRMED track carrying a 768-D embedding (P3.1 DINOv2-base). */
function detectPayloadWithEmbedding(embedding: number[]) {
  return {
    detections: [],
    faces: [],
    tracked_objects: [
      {
        track_id: 1,
        state: 'confirmed',
        label: 'cup',
        confidence: 0.92,
        bbox: [10, 10, 50, 50],
        frames_seen: 6,
        frames_lost: 0,
        first_seen_at: null,
        last_seen_at: null,
        embedding,
        synthetic: false,
      },
    ],
    scene_summary: {
      total_tracks: 1,
      confirmed_count: 1,
      lost_count: 0,
      new_count: 1,
      frame_sequence: 1,
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

/** A fake WS client that swallows sends. */
function fakeClient() {
  return { readyState: 1, send: jest.fn(), on: jest.fn() } as any;
}

describe('PerceptionGateway — visual_embedding flow (P1 #0, BL.2 discard contract)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('NEW reality: the per-track embedding now FLOWS into the visual_embedding modality slot', async () => {
    const embedding = new Array(768).fill(0).map((_, i) => Math.sin(i * 0.01));
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => detectPayloadWithEmbedding(embedding),
    })) as any;

    const { gateway, tickSampler } = buildGateway();
    const client = fakeClient();

    // Drive a single frame through the private handler.
    await (gateway as any).handleFrame(client, Buffer.from([0xff, 0xd8, 0xff]));

    // FLIPPED CONTRACT (was: "no visual_embedding modality / embedding discarded")
    // — the gateway now feeds the visual_embedding slot exactly once.
    expect(tickSampler.updateVisualEmbedding).toHaveBeenCalledTimes(1);

    // And the snapshot it fed carries the embedding (the signal that used to be
    // structurally absent from fusion).
    const snap = tickSampler.visualEmbedding;
    expect(snap).toBeDefined();
    const confirmed = snap.objects.find(
      (o: TrackedObjectDTO) => o.state === 'confirmed',
    );
    expect(confirmed).toBeDefined();
    expect(Array.isArray(confirmed.embedding)).toBe(true);
    expect(confirmed.embedding).toHaveLength(768);
    expect(confirmed.embedding).toEqual(embedding);
  });

  it('feeds the SAME snapshot to both the scene and visual_embedding slots (single source)', async () => {
    const embedding = new Array(768).fill(0.05);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => detectPayloadWithEmbedding(embedding),
    })) as any;

    const { gateway, tickSampler } = buildGateway();
    await (gateway as any).handleFrame(fakeClient(), Buffer.from([0xff, 0xd8, 0xff]));

    expect(tickSampler.updateScene).toHaveBeenCalledTimes(1);
    expect(tickSampler.updateVisualEmbedding).toHaveBeenCalledTimes(1);
    // Same object reference — one snapshot drives both modalities this frame.
    expect(tickSampler.visualEmbedding).toBe(tickSampler.scene);
  });

  it('object_appeared event is produced for the confirmed track (sanity that the snapshot is real)', async () => {
    const embedding = new Array(768).fill(0.1);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => detectPayloadWithEmbedding(embedding),
    })) as any;

    const { gateway, tickSampler } = buildGateway();
    await (gateway as any).handleFrame(fakeClient(), Buffer.from([0xff, 0xd8, 0xff]));

    const snap = tickSampler.visualEmbedding;
    expect(snap.events.some((e: any) => e.type === SceneEventType.OBJECT_APPEARED)).toBe(true);
  });
});
