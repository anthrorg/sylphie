# Feature: Unified frontend shell + deployment/role gate (public vs guardian), retire legacy dashboard

**Priority:** P1  ·  **Engineering level:** production
**Area / component:** frontend/ (shell, routing, build config). Owner: forge; conceptual reviewer: ashby.

## Why (required)
The frontend ships two overlapping dashboards — the new `/dashboard/*` sidebar shell and the entire legacy grid at `/legacy` — with divergent visual languages, behind one login-walled surface that tries to serve operators and newcomers at once. Jim's ruling (2026-07-02): where Sylphie runs decides who you are. A **local** install is the guardian (full instrument); the **online/hosted** version is the public test-drive only, where one shared instance grows in public. Nothing today gates by deployment, and the legacy shell is dead weight fragmenting the experience.

## What it should do (required)
- One app shell is the only shell; the `/legacy` dashboard (`Dashboard.tsx`) and its divergent styling are removed, any unique piece re-homed into the new shell.
- The app resolves deployment/role at runtime: **local build → guardian** experience (full); **hosted build → public** test-drive only. Guardian surfaces and data are unreachable on the hosted build, even by direct URL.
- **Video/camera perception is gated to local only** — no camera pipeline shipped or reachable on the hosted build.
- Guardian self-designation is available on local installs (see open decision: automatic on first run vs. explicit toggle).

## Scope hints
`frontend/src/App.tsx` (routing), `frontend/src/Dashboard.tsx` (legacy — remove), `frontend/src/layouts/DashboardLayout.tsx`, `frontend/src/components/Navigation/Sidebar.tsx`, Vite build/env for deployment target, `CameraPanel`/`usePerception` (gate off on hosted). Owner: forge; conceptual: ashby.

## Dependencies (required)
- **Conflict risk (same files) — do NOT run concurrently:** planning item `20260702-013-feature-observability-dashboard-snapshot-series` touches the frontend dashboard; coordinate so its snapshot-series page is re-homed into the new shell, not built against the legacy one.
- **Blocks** the other three FE experience items (guardian cockpit, guardian depth surfaces, public test-drive) — they build on this shell.
- Color/token (visual) system is deferred and tracked separately; this shell work uses current styling and needs no structural change when the tokens land.

## Database impact (required)
**Touches a database / schema / migration?** no — routing, build config, and component gating only.

## Acceptance — how we'll know it works (required)
- Given the hosted build, when a user requests any guardian route by URL, then they are gated to the public experience and no guardian data/telemetry is served.
- Given the hosted build, when the app loads, then no camera/video pipeline is initialized or reachable.
- Given the local build, when the installer designates themselves guardian, then the full instrument shell is available.
- The `/legacy` route and `Dashboard.tsx` grid no longer exist; a build-wide search shows a single shell.

## Non-goals / scope guard (required)
- No cockpit/Impact features, no public test-drive screens, no depth surfaces (each a separate item).
- No visual token/color rework (deferred, separate).
- No new backend endpoints beyond what deployment/role gating strictly requires.

## Source / references
docs/frontend-experience-spec.md §1 (model), §3 (layout), §9 (epic 1). Design discussion 2026-07-02.
