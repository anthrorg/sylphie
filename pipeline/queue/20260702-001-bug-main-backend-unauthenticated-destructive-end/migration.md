# Migration plan — 20260702-001 — backend hardening (dbcheck false-positive record)

> Deliberate "n/a" record. `dbcheck` flagged `touches_db` on prose keyword hits only
> ("migration", "neo4j"); `surface_files` is EMPTY. This item changes NO DB surface.
> Known gotcha (pipeline.rules.md → "Tighten dbcheck: prose mentions false-positive").

## 1. Surfaces & impact class
- Stores touched: NONE. (Prose mentions Neo4j/TimescaleDB because the bugs *touch code
  that talks to* them: an unauthenticated reset endpoint, a boot-time CREATE CONSTRAINT
  deadline, and a broken read-only SELECT.)
- Files/objects: n/a — no tables, models, labels, constraints, indexes, or dims change.
- Impact class: **none** (code-only). TK-BEH-3 corrects a read query (GROUP BY
  qualification); TK-BEH-1 *adds a guard in front of* destructive endpoints — it does
  not itself alter schema or data. TK-BEH-2 adds a timeout around an existing
  `CREATE CONSTRAINT ... IF NOT EXISTS` (idempotent, already shipped op — unchanged).

## 2. Forward migration (incremental path)
- Mechanism: n/a — no migration is delivered.
- Confirm NOT delivered by editing `infra/*/init/**`: [x] confirmed (no infra edits at all).

## 3. Backfill assessment
- Transform/recompute existing rows/nodes? **no** — nothing writes or alters any store.

## 4. Backup + REVERSE
- n/a (no data-affecting change). REVERSE = git revert of the code change.

## 5. Continuity proof (review-cog smoke)
- Not a DB continuity case. Review smoke = the item's ACs (401/403 e2e sweep, stalled-driver
  boot test, metrics/health numeric values, WS/STT notification paths).

## 6. Sign-off
- dbcheck: keyword false-positive, corrected here · sentinel review: not required (no DB
  surface) — flag to sentinel only if refine disagrees with this classification.
