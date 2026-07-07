# Opus plan-verify verdict — 20260702-013

verdict: **needs-rework**

## Summary
Plan is well-researched: I spot-checked every load-bearing claim against the codebase and all verify — the observability spec (Parts 1-3), metrics.controller.ts at 1,817 lines, no existing observability/snapshot controller, MetricsPanel.tsx imported by AnalyticsView, item 016 with genuinely zero contract nodes, and real DEP-3/Q-26/EP-22/EP-26/TK-BEH-1 references. The hard upstream dependency on item 016 (unbuilt snapshot producer) is handled correctly as a governance dependency in the existing DEP-3 pattern rather than a guessed design fork, so no replan is needed. Two fixable gaps block queue: (1) a factual priority error — the source header explicitly says P1 for the whole feature but the plan calls it P2 ('source does not argue for higher', which is false) and silently downgraded 5 of 6 tickets, a priority change policy says surfaces to Jim; (2) five source-named panel elements have no pinned acceptance criterion (alarm strip covers only 1 of 3 trigger conditions; Row 3 12-drive trend/total pressure; Row 1 LLM-calls-per-decision trend; Row 0 companion stats; Row 2 knowledge small-stats), so a builder could pass all ACs and still ship an incomplete operator page. ACs that exist are genuinely runnable and CANON is clean (read-only, DB n/a, theater gated on EP-22). Send back to refine to tighten ACs and reconcile priority; do not queue for build until item 016 lands a contract-committed manifest schema (build -a/-b against the SnapshotManifestReader fixture only if starting early).

## Critical gaps
- Priority factual error: source header says P1 for the whole feature; plan classifies P2 and states ticket -a 'source does not argue for higher' (false). 5 of 6 tickets silently downgraded P1->P2 — a priority change that per policy surfaces to Jim.
- Ticket -d alarm strip AC covers only detector-over-threshold; source names two more trigger conditions (failed integrity check, floor-checksum failure) with no AC.
- Ticket -d: Row 3 '12-drive trend view + total pressure' is in the title but has no acceptance criterion.
- Ticket -c: Row 1 'LLM-calls-per-decision trend' has no acceptance criterion.
- Ticket -b: Row 0 companion stats (total events, unique users, last snapshot age) have no acceptance criterion.
- Ticket -e: Row 2 knowledge small-stats (OKG people/procedures/insights/theory confirm/refute) have no acceptance criterion.
- Build caution (not a plan defect): Row 3 live drive reads must reuse existing read surfaces, not add a new pull/RPC path into the drive process (drive-event-standard).

