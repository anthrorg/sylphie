# Migration plan — 20260625-003 Sylphie Interaction Directive (attach to EP-20)

> NO-DB-CHANGE assessment. `dbcheck` flagged `touches_db=true` on **keyword hits only**
> (`neo4j`, `timescale`) with **`surface_files: []`**. The keywords appear in *prose*, not
> in any DB surface this item changes: source.md lists `sentinel: Timescale/Neo4j-other
> connectivity` in the directive's owner list, and plan.md's discovery notes name the
> stores. The planned work is (a) an **attach/dedupe** of this intake item onto existing
> EP-20 tickets (no code), and (b) one **staged** ticket TK-106 (a runtime config/env flag
> in `perception.gateway.ts`). Neither touches a schema, hypertable, node label, index, or
> vector dim. Filed per the DB-Change Safety gate so **sentinel** can confirm the no-op.

## 1. Surfaces & impact class
- Stores touched: [ ] postgres  [ ] timescaledb  [ ] neo4j-world  [ ] neo4j-self  [ ] neo4j-other  → **none**
- Files/objects: none. No `infra/**`, no `prisma/**`, no `*.sql`/`*.cypher`, no embedding-dim/vector change. Staged TK-106's `files_in_scope` is `apps/sylphie/src/gateways/perception.gateway.ts` + app config wiring — application code only.
- Impact class: **additive** (in fact: no DB delta at all)
- Contract decision authorizing it (if destructive): n/a — not destructive

## 2. Forward migration (incremental path)
- Mechanism: **n/a** — no migration. (Were TK-106 ever to need persisted config, it would be a config/env value, not a schema object.)
- Summary of the change: no DB change. Attach links the intake item to EP-20; TK-106 (staged, unapproved) gates frame ingestion + the WS5 scene-change nudge behind a runtime flag.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed (no infra files in scope)

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no**
- If no — why it's safe (additive-only): there is no DB write of any kind; no rows/nodes are created, altered, or removed. The keyword match is lexical, from directive prose, not from a data-model change.

## 4. Backup + REVERSE
- Pre-write backup command: **n/a** — no DB write to back up.
- Backup-failure behavior: n/a.
- REVERSE: revert the application-code commit (TK-106 flag); no data to restore.

## 5. Continuity proof (the review-cog smoke)
- Seed data used: **n/a** — no DB surface to seed/migrate.
- Steps: n/a. (TK-106's own ACs cover behavioral verification — frames suppressed when flag OFF, normal when ON — none of which read/write a DB schema.)
- Result: n/a — no continuity risk because no schema changes.

## 6. Sign-off
- `dbcheck` clean: [ ] (flag is a known prose-keyword false-positive; `surface_files` empty)  ·  reviewed by **sentinel**: [ ] (must confirm the no-op before queue/done)  ·  continuity smoke passed: [x] (vacuous — no DB change)
- Approval marker used? **no**
