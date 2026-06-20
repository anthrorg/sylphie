-- =============================================================================
-- TK-30 — ACC.FIXTURES: seed row for visual_object_embeddings
-- =============================================================================
--
-- WHAT THIS DOES
--   Inserts one deterministic row into ``visual_object_embeddings`` so that
--   acceptance tests can assert:
--     * a 768-D DINOv2-base embedding is stored (matches the P3.1 vector dim)
--     * a JSON bounding_box column is populated (AC-2)
--     * confidence = 0.40 (the system default for unconfirmed observations)
--
-- DESIGN NOTES
--   * The embedding vector is the same deterministic pattern used by
--     centroid-db-smoke.cjs: dim_i % 10 / 10 -- pure arithmetic, no randomness,
--     byte-identical on every run.
--   * bounding_box is stored as a JSON string (TEXT column), matching the
--     byte-for-byte format written by visual-working-memory.service.ts.
--   * embedding_version = 2 -> DINOv2-base-768 (P3.1 convention).
--   * The row id is a stable literal so ON CONFLICT DO NOTHING is idempotent;
--     applying this script twice is safe.
--
-- PRECONDITION
--   The backend must have been started at least once so ensureSchema() has
--   run and created visual_object_embeddings (+ the bounding_box additive
--   column).  This script does NOT create the table.
--
-- CONNECTION (defaults; override via env)
--   host=localhost port=5433 db=sylphie_events user=sylphie pw=sylphie_events_dev
--
--   e.g.  psql "postgresql://sylphie:sylphie_events_dev@localhost:5433/sylphie_events" --               -v ON_ERROR_STOP=1 -f test/fixtures/vision/seed_timescale.sql
-- =============================================================================

BEGIN;

INSERT INTO visual_object_embeddings
  (id, node_id, label, embedding, confidence, discovered, created_at,
   bounding_box, dominant_colors, object_crop_b64, embedding_version)
VALUES (
  'tk30-seed-mug-001',
  'tk30-wkg-mug-001',
  'mug',
  -- 768-D DINOv2-base-768 deterministic vector: dim_i % 10 / 10
  '[0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7]'::vector,
  0.40,
  false,
  NOW(),
  -- bounding_box as JSON string (TEXT), matching vwm.service.ts serialization
  '[[0.192,0.25],[0.577,0.583]]',
  -- dominant_colors: null (not required by AC)
  NULL,
  -- object_crop_b64: null (not required by AC)
  NULL,
  -- embedding_version = 2 (P3.1 DINOv2-base-768)
  2
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- VERIFICATION (run after COMMIT to confirm the row landed):
--   SELECT id, label, confidence,
--          array_length(embedding::real[], 1) AS embedding_dims,
--          bounding_box
--   FROM visual_object_embeddings
--   WHERE id = 'tk30-seed-mug-001';
--
--   Expected: id=tk30-seed-mug-001, label=mug, confidence=0.4,
--             embedding_dims=768, bounding_box='[[0.192,0.25],[0.577,0.583]]'
