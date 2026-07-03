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

---

## Refine red-team #2 (pipeline-refine, 2026-07-03) — TK-153 → REPLAN

Scope: only **TK-153** (P0 drive_rules lockdown, now a real contract node under EP-27).
The design-needing findings from the original audit are already filed as Q-25..Q-29.

`plan-reviewer` red-team + **independent source re-verification** (grep confirmed all three):
1. `guardian-rules.service.ts:44` injects `POSTGRES_RUNTIME_POOL` (sylphie_app) and `INSERT INTO drive_rules` at :133 → a plain REVOKE kills the guardian approval path (AC2).
2. `POSTGRES_ADMIN_POOL` is a defined Symbol (`packages/shared/src/storage/database.tokens.ts:14`) that is **never `provide:`d** anywhere; `POSTGRES_GUARDIAN_POOL` does not exist → the "separate privileged role/connection" the ticket assumes **must be built from scratch** (role + secret + pool token + provider + service rewire), spanning **sentinel + forge**, not the single ~≤250 LOC sentinel migration the complexity_budget claims.
3. **No `CREATE TABLE drive_rules`** exists in executable code → table ownership is undefined; if `sylphie_app` owns the table, REVOKE is a no-op and RLS is bypassed (owner implicit privileges + RLS bypass without `FORCE`).

Recorded as governance open_questions **Q-34 (privileged-role seam / CANON in-process-vs-isolated), Q-35 (table ownership/creation path), Q-36 (grant matrix + RLS SELECT-policy footgun + missing AC2/3/4 harness)** — all `owner: architect`, `scope: TK-153`. Changelog v2.11.

**Route: REPLAN.** TK-153 + EP-27 nodes left intact (accepted, append-only). The core blocker is an **unmade architect seam decision** (does the guardian privileged write-pool live in-process in `apps/sylphie` or in an isolated guardian-approval process, mirroring drive isolation?). Replan action: get the architect ruling on Q-34 (+ Q-35 ownership fact, Q-36 grant/RLS design), then TK-153 likely **splits** into (a) a sentinel migration (REVOKE/RLS/CREATE ROLE/GRANT/ownership) and (b) a forge pool-provider + guardian-service-rewire ticket, before re-entering the queue.

---

## Replan resolution (pipeline-replan, 2026-07-03) — DEC-34 / architect AD-0051 + AD-0052

Architect ruled the TK-153 seam against the **live** sylphie-postgres DB. Q-34/Q-35/Q-36 → **resolved** (DEC-34). Key live facts: `drive_rules` + `proposed_drive_rules` exist, owner=**sylphie_admin** (REVOKE bites, RLS not owner-bypassed), role **guardian_admin already exists**; and the guardian approve/reject path is **already broken** today (approveRule RLS-violates, rejectRule silently updates 0 rows) — TK-153 *fixes a live break*.

**TK-153 SPLITS (staged — awaits Jim's contract-write approval gate; contract_write=staged):**

### TK-153a — sentinel / ashby / code-reviewer  (proves AC1, AC3, AC4)
Convergent migration `infra/migrations/NNN-drive-rules-lockdown.ts` (dry-run default, --confirm to apply). Idempotent from any starting state:
- `CREATE TABLE IF NOT EXISTS drive_rules, proposed_drive_rules` matching the **live schema exactly** (first in-repo codification).
- `ALTER TABLE ... OWNER TO sylphie_admin` (idempotent); `CREATE ROLE IF NOT EXISTS guardian_admin` (+ drive_engine) LOGIN, env passwords.
- Per-table `REVOKE ALL` then grant the matrix below; does **NOT** touch 001 global default privileges, **NOT** an edit to 001.
- `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies `TO role FOR SELECT USING(true)`; guardian `FOR ALL USING/WITH CHECK(true)`; proposer INSERT `WITH CHECK (status='pending')`.
- **REVOKE is the PRIMARY write-denial** (raises 'permission denied' for verify-rls.ts:130); RLS is defense-in-depth.
- NEW continuity/reverse smoke: seed → prove sylphie_app denied loudly → prove guardian_admin write succeeds → data unchanged → REVERSE restores grants.

Grant matrix (end-state):
| | sylphie_app | drive_engine | guardian_admin |
|---|---|---|---|
| drive_rules | SELECT | SELECT | SELECT/INSERT/UPDATE/DELETE |
| proposed_drive_rules | SELECT, INSERT | SELECT | SELECT/INSERT/UPDATE/DELETE |

### TK-153b — forge / ashby / code-reviewer  (depends_on TK-153a; proves AC2)
- `POSTGRES_GUARDIAN_POOL` token in `@sylphie/shared` (NOT POSTGRES_ADMIN_POOL); provider in `apps/sylphie/src/app.module.ts`.
- Rewire `GuardianRulesService.approveRule/rejectRule` to use the guardian pool; **reads stay on POSTGRES_RUNTIME_POOL**.
- Creds env-only (`POSTGRES_GUARDIAN_USER/PASSWORD`), **no hardcoded default**, **fail-closed** with a clear "guardian credentials not configured" error while reads keep working. `.env.example` plumbing.
- Ship in the **same release window** as TK-153a.

**Not in scope:** wiring the dormant `RlsVerificationService` (that is TK-129 / DEP-3). Pointing drive-server at the `drive_engine` role is a separate follow-up candidate.

**Jim ops (provisioning, not a decision):** set `guardian_admin` (+ eventually `drive_engine`) passwords as Railway/env secrets before prod `--confirm`. Railway prod postgres state unobserved → migration **dry-run against prod before --confirm**.

**Plan-cog next action:** stage TK-153a/TK-153b as the split of TK-153 in this plan.md (done above), present for Jim's approval-gate contract write, then → refine.
