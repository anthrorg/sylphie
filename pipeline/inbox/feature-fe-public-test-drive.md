# Feature: Public Test-Drive — Landing → What-to-expect → Meet → Wrap (hosted, zero-trust)

**Priority:** P1  ·  **Engineering level:** production
**Area / component:** frontend/ (public / hosted) + hosted enforcement. Owner: forge; conceptual reviewer: ashby; hosted enforcement: sentinel.

## Why (required)
The hosted online experience is for anyone to meet and test Sylphie, and for her to grow in a public space. Today the front door is a bare login wall into an operator's console — no expectations set, no privacy framing, no bounds. A stranger should leave knowing what she is, what happened between them, and that nothing was faked or leaked.

## What it should do (required)
A four-step public pathway, with no operator surfaces reachable:
- **Landing** (no wall): who she is, honest status, a "Meet her" button, and a "run her locally" pointer.
- **What-to-expect** (consent gate before entry): the zero-trust privacy pact (don't share personal facts), early-development honesty, the rate/time limits, "no camera on the hosted demo", and "what you teach stays a candidate until a guardian confirms it". Requires explicit acknowledge to enter.
- **Meet:** focused chat with grounding badges (grounded / inferred / unsure) and a first-class "I don't know"; her mood as one headline; a live user-relative knowledge slice (this session's candidate facts, marked pending-guardian); one honest autonomy headline with an on-tap explainer; a visible time/message budget.
- **Wrap** (limit reached): the session knowledge slice as a keepsake + download / community CTAs.
- **Enforcement:** rate + time limits enforced; only headline metrics exposed; operator-grade data (other users, drive internals, supervisor, telemetry, cost, controls) not served to the public build; candidate-only staging and no cross-user reads.

## Scope hints
New public pages in `frontend/src` (Landing, Consent/What-to-expect, Meet, Wrap); `ConversationPanel` (grounding badges already present); a scoped user-KG-slice view; budget/limit UI. Backend: rate/time limiting + public-scoped read endpoints (meridian / forge); zero-trust query scoping (atlas / sentinel). Owner: forge; conceptual: ashby.

## Dependencies (required)
- **Depends on:** `feature-fe-shell-and-role-gate` (deployment/role gate + hosted video removal).
- **Launch-gating prerequisites — do NOT re-file (already tracked); must land before public exposure** (per architect ruling AD-0043): `20260702-001-bug-main-backend-unauthenticated-destructive-endpoints` (anon destructive endpoints) and `20260702-005-bug-frontend-unmount-reconnect-zombie-sockets-br` (browser-exposed API key + zombie reconnect).
- **Zero-trust depends on real person-fact isolation** — the known WKG person-fact leak (§2.8) and related items (`20260702-008`, `20260702-010`) must resolve, or the public build must hard-scope to candidate-only / no-cross-user reads. Dedupe against those; do not re-file isolation.
- Open decisions (Jim): the real rate/time numbers; session ephemeral vs. persisted; voice on public keep vs. cut.

## Database impact (required)
**Touches a database / schema / migration?** unknown — rate/time limiting may need a lightweight session/limit store (in-memory or a small table / redis); the knowledge slice is read-only over existing graphs. No migration of core stores expected — planning to confirm.

## Acceptance — how we'll know it works (required)
- Given the hosted build, when a stranger arrives, then they see the Landing and must pass the What-to-expect consent screen (privacy pact + limits shown) before reaching Meet.
- Given a Meet session, when she replies, then grounding badges render and "I don't know" is a normal answer; her mood shows as one headline; the user-relative candidate-fact slice updates live and marks facts pending-guardian.
- Given the rate/time budget is exhausted, when the user continues, then they are moved to Wrap with their session keepsake and a download CTA.
- Given the public build, when probing for operator data (other users, telemetry, controls), then none is served.

## Non-goals / scope guard (required)
- No guardian/cockpit surfaces; no video on hosted; no color rework (deferred).
- Does not fix the launch-gating security bugs itself (tracked separately) — it depends on them.
- No account system unless the persistence decision requires it (default: ephemeral).

## Source / references
docs/frontend-experience-spec.md §3B, §4B, §6, §9 (epics 4 & 5). Architect ruling AD-0043 (launch gating). Design discussion 2026-07-02.
