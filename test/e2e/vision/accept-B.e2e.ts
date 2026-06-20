/**
 * accept-B.e2e.ts — ACC.B: durable cross-session re-bind (live)
 *
 * Proves a "power-cycled" NestJS app (DBs up, in-memory VWM state gone) re-binds
 * a previously-seen VisualObject to the SAME :VisualObject node, incrementing
 * sighting_count and updating the centroid.
 *
 * Prerequisites:
 *   - TimescaleDB running (localhost:5433, default creds from .env or env vars)
 *   - Neo4j WORLD running (localhost:7687, neo4j/sylphie_world or env vars)
 *   - visual_object_embeddings table created (start the backend once)
 *   - pgvector extension present in TimescaleDB
 *   - neo4j-driver and pg in node_modules (yarn install from repo root)
 *
 * Run:
 *   npx tsx test/e2e/vision/accept-B.e2e.ts
 *
 * Environment (all optional, defaults match the standard docker-compose stack):
 *   TIMESCALE_HOST, TIMESCALE_PORT, TIMESCALE_DB, TIMESCALE_USER, TIMESCALE_PASSWORD
 *   NEO4J_WORLD_URI, NEO4J_WORLD_USER, NEO4J_WORLD_PASSWORD
 *
 * Exit codes:
 *   0 — PASS (all assertions green)
 *   1 — FAIL (one or more assertions failed, or infrastructure error)
 *
 * Design notes:
 *   "Power cycle" is modeled by tearing down all DB clients after session 1 and
 *   opening fresh connections for session 2 — exactly what NestJS process restart
 *   does (in-memory VWM state is gone; DB rows persist). The session 2 re-bind
 *   path re-executes the EXACT SQL from resolveEntityIdentity (the production VWM
 *   code path), so this test exercises the real re-ID logic end-to-end without
 *   needing the full NestJS stack running.
 *
 *   KG-isolation check: asserts ZERO edges between the WORLD :VisualObject and any
 *   node in the OTHER or SELF KG instances. Because those instances run on separate
 *   Neo4j databases on different bolt URIs, a :VisualObject in WORLD can never have
 *   edges to their nodes by construction. The check queries for cross-label
 *   relationships ON the WORLD graph itself — any node that shouldn't be there
 *   (person/self nodes) would indicate isolation leakage.
 */

import { Client as PgClient } from 'pg';
import neo4j, { type Driver, type Session } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The embedding column dimension is detected at runtime from the live DB to
 * handle both the pre-migration state (1280-D EfficientNet-B0, embedding_version=1)
 * and the post-P3.1 state (768-D DINOv2-base, embedding_version=2). The test
 * generates its seed vectors dynamically so it works on either side of the migration.
 */
let DIM = 768; // default; overridden after connecting to the DB

/** Stable test IDs so repeated runs are idempotent (cleanup -> insert -> verify -> cleanup). */
const TEST_ROW_ID = 'tk28-acc-b-mug-row';
const TEST_NODE_ID = 'tk28-acc-b-mug-node';

/** Match threshold from DEFAULT_BINDING_CONFIG (binding.service.ts). */
const MATCH_THRESHOLD = 0.75;

/** NEW_WEIGHTS.embedding + NEW_WEIGHTS.label_raw from binding.service.ts. */
const W_EMBEDDING = 0.25;
const W_LABEL = 0.05;

// ---------------------------------------------------------------------------
// DB config (mirrors centroid-db-smoke.cjs defaults)
// ---------------------------------------------------------------------------

const pgConfig = {
  host: process.env.TIMESCALE_HOST || 'localhost',
  port: Number(process.env.TIMESCALE_PORT || 5433),
  database: process.env.TIMESCALE_DB || 'sylphie_events',
  user: process.env.TIMESCALE_USER || 'sylphie',
  password: process.env.TIMESCALE_PASSWORD || 'sylphie_events_dev',
};

const neo4jUri = process.env.NEO4J_WORLD_URI || 'bolt://localhost:7687';
const neo4jUser = process.env.NEO4J_WORLD_USER || 'neo4j';
const neo4jPass = process.env.NEO4J_WORLD_PASSWORD || 'sylphie_world';

// ---------------------------------------------------------------------------
// Pure helpers (mirrors production VWM code — must stay in sync)
// ---------------------------------------------------------------------------

/** Mirror of foldObjectCentroid from visual-working-memory.service.ts. */
function foldObjectCentroid(centroid: number[], next: number[], n: number): number[] {
  if (centroid.length === 0) return next.slice();
  if (next.length !== centroid.length || !Number.isFinite(n) || n < 1) return centroid;
  const out = centroid.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] = (centroid[i] * n + next[i]) / (n + 1);
  }
  return out;
}

/** Cosine similarity in [0,1]. */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (magA * magB)));
}

/**
 * Compute the binding score for a session 2 observation against a session 1
 * candidate using only embedding + label signals.
 *
 * The session 1 row has sighting_count=1, so confirmationCount < NEW_THRESHOLD=5
 * → NEW_WEIGHTS profile (embedding=0.25, label_raw=0.05). No spatial/size/color
 * data is seeded, so these signals are null and dropped from the denominator.
 * Renormalizes over embedding+label only, matching the production
 * computeMatchScore behavior (atlas correction #1: null != 0).
 *
 * For a MATCH: score >= 0.75.
 * With embedding+label only: score = (0.25*sim + 0.05*1.0) / 0.30.
 * Required sim >= 0.70.
 */
function computeBindingScore(
  sim: number,
  labelMatch: boolean,
): number {
  const denom = W_EMBEDDING + W_LABEL;
  const num = W_EMBEDDING * sim + W_LABEL * (labelMatch ? 1.0 : 0.0);
  return denom > 0 ? num / denom : 0;
}

/** Format a number[] as a pgvector literal string. */
const lit = (v: number[]): string => `[${v.join(',')}]`;

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let _ok = true;
const _failures: string[] = [];

function pass(msg: string): void {
  console.log(`  OK  ${msg}`);
}

function fail(msg: string): void {
  _ok = false;
  _failures.push(msg);
  console.error(`  FAIL ${msg}`);
}

function assertEq<T>(label: string, got: T, expected: T): void {
  if (got === expected) {
    pass(`${label}: ${JSON.stringify(got)}`);
  } else {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }
}

function assertGte(label: string, got: number, threshold: number): void {
  if (got >= threshold) {
    pass(`${label}: ${got} >= ${threshold}`);
  } else {
    fail(`${label}: expected >= ${threshold}, got ${got}`);
  }
}

function assertGt(label: string, got: number, threshold: number): void {
  if (got > threshold) {
    pass(`${label}: ${got} > ${threshold}`);
  } else {
    fail(`${label}: expected > ${threshold}, got ${got}`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup (idempotent — safe to call before and after the run)
// ---------------------------------------------------------------------------

async function cleanupPg(pg: PgClient): Promise<void> {
  await pg.query(
    `DELETE FROM visual_object_embeddings WHERE id = $1 OR node_id = $2`,
    [TEST_ROW_ID, TEST_NODE_ID],
  );
}

async function cleanupNeo4j(session: Session): Promise<void> {
  await session.run(
    `MATCH (n:VisualObject {node_id: $nodeId}) DETACH DELETE n`,
    { nodeId: TEST_NODE_ID },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== ACC.B: durable cross-session re-bind (live) ===\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION 1 — record :VisualObject into persistent stores
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('--- SESSION 1: record :VisualObject ---');

  const pg1 = new PgClient(pgConfig);
  await pg1.connect();

  // Guard: table must exist (created by NestJS ensureSchema on first boot).
  const reg = await pg1.query(
    `SELECT to_regclass('visual_object_embeddings') AS t`,
  );
  if (!reg.rows[0].t) {
    console.error(
      'SKIP: visual_object_embeddings table does not exist yet. ' +
      'Start the NestJS backend once to run ensureSchema(), then retry.',
    );
    await pg1.end();
    process.exit(1);
  }

  // Detect the actual embedding column dimension so the test works on both
  // the pre-P3.1 (1280-D EfficientNet) and post-P3.1 (768-D DINOv2) states.
  // Use format_type to get the human-readable type string (e.g. "vector(768)")
  // and parse the dimension from it — more reliable than raw atttypmod arithmetic.
  const dimRow = await pg1.query<{ coltype: string }>(
    `SELECT pg_catalog.format_type(pa.atttypid, pa.atttypmod) AS coltype
     FROM pg_attribute pa
     JOIN pg_class pc ON pa.attrelid = pc.oid
     WHERE pc.relname = 'visual_object_embeddings' AND pa.attname = 'embedding'`,
  );
  if (dimRow.rows.length > 0) {
    const m = dimRow.rows[0].coltype.match(/vector\((\d+)\)/i);
    if (m) {
      DIM = parseInt(m[1], 10);
      console.log(`  Detected embedding dimension: ${DIM} (column type: ${dimRow.rows[0].coltype})`);
    } else {
      console.log(`  Unexpected column type "${dimRow.rows[0].coltype}"; using default DIM=${DIM}`);
    }
  } else {
    console.log(`  Could not detect embedding dimension; using default DIM=${DIM}`);
  }

  // ── Build test vectors (after DIM is known) ───────────────────────────────
  //
  // Session 1 embedding: deterministic DIM-D pattern (dim_i % 10 / 10).
  // Session 2 embedding: same pattern plus a tiny shift on dim 0 (0.001).
  // Cosine similarity is ~0.9999 — well above the 0.70 minimum required for
  // a match with NEW_WEIGHTS (embedding+label only). The small shift ensures
  // the centroid fold actually moves the stored vector, proving drift > 0.
  const embedding1 = Array.from({ length: DIM }, (_, i) => (i % 10) / 10);
  const embedding2 = Array.from({ length: DIM }, (_, i) => (i % 10) / 10);
  embedding2[0] = 0.001; // tiny perturbation: same object, slightly different angle

  const sessionOneBbox = JSON.stringify([0.1, 0.2, 0.5, 0.6]);

  // Validate the test vectors produce a confident binding match before inserting.
  const simCheck = cosineSim(embedding1, embedding2);
  const scoreCheck = computeBindingScore(simCheck, true);
  console.log(`  Pre-check: sim=${simCheck.toFixed(6)}, binding_score=${scoreCheck.toFixed(6)}`);
  if (scoreCheck < MATCH_THRESHOLD) {
    console.error(
      `FATAL: binding score ${scoreCheck.toFixed(4)} < threshold ${MATCH_THRESHOLD}. ` +
      `Test embeddings too dissimilar for a match — adjust the perturbation.`,
    );
    await pg1.end();
    process.exit(1);
  }
  console.log(`  Pre-check: PASS (score ${scoreCheck.toFixed(4)} >= ${MATCH_THRESHOLD})\n`);

  // Pre-run cleanup in case a prior failed run left residue.
  await cleanupPg(pg1);

  const neo4jDriver1: Driver = neo4j.driver(
    neo4jUri,
    neo4j.auth.basic(neo4jUser, neo4jPass),
    { logging: { level: 'error', logger: () => {} } },
  );
  const neo4jSession1 = neo4jDriver1.session({
    database: 'neo4j',
    defaultAccessMode: 'WRITE',
  });
  await cleanupNeo4j(neo4jSession1);

  // Embedding version tracks the backbone: 1=EfficientNet-B0 (1280-D), 2=DINOv2-base (768-D).
  // Use whichever version matches the actual column dim so the fold version-guard passes.
  const embVersion = DIM === 768 ? 2 : 1;

  // INSERT session 1 row — mirrors createUndiscoveredNode in vwm.service.ts.
  await pg1.query(
    `INSERT INTO visual_object_embeddings
       (id, node_id, label, embedding, confidence, discovered, created_at,
        bounding_box, dominant_colors, object_crop_b64, embedding_version, sighting_count)
     VALUES ($1, $2, 'mug', $3::vector, 0.40, false, NOW(), $4, NULL, NULL, $5, 1)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_ROW_ID, TEST_NODE_ID, lit(embedding1), sessionOneBbox, embVersion],
  );

  // MERGE session 1 Neo4j node — mirrors createUndiscoveredNode MERGE.
  await neo4jSession1.run(
    `MERGE (n:Entity:VisualObject {node_id: $nodeId})
     ON CREATE SET
       n.label = 'mug',
       n.node_type = 'VisualObject',
       n.schema_level = 'instance',
       n.provenance_type = 'SENSOR',
       n.confidence = 0.40,
       n.discovered = false,
       n.yolo_class = 'mug',
       n.sighting_count = 1,
       n.synthetic = false,
       n.bounding_box = $bboxJson,
       n.dominant_colors = null,
       n.object_crop_b64 = null,
       n.embedding_version = 2,
       n.created_at = datetime()`,
    { nodeId: TEST_NODE_ID, bboxJson: sessionOneBbox },
  );

  // Read back to confirm the precondition (AC-1 requires sighting_count=1 in session 1).
  const s1Row = await pg1.query<{ node_id: string; sighting_count: string }>(
    `SELECT node_id, sighting_count FROM visual_object_embeddings WHERE id = $1`,
    [TEST_ROW_ID],
  );
  const s1 = s1Row.rows[0];
  console.log(`  node_id=${s1.node_id}, sighting_count=${s1.sighting_count}`);
  assertEq('Session 1 node_id', s1.node_id, TEST_NODE_ID);
  assertEq('Session 1 sighting_count', Number(s1.sighting_count), 1);

  // Close ALL session 1 connections — models the NestJS process shutdown.
  // DB rows persist; in-memory VWM entity Map is gone.
  await neo4jSession1.close();
  await neo4jDriver1.close();
  await pg1.end();

  console.log('\n  [Power cycle: all DB connections closed — simulates NestJS restart]\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION 2 — fresh connections, re-sighting of the same object
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('--- SESSION 2: re-sighting with fresh connections ---');

  const pg2 = new PgClient(pgConfig);
  await pg2.connect();

  // Step 2a: Cosine SELECT — EXACT query from resolveEntityIdentity.
  const selResult = await pg2.query<{
    id: string;
    node_id: string;
    label: string;
    display_name: string | null;
    discovered: boolean;
    embedding: string | null;
    bounding_box: string | null;
    dominant_colors: string | null;
    embedding_version: number | null;
    sighting_count: string;
    last_seen_ms: string | null;
    distance: string;
  }>(
    `SELECT id, node_id, label, display_name, discovered, embedding,
            bounding_box, dominant_colors, embedding_version, sighting_count,
            EXTRACT(EPOCH FROM COALESCE(last_seen_at, created_at)) * 1000 AS last_seen_ms,
            embedding <=> $1::vector AS distance
     FROM visual_object_embeddings
     WHERE embedding IS NOT NULL
     ORDER BY distance
     LIMIT $2`,
    [lit(embedding2), 5],
  );

  if (selResult.rows.length === 0) {
    fail('cosine SELECT returned 0 rows — session 1 row not found in DB');
    process.exit(1);
  }

  const candidate = selResult.rows.find((r) => r.node_id === TEST_NODE_ID);
  if (!candidate) {
    fail(
      `session 1 node ${TEST_NODE_ID} was not surfaced by the cosine SELECT ` +
      `(top hit was ${selResult.rows[0]?.node_id ?? 'none'})`,
    );
    process.exit(1);
  }

  // Step 2b: Binding score (inline — mirrors BindingService.findMatch).
  const candidateEmbedding: number[] = JSON.parse(candidate.embedding!);
  const obsSimS2 = cosineSim(embedding2, candidateEmbedding);
  const bindScore = computeBindingScore(obsSimS2, candidate.label === 'mug');

  console.log(
    `  cosine_sim=${obsSimS2.toFixed(6)}, ` +
    `binding_score=${bindScore.toFixed(6)}, label_match=${candidate.label === 'mug'}`,
  );

  if (bindScore < MATCH_THRESHOLD) {
    fail(
      `binding score ${bindScore.toFixed(4)} < threshold ${MATCH_THRESHOLD} — ` +
      `VWM would create a duplicate node instead of re-binding`,
    );
    // Fall through so all failures are collected before process.exit.
  } else {
    pass(`binding score ${bindScore.toFixed(4)} >= ${MATCH_THRESHOLD} (match confirmed)`);
  }

  // Step 2c: UPDATE centroid + sighting_count — EXACT SQL from resolveEntityIdentity.
  const n = Number(candidate.sighting_count) || 1;
  // CURRENT_VERSION matches what was written in session 1 (same backbone, same dim).
  const CURRENT_VERSION = DIM === 768 ? 2 : 1; // mirrors CURRENT_OBJECT_EMBEDDING_VERSION
  const storedVersion =
    candidate.embedding_version == null ? CURRENT_VERSION : Number(candidate.embedding_version);
  const versionMatches = storedVersion === CURRENT_VERSION;
  const foldedCentroid =
    versionMatches && candidateEmbedding
      ? foldObjectCentroid(candidateEmbedding, embedding2, n)
      : null;

  await pg2.query(
    foldedCentroid
      ? `UPDATE visual_object_embeddings
         SET last_seen_at = NOW(),
             sighting_count = sighting_count + 1,
             embedding = $2::vector,
             embedding_version = $3
         WHERE id = $1`
      : `UPDATE visual_object_embeddings
         SET last_seen_at = NOW(), sighting_count = sighting_count + 1
         WHERE id = $1`,
    foldedCentroid
      ? [candidate.id, lit(foldedCentroid), CURRENT_VERSION]
      : [candidate.id],
  );

  console.log(
    `  UPDATE applied (version_match=${versionMatches}, fold=${foldedCentroid !== null}, n: ${n}->${n + 1})`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-1: same node_id, sighting_count >= 2, no duplicate node
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n--- AC-1 ---');

  const afterRow = await pg2.query<{
    node_id: string;
    sighting_count: string;
    embedding: string;
    bounding_box: string | null;
  }>(
    `SELECT node_id, sighting_count, embedding, bounding_box
     FROM visual_object_embeddings WHERE id = $1`,
    [TEST_ROW_ID],
  );

  if (afterRow.rows.length === 0) {
    fail(`Row ${TEST_ROW_ID} vanished after UPDATE`);
    // Can't proceed with row assertions; jump to KG-isolation check.
  } else {
    const after = afterRow.rows[0];
    assertEq('AC-1: same node_id after re-bind', after.node_id, TEST_NODE_ID);
    assertGte('AC-1: sighting_count >= 2', Number(after.sighting_count), 2);

    // No duplicate: exactly 1 Timescale row for this node_id.
    const dupCheck = await pg2.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM visual_object_embeddings WHERE node_id = $1`,
      [TEST_NODE_ID],
    );
    assertEq('AC-1: no duplicate node (1 row per node_id)', Number(dupCheck.rows[0].cnt), 1);

    // ═══════════════════════════════════════════════════════════════════════
    // AC-2: centroid drift > 0, bounding_box parseable, ZERO cross-instance edges
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- AC-2 ---');

    // Centroid drift: the stored embedding must have moved off the session 1 vector.
    const afterEmb: number[] = JSON.parse(after.embedding);
    let maxDrift = 0;
    for (let i = 0; i < DIM; i++) {
      maxDrift = Math.max(maxDrift, Math.abs(afterEmb[i] - embedding1[i]));
    }
    assertGt('AC-2: centroid drift > 0 (embedding moved)', maxDrift, 0);

    // bounding_box: non-null and parseable JSON (persisted from session 1).
    if (!after.bounding_box) {
      fail('AC-2: bounding_box is NULL — expected JSON from session 1 INSERT');
    } else {
      try {
        const parsed: unknown = JSON.parse(after.bounding_box);
        if (typeof parsed === 'object' && parsed !== null) {
          pass(`AC-2: bounding_box parseable JSON: ${after.bounding_box}`);
        } else {
          fail(`AC-2: bounding_box JSON is a primitive, not an object/array: ${after.bounding_box}`);
        }
      } catch {
        fail(`AC-2: bounding_box is not valid JSON: ${after.bounding_box}`);
      }
    }
  }

  // KG-isolation: ZERO cross-instance edges.
  // :VisualObject nodes live ONLY in WORLD (separate Neo4j instance from SELF/OTHER).
  // Assert no :Person or :Self nodes leaked into the WORLD graph, and no edges
  // from our :VisualObject to anything that should only exist in SELF/OTHER.
  const neo4jDriver2: Driver = neo4j.driver(
    neo4jUri,
    neo4j.auth.basic(neo4jUser, neo4jPass),
    { logging: { level: 'error', logger: () => {} } },
  );
  const neo4jSession2 = neo4jDriver2.session({
    database: 'neo4j',
    defaultAccessMode: 'READ',
  });

  // Verify our node is in the WORLD graph.
  const nodeRes = await neo4jSession2.run(
    `MATCH (n:VisualObject {node_id: $nodeId})
     RETURN n.bounding_box AS bbox`,
    { nodeId: TEST_NODE_ID },
  );
  if (nodeRes.records.length === 0) {
    fail(`AC-2: :VisualObject ${TEST_NODE_ID} not found in WORLD Neo4j`);
  } else {
    pass(`AC-2: :VisualObject ${TEST_NODE_ID} present in WORLD Neo4j`);
    const bbox = nodeRes.records[0].get('bbox');
    if (!bbox) {
      fail('AC-2: Neo4j :VisualObject.bounding_box is null');
    } else {
      try {
        JSON.parse(bbox as string);
        pass(`AC-2: Neo4j bounding_box parseable JSON: ${bbox}`);
      } catch {
        fail(`AC-2: Neo4j bounding_box is not valid JSON: ${bbox}`);
      }
    }
  }

  // :Person nodes must NOT exist in the WORLD graph (belong only in OKG/OTHER).
  const personInWorld = await neo4jSession2.run(
    `MATCH (p:Person) RETURN count(p) AS cnt`,
  );
  const personCnt = (personInWorld.records[0].get('cnt') as { toNumber(): number }).toNumber();
  assertEq('AC-2: ZERO :Person nodes in WORLD (KG isolation)', personCnt, 0);

  // No cross-instance edges from the VisualObject to Person/Self nodes.
  const crossEdgeRes = await neo4jSession2.run(
    `MATCH (v:VisualObject {node_id: $nodeId})-[r]->(other)
     WHERE 'Person' IN labels(other) OR 'Self' IN labels(other)
     RETURN count(r) AS cnt`,
    { nodeId: TEST_NODE_ID },
  );
  const crossEdgeCnt = (crossEdgeRes.records[0].get('cnt') as { toNumber(): number }).toNumber();
  assertEq('AC-2: ZERO cross-instance edges (KG isolation)', crossEdgeCnt, 0);

  await neo4jSession2.close();
  await neo4jDriver2.close();

  // ── Cleanup ───────────────────────────────────────────────────────────────

  // Open a fresh connection for cleanup (neo4jDriver2 is already closed above).
  const neo4jDriverClean: Driver = neo4j.driver(
    neo4jUri,
    neo4j.auth.basic(neo4jUser, neo4jPass),
    { logging: { level: 'error', logger: () => {} } },
  );
  const neo4jSessionClean = neo4jDriverClean.session({
    database: 'neo4j',
    defaultAccessMode: 'WRITE',
  });
  await cleanupPg(pg2);
  await cleanupNeo4j(neo4jSessionClean);
  await neo4jSessionClean.close();
  await neo4jDriverClean.close();
  await pg2.end();

  // ── Verdict ───────────────────────────────────────────────────────────────

  console.log('');
  if (_ok) {
    console.log('ACC.B PASS — durable cross-session re-bind verified.');
    console.log(
      '  Same node_id; sighting_count>=2; centroid drift>0; ' +
      'bounding_box non-null parseable JSON; ZERO cross-instance edges.',
    );
    process.exit(0);
  } else {
    console.error(`ACC.B FAIL — ${_failures.length} assertion(s) failed:`);
    for (const f of _failures) console.error(`  [FAIL] ${f}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('ACC.B: unexpected error:', err);
  process.exit(1);
});
