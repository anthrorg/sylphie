/**
 * P1 #2 — live DB-integration smoke for mutable instance centroids.
 *
 * Exercises the EXACT SQL the VWM #2 path uses against the real TimescaleDB
 * (pgvector), which a unit-test fake cannot cover:
 *   1. the cosine SELECT returns `embedding` as a parseable text literal,
 *   2. the `UPDATE ... SET embedding = $2::vector WHERE id = $1` succeeds,
 *   3. the stored centroid actually moves to the incremental mean,
 *   4. sighting_count increments.
 *
 * Everything runs inside a single transaction that is ROLLED BACK at the end,
 * so it leaves ZERO residue in Jim's shared DB. Read-your-writes inside the txn
 * still proves the SQL against real pgvector.
 */
const { Client } = require('pg');

const DIM = 1280;
// Mirror of foldObjectCentroid (apps/sylphie/.../visual-working-memory.service.ts)
function foldObjectCentroid(centroid, next, n) {
  if (centroid.length === 0) return next.slice();
  if (next.length !== centroid.length || !Number.isFinite(n) || n < 1) return centroid;
  const out = centroid.slice();
  for (let i = 0; i < out.length; i++) out[i] = (out[i] * n + next[i]) / (n + 1);
  return out;
}
const lit = (v) => `[${v.join(',')}]`;

(async () => {
  const client = new Client({
    host: process.env.TIMESCALE_HOST || 'localhost',
    port: Number(process.env.TIMESCALE_PORT || 5433),
    database: process.env.TIMESCALE_DB || 'sylphie_events',
    user: process.env.TIMESCALE_USER || 'sylphie',
    password: process.env.TIMESCALE_PASSWORD || 'sylphie_events_dev',
  });
  let ok = true;
  const fail = (m) => { ok = false; console.error('FAIL:', m); };

  // Deterministic 1280-D vectors. Query == stored so the SELECT nearest hits it.
  const stored = Array.from({ length: DIM }, (_, i) => (i % 10) / 10);
  const sighting = Array.from({ length: DIM }, (_, i) => ((i + 3) % 10) / 10);
  const n0 = 1; // sighting_count BEFORE the fold
  const expected = foldObjectCentroid(stored, sighting, n0);
  const ID = 'p1-2-smoke-row';
  const NODE = 'p1-2-smoke-node';

  await client.connect();
  try {
    const reg = await client.query("SELECT to_regclass('visual_object_embeddings') AS t");
    if (!reg.rows[0].t) {
      console.error('SKIP: visual_object_embeddings table does not exist yet (start the backend once).');
      process.exit(2);
    }

    await client.query('BEGIN');

    // Seed a known centroid row (n=1).
    await client.query(
      `INSERT INTO visual_object_embeddings (id, node_id, label, embedding, confidence, discovered, created_at, sighting_count)
       VALUES ($1,$2,'cup',$3::vector,0.40,false,NOW(),$4)`,
      [ID, NODE, lit(stored), n0],
    );

    // (1) The EXACT service SELECT — does embedding come back as a parseable literal?
    const sel = await client.query(
      `SELECT id, node_id, label, display_name, discovered, embedding, sighting_count,
              embedding <=> $1::vector AS distance
       FROM visual_object_embeddings
       WHERE embedding IS NOT NULL
       ORDER BY distance LIMIT 1`,
      [lit(stored)],
    );
    const row = sel.rows[0];
    if (!row || row.id !== ID) fail(`SELECT did not return the seeded row (got ${row && row.id})`);
    const similarity = 1 - Number(row.distance);
    if (!(similarity >= 0.75)) fail(`self-match similarity ${similarity} < 0.75`);
    let parsed = null;
    try { parsed = JSON.parse(row.embedding); } catch (e) { /* handled below */ }
    if (!Array.isArray(parsed) || parsed.length !== DIM) {
      fail(`stored embedding did not parse as a ${DIM}-D array (got ${parsed && parsed.length})`);
    } else {
      console.log(`OK  SELECT returned embedding as parseable ${parsed.length}-D literal; self-sim=${similarity.toFixed(4)}`);
    }

    // (2)+(3) The EXACT service UPDATE — write the folded centroid by id.
    const n = Number(row.sighting_count) || 1;
    const updated = foldObjectCentroid(parsed || stored, sighting, n);
    await client.query(
      `UPDATE visual_object_embeddings
       SET last_seen_at = NOW(), sighting_count = sighting_count + 1, embedding = $2::vector
       WHERE id = $1`,
      [ID, lit(updated)],
    );

    // (4) Re-read and verify the centroid moved + count incremented.
    const after = await client.query(
      'SELECT embedding, sighting_count FROM visual_object_embeddings WHERE id = $1', [ID]);
    const got = JSON.parse(after.rows[0].embedding);
    const cnt = Number(after.rows[0].sighting_count);
    if (cnt !== n0 + 1) fail(`sighting_count ${cnt} != ${n0 + 1}`);
    const probes = [0, 1, 2, 3, 100, 639, 1279];
    let maxErr = 0;
    for (const i of probes) maxErr = Math.max(maxErr, Math.abs(got[i] - expected[i]));
    if (maxErr > 1e-5) fail(`centroid did not match incremental mean (maxErr=${maxErr} over probes)`);
    // Prove it actually MOVED off the original stored vector.
    let moved = false;
    for (const i of probes) if (Math.abs(got[i] - stored[i]) > 1e-6) moved = true;
    if (!moved) fail('centroid did not move from the original stored vector');
    if (ok) {
      console.log(`OK  UPDATE moved centroid to incremental mean (maxErr=${maxErr.toExponential(2)} over ${probes.length} probes); sighting_count ${n0}→${cnt}`);
      console.log(`    sample dim0: stored=${stored[0]} sighting=${sighting[0]} -> centroid=${got[0]} (expected ${expected[0]})`);
    }

    await client.query('ROLLBACK'); // zero residue
    console.log('OK  transaction ROLLED BACK — no residue in shared DB');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    fail(`exception: ${e.message}`);
  } finally {
    await client.end();
  }
  console.log(ok ? '\nP1 #2 DB-INTEGRATION SMOKE: PASS' : '\nP1 #2 DB-INTEGRATION SMOKE: FAIL');
  process.exit(ok ? 0 : 1);
})();
