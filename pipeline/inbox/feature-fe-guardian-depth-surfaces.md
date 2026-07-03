# Feature: Guardian depth surfaces — Her Mind, Her Growth, Timeline, Instruments

**Priority:** P2  ·  **Engineering level:** production
**Area / component:** frontend/ (guardian / local only). Owner: forge; conceptual reviewer: ashby.

## Why (required)
Beyond the cockpit's at-a-glance + impact view, the guardian needs full-depth surfaces to inspect memory and reasoning, track growth over time, replay past turns, and operate controls. Today these exist as scattered, inconsistent panels and dialogs; they need one home and one organizing logic.

## What it should do (required)
Four surfaces, one click from the cockpit, unified under the shell:
- **Her Mind:** all three knowledge graphs (WKG / SKG / OKG) full, with provenance + confidence and node-inspector deep-links; the reasoning trace / inner monologue; working-memory activation; episodic memory.
- **Her Growth:** the autonomy curve over the session, prediction-accuracy (MAE) trend, experiential-provenance ratio, a graduation-events feed (milestone only when a decision *really* graduated — **convergence "graduation" milestones are theater per AD-0044 and must NOT be surfaced**), developmental stage. (`ObservatoryPanel` is the honest material here — poll-based / session-granular.)
- **Timeline:** scrub the session; replay (inspect, not re-run) any past turn's full impact (re-uses the cockpit inspector component + the shared selected-turn control).
- **Instruments (ops bay):** supervisor live verdicts + controls; system/maintenance logs with level filtering; tensor/bootstrap progress (renders OFFLINE while stub §0.1 stands); guarded destructive actions (reset, skills) behind confirm. **Detector surfaces show only the AD-0044 "real" detectors**; the client-side fabricated detector hook is deleted (see the cockpit item's honesty ruling).

## Scope hints
Reuse `GraphPanel`/`ExplorerView`/`NodeInspector`, `ObservatoryDashboard` (growth metrics), `InnerMonologuePanel`, `SupervisorPanel`, `System`/`MaintenanceLogsPanel`, `SkillManager` (guarded reset). Owner: forge; conceptual: ashby.

## Dependencies (required)
- **Design-lock delivered:** architect AD-0044 covers these surfaces too (they are views over the same recording at the same selected instant).
- **Depends on:** `feature-fe-shell-and-role-gate` and `feature-fe-guardian-cockpit-and-impact` (shares the inspector component, the selected-turn control, the spine read-API precondition, and the design-lock).
- **Conflict risk — do NOT run concurrently:** planning item `20260702-013-feature-observability-dashboard-snapshot-series` overlaps Her Growth / observability — coordinate/merge.
- Guarded destructive actions must not re-expose the endpoints tracked in `20260702-001-bug-main-backend-unauthenticated-destructive-endpoints`; that fix is a prerequisite for safely surfacing reset even to a guardian.

## Database impact (required)
**Touches a database / schema / migration?** no — read-only views over existing stores plus already-existing control endpoints; no schema or migration.

## Acceptance — how we'll know it works (required)
- Given the guardian build, when opening Her Mind, then all three graphs render with provenance/confidence and inspector deep-links resolve to the underlying nodes/edges.
- Given a multi-turn session, when opening Timeline and selecting a past turn, then its full impact replays identically to the live cockpit view.
- Given Her Growth after a session has run, then the autonomy curve and MAE trend render from real metrics, and a graduation event appears only when one really occurred.
- Given Instruments, when a destructive action is invoked, then it is guarded, requires confirm, and is authenticated.

## Non-goals / scope guard (required)
- No public surfaces; no new cognition/behavior; no color rework (deferred).
- Does not build new supervisor interventions — surface existing ones honestly and label unbuilt ones as such.

## Source / references
architect AD-0044 (design-lock) · docs/research/frontend-cockpit-ux-research.md · docs/frontend-experience-spec.md §3A, §4A, §9 (epic 3) · design discussion 2026-07-02.
