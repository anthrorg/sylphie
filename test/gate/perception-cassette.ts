/**
 * perception-cassette.ts — HTTP cassette for the PERCEPTION sidecar boundary (WS5 T0).
 *
 * The LLM cassette (`cassette.ts`) intercepts the outbound Ollama HTTP boundary.
 * Perception is a SEPARATE external dependency on a SEPARATE port with a SEPARATE
 * content type (binary JPEG in / JSON out), so it gets its own cassette server —
 * they are NOT multiplexed (the binary-JPEG perception path and the JSON LLM path
 * would collide; T0.1).
 *
 * The backend's PerceptionGateway calls two endpoints on `PERCEPTION_HOST`:
 *   POST /perception/detect   — binary JPEG in → detection/tracking JSON out.
 *   POST /perception/caption  — binary JPEG in → { caption } JSON out (fire-and-forget).
 *
 * This cassette answers BOTH from canned fixtures, so the REAL gateway path runs:
 *   detection mapping → SceneEventDetector.detectEvents → VWM.updateScene → caption
 *   compose. The cassette deliberately bypasses ONLY the Python sidecar (YOLO +
 *   IoU tracker + Moondream2) — exactly the real camera→sidecar leg the mandatory
 *   mythos live-smoke must still cover.
 *
 * Determinism invariants this cassette enforces (T0.2):
 *   - /perception/detect returns `tracked_objects` with ≥1 object `state:'confirmed'`
 *     AND a non-empty `scene_summary`. VWM.updateScene filters `state==='confirmed'`
 *     and the scene/VWM/caption block is gated on a confirmed-object scene
 *     (perception.gateway.ts) — a tentative-only or empty response would silently
 *     skip the whole block and pass P1/P3 vacuously. The default fixture is therefore
 *     ALWAYS a confirmed object + non-empty summary.
 *
 * Synthetic marking (T0.8): every `tracked_objects` entry carries `synthetic: true`
 * (a data value off the detection payload, plumbed onto the WORLD node — NOT a
 * GATE_MODE branch in the gateway). `perception-reset` then deletes them cleanly.
 *
 * Lesion (T0.6): `/perception/caption` can be flipped to return 503 "unavailable"
 * so the P6 fixture proves she does not fabricate a caption she cannot generate.
 *
 * Process-local to the gate runner. The operator points the backend's
 * PERCEPTION_HOST at this server's URL BEFORE starting the backend (the URL is
 * fixed and printed on start, mirroring the LLM cassette).
 */

import * as http from 'http';

// ---------------------------------------------------------------------------
// Config — no hardcoded ports (env with defaults), distinct from the LLM cassette
// ---------------------------------------------------------------------------

/** Port the perception cassette listens on. Backend's PERCEPTION_HOST must match. */
export const PERCEPTION_CASSETTE_PORT = parseInt(
  process.env.GATE_PERCEPTION_PORT || '11600',
  10,
);

/** The URL the backend should use for PERCEPTION_HOST while the gate runs. */
export const PERCEPTION_CASSETTE_URL = `http://localhost:${PERCEPTION_CASSETTE_PORT}`;

// ---------------------------------------------------------------------------
// Fixture types — mirror the real sidecar response shape (main.py /perception/detect)
// ---------------------------------------------------------------------------

/** A single tracked object in the detect response (mirrors main.py:448-468). */
export interface CassetteTrackedObject {
  track_id: number;
  /** MUST be 'confirmed' for ≥1 object or the scene/VWM/caption block is skipped. */
  state: 'tentative' | 'confirmed' | 'lost' | 'deleted';
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
  frames_seen: number;
  frames_lost: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  embedding: number[] | null;
  /** WS5 T0.8 — synthetic discriminator carried onto the WORLD node. */
  synthetic?: boolean;
}

/** A raw detection in the detect response (mirrors main.py:478-490). */
export interface CassetteDetection {
  label_raw: string;
  confidence: number;
  bbox_x_min: number;
  bbox_y_min: number;
  bbox_x_max: number;
  bbox_y_max: number;
  mask_polygon: number[][] | null;
  frame_id: string;
}

/** The full /perception/detect response a fixture produces. */
export interface DetectFixture {
  detections: CassetteDetection[];
  faces: unknown[];
  face_connections: number[][];
  face_oval: number[][];
  tracked_objects: CassetteTrackedObject[];
  scene_summary: {
    total_tracks: number;
    confirmed_count: number;
    lost_count: number;
    new_count: number;
    frame_sequence: number;
  };
}

// NOTE (T4 P1b, NOT WIRED IN T0): the unknown-person→Social path reads
// `frame.raw['unknown_person_count']`, which the gateway derives from VWM
// `getUnknownPersons()` (perception.gateway.ts), NOT from the detect response.
// So injecting a `person`-labelled face track that VWM cannot identify is what
// will drive P1b — there is no detect-response field for it. Left unstubbed here
// deliberately: a fixture field the gateway never reads would be theater.

// ---------------------------------------------------------------------------
// Default fixtures (T0.2 invariant: ≥1 confirmed object + non-empty scene_summary)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic 1280-D embedding so VWM's cosine-match / WORLD-node write path
 * runs for real (a null embedding would skip the embedding store). Deterministic:
 * a fixed pattern keyed off the track id so two frames of the SAME object match
 * (>0.75 cosine) and a different object does not.
 */
export function syntheticEmbedding(seed: number): number[] {
  const v = new Array<number>(1280);
  for (let i = 0; i < 1280; i++) {
    // Smooth deterministic signal; seed shifts the phase so distinct seeds diverge.
    v[i] = Math.sin((i + 1) * 0.01 + seed * 1.7);
  }
  return v;
}

let nextFrameId = 1;
function frameId(): string {
  return `gate-frame-${nextFrameId++}`;
}

/**
 * Default detect fixture: one CONFIRMED synthetic object. `label` and `trackId`
 * parameterized so callers can inject novelty (new label / fresh trackId) or
 * habituation (same identity, fresh trackId). Always satisfies the T0.2 invariant.
 */
export function makeDetectFixture(opts: {
  label?: string;
  trackId?: number;
  framesSeen?: number;
  /** Override the embedding seed (identity). Defaults to trackId. */
  embeddingSeed?: number;
} = {}): DetectFixture {
  const label = opts.label ?? 'cup';
  const trackId = opts.trackId ?? 101;
  const framesSeen = opts.framesSeen ?? 5;
  const bbox: [number, number, number, number] = [120, 80, 240, 200];
  const fid = frameId();
  return {
    detections: [
      {
        label_raw: label,
        confidence: 0.87,
        bbox_x_min: bbox[0],
        bbox_y_min: bbox[1],
        bbox_x_max: bbox[2],
        bbox_y_max: bbox[3],
        mask_polygon: null,
        frame_id: fid,
      },
    ],
    faces: [],
    face_connections: [],
    face_oval: [],
    tracked_objects: [
      {
        track_id: trackId,
        state: 'confirmed', // T0.2 — at least one confirmed object, ALWAYS.
        label,
        confidence: 0.87,
        bbox,
        frames_seen: framesSeen,
        frames_lost: 0,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        embedding: syntheticEmbedding(opts.embeddingSeed ?? trackId),
        synthetic: true, // T0.8 — marks the WORLD node synthetic for clean reset.
      },
    ],
    scene_summary: {
      total_tracks: 1,
      confirmed_count: 1,
      lost_count: 0,
      new_count: framesSeen <= 1 ? 1 : 0,
      frame_sequence: nextFrameId,
    },
  };
}

// ---------------------------------------------------------------------------
// Cassette server
// ---------------------------------------------------------------------------

export interface PerceptionCassetteStats {
  detectHits: number;
  captionHits: number;
  captionLesionRejections: number;
  lastCaptionPrompt: string | null;
}

export class PerceptionCassette {
  private server: http.Server | null = null;

  /** The detect fixture served on the next /perception/detect call. */
  private detectFixture: DetectFixture = makeDetectFixture();

  /** The caption served on the next /perception/caption call (when not lesioned). */
  private caption = 'a synthetic gate object in view';

  /** When true, /perception/caption returns 503 "unavailable" (T0.6 lesion). */
  private captionLesioned = false;

  readonly stats: PerceptionCassetteStats = {
    detectHits: 0,
    captionHits: 0,
    captionLesionRejections: 0,
    lastCaptionPrompt: null,
  };

  /** Swap the detect fixture the NEXT frame will receive. */
  setDetectFixture(fixture: DetectFixture): void {
    this.detectFixture = fixture;
  }

  /** Swap the caption the NEXT /perception/caption call will return. */
  setCaption(caption: string): void {
    this.caption = caption;
  }

  /** Flip caption lesion mode on/off (T0.6). */
  setCaptionLesion(lesioned: boolean): void {
    this.captionLesioned = lesioned;
  }

  /** True once /perception/caption has been hit at least once (T0.4 acceptance). */
  captionWasHit(): boolean {
    return this.stats.captionHits > 0;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      this.server.on('error', reject);
      this.server.listen(PERCEPTION_CASSETTE_PORT, () => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const urlPath = (req.url ?? '/').split('?')[0];

    // Drain the (binary JPEG) body so the socket frees; content is irrelevant —
    // the cassette is fixture-driven, not image-driven.
    await drain(req);

    if (method === 'POST' && urlPath === '/perception/detect') {
      this.stats.detectHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.detectFixture));
      return;
    }

    if (method === 'POST' && urlPath === '/perception/caption') {
      if (this.captionLesioned) {
        // T0.6 — caption unavailable. Mirror the real sidecar's 503 (main.py:736).
        // The gateway's requestVlmCaption treats a non-ok response as "no caption"
        // and falls back to the VWM-only description (never fabricates one).
        this.stats.captionLesionRejections++;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'VLM is disabled' }));
        return;
      }
      this.stats.captionHits++;
      this.stats.lastCaptionPrompt = new URL(req.url ?? '/', PERCEPTION_CASSETTE_URL)
        .searchParams.get('prompt');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ caption: this.caption, model: 'gate-cassette', inference_ms: 0 }));
      return;
    }

    if (method === 'GET' && urlPath === '/perception/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', model_loaded: true, vlm_enabled: !this.captionLesioned }));
      return;
    }

    // Unknown endpoint — 404 (the real sidecar has more, but the gateway only
    // calls /detect and /caption; a 404 here surfaces an unexpected call loudly).
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `perception cassette: no fixture for ${method} ${urlPath}` }));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const srv = this.server;
      if (!srv) return resolve();
      this.server = null;
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    });
  }
}

function drain(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('data', () => {});
    req.on('end', () => resolve());
    req.on('error', () => resolve());
  });
}
