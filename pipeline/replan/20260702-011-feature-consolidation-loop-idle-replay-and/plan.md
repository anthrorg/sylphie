# Plan — 20260702-011: Consolidation loop (idle replay + insight synthesis)

## 1. Source verification against the actual codebase

Confirmed true:
- Episodic ring buffer capacity is **50** slots, exactly as claimed
  (`packages/decision-making/src/episodic-memory/episodic-memory.service.ts:52`
  `RING_BUFFER_CAPACITY = 50`).
- `CognitiveAwareness` drive exists (`packages/drive-engine/src/constants/drives.ts`),
  is action-driven only, and is already used as a pressure-trigger elsewhere in the
  codebase via a **push** subscription to `driveState$` (see finding below) — consistent
  with CANON drive isolation (no pull/RPC path into the drive).
- A Type-2 deliberation path exists in `packages/decision-making/src/deliberation/` and
  is referenced across arbitration/action-handler code — the source's "Type-2
  deliberation path" hook point is real.
- Real Online EWC with Fisher computation lives in `packages/cognition-service/main.py`
  (`fisher_computed`, phase-transition endpoint) — confirmed live via prior verification
  in contract.yaml (EP8-POC, resolved: empirical Fisher is the active path, not the
  uniform fallback). The source's "EWC (real Online EWC, λ-ramped) anchors prior
  competence" claim has real substrate to hang off.
- `feature-theory-loop` (sibling item **20260702-018**) and
  `feature-schema-versioning` (sibling item **20260702-015**) and
  `bug-audit-wkg-knowledge-graph` (sibling item **20260702-008**, confirmed to be the
  bug report whose fix this item's acceptance criterion #2 depends on — its "no-op
  contradiction gate" finding is literally the blocker the source names) are all real,
  currently-unbuilt sibling pipeline items, still sitting in `pipeline/planning/`. None
  of the three have contract tickets yet. **This item is the 4th link in an entirely
  unbuilt dependency chain** (008 → 015 → 018 → 011).

**Overstated / needs correction** — the source's "Why" claims nothing currently turns
verified atoms into connected understanding. **That is not accurate.** A CognitiveAwareness-
pressure-triggered synthesis pipeline already exists and is DONE in `packages/learning`:
- `packages/learning/src/learning.service.ts` subscribes to `driveState$` (push, not
  pull — CANON-clean) and calls `forceCycle()` when `CognitiveAwareness` pressure exceeds
  `COGNITIVE_AWARENESS_PRESSURE_THRESHOLD` (contract **TK-55**, "Learning cycle pressure
  trigger (Cognitive Awareness drive)", done).
- `packages/learning/src/pipeline/cross-session-synthesis.service.ts` already finds pairs
  of `:Insight` WKG nodes sharing entity references (`REVEALS` edges), asks an LLM to
  detect a meta-pattern, and persists a new `:Insight` node with `SYNTHESIZES` edges back
  to its sources — citation-verified, confidence-capped
  (`MAX_SYNTHESIS_CONFIDENCE_PRE_GUARDIAN`) pre-guardian. `InsightType` enum already
  exists (`DELAYED_REALIZATION | MISSED_CONNECTION | IMPLICIT_INSTRUCTION | CONTRADICTION
  | THEMATIC_THREAD`) in `packages/learning/src/interfaces/learning.interfaces.ts:419-424`.
- Contract **EP-12** ("Tier 5 — Learning / consolidation depth residuals", **done**) with
  children **TK-52** (reflection windowed sampling), **TK-53** (ungrounded-insight
  re-grounding sweep), **TK-54** (dead-letter tracking), **TK-55** (the pressure trigger
  above), **TK-87/TK-88** (LLM-assisted extraction) already built exactly the "she wakes
  up smarter because she connected what she already had" loop — just over
  **conversation-reflection-derived per-session Insight nodes**, not over the
  **decision-cycle episodic ring buffer + Type-2 deliberation + theory verdicts**
  substrate this item asks for.

This is a genuine design fork, not a nitpick: both systems (a) fire off the same
`CognitiveAwareness` drive signal, and (b) would write to the **same WKG node label**
(`:Insight`) with **different property shapes and provenance rules**. Left unresolved,
building this item as scoped risks: two independent consolidation cycles racing on the
same drive pressure (one could discharge pressure the other was about to act on), and a
`:Insight` label used with two incompatible shapes (schema incoherence — exactly the kind
of drift `feature-schema-versioning`, item 015, exists to prevent). See open questions.

## 2. Existing contract overlap

- `EP-12` (done) + children `TK-52`, `TK-53`, `TK-54`, `TK-55`, `TK-87`, `TK-88` —
  the existing CognitiveAwareness-triggered Insight-synthesis pipeline in
  `packages/learning`. **Attach to / coordinate with this, do not clone it.**
- No existing epic/ticket covers episodic-ring-buffer or Type-2-deliberation-driven
  consolidation, theory-verdict pruning, or EWC-anchored re-weighting on consolidation —
  that part is genuinely new and not yet planned anywhere in `contract.yaml`.
- Sibling pipeline items (not yet contract tickets, all still in `pipeline/planning/`):
  `20260702-008` (bug-audit-wkg — fixes the contradiction-scanner no-op this item's AC#2
  needs), `20260702-015` (schema-versioning — owns the migration framework this item's DB
  impact should ride), `20260702-018` (theory-loop — produces the confirmed/refuted
  theory verdicts this item consumes).

## 3. Design fork — open question (routes this item to replan)

**Q1 (for `architect`):** Should decision-making's new episodic/theory consolidation loop
(a) feed its candidates into the **existing** `packages/learning` CognitiveAwareness
pipeline (extend `cross-session-synthesis`'s candidate sources to include episodic/theory
pairs, reuse the existing `:Insight` shape + `InsightType` enum + guardian-confirmation
ceiling), or (b) use a **distinct WKG node label** (e.g. `:EpisodicInsight` or
`:ConsolidationInsight`) with its own trigger, coordinated with (not duplicating) the
existing `driveState$` subscriber so the two don't race on the same `CognitiveAwareness`
pressure? The answer changes which package owns the write path, whether `atlas` extends
an existing schema or defines a new one, and whether `drive`/`skinner`'s trigger ticket
is "add a second subscriber" (needs a coordination mechanism) or "extend the existing
one" (needs learning/decision-making to share a dependency edge that doesn't exist
today). **Do not guess this — it is exactly the kind of decision item 015
(schema-versioning) and CANON coherence exist to gate.**

## 4. Split recommendation

None needed structurally — the source is already one coherent feature. The fork above is
a design question to resolve, not a reason to split the item into unrelated pieces.

## 5. Proposed epic + tickets (provisional — drafted so architect has something concrete
to rule on; ticket **20260702-011-a** is gated on Q1's answer and must not be built until
it resolves)

### Epic: 20260702-011-EPIC — Consolidation loop (idle replay + insight synthesis)
Depends on sibling items 20260702-008, 20260702-015, 20260702-018 landing as contract
work first (none exist as tickets yet — this epic cannot enter `queue` before they do).

---

### Ticket 20260702-011-a — Resolve + define the WKG insight-node write path for
consolidation (architect ruling + `atlas` schema, reviewer `scout`)
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** [] (this is the unblocking ticket — architect ruling, not code, is the
  actual gate; the schema work itself depends on item 015's migration framework landing)
- **non_goals:** No episodic replay logic here. No EWC wiring here. Not a redesign of
  `cross-session-synthesis`'s existing citation/confidence rules — reuse or extend, don't
  rewrite.
- **Given/When/Then (every criterion has a runnable check):**
  1. Given `architect` has ruled on Q1 (§3), when the ruling is recorded, then
     `docs/decisions/architect-log.yaml` contains an entry naming the chosen write path
     (extend-existing vs. new-label) — *check: `grep -c "20260702-011" docs/decisions/architect-log.yaml` returns ≥1*.
  2. Given the ruling, when the WKG shape is defined, then a migration script exists
     under `infra/migrations/` (per item 015's framework once it lands) that is
     idempotent and additive — *check: running the migration script twice produces the
     same node/constraint count both times (`MATCH (n:<label>) RETURN count(n)` before
     and after the second run are equal)*.
  3. Given the new/extended shape, when a unit test constructs a sample consolidation
     insight, then it validates against the documented shape (required props: id, source
     episode/theory refs, provenance, confidence, `insight_type`) — *check: `yarn
     workspace @sylphie/decision-making test <new spec file>` passes*.

---

### Ticket 20260702-011-b — Episodic + theory replay selection (idle + CognitiveAwareness
trigger) (`cortex`, reviewer `luria`)
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** [20260702-011-a]; also blocked on sibling item 20260702-018 landing
  (theory verdicts must exist to replay against) — noted, not a local ticket dependency.
- **non_goals:** No change to the ring-buffer size or the episodic encoding gate (source
  non-goal, preserved). No new pathology detectors.
- **Given/When/Then:**
  1. Given idle (no interaction in flight) and `CognitiveAwareness` pressure over the
     agreed threshold and ≥N recent episodes/verdicts, when the consolidation action
     runs, then it reads the ring buffer (all 50 slots or fewer if not full) plus
     recently confirmed/refuted theory nodes and selects a bounded candidate set — *check:
     unit test asserts `selectConsolidationCandidates()` returns ≤ the documented cap and
     never throws on an empty ring buffer*.
  2. Given the trigger fires, when it subscribes to drive state, then it does so via the
     existing push-style `driveState$` observable (CANON drive isolation: no pull/RPC
     into the drive) — *check: code review confirms the subscription mirrors the
     `learning.service.ts` pattern (`.driveState$.subscribe(...)`), no new RPC/HTTP call
     into drive-engine*.
  3. Given ticket -a's ruling chose "coordinate with the existing subscriber", when both
     the learning-package trigger and this one are pressure-eligible in the same tick,
     then only one fires (a documented coordination mechanism — e.g. a shared in-flight
     guard or explicit ordering) — *check: integration test simulates simultaneous
     eligibility and asserts exactly one consolidation cycle runs*.

---

### Ticket 20260702-011-c — Cross-episode pattern detection → insight synthesis
(`cortex`, reviewer `luria`; WKG write via `atlas`'s shape from -a)
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** [20260702-011-a, 20260702-011-b]
- **non_goals:** No benchmark quality bar (source: "plausible, provenance-linked" is the
  prototype bar, not measured accuracy).
- **Given/When/Then:**
  1. Given a candidate set from -b routed through the Type-2 deliberation path, when
     cross-episode patterns are detected, then at least one insight node is written to
     the WKG with provenance linking its source episode/theory ids — *check: integration
     test seeds ≥2 related episodes + 1 confirmed theory, runs the cycle, and queries
     Neo4j for the new node's provenance-linked source ids*.
  2. Given the write path, when the insight node is created, then confidence respects the
     0.60 pre-guardian ceiling (CANON Std-3/Std-6) — *check: unit test asserts the written
     confidence is ≤ 0.60 for a non-guardian-confirmed insight*.

---

### Ticket 20260702-011-d — Contradiction pruning on consolidation (`atlas`, reviewer
`scout`)
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** [20260702-011-c]; hard-blocked on sibling item 20260702-008 landing
  (the contradiction scanner is a structural no-op today per that item's confirmed
  finding — this ticket cannot pass its own acceptance criteria until 008 ships).
- **non_goals:** No changes to the contradiction-detection algorithm itself (008's scope).
- **Given/When/Then:**
  1. Given a Tess-refuted theory contradicting an existing WKG node (post-008, using the
     real `CONTRADICTS` shape), when consolidation runs, then the contradiction is
     pruned/demoted through the sanctioned path only — *check: integration test seeds a
     real `CONTRADICTS` edge in 008's fixed shape, runs consolidation, and asserts the
     contradicting node is demoted, not deleted-and-silently-replaced*.
  2. Given any consolidation write, when the MERGE-raises-only audit runs, then no node's
     confidence is lowered outside the sanctioned path — *check: existing/extended
     MERGE-raises-only audit script (or a new unit test if none exists yet — confirm
     during ticket build) passes against a consolidation-touched fixture graph*.

---

### Ticket 20260702-011-e — EWC-anchored confidence stability check on consolidation
(`learning`/`meridian`, reviewer `piaget`)
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** [20260702-011-c]
- **non_goals:** No changes to the EWC/Fisher computation itself (already real per
  cognition-service verification above) — this ticket only anchors consolidation writes
  to it and checks for regression.
- **Given/When/Then:**
  1. Given consolidation completes, when graduated-category agreement metrics are
     compared before/after, then they do not regress beyond the existing EWC tolerance
     band — *check: integration test captures agreement metrics pre/post a consolidation
     cycle against a fixture with ≥1 graduated category and asserts no regression beyond
     the documented tolerance*.
  2. Given consolidation completes, when the drive trace is inspected, then
     `CognitiveAwareness` pressure shows relief attributable to this cycle — *check: drive
     trace assertion in the same integration test*.

---

### Ticket 20260702-011-f — Insight count in snapshot metrics (`forge`, reviewer `ashby`)
- **engineering_level:** prototype
- **priority:** P2
- **depends_on:** [20260702-011-a]
- **non_goals:** No new dashboard UI beyond exposing the existing metrics block field
  (source only asks for the count to be visible in snapshot metrics).
- **Given/When/Then:**
  1. Given a consolidation cycle has run, when the next snapshot is taken, then its
     metrics block contains an `insights` count reflecting the new node(s) written by
     -c/-d — *check: snapshot-metrics unit/integration test asserts the field is present
     and its value increases across a before/after consolidation cycle*.

## 6. Priority rationale
Source declares P2 and this is a feature (compounding-learning capability), not a
security/data-loss/correctness-bug item — P2 stands for all tickets. No ticket here
argues for elevation.

## 7. Routing recommendation: **replan**
Reason: the design fork in §3 (Q1 — relationship to the already-built, done, EP-12
CognitiveAwareness/Insight-synthesis pipeline in `packages/learning`) is a genuine
architectural ambiguity that changes ticket scope and ownership. Per pipeline policy,
ambiguity routes to replan with the question written down, never guessed. Separately
(not itself a replan reason, but relevant context for whoever re-plans this): the item
also sits behind three entirely unbuilt sibling items (008, 015, 018) and cannot reach
`queue` until they do — the epic above should not be built before its dependency chain
lands, regardless of how Q1 resolves.
