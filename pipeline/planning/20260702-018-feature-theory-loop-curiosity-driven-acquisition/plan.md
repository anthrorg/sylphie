# Plan — 20260702-018 Feature: Theory loop — curiosity-driven acquisition + Tess confirmation

## 0. Verdict up front

This item bundles a **buildable acquisition slice** (extend an existing, partially-built
autonomous-research mechanism to write quarantined "theory" objects instead of direct
facts) with a **genuinely unresolved confirmation slice** (a Tess CLI integration that
does not exist anywhere in the codebase, with an open request/verdict contract, and a
real conflict against the CANON confidence-ceiling standard). Route: **replan** for the
item as a whole. The acquisition slice's tickets are fully specified below so refine can
pick them up the moment the design fork is ruled on (or if Jim/architect chooses to split
the item — see §6).

## 1. Source claims verified against the actual codebase

| # | Source claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "the executor selects a `research` action" when Curiosity/no-interaction | **Already built**, not net-new | `packages/decision-making/src/tick-engine/decision-tick-engine.service.ts:312-336` — self-initiated tick already checks `boredom > 0.6 \|\| curiosity > 0.7` and injects a synthetic `RESEARCH_ENTITY` request via `pickResearchTarget()` (lines 411-436). |
| 2 | Target selection: "low-confidence or stale under ACT-R decay" | **Half true** | `pickResearchTarget()` filters `confidence < 0.60` and sorts ascending — low-confidence, yes. It does **not** use staleness/ACT-R decay (`last_retrieval_at`/`updated_at` age) at all — only raw confidence. |
| 3 | "Reading produces a theory object... provenance `LLM_GENERATED`" | **False as built** | `action-handler-registry.service.ts:504-538` (`RESEARCH_ENTITY` handler) writes web-research nodes/edges directly via `wkgContext.writeEntity`/`writeRelationship` with `provenance: 'INFERENCE'` at `confidence: 0.30` — not `LLM_GENERATED`, and not as a distinct "theory" shape. There is **no theory node type, no status field (open/confirmed/refuted), no verdict ref, no spawned-from link** anywhere in the codebase. Writes land as ordinary `:Entity`/`:Concept` nodes indistinguishable from any other inferred fact — this is exactly the "naive hoarding" failure mode the source's own "Why" section warns against. |
| 4 | Tess CLI integration point | **Confirmed absent** | Zero references to "Tess" anywhere under `packages/` or `docs/` outside the research note itself. Source's own scope hint ("architect to place it") is accurate — this is new. |
| 5 | New provenance tier `Tess_Confirmed`, "promoted; decays slowly" | **Not built; and conflicts with CANON if built as described** | See §2 below — real design fork, not just missing plumbing. |
| 6 | "Curiosity is NOT fully relieved by proposal alone" | **Currently true by omission, untested** | No drive-relief entry exists for `RESEARCH_ENTITY`/`research` action type anywhere in `packages/drive-engine` (grepped, zero hits). So today nothing explicitly relieves Curiosity on a research write — but this is an absence, not an enforced invariant, and there is no theory `status` field to make "relief only at resolution" operant in the first place. `constitution.CON-2` in `planning/contract.yaml` ("Pay curiosity/social relief for anything but durable knowledge/identity change") already states this exact principle at the project level — this feature's AC #3 is re-deriving an existing rule, not inventing one. |
| 7 | Hallucinated-Knowledge detector "gets precise" on never-Tess-verdicted ratio | **Detector exists, measures something coarser** | `attractor-monitor.service.ts:328-427` (`detectHallucinatedKnowledge`) already fires at >20% of WKG entities lacking trusted (`SENSOR`/`GUARDIAN`-family) provenance — a static provenance-class ratio, not a "never received a verdict" ratio. Sharpening it requires a verdict-tracking field that doesn't exist yet (blocked on §2). |
| 8 | Decay rates: `LLM_GENERATED` 0.08/hr fast decay | **Confirmed accurate** | `packages/learning/src/pipeline/confidence-decay.service.ts:120-146` (and the mirrored edge-decay block ~200, and the OTHER-instance block ~296) — `CASE n.provenance_type ... WHEN 'LLM_GENERATED' THEN 0.08`. Three call sites, all currently missing a `Tess_Confirmed` case — an unhandled provenance value there falls to `ELSE 0.05`, i.e. it would NOT decay slowly as the source requires unless explicitly added. |
| 9 | "Curiosity contingency updates via the guardian-approved path only" | **Now true** | TK-154/TK-155 (drive_rules RLS lockdown + guardian privileged pool) merged via PR #86 (commit 847e367) — `sylphie_app` can no longer write `drive_rules` directly; only the guardian path can. This dependency is resolved, not a blocker. |
| 10 | Source's citation "§5 (theory schema)" in `docs/future/sylphie-autonomous-cognition-research.md` | **Citation is wrong** | Doc §5 is "The Guilt Drive," unrelated to theory schema. The actual field list ("id, claim, source nodes, provenance, confidence, status, verdict ref, spawned-from") lives in **§7 open question #2**, which the source.md itself already restates correctly in its own "What it should do" section — so this is a doc cross-reference bug, not a planning blocker. Flagging for hygiene only. |

## 2. The real design fork (why this routes to replan)

**CANON confidence-ceiling conflict.** The system's confidence ceiling is 0.60 until
**guardian**-confirmed (Six Immutable Standards; `provenance.types.ts` codifies this —
the *only* documented way past 0.60 is `GUARDIAN`/`GUARDIAN_APPROVED_INFERENCE` at 0.90,
explicitly gated to "ONLY a verified guardian may trigger the promotion" per CANON Std-5
guardian asymmetry). The source's confirmation loop proposes `Tess_Confirmed` as "the
only path to **high** confidence for non-experiential knowledge... promoted." Tess is an
automated 10-stage statistical pipeline, not the guardian. Two readings are both
plausible and neither is stated in the source:

- (a) `Tess_Confirmed` promotes **within** the ≤0.60 ceiling (e.g. INFERENCE-floor 0.30 →
  something meaningfully higher but still ≤0.60, decaying slowly) — CANON-compliant, no
  new exception needed.
- (b) `Tess_Confirmed` is meant to exceed 0.60 the way guardian-confirmation does — this
  would require a **new, explicit CANON exception** (a change to the Six Immutable
  Standards, or a documented sub-clause of Std-5) authorizing a second, non-guardian path
  above the ceiling. That is exactly the kind of change `update-canon` exists to gate,
  and exactly the kind of call this repo's rules say is not the planning agent's or the
  coordinator's to make.

Guessing between (a) and (b) would be coding around a CANON conflict rather than
surfacing it. This is the architect-ruling open question that blocks Epic B.

**Tess invocation/transport contract is undefined.** No CLI, no message queue, no
file-drop convention, no request schema, no verdict schema exists anywhere in the repo.
The source explicitly calls this "open question #3 — resolve in planning" but a planning
pass cannot invent an external system's integration contract from nothing; this needs an
architect decision on the mechanism (sync subprocess call? async file-drop analogous to
this very pipeline's own cog pattern? a queue?) before any Epic-B ticket can have a real
runnable-check acceptance criterion.

## 3. Existing contract overlap

- `planning/contract.yaml` `constitution.CON-2` ("Pay curiosity/social relief for
  anything but durable knowledge/identity change (Invariant 1 / CANON Std 6)") is a
  direct, pre-existing governing constraint for this feature's AC #3 — cite it, don't
  reinvent it.
- No existing epic/ticket in `contract.yaml` covers theory objects, Tess, or
  curiosity-driven acquisition (searched for `Tess`, `theory`, `curiosity`,
  `LLM_GENERATED`, `Hallucinated`, `research action` — only tangential provenance/decay
  work under WS4/WS5/legacy-migration tickets, none of which touch this surface).
- Sibling pipeline items this feature explicitly depends on/sequences after are **all
  still sitting in `planning/`, unticketed**, as of this pass:
  - `20260702-016` — feature-snapshot-restore (dependency)
  - `20260702-015` — feature-schema-versioning-migration-framework (dependency)
  - `20260702-008` — bug-audit-wkg-knowledge-graph (sequence-after: writeEntity phantom
    node_ids / confidence-ceiling escape / no-op-write logging bugs)
  - `20260702-006` — bug-audit-learning-planning-supervisor (sequence-after: provenance
    falsification fix)
  - `20260702-011` — feature-consolidation-loop (this item **blocks** that one; also
    unticketed)

  None of these have contract ticket IDs yet, so this item's `depends_on` below reference
  pipeline item IDs, not `TK-*` IDs — they'll need to resolve once those items are
  planned. This item is premature to build even for its buildable half until at least
  `20260702-008` (the WKG write-path bugs the theory writes would ride) is ticketed.

## 4. Proposed epic

**EP-018 — Theory loop: curiosity-driven acquisition + Tess confirmation**
(working id `20260702-018`; split into two sub-tracks per §2)

### Epic A — Acquisition hardening (buildable now, once sequencing clears)

#### Ticket 20260702-018-a — WKG `:Theory` node shape (additive schema + writer)

- **Title:** Define and write a quarantined `:Theory` node shape in the WORLD Neo4j graph
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** `20260702-008` (bug-audit-wkg-knowledge-graph — theory writes ride the
  same `writeEntity` plumbing that item fixes)
- **non_goals:** No Tess wiring; no promotion/demotion logic; no consolidation reads of
  theory nodes.
- **Acceptance criteria:**
  1. Given a call to a new `wkgContext.writeTheory({ claim, sourceNodeIds, spawnedFrom? })`
     helper, when it runs against a live Neo4j WORLD session, then a `:Theory` node is
     created with properties `{ claim, provenance: 'LLM_GENERATED', confidence: 0.35,
     status: 'open', verdict_ref: null, spawned_from: <id-or-null>, created_at }` and is
     linked `(:Theory)-[:ABOUT]->(:Entity)` to each source node —
     **runnable check:** a Jest integration spec (`yarn workspace @sylphie/decision-making
     test --testPathPattern=wkg-theory`) that calls `writeTheory`, then queries
     `MATCH (t:Theory {claim: $claim}) RETURN t.provenance, t.confidence, t.status` and
     asserts the three literal values above.
  2. Given every existing grounding read-path (`matchEntities`/`getSubgraph`/
     `getEntityFacts`/`getRelationships`), when a `:Theory` node exists in the graph,
     then none of those paths return it as a groundable fact (mirrors the existing
     `:Candidate` exclusion pattern in `provenance.types.ts`) —
     **runnable check:** extend the existing grounding-exclusion spec suite (same file
     that tests the `:Candidate` `NOT <var>:Candidate` clauses) with a `:Theory` fixture
     and assert it is excluded from all four read paths' results.
- **DB surface:** yes — additive-only (new label + properties, no existing schema
  touched). See `migration.md`.

#### Ticket 20260702-018-b — Rewire autonomous research write path onto `:Theory`

- **Title:** Fix `RESEARCH_ENTITY` autonomous path: correct provenance, quarantine as
  theory, add staleness to target selection
- **engineering_level:** prototype
- **priority:** P1 (corrects a live provenance mislabeling against CANON
  provenance-required, not just new scope)
- **depends_on:** `20260702-018-a`
- **non_goals:** No change to the LLM-tool-callable `research_entity` conversational path
  semantics beyond the provenance/shape fix; no unbounded crawling (keep the existing
  3-query SearXNG fan-out and per-tick cooldown as the rate limit).
- **Acceptance criteria:**
  1. Given idle state with `curiosity > 0.7` (or `boredom > 0.6`) and no active
     interaction, when `decision-tick-engine.service.ts`'s self-initiated tick fires,
     then `pickResearchTarget()` selects among WKG entities filtered by
     `confidence < 0.60 OR staleness (hoursSinceLastActivity) > <threshold>` (currently
     only the confidence half exists) —
     **runnable check:** unit test on `pickResearchTarget` with a fixture set including a
     high-confidence-but-stale entity; assert it is eligible for selection (currently it
     is not — this is the regression-fixing assertion).
  2. Given the `RESEARCH_ENTITY` handler extracts nodes/edges from web research, when it
     writes to the WKG, then it calls `writeTheory` (from 018-a) instead of
     `writeEntity`/`writeRelationship` directly, with `provenance: 'LLM_GENERATED'` (not
     `'INFERENCE'`) —
     **runnable check:** `yarn workspace @sylphie/decision-making test
     --testPathPattern=action-handler-registry` asserting the handler's Neo4j write call
     args carry `provenance: 'LLM_GENERATED'` and land as `:Theory`, not `:Entity`.
  3. Given a single curiosity-discharge cycle, when the tick engine's cooldown
     (`SELF_INITIATE_COOLDOWN_MS`) is active, then no second `RESEARCH_ENTITY` request is
     injected until it elapses — **runnable check:** existing tick-engine cooldown spec,
     extended to assert exactly one synthetic-text injection per cooldown window (locks
     in the source's "one targeted read per curiosity discharge, rate-limited" non-goal).
- **DB surface:** no new surface beyond 018-a (uses its writer).

#### Ticket 20260702-018-c — Curiosity/Boredom non-relief-on-proposal (CON-2 guard)

- **Title:** Characterize and enforce: forming a theory does not relieve Curiosity/Boredom
- **engineering_level:** prototype
- **priority:** P1 (protects an existing CANON/constitution invariant, CON-2, from a
  silent future regression)
- **depends_on:** `20260702-018-a`, `20260702-018-b`
- **non_goals:** No relief-on-resolution logic yet (that needs Tess verdicts — Epic B).
  This ticket only locks in the negative case.
- **Acceptance criteria:**
  1. Given a completed `RESEARCH_ENTITY` cycle that writes a new `:Theory` node (status
     `open`), when the drive-outcome reporting for that cycle runs, then Curiosity and
     Boredom pressure vectors show **no negative (relief) delta** attributable to the
     research action — **runnable check:** a `packages/drive-engine` spec
     (`action-outcome-reporter.service.spec.ts` extension) that drives a
     `RESEARCH_ENTITY`-tagged outcome through the reporter and asserts
     `computedEffects.curiosity >= 0 && computedEffects.boredom >= 0` for that action
     type (mirrors the existing `no-theater.spec.ts` pattern used for `ScenePrediction`
     PRESSURE-only assertions).
  2. Given the property-based `no-theater.spec.ts` suite, when a `RESEARCH_ENTITY`
     action fixture is added to it, then it passes alongside the existing ScenePrediction
     assertions with no relief on any axis — **runnable check:**
     `yarn workspace @sylphie/decision-making test --testPathPattern=no-theater`.

### Epic B — Confirmation loop (NOT ticketed — outline only, blocked on §2 ruling)

These are **not** atomic tickets yet — they're recorded so refine/build can pick them up
the moment the architect rules on the two open questions in §2. Writing runnable-check
ACs for them now would mean inventing a payload/transport contract that doesn't exist,
which is exactly the guessing the pipeline rules forbid.

- **B1 — Tess request/verdict transport + payload contract.** Blocked on architect
  placement decision (mechanism: sync CLI subprocess vs async file-drop vs queue) per
  source's own scope hint ("Tess CLI integration point — new — architect to place it").
- **B2 — `Tess_Confirmed` provenance tier: promotion function + decay-rate wiring.**
  Blocked on B1 AND on the CANON confidence-ceiling ruling in §2 (does `Tess_Confirmed`
  stay ≤0.60 or does it need a new CANON exception). Concretely touches three call sites
  in `confidence-decay.service.ts` (node-decay, edge-decay, OTHER-instance mirror) which
  currently default any unhandled provenance to 0.05/hr — silently wrong for "decays
  slowly" until this lands.
- **B3 — Refutation loop: discharge Curiosity, demote node, spawn "why was I wrong"
  theory.** Blocked on B1/B2 (needs a real verdict to react to).
- **B4 — Hallucinated-Knowledge detector precision (never-Tess-verdicted ratio).**
  Blocked on B2 (needs the verdict-tracking field to exist before a ratio over it means
  anything). Must be additive to `attractor-monitor.service.ts`'s existing 20%
  provenance-class detector, not a replacement — the existing detector and its threshold
  are presumably covered by existing tests and must not regress.

## 5. Non-goals (carried from source, still binding)

- No consolidation/insight synthesis (separate feature, `20260702-011`).
- No executor-tensor involvement.
- No unbounded web crawling — one targeted read per curiosity discharge, rate-limited
  (already structurally true via the tick-engine cooldown; 018-b's AC #3 locks it in).
- Tess itself is external; this feature builds the contract and the Sylphie side only —
  never an implementation of Tess.

## 6. Split recommendation

Recommend the coordinator treat this as two lineages going forward rather than one:

1. **Acquisition hardening** (018-a/b/c above) — small, atomic, buildable once its
   sequencing dependency (`20260702-008`) is itself ticketed. Could proceed to refine
   largely independently of the Tess question.
2. **Tess confirmation loop** (B1-B4) — cannot be ticketed atomically until the architect
   rules on (a) the CANON confidence-ceiling question and (b) the Tess transport
   mechanism. Recommend this stays parked as an `open_question` in governance until that
   ruling lands, rather than re-entering `planning` on a timer with no new information.

Do not create new pipeline item folders for this split — this is a recommendation for
how the *existing* item's tickets should be staged/sequenced once it leaves replan, not
an instruction to fork the source item.

## 7. Open questions (route: replan)

1. **CANON confidence-ceiling conflict:** Does `Tess_Confirmed` provenance stay within
   the existing ≤0.60 non-guardian ceiling (promoted-but-bounded), or does it need a new,
   explicit CANON exception (Std-5-style) to exceed it the way only guardian-confirmation
   currently can? This cannot be guessed — needs an architect ruling, and if the answer is
   "yes, new exception," it needs to go through `update-canon` with Jim's explicit
   approval before any Epic-B ticket writes code.
2. **Tess invocation/transport contract:** How does Sylphie send a theory to Tess and
   receive a verdict — synchronous CLI subprocess call, an async file-drop convention
   (this pipeline's own inbox/outbox pattern is a plausible precedent), or a queue? What
   are the literal request and verdict payload shapes? Source flags this as its own open
   question #3; architect placement is required per the source's scope hint.
3. **Staleness threshold for target selection (018-b AC #1):** what ACT-R
   staleness-vs-confidence threshold decides "stale enough to research" — a concrete
   number needs picking during ticket build (briefing-builder can default it and flag it
   as an assumption logged in governance; not architect-level, just needs an owner).
