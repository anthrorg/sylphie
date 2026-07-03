# Migration plan — 20260702-004 — Drive subsystem resilience & isolation

> Reconciliation-first plan. The one true schema/grant change here (RLS on `drive_rules`)
> is **already owned and authored by TK-AUDIT-1** (item 20260625-002, Jim-approved
> 2026-06-27). This file records the reconciliation so we do not clone a second migration
> for the same object. `sentinel` must review before any DB-touching ticket reaches `queue`.

## 1. Surfaces & impact class
- Stores touched: [x] postgres  [x] timescaledb  [ ] neo4j-world  [ ] neo4j-self  [ ] neo4j-other
- Files/objects:
  - **postgres** — role grants for `sylphie_app`; RLS policy on `drive_rules`
    (`infra/postgres/init/001-runtime-user.sql`). **This grant/policy change = TK-AUDIT-1.**
  - **timescaledb** — `events` hypertable (`infra/timescaledb/init/002-events.sql`). **No
    schema change** — the fix is a *code* correction to the writer's INSERT column list to
    match the existing schema (or removal of the dead writer). Not a migration.
- Impact class: **additive (security)** for the RLS piece (REVOKE + policy, no rows
  altered); **none** for the Timescale piece (code-only).
- Contract decision authorizing the destructive-adjacent RLS change: TK-AUDIT-1 under
  DEC-28 (Jim approval 2026-06-27). No new decision needed.

## 2. Forward migration (incremental path)
- Mechanism: **delegated** — `infra/migrations/NNN-drive-rules-lockdown.ts` as already
  specified in item 20260625-002's `migration.md` (dry-run default, `--confirm` to apply).
  This item (TK-DR-2) adds **no new migration**; it wires the NestJS-side verifier
  (`RlsVerificationService`) into a module + startup-abort, which is app code, not schema.
- Summary: TK-AUDIT-1 performs `REVOKE INSERT, UPDATE, DELETE ON drive_rules FROM
  sylphie_app`, enables RLS, and routes guardian-approved writes through a separate
  privileged role. TK-DR-2 only ensures the app fails closed if that state is absent.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed — grant/policy
  ships via the incremental migration (TK-AUDIT-1), not an init-script edit. The
  `db-change-guard` hook would block a wipe regardless.

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no.**
- Why safe: the RLS change alters privileges/RLS only — all `drive_rules` rows preserved
  untouched (additive security). The Timescale fix changes client SQL to match the existing
  `events` schema; no existing rows are read/written destructively.

## 4. Backup + REVERSE
- Pre-write backup command (for the TK-AUDIT-1 RLS apply):
  `pg_dump -U sylphie_admin -t drive_rules sylphie_system > backups/drive_rules-pre-lockdown.sql`
  plus a grants snapshot (`\dp drive_rules`).
- Backup-failure behavior: hard-stop (exit 1) before any write: [x] confirmed (inherited
  from TK-AUDIT-1's migration).
- REVERSE: re-`GRANT INSERT, UPDATE, DELETE ON drive_rules TO sylphie_app;` +
  `ALTER TABLE drive_rules DISABLE ROW LEVEL SECURITY;`, or restore the grants snapshot.
  TK-DR-2 (verifier) reverses by removing the module registration — no data effect.

## 5. Continuity proof (the review-cog smoke)
- Seed data: representative `drive_rules` rows.
- Steps: seed → apply TK-AUDIT-1 forward → assert (a) `sylphie_app` `UPDATE drive_rules`
  DENIED, (b) guardian/privileged path UPDATE SUCCEEDS, (c) row count + contents unchanged,
  (d) with the grant re-added, the registered `RlsVerificationService` ABORTS startup.
- For the Timescale piece: emit one event → assert the INSERT lands in `events` with the
  corrected column list (no column error), pre-existing rows intact.

## 6. Sign-off
- `dbcheck` clean: [ ]   ·   reviewed by sentinel: [ ]   ·   continuity smoke passed: [ ]
- Approval marker used? **no** (additive — no wipe). RLS change authorized via TK-AUDIT-1
  / DEC-28; this item adds no new destructive change.
