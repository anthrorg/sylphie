# Feature: Coordinated Sylphie Snapshot + tested restore across all five stores (with metrics block)

**Priority:** P0  ·  **Engineering level:** production
**Area / component:** persistence / infra (all stores)

## Why (required)
Sylphie's accumulated state (four Neo4j graphs, Postgres drive state, TimescaleDB event
history, tensor weights + EWC Fisher anchors) is wiped between iterations, so the tensor
never accumulates enough verified experience to graduate. The stores cross-reference each
other, so backing them up at different moments produces a corrupt snapshot (tensor
"remembers" events the log no longer contains). Nothing else on the roadmap matters until
a wipe is survivable. Additionally, every snapshot is a timestamped state-of-the-self —
if a metrics block isn't captured from the first snapshot onward, the early growth curve
(the steepest, most valuable part of the time series) is lost forever.

## What it should do (required)
A **Sylphie Snapshot** is a single restorable artifact capturing all five stores at one
logical point in time:
- **Coordination protocol:** quiesce the decision cycle (reuse the existing concurrency
  guard / epoch fence) → record a TimescaleDB event-id watermark as the logical clock →
  dump all stores (Neo4j dumps per instance, `pg_dump` for drive state, Timescale up to
  the watermark, tensor checkpoints + Fisher anchors) → checksum every file into a
  `manifest.json` (snapshot id, UTC timestamp, code git SHA, schema_version,
  tensor_arch_version) → resume the cycle.
- **Metrics block in the manifest**, computed during the quiesce window, per the schema in
  `docs/future/sylphie-observability-spec.md` §1: graduation (type1_ratio, by_category),
  knowledge (nodes by provenance, confidence mass, hallucination_ratio, theory counts),
  health (detector values+thresholds, all 12 drives, guilt/veto counters), experience
  (event counts, verified samples, replay buffer fill), integrity flags, and
  `uptime_since_last_wipe_hours`. All cheap aggregate queries — counts, not scans.
- **Restore is a first-class, tested operation:** one command rebuilds all five stores from
  a snapshot and verifies checksums. EWC Fisher anchors always travel with weights
  (`tensor/fisher/` is non-optional).
- **Cadence:** automated rolling snapshots (every N hours + before every deploy) with an
  hourly→daily→weekly retention ladder, plus named milestone snapshots that are never
  auto-deleted.

## Scope hints
`infra/**` (owner: `sentinel`, conceptual reviewer `ashby`); tensor checkpoint paths in
`packages/cognition-service/**` (`meridian`); metrics aggregate queries touch all stores
read-only. Quiesce hook lives near the executor cycle (`cortex` consult).

## Dependencies (required)
None hard — this is the root of the persistence chain. Blocks: feature-schema-versioning,
feature-tensor-contract, feature-observability-dashboard, feature-replay-from-events.
Conflict note: **bug-audit-drive-engine** edits `infra/postgres/init/**` and
`infra/timescaledb/init/002-events.sql` (same `sentinel` territory) — sequence, don't run
concurrently.

## Database impact (required)
**Touches a database / schema / migration?** yes
All five stores are read (dumped) — read-only in normal operation. The **restore path
writes all stores** and must respect the db-change-guard (restore is an explicit,
Jim-approved operation, never autonomous). No schema changes to existing data; adds
manifest/metadata artifacts only.

## Acceptance — how we'll know it works (required)
1. Given a running system, when the snapshot command runs, then a snapshot directory is
   produced with manifest, checksums, all five store dumps, tensor weights + Fisher, and
   a populated metrics block — and the decision cycle resumes afterward.
2. Given a snapshot, when the restore command runs against empty stores, then all five
   stores are rebuilt, checksums verify, and the system boots against the restored state.
3. Given a restored system, when compared to the pre-snapshot state, then WKG/SKG/OKG node
   counts, drive values, event watermark, and tensor checkpoint hashes match the manifest.
4. Given two consecutive snapshots, when their manifests are diffed, then the metrics
   block yields a valid trend point (e.g. `events_this_period` matches the watermark delta).
5. Snapshot-during-writes test: events emitted during the quiesce window are either fully
   in or fully out of the snapshot (watermark consistency), never torn.

## Non-goals / scope guard (required)
No schema-version migration framework (separate feature). No dashboard/page (separate
feature). No incremental/streaming backup optimization — full dumps are fine at current
scale. No cloud/offsite replication yet.

## Source / references
`docs/future/sylphie-persistence-migration-plan.md` §1–§2, §7 (build order item 1);
`docs/future/sylphie-observability-spec.md` §1 + Part 3 ("schema first, before the next
snapshot").
