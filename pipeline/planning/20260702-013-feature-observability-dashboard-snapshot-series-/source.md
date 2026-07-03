# Feature: Observability dashboard — snapshot-series analytics page

**Priority:** P1  ·  **Engineering level:** production
**Area / component:** frontend / analytics (read-only over snapshots + live stores)

## Why (required)
Plenty is observable live, but there is no **time axis** and no **plain-language verdict**
on top of the signals. One page must answer, in 30 seconds, for a tired operator (and
later a funder): is she graduating off the LLM? Is knowledge growing *and* staying
trustworthy? Is she healthy or drifting? Is she accumulating experience? The snapshot
sequence (see feature-snapshot-restore) already carries the metrics block — this page is
a view over that history plus a thin live layer.

## What it should do (required)
Layout: the answer is the headline, the chart is the evidence; most-important-first.
- **Row 0 — vital sign:** `uptime_since_last_wipe_hours`, huge; green climbing, red on
  reset. Companion stats: total events, unique users, last snapshot age. Alarm strip
  beneath it: any detector over threshold, failed integrity check, or floor-checksum
  failure, visible regardless of scroll.
- **Row 1 — graduation (the hero):** "Running N% of decisions without the LLM" headline;
  Type-1 ratio over time with milestone markers; per-category stage table
  (shadow→audit→partial→full pills, agreement %, rolling MAE vs 0.10/0.15 lines,
  decision counts); LLM-calls-per-decision trend.
- **Row 2 — knowledge + trust together:** confidence-weighted knowledge mass climbing
  beside hallucination_ratio vs its 0.20 threshold; provenance ladder as stacked area
  (llm_generated → inference → tess_confirmed); small stats (OKG people, procedures,
  insights, theory confirm/refute).
- **Row 3 — health:** five detector sparklines each against its threshold line; 12-drive
  trend view + total pressure; guilt panel (guilt events, vindicated vs punished
  resolutions, floor vetoes).
- **Row 4 — experience:** events-per-period + verified-training-samples throughput;
  replay-buffer fill, encode rate, sessions.
- **Cross-cutting:** time-range selector (24h/7d/30d/all, default 7d); milestone markers
  on every time axis; historical trends read **snapshots only** (never the live cognitive
  cycle); live panels are read-only and briefly cached. Auto-fire a milestone snapshot +
  alert when a category first crosses to `partial`.
- **Public/funder view (later):** Row 0 + Row 1 hero + provenance ladder + one health
  badge — same data, fewer panels.

## Scope hints
`frontend/**` (owner: `forge`, conceptual reviewer `ashby`); a small read-only backend
surface for snapshot-series queries (avoid growing `metrics.controller.ts` — it is a
flagged 1,777-line god-object; put this in a properly layered module). Detector/drive
live reads exist already.

## Dependencies (required)
Depends on **feature-snapshot-restore** (the metrics block is the data source — without
it there is no time series). Build order within this feature: Row 0 + Row 1 → Row 3
alarms → Rows 2 & 4 → public view. Sequence AFTER **bug-audit-apps-sylphie-backend**
(it fixes `metrics.controller.ts` auth + the broken `meanDriveResolutionTimes` metric,
and stops DrivePublisher emitting fabricated zeros — this dashboard must never chart
fabricated telemetry) and AFTER **bug-audit-frontend-shared** (it removes/wires the dead
`MetricsPanel.tsx` branches and fixes the WS-hook reconnect pattern this page's live
panels will reuse — don't resurrect the deprecated panel).

## Database impact (required)
**Touches a database / schema / migration?** no
Reads snapshot manifests (files) for all trends; live panels read existing stores
read-only. No schema changes.

## Acceptance — how we'll know it works (required)
1. Given ≥2 snapshots on disk, when the page loads, then Row 0 shows uptime and Row 1
   renders the Type-1 ratio trend from the manifests alone (verifiable with the live
   backend stopped — historical panels still render).
2. Given a detector value crossing its threshold in the latest snapshot/live read, then
   the alarm strip shows it at any scroll position.
3. Given a category whose stage changes to `partial` between two snapshots, then a
   milestone snapshot fires automatically and the transition is annotated on the hero
   chart.
4. Rendering the page produces zero writes to any store and no measurable slowdown of the
   decision cycle (observability must not perturb the observed).

## Non-goals / scope guard (required)
No new instrumentation beyond the snapshot metrics block (if a panel needs a metric the
block lacks, that's a change request to the snapshot feature, not ad-hoc live queries).
Public view is a stripped layout, not a separate app. No auth/user-management work.

## Source / references
`docs/future/sylphie-observability-spec.md` Part 2 + Part 3.
