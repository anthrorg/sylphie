# Plan — 20260702-013: Observability dashboard (snapshot-series analytics page)

## Source verification

- `docs/future/sylphie-observability-spec.md` **exists** and has Part 1 (Snapshot
  Metrics Schema), Part 2 (Page Spec), Part 3 (Build notes) exactly as the source
  claims (`§15`, `§119`, `§163`). Source's row-by-row description matches the spec
  verbatim — no drift found.
- `apps/sylphie/src/controllers/metrics.controller.ts` is **1,817 lines** today
  (verified via `wc -l`), not the 1,777 the source cites — small drift (+40 lines),
  almost certainly from the in-flight EP-22 backend-audit build (item 20260702-001,
  now in `working`). Still a god-object either way; does not change any ticket. This
  item's own scope hint ("avoid growing metrics.controller.ts... put this in a
  properly layered module") is honored by putting the new read surface in a **new**
  controller/module, not by editing the existing one — so it is independent of
  Q-26 (the open architect question on how to *decompose* metrics.controller.ts).
  Verified no existing controller is named `observability`/`snapshot` — a fresh
  module is a clean addition, not a refactor.
- `frontend/src/components/Metrics/MetricsPanel.tsx` **exists** and is imported live
  by `frontend/src/pages/dashboard/AnalyticsView.tsx` (confirmed via grep) — this is
  the "dead/live-mixed" panel the source says item 20260702-005 (bug-audit-frontend-shared,
  now EP-26/TK-141..152, in `working`) fixes. The observability page is a **new,
  separate page** (snapshot-series, not live cognitive-cycle telemetry) — it does not
  reuse `MetricsPanel.tsx`'s dead branches, only (per the source) the WS-hook
  reconnect *pattern* EP-26 fixes, for its thin live layer (Row 0 last-snapshot-age,
  Row 3 live detector reads).
- **No snapshot/manifest infrastructure exists yet anywhere in the codebase**
  (`grep -i "snapshot_id|manifest"` across `apps/` returns zero snapshot-writer
  hits — the matches found are unrelated `face-snapshot.service.ts` / visual-memory
  code). Confirmed against `pipeline/planning/20260702-016-.../source.md`
  (`feature-snapshot-restore.md`): item 016 is the feature that will create
  `manifest.json` + the metrics block this page reads, and **it has zero contract
  nodes today** — it is still sitting unplanned in `pipeline/planning/`. This is a
  **hard, unresolved upstream dependency**: there is no manifest schema, no
  manifest storage location, and no snapshot-listing capability for this item's
  backend module to read from yet.
- `bug-audit-apps-sylphie-backend.md` → confirmed as pipeline item **20260702-001**,
  contract nodes **EP-22 / TK-109..118**, currently `working` (PR in flight via
  worktree-agents). `bug-audit-frontend-shared.md` → confirmed as pipeline item
  **20260702-005**, contract nodes **EP-26 / TK-141..152**, currently `working`.
  Both sequencing dependencies the source names are real, identified, in-flight
  contract work — not fiction.
- Frontend routing: confirmed `frontend/src/pages/dashboard/` is where dashboard
  pages live (sibling to the existing `AnalyticsView.tsx`, `GuardianView.tsx`) — a
  new `ObservatoryAnalyticsView.tsx` (name TBD by forge) fits the existing pattern,
  no new routing framework needed.

## existing_contract_overlap

- **EP-22 / TK-109..118** (item 20260702-001, `working`) — fixes
  `metrics.controller.ts` auth + `meanDriveResolutionTimes` + stops DrivePublisher
  fabricated-zero emission. This item's Row-3 health panels and Row-1 graduation
  data must not chart data from before that fix lands (source's own sequencing
  requirement) — **attach as a hard sequencing dependency, not an epic clone.**
- **EP-26 / TK-141..152** (item 20260702-005, `working`) — removes/wires dead
  `MetricsPanel.tsx` branches, fixes WS-hook reconnect. Same relationship: sequence
  after, reuse the reconnect pattern, don't resurrect the deprecated panel.
- **Item 20260702-016** (`feature-snapshot-restore`, P0, still unplanned, zero
  contract nodes) — the metrics-block-in-manifest producer this page's every
  historical panel reads. **Hard blocking dependency**, not yet a contract id to
  depend_on against.
- **Q-26** (open_question, scope EP-27, owner architect) — metrics.controller.ts
  god-object decomposition. Not directly in scope here since this item adds a new
  module rather than touching the existing controller, but flagged so nobody later
  "helpfully" folds the new snapshot-series routes into metrics.controller.ts.
- No existing epic already covers a snapshot-series analytics page, live-detector
  alarm strip, or a public/funder view — this is genuinely new frontend/backend
  surface, not a duplicate.

## Proposed epic

**EP (working id): 20260702-013-EP — "Observability dashboard: snapshot-series
analytics page"**
Owner: `forge` (frontend/**, thin backend module) / conceptual reviewer `ashby`.
Depends on item 20260702-016 shipping a `manifest.json` with the Part-1 metrics
block (governance dependency, see below) and on EP-22/EP-26 landing (sequencing,
per source and per this item's own non-goals).

### Cross-item dependency (governance, not a depends_on edge — 016 has no contract id yet)
Same pattern as existing `DEP-3` in the contract (a real dependency on a
not-yet-a-contract-node item). At refine/queue time this should be recorded as a
`dependency` governance entry: *"20260702-013's every ticket that reads snapshot
history is blocked on item 20260702-016 (feature-snapshot-restore) landing a
manifest.json + metrics-block schema — until then, ticket -a/-b can build the
UI shell + backend module against a hand-fixture manifest, but -c/-d/-e (which read
real snapshot data) cannot merge to a working demo."* Recommend NOT queuing this
epic for build until 016 has at least a stable, contract-committed manifest schema
(even if 016's own restore-tested-ness ships later) — building against a schema
that might still change is wasted/re-done work.

## Tickets (working ids)

### 20260702-013-a — Backend: snapshot-series read module (new controller, not metrics.controller.ts)
- **Engineering level:** production
- **Priority:** P2 (feature; source does not argue for higher)
- **Owner:** forge (backend), conceptual reviewer ashby
- **depends_on:** none within this epic (first ticket); **blocked externally** on
  item 20260702-016's manifest schema being contract-stable (see governance
  dependency above)
- **Given/When/Then acceptance criteria (each with a runnable check):**
  1. Given the manifest-listing directory (schema TBD by 016, stubbed here behind
     an injectable `SnapshotManifestReader` interface for testability), when
     `GET /api/observability/snapshots?range=7d` is called, then it returns the
     parsed metrics blocks for snapshots in range, sorted by timestamp.
     **Check:** `yarn --cwd apps/sylphie test observability.controller.spec.ts`
     — unit test with a fixture manifest directory (2+ fixture snapshots),
     asserts response shape + range filtering + sort order.
  2. Given the route lives in a **new** module (e.g. `observability.controller.ts`
     + `observability.service.ts`), when the module is registered, then
     `metrics.controller.ts`'s line count does not grow.
     **Check:** `git diff --stat apps/sylphie/src/controllers/metrics.controller.ts`
     against the PR shows zero lines changed in that file.
  3. Given the endpoint is read-only, when it runs against a live backend, then it
     issues zero writes to any store.
     **Check:** integration test asserts no `INSERT`/`UPDATE`/graph-write calls
     fire on the mocked store clients during the request (spy assertions in
     `observability.controller.spec.ts`).
  4. Given the read surface is anonymous-reachable per the source ("read-only
     over snapshots"), when the dynamic route-enumeration guard from EP-21/TK-BEH-1
     (item 20260702-001) runs, then the new GET routes are correctly classified as
     safe-to-be-public (no state mutation) and not flagged as an unguarded
     destructive route.
     **Check:** re-run the TK-BEH-1 e2e route-enumeration test after this PR merges;
     assert it still passes with the new routes present.
- **non_goals:** does not build the manifest reader against a real manifest format
  (016 owns that schema); does not touch `metrics.controller.ts`'s existing routes;
  no auth/user-management.

### 20260702-013-b — Frontend: page shell + Row 0 (vital sign) + time-range selector
- **Engineering level:** production
- **Priority:** P2
- **Owner:** forge, conceptual reviewer ashby
- **depends_on:** 20260702-013-a
- **Given/When/Then acceptance criteria:**
  1. Given ≥2 fixture snapshots served by -a's endpoint, when the new page loads,
     then Row 0 renders `uptime_since_last_wipe_hours` as the largest element on
     the page, colored green when the value increased since the prior snapshot and
     red when it decreased (a wipe).
     **Check:** `yarn --cwd frontend test ObservatoryAnalyticsView` — RTL test
     asserts the color class/style flips on a fixture pair where uptime drops.
  2. Given the time-range selector (24h/7d/30d/all), when no selection is made,
     then it defaults to 7d and is present with `[role=radiogroup]` (or button
     group) semantics for a11y.
     **Check:** same test file, assert default selected option === "7d".
  3. Given the backend is stopped (network error), when the page loads, then
     historical (snapshot-sourced) panels still render from the last successful
     fetch/cache and do not throw, showing a "backend unreachable, showing cached
     history" notice rather than a blank/crashed page.
     **Check:** RTL test with the fetch mock rejecting; assert the page still
     shows Row 0 content and the notice text.
- **non_goals:** no Row 1-4 content yet; no alarm strip yet (ticket -d).

### 20260702-013-c — Frontend: Row 1 graduation hero (Type-1 ratio trend + category stage table)
- **Engineering level:** production
- **Priority:** P2
- **Owner:** forge, conceptual reviewer ashby
- **depends_on:** 20260702-013-b
- **Given/When/Then acceptance criteria:**
  1. Given ≥2 fixture snapshots with differing `graduation.type1_ratio`, when the
     page loads, then the headline reads "Running N% of decisions without the LLM"
     with N computed from the latest snapshot, and the hero chart plots the ratio
     over the selected time range.
     **Check:** `yarn --cwd frontend test ObservatoryAnalyticsView.row1` — RTL
     asserts headline text interpolation and that the chart component receives
     the expected series-length prop.
  2. Given the per-category `by_category` array, when rendered, then the stage
     table shows one row per category with a shadow/audit/partial/full pill,
     agreement %, rolling MAE plotted against 0.10/0.15 reference lines, and
     decision count.
     **Check:** same test file, assert row count === fixture category count and
     each pill's text matches the fixture `stage` value.
  3. Given a category's `stage` differs between two consecutive fixture snapshots
     and the new value is `"partial"`, when the hero chart renders, then a
     milestone marker/annotation appears at that snapshot's timestamp on the
     Type-1 ratio line.
     **Check:** RTL test asserts a marker element renders at the corresponding
     x-position/timestamp prop.
- **non_goals:** does not implement the *auto-fire* milestone-snapshot-on-partial
  side effect (that is backend/-e's job — this ticket only renders a marker when
  the data already shows a transition).

### 20260702-013-d — Frontend + backend: alarm strip + Row 3 health (detector sparklines, drives, guilt panel)
- **Engineering level:** production
- **Priority:** P1 (source calls out Row 3 as "operator-critical" and sequences it
  immediately after the hero row, ahead of Rows 2/4 — a live safety-relevant signal,
  bumped above the default feature P2)
- **Owner:** forge (frontend) + backend touch in -a's module for the live detector
  read, conceptual reviewer ashby
- **depends_on:** 20260702-013-a, 20260702-013-c (shares layout scaffold)
- **Given/When/Then acceptance criteria:**
  1. Given a detector's live or latest-snapshot value exceeds its paired threshold,
     when the page is at any scroll position, then the alarm strip (fixed/sticky
     under Row 0) shows that detector.
     **Check:** RTL test scrolls the container (`window.scrollTo` mock) then
     asserts the alarm strip element is still present in the DOM / has
     `position: sticky|fixed` in its computed style.
  2. Given the five detectors' `{value, threshold}` pairs from the latest snapshot,
     when Row 3 renders, then each renders a sparkline with its threshold drawn as
     a reference line.
     **Check:** RTL/unit test asserts 5 sparkline components render, each with a
     `threshold` prop matching the fixture.
  3. Given `guilt_events`, `guilt_resolved_vindicated`, `guilt_resolved_punished`,
     `floor_vetoes` in the metrics block, when Row 3 renders, then the guilt panel
     shows all four counts distinctly labeled.
     **Check:** RTL test asserts all four labeled values are present and match
     fixture numbers.
  4. Given the live detector read added to -a's backend module, when it is
     exercised, then it produces zero writes to any store (same class of check as
     -a AC3) and reuses the EP-26 WS-hook reconnect pattern rather than a bespoke
     one.
     **Check:** integration test (no-write spy assertions) + a code-review check
     that the hook import comes from the shared reconnect utility EP-26 lands
     (grep for the shared hook name in the new file), not a duplicate impl.
- **non_goals:** does not add new detectors or change threshold values (data-layer
  scope, not this ticket's).

### 20260702-013-e — Frontend + backend: Row 2 (knowledge+trust) and Row 4 (experience) + auto-fire milestone snapshot on stage transition
- **Engineering level:** production
- **Priority:** P2
- **Owner:** forge (frontend) + meridian/sentinel touch for the auto-fire hook
  (backend trigger into whatever 016 exposes for "take a named snapshot now"),
  conceptual reviewer ashby
- **depends_on:** 20260702-013-a, 20260702-013-c; **externally blocked** on item
  20260702-016 exposing a callable "fire a milestone snapshot" operation (016 scope,
  not this item's to build) — this ticket only wires the *call*, not the snapshot
  mechanism itself.
- **Given/When/Then acceptance criteria:**
  1. Given `confidence_weighted_knowledge` and `hallucination_ratio` series, when
     Row 2 renders, then Chart A (knowledge mass) and Chart B (hallucination ratio
     vs. 0.20 threshold) render together in the same row/section.
     **Check:** RTL test asserts both chart components are present as siblings
     within the Row-2 container element.
  2. Given `wkg_nodes_by_provenance` across ≥2 fixture snapshots, when Row 2
     renders, then the provenance ladder renders as a stacked area with exactly
     the ordered series `llm_generated → inference → tess_confirmed`.
     **Check:** RTL test asserts the stacked-area component's series prop order.
  3. Given `events_this_period` and `verified_training_samples` series, when
     Row 4 renders, then the throughput chart plots both, and replay-buffer-fill/
     encode-rate/session count render as operator-only detail stats.
     **Check:** RTL test asserts chart series count === 2 and the three detail
     stats render with fixture values.
  4. Given a fixture pair of consecutive snapshots where some category's `stage`
     newly becomes `"partial"` (same transition condition as -c AC3), when the
     backend detects this on the manifest-reader side, then it calls the
     milestone-snapshot trigger exactly once (not once per category, not
     repeatedly on re-poll of the same pair).
     **Check:** unit test on the backend service — mock the trigger, feed the
     same snapshot pair twice, assert the trigger call count is exactly 1 across
     both invocations (idempotent-per-transition).
- **non_goals:** does not implement the milestone-snapshot mechanism, alert
  delivery/paging, or Tess-confirmation wiring (Tess is explicitly future per the
  spec: "once Tess is wired...").

### 20260702-013-f — Frontend: public/funder stripped view
- **Engineering level:** prototype (source explicitly marks this "(later)" and
  scopes it to a stripped layout, not a separate app — lower rigor than the
  operator page)
- **Priority:** P2
- **Owner:** forge, conceptual reviewer ashby
- **depends_on:** 20260702-013-c, 20260702-013-d, 20260702-013-e (reuses their
  components — Row 0 + Row 1 hero + provenance ladder + one health badge)
- **Given/When/Then acceptance criteria:**
  1. Given the same snapshot data source as the operator page, when the public
     view route renders, then it shows exactly Row 0, the Row 1 hero chart, the
     Row 2 provenance ladder, and one collapsed health badge — no other panels.
     **Check:** RTL test on the public view component asserts the rendered panel
     count === 4 and their identities (by test-id) match that list exactly.
  2. Given the public view, when it renders, then it reuses the Row 0/1/2/3
     components built in -b/-c/-e/-d (not a forked copy), verified by the same
     component modules being imported.
     **Check:** static import-check test (or code review) asserting the public
     view file imports from the shared component modules, not a duplicate file.
  3. Given the public view is meant for external/funder eyes, when it renders,
     then no auth/login work is present (per explicit non-goal) and it is reachable
     at a distinct route from the operator dashboard.
     **Check:** route test asserts a distinct path (e.g. `/observatory/public`)
     resolves to the public component, and grep confirms no new auth guard files
     were added for this ticket.
- **non_goals:** no auth/user-management (source is explicit); not a separate app/
  deployable; no new metrics beyond what the operator page already has.

## Sequencing summary
`-a → -b → -c → {-d, -e in parallel} → -f`. Whole epic additionally gated on:
item 20260702-016 (manifest schema, external, not yet contract) for any ticket
touching real snapshot data (-a's real reader, -c/-d/-e's real charts); EP-22
(item 001) and EP-26 (item 005) landing first per the source's explicit sequencing
("must never chart fabricated telemetry" / "don't resurrect the deprecated panel").

## Migration / DB gate

See `migration.md` — **n/a**. This item is read-only over files (snapshot
manifests, once 016 creates them) and existing live stores; no schema surface.
Deliberate n/a note written per the DB gate policy (source's own DB-impact section
already says "no" and verification found no schema-owning code in this item's
scope).

## split_recommendation

None required as a *pipeline-item* split — the source is already one coherent
feature (one page, one data source) and the row-by-row ticket breakdown above
(-a through -f) is the atomic decomposition. The one thing worth flagging: ticket
-f (public view) is materially lower rigor (prototype) than -a..-e (production) and
has no acceptance-criteria dependency forcing it to ship in the same PR/release as
the operator page — if Jim wants to time-box the public view separately (e.g. after
funder conversations firm up), it can be pulled from this epic's queue order without
touching -a..-e. Not a design fork, just a sequencing flexibility note.

## open_questions

- **None that need architect/Jim ruling to plan this item.** The one real
  ambiguity — "when can this epic actually be queued to build?" — is not a design
  fork, it's a hard sequencing fact (item 20260702-016 has no manifest schema yet)
  that the governance dependency above captures. Recommend refine keep -a/-b
  buildable now against a fixture/interface (`SnapshotManifestReader`) so frontend
  shell work isn't blocked on 016's timeline, while flagging -c/-d/-e/-f as
  not-mergeable-to-real-data until 016 lands a stable schema.
