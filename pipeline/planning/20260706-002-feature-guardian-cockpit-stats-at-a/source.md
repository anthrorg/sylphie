# Feature: Guardian Cockpit — stats at a glance + turn-inspector ("Impact of this turn") + search-everything

**Priority:** P1  ·  **Engineering level:** production
**Area / component:** frontend/ (guardian / local only) + a new read-only backend read-API. Owner: forge; conceptual reviewer: ashby; spine read-API query cost: sentinel.

> **✅ DESIGN-LOCKED — architect AD-0044** (was BLOCKED pending research). Build against the design-lock: `docs/decisions/architect-log.yaml` (AD-0044) + the research brief `docs/research/frontend-cockpit-ux-research.md`.
> **Locked organizing model:** a **flight-deck shell** (always-on vitals, status-by-exception) wrapped around a **time-travel *inspector*** (NOT a "debugger" — the word is banned from UI copy because the event spine is a *recording*, not a re-runnable program; vocabulary is "inspector/replay") with an **observability command line** (Cmd-K) — all three bound to a **single selected-turn value that re-scopes every panel**. The five spec surfaces (Cockpit / Her Mind / Her Growth / Timeline / Instruments) are views over the same recording at the same selected instant, not separate apps.
> **Honesty is structural (CANON Std-1):** three never-conflated visual tokens rendered by ONE shared status-chip — **earned value** vs **earned zero** vs **offline / unknown / theater**. A blank cell must never read as a healthy 0; offline is an explicit chip.

## Why (required)
The guardian needs to work in chat for a few minutes, then see exactly how that conversation impacted Sylphie. Today that means jumping between a legacy grid, three dialogs, a drawer, and a light-themed pop-out and reconstructing causality by hand. The raw material — the verbatim TimescaleDB event spine, the three graphs, drives, predictions — exists, but is organized by subsystem, not by the conversation, and there is **no turn-keyed read path over it yet** (see Preconditions).

## What it should do (required)
Three integrated modes on one dense surface, unified by the **selected turn** (a program-counter over the conversation-as-recording); selecting a turn re-scopes every panel to that instant.
- **Stats at a glance (flight deck):** always-on vitals (autonomy, drive levels, executor state, cost burn, prediction MAE, graph size, feed health) as live numbers, sparklines, and small-multiples — readable in seconds, no clicks. Density = **raise data-ink (Tufte)**, not decoration; status-by-exception (silence is the default, only deviations surface).
- **Causal drill-down — "Impact of this turn" (time-travel inspector):** selecting any turn loads what it did, read verbatim from the spine: drives moved + why, decision path (Type 1 / Type 2 / SHRUG) + confidence, perception at that moment, candidate facts staged + provenance, grounding of reply, episode recorded, supervisor verdict if sampled, prediction + later accuracy, LLM cost, and whether the model was used. **Inspect actual recorded state — never a reconstruction, never a what-if re-simulation.** Drill in place; do not navigate away.
- **Search / track-down-everything (command line, Cmd-K):** one **structured** query surface over the spine + three graphs + logs + drive history + predictions; results re-scope the whole cockpit ("every turn where she shrugged", "everything about entity X", "LLM-provenance facts < 0.4 never re-confirmed"). **NL query is OUT for v1** (LLM/theater risk).
- **Shared control:** a bottom scrubber + tracks; follow-live by default, pause on any selection, prominent jump-to-live, two clocks visible (selected instant + now). **Reverse-step scope = entire recorded history** (state is materialized per spine row, so it's an indexed read, not a window).
- **Deep-link rule:** every number reaches its raw evidence (the `InnerMonologuePanel` raw-JSON expansion is the existing primitive).
- **Honest detectors only** (see Preconditions #2/#5 and the ruling below).

## Detector honesty ruling (AD-0044 — build exactly this)
- **May surface as real "breakpoints"** (backend `AttractorMonitorService`, live): TYPE_2_ADDICT; HALLUCINATED_KNOWLEDGE (needs the unmeasured flag, Precondition #5); DEPRESSIVE_ATTRACTOR; PLANNING_RUNAWAY (label "failure-ratio only" — plan-proliferation leg unwired); PREDICTION_PESSIMIST; MOOD_BLEED (label its hostile-appraisal blind spot).
- **MUST NOT APPEAR / delete, do not deprecate:** the client-side `deriveAttractorAlerts` in `frontend/src/hooks/useObservatoryAlerts.ts` — it invents six fake detectors with hardcoded `risk_score: 0.5`, invented intervention copy, and fetches a non-existent endpoint then silently substitutes its fabrication (a standing Std-1 violation in the honesty-flagship surface). Also banned until earned: any coherence/contradiction breakpoint (scanner no-op, stub §0.5); the theater-check chip as currently fed (`is_grounded` flag-only, stub §3.1 — label or remove); convergence "graduation" milestones (theater). Tensor cognition renders "OFFLINE — no influence this turn" while stub §0.1 stands. `AttractorAlertBanner`'s return-null-when-unreachable becomes an explicit "detectors: offline" state.

## Preconditions (AD-0044) — must land before/with the cockpit build
1. **New spine read-API** — a turn index + per-turn "impact bundle" keyed by `correlation_id = 'turn:<turnId>'` (indexed), with a session/time-window fallback for events whose INSERT omits the correlation id (e.g. `communication.service.ts:1290`); time-window-attributed events render "attributed-by-time," not claimed-exact. (No such read path exists today.)
2. **Real attractor-status endpoint** exposing `AttractorMonitorService` results + spine `ATTRACTOR_STATE_ALERT` rows for timeline markers — **and delete** the client-side fabrication in #detector ruling above.
3. **`turn_id` stamped on every response message on the text path** (field exists at `types/index.ts:94`).
4. **WS zombie-socket fix** — already tracked as item `20260702-005` (also an AD-0043 launch gate); duplicate delivery corrupts turn identity.
5. **`DetectorResult` gets an explicit `unmeasured`/noData flag** so a Neo4j-down detector renders offline, not a healthy zero.

## Scope hints
Verified reusable (AD-0044 read the components): `ConversationPanel` (grounding badges), `MetricsPanel` Executor/DriveEngine (with a `pressureIsStale` flag), `MiniDriveChart`, `InnerMonologuePanel` (verbatim payloads + raw-JSON expansion = the deep-link primitive), `SupervisorPanel` (real controls), `NodeInspector` (provenance + confidence-vs-threshold), `ExplorerSearchBar` (graph-only; generalize for Cmd-K). `ObservatoryPanel` is poll-based / session-granular → Her-Growth material, not vitals. New build: the spine read-API (Precondition 1), the impact-bundle reader, the Cmd-K structured search, the turn/time scrubber. Owner: forge; conceptual: ashby; query cost: sentinel.

## Dependencies (required)
- **Design-lock delivered:** architect AD-0044 (this item is unblocked).
- **Depends on:** `feature-fe-shell-and-role-gate` (the shell) and the five Preconditions above (2, 3, 5 are new backend tickets; 4 is item `20260702-005`).
- **Conflict risk (same files) — do NOT run concurrently:** planning item `20260702-013-feature-observability-dashboard-snapshot-series`; the cockpit subsumes ad-hoc observability panels — coordinate/merge.
- References `20260702-002-bug-tensor-cognition-sidecar-is-dead`: cockpit renders its offline state truthfully, does not wait on the fix.

## Database impact (required)
**Touches a database / schema / migration?** no schema change / no migration — but it **requires new READ-ONLY endpoints** over the existing TimescaleDB event spine and Neo4j graphs (the spine read-API + the attractor-status endpoint). Reads only. **Build-time verify:** one SQL sweep confirming `correlation_id` coverage per event type on a live session before finalizing the impact-bundle join.

## Acceptance — how we'll know it works (required)
- Given a live guardian session, when the guardian lands on the cockpit, then core vitals render live with no interaction, and any offline channel shows an explicit offline chip (never a blank/zero).
- Given a completed turn, when selected, then every panel re-scopes to that instant and its full causal impact renders from the spine; events attributed by time-window are labeled "attributed-by-time," not exact.
- Given the inspector, then no control implies re-running or altering a turn (inspect-only; "debugger"/"re-run" vocabulary absent).
- Given Cmd-K structured search, when run, then results span spine + graphs + logs and clicking a result pivots the cockpit in place; no NL free-text query path exists in v1.
- Given the detector surface, then only the AD-0044 "real" detectors appear (with their labels/caveats), the client-side fabricated detectors are gone, and tensor shows "OFFLINE".
- Every displayed number deep-links to its underlying record.

## Non-goals / scope guard (required)
- No public-facing surfaces; no new gates/cognition (reads existing telemetry only); no color/token rework (deferred).
- **No re-simulation / what-if / re-run of turns** — inspect-only; "debugger" vocabulary banned from UI copy.
- **No NL/free-text query in v1** (structured search only).
- **No fabricated or unearned detectors** — the honesty ruling above is a hard boundary.
- Excludes the full Her Mind / Her Growth / Timeline / Instruments deep surfaces (separate item) beyond the at-a-glance layer.

## Jim's non-blocking calls (defaults locked in AD-0044; change if you disagree)
Final vitals-strip membership + deviation thresholds (default: the spec four + a feed-health channel); density-toggle default; watch-pin persistence (localStorage per guardian — veto?); keyboard reservation vs. push-to-talk.

## Source / references
architect AD-0044 (design-lock) · `docs/research/frontend-cockpit-ux-research.md` · `docs/frontend-experience-spec.md` §3A/§4A/§9 (epic 2) · architect AD-0043 (Std-3 semantics: confidence lifts on retrieval-and-use, not guardian confirmation) · design discussion 2026-07-02.
