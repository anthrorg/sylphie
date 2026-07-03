# Plan — 20260702-004 — Drive engine/server resilience & isolation is façade

- **Type:** bug · **Route:** EPIC (multi-ticket) · **DB:** yes (Postgres RLS; Timescale is code-only) · **size_hint:** large · **Priority:** P0 (blocker)
- **Owner:** `drive` (packages/drive-engine, apps/drive-server) · **conceptual reviewer:** `skinner` · **DB reviewer:** `sentinel`

## Classification (plan cog)
A blocker-severity bug that is really a **cluster of ~8 independent defects** in the drive
subsystem's reliability/integrity layer. Each defect has its own fix surface and its own
runnable check → this is an **epic**, not a single ticket. Route = epic decomposition,
staged here (contract_write=staged; this scheduled run is contract-write-prohibited).

## Discovery (verified against live source @ HEAD 228df73 — not planned from a guess)
Spot-checked the load-bearing evidence; every claim held exactly:
- **Reconnect dead:** `recovery.ts:118 attemptRecovery()` — the ONLY callers are in
  `recovery.spec.ts` (grep confirmed zero production callers). Dead path.
- **RLS unenforced:** `infra/postgres/init/001-runtime-user.sql:10` grants
  `SELECT, INSERT, UPDATE, DELETE ON TABLES TO sylphie_app` with no REVOKE/policy on
  `drive_rules`; `RlsVerificationService` (verify-rls.ts:28, `implements OnModuleInit`) is
  referenced nowhere outside its own file → registered in no module → `OnModuleInit`
  never runs.
- **Theater trusts the caller:** `theater-prohibition.ts:59-91` — `detectTheater(...,
  currentDriveState: PressureVector)` declares the param (docstring: "Current drive
  snapshot for post-flight verification") but the body destructures/derives the verdict
  solely from `theaterCheck.driveValueAtExpression`. `currentDriveState` is unused. Judge
  trusts the defendant's testimony.
- **Timescale event persistence broken:** writer INSERTs
  `event_id, timestamp, event_type, subsystem_source, correlation_id, drive_snapshot,
  event_data, schema_version` (timescale-writer.ts:213-224) but `002-events.sql:7-16`
  defines `id, type, timestamp, subsystem, session_id, drive_snapshot, payload,
  correlation_id, schema_version`. 4 column-name mismatches + writer omits `session_id`
  (NOT NULL) → the INSERT would throw if ever reached; it is not reached because the
  emitter is never instantiated. Dead + wrong.

Other cited defects (staleness anchor lockout, SESSION_START overwrite, HEALTH_STATUS
fabrication, baseline no-op, tick-drift math, NaN, fork race, POSTGRES_DB default,
reloadRules swallow, cross-modulation ×3) were not re-read line-by-line this run but the
5 spot-checks above all matched the audit exactly, and the audit is source-traced at the
current HEAD — treat the remainder as reliable; refine/execute confirm at the fix site.

## Cross-item reconciliation (IMPORTANT — do not clone)
The `drive_rules` REVOKE + RLS policy is **already Jim-approved as TK-AUDIT-1** (item
20260625-002, pipeline decision DEC-28 / log 2026-06-27) with its own `migration.md`.
This epic must **reconcile, not duplicate**: the DB grant/policy migration belongs to
TK-AUDIT-1. This epic's RLS ticket (TK-DR-2) owns only the NestJS-side gap TK-AUDIT-1
does not cover — **registering `RlsVerificationService` and aborting startup on failure**.
See this item's `migration.md`.

## Proposed contract structure (STAGED — NOT written to contract.yaml)
Route target: `contract_routing = EP-21` (rolling intake epic, parent FEAT-3). Epic:
a new numeric `EP-<n>` (next free id assigned at contract-write; working name
"Drive subsystem resilience & isolation — make the named guarantees real") — ids must
be numeric per the planning-worx schema, NOT a semantic name like EP-DRIVE-RESILIENCE.

| Ticket | Defect | Priority | eng_level | DB? | Reconcile |
|---|---|---|---|---|---|
| TK-DR-1 | Reconnect + bounded/drained send queue (wire `attemptRecovery`, wait-for-`open`, bounded TTL queue) | P0 | production | no | shared reconnect pattern w/ item 005 + apps-sylphie |
| TK-DR-2 | Register `RlsVerificationService` + startup-abort on RLS misconfig | P0 | production | reads DB | REVOKE/policy = **TK-AUDIT-1** (don't re-do) |
| TK-DR-3 | `detectTheater` reads isolated `currentDriveState` for the verdict | P1 | production | no | — |
| TK-DR-4 | SESSION_START cannot overwrite drive state; preserve Timescale-restored checkpoint | P1 | production | no | — |
| TK-DR-5 | Staleness anchor: a single >5 s gap must not permanently lock the reader | P1 | production | no | — |
| TK-DR-6 | Timescale event persistence: fix INSERT columns to match `002-events.sql` **or** remove the dead writer + emitter | P2 | mvp | code-only (existing schema) | no migration |
| TK-DR-7 | HEALTH_STATUS: make real (engine emits, real `lastPingAt`/`childMemoryBytes`, enforce <10 MB) **or** remove the fake handler | P2 | mvp | no | — |
| TK-DR-8 | Low-severity cluster (refine will atomicity-split): tick-drift math, NaN guard on partial pressure vectors, fork checkpoint/exit race, `POSTGRES_DB` default mismatch, `reloadRules` swallowed errors, cross-modulation ×3 coefficients | P2 | mvp | no | — |

**Non-goal (explicit, from source):** redesigning drive baseline self-adjustment (E4-T008)
into a live path — that is a Std-6 capability decision, not a bug fix. Either wire as
recovery-only per the ratified Std-6 clarification or delete the dead `adjusted=N` logging;
do not build a new consumer here.

## Acceptance criteria (testable; ≥1 Given/When/Then)
- **TK-DR-1** — Given a live drive-server connection, When the socket drops, Then the
  client reconnects within the backoff window and resumes snapshots, the send queue stays
  bounded and is drained on reconnect, and success is declared only after the `open` event
  (integration test on ws-channel with a mock server that drops then re-accepts).
- **TK-DR-2** — Given the runtime role `sylphie_app`, When RLS on `drive_rules` is
  misconfigured (grant present), Then the registered `RlsVerificationService.OnModuleInit`
  detects it and startup ABORTS (non-zero exit / thrown init error); When RLS is correct,
  Then startup proceeds (integration test toggling the grant).
- **TK-DR-3** — Given a response whose reported `driveValueAtExpression` disagrees with the
  engine's actual isolated state, When `detectTheater` runs, Then it reads
  `currentDriveState` and returns theatrical (unit test with mismatched inputs).
- **TK-DR-5** — Given a single >5 s snapshot gap, When the next valid snapshot arrives,
  Then it is accepted and the reader resumes (unit test on the staleness anchor advancing).
- **TK-DR-6** — Given the event emitter is instantiated and emits one event, When the
  writer runs against a DB with the `002-events.sql` schema, Then the row is INSERTed with
  no column error (or, if removal chosen: Given the emitter/writer are deleted, When the
  build runs, Then no dead reference remains — grep + typecheck).

## DB step
`dbcheck` run (see log). Touches Postgres (RLS) → migration path required, but the schema
change is **TK-AUDIT-1's already-authored migration** — this item's `migration.md` records
the reconciliation and the Timescale code-only note. **`sentinel` must review** before any
ticket here reaches `queue`.

## Routing decision → refine
ACs are testable and the design is bounded (fix surfaces are known, the one cross-cutting
concern — the shared reconnect pattern — is a coordination note, not a design hole; the RLS
overlap is reconciled above; the baseline redesign is fenced as a non-goal). No genuine
multi-perspective reconciliation is blocking. **Move to `refine`** for atomicity-splitting
(esp. TK-DR-8) and a `plan-reviewer` red-team.

## Notes for refine
- Split TK-DR-8 into per-defect atomic tickets.
- Confirm TK-DR-1's shared reconnect pattern against item 005 (frontend) and the
  apps-sylphie drive-client so all three share one "wait for open + bounded queue + guard
  against unmount/close" implementation.
- Verify `migration.md` is sound (it delegates the grant/policy change to TK-AUDIT-1);
  block on `sentinel` sign-off per the DB-Change Safety gate.
- TK-DR-6/TK-DR-7 each carry a fix-or-remove decision — flag for the conceptual reviewer
  (`skinner`): removing a named CANON guarantee (theater/health) vs. making it real is a
  design call, not a pure code fix.

---

## Refine cog — 2026-07-02T17:08Z (atomicity gate + red-team; contract_write=staged, item-local only)

**Atomicity gate.** TK-DR-1..7 are each single-fix-surface, single-runnable-check → atomic, no split. **TK-DR-8 is NOT atomic** (bundles 6 independent defects); story-split into:
- **TK-DR-8a** — tick-drift accumulator math (unit test: expected vs actual tick interval under drift).
- **TK-DR-8b** — NaN guard on partial pressure vectors (unit test: partial vector → no NaN propagates to consumers).
- **TK-DR-8c** — fork checkpoint/exit race (test: child exit during checkpoint does not corrupt/lose last snapshot).
- **TK-DR-8d** — `POSTGRES_DB` default mismatch (test: default resolves to the real DB name; connection succeeds).
- **TK-DR-8e** — `reloadRules` swallowed errors surface (test: forced reload failure throws/logs, not silently swallowed).
- **TK-DR-8f** — cross-modulation ×3 coefficient correctness vs CANON guardian-asymmetry ×2/×3 (test: coefficient matches the ratified asymmetry).

Each 8x is `mvp`, `no-DB`, owner `drive` / conceptual `skinner`. Splitting revealed **no design hole** — all six are bounded, mechanical corrections.

**Red-team (plan-reviewer role, applied by coordinator — no separate agent file in repo).**
- **HIGH (sequencing dependency):** TK-DR-2 registers `RlsVerificationService` + startup-abort-on-RLS-misconfig. The actual REVOKE/RLS policy is **TK-AUDIT-1** (item 20260625-002), which per DEC-28 is *staged, not yet written to contract, not yet built*. If TK-DR-2 lands first, the verifier will ABORT drive-server startup on every boot until TK-AUDIT-1 applies the grant lockdown. **Mitigation:** TK-DR-2 must carry `depends_on: TK-AUDIT-1` (or ship the verifier in warn-only mode until TK-AUDIT-1 is done). Not a design hole — the design is sound; it needs a dependency edge honored at execute time.
- **HIGH (cross-item coordination):** TK-DR-1's reconnect ("wait-for-`open` + bounded TTL queue + guard against close/unmount") is the same class as item 005 TK-FE-1/TK-FE-4 and the apps-sylphie drive-client. One shared implementation, not three divergent ones. Coordination note for execute, not a blocker.
- **MEDIUM (fix-or-remove design calls):** TK-DR-6 (Timescale event persistence) and TK-DR-7 (HEALTH_STATUS) each accept fix **or** remove. Both branches carry runnable ACs and both satisfy theater-prohibition (real, or the fake is gone). `mvp` eng_level; neither object is one of the Six Immutable Standards → this is a trio-level (skinner) call at build, not a planning-blocking hole.
- **No CRITICAL findings. No CANON conflict** (TK-DR-3 strengthens theater-prohibition; fix-or-remove branches are CANON-neutral).

**DB gate.** `pipeline.py dbcheck 20260702-004` → `touches_db:true, has_migration_plan:true, ok:true`. `migration.md` is sound: backfill assessed (none — additive RLS), REVERSE present (re-GRANT + DISABLE RLS), backup command present, incremental (delegated to TK-AUDIT-1's migration, not an init-script edit), continuity smoke defined. **`sentinel` sign-off still required before any DB-touching ticket (TK-DR-2) is built.**

**Verdict: atomic + red-teamed clean → `queue`.** Tickets remain staged in this plan.md; contract-write into `contract.yaml` awaits Jim's per-item staged-write approval gate (contract_write=staged). Execute cannot pick these until they are written to the contract.
