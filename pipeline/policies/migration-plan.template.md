# Migration plan — <item id> <short title>

> Required for any change that touches a DB surface. Lives as `migration.md` in the
> item's folder. Gate: `pipeline/policies/db-change-safety.md`. Copy this, fill every
> section — "n/a" is a valid answer but must be a deliberate one.

## 1. Surfaces & impact class
- Stores touched: [ ] postgres  [ ] timescaledb  [ ] neo4j-world  [ ] neo4j-self  [ ] neo4j-other
- Files/objects: <tables, hypertables, prisma models, node labels, constraints, indexes, vector dims>
- Impact class: **additive** | **destructive** (drop / rename / retype / dim-change / recompute)
- Contract decision authorizing it (if destructive): DEC-___

## 2. Forward migration (incremental path)
- Mechanism: Prisma migration `____` | `infra/migrations/NNN-____.ts`
- Summary of the change: <what it does, in one paragraph>
- Confirm it is NOT delivered by editing `infra/*/init/**`: [ ] confirmed

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **yes / no**
- If yes — how: <transform query / re-embed job / re-derive>; estimated volume & cost: <…>
- If no — why it's safe (additive-only): <justification — not "assumed">

## 4. Backup + REVERSE
- Pre-write backup command: <pg_dump / neo4j-admin database dump …>
- Backup-failure behavior: hard-stop (exit 1) before any write: [ ] confirmed
- REVERSE: <exact rollback steps, or "restore from the backup above">

## 5. Continuity proof (the review-cog smoke)
- Seed data used: <representative fixture>
- Steps: seed → apply forward → assert pre-existing data intact (counts/spot-checks) → (rollback)
- For index/constraint changes: prove the index is rebuilt and the app picks it up.
- Result: <pass/fail + evidence — log lines, row counts>

## 6. Sign-off
- `dbcheck` clean: [ ]   ·   reviewed by sentinel: [ ]   ·   continuity smoke passed: [ ]
- Approval marker used? **no** | **yes** (decision id: DEC-___, marker removed after: [ ])
