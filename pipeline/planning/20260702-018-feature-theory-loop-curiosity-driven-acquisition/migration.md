# Migration plan — 20260702-018 Feature: Theory loop — curiosity-driven acquisition + Tess confirmation

> Covers only the buildable Epic-A surface (018-a/b/c). Epic B (`Tess_Confirmed`
> provenance tier + its decay-rate wiring) is a second, additive migration to be written
> when Epic B actually tickets — not invented here, since its shape depends on the
> open questions in `plan.md` §2/§7 (whether `Tess_Confirmed` needs a new CANON exception
> changes nothing about additivity, but the exact decay rate and promotion-target
> confidence are undecided, so that migration's content would be guessed if written now).

## 1. Surfaces & impact class
- Stores touched: [ ] postgres  [ ] timescaledb  [x] neo4j-world  [ ] neo4j-self  [ ] neo4j-other
- Files/objects: new Neo4j node label `:Theory` (WORLD instance) with properties
  `{ claim, provenance, confidence, status, verdict_ref, spawned_from, created_at }`;
  new relationship type `:ABOUT` from `:Theory` to existing `:Entity`/`:Concept` nodes.
  No new provenance enum value in this slice — `:Theory` nodes use the existing
  `LLM_GENERATED` provenance value (already handled everywhere: `provenance.types.ts`
  base-confidence table, `confidence-decay.service.ts` 0.08/hr case, the
  `HALLUCINATED_KNOWLEDGE` untrusted-provenance set). The new `Tess_Confirmed` provenance
  value belongs to Epic B's migration, not this one.
- Impact class: **additive**. New label, new relationship type, new properties on nodes
  that don't exist yet. Nothing pre-existing is dropped, renamed, retyped, or
  dimension-changed.
- Contract decision authorizing it (if destructive): n/a — not destructive.

## 2. Forward migration (incremental path)
- Mechanism: hand-written Cypher in a new `infra/migrations/00N-add-theory-node.ts`
  dry-run/confirm script, following the house convention
  (`infra/migrations/001-legacy-pattern-rescope.ts` as reference), NOT an
  `infra/*/init/**` edit.
- Summary of the change: the script is a no-op in the true "migration" sense (Neo4j has
  no schema to ALTER for a brand-new label/property set — there is nothing to transform).
  Its real job is to **create the supporting constraint/index** so `:Theory.status` and
  `:Theory.claim` lookups are performant from day one, and to assert (dry-run) that zero
  `:Theory` nodes currently exist (proving this is genuinely a fresh addition, not a
  silent collision with pre-existing data under another label). Concretely:
  `CREATE INDEX theory_status_idx IF NOT EXISTS FOR (t:Theory) ON (t.status)` and a
  uniqueness-free existence check (Neo4j Community has no per-label uniqueness needed
  here since `:Theory` nodes have no natural business key).
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed — the writer
  code (`writeTheory` in 018-a) is the only thing that ever creates `:Theory` nodes;
  the migration script only adds the index.

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no**.
- Why it's safe (additive-only): `:Theory` is a brand-new label with no prior data under
  it anywhere in WORLD. No existing `:Entity`/`:Concept` node's shape, properties, or
  provenance changes — 018-b rewires the *write path* for future autonomous-research
  writes (so newly-produced knowledge lands as `:Theory` instead of `:Entity`), but does
  not touch any node already persisted from prior `RESEARCH_ENTITY` runs. Those legacy
  `:Entity`-shaped, `INFERENCE`-provenance nodes from before this fix are a **separate,
  explicit residual** — flagged here, not silently absorbed: whether to retroactively
  re-provenance/re-shape them into `:Theory` nodes is an open backfill question for
  whoever builds 018-b to raise as a governance `open_question` if the volume is
  non-trivial (a `MATCH (n) WHERE n.source = 'web_research' AND n.provenance_type =
  'INFERENCE' RETURN count(n)` dry-run count should be taken before build starts).

## 4. Backup + REVERSE
- Pre-write backup command: `neo4j-admin database dump world --to-path=<backup-dir>`
  (per house convention) before running the index-creation script live.
- Backup-failure behavior: hard-stop (exit 1) before any write: [x] confirmed (mirrors
  `001-legacy-pattern-rescope.ts`'s pattern).
- REVERSE: `DROP INDEX theory_status_idx IF EXISTS` followed by `MATCH (t:Theory) DETACH
  DELETE t` (safe only because, per §3, no data existed under this label before the
  migration — the reverse is "remove what this migration and its writer added," not a
  destructive rollback of pre-existing data). Note: `DETACH DELETE` is on the
  db-change-guard's blocked-command list for general use; the reverse step must run under
  the documented approval escape hatch (`SYLPHIE_DB_CHANGE_APPROVED=1` or the
  `.db-change-approved` marker citing this migration's decision id) if it's ever actually
  invoked, same as any other guarded destructive command in this repo.

## 5. Continuity proof (the review-cog smoke)
- Seed data used: a fixture WORLD graph with pre-existing `:Entity`/`:Concept` nodes
  (representative of current production shape) plus zero `:Theory` nodes.
- Steps: seed → apply forward (create index) → assert pre-existing `:Entity` node count
  and properties are byte-identical to pre-migration → call `writeTheory` once → assert
  exactly one new `:Theory` node exists and the pre-existing nodes are still untouched →
  (optional rollback per §4, re-assert pre-existing nodes still intact).
- For index/constraint changes: prove the index is rebuilt and picked up — run
  `SHOW INDEXES` (or `CALL db.indexes()`) after the migration and assert
  `theory_status_idx` appears `ONLINE`, then run a `MATCH (t:Theory {status:'open'})`
  query and confirm (via `EXPLAIN`) the planner uses the index rather than a full label
  scan.
- Result: to be produced by the **review** cog when this ticket actually builds — not
  fabricated here.

## 6. Sign-off
- `dbcheck` clean: [ ] — run `python pipeline/pipeline.py dbcheck 20260702-018` once this
  item is re-planned into `refine`.
- Reviewed by sentinel: [ ] — pending (owner per CLAUDE.md's `infra/**` /
  database-migration row is `sentinel`, conceptual reviewer `ashby`).
- Continuity smoke passed: [ ] — pending build.
- Approval marker used? **no** (nothing destructive is being delivered in this slice;
  the REVERSE step in §4 is documented for completeness but not expected to be invoked).
