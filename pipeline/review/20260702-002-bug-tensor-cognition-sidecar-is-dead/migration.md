# Migration plan — 20260702-002 Tensor cognition sidecar dead end-to-end

> Deliberate n/a record. `dbcheck` flagged this item only on the keyword "migration",
> which appears in the source's *"Touches a database / schema / migration?* **no**"*
> declaration — a heuristic false positive.

## 1. Surfaces & impact class
- Stores touched: none (no postgres / timescaledb / neo4j)
- Files/objects: n/a — all fixes are TS/Python code + on-disk checkpoint-file behavior
  (`.npz` checkpoints are file state, not a DB surface)
- Impact class: n/a

## 2. Forward migration
n/a — no schema change; nothing delivered via `infra/*/init/**`.

## 3. Backfill assessment
No. No stored rows/nodes exist for this surface; additive-only code change.

## 4. Backup + REVERSE
n/a — REVERSE is `git revert` of the code change.

## 5. Continuity proof
n/a — no DB data to carry forward. Sentinel review: not required (no DB surface);
recorded here so the refine-cog dbcheck gate passes deliberately rather than silently.
