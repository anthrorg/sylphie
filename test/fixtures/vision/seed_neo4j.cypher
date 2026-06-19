// =============================================================================
// TK-30 — ACC.FIXTURES: seed :VisualObject node for acceptance tests
// =============================================================================
//
// WHAT THIS DOES
//   MERGEs a single :VisualObject node into the WORLD Neo4j instance so that
//   acceptance tests can assert:
//     * provenance_type = 'SENSOR'
//     * confidence = 0.40  (AC-2)
//     * the node exists without error
//
// DESIGN NOTES
//   * Property shape mirrors the ON CREATE SET block in
//     visual-working-memory.service.ts (the MERGE that runs every observation).
//   * node_id is stable ('tk30-seed-mug-001') so repeated runs are idempotent
//     via MERGE semantics.
//   * synthetic = false — this is a test-fixture node, not a live-camera
//     synthetic:true node created by the T0.8 perception-reset path.  Tests
//     that verify the perception-reset path should use synthetic:true; these
//     seed rows are long-lived fixture data.
//   * bounding_box is stored as a JSON string (TEXT), byte-identical to the
//     TimescaleDB TEXT column written by vwm.service.ts.
//
// INSTANCE
//   WORLD Neo4j (bolt://localhost:7687, user neo4j / sylphie_world).
//   :VisualObject nodes live ONLY in WORLD (KG isolation invariant).
//
// APPLY
//   cypher-shell -a bolt://localhost:7687 -u neo4j -p sylphie_world \
//     --file test/fixtures/vision/seed_neo4j.cypher
//
//   or via the Neo4j Browser / Aura console.
// =============================================================================

MERGE (n:Entity:VisualObject {node_id: 'tk30-seed-mug-001'})
ON CREATE SET
  n.label             = 'mug',
  n.node_type         = 'VisualObject',
  n.schema_level      = 'instance',
  n.provenance_type   = 'SENSOR',
  n.confidence        = 0.40,
  n.discovered        = false,
  n.yolo_class        = 'mug',
  n.sighting_count    = 1,
  n.synthetic         = false,
  n.bounding_box      = '[[0.192,0.25],[0.577,0.583]]',
  n.dominant_colors   = null,
  n.object_crop_b64   = null,
  n.embedding_version = 2,
  n.created_at        = datetime()
RETURN n.node_id AS id, n.provenance_type AS provenance, n.confidence AS confidence;

// VERIFICATION (expected result):
//   id                    | provenance | confidence
//   ----------------------|------------|------------
//   "tk30-seed-mug-001"   | "SENSOR"   | 0.4
