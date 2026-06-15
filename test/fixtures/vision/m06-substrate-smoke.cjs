/**
 * M0.6 substrate behavioral smoke (P3.0 gate).
 *
 * Verifies the LIVE perception container actually produces the substrate the
 * P3 backbone-swap plan depends on:
 *   1. tracked_objects[].embedding non-null, length 1280 (EfficientNet baseline)
 *   2. faces[] non-empty on a face frame
 *
 * Object embeddings are only extracted for CONFIRMED tracks, so we POST the
 * same frame repeatedly to drive the tracker to confirmation before reading.
 *
 * Run: node test/fixtures/vision/m06-substrate-smoke.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

// NOTE: frame-1280x720.jpg is a SYNTHETIC test pattern (flat gray + one square)
// — YOLO sees no COCO objects in it, so it is useless for an embedding smoke.
// face_closeup.jpg is a real photo that yields confirmed COCO tracks (person +
// a dog false-positive) AND a face, exercising both the object-embedding and
// face paths from a single in-repo asset. Run against an ISOLATED container
// (PERCEPTION_BASE) — the shared :8430 tracker is contended by the live stack.
const BASE = process.env.PERCEPTION_BASE || 'http://127.0.0.1:8430';
const FRAME = path.join(__dirname, 'face_closeup.jpg');
const FACE = path.join(__dirname, 'face_closeup.jpg');
const OBJECT_EMBEDDING_DIM = 1280;

async function postJpeg(buf) {
  const res = await fetch(`${BASE}/perception/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buf,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const health = await (await fetch(`${BASE}/perception/health`)).json();
  console.log('HEALTH', JSON.stringify(health));

  // --- Object embedding path: POST identical frame to confirm tracks ---
  const frameBuf = fs.readFileSync(FRAME);
  let last;
  for (let i = 0; i < 10; i++) {
    last = await postJpeg(frameBuf);
    const t = last.tracked_objects || [];
    const ss0 = last.scene_summary || {};
    const maxSeen = t.reduce((m, x) => Math.max(m, x.frames_seen || 0), 0);
    const states = t.map((x) => `${x.label}:${x.state}:s${x.frames_seen}/l${x.frames_lost}`).join(' ');
    console.log(`  POST#${i + 1} confirmed=${ss0.confirmed_count} total=${ss0.total_tracks} maxSeen=${maxSeen} | ${states}`);
  }
  const tos = last.tracked_objects || [];
  const ss = last.scene_summary || {};
  console.log(
    `\nOBJECT FRAME (${FRAME.split(path.sep).pop()}): confirmed=${ss.confirmed_count} total=${ss.total_tracks} ` +
      `frame=${last.frame_width}x${last.frame_height}`,
  );
  let embOk = 0;
  for (const t of tos) {
    const el = Array.isArray(t.embedding) ? t.embedding.length : null;
    if (el === OBJECT_EMBEDDING_DIM) embOk++;
    console.log(`  track ${t.track_id} ${String(t.label).padEnd(12)} state=${String(t.state).padEnd(10)} emb_len=${el}`);
  }

  // --- Face path: faces are per-frame (not track-gated) ---
  const faceBuf = fs.readFileSync(FACE);
  let faceResp;
  for (let i = 0; i < 3; i++) faceResp = await postJpeg(faceBuf);
  const faces = faceResp.faces || [];
  console.log(`\nFACE FRAME (${FACE.split(path.sep).pop()}): faces=${faces.length}`);

  console.log('\n=== M0.6 VERDICT ===');
  const embPass = embOk > 0;
  const facePass = faces.length > 0;
  console.log(`  embeddings non-null len ${OBJECT_EMBEDDING_DIM}: ${embPass ? 'PASS' : 'FAIL'} (${embOk} confirmed tracks carry full embedding)`);
  console.log(`  faces non-empty:                ${facePass ? 'PASS' : 'FAIL'} (${faces.length} faces)`);
  console.log(`  OVERALL: ${embPass && facePass ? 'PASS' : 'FAIL'}`);
  process.exit(embPass && facePass ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE ERROR', e);
  process.exit(1);
});
