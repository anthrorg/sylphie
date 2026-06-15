-- =============================================================================
-- P3.1 — DINOv2-base destructive object-embedding migration (vector(1280) → 768)
-- =============================================================================
--
-- WHAT THIS DOES
--   Re-keys the `visual_object_embeddings.embedding` column from the legacy
--   1280-D EfficientNet-B0 space to the new 768-D DINOv2-base CLS space. The
--   dims are incompatible (and pgvector rejects mixed-dim columns), so this is a
--   FROZEN + VERSIONED + MIGRATION-GATED phase transition — never online drift.
--
--   Because objects do NOT retain a re-embeddable crop in this column's history
--   (only the WORLD node carries object_crop_b64, and re-embedding is out of
--   scope for P3.1), the only correct migration is DROP-then-ADD: the new column
--   starts NULL on every existing row. The legacy rows are then a clean recall
--   MISS, not a silent corrupted HIT — exactly the stability contract.
--
-- WHY DROP-THEN-ADD (not add-`_v3`-then-rename)
--   atlas correction: with a clean-missing column (we are NOT preserving any
--   1280-D data) a straight drop-then-add has fewer failure surfaces than
--   adding a parallel `embedding_v3` column and renaming. There is nothing to
--   copy across, so the rename dance buys nothing.
--
-- LEGACY ROWS (the 2 pre-P3.1 rows on Jim's live DB)
--   Their `embedding` becomes NULL (the new column starts NULL). They KEEP
--   `embedding_version = 1` — do NOT null embedding_version. The version guard
--   in visual-working-memory.service.ts already refuses to fold a v2 (DINOv2)
--   observation into a v1 row, and the candidate SELECT's `WHERE embedding IS
--   NOT NULL` clause excludes these NULLed rows from re-ID entirely until they
--   are re-observed and re-inserted as v2. (That `WHERE embedding IS NOT NULL`
--   is load-bearing here and is intentionally retained — the fold version-guard
--   alone does NOT exclude a NULL-embedding row from the cosine candidate set.)
--
-- THE IVFFLAT INDEX
--   `visual_object_embedding_idx` (ivfflat, vector_cosine_ops) is dropped here
--   because it is bound to the old column. It is NOT recreated in this script:
--   ensureSchema() recreates it idempotently (CREATE INDEX IF NOT EXISTS, inside
--   a try/catch) on the next backend boot, and ivfflat needs enough 768-D rows
--   to build its lists anyway — so it is correctly deferred until real DINOv2
--   rows accumulate. There is intentionally NO throwing rebuild in this script.
--
-- =============================================================================
-- OPERATIONAL PRECONDITION (HARD — coordinator-run, NOT auto-run)
--   This is DESTRUCTIVE and must run in a COORDINATED STACK-DOWN WINDOW:
--     1. Stop the NestJS app (apps/sylphie) so no /detect write races this DDL.
--        ensureSchema() does NOT and MUST NOT run this — auto-destructive on
--        restart is dangerous (atlas). This is a deliberate, manual, one-time op.
--     2. Run this script against the TimescaleDB instance (sylphie_events).
--     3. Restart the app — ensureSchema() sees vector(768) already present
--        (its CREATE is IF NOT EXISTS, so it is a no-op on the existing table)
--        and (re)creates the deferred indexes as rows accumulate.
--
--   Connection (matches centroid-db-smoke.cjs defaults; override via env):
--     host=localhost port=5433 db=sylphie_events user=sylphie pw=sylphie_events_dev
--   e.g.  psql "postgresql://sylphie:sylphie_events_dev@localhost:5433/sylphie_events" \
--              -v ON_ERROR_STOP=1 -f test/fixtures/vision/p3.1-dinov2-migration.sql
--
--   Run the scratch-DB migration test FIRST (coordinator) before touching live.
-- =============================================================================

BEGIN;

-- Drop the ivfflat index bound to the old 1280-D column (recreated by
-- ensureSchema as 768-D rows accumulate — see header).
DROP INDEX IF EXISTS visual_object_embedding_idx;

-- The re-key itself: drop the 1280-D column, add it back as 768-D. The new
-- column starts NULL on every existing row (the legacy 1280-D vectors are gone,
-- by design — there is nothing to migrate forward). embedding_version is left
-- UNTOUCHED, so the legacy rows keep version 1 and are excluded from re-ID by
-- the `WHERE embedding IS NOT NULL` candidate clause.
ALTER TABLE visual_object_embeddings DROP COLUMN embedding;
ALTER TABLE visual_object_embeddings ADD COLUMN embedding vector(768);

-- NOTE: `UPDATE visual_object_embeddings SET embedding = NULL` is IMPLICIT — a
-- freshly-added column is NULL on all existing rows, so an explicit UPDATE is
-- unnecessary (and a no-op). Left here as documentation of the intended end
-- state: every pre-existing row has embedding = NULL, embedding_version = 1.

COMMIT;

-- POST-MIGRATION SANITY (run manually after COMMIT; not part of the txn):
--   -- column is now 768-D:
--   SELECT atttypmod FROM pg_attribute
--     WHERE attrelid = 'visual_object_embeddings'::regclass AND attname = 'embedding';
--   -- legacy rows: embedding NULL, version still 1:
--   SELECT count(*) AS legacy_nulled
--     FROM visual_object_embeddings
--     WHERE embedding IS NULL AND embedding_version = 1;
