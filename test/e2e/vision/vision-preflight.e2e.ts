/**
 * vision-preflight.e2e.ts — ACC.0 M0 substrate preflight for the vision acceptance suite.
 *
 * Validates that the perception sidecar is UP and the three M0 conditions are
 * satisfied BEFORE any ACC.A/B/C test runs.  A failure here is diagnostic: it
 * names exactly which M0 condition failed so the operator knows what to fix
 * instead of seeing a cryptic downstream failure.
 *
 * M0 conditions (all must be true for a green exit):
 *   1. model_loaded        — YOLO detector loaded at sidecar startup
 *   2. face_model_loaded   — MediaPipe face detector loaded at sidecar startup
 *   3. embedding_init_failed === false — OnnxEmbeddingExtractor did not latch-fail
 *
 * Reads: GET /perception/status
 *   Returns: { model_loaded, face_model_loaded, embedding_init_failed, ... }
 *
 * Exit codes:
 *   0 — sidecar UP + all M0 conditions satisfied
 *   1 — sidecar DOWN or one or more M0 conditions failed (message names which)
 *
 * Run:
 *   npx tsx test/e2e/vision/vision-preflight.e2e.ts
 *
 * Environment:
 *   PERCEPTION_HOST  defaults to http://localhost:8430
 *
 * Prerequisites:
 *   The perception sidecar must be running (docker-compose or direct uvicorn).
 */

const PERCEPTION_HOST =
  process.env.PERCEPTION_HOST ?? 'http://localhost:8430';

const STATUS_URL = `${PERCEPTION_HOST}/perception/status`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerceptionStatus {
  active: boolean;
  tracked_objects: number;
  fps: number;
  model_loaded: boolean;
  face_model_loaded: boolean;
  embedding_init_failed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchStatus(): Promise<{ ok: boolean; status: number; body: PerceptionStatus | null }> {
  try {
    const res = await fetch(STATUS_URL);
    let body: PerceptionStatus | null = null;
    try {
      body = (await res.json()) as PerceptionStatus;
    } catch {
      /* non-JSON — body stays null */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    // fetch() throws when the host is unreachable (ECONNREFUSED, etc.)
    return { ok: false, status: 0, body: null };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== vision-preflight: ACC.0 M0 substrate check ===');
  console.log(`  target: ${STATUS_URL}`);
  console.log('');

  const { ok, status, body } = await fetchStatus();

  // Sidecar reachability check — fail loudly if down.
  if (!ok || body === null) {
    const reason =
      status === 0
        ? `sidecar unreachable at ${STATUS_URL} (connection refused or network error)`
        : `GET /perception/status returned HTTP ${status} (expected 200)`;
    console.error(`PREFLIGHT FAILED — M0 CONDITION: SIDECAR_DOWN`);
    console.error(`  ${reason}`);
    console.error('');
    console.error('Fix: start the perception sidecar before running acceptance tests.');
    console.error('  docker compose up -d   (or)   uvicorn main:app --port 8430');
    process.exit(1);
  }

  console.log(`  GET /perception/status → HTTP ${status}`);
  console.log(`  model_loaded:           ${body.model_loaded}`);
  console.log(`  face_model_loaded:      ${body.face_model_loaded}`);
  console.log(`  embedding_init_failed:  ${body.embedding_init_failed}`);
  console.log('');

  // Collect which M0 conditions failed so we can name them all at once.
  const failures: string[] = [];

  if (!body.model_loaded) {
    failures.push(
      'model_loaded=false — YOLO detector did not load at startup ' +
      '(check ultralytics install and model file path: COBEING_PERCEPTION_DETECTION__MODEL_PATH)',
    );
  }

  if (!body.face_model_loaded) {
    failures.push(
      'face_model_loaded=false — MediaPipe face detector did not load at startup ' +
      '(check mediapipe install and face_landmarker.task asset)',
    );
  }

  if (body.embedding_init_failed) {
    failures.push(
      'embedding_init_failed=true — OnnxEmbeddingExtractor latched a hard failure ' +
      '(check onnxruntime install and ArcFace model file)',
    );
  }

  if (failures.length > 0) {
    console.error(`PREFLIGHT FAILED — ${failures.length} M0 condition(s) not satisfied:`);
    for (const f of failures) {
      console.error(`  [FAIL] ${f}`);
    }
    console.error('');
    console.error('Fix each condition above before running ACC.A/B/C acceptance tests.');
    process.exit(1);
  }

  console.log('PREFLIGHT PASSED — sidecar UP, all M0 conditions satisfied.');
  console.log('  model_loaded=true, face_model_loaded=true, embedding_init_failed=false');
  console.log('  ACC.A/B/C acceptance tests may proceed.');
  process.exit(0);
}

void main();
