/**
 * perception-stub.ts — Inbound WebSocket camera stub for the Provability Gate (WS5 T0.3).
 *
 * Unlike the LLM cassette (outbound only — the backend calls OUT to it), the
 * perception path needs an INBOUND trigger: the real `PerceptionGateway.handleFrame`
 * fires on a WS message to `/ws/perception`. This stub is that camera. It pushes a
 * dummy JPEG over the socket, which makes the gateway POST to PERCEPTION_HOST (the
 * perception cassette), then run the REAL detection-mapping → detectEvents → VWM →
 * caption-compose path.
 *
 * Frame pacing (T0.5): frames are spaced > MIN_FRAME_INTERVAL_MS (66ms at 15fps)
 * AND the stub awaits the gateway's `processing` flag clearing (via
 * GET /api/metrics/perception-status) between frames. Back-to-back frames inside
 * the min-interval, or while a prior frame is still processing, are DROPPED by the
 * gateway — a dropped novel frame makes P1a/P1c non-deterministic.
 *
 * Caption-settle barrier (T0.4): `requestVlmCaption` is fire-and-forget and
 * `lastVlmCaption` lands a frame late (5s cooldown + scene-change predicate). So
 * to get a caption into the NEXT frame's composed scene description, the sequence is:
 *   1. arm-frame  — a scene-change frame that trips the caption request.
 *   2. await      — the perception cassette records the /perception/caption hit
 *                   (deterministic completion signal, not a wall-clock sleep).
 *   3. second-frame — now `lastVlmCaption` is set; the composed description carries it.
 * `injectCaptionedScene()` runs this barrier and asserts the cassette saw the hit.
 *
 * The stub carries NO `currentTurnContext` — so `speakerIsGuardian` is structurally
 * absent from any episode the frame produces (T0.9): a synthetic seen-fact can never
 * masquerade as guardian-confirmed.
 */

import { WebSocket } from 'ws';
import type { PerceptionCassette, DetectFixture } from './perception-cassette';

/**
 * Resolve the backend port at call time, not at module-import time.
 *
 * The smoke test sets process.env.APP_PORT AFTER importing this module, so a
 * module-level `const BACKEND_PORT = process.env.APP_PORT || '3000'` bakes in
 * '3000' before main() can override it. Deferring to a function means callers
 * (open, awaitProcessingClear, injectFrame) see whatever the env holds at the
 * moment they run — which is the correct smoke-isolated port.
 */
function backendPort(): string {
  return process.env.APP_PORT || process.env.PORT || '3000';
}
function wsBase(): string { return `ws://localhost:${backendPort()}`; }
function httpBase(): string { return `http://localhost:${backendPort()}`; }

/** Min spacing between injected frames (must exceed gateway MIN_FRAME_INTERVAL_MS=66.67ms). */
const FRAME_SPACING_MS = 90;

/**
 * Gateway caption cooldown (perception.gateway.ts CAPTION_COOLDOWN_MS=5000). A
 * caption request only fires if `timeSinceCaption >= COOLDOWN`. The barrier must
 * wait out any in-flight cooldown from a prior frame before arming, or the arm's
 * caption request is silently suppressed by the cooldown predicate. Mirrored here
 * (not imported — the gateway is backend code; the stub is harness code).
 */
const CAPTION_COOLDOWN_MS = 5000;

/** A tiny but valid-enough JPEG header + payload. Content is irrelevant — the
 * perception cassette is fixture-driven, not image-driven — but it must be a
 * non-empty binary Buffer so the gateway forwards a real body. */
const DUMMY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll the gateway `processing` flag until it clears (or timeout). */
async function awaitProcessingClear(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpBase()}/api/metrics/perception-status`);
      if (res.ok) {
        const body = (await res.json()) as { processing?: boolean };
        if (body.processing === false) return true;
      }
    } catch {
      // status route not up yet — fall through to retry
    }
    await sleep(20);
  }
  return false;
}

/**
 * A persistent inbound camera socket. Stays open across injected frames so the
 * gateway keeps the same connection (and its per-connection state) alive.
 */
export class PerceptionCameraStub {
  private ws: WebSocket | null = null;

  /** Open the camera socket and wait for it to connect. */
  open(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase()}/ws/perception`);
      this.ws = ws;
      const to = setTimeout(() => {
        ws.close();
        reject(new Error('PerceptionCameraStub: timeout waiting for /ws/perception open'));
      }, timeoutMs);
      ws.on('open', () => {
        clearTimeout(to);
        // Give the gateway a beat to register handleConnection's message handler.
        setTimeout(resolve, 100);
      });
      ws.on('error', (err) => {
        clearTimeout(to);
        reject(err);
      });
    });
  }

  /**
   * Inject ONE frame: set the cassette's detect fixture, push a JPEG, and await
   * the gateway `processing` flag clearing. Returns when the frame has been fully
   * processed (detection → detectEvents → VWM → caption-compose all run).
   */
  async injectFrame(cassette: PerceptionCassette, fixture: DetectFixture): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('PerceptionCameraStub: socket not open');
    }
    // Arm the cassette response BEFORE the gateway POSTs to it.
    cassette.setDetectFixture(fixture);

    // Space frames so the gateway's MIN_FRAME_INTERVAL_MS drop-guard does not eat it.
    await sleep(FRAME_SPACING_MS);
    this.ws.send(DUMMY_JPEG);

    // The gateway sets `processing=true` synchronously on receipt and clears it in
    // the finally block after the detect POST + scene pipeline. Awaiting the clear
    // is the deterministic "frame fully handled" signal (T0.5).
    await sleep(20); // let the gateway flip processing=true first
    const cleared = await awaitProcessingClear();
    if (!cleared) {
      throw new Error('PerceptionCameraStub: gateway processing flag never cleared (frame stuck?)');
    }
  }

  /**
   * Caption-settle barrier (T0.4). Drives a caption into the COMPOSED scene
   * description by:
   *   1. setting the caption the cassette will return,
   *   2. injecting an arm-frame (scene change → trips requestVlmCaption),
   *   3. awaiting the cassette's /perception/caption hit (deterministic, not a sleep),
   *   4. injecting a second frame so the now-set lastVlmCaption is composed in.
   *
   * Returns true iff the cassette actually recorded a caption hit during the
   * barrier — the T0 acceptance check. If false, the barrier is misbuilt and any
   * downstream P2/P4 caption assertion is untrustworthy.
   */
  async injectCaptionedScene(
    cassette: PerceptionCassette,
    caption: string,
    armFixture: DetectFixture,
    secondFixture: DetectFixture,
    captionTimeoutMs = 8000,
  ): Promise<boolean> {
    cassette.setCaption(caption);
    const hitsBefore = cassette.stats.captionHits;

    // 0. Wait out the gateway's caption cooldown. A prior frame (e.g. the T0-B
    //    detect frame) may have just consumed a caption slot; the arm's request
    //    would then be suppressed by `timeSinceCaption >= COOLDOWN`. Pacing past
    //    the cooldown is what makes the barrier deterministic rather than flaky.
    await sleep(CAPTION_COOLDOWN_MS + 300);

    // 1+2. Arm-frame: a NEW object → OBJECT_APPEARED scene change → caption request.
    await this.injectFrame(cassette, armFixture);

    // 3. Await the fire-and-forget caption request landing on the cassette.
    const deadline = Date.now() + captionTimeoutMs;
    while (Date.now() < deadline && cassette.stats.captionHits <= hitsBefore) {
      await sleep(30);
    }
    const captionHit = cassette.stats.captionHits > hitsBefore;

    // 4. Second frame: lastVlmCaption is now set → composed into the scene desc.
    await this.injectFrame(cassette, secondFixture);

    return captionHit;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
