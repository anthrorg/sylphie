# Plan — 20260625-003 — Sylphie Interaction Directive (from Jim, 2026-06-22)

- **Type:** feature (behavioral, cross-cutting) · **Route:** ATTACH to existing **EP-20** (dedupe) · **DB:** none
- **Plan-cog run:** 2026-06-26T13:07Z · supersedes the earlier RECONCILE/parked plan.

## Classification (plan cog)
Ingest guessed `bug`. It is really a **cross-cutting behavioral directive**. Its core
design tension (proactive-initiation vs. firehose turn-taking) was previously parked to
`replan` — but per **DEC-27** (accepted, Jim-approved) that tension is **already
adjudicated in the live contract** by **EP-20 / TK-97..105 + DEC-26**. So this is NOT a
new epic and NOT a reconciliation: it is a **duplicate-of** the in-flight EP-20 work.
This re-plan's job is to (a) confirm the directive maps cleanly onto the existing tickets,
and (b) surface any directive point NOT already covered as a staged delta (DEC-27).

## Discovery (codebase-pkg unavailable this run → authoritative read via Grep/Read)
`codebase-pkg` MCP (Neo4j bolt://localhost:7692) is not connected in this environment, so
discovery fell back to the repo's authoritative read path (Grep/Read on real source).
Confirmed every file named by the EP-20 tickets exists and the tickets are real/landed:
- `apps/sylphie/src/services/communication.service.ts` — present (TK-99/100/101 boundary).
- `apps/sylphie/src/gateways/perception.gateway.ts` — present; already injects NestJS
  `ConfigService`, and carries live **TK-97** markers (per-identity VWM ids → habituator)
  and the **WS5 scene-change nudge** (`SCENE_CYCLE_COOLDOWN_MS`, lines ~322-326) — i.e. the
  exact seam TK-98 keys on. Confirms the tickets shipped against this code.
- `packages/drive-engine/src/constants/rules.ts` — present (TK-97 pressure rules).
- `packages/decision-making/src/tick-engine/decision-tick-engine.service.ts` — present
  (IDLE_PRESSURE_THRESHOLD self-tick gate, TK-97/98/103).
- `packages/decision-making/src/action-retrieval/action-retriever.service.ts` — present
  (seed-greet arbitration, TK-104).

## Directive → EP-20 mapping (verified — every point has a home)
| Directive point (source.md) | Owning EP-20 ticket(s) | Status |
|---|---|---|
| 1. Proactive, greets first on landing | **TK-100** (DELIBERATE_GREET on connect) | done |
| 2. Genuine turn-taking / yields the floor | **TK-99** (turn-floor / barge-in gate) | done |
| 3. One coherent contribution per turn | **TK-99** + **TK-104** (worth-saying/content-dedup) | done |
| 4. Engaging beyond Q&A, paced not firehose | **TK-104** (+TK-99 pacing) | done |
| 5. Theater enforced **AND learned** (neg. reinforcement) | **TK-101** (block + ConfidenceUpdater drop, CANON-gated) | **todo** |
| 6. Coherent decision-to-speak loop ("is it my turn?"/"worth saying?") | **TK-103** (intent seam) + **TK-99** + **TK-104** | done |
| Refinement: vision silent on STATIC, reacts once to NEW | **TK-98** + **TK-97** (habituation defines new-vs-static); **TK-103** SALIENT_OBSERVATION | done |
| Symptom: perception overlay slows after ~30s | **TK-105** (frontend overlay buffer) + **TK-102** (app-side retained-tracker) | TK-105 in_progress / TK-102 done |
| Dormancy remark ("left me dormant so long") | **superseded by EP-20** (hopper: confabulation from the loop; fixed by TK-98/99 + TK-101 per epic intent) | covered |

Conclusion: directive points 1–6, the vision-novelty refinement, and the overlay slowdown
are **fully covered** by TK-97..105. No duplicate epic/tickets are created (DEC-27).

## Gap found — one uncovered directive point (staged delta, per DEC-27)
Source.md, "Additional symptoms": **"Product option: may need a switch to disable visual
perception for online demos."** This is **explicitly a NON-GOAL of both TK-102 and TK-105**
("building a demo kill-switch") and is owned by no EP-20 ticket. Per DEC-27: "If re-plan
surfaces a directive point NOT already covered by TK-97..105, that delta becomes a new
ticket under EP-20 at the normal staged-write gate." Discovery found no existing
perception-disable flag; the gateway already injects `ConfigService`, so the simplest
correct shape is a runtime-readable config/env flag gating frame ingestion + the
scene-change nudge.

## Staged ticket (contract_write=staged → NOT written to contract.yaml; staged here for the approval gate)
```yaml
- id: TK-106            # provisional (next free id; confirm at write time)
  kind: ticket
  parent: EP-20
  status: todo
  priority: P2          # product convenience for demos; not a bleed-stop
  estimate: S
  engineering_level: production
  title: "Demo kill-switch — runtime flag to disable visual perception for online demos"
  intent: "Jim's directive product option: 'may need a switch to disable visual perception
    for online demos.' Distinct from the loop fixes (TK-97/98/102) and the overlay buffer
    (TK-105) — those bound/quiet perception; this CUTS it for a public demo. perception.gateway.ts
    already injects NestJS ConfigService; add a runtime-readable flag (env/config, e.g.
    PERCEPTION_ENABLED, default ON) that, when OFF, stops ingesting/processing frames AND
    suppresses the WS5 scene-change cognitive-cycle nudge, so perception contributes zero
    pressure and zero cycles while the rest of the system (text chat, greet, turn-taking)
    runs normally. forge work-trio (forge -> ashby -> code-reviewer); coordinate with marr
    on the perception-service boundary."
  complexity_budget: "One config/env flag + guard at frame ingestion and the scene-change
    nudge site in perception.gateway.ts. No new UI required (env toggle is sufficient);
    no CV-model or IPC-contract changes; reuse the existing ConfigService."
  acceptance_criteria:
  - given: the perception-disable flag is set OFF (e.g. PERCEPTION_ENABLED=false) and the app is running with text chat live
    when: perception frames arrive at the gateway over a >60s window
    then: zero frames are processed, zero scene-change cognitive-cycle nudges are enqueued, and the perception contribution to drive pressure is zero (provable from logs/telemetry) — while a user text message still receives exactly one coherent reply
  - given: the flag is ON (default)
    when: perception frames arrive
    then: perception processes and nudges normally (TK-97/98 behavior unchanged) — the switch is opt-in and does not alter default behavior
  - given: the flag is set OFF at process start, then the process is restarted with the flag ON (deterministic startup-read)
    when: each configuration is brought up
    then: perception is fully suppressed in the OFF run and fully normal in the ON run, and the active flag value is logged once at startup — a binary, restart-scoped check (runtime hot-toggle without restart is explicitly out of scope; see non_goals)
  files_in_scope:
  - apps/sylphie/src/gateways/perception.gateway.ts
  - apps/sylphie (config/env wiring for the flag; reuse @nestjs/config ConfigService)
  non_goals:
  - Any frontend overlay/UI toggle (that is TK-105's surface; an env/config flag is enough here)
  - Bounding/evicting retained perception state (that is TK-102) or CV-model changes
  - Disabling text chat, greet, or turn-taking — only the visual-perception path
  - Runtime hot-toggle of the flag WITHOUT a restart (deferred follow-up slice, story-splitter Data/Rules split at refine 2026-06-26T1708Z; the demo use-case is met by setting the flag before the demo and reading it at process start — hot-reload is a distinct, larger capability and is not required for an online-demo kill-switch)
  depends_on: []
```

## Contract-write boundary (staged)
Per `config.json: contract_write=staged`, this plan does **not** mutate
`planning/contract.yaml`. The attach (linking 20260625-003 → EP-20 / TK-97..105) is already
reflected in `item.json:contract_nodes`. The proposed **TK-106** above is staged here only;
its id and the write into the contract happen at the explicit approval gate, not
autonomously. TK-106 is intentionally NOT added to `contract_nodes` yet (the node does not
exist in the contract).

## DB
`dbcheck` → no DB surface. The staged TK-106 is a config-flag gate (no schema, no
migration). No `migration.md` required; sentinel review not triggered.

## Route decision (plan cog)
Testable acceptance criteria exist (all mapped tickets carry runnable ACs; the staged
TK-106 has ≥1 Given/When/Then). The design tension that previously parked this item is
resolved (DEC-27). → **moved to `refine`** with node note `EP-20; TK-97..105 (attach); +TK-106 staged`.

---

## Refine cog — 2026-06-26T1708Z (atomicity + red-team + DB gate)

**Scope reviewed:** the only NEW buildable work this item introduces is the staged
**TK-106** (demo perception kill-switch). TK-97..105 are already in the live contract and
were red-teamed at v1.9/2.0/2.1 (plan-reviewer); the attach to them is dedupe bookkeeping
(DEC-27), not new tickets, so the readiness gate is applied to TK-106.

### 1. Atomicity-gate (fixpoint, 3 passes)
TK-106 passed criteria 1,3,4(core),5,6,7 on pass 1. **One defect:** criterion 2
(testable/binary) + criterion 4 (single responsibility) — the original **AC3** demanded a
*runtime hot-toggle without restart* and hedged it with **"if the config surface supports
it"**, which is non-binary (not a runnable check) and bundles a second, larger capability
(config hot-reload) onto a startup-read flag.
**Split applied (story-splitter, Data/Rules meta-pattern — reduce variations to one):**
delivered the single complete slice = a **deterministic startup-read flag** (fully meets the
online-demo use-case: operator sets `PERCEPTION_ENABLED=false` before the demo); the
runtime-hot-toggle variation is **deferred** (now a `non_goal`, captured as a follow-up
slice). AC3 rewritten as a binary, restart-scoped check.
Pass 2 and pass 3 after the split: **no new splits** → fixpoint reached. TK-106 is **atomic**.

### 2. Red-team (plan-reviewer rubric)
No CRITICAL, no HIGH. Findings:
- **[MEDIUM] TK-106/AC3** — non-binary "if the config surface supports it" + hot-toggle scope
  creep. *Why it matters:* un-runnable AC + a second capability inflate a one-pass ticket.
  **Resolved in-place** by the atomicity split above (startup-read slice; hot-toggle deferred).
- **[LOW] TK-106 ↔ TK-98 nudge overlap** — both touch the WS5 scene-change nudge. *Not a
  double-fix:* TK-98 classifies/suppresses emission *intent* on a live perception path; TK-106
  cuts frame ingestion *upstream* so zero cycles occur. They compose. Noted, not blocking.
- **[LOW] TK-106/AC1 telemetry dependency** — "perception contribution to drive pressure is
  zero (provable from logs/telemetry)" leans on EP-19 telemetry, which RISK-2 flags as possibly
  not-app-side. *Mitigated:* AC reads "logs/telemetry" — process logs suffice independent of the
  Timescale path. Not blocking.
- **Coverage / CANON:** directive points fully mapped (table above); a demo kill-switch raises no
  CANON tension (consistent with Theater Prohibition — with perception OFF she must not narrate
  perception, which TK-101 already enforces). No contradiction, no orphan scope.

No CRITICAL/HIGH → nothing to record as a governance `open_question`/`risk` (and
`contract_write=staged` forbids a contract write regardless). The single MEDIUM is resolved
in the staged ticket, not deferred.

### 3. DB gate
`python pipeline/pipeline.py dbcheck 20260625-003` → `touches_db=true`, **`surface_files: []`**,
`keyword_hits: [migration, neo4j, timescale]`, `has_migration_plan=true`, `ok=true`. The hits
are **lexical, from directive prose** (owner-list + discovery notes), not a DB surface this item
changes. `migration.md` is present and **sound, not weak**: it carries a backfill assessment
(§3, additive/no-write), a REVERSE (§4, revert the app-code commit), and confirms **no
init-script delivery** (§2). None of the three RUNBOOK weakness triggers fire → **no replan on
DB grounds**. Residual: `migration.md §6` asks **sentinel** to confirm the no-op — that is a
review-cog sign-off, not a refine blocker; carried forward on the item, not gating queue.

### Verdict
TK-106 atomic (fixpoint), red-teamed clean (no CRITICAL/HIGH), DB gate satisfied. → **move
`refine → queue`**, note `atomic, red-teamed clean`.
