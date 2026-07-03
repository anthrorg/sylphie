# Migration plan — 20260625-002 / TK-AUDIT-1 — drive_rules write-protection

## 1. Surfaces & impact class
- Store: **postgres** (`sylphie-postgres`), objects: `drive_rules` (+ `proposed_drive_rules`
  write path), role grants for `sylphie_app`.
- Impact class: **additive (security)** — REVOKE privileges + add RLS. No rows altered or
  dropped. Authorizing decision: pending `architect` (CANON Std-6 gap).

## 2. Forward migration (incremental path)
- Mechanism: `infra/migrations/NNN-drive-rules-lockdown.ts` (dry-run default, --confirm to
  apply), NOT an edit to `infra/postgres/init/001-runtime-user.sql`.
- Summary: `REVOKE INSERT, UPDATE, DELETE ON drive_rules FROM sylphie_app`; enable RLS as
  defense-in-depth; route guardian-approved writes through a separate privileged role/
  connection the runtime cognition path does not hold. Wire to existing verify-rls.ts and
  guardian-rules.service.ts.

## 3. Backfill assessment
- Existing rows transformed/recomputed? **No.** This changes privileges/RLS only; all
  `drive_rules` data is preserved untouched. Justified additive-only (no schema/data change).

## 4. Backup + REVERSE
- Pre-write backup: `pg_dump -U sylphie_admin -t drive_rules sylphie_system > backups/drive_rules-pre-lockdown.sql`
  plus a snapshot of current grants (`\dp drive_rules`). Hard-stop (exit 1) if backup fails.
- REVERSE: re-`GRANT INSERT, UPDATE, DELETE ON drive_rules TO sylphie_app;` and `DISABLE ROW LEVEL SECURITY`,
  or restore the grants snapshot.

## 5. Continuity proof (review-cog smoke)
- Seed `drive_rules` with representative rows. Apply forward. Assert: (a) `sylphie_app`
  `UPDATE drive_rules` is DENIED; (b) the guardian/privileged path UPDATE SUCCEEDS;
  (c) row count + contents unchanged. This IS the doc's stated acceptance check.

## 6. Sign-off
- dbcheck clean: [ ] · sentinel reviewed: [ ] · continuity smoke passed: [ ]
- Approval marker used? no (additive — no wipe).
