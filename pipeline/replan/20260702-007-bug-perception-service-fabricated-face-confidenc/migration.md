# Migration plan — 20260702-007 Perception service fabricated confidence / dead tracker config / hot-path throttle

> Deliberate "n/a." This item touches no database surface. `pipeline.py dbcheck 20260702-007`
> reports `touches_db: true` on the keyword `"migration"`, but that is a **known false
> positive** (see `pipeline/pipeline.rules.md` "Known gotchas" — "Tighten dbcheck: prose
> mentions of 'migration'/'postgres' false-positive"). The only occurrence of the string
> "migration" in `source.md` is inside the sentence "Pure CV/service code; no
> schema/**migration**." — a negation, not a change. Confirmed by direct read of `source.md`
> and by grepping the four scope files named in the item (`face_detector.py`, `main.py`,
> `tracker.py`, `feature_extraction.py`, plus the consumer `face-snapshot.service.ts`) for
> any `*.sql`, `*.cypher`, `CREATE TABLE`, `ensureSchema`, `vector(`, or Prisma-model
> reference — zero hits relevant to this item's fix surfaces.

## 1. Surfaces & impact class
- Stores touched: [ ] postgres  [ ] timescaledb  [ ] neo4j-world  [ ] neo4j-self  [ ] neo4j-other
- Files/objects: none. All four fix surfaces are in-process Python (perception-service:
  `face_detector.py`, `tracker.py`, `main.py`, `feature_extraction.py`) or TypeScript service
  logic (`face-snapshot.service.ts`'s in-memory gate check). `face-snapshot.service.ts` does
  own a `face_embeddings` TimescaleDB table elsewhere in the file (`ensureSchema` per
  `contract.yaml` TK-*, already tracked by other tickets), but this item's fix (logging the
  bail + deriving a real confidence, ticket -a) reads/writes no new column and adds no query
  — it only changes which detections pass the existing, unmodified confidence comparison
  before `saveSnapshot` is ever called. No schema surface.
- Impact class: **n/a** (no DB surface touched).
- Contract decision authorizing it: n/a.

## 2. Forward migration (incremental path)
- Mechanism: n/a — no migration.
- Summary of the change: pure code fixes (real per-detection confidence value, tracker state-
  machine correction, config wiring, hot-path throttle/vectorization). No persisted-data shape
  changes anywhere.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed — no `infra/` files
  are in scope for any of the four tickets.

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no.**
- Why safe: nothing here changes a stored schema, column, or embedding dimension. Ticket -a
  changes what confidence value is reported per detection (an ephemeral, non-persisted
  per-request value derived at inference time) — no existing `face_embeddings` row's stored
  data changes shape or meaning. Tickets -b/-c/-d are entirely in-memory tracker/pipeline
  logic with no persistence at all.

## 4. Backup + REVERSE
- Pre-write backup command: n/a — no DB write path is touched.
- Backup-failure behavior: n/a.
- REVERSE: standard git revert of the code change; no data-side rollback needed.

## 5. Continuity proof (the review-cog smoke)
- n/a — no DB surface, so no continuity smoke is required by `pipeline/policies/db-change-safety.md`.
  If review disagrees (e.g. it judges ticket -a's confidence-derivation choice, once ruled by
  architect, does touch a persisted `face_embeddings` field), it should re-run
  `pipeline.py dbcheck 20260702-007` at that point and this file should be revisited — but as
  scoped today, nothing here persists anything new.

## 6. Sign-off
- `dbcheck` clean: [ ] — reports a false-positive keyword hit; documented above, not a real
  DB surface. Sentinel review recommended only as a sanity check on this n/a determination,
  not required to unblock queue/done for this item.
- reviewed by sentinel: [ ] (optional given no real DB surface)
- continuity smoke passed: n/a
- Approval marker used? **no** (nothing destructive; nothing DB-touching at all).
