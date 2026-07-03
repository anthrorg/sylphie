# Plan — 20260625-002 — Codebase Audit Remediation Roadmap

- **Type:** feature · **Route:** EPIC (multi-ticket) · **DB:** yes (P0) · **size_hint:** large

## Classification (plan cog)
Ingest guessed `unknown`. This is a **feature/epic**: a remediation roadmap with 9
findings, each a candidate ticket. Not a single ticket — route = epic decomposition.

## Discovery
The source is itself an audit artifact and names exact files (verified present):
infra/postgres/init/001-runtime-user.sql, packages/decision-making/src/decision-making.service.ts,
apps/sylphie/src/gateways/webrtc.gateway.ts, metrics.controller.ts. Full per-finding
evidence already lives in docs/audits/*. So discovery here = confirm files exist + map
each finding to its owner (the doc already assigns owners); no fresh investigation needed.

## Proposed contract structure (STAGED — not written to contract.yaml; contract_write=staged)
Epic: **EP-AUDIT** — "Codebase audit remediation (2026-06-21)"

| Ticket | Finding | Priority | Owner | DB? |
|---|---|---|---|---|
| TK-AUDIT-1 | P0 drive_rules write-protection (REVOKE + RLS) | P0 | sentinel (architect decides) | **YES** |
| TK-AUDIT-2 | decision-making.service.ts god-object decomposition | P1 | cortex (architect seams) | no |
| TK-AUDIT-3 | metrics.controller.ts god-object + layering inversion | P1 | forge | no |
| TK-AUDIT-4 | dead fork-based IpcChannelService + stale docstring | P1 | drive | no |
| TK-AUDIT-5 | /cognition deliberation leg computed-then-discarded | P1 | meridian | no |
| TK-AUDIT-6 | orphaned /cognition/phase-transition → EWC has no trigger | P1 | architect | no |
| TK-AUDIT-7 | WebRTC signaling gateway server-side no-op | P1 | vox/forge | no |
| TK-AUDIT-8 | 11 duplication clusters → consolidate into @sylphie/shared | P2 | per-owner | no |
| TK-AUDIT-9 | dead exports + no-console lint rule | P2 | cleanup | no |

Sequencing (from the doc): P0 first → confirm the two "silently inert" P1s (6, 5) →
god-objects (2, 3) → P2 cleanup (8, 9).

## TK-AUDIT-1 (P0) — acceptance criteria
Given the runtime role `sylphie_app`, when it issues `UPDATE drive_rules`, then the DB
denies it; AND when the guardian-approved path writes a rule, then it succeeds. (CANON
Std-6: the system cannot rewrite the rules it is judged by.) Migration plan: migration.md.

## Notes
- `refine` should red-team the epic (atomicity per ticket) and confirm the migration plan.
- TK-AUDIT-6 (EWC trigger) may be a correctness gap masquerading as cleanup — flag for
  the conceptual reviewer, not just code review.

## Refine red-team (refine cog)
Atomicity check across the 9 staged tickets is NOT uniform:
- TK-AUDIT-1 (P0 drive_rules lockdown): atomic + ready — migration plan written, clear AC.
- TK-AUDIT-2/3 (god-object decompositions): NOT atomic — both explicitly need an
  `architect` seam decision before they can be sized/built. Research/design first.
- TK-AUDIT-6 (orphaned phase-transition → EWC trigger): NOT a clean ticket — it's a
  CONFIRM ("is EWC silently inert?"). Investigation, not a build.
- TK-AUDIT-8 (duplication consolidation): needs canonical-home calls from architect/forge.

Finding: this is a **mixed-readiness epic**. One ticket (the P0) is build-ready; several
need architect decisions or investigation. The pipeline currently treats one source doc
as one indivisible item, so it cannot peel the ready P0 off to `queue` while the rest goes
to design. Routing the whole item to `replan` with that recommendation.
