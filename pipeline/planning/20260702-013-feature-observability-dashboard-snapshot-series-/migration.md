# Migration plan — 20260702-013 (Observability dashboard)

**Status: N/A — no database/schema surface.**

## Why this is genuinely n/a, not a false negative

Per `pipeline/policies/db-change-safety.md`, every item gets a deliberate note
even when the DB gate finds nothing, because the keyword scanner can false-positive
on prose (e.g. this source doc says "manifest", "schema_version", "TimescaleDB" —
all data-content words, not schema-change words).

Verified against the actual scope:

- **Backend module (ticket -a, -d, -e's backend touch):** read-only. It reads
  snapshot manifest files (JSON, written by the *separate* feature
  20260702-016/feature-snapshot-restore) and reads existing live stores
  (Postgres drive state, Timescale events, Neo4j graphs) through existing
  read-only service methods — no new tables, no new columns, no migrations, no
  `CREATE`/`ALTER`/`DROP` anywhere in this item's scope.
- **Frontend (tickets -b, -c, -f):** pure UI, zero DB surface.
- **The "auto-fire a milestone snapshot" trigger (ticket -e):** this item only
  wires a *call* into whatever operation item 20260702-016 exposes for taking a
  named snapshot — it does not implement the snapshot mechanism, and does not
  itself touch a database. If 016's snapshot-taking operation later needs a
  schema (e.g. a `snapshots` metadata table), that migration belongs to 016's
  own migration.md, not this one.
- Source's own "Database impact" section already self-reports "no" and the
  planning-stage verification (see plan.md) found no schema-owning code
  anywhere in this item's file scope (`frontend/**`, one new backend
  controller/service module).

**Conclusion:** `pipeline.py dbcheck` may keyword-flag this item on words like
"manifest"/"schema"/"TimescaleDB"; this note documents that as a false positive.
No migration required. If a future ticket under this epic turns out to need
persisted state (e.g. caching computed trend aggregates), that would need its own
migration.md at that time — not assumed here.
