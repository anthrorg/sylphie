# Plan — 20260702-016: Coordinated Sylphie Snapshot + tested restore (5 stores + metrics)

## Source verification (against actual code, not the doc's framing)

Read in full: `docs/future/sylphie-persistence-migration-plan.md` (§1-§7),
`docs/future/sylphie-observability-spec.md` (§1, Part 3). Verified against source:

1. **Store inventory confirmed.** `docker-compose.yml` shows exactly the five stores
   the source (and its "all five stores" title) actually mean once PKG is excluded:
   `neo4j-world` (WKG, 7687), `neo4j-self` (SKG, 7690), `neo4j-other` (OKG, 7689),
   `postgres` (drive state, 5434, db `sylphie_system`), `timescaledb` (event log, 5433,
   db `sylphie_events`). `codebase-pkg-neo4j` (PKG, 7691) is correctly excluded — the
   migration-plan doc's own table calls it "tooling only — rebuildable from source."
   Tensor weights + EWC Fisher are additional artifacts riding alongside the five
   store dumps, not a sixth "store" — acceptance criterion 1's wording ("all five
   store dumps, tensor weights + Fisher") is internally consistent with this reading.
   The source's Why-section phrase "four Neo4j graphs" (counting PKG in) is loose but
   harmless since the acceptance criteria and scope hints correctly scope PKG out.

2. **Zero existing snapshot/backup/restore tooling.** Verified via glob/grep across
   the repo: no `infra/neo4j/`, no docker-compose backup service, no `pg_dump`/
   `neo4j-admin dump` script, no snapshot directory format anywhere. `infra/migrations/`
   only has the two one-shot data migrations (001 legacy-rescope, 002 drive-rules-
   lockdown). This is a fully greenfield build — nothing to reuse except conventions
   (the `npx tsx infra/migrations/00N-*.ts [--confirm]` dry-run/confirm pattern, and
   the paired `.spec.ts`/`.smoke.ts` test convention from 002).

3. **"You already have a concurrency guard / epoch fence — reuse it" — TRUE but
   incomplete.** Read `packages/decision-making/src/concurrency/cycle-guard.service.ts`
   in full. `CycleGuardService` is real and does exactly what's described (two-lane
   FIFO admission, `tickInFlight` mutex, monotonic `cycleEpoch`, watchdog). But it has
   **no existing "pause admission for an external reason" API** — it only pauses
   organically between turns. A quiesce-for-snapshot capability (block `enqueue`/
   `drainNext` from starting a new turn, wait for `tickInFlight` to clear, resume) is
   a small **additive** method that must be built, not something that already exists
   to "reuse" verbatim. Ticket -a scopes this precisely.

4. **Drive isolation gap in the source's coordination protocol.** `CycleGuardService`
   lives in `packages/decision-making` and only governs the decision-cycle process.
   Drive state (Postgres, port 5434) is written by the **separate** drive-engine
   process's own 100Hz tick loop, which `CycleGuardService` does not touch. Per CANON
   drive isolation, the coordinator cannot RPC/pull into the drive process to pause it
   — it must **push** a quiesce request event and wait for a **pushed-back**
   acknowledgment, mirroring the existing one-way event patterns already used for
   drive telemetry (`DrivePublisher`) and inbound drive events. This is resolvable
   within existing patterns (not a novel mechanism) and is written into ticket -a's
   acceptance criteria as an explicit constraint, so it doesn't need to become an
   open_question — but it is flagged here because it's the one place a builder could
   accidentally introduce an RPC/pull path while "just reusing the guard."

5. **EWC Fisher anchors are NOT currently persisted anywhere — real gap, not just
   scope.** Read `packages/cognition-service/training/replay.py` and
   `packages/cognition-service/inference/cycle.py` in full.
   `EWCRegularizer._fisher` / `._phase_fisher` are in-memory NumPy arrays on the
   `Trainer`'s `_ewc` instance. `Cycle.save_checkpoint()` (cycle.py:200-218) saves
   `global_model`, `panel_models`, `convergence_model`, `deliberation` — **it never
   touches `_ewc`**. So today, a process restart already silently loses all EWC
   state; the source's framing ("EWC Fisher anchors always travel with weights...
   `tensor/fisher/` is non-optional") describes a *target* state, not something that
   exists to be dumped. Ticket -b must **add** Fisher save/load, not just copy an
   existing file. This is exactly the kind of silent-gap the source doc is trying to
   close, so it belongs in this feature rather than being deferred.

6. **The "TimescaleDB event-id watermark" claim needs a correction.** Read
   `infra/timescaledb/init/002-events.sql` in full: `events.id` is `UUID NOT NULL` —
   not a monotonic sequence/bigserial. UUIDs have no natural ordering, so "record the
   latest event id as the logical clock" as literally stated does not work. The
   watermark must be `MAX(timestamp)` (the hypertable's partition column,
   `TIMESTAMPTZ`), optionally paired with the `id` of the last row at that timestamp
   for exact-boundary tie-breaking. Ticket -a's acceptance criteria are written
   against `timestamp`, not `id`.

7. **Guardian/RLS interaction with restore.** `infra/migrations/002-drive-rules-
   lockdown.ts` (merged, PR #86) put RLS + a `guardian_admin` role on `drive_rules`/
   `proposed_drive_rules`. A `pg_dump`/`pg_restore` of the Postgres drive-state store
   run as the Postgres superuser bypasses RLS (expected, standard pg_dump behavior)
   but restoring the *role/policy definitions themselves* must not silently regress
   the TK-154 lockdown. Ticket -d's acceptance criteria include an explicit check
   that RLS + the guardian policy still exist post-restore.

8. **Cadence claim has no runnable acceptance criterion in the source.** The "What it
   should do" section describes automated rolling snapshots + a retention ladder +
   never-deleted milestone snapshots, but none of the source's 5 numbered acceptance
   criteria test this — all 5 are about the snapshot/restore mechanism itself. Ticket
   -e supplies its own Given/When/Then for the ladder + milestone-retention logic
   (testable on a fake clock, no live scheduler needed for the test).

9. **Conflict note re: "bug-audit-drive-engine"** — could not find a pipeline item by
   that name/slug currently in any state folder (checked `pipeline.py list`). It most
   likely refers to work already merged as item `20260625-002` / TK-154 / TK-155
   (drive_rules lockdown, PR #86, merged 2026-07-03) which did touch
   `infra/postgres/init/**`. That conflict has already resolved itself by landing
   first; no live sequencing hazard remains, but flagging in case another still-open
   item uses a different id/slug for the same territory.

## Existing contract overlap

Checked `planning/contract.yaml` (read-only) for existing epics touching persistence/
snapshot/backup/restore/tensor-checkpoint work. **No existing epic or ticket owns this
feature.** `EP-27` (`Codebase audit remediation... CANON Std-6 drive_rules lockdown`) is
the nearest neighbor by *territory* (`infra/postgres/init/**`, TK-154/155) but is a
different concern (RLS lockdown, already merged) — not a clone target. `infra/
migrations/001`/`002` are one-shot data migrations, not backup/restore infrastructure.
This plan proposes a **new epic**.

## Proposed epic

**EP-NEW (working id `20260702-016-EP`) — "Coordinated Sylphie Snapshot + tested
restore across all five stores"**, parent `FEAT-3` (or a new persistence-track feature
if Jim wants one — flagged as a light open question below, does not block staging).

Owner: `sentinel` (infra/DB), with `meridian` co-owning the tensor-checkpoint ticket
(-b, `packages/cognition-service/**`) and `cortex` consulted on the decision-cycle
quiesce hook (-a touches `packages/decision-making/src/concurrency/**`). Conceptual
reviewer: `ashby` (sentinel's default) for -a/-c/-d/-e; `luria` for -b (cognition-
service's conceptual reviewer per the ownership table — corrected from the source's
scope-hint suggestion, which didn't name one for the tensor piece).

## Tickets

### 20260702-016-a — Snapshot core: quiesce protocol + watermark + all-five-store dump + manifest + checksums

**Priority:** P0 (data-loss prevention — root of the persistence chain; nothing else
in this epic or its dependents works without this).
**Engineering level:** production.
**Depends on:** none.
**Owner:** `sentinel`. Conceptual reviewer: `ashby`. Touches
`packages/decision-making/src/concurrency/cycle-guard.service.ts` (additive method
only) and a new `infra/snapshot/` tree.

Scope: a `yarn snapshot:create` command that:
- Adds an additive `quiesce()`/`resume()` pair to `CycleGuardService` (block new
  admission, wait for `tickInFlight` to clear, no change to existing mutex/epoch/
  watchdog behavior for turns already admitted).
- Pushes a `SNAPSHOT_QUIESCE_REQUEST` event into the drive-engine process and awaits
  its pushed-back `SNAPSHOT_QUIESCED` acknowledgment (never an RPC/pull into drive —
  CANON drive isolation) before touching the drive-state Postgres store.
- Records the watermark as `MAX(timestamp)` over `events` (TimescaleDB), not an
  "event id" (see verification note 6).
- Dumps WKG/SKG/OKG via `neo4j-admin database dump` (or equivalent bolt-based export
  if `neo4j-admin` isn't available in the running container) into `neo4j/{wkg,skg,
  okg}.dump`; `pg_dump` for drive state into `postgres/drive_state.sql`; a Timescale
  dump filtered to `timestamp <= watermark` into `timescale/events.dump`.
- Writes `manifest.json` (snapshot id, UTC timestamp, code git SHA, `schema_version`
  placeholder int, watermark) and a checksum (sha256) per file.
- Resumes the drive-engine (push `SNAPSHOT_RESUME` event) and the decision cycle
  (`resume()`) unconditionally, including on dump failure (never leave the system
  quiesced on an exception).

Non_goals: tensor/Fisher dump (ticket -b), metrics block (ticket -c), restore (ticket
-d), automated cadence/retention (ticket -e), any schema-version migration framework.

Acceptance criteria:
- Given a running docker-compose stack (all five store containers healthy), when
  `yarn snapshot:create` runs, then a timestamped snapshot directory exists under
  `snapshots/` containing `manifest.json`, one checksum per dumped file, and non-empty
  dump files for all five stores. *Runnable check:* `yarn snapshot:create` against the
  dev compose stack, then assert (via a `.smoke.ts`, mirroring the 002-drive-rules-
  lockdown.smoke.ts convention) that all 5 dump files + manifest exist and are
  non-empty, and every checksum in the manifest matches a fresh sha256 of its file.
- Given the decision cycle has an admitted turn in flight, when `quiesce()` is called,
  then it does not resolve until that turn's `tickInFlight` clears (no new turn is
  admitted meanwhile). *Runnable check:* `cycle-guard.service.spec.ts` unit test —
  enqueue a turn with a controllable async runner, call `quiesce()`, assert the
  promise is still pending while the runner hasn't resolved, then resolves once it
  does, and a turn enqueued during the pending quiesce is not drained until `resume()`.
- Given a quiesce is requested, when the drive-engine has not yet acknowledged
  `SNAPSHOT_QUIESCED`, then no Postgres dump of drive state begins. *Runnable check:*
  unit test on the snapshot orchestrator with a fake drive-engine event channel that
  delays the ack; assert `pg_dump` invocation happens strictly after the ack event is
  observed.
- Given events are being written to the `events` hypertable during the quiesce
  window (a background writer fixture), when the snapshot completes, then every event
  with `timestamp <= watermark` is in the Timescale dump and every event with
  `timestamp > watermark` is not — no torn set. *Runnable check:* integration test
  against the dev TimescaleDB container: seed rows before/after a captured watermark,
  run the dump-to-watermark step, assert row membership by timestamp boundary.
- Given the dump step throws (simulate a failed `pg_dump`), when `snapshot:create`
  exits, then `resume()` and the drive-engine `SNAPSHOT_RESUME` push have still fired
  (system is never left paused). *Runnable check:* unit test with a stubbed dumper
  that rejects; assert both resume paths were called exactly once.

### 20260702-016-b — Tensor checkpoint + EWC Fisher persistence (save + load), wired into the snapshot manifest

**Priority:** P0 (Fisher loss on restart already happens today silently; leaving this
out of the snapshot means every restore silently reintroduces catastrophic forgetting
risk — this is exactly the failure mode the feature exists to close).
**Engineering level:** production.
**Depends on:** 20260702-016-a (needs the manifest/checksum harness to attach to).
**Owner:** `meridian` (`packages/cognition-service/**`). Conceptual reviewer: `luria`.

Scope:
- Add `EWCRegularizer.save(path)` / `.load(path)` (NumPy `.npz`, one array per
  parameter tensor for `_fisher`, `_reference`, and `_phase_fisher` when present).
- Wire `Cycle.save_checkpoint()` to also call `trainer.ewc.save(base + "/fisher")`
  so a normal checkpoint now includes Fisher (closes the pre-existing gap in
  verification note 5, independent of snapshotting — this alone is a correctness fix).
- Add a `tensor_manifest.json` (arch version, param counts, bootstrap stage per
  category) per the migration-plan doc's §2 format, written alongside the fisher/
  weights dump.
- Extend the snapshot orchestrator (ticket -a's `infra/snapshot/`) to copy
  `WEIGHTS_DIR` (global/panels/convergence/deliberation) + the new fisher `.npz` +
  `tensor_manifest.json` into the snapshot dir's `tensor/weights/` and `tensor/fisher/`
  and checksum them into the same `manifest.json`.

Non_goals: no change to EWC math/blending logic, no architecture/input-contract
versioning framework (source non-goal), no metrics.

Acceptance criteria:
- Given a `Trainer` with `_fisher` and `_reference` populated (a `compute_fisher()` +
  `set_reference()` pass has run), when `ewc.save(path)` then a fresh `EWCRegularizer`
  `.load(path)` runs, then the loaded `_fisher`/`_reference` arrays are numerically
  identical (assert `np.array_equal` per array). *Runnable check:*
  `packages/cognition-service/training/tests/test_ewc_persistence.py` (new), run via
  the existing pytest harness.
- Given `Cycle.save_checkpoint()` is called after a `compute_fisher()`/
  `set_reference()` pass, when the weights directory is inspected, then a
  `fisher/` subdirectory exists with a non-empty `.npz`. *Runnable check:* extend
  `test_tf_training.py` or add a focused checkpoint test asserting the file exists
  post-call.
- Given `yarn snapshot:create` runs (ticket -a's orchestrator, cognition-service
  reachable), when the snapshot completes, then `tensor/fisher/` is present in the
  snapshot dir and is non-optional — the snapshot **fails loud** (non-zero exit,
  no partial snapshot left behind as "complete") if the fisher directory is missing
  or empty, never silently omitted. *Runnable check:* `.smoke.ts` asserting a snapshot
  run against a cognition-service with no prior fisher save exits non-zero with a
  named error, and a run after a save succeeds and includes the directory.

### 20260702-016-c — Metrics block computed during the quiesce window, written into the manifest

**Priority:** P1 (not data-loss-critical by itself — it's an observability payload —
but the source's own framing that "the early growth curve is lost forever" if this
ships late is real, so it should not slip far behind -a/-b; kept below P0 because a
snapshot without a metrics block is still a valid, restorable backup).
**Engineering level:** production.
**Depends on:** 20260702-016-a.
**Owner:** `sentinel` (cross-store read-only aggregate queries). Conceptual reviewer:
`ashby`.

Scope: implement the `metrics` block exactly per `docs/future/sylphie-observability-
spec.md` §1 (graduation, knowledge, health, experience, integrity, plus top-level
`uptime_since_last_wipe_hours`), computed as cheap aggregate queries (counts, not
scans) against the five stores during the already-quiesced window from ticket -a, and
written into `manifest.json` alongside the store/tensor sections.

Non_goals: no dashboard/page (explicit source non-goal, and Part 2 of the
observability spec is out of scope for this item entirely), no new live-metrics
endpoint, no historical-trend storage beyond what's already in the manifest series.

Acceptance criteria:
- Given a running system with known WKG/SKG/OKG/event/drive state, when
  `snapshot:create` runs, then `manifest.json.metrics` contains every field named in
  the observability spec §1 schema (graduation, knowledge, health, experience,
  integrity, `uptime_since_last_wipe_hours`) with no field silently omitted or
  hardcoded to a placeholder. *Runnable check:* a schema-shape test asserting every
  key path from the spec's JSON example exists in the produced manifest (a JSON-schema
  or deep-key-list assertion in a `.spec.ts`/`.smoke.ts`).
- Given a fresh docker-compose stack with a handful of seeded WKG nodes and drive-rule
  overrides, when the metrics block is computed, then `knowledge.wkg_nodes_total`,
  `health.drives.*`, and `experience.events_total` match hand-verified counts from
  direct queries against the same seeded stores (not derived from cached/stale state).
  *Runnable check:* integration test seeding known counts then asserting exact
  equality against the manifest's computed values.
- Given the metrics computation queries fail for one store (simulate a Neo4j query
  timeout), when `snapshot:create` runs, then the snapshot **fails loud** rather than
  writing a manifest with silently-zeroed metrics (CANON theater prohibition — no
  fabricated/placeholder metric values ever ship in a "successful" snapshot).
  *Runnable check:* unit test with a stubbed failing query; assert non-zero exit and
  no manifest file is left marked complete.

### 20260702-016-d — Restore: rebuild all five stores + tensor/Fisher from a snapshot, verify checksums, boot invariant check

**Priority:** P0 (per the source's own "a backup you've never restored is a
hypothesis, not a backup" — untested restore is the actual risk this whole feature
exists to close).
**Engineering level:** production.
**Depends on:** 20260702-016-a, 20260702-016-b, 20260702-016-c (restore verifies the
full manifest shape all three previous tickets produce).
**Owner:** `sentinel`. Conceptual reviewer: `ashby`.

Scope: `yarn snapshot:restore:dry-run` / `yarn snapshot:restore:confirm <snapshot-id>`
(mirroring the existing `migrate:*:dry-run`/`:confirm` convention) that:
- Verifies every checksum in the manifest against the on-disk dump files before
  touching any store (fail loud on mismatch, restore nothing).
- Rebuilds WKG/SKG/OKG from their Neo4j dumps, restores drive-state Postgres via
  `pg_restore`/`psql` run with sufficient privilege to satisfy the TK-154 RLS/
  guardian-policy objects (verification note 7) — never as the RLS-restricted
  `sylphie_app` role — and restores Timescale events up to the watermark.
- Restores tensor weights + Fisher (`tensor/fisher/` required — refuses to boot
  against a snapshot missing it, per source §4.4/ticket -b).
- Runs a minimal post-restore invariant subset needed to prove AC #2/#3 below:
  checksum-verify, cross-store referential integrity (no dangling provenance is a
  fuller check — deferred; here it's "counts match manifest" only), drive-value
  sanity range check, and confirms RLS + `drive_rules_guardian_all` policy still
  exist on `drive_rules` post-restore.
- Only ever human-invoked (`--confirm` required to write; dry-run is the default,
  matching the source's "explicit, Jim-approved operation, never autonomous"
  requirement and the repo's db-change-guard discipline).

Non_goals: full §5 invariant suite (schema-conformance-per-node, full referential
integrity) — deferred to the separate observability/schema-versioning features the
source itself defers; autonomous/scheduled restore; restore-over-live-corrupted-data
(only tested against empty/fresh store containers, matching the source's own AC
wording — restoring in place over existing data is a manual, escape-hatch-gated
operation per `pipeline/policies/db-change-safety.md`, not exercised by this ticket's
tests).

Acceptance criteria:
- Given a snapshot produced by ticket -a/-b/-c, when `snapshot:restore:confirm` runs
  against a fresh set of empty store containers, then all five stores are populated
  and the tensor weights + Fisher are restored, and the process exits 0. *Runnable
  check:* a `.smoke.ts` that spins up throwaway containers (or a dedicated
  docker-compose override), runs the restore, asserts exit code 0 and non-empty
  target stores.
- Given the restored system, when compared to the manifest, then WKG/SKG/OKG node
  counts, drive values, the event watermark, and tensor checkpoint hashes all match
  the manifest's recorded values (source AC #3, verbatim). *Runnable check:* the same
  smoke test queries each restored store post-restore and diffs against
  `manifest.json`'s recorded counts/hashes.
- Given a snapshot whose manifest checksum for one file doesn't match the on-disk
  file (corrupt the file to simulate), when restore runs, then it refuses to restore
  anything and exits non-zero before any store is touched. *Runnable check:* unit
  test with a tampered dump file, assert no store-mutating call was made.
- Given a successful restore, when `drive_rules` is inspected, then RLS is still
  enabled and the `drive_rules_guardian_all` policy still exists (the TK-154 lockdown
  was not silently regressed by the restore). *Runnable check:* SQL assertion in the
  smoke test (`SELECT relrowsecurity FROM pg_class...`, `\d+ drive_rules` equivalent).

### 20260702-016-e — Automated cadence: rolling snapshots + hourly→daily→weekly retention ladder + never-deleted milestone snapshots

**Priority:** P1 (the source gave this no runnable acceptance criterion of its own —
see verification note 8 — and a working manual `snapshot:create`/`:restore` already
satisfies the letter of the feature's stated ACs; automating the cadence is what makes
the P0 mission durable in practice, but it is layered on top of, not required for, ACs
#1-#5).
**Engineering level:** production.
**Depends on:** 20260702-016-a, 20260702-016-d (don't automate a snapshot mechanism
that hasn't been restore-tested).
**Owner:** `sentinel`. Conceptual reviewer: `ashby`.

Scope: a scheduler entry point that calls `snapshot:create` every N hours (config) and
before every deploy (hook point only — actual deploy-pipeline wiring may be a thin
call site, not a new deploy system), plus a retention-ladder pruner (keep all
hourlies for 24h, then thin to daily for 7d, then weekly beyond that) and a
`--milestone <name>` flag that tags a snapshot as permanently exempt from pruning.

Non_goals: cloud/offsite replication (explicit source non-goal), dashboard/UI for
managing snapshots, incremental/streaming backups (explicit source non-goal).

Acceptance criteria:
- Given a set of snapshot directories with known ages (fixture, fake clock — no live
  scheduler needed), when the retention pruner runs, then hourlies older than 24h are
  thinned to one-per-day, and dailies older than 7d are thinned to one-per-week, per
  the stated ladder. *Runnable check:* unit test with fixture snapshot timestamps,
  assert the surviving set matches the expected ladder membership exactly.
- Given a snapshot tagged `--milestone`, when the pruner runs regardless of age, then
  it is never deleted. *Runnable check:* unit test asserting a milestone-tagged
  fixture older than every retention window survives pruning.
- Given the cadence scheduler fires, when a prior `snapshot:create` run is still in
  progress, then the new tick is skipped (not queued, not run concurrently) and this
  is logged, not silently dropped. *Runnable check:* unit test with a fake in-progress
  lock; assert the scheduler's tick function returns early and emits a log line.

## Migration / DB gate

**No schema migration required.** See `migration.md` in this folder for the full
n/a rationale — the source's "Database impact: yes" is about read/write *content*
operations (dumping and, on restore, rewriting existing tables), not a schema shape
change. No `CREATE TABLE`/`ALTER TABLE`/new columns are introduced anywhere in tickets
-a through -e.

## Split recommendation

None needed beyond the 5-ticket decomposition above — the source item was already a
single coherent feature; it was too large for one atomic ticket (production-level,
touches 5 independent store technologies + a separate process's tick loop + a
still-missing persistence layer in cognition-service) but does not bundle unrelated
concerns that belong in different pipeline items. No further split into separate
inbox items recommended.

## Open questions (light, non-blocking — do not gate staging)

- **Q:** Should this epic parent under `FEAT-3` ("Intake pipeline — rolling
  operational/maintenance work") or a new top-level `FEAT-4` ("Persistence &
  durability")? `FEAT-3`'s existing epics (EP-21..27) are audit-remediation/hardening
  in nature; this is new, larger, thesis-critical infrastructure. Recommend `FEAT-4`
  but leaving as an open_question rather than guessing, since it's a taxonomy call,
  not a design fork — refine stage or Jim can settle it without blocking ticket work.
- **Q:** `neo4j-admin database dump` requires the target database to be offline (or
  requires the enterprise `neo4j-admin database dump --to-path` online-backup variant,
  which needs Neo4j Enterprise — this repo runs `neo4j:5-community` per
  `docker-compose.yml`). Community edition's dump command needs the DB stopped, or an
  online alternative (e.g., `apoc.export.cypher.all` via the already-loaded `apoc`
  plugin) must be used instead. This is an implementation-level fork for ticket -a's
  builder to resolve (does NOT need to block staging) but is flagged because it
  changes whether "quiesce" needs to include "stop the Neo4j container" — worth a
  quick technical spike at the start of ticket -a rather than an assumption baked into
  the acceptance criteria above (which are written store-agnostically for this
  reason).

## Routing recommendation: refine

The plan is atomic once split into 5 tickets, every acceptance criterion has a
concrete runnable check, and the two potential design forks (drive-isolation quiesce
protocol, Neo4j community-edition dump mechanics) are resolvable within existing
patterns without requiring an architect/Jim ruling before ticket work can start — they
are flagged as implementation-detail notes inside the relevant tickets, not
open_questions blocking the plan. The two governance open_questions above (epic
parent taxonomy) are non-blocking and can resolve during refine or ticket build.
