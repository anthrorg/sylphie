# Migration plan — 20260625-002 / TK-154 — drive_rules lockdown (convergent)

Updated 2026-07-03 to the **convergent** design ruled by architect AD-0052 / DEC-34
(supersedes the earlier "additive privileges-only" sketch, which assumed the tables/
roles already existed and were correctly owned — the live-DB probe showed they exist
by out-of-repo hand-creation, owned by `sylphie_admin`, un-codified).

## 1. Surfaces & impact class
- Store: **postgres** (`sylphie-postgres`, host port 5434). Objects: `drive_rules`,
  `proposed_drive_rules`; roles `sylphie_app`, `drive_engine`, `guardian_admin`.
- Impact class: **convergent security + first in-repo schema codification.** Codifies
  the tables (IF NOT EXISTS — no drop/recreate), pins ownership, provisions/normalizes
  roles + grants, enables RLS. **No rows altered, recomputed, or dropped.**
- Authorizing decision: DEC-34 (architect AD-0051 seam + AD-0052 DB end-state).

## 2. Forward migration (incremental path — convergent, idempotent)
- Mechanism: `infra/migrations/NNN-drive-rules-lockdown.ts` (dry-run default,
  `--confirm` to apply), run as **sylphie_admin** (superuser). **NOT** an edit to
  `infra/postgres/init/001-runtime-user.sql`.
- Steps (each idempotent; reaches the same end-state from any start):
  1. `CREATE TABLE IF NOT EXISTS drive_rules`, `proposed_drive_rules` **matching the
     live schema exactly** (first in-repo codification). No-op where they already exist.
  2. `ALTER TABLE ... OWNER TO sylphie_admin` (idempotent) — so REVOKE bites and the
     owner is not the runtime role.
  3. `CREATE ROLE IF NOT EXISTS guardian_admin`, `drive_engine` (LOGIN, passwords from
     env — no hardcoded default).
  4. Per-table `REVOKE ALL ... FROM sylphie_app, drive_engine, guardian_admin` then
     `GRANT` the exact matrix (below). This neutralizes the `001` default-privilege
     grant for these two tables **without touching global default privileges** (blast
     radius: other tables rely on them).
  5. `ENABLE` + `FORCE ROW LEVEL SECURITY`; per-role policies (below). **REVOKE is the
     PRIMARY write-denial** (raises `permission denied`); RLS is defense-in-depth.

Grant matrix (end-state):

| | sylphie_app | drive_engine | guardian_admin |
|---|---|---|---|
| drive_rules | SELECT | SELECT | SELECT, INSERT, UPDATE, DELETE |
| proposed_drive_rules | SELECT, INSERT | SELECT | SELECT, INSERT, UPDATE, DELETE |

Policies (`TO role`, drop-and-recreate): per-role `FOR SELECT USING(true)`;
`FOR ALL TO guardian_admin USING(true) WITH CHECK(true)`; proposer INSERT policy on
`proposed_drive_rules` `WITH CHECK (status = 'pending')`; **no** write policy for
`sylphie_app` on `drive_rules`.

## 3. Backfill assessment
- Existing rows transformed/recomputed? **No.** Schema is `CREATE TABLE IF NOT EXISTS`
  (never drops/recreates an existing table); ownership/role/grant/RLS changes touch no
  row data. All `drive_rules` / `proposed_drive_rules` rows are preserved untouched.

## 4. Backup + REVERSE
- Pre-write backup (hard-stop on failure): `docker exec sylphie-postgres pg_dump -U
  sylphie_admin -t drive_rules -t proposed_drive_rules sylphie_system >
  backups/drive_rules-pre-lockdown.sql`, plus a grants snapshot (`\dp drive_rules
  proposed_drive_rules`) and `\d` schema snapshot.
- REVERSE: restore the prior grant set to `sylphie_app` (re-`GRANT INSERT,UPDATE,DELETE
  ON drive_rules` + `UPDATE,DELETE ON proposed_drive_rules`), `NO FORCE` / `DISABLE ROW
  LEVEL SECURITY`, drop the added policies. Roles/tables are left in place (creating
  them is non-destructive; dropping is not required to restore the pre-lockdown
  write-behavior). Proven by the reverse smoke.

## 5. Continuity proof (TK-154 smoke — the AC harness)
- Seed `drive_rules` + `proposed_drive_rules` with representative rows. Apply forward.
  Assert: (a) `sylphie_app` UPDATE/INSERT/DELETE on `drive_rules` DENIED with
  `permission denied`; (b) `sylphie_app` SELECT `drive_rules` + SELECT/INSERT
  `proposed_drive_rules` SUCCEED; (c) `guardian_admin` write SUCCEEDS; (d) row count +
  contents unchanged; (e) a fresh/empty DB converges to the same end-state; (f) REVERSE
  restores `sylphie_app` grants. This is the runnable proof for TK-154 AC1/AC3/AC4
  (AC2 guardian-path-succeeds also proven end-to-end by TK-155).

## 6. Prod note
- Railway prod postgres state is unobserved from here → run the migration **dry-run
  against prod first** to see the actual starting state; convergence makes `--confirm`
  safe afterward. Jim ops: provision `guardian_admin` / `drive_engine` passwords as
  Railway/env secrets before prod `--confirm`.

## 7. Sign-off
- dbcheck clean: [x] · sentinel reviewed: [x] · continuity smoke passed: [x] (24/24, throwaway container, orchestrator-run 2026-07-03) · ashby+code-reviewer: [x]
- Approval marker used? no (no wipe; convergent + additive, no data loss).
- Built to PR #86 (TK-154 + TK-155). Live apply/`--confirm` + guardian secret provisioning remain Jim's (merge gate).
