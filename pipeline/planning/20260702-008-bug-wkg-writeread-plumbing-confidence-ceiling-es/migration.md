# Migration plan — 20260702-008 WKG write/read plumbing bugs

> Filled per `pipeline/policies/migration-plan.template.md`. Gate:
> `pipeline/policies/db-change-safety.md`.

## 1. Surfaces & impact class
- Stores touched: [x] neo4j-world  [ ] postgres  [ ] timescaledb  [ ] neo4j-self  [ ] neo4j-other
- Files/objects: no new node labels, constraints, or indexes. All five tickets (008-a
  through 008-e) are **Cypher query corrections inside existing application code**
  (`packages/decision-making/src/wkg/wkg-context.service.ts`,
  `packages/decision-making/src/arbitration/contradiction-scanner.service.ts`,
  `packages/decision-making/src/action-handlers/action-handler-registry.service.ts`,
  `packages/decision-making/src/action-retrieval/action-retriever.service.ts`) — property
  names, returned ids, match shapes, and confidence-value logic against the **existing**
  graph model (`:Entity`, `:ActionProcedure`, `:Candidate`, `:Drive` labels; `node_id`,
  `confidence`, `provenance_type`, `triggerContext`/`trigger_context` properties — all
  already in use, none newly introduced).
- Impact class: **additive** for the code fix itself (no structural change). One
  **data-correction** surface exists as a consequence of ticket 008-a's bug fix: existing
  `ActionProcedure` nodes in a populated WORLD graph may already carry confidence > 0.60
  from the pre-fix dedup-boost bug (non-guardian provenance). Correcting those values down
  to the legitimate 0.60 ceiling is additive-only (a value clamp, not a drop/rename/retype)
  but is a live-data write and so is treated as a migration per this policy's own guidance:
  "treat every Neo4j structural change as a migration with a backfill question, even
  though there's no tool forcing the shape" — this is the backfill-question case even
  without a structural change.
- Contract decision authorizing it (if destructive): n/a — not destructive. No DEC-* needed
  to *run* the backfill (it only lowers over-ceiling values back to the documented CANON
  Std-3 cap, which is restoring correctness, not a data-loss event); if Jim wants to review
  the affected-node count before `--confirm` is run in a populated environment, that's a
  one-time operational approval, not a governance decision.

## 2. Forward migration (incremental path)
- Mechanism: `infra/migrations/003-wkg-dedup-confidence-reclamp.ts` (next sequence number
  after the existing `001-legacy-pattern-rescope.ts` / `002-drive-rules-lockdown.ts`
  house convention).
- Summary of the change: dry-run by default — queries WORLD for `ActionProcedure` nodes
  with `confidence > 0.60` and `provenance_type` in
  `{'INFERENCE','LLM_GENERATED','BEHAVIORAL_INFERENCE'}` (non-guardian tiers; guardian-tier
  procedures at >0.60 are legitimate and must NOT be touched), prints the count + a sample
  of `(node_id, name, confidence)`, and exits 0 with zero writes. With `--confirm`
  (or `SYLPHIE_WKG_RECLAMP_CONFIRM=1`), it sets `confidence = 0.60` on exactly that node
  set via a single parameterized `SET p.confidence = 0.60` write, guarded by the same
  `WHERE` clause used in dry-run so the two modes select identical rows.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed — this is an
  `infra/migrations/NNN-*.ts` script only; no init-file touched.

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **yes, conditionally** — only in an
  environment where the pre-fix dedup-boost bug has actually run against real traffic
  (i.e., any populated WORLD graph that predates ticket 008-a's fix landing). A fresh/empty
  graph, or one that was never exposed to two Jaccard-matching (>0.70) Type-2 opportunities
  before the fix, has nothing to backfill — the dry-run will simply report zero affected
  nodes, which is the honest "no backfill needed" proof rather than an assumption.
- How: single `SET p.confidence = 0.60` clamp on the filtered node set (see §2). Estimated
  volume: bounded by total `ActionProcedure` node count in WORLD (typically low hundreds in
  dev; the dry-run's printed count is the actual pre-`--confirm` measurement — no guessing).
  Cost: one Cypher write pass, sub-second at this scale.

## 4. Backup + REVERSE
- Pre-write backup command: `neo4j-admin database dump --database=world --to-path=<backup-dir>`
  (or the container-equivalent the repo already uses for WORLD) run by the script before
  any `--confirm` write; the script hard-stops (exit 1, no write) if the backup command
  fails.
- Backup-failure behavior: hard-stop (exit 1) before any write: [x] confirmed (required by
  house convention; ticket 008-a's acceptance criteria assert this).
- REVERSE: restore from the pre-write backup taken above (`neo4j-admin database load` from
  the dump). There is no forward-only data loss to reverse a formula for — the only change
  is a numeric confidence clamp — so "restore from backup" is the documented rollback
  rather than a bespoke reverse-Cypher script.

## 5. Continuity proof (the review-cog smoke)
- Seed data used: a small fixture graph with (a) 2+ `ActionProcedure` nodes at
  confidence > 0.60 with `provenance_type: 'INFERENCE'` (simulating the bug's effect),
  (b) 1 legitimate guardian-tier node at confidence 0.90 (`GUARDIAN_APPROVED_INFERENCE`),
  (c) 1 normal node at confidence 0.45 (never affected).
- Steps: seed → run dry-run (assert it reports exactly the 2 affected nodes from (a), zero
  writes, and node (b)/(c) unaffected/unreported) → run `--confirm` (assert (a) now reads
  0.60, (b) untouched at 0.90, (c) untouched at 0.45) → re-run `--confirm` (assert
  idempotent — no further change, same report of zero *newly* affected rows).
- For index/constraint changes: n/a — no index/constraint touched.
- Result: to be captured by the build/review stage when the script is implemented and run
  against the fixture — this plan specifies the required proof, not the executed result.

## 6. Sign-off
- `dbcheck` clean: [ ] (to be run by the plan/refine cog on this item)
- reviewed by sentinel: [ ] (this item's file scope is `packages/decision-making` —
  primary owner is `atlas` per the work-trio table, but the migration script itself
  under `infra/migrations/` should get a `sentinel` pass per that path's ownership row)
- continuity smoke passed: [ ] (pending build)
- Approval marker used? **no** (not a destructive change; no `.db-change-approved` marker
  or `SYLPHIE_DB_CHANGE_APPROVED=1` needed — this is a documented, backed-up, idempotent,
  additive value correction, not a schema wipe or drop)
