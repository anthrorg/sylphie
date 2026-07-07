# Plan — 20260702-015: Schema versioning, migration framework, and boot/restore invariant checks

## Source verification (claims checked against actual code, not taken on faith)

| Source claim | Verified? | Evidence |
|---|---|---|
| "Neo4j has no enforced schema" / drift is silent | **Confirmed** | `pipeline/policies/db-change-safety.md` §"the databases": *"the three identity graphs have no migration framework... Treat every Neo4j structural change as a migration... even though there's no tool forcing the shape."* This is the house's own stated gap, not speculation. |
| `ProvenanceMissingError` catches *missing*, not *malformed*, values | **Confirmed** | `packages/shared/src/exceptions/specific.exceptions.ts:31-41` — the exception fires only when a write omits a provenance source (`operation` string + context); there is no shape/type validation path. |
| "Extend the existing Prisma discipline in `packages/shared` to Neo4j" | **Partially wrong — corrected below** | `packages/shared/prisma/migrations/` exists and is real (3 dated migrations + `migration_lock.toml`), but **Prisma has no Neo4j connector** — it is physically impossible to "extend Prisma" to a graph store. The repo already solved this a different way: `infra/migrations/NNN-*.ts` — a bespoke dry-run/`--confirm` TypeScript script convention, used live for `001-legacy-pattern-rescope.ts` and `002-drive-rules-lockdown.ts` (merged PR #86, 2026-07-03). **This existing convention — not Prisma — is the correct extension point for Neo4j/Timescale migrations.** Plan below builds on it rather than inventing a second pattern. |
| A migration *framework* (discovery + ordered apply) exists | **False — gap confirmed** | Root `package.json` has one **hand-named yarn-script pair per migration** (`migrate:legacy-rescope:dry-run/confirm`, `migrate:drive-rules-lockdown:dry-run/confirm/reverse-*/test/smoke` — lines 37-44). There is no generic "discover pending migrations for store X and apply in order" runner. This confirms the source's ask is real, not already done. |
| `ACTION_TYPE_DEFAULTS` exists and is checksummable | **Confirmed** | `packages/drive-engine/src/constants/rules.ts:80` — a real, named, exported constant. |
| "the veto logic" (paired with `ACTION_TYPE_DEFAULTS` in AC4) is a checksummable code object | **NOT confirmed — no such artifact found** | Repo-wide search for `veto` across `packages/**/*.ts` returns **zero hits** in decision-making or drive-engine (only unrelated frontend UI text). CANON's "no self-modification of evaluation" / guardian-asymmetry standards exist as *prose* (CLAUDE.md, architect-log.yaml), not as one identifiable checksummable code unit. **This is a real ambiguity — routed to `open_questions`, not guessed** (see below). |
| An existing boot-time-hook pattern to extend | **Confirmed, gives a concrete anchor** | `apps/sylphie/src/services/wkg-bootstrap.service.ts` — an `OnModuleInit` service already runs best-effort seeding/reset logic before request-serving, wired into `AppModule`. The new boot-guard/invariant-check services follow this exact pattern (new `OnModuleInit` provider(s), same lifecycle slot). |
| Dependency: **feature-snapshot-restore** must exist first | **Confirmed as stated, and currently unmet** | That work is pipeline item `20260702-016` (`feature-coordinated-sylphie-snapshot-tested-rest...`), **still sitting in `pipeline/planning/`** — not yet decomposed into any `contract.yaml` ticket. The manifest/checksum format this item's AC1 and invariant #1 need does not exist yet anywhere in the codebase or the contract. This is a genuine blocking dependency, not resolvable by this plan alone (see ticket 015-e). |

## Contract overlap check (`planning/contract.yaml`, read-only)

No existing epic or ticket covers schema versioning, a migration runner, boot-time invariant checks, or floor-integrity checksums. (A regex sweep for `schema_version|migration framework|floor.integrity|ACTION_TYPE_DEFAULTS` only matched the contract's own top-of-file `schema_version: "1.0"` metadata field and unrelated `DriveSnapshot`-type hits — false positives, not real overlap.) `existing_contract_overlap` is empty. This is genuinely new epic-level work.

Related-but-separate pipeline items (do not merge into this one):
- `20260702-016` (feature-snapshot-restore) — the manifest/restore path this item explicitly depends on. Still unplanned.
- `20260702-013` (observability-dashboard-snapshot-series) — a metrics/dashboard "snapshot series," unrelated despite the shared word "snapshot."
- No `feature-tensor-contract` item exists yet in the pipeline; the source's own non-goals correctly exclude tensor-shape handling from this item regardless.

## Design correction carried into the tickets

Drop "extend Prisma to Neo4j" from every ticket description — it's not implementable. Instead: **generalize the already-proven `infra/migrations/NNN-*.ts` dry-run/`--confirm` convention** (idempotent, backs up before write, documents a reverse, traces to a `DEC-*`) into a discoverable runner, per `pipeline/policies/db-change-safety.md`'s "house convention." Postgres keeps using Prisma (already has its own version tracking via `_prisma_migrations`) — it needs no new schema_version stamp, only wiring so the boot guard can read Prisma's applied-migration state alongside the Neo4j/Timescale stamps.

## Epic

**EP (working id) 20260702-015**: Schema versioning, migration framework, and boot/restore invariant checks
Priority: P0 (source argues P0 explicitly — silent data-shape corruption that compounds into poisoned learning; CANON Std-6 tie-in on the floor-integrity piece). Engineering level: production.

### Ticket 20260702-015-a — Migration runner framework (Neo4j + TimescaleDB)
**Priority:** P0 · **Engineering level:** production · **depends_on:** none

Generalizes the existing `infra/migrations/NNN-*.ts` convention (proven by `001-legacy-pattern-rescope.ts`, `002-drive-rules-lockdown.ts`) into a runner that discovers pending migrations for a target store, applies them in ascending version order, and bumps a `schema_version` stamp — replacing the current one-hand-named-yarn-script-per-migration pattern (`package.json:37-44`).

Acceptance criteria (each with a runnable check):
1. Given two migration scripts declaring `fromVersion: 1, toVersion: 2` and `fromVersion: 2, toVersion: 3` for the same store, when the runner is invoked in dry-run mode (default, no `--confirm`), then it prints the pending-migration plan in order and performs zero writes (exit 0, DB state unchanged — asserted by a before/after row-count or node-count snapshot in the test).
2. Given the same two scripts, when the runner is invoked with `--confirm`, then both apply in order and the store's `schema_version` stamp ends at 3 (not 2, not skipped).
3. Given a runner invocation that has already applied to `toVersion: 3`, when the runner is invoked again with `--confirm`, then it is a no-op (0 migrations applied, stamp still 3) — proves idempotency by double-run, per AC2 of the source.
4. Given a migration script that changes existing node/row shape, when it applies, then a validation-pass hook runs immediately after and fails loud (non-zero exit, named error) if any existing node/row does not match the new shape — no read-time tolerance.

Non-goals: down-migrations (the source's own non-goal — snapshot restore is the undo path); a generic runner for Postgres (Prisma already owns that lane).

### Ticket 20260702-015-b — v1 backfill migration: stamp `schema_version` on WKG/SKG/OKG Neo4j + TimescaleDB
**Priority:** P0 · **Engineering level:** production · **depends_on:** [20260702-015-a]

Writes the first real migration using the 015-a framework: a `:SchemaVersion` singleton node in each of the three identity Neo4j stores (WKG/SKG/OKG — **not** PKG, the codebase graph, which the source's own reference doc `docs/future/sylphie-persistence-migration-plan.md` §1 table marks "Tooling only — rebuildable from source," so it is out of scope for identity-state versioning) and a `schema_version` row in TimescaleDB, both stamped `1`.

Acceptance criteria:
1. Given a WKG/SKG/OKG instance with no `:SchemaVersion` node, when the backfill migration runs with `--confirm`, then exactly one `:SchemaVersion {version: 1}` node exists per store (assert via a Cypher count query in the test).
2. Given a TimescaleDB instance with no `schema_version` row, when the backfill migration runs with `--confirm`, then exactly one row with `version = 1` exists.
3. Given the migration has already run, when it is re-run with `--confirm`, then it is a no-op (node/row count and value unchanged) — idempotency, per house convention.
4. Given the migration ran, when `yarn migrate:<name>:dry-run` is invoked with no `--confirm`, then it performs zero writes and prints the same plan whether run before or after the real apply (dry-run never has side effects).

Non-goals: PKG (codebase graph) versioning; any change to `infra/*/init/**` (would require the db-change-guard approval flow — not warranted for an additive metadata node).

### Ticket 20260702-015-c — Boot-time schema_version guard (refuse boot on unrecognized version)
**Priority:** P0 · **Engineering level:** production · **depends_on:** [20260702-015-b]

New `OnModuleInit` provider, following the existing `WkgBootstrapService` pattern (`apps/sylphie/src/services/wkg-bootstrap.service.ts`), wired into `AppModule` ahead of request-serving. Reads the `schema_version` stamp from each Neo4j/Timescale store (and Prisma's applied-migration state for Postgres) and compares against the highest version the running code ships.

Acceptance criteria:
1. Given a store stamped with a `schema_version` higher than any migration the running code recognizes, when the app boots, then a specific, named error (e.g. `SchemaVersionUnknownError`) is thrown identifying the store and the unexpected version, and the process exits non-zero before serving any request — no partial start (source AC1).
2. Given all stores stamped at a version the code recognizes, when the app boots, then boot proceeds normally (no false positive).
3. Given a store with a pending (not-yet-applied) migration the code *does* recognize, when the app boots, then boot does not silently proceed on the stale shape — it either applies the pending migration via 015-a's runner or refuses with a distinct "pending migration" error (pick one behavior; write the AC as whichever the ticket build settles on, but it must not be silent pass-through).

Non-goals: auto-applying migrations without an explicit `--confirm`-equivalent gate in production (avoid accidental live schema changes on every deploy) — this AC needs the specific behavior nailed down during ticket build, not guessed here; flagged in `open_questions`.

### Ticket 20260702-015-d — Boot-time invariant checks: referential integrity, schema conformance, drive-state sanity
**Priority:** P0 · **Engineering level:** production · **depends_on:** [20260702-015-b]

Implements invariants #2, #3, #4 from the source's acceptance list (cross-store referential integrity, Neo4j schema conformance, drive-state sanity). Explicitly does **not** need the snapshot manifest from item 016 — these are general boot-time health checks, not restore-specific.

Acceptance criteria:
1. Given an OKG person node referenced by a recent event that does not exist in OKG, when the invariant pass runs at boot, then it refuses to start the decision cycle and names the specific failed invariant (e.g. `dangling OKG reference: person=<id>`) — source AC3.
2. Given a WKG action procedure marked graduated by the tensor that no longer exists in WKG, when the invariant pass runs, then it refuses to start and names the dangling procedure reference.
3. Given a drive-state row with a value outside `[-10, +1]`, or `pressure > 12`, or a `NaN`, when the invariant pass runs, then it refuses to start and names the drive-sanity violation.
4. Given a Neo4j node that does not conform to the current `schema_version` shape (post 015-b), when the schema-conformance validation query runs, then it fails loud rather than being silently tolerated — source §3.3.
5. Given all four checks pass, when the invariant pass runs, then the decision cycle is allowed to start (no false positive).

Non-goals: tensor-contract match (source's own non-goal — separate feature, no `feature-tensor-contract` pipeline item exists yet either); checksum-against-manifest verification (split to 015-e — needs the snapshot manifest from item 016, which does not exist yet).

### Ticket 20260702-015-e — Checksum verification against the snapshot manifest
**Priority:** P0 · **Engineering level:** production · **depends_on:** [20260702-015-b] AND the (not-yet-planned) manifest/restore work in pipeline item `20260702-016`

**BLOCKED — not buildable yet.** Implements invariant #1 from the source (checksums match the snapshot manifest). The manifest format, checksum fields, and restore path this needs do not exist anywhere in the codebase or `contract.yaml` — item `20260702-016` is still sitting unplanned in `pipeline/planning/`. Written here as a placeholder ticket with acceptance criteria the refine/queue stage should **not** advance until 016 lands a manifest format:

1. Given a snapshot manifest with a checksum field per store dump, when a restore runs, then each restored store's actual content-hash is recomputed and compared to the manifest's recorded checksum; a mismatch on any store refuses to start the cycle and names which store's checksum failed (source AC3, checksum clause).

This ticket should stay parked (not queued) until item 016 produces a manifest schema to build against — sequencing this before 016 would mean guessing a manifest shape now and likely rebuilding it later.

### Ticket 20260702-015-f — Floor-integrity boot check: `ACTION_TYPE_DEFAULTS` checksum
**Priority:** P0 · **Engineering level:** production · **depends_on:** [20260702-015-c]

Scoped to the **one confirmed artifact** from source AC4 — `ACTION_TYPE_DEFAULTS` (`packages/drive-engine/src/constants/rules.ts:80`). The AC's paired "veto logic" checksum target has no corresponding named code object anywhere in the repo (verified — see table above) and is **not** guessed here; it is an `open_question` for `architect` to resolve before a follow-up ticket adds it.

Acceptance criteria:
1. Given the running code's `ACTION_TYPE_DEFAULTS` object, when the app boots, then its checksum (e.g. a stable JSON-stringify + hash) is computed and compared against a recorded expected checksum.
2. Given a byte of `ACTION_TYPE_DEFAULTS` is modified (test mutates a value in a copy, not the real file), when the boot check runs against that mutated copy, then boot refuses with a specific `FloorChecksumMismatchError` naming `ACTION_TYPE_DEFAULTS` — source AC4, scoped half.
3. Given `ACTION_TYPE_DEFAULTS` is unmodified, when the boot check runs, then boot proceeds (no false positive).

Non-goals (explicit, pending the open question): checksumming any "veto logic" object — deferred until architect names the concrete code unit that constitutes it.

## Non-goals (epic-wide, from source + verification)
- No down-migrations beyond restore-from-snapshot.
- No retro-migration of already-wiped historical state.
- No tensor-shape handling (separate, not-yet-planned feature).
- No edits to `infra/*/init/**` (would require the db-change-guard approval flow; not warranted here since all changes are additive metadata).
- No literal "extend Prisma to Neo4j" (technically impossible — corrected to extend the `infra/migrations/NNN-*.ts` convention instead).
- No PKG (codebase graph, port 7691) schema_version stamping — tooling-only, rebuildable from source per the source's own reference doc.

## Split recommendation
None needed within this item — it is internally coherent (all six tickets are one schema/migration/invariant concern). The two adjacent concerns (snapshot/restore manifest format, tensor contract) are correctly already separate pipeline items/features and should stay that way; do not fold them into this epic.

## Open questions (for architect — do not guess)
1. **What code object is "the veto logic" for CANON Std-6 floor-integrity purposes?** A repo-wide search for `veto` across `packages/**/*.ts` returns zero hits in decision-making/drive-engine. Candidates to rule on: the confidence-ceiling gate (0.60-until-guardian-confirmed enforcement), the guardian-asymmetry multiplier code, or some hard-stop/override path in the executor that isn't literally named "veto." Ticket 015-f is scoped to exclude this until answered.
2. **015-c's exact behavior on a *recognized-but-pending* migration at boot** (auto-apply vs refuse-and-require-manual-apply) — the source doesn't specify, and defaulting to auto-apply-on-every-boot risks an accidental live schema change on deploy; defaulting to refuse risks a boot deadlock in a fresh environment. Needs a ruling before 015-c's AC3 is finalized (currently written as "must not silently pass through," not as a specific chosen behavior).
3. **Sequencing with pipeline item 20260702-016** (feature-snapshot-restore): this item's ticket 015-e cannot be built until 016 lands a manifest/checksum format in the contract. Recommend 016 be planned and queued before 015-e is pulled off refine, even though 015-a/b/c/d/f can proceed independently now.
