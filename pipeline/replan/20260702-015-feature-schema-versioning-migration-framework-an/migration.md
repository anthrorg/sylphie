# Migration plan — 20260702-015 Schema versioning, migration framework, and boot/restore invariant checks

> Filled per `pipeline/policies/db-change-safety.md` and `migration-plan.template.md`.

## 1. Surfaces & impact class
- Stores touched: [ ] postgres (Prisma-owned, no new schema_version stamp needed — `_prisma_migrations` already tracks it)  [x] timescaledb  [x] neo4j-world  [x] neo4j-self  [x] neo4j-other
- Files/objects: a `:SchemaVersion {version: N}` singleton node in each of the three identity Neo4j stores (WKG/SKG/OKG — **not** PKG, which is tooling-only/rebuildable per the source's own reference doc); a `schema_version` metadata row in TimescaleDB. New generic runner code lives in `infra/migrations/` (TypeScript, no DB objects of its own beyond what each individual numbered migration creates).
- Impact class: **additive** — every change in this epic adds a new metadata node/row and a new migration-runner mechanism. Nothing drops, renames, retypes, or changes a dimension. No existing data is altered by the v1 backfill migration (015-b) beyond the addition of the stamp node/row itself.
- Contract decision authorizing it (if destructive): n/a — not destructive.

## 2. Forward migration (incremental path)
- Mechanism: `infra/migrations/NNN-*.ts` — generalizing the exact convention already proven live by `infra/migrations/001-legacy-pattern-rescope.ts` and `infra/migrations/002-drive-rules-lockdown.ts` (merged PR #86). **Not Prisma** for the Neo4j/Timescale side — Prisma has no Neo4j connector, so the source's "extend Prisma to Neo4j" wording is corrected in `plan.md` to mean "extend the same migration *discipline*," delivered via the house's own `NNN-*.ts` dry-run/`--confirm` pattern, not literally via Prisma.
- Summary of the change: ticket 015-a builds a generic runner (discover pending migrations for a store by declared `fromVersion`/`toVersion`, apply in order, run a post-apply validation pass, bump the stamp). Ticket 015-b is the first real migration built on that runner: it creates the `:SchemaVersion {version: 1}` node in WKG/SKG/OKG and the `schema_version = 1` row in TimescaleDB, dry-run by default, `--confirm` to apply, following the exact `yarn migrate:<name>:dry-run` / `:confirm` script-pair pattern already in root `package.json`.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed — no init-script edits anywhere in this epic; the guard would block it anyway.

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no**
- If no — why it's safe (additive-only): the v1 backfill migration (015-b) only **adds** a new singleton stamp node/row per store; it does not touch, rewrite, or reinterpret any existing WKG/SKG/OKG node or Timescale row. Later migrations built on the 015-a framework (post-v1, out of this epic's immediate scope) may need real backfills when they change existing node shapes — those future migrations each get their own `migration.md` per this same policy when they're planned; this epic only builds the *mechanism* plus the zero-risk v1 stamp.

## 4. Backup + REVERSE
- Pre-write backup command: each `NNN-*.ts` migration script backs up before any write per the house convention (`neo4j-admin database dump` for the three Neo4j stores; the existing Timescale/pg backup path used by `002-drive-rules-lockdown.ts` for its Postgres-adjacent work). Ticket 015-a's runner enforces this as a required hook every migration script must call before writing — a migration without a backup step fails the runner's own pre-flight check.
- Backup-failure behavior: hard-stop (exit 1) before any write: [x] confirmed (carried over from the house convention documented in `db-change-safety.md`).
- REVERSE: the v1 stamp node/row can simply be deleted (a `DETACH DELETE` on the single `:SchemaVersion` node, or a `DELETE FROM schema_version` row) with zero data loss elsewhere, since nothing else was touched — but per policy the documented REVERSE for any 015-a-framework migration is "restore from the pre-migration backup taken in step above," not a hand-rolled undo query, to stay consistent with the epic's stated non-goal ("no down-migrations beyond restore-from-snapshot — milestone snapshots are the undo path").

## 5. Continuity proof (the review-cog smoke)
- Seed data used: a test WKG/SKG/OKG instance and a test TimescaleDB instance with representative pre-existing nodes/rows (from the existing test fixtures used by `002-drive-rules-lockdown.spec.ts`/`.smoke.ts` as a pattern to follow).
- Steps: seed → run the 015-b migration dry-run (assert zero writes, plan printed) → run with `--confirm` (assert stamp created, pre-existing seeded nodes/rows byte-for-byte unchanged by count and spot-check) → re-run with `--confirm` (assert no-op / idempotent) → (no rollback path exercised beyond backup-restore, per REVERSE above).
- For index/constraint changes: n/a — this epic adds no index or constraint, only a metadata node/row.
- Result: to be produced during the build ticket (015-b), following the existing `.spec.ts`/`.smoke.ts` pattern from `002-drive-rules-lockdown`; this plan records the *proof obligation*, not yet a result (item is still in planning, pre-build).

## 6. Sign-off
- `dbcheck` clean: [ ] (to be run by the plan/refine cog on this item)
- reviewed by sentinel: [ ] (sentinel owns `infra/**` per CLAUDE.md's work-trio table — required before 015-a/b are built)
- continuity smoke passed: [ ] (produced during 015-b's build, per §5 above)
- Approval marker used? **no** — nothing here is destructive; the `.db-change-approved` escape hatch is not needed.
