# Migration plan — 20260702-014 (Replay-from-events)

## Verdict: N/A — no schema change, no migration script

The source explicitly scopes this as **read-only** ("Reads TimescaleDB event
history at scale (range scans). No writes, no schema change.") and the
non-goals section forbids changing what events are captured. Verified against
the actual schema:

- `infra/timescaledb/init/002-events.sql` defines the `events` hypertable
  (`id, type, timestamp, subsystem, session_id, drive_snapshot JSONB, payload
  JSONB, correlation_id, schema_version`). The replay tool only issues `SELECT`
  range scans against this table (by `timestamp`, `session_id`, `type`,
  `correlation_id`) — no `CREATE`, `ALTER`, `INSERT`, `UPDATE`, or `DELETE`.
- No new table, column, index, or pgvector dimension is proposed anywhere in
  the source or in this plan.

Per `pipeline/policies/db-change-safety.md` §"The gate", a change only needs a
migration plan when it hits a DB surface with a **write** (additive or
destructive). This item has no write surface. `pipeline.py dbcheck` will
likely flag the item as DB-touching on keyword grounds ("TimescaleDB",
"database") — that flag is a true positive for *touches* but the touch is
read-only, so no forward-migration / backfill / backup / REVERSE plan applies.

## One caveat surfaced during verification (not a migration, a scope finding)

`packages/cognition-service/schemas.py:112` (`TrainingSample`) requires
`fused_embedding` (768-dim), `episodic_context` (768-dim), and
`modality_embeddings` (per-modality dict) to be present on every sample fed to
`/cognition/train`. Verified against `packages/shared/src/types/event.types.ts`
(zero occurrences of "embedding" in the whole file) and against
`ActionExecutedEvent`'s actual payload (`actionId`, `actionType`,
`arbitrationType` only — see event.types.ts:567-576): **none of those
embedding fields are persisted anywhere in the event log today.** If replay
cannot deterministically recompute them from data already available elsewhere
(raw sensory payload, episodic memory), then either (a) full-fidelity
`TrainingSample` reconstruction genuinely requires a *new* event field — which
would be a schema change, and the source's own non-goals forbid absorbing that
into this feature's scope — or (b) the tool's real scope is narrower than
"regenerates labeled training samples" as literally stated. This is written up
as an `open_question` for `architect` in `plan.md`, not decided here, and it
does **not** change this migration verdict: even the narrower/degraded version
of the tool is still read-only against the existing schema.
