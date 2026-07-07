# Migration plan — 20260702-011 Consolidation loop (idle replay + insight synthesis)

> Filled per `pipeline/policies/db-change-safety.md`. **Status: provisional / blocked.**
> The actual shape depends on the architect ruling in `plan.md` §3 (Q1) — extend the
> existing `:Insight` shape vs. a new label. This plan covers the additive-only path
> either way; it cannot be finalized (mechanism, exact props) until Q1 resolves, and it
> cannot be executed at all until sibling item **20260702-015** (schema-versioning /
> migration framework) lands — there is currently no `infra/migrations/NNN-*.ts`
> convention target for Neo4j structural changes beyond the one legacy reference script.

## 1. Surfaces & impact class
- Stores touched: [x] neo4j-world (WKG). Not postgres/timescaledb/neo4j-self/neo4j-other.
- Files/objects: either (a) additive properties on the existing `:Insight` label
  (`packages/learning/src/pipeline/cross-session-synthesis.service.ts:441` shape) to
  carry episodic/theory source refs, or (b) a new node label (e.g. `:EpisodicInsight`)
  plus its own indexes — resolved by Q1.
- Impact class: **additive** in both branches of Q1 — no existing property is dropped,
  renamed, or retyped; no existing node is deleted. New properties/labels only.
- Contract decision authorizing it: none yet — pending the architect ruling this plan
  depends on (will be recorded in `docs/decisions/architect-log.yaml`, referenced from
  ticket 20260702-011-a).

## 2. Forward migration (incremental path)
- Mechanism: `infra/migrations/NNN-<name>.ts`, following the house convention
  (`infra/migrations/001-legacy-pattern-rescope.ts` as reference) — **the concrete
  numbered file cannot be written yet** because item 20260702-015 is the item that
  establishes this repo's Neo4j migration framework generally (schema_version stamping,
  ordered application on boot). This item's migration should be authored as one of the
  first migrations to ride that framework, not ahead of it.
- Summary of the change: add either new properties (source-episode-ids,
  source-theory-ids, `insight_origin: 'consolidation'`) to the existing `:Insight` shape,
  or a new label with its own minimal shape (id, provenance, confidence, insight_type,
  source refs) — mirroring the existing `:Insight` conventions so a future unification is
  possible without a rename.
- Confirm it is NOT delivered by editing `infra/*/init/**`: [x] confirmed (not planned).

## 3. Backfill assessment
- Do existing rows/nodes need transform or recompute? **no**.
- Why it's safe (additive-only): this change only adds new properties/label going
  forward for newly-written consolidation insights. Existing `:Insight` nodes written by
  `cross-session-synthesis` (conversation-reflection substrate) are untouched — they
  simply won't carry the new episodic/theory source-ref properties, which is expected
  (those fields are optional/absent on pre-existing rows, not required).

## 4. Backup + REVERSE
- Pre-write backup command: `neo4j-admin database dump` for the WKG (neo4j-world)
  instance, per house convention, before the migration script's `--confirm` run.
- Backup-failure behavior: hard-stop (exit 1) before any write: [x] confirmed (required
  by the house convention this migration must follow).
- REVERSE: additive-only change → reverse is `DETACH DELETE` on nodes/properties created
  by this migration's run-id (script should tag written nodes with a migration run
  marker to make this precise), or full restore from the pre-write dump if precision
  isn't achievable. No existing data is at risk either way.

## 5. Continuity proof (the review-cog smoke)
- Seed data used: a fixture WKG with pre-existing `:Insight` nodes (from
  conversation-reflection) plus sample episodes/theories.
- Steps: seed → apply forward migration → assert pre-existing `:Insight` node count and
  properties are unchanged (count + spot-check) → assert new consolidation
  insight-shape is queryable → (rollback only if the review cog needs to prove REVERSE).
- Result: not yet run — this item is not built; the review cog runs this once the ticket
  reaches `review`.

## 6. Sign-off
- `dbcheck` clean: [ ] — pending (run `python pipeline/pipeline.py dbcheck 20260702-011`
  once tickets are staged as contract nodes).
- reviewed by sentinel: [ ] — not yet requested (this item is not ready to build; see
  plan.md routing = replan).
- continuity smoke passed: [ ] — not run.
- Approval marker used? **no**.
