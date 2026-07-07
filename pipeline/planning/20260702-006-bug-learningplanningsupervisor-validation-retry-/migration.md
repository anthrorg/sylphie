# Migration assessment — 20260702-006

## Verdict: N/A — no schema/structural migration required

`pipeline.py dbcheck` will likely flag this item as DB-touching (it mentions Neo4j, WORLD graph,
provenance, confidence, TimescaleDB) — this note explains why, despite that, no `NNN-*.ts` migration
script is needed for the 4 tickets in `plan.md`.

## Surfaces touched, and why each is additive/non-structural

| Surface | What changes | Structural? |
|---|---|---|
| Neo4j WORLD | `ActionProcedure` nodes created from the correct (refined) `PlanProposal` instead of the stale original (ticket -a); typed-edge `provenance_type` / `confidence` property *values* written by `writeTypedEdge`/`edges.push` change from always-GUARDIAN/0.60 to CANDIDATE/capped when the subject is an unverified conversational speaker (ticket -c); a per-speaker `:Candidate` subject node is MERGEd via the same `grounding_person_id`-keyed pattern already used for value entities in this file (ticket -c) | No — no new labels, no new constraints/indexes, no new properties outside the existing `provenance_type`/`confidence`/`grounding_person_id` property set already written by this exact file today |
| TimescaleDB `events` table | The `payload` JSONB `has_planned` flag is set conditionally instead of unconditionally in the ingest `finally` block; a `deferred_reenqueue_rejected` reason is added to an existing `eventLogger.log('OPPORTUNITY_DROPPED', ...)` call already used elsewhere in the same file (ticket -d) | No — no column/index/schema change; same `UPDATE events SET payload = jsonb_set(...)` pattern already in the file, just gated by a condition |

All four tickets change **application logic that decides what value to write**, using the **existing**
Neo4j property model and the **existing** TimescaleDB `events.payload` JSONB shape. No `CREATE
CONSTRAINT`, no new Neo4j label, no new Postgres/Timescale column, no pgvector dimension change, no
embedding-version bump.

## Backfill assessment (per policy §3 — "no backfill needed" must be justified, never assumed)

**Forward fix (these 4 tickets): no backfill required.** Once shipped, all *new* writes use correct
provenance/subject/proposal/queue-mark logic going forward. Nothing about the forward fix requires
touching existing rows/nodes.

**Historical data (out of scope for these tickets, flagged as OQ-1 in plan.md):** rows/nodes written
*before* this fix may carry incorrect state:
- `ActionProcedure` nodes possibly written from a stale (attempt-1, failing) proposal instead of the
  refined one that actually passed validation (ticket -a's bug).
- Conversation-derived typed edges stamped GUARDIAN/0.60 provenance that should have been
  CANDIDATE/capped, and/or attached to an arbitrary noun subject instead of the correct speaker (ticket
  -c's bug).

Whether to run a one-time corrective pass over this historical data is **explicitly not decided here** —
per the source item itself ("flag for a migration-plan decision, not a schema change") this needs a
governance call (OQ-1) on cost/risk versus leaving historical data as-is. **If** a backfill is later
approved, it must follow the house convention in `pipeline/policies/db-change-safety.md`: a
dry-run-by-default, `--confirm`-to-apply, idempotent, backed-up, REVERSE-documented Cypher script in
`infra/migrations/NNN-*.ts` — never an ad hoc one-off query. This migration.md does not authorize that
work; it only names it as deferred.

## Backup + REVERSE

Not applicable — no forward migration script is part of this item's scope (see above). If the optional
historical backfill (OQ-1) is later approved as its own piece of work, its own migration.md will specify
backup + REVERSE per policy at that time.

## Continuity proof

Not applicable — no schema/structural change means there is nothing for the review cog's continuity
smoke to prove beyond the tickets' own unit tests (already specified in `plan.md`'s acceptance criteria).

## No silent wipe

Not applicable — no destructive operation of any kind is part of this item's scope.
