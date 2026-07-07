# Migration plan — 20260702-016 Coordinated Sylphie Snapshot + tested restore

> Required for any change that touches a DB surface. Gate:
> `pipeline/policies/db-change-safety.md`.

## 1. Surfaces & impact class
- Stores touched: [x] postgres  [x] timescaledb  [x] neo4j-world  [x] neo4j-self  [x] neo4j-other
  (all five in-scope stores; `codebase-pkg-neo4j` is out of scope per the source doc's
  own "tooling only" classification, confirmed against `docker-compose.yml`.)
- Files/objects: **no tables, hypertables, Prisma models, node labels, constraints, or
  vector dims are created, dropped, renamed, or retyped by this feature.** The feature
  adds new *tooling* (`infra/snapshot/**`, `yarn snapshot:create` /
  `snapshot:restore:dry-run` / `:confirm`) that reads existing schemas (dump) and, on
  restore, rewrites existing tables/graphs with previously-dumped *content* — same
  shape, not a new shape. New artifacts introduced (`manifest.json`, per-file
  checksums, `tensor_manifest.json`) live in the snapshot output directory
  (`snapshots/<id>/…`) on disk, not in any database.
- Impact class: **additive** — this is new backup/restore *tooling*, not a schema
  change. The source's own "Database impact: yes" (source.md line 51-55) is read-write
  of *content*, not a `CREATE TABLE`/`ALTER TABLE`/column/index/vector-dim change
  anywhere in tickets -a through -e (confirmed against every ticket's scope in
  `plan.md` — none touch `infra/*/init/**`, `prisma/migrations/**`, or Neo4j
  constraint/index definitions).
- Contract decision authorizing it (if destructive): n/a — no destructive schema
  change proposed.

## 2. Forward migration (incremental path)
- Mechanism: **n/a — no schema migration.** The feature instead produces two new
  operational scripts under the existing `npx tsx infra/migrations/00N-*.ts
  [--confirm]` dry-run/confirm *convention* (not a numbered migration file itself):
  `yarn snapshot:create` (ticket -a, read-only in normal operation) and
  `yarn snapshot:restore:dry-run` / `yarn snapshot:restore:confirm <snapshot-id>`
  (ticket -d, the one write-capable path this feature adds).
- Summary of the change: create-side is read-only (dumps five stores + tensor/Fisher
  into a timestamped directory + manifest); restore-side rebuilds all five stores'
  *content* from a prior snapshot's dumps into **fresh/empty** store containers only
  (ticket -d's stated non_goal explicitly excludes restore-over-live-corrupted-data —
  that remains a manual, escape-hatch-gated operation per this same policy, not
  exercised by this feature's own tests).
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed — no ticket
  in `plan.md` touches `infra/postgres/init/**`, `infra/timescaledb/init/**`, or any
  Neo4j init/constraint script.

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no**
- If no — why it's safe (additive-only): restore rebuilds tables/graphs to their
  exact dumped shape via `pg_restore`/`neo4j-admin`/Timescale replay — no schema
  version bump, no column added, no re-embedding, no dimension change is part of this
  feature. (Ticket -b *adds* a new persisted artifact — EWC Fisher `.npz` — but that
  is a new **file on disk** in `tensor/fisher/`, not a database row/column; it closes
  a pre-existing silent gap in `Cycle.save_checkpoint()`, verified by reading
  `packages/cognition-service/inference/cycle.py:200-218`, which today saves
  `global_model`/`panel_models`/`convergence_model`/`deliberation` but never the
  `EWCRegularizer`'s in-memory `_fisher`/`_reference`/`_phase_fisher` NumPy arrays,
  confirmed by reading `packages/cognition-service/training/replay.py:82-185`.)

## 4. Backup + REVERSE
- Pre-write backup command: this feature *is* the backup mechanism (`pg_dump` for
  Postgres drive-state; `neo4j-admin database dump` or an online `apoc.export.cypher`
  fallback for WKG/SKG/OKG — ticket -a flags the Neo4j Community-edition offline-dump
  constraint as an implementation-level spike, see plan.md open question 2; a
  Timescale dump filtered to `timestamp <= watermark`, per plan.md verification note 6
  correcting the source's "event id" framing — `events.id` is `UUID NOT NULL`
  (confirmed by reading `infra/timescaledb/init/002-events.sql:8`), not a monotonic
  key, so the watermark is `MAX(timestamp)` on the hypertable's partition column
  instead).
- Backup-failure behavior: hard-stop (exit 1) before any write: [x] confirmed — ticket
  -a's acceptance criteria require the dump step to leave no partial/misleading
  "complete" snapshot on failure, and ticket -d's acceptance criteria require restore
  to verify every manifest checksum against on-disk dump files **before touching any
  store**, refusing to restore anything and exiting non-zero on any mismatch.
- REVERSE: for `snapshot:create` — n/a (read-only; nothing to reverse; failure paths
  always resume the quiesced system per ticket -a's explicit "never leave the system
  quiesced on an exception" acceptance criterion). For `snapshot:restore:*` — the
  restore target is always fresh/empty store containers (ticket -d's stated scope), so
  the "rollback" is simply not proceeding past the pre-restore checksum-verify gate;
  restoring in place over existing live data is out of scope for this feature and, if
  ever done by hand, falls under this same policy's auditable-approval escape hatch
  (`SYLPHIE_DB_CHANGE_APPROVED=1` / `.db-change-approved` marker citing a decision id),
  not this feature's automated path.

## 5. Continuity proof (the review-cog smoke)
- Seed data used: per-ticket smoke fixtures already specified in `plan.md`'s
  acceptance criteria — e.g. ticket -a's `.smoke.ts` seeding events before/after a
  captured watermark; ticket -d's `.smoke.ts` spinning up fresh throwaway store
  containers, running `snapshot:restore:confirm`, then diffing restored WKG/SKG/OKG
  node counts, drive values, event watermark, and tensor checkpoint hashes against the
  snapshot's own `manifest.json`.
- Steps: seed known state → `snapshot:create` → (simulate wipe by targeting fresh
  containers) → `snapshot:restore:confirm` → assert restored counts/values/hashes match
  the manifest exactly (ticket -d acceptance criterion 2, verbatim from source AC #3)
  → assert RLS + the `drive_rules_guardian_all` policy from the TK-154 lockdown
  (merged PR #86, `infra/migrations/002-drive-rules-lockdown.ts`) still exist
  post-restore (ticket -d acceptance criterion 4 — this is the one place a restore
  path could silently regress an existing, already-shipped DB security control, so it
  is explicitly checked).
- For index/constraint changes: n/a — no index/constraint changes ship in this
  feature.
- Result: to be produced by the build (this is a plan-stage document); the runnable
  checks proving each step are enumerated in `plan.md`'s per-ticket acceptance
  criteria (all runnable via `yarn` scripts / pytest / `.smoke.ts` per the repo's
  existing conventions — no bare `tsc`).

## 6. Sign-off
- `dbcheck` clean: [ ] — to be run by the refine/queue stage
  (`pipeline.py dbcheck 20260702-016`) once staged into a real item id in
  `contract.yaml`; this migration.md is the required artifact for that check to pass
  despite the item touching DB surfaces, since the impact class is additive tooling,
  not a schema change.
- Reviewed by sentinel: [ ] — `sentinel` is the proposed ticket owner for -a/-c/-d/-e
  per `plan.md`; review happens at build time, not plan time.
- Continuity smoke passed: [ ] — see acceptance criteria in `plan.md`, ticket -d in
  particular (the full restore-and-compare-to-manifest smoke).
- Approval marker used? **no** — no destructive schema change is proposed, so the
  `SYLPHIE_DB_CHANGE_APPROVED=1` / `.db-change-approved` escape hatch does not apply
  here. (It would apply, separately, to any future hand-invoked
  restore-over-live-data operation — explicitly out of scope for this feature, see §4.)
