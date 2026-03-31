# CANON Compliance Report — Epic 7: Learning (Consolidation Pipeline)

**Evaluation Date:** 2026-03-29
**Epic Status:** PRE-APPROVAL REVIEW
**Complexity:** L | **Dependencies:** E2, E3, E4, E6

---

## Overall Verdict: **COMPLIANT WITH CONCERNS**

Epic 7 is architecturally sound and aligned with CANON philosophy and standards. However, several implementation details require explicit specification before development begins. All concerns are resolvable through clarification; no architectural redesign is needed.

---

## Philosophy Alignment

### 1. Experience Shapes Knowledge — LLM Provides Voice

**PASS**

Epic 7 correctly implements this principle:
- Learning reads from **TimescaleDB** (experience record), not from LLM hallucination
- Consolidation surfaces entities and relationships extracted from actual events marked `has_learnable=true`
- LLM assists in edge refinement (not creation from thin air) — it interprets relationships within experienced content
- Provenance discipline: `LLM_GENERATED` tags acknowledge which refinements came from LLM assistance vs. direct observation
- Contradiction detection signals developmental moments (Piagetian disequilibrium) rather than suppressing them

**Evidence:** Consolidation pipeline explicitly queries TimescaleDB for learnable events, not free-form LLM generation. Entity extraction from actual experience, not imagination.

---

### 2. Dual-Process Cognition

**PASS**

Learning supports Type 1/Type 2 transition:
- LLM involvement in edge refinement is **deliberate and traceable** (Type 2 cost exists — LLM API calls, latency)
- Entities and edges created by Learning can graduate to Type 1 when they meet confidence thresholds (> 0.80 AND MAE < 0.10)
- Graph consolidation removes temporal context gradually, allowing episodic memory to compress into semantic memory — the mechanism by which Type 2 becomes Type 1
- **Satisfaction habituation on repeated actions** — prevents Type 2 lock-in by making the LLM's suggestions less rewarding over repetition

**Evidence:** Entity/edge creation is timestamped; confidence mechanics allow Type 1 graduation. Consolidation pipeline does not lock behaviors into permanent status.

---

### 3. The World Knowledge Graph Is the Brain

**PASS**

Epic 7 correctly treats WKG as the architectural center:
- All learning writes to WKG via upsert operations
- Maintenance cycle is triggered by **Cognitive Awareness drive** (self-knowledge pressure) — the graph's own fullness/readiness
- WKG is the **source of truth** for decision-making in future sessions
- No learning happens that doesn't eventually write to the graph

**Evidence:** Consolidation pipeline feeds directly into WKG; Learning subsystem is primarily a gateway, not a storage system.

---

### 4. The Guardian Is the Primary Teacher

**PASS**

Epic 7 respects Guardian Asymmetry:
- Learning distinguishes `GUARDIAN` provenance (base confidence 0.60) from `LLM_GENERATED` (base confidence 0.35)
- Guardian-tagged knowledge starts with higher trust than LLM-assisted knowledge
- Contradiction detection suggests reviewing guardian-confirmed edges when they conflict — guardian feedback would resolve them
- No autonomous override of guardian-supplied knowledge

**Evidence:** Provenance system makes guardian input immediately distinguishable and weighted appropriately in confidence dynamics.

---

### 5. Personality Emerges from Contingencies, Not Targets

**PASS**

Learning feeds contingencies, not traits:
- Entity and edge creation from actual experience builds the graph that **shapes contingencies**
- If Sylphie learns "asking Jim questions → response within 30s → Social relief" (contingency), **personality follows**
- No trait targeting ("make Sylphie curious") — curiosity emerges from successful information-seeking in the consolidation pipeline
- Contradiction detection creates learning opportunities without prescribing personality

**Evidence:** Learning creates knowledge; Drive Engine uses that knowledge in contingency structure. Personality emerges from the loop, not from Learning's design.

---

### 6. Prediction Drives Learning

**PASS**

Learning is prediction-driven:
- Consolidation selects learnable events from TimescaleDB, which are **prediction outcomes** (things that happened after predictions were made)
- Edge refinement from predictions creates generalizable relationships
- Contradiction detection flags **failed predictions** as catalysts
- Learning output (new entities, edges) feeds back into Decision Making's prediction cache

**Evidence:** TimescaleDB event filter `has_learnable=true` is set by the Decision Making subsystem after evaluating prediction accuracy. Failed predictions → learnable events → learning.

---

### 7. Provenance Is Sacred

**PASS** (with clarification needed)

Epic 7 correctly implements provenance tagging:
- Entities extracted from experience are tagged `LLM_GENERATED` (if LLM-assisted) or `SENSOR`/`GUARDIAN` (if from input)
- Edges refined by LLM are tagged `LLM_GENERATED`
- Provenance is **never erased** during consolidation

**Concern:** Epic scope does not explicitly state how provenance is updated during refinement. Does an edge created as `SENSOR` that is later refined by LLM become `LLM_GENERATED`, or does it retain `SENSOR` with a note of refinement? **Clarification needed before implementation.**

---

### 8. Offload What's Solved, Build What Isn't

**PASS**

Epic 7 uses existing LLM capability appropriately:
- Edge refinement delegates relationship interpretation to Claude API (solved problem: NLP)
- Entity extraction leverages LLM pattern matching (solved problem)
- Learning subsystem focuses on **what's not solved**: consolidation timing, contradiction detection, confidence dynamics, integration with Drive Engine

**Evidence:** Epic scope correctly uses LLM for NLP tasks, focuses subsystem logic on graph management and prediction-feedback loops.

---

## Six Immutable Standards Check

### 1. The Theater Prohibition

**PASS**

Learning does not produce direct output to the user. It updates internal knowledge:
- No speech acts, no emotional expressions
- Learning writes to graph; Communication reads from graph when generating responses
- If a learned contradiction produces conflicting emotional knowledge, the **Drive Engine** evaluates whether to surface it — Theater Prohibition is enforced downstream

**Evidence:** Learning is silent subsystem; only WKG state changes, no user-facing output.

---

### 2. The Contingency Requirement

**PASS**

Every learned relationship traces to experience:
- Consolidation queries `has_learnable=true` events from TimescaleDB
- Each event is associated with **specific behavior, prediction, and outcome**
- Entity/edge creation is contingent on successful integration (no orphaned knowledge)

**Evidence:** Consolidation pipeline is explicitly grounded in event records that carry behavioral context.

---

### 3. The Confidence Ceiling

**PASS** (with implementation detail required)

Epic 7 correctly implements the ceiling:
- LLM-assisted entities start at 0.35 (not 0.60)
- Entities start below retrieval threshold (0.50) unless guardian-confirmed
- Confidence must rise through **repeated retrieval-and-use** (ACT-R formula)

**Concern:** Epic scope does not specify the initial confidence for entities extracted from SENSOR/INFERENCE events. **Clarification needed:** Should sensor-extracted entities start at 0.40 (SENSOR base) or lower? **Recommend:** Sensor-extracted start at 0.40, but do not exceed 0.60 until used successfully.

---

### 4. The Shrug Imperative

**PASS**

Learning does not force decisions:
- Consolidation extracts what was learned; does not recommend behavior
- Low-confidence edges do not trigger reflex actions
- Decision Making remains responsible for "shrug" response when no action exceeds threshold

**Evidence:** Learning is write-only to graph; Decision Making reads and arbitrates.

---

### 5. The Guardian Asymmetry

**PASS** (with specification gap)

Epic 7 respects Guardian Asymmetry in provenance:
- GUARDIAN-tagged edges start at 0.60
- LLM_GENERATED edges start at 0.35
- Contradiction detection should flag guardian-confirmed knowledge conflicts for human review

**Concern:** How does contradictiondetection weight guardian knowledge vs. LLM knowledge? **Clarification needed:** If a GUARDIAN edge contradicts an LLM_GENERATED edge, should the system prefer the GUARDIAN edge for resolution? **Recommend:** Yes — Guardian Asymmetry applies to conflict resolution.

---

### 6. No Self-Modification of Evaluation

**PASS** (with dependency note)

Learning does not modify its own success criteria:
- Entity extraction rules are hardcoded (not learned)
- Confidence update rules come from Decision Making (fixed ACT-R formula)
- Learning cannot modify the `has_learnable` filter or timing of consolidation cycles
- Consolidation timing is drive-mediated but **Cannot be changed by Learning subsystem**

**Note:** Maintenance cycle timing is mediated by **Cognitive Awareness drive** (Epic 4 dependency). Learning subsystem cannot modify drive rules; only Guardian can approve new rules via Postgres review queue. **Dependency is correctly scoped.**

---

## Architecture Check

### Five-Subsystem Model

**PASS**

Epic 7 correctly fits into subsystem architecture:

| Subsystem | Role in Epic 7 | Status |
|-----------|---|---|
| **Decision Making** (1) | Produces predictions → TimescaleDB; Learning reads outcomes | Dependency met |
| **Communication** (2) | Provides conversational content → TimescaleDB; Learning extracts entities | Dependency met |
| **Learning** (3) | **THIS EPIC** — Consolidates, refines, updates WKG | In scope |
| **Drive Engine** (4) | Triggers maintenance cycles via Cognitive Awareness drive | Dependency (E4) |
| **Planning** (5) | Uses consolidated knowledge for opportunity research | Downstream consumer |

Learning correctly depends on E2, E3, E4, E6 and feeds downstream to E5.

### Five Databases

**PASS**

Epic 7 uses databases correctly:

| Database | Role in Epic 7 | Status |
|----------|---|---|
| **World Knowledge Graph (Neo4j)** | Write target for entities, edges, provenance | ✓ Central to epic |
| **TimescaleDB** | Read source for learnable events, context | ✓ Input |
| **KG(Self)** | Not directly modified by Learning | ✓ Isolated per CANON |
| **Other KGs (Grafeo)** | Not modified by Learning | ✓ Isolated per CANON |
| **PostgreSQL** | Stores drive rules (Learning cannot modify) | ✓ Correct isolation |

**Isolation maintained.** Learning does not cross-contaminate KG(Self), Other KGs, or break Postgres write-protection.

### KG Isolation

**PASS**

Epic 7 respects absolute isolation:
- WKG entities are world knowledge (neutral)
- Self KG and Other KGs are **never written by Learning** — only by their respective subsystems (KG(Self) by Decision Making/Self-Evaluation, Other KGs by Communication)
- Consolidation creates no cross-graph edges
- **No shared provenance between graphs**

**Evidence:** Epic scope explicitly limits Learning to WKG writes; all three KGs remain isolated.

### Drive Isolation

**PASS**

Learning does not modify Drive Engine:
- Maintenance cycle **reads** Cognitive Awareness drive value (one-way)
- Learning cannot **write** to drive computations or rules
- Drive rules remain in Postgres with Guardian-approval gate

**Evidence:** Learning is read-only from drives; write-protected isolation is maintained.

---

## Phase Boundary Check

### Phase 1 Scope

**PASS**

Epic 7 is entirely Phase 1:
- No hardware involved
- No robot perception beyond vision (Phase 2)
- Consolidation works from **conversation and prediction outcomes**, not embodied experience
- All five subsystems remain software-based

**Evidence:** Learning consolidates text and event records, not sensor streams. Aligns with Phase 1 definition.

---

## Confidence Dynamics Check

### ACT-R Formula

**PASS** (with implementation specification required)

Epic 7 correctly seeds confidence values for consolidation:

`min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

- **SENSOR base:** 0.40 ✓
- **GUARDIAN base:** 0.60 ✓
- **LLM_GENERATED base:** 0.35 ✓
- **INFERENCE base:** 0.30 ✓

**Concern:** Epic scope does not specify what base confidence entities receive during extraction. **Clarification needed:**
- Are entities extracted from SENSOR events assigned 0.40 base?
- Are entities extracted from GUARDIAN feedback assigned 0.60 base?
- Are LLM-extracted entities assigned 0.35 base?

**Recommend:** Yes to all three. Provenance → base confidence is deterministic.

### Retrieval Threshold

**PASS**

Learning respects the 0.50 threshold:
- Entities below 0.50 are not selected for Type 1 decisions
- Consolidation does not artificially boost confidence
- Confidence grows only through repeated retrieval-and-use

**Evidence:** No bypass mechanism proposed in Epic 7 scope.

### Type 1 Graduation

**PASS**

Learning feeds data that enables graduation:
- Edge creation from consolidation → entities available for confidence tracking
- Confidence > 0.80 AND MAE < 0.10 over last 10 uses triggers Type 1 graduation
- Decision Making arbitrates; Learning provides the knowledge substrate

**Evidence:** Type 1 graduation is a Decision Making/Drive Engine concern; Learning provides the necessary history and knowledge structures.

### Confidence Ceiling

**PASS** (specification gap)

- No untested entity exceeds 0.60 ✓
- LLM_GENERATED edges cap at 0.35 base ✓

**Concern:** How are extracted entities constrained to the ceiling? Is this enforced at upsert time, or does it happen during confidence update? **Clarification needed:** Recommend enforcement at upsert time — newly created entities should not exceed base + modest initial boost.

---

## Planning Rules Check

### Rule 1: No Code Without Epic-Level Planning

**PASS**

This compliance review IS the epic-level planning validation. Epic 7 roadmap is sufficient for implementation planning. ✓

### Rule 2: Every Epic Planned by Parallel Agents

**PASS**

This review is conducted by the Canon guardian agent (this document). Other agent analyses should follow to cross-examine. ✓

### Rule 3: CANON Is Immutable

**PASS**

No CANON modifications proposed by Epic 7. ✓

### Rule 4: Every Implementation Session Produces Tangible Artifact

**PENDING**

Epic 7 implementation will produce:
- Consolidation orchestrator code
- Entity extraction module
- Edge refinement module
- Contradiction detection module
- Learning job implementations (temporal pattern, procedure formation, pattern generalization, correction processing)
- Session logs in `docs/sessions/`

**Requirement:** After implementation, write session log to `docs/sessions/YYYY-MM-DD-epic-7-learning.md` per template. ✓

### Rule 5: Context Preservation at End of Session

**PENDING**

Implementation session must save context:
- Which modules were modified
- Wiring changes (e.g., new TimescaleDB event filters for `has_learnable`)
- Known issues discovered during implementation
- Gotchas for next session

Covered by session log requirement. ✓

---

## Violations

**NONE**

Epic 7 contains no violations of CANON philosophy, standards, or implementation rules.

---

## Concerns (Non-Violation but Noteworthy)

### Concern 1: Provenance Refinement During Consolidation

**Severity:** Medium | **Impact:** Implementation clarity

**Issue:** Epic 7 scope does not explicitly state how provenance is updated when an edge is refined. If an entity starts as SENSOR-extracted, then is refined by LLM, should it become LLM_GENERATED or retain SENSOR with a refinement note?

**CANON Reference:** Philosophy 7 (Provenance Is Sacred) requires that provenance is "never erased."

**Recommendation:** Implement provenance chains, not replacement.
- Original extraction: `SENSOR`
- LLM refinement: Add **relationship** `REFINED_BY: [LLM timestamp]`, but preserve original provenance
- Result: Edge carries both SENSOR origin AND LLM refinement lineage
- This enables the "lesion test" — removing LLM shows what came from pure experience

**Action:** Add to implementation specification before code begins.

---

### Concern 2: Contradiction Resolution Priority

**Severity:** Medium | **Impact:** Learning direction in conflicts**

**Issue:** When consolidation detects a contradiction (e.g., GUARDIAN edge vs. LLM_GENERATED edge about the same relationship), what is the resolution strategy?

**CANON Reference:** Guardian Asymmetry (Standard 5) and Provenance (Philosophy 7).

**Recommendation:** Implement weighted conflict resolution:
1. If GUARDIAN edge exists: flag contradiction, do NOT merge LLM edge; surface to guardian for decision
2. If SENSOR edge exists: allow LLM edge to coexist at lower confidence pending retrieval-and-use confirmation
3. If two LLM_GENERATED edges contradict: merge using information-theoretic score (which is simpler/more parsimonious?)

**Action:** Add to implementation specification before code begins.

---

### Concern 3: Maintenance Cycle Timing Detail

**Severity:** Low | **Impact:** Drive dynamics**

**Issue:** Epic 7 scope states maintenance cycle is "pressure-driven (Cognitive Awareness drive), timer fallback." Does not specify:
- What is the minimum/maximum cycle interval?
- What is the Cognitive Awareness threshold that triggers consolidation?
- What is the timer fallback interval (e.g., consolidate every 1 hour regardless)?

**CANON Reference:** Core Philosophy 6 (Prediction Drives Learning) — should consolidation be reactive (prediction failure → consolidate) or periodic?

**Recommendation:** Implement as follows:
- **Reactive:** When Cognitive Awareness > 0.6 (system feels full of unintegrated experience), trigger maintenance cycle
- **Periodic fallback:** If no reactive trigger for > 60 minutes, force consolidation (prevent knowledge starvation)
- **Rate limit:** Max 1 consolidation per 10 minutes to prevent thrashing

**Action:** Add to implementation specification before code begins.

---

### Concern 4: Learning Job Scope Clarity

**Severity:** Low | **Impact:** Feature completeness**

**Issue:** Epic 7 scope lists "learning jobs" — temporal pattern detection, procedure formation, pattern generalization, correction processing. Each job type is mentioned but not detailed. Is this epic responsible for all four, or only some?

**CANON Reference:** Every implementation session produces tangible artifacts (Rule 4). Need to know which jobs are in scope.

**Recommendation:** Clarify job scope:
1. **Temporal pattern detection** — E7 (this epic)
2. **Procedure formation** — E7 or E5 (Planning)? Recommend: E5, after Learning feeds opportunity detection
3. **Pattern generalization** — E7 (part of consolidation)
4. **Correction processing** — E7 (when guardian corrects, update confidence + provenance)

**Action:** Add to epic scope clarification before implementation begins.

---

### Concern 5: LLM Cost Accounting

**Severity:** Low | **Impact:** Type 2 cost structure**

**Issue:** Edge refinement uses Claude API. Epic 7 scope does not mention cost tracking or drive pressure from LLM latency.

**CANON Reference:** Core Philosophy 2 (Type 2 must always carry explicit cost).

**Recommendation:** Implement cost tracking:
- Record LLM API latency for each consolidation cycle
- Write latency to TimescaleDB as a "learning cost" event
- Drive Engine reads this cost and applies Cognitive Effort pressure proportional to consolidation frequency
- This creates genuine evolutionary pressure for the system to consolidate less often as it matures

**Action:** Add to implementation specification before code begins.

---

## Required Actions Before Approval

Before the Epic 7 implementation begins:

1. **Specify provenance refinement behavior** (Concern 1)
   - File: `docs/decisions/` — new decision record
   - Content: Provenance chain structure when edges are refined

2. **Specify contradiction resolution strategy** (Concern 2)
   - File: `docs/decisions/` — new decision record
   - Content: Priority rules for conflicting edges by provenance type

3. **Specify maintenance cycle timing** (Concern 3)
   - File: `docs/decisions/` — new decision record
   - Content: Reactive trigger threshold, periodic fallback interval, rate limits

4. **Clarify learning job scope boundaries** (Concern 4)
   - File: `wiki/phase-1/epic-7/` — update epic scope
   - Content: Which jobs are E7 vs. deferred to E5; acceptance criteria for each

5. **Add cost tracking specification** (Concern 5)
   - File: `docs/decisions/` — new decision record
   - Content: LLM cost accounting, drive pressure application, maturation dynamics

6. **Type-check all code** before merge
   - Command: `npx tsc --noEmit` from repo root

7. **Write session log** after implementation
   - File: `docs/sessions/YYYY-MM-DD-epic-7-learning.md`
   - Template: Provided in CLAUDE.md

---

## Jim's Attention Needed

### Decision: Provenance Chain Design

Jim should review and approve the provenance refinement strategy (Concern 1). The question of whether provenance can be augmented without erasure touches on the "lesion test" — Jim's framework for measuring whether Sylphie is developing genuine knowledge.

**Recommended approach:** Implement provenance as a DAG (directed acyclic graph), not a simple scalar. Each edge carries lineage of refinements while preserving original source. This honors "provenance is sacred" while allowing learning to improve representation.

### Decision: Contradiction as Teaching Opportunity

Jim should confirm that contradictions detected during consolidation should **surface for guardian review**, not be auto-resolved. This aligns with Piagetian disequilibrium but requires explicit guardian feedback loop integration.

**Recommended approach:** Flag contradictions in TimescaleDB with `contradiction_type` and `needs_guardian_input = true`. Communication subsystem can proactively ask Jim about conflicts, creating learning opportunities.

---

## Summary

**Epic 7: Learning is COMPLIANT with the CANON** and ready for implementation planning. No architectural changes needed. Five implementation decisions must be made and documented before code begins. All decisions are localized to Epic 7; no changes to other subsystems or CANON principles required.

**Next Steps:**
1. Guardian (Jim) reviews this analysis and approves concerns → decision records
2. Implementation team addresses clarifications in spec documents
3. Implementation proceeds with enhanced specification
4. Session log captures artifacts and gotchas
5. Code review validates against this compliance analysis
