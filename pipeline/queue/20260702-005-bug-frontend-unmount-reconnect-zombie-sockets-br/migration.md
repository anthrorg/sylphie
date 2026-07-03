# Migration plan — 20260702-005 — Frontend/shared bug epic — **n/a (deliberate)**

> `dbcheck` flagged this item because the source prose contains the tokens `prisma`,
> `timescale`, and `migration`. That is a **keyword false-positive**: the item declares
> **no schema/DB migration**. This file is a deliberate `n/a` recording *why*, per the
> template ("'n/a' is a valid answer but must be a deliberate one"), and routes `sentinel`
> to confirm no schema surface before this epic reaches `queue`.

## 1. Surfaces & impact class
- Stores touched: [ ] postgres  [ ] timescaledb  [ ] neo4j-world  [ ] neo4j-self  [ ] neo4j-other
- Files/objects: **none.** The only DB-adjacent work is `packages/shared` **client code**:
  - `storage/prisma.service.ts` — URL-escape the Prisma DSN; drop `env!` non-null assertions.
  - `storage/timescale.service.ts` — `withTransaction` ROLLBACK must not mask the original error.
  No tables, hypertables, Prisma models, node labels, constraints, indexes, or vector dims
  are added, dropped, renamed, retyped, or recomputed.
- Impact class: **none** (client-code correctness only — connection-string escaping and
  error propagation).
- Contract decision authorizing a destructive change: **n/a — no destructive change.**

## 2. Forward migration (incremental path)
- Mechanism: **none.** No Prisma migration and no `infra/migrations/NNN-*.ts`. The changes
  are TypeScript in `packages/shared` (and frontend); they alter how the client *connects*
  and *handles errors*, not the schema it connects to.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed (no init edit).

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no.**
- Why safe: no schema or data is touched. DSN escaping changes the *client's* connection
  string parsing; ROLLBACK error-handling changes which error surfaces on failure — neither
  reads or writes rows destructively.

## 4. Backup + REVERSE
- Pre-write backup: **n/a** — no DB write. (Standard git revert reverses the code change.)
- REVERSE: revert the `packages/shared` client-code commit.

## 5. Continuity proof (the review-cog smoke)
- **n/a for schema.** Verification is code-level: assert the escaped DSN still connects to
  the existing DB, and that a forced transaction failure now propagates the original error
  (unit test on `withTransaction`). No pre-existing-data-survival smoke is required because
  nothing migrates.

## 6. Sign-off
- `dbcheck` clean: [ ] (re-run after this deliberate n/a)   ·   reviewed by sentinel: [ ]
  (confirm no schema surface)   ·   continuity smoke passed: [x] n/a (no schema change)
- Approval marker used? **no** — no wipe, no destructive change.
