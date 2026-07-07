# Migration plan — 20260702-012 Executor tension (stakes, veto, Guilt drive)

> Status: **provisional / blocked** — DB impact is real (source confirms: "yes") but
> the exact schema cannot be finalized until the architect ruling in ticket
> `20260702-012-a` resolves open questions 1 and 4 (stakes-tier taxonomy; the
> rule-strength write path). This document records the known additive-only surface
> and a placeholder shape; a build agent must not execute any migration off this
> document — a fresh, ruling-informed `migration.md` must be written once
> `20260702-012-a` lands, and that revision is what the `refine`/`review` cogs gate on.

## 1. Surfaces & impact class
- Stores touched: [ ] postgres (drive_rules, indirectly) [x] timescaledb (new event
  types) [ ] neo4j-world [ ] neo4j-self [ ] neo4j-other
- Files/objects (expected, not final):
  - **TimescaleDB**: new event *types* only — `DIVERGENCE`, `FLOOR_VETO`,
    `GUILT_ACCRUAL`, `GUILT_RESOLUTION` — logged through the existing decision-event
    logger (`DECISION_EVENT_LOGGER` token, same table shape used by
    `TYPE_1_GRADUATION`/`TYPE_1_DEMOTION`/`CONFIDENCE_UPDATED` per contract.yaml
    ~line 1308-1320). If that events table is a generic `(event_type, payload jsonb,
    ts)` shape (needs confirming when the ruling lands and the ticket is built), new
    event types are **additive with no DDL change** — just new enum/string values and
    a payload shape. If event types are enum-constrained at the DB level, an additive
    enum-value migration is needed.
  - **Postgres `drive_rules`**: per-action-class tolerance/stakes-tier value. This
    table is now REVOKE+RLS locked with a guardian-privileged pool
    (`infra/migrations/002-drive-rules-lockdown.ts`, TK-154/TK-155, merged PR #86).
    Any new column must (a) go through the same guardian-privileged migration pattern
    as 002, and (b) be write-restricted to the guardian pool exactly like existing
    columns — no new escape hatch. **Column list is TBD pending open question 4.**
- Impact class: **additive** in all cases above, assuming the events table is
  generic-payload-shaped (to confirm) and the drive_rules addition is a new nullable
  column with a safe default (to confirm shape after the ruling).
- Contract decision authorizing it: N/A yet — no destructive change is anticipated;
  if the ruling somehow requires a destructive change, a `DEC-*` entry must be added
  before that work proceeds (per policy — not assumed here).

## 2. Forward migration (incremental path)
- Mechanism: `infra/migrations/NNN-executor-tension-guilt-columns.ts` (Timescale +
  Postgres, following the `002-drive-rules-lockdown.ts` pattern for the guardian-write
  path) — NNN to be assigned at build time, not guessed here.
- Summary: adds (a) any new Timescale event-type support needed for
  divergence/veto/guilt events (likely zero-DDL if the events table is generic), and
  (b) a guardian-writable, additive column on `drive_rules` for per-action-class
  stakes-tier/tolerance, once the ruling defines its shape.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed (this plan
  explicitly requires the incremental `infra/migrations/NNN-*.ts` path).

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **No**, provided the new column
  is nullable with a safe default (e.g. `NULL` = "no stakes-tier assigned yet," treated
  as the most conservative/highest-tolerance-restriction tier by application code).
  This is additive-only and needs no backfill of existing `drive_rules` rows. If the
  ruling instead requires a NOT NULL column, backfill becomes required and this
  document must be revised before build.

## 4. Backup + REVERSE
- Pre-write backup command: `pg_dump` for the Postgres `drive_rules` table snapshot
  (same tool already used by the 002 migration's safety story); Timescale event-type
  additions carry no backup requirement if zero-DDL.
- Backup-failure behavior: hard-stop (exit 1) before any write — [x] confirmed, per
  house convention (`infra/migrations/001-legacy-pattern-rescope.ts` reference pattern).
- REVERSE: drop the new nullable column (`ALTER TABLE drive_rules DROP COLUMN
  <name>`) — safe since it's additive/nullable; no data loss on rollback because no
  existing column is touched.

## 5. Continuity proof (the review-cog smoke)
- Deferred — cannot be executed until the ruling fixes the actual column(s)/shape.
  The eventual migration script must still pass the standard continuity smoke (seed →
  apply forward → assert pre-existing `drive_rules` rows intact → rollback) before
  `review` marks it done.

## 6. Sign-off
- `dbcheck` clean: [ ] (pending — this doc is provisional)
- Reviewed by sentinel: [ ] (pending — sentinel is the DB-surface domain owner per
  CLAUDE.md's work-trio table; should review once the ruling lands, before build)
- Continuity smoke passed: [ ] (not yet — no code to smoke)
- Approval marker used? **no**
