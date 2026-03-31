# Epic 7: Learning (Consolidation Pipeline) — Technical Decisions

**Date:** 2026-03-29
**Status:** APPROVED (Cross-Agent Review Complete)
**Epic:** Epic 7 — Learning (Consolidation Pipeline)
**Reference:** CANON Philosophy 7 (Provenance), Standard 2 (Contingency), Standard 5 (Guardian Asymmetry)

---

## Decision 1: Provenance Refinement Strategy

**Context:**
When an entity starts as SENSOR-extracted, then is refined by the LLM during edge refinement, should the original provenance be replaced with `LLM_GENERATED`, or should both be preserved?

**Decision:**
Implement **provenance chains**, not replacement. Original provenance is never erased. Add `refined_by` metadata array tracking the full refinement lineage. The Lesion Test works by filtering on original provenance; refined edges retain their base provenance marker.

**Implementation Details:**
- Edge structure adds optional `refined_by` field: array of `{ timestamp, refiner_type (LLM|GUARDIAN), confidence_delta }`
- Base provenance never changes: `SENSOR` edge refined by LLM remains `SENSOR` with `refined_by: [{refiner_type: LLM, ...}]`
- Lesion Test filters on base provenance marker: `WHERE provenance = 'SENSOR'` captures all SENSOR-sourced edges regardless of refinement history
- Confidence updates during refinement: `old_confidence + confidence_delta` recorded in `refined_by` entry

**Rationale:**
CANON Philosophy 7 explicitly states: "This distinction is never erased. It enables the Lesion Test." Provenance is the audit trail. Erasing it loses the ability to test whether refined knowledge is superior to base knowledge. The refinement chain also creates transparency: we can always ask "which refinements made this stronger?" and remove them individually if needed.

**CANON Reference:**
Philosophy 7 (Provenance Is Sacred), Section "Provenance" in Core Standards

---

## Decision 2: Contradiction Resolution Priority

**Context:**
When consolidation detects conflicting edges from different provenance sources (e.g., SENSOR says `person:likes:coffee`, GUARDIAN says `person:dislikes:coffee`), what is the resolution order?

**Decision:**
Implement a strict provenance hierarchy:

1. **GUARDIAN edges are never overwritten** by lower-provenance edges. Surface contradictions to the guardian for explicit decision.
2. **SENSOR edges can be updated by GUARDIAN**, but both may coexist at different confidence levels if the guardian permits.
3. **LLM_GENERATED vs LLM_GENERATED** conflicts: merge using parsimony principle (prefer simpler relationship type).
4. **INFERENCE is lowest priority** — overwritten by any direct evidence from SENSOR, LLM_GENERATED, or GUARDIAN.
5. **All contradictions logged** to TimescaleDB as `CONTRADICTION_DETECTED` events regardless of resolution outcome (including suppressed contradictions).

**Implementation Details:**
- Contradiction detection emits event: `{ event_type: CONTRADICTION_DETECTED, from_edge_id, to_edge_id, from_provenance, to_provenance, confidence_gap, resolution_action }`
- Resolution action is one of: `GUARDIAN_REVIEW_REQUESTED`, `SUPERSEDED_BY_HIGHER_PROVENANCE`, `MERGED_VIA_PARSIMONY`, `COEXIST_AT_DIFFERENT_CONFIDENCE`
- Guardian review queue includes unresolved GUARDIAN contradictions with priority weight
- Parsimony rule: simpler relationship (fewer properties, fewer conditions) wins among equal-provenance edges

**Rationale:**
Standard 5 (Guardian Asymmetry) establishes that "Guardian feedback outweighs algorithmic evaluation (2x confirm, 3x correction)." GUARDIAN marks feedback directly from the human; it should not be silently overwritten. SENSOR evidence is more direct than INFERENCE, which is speculative. Parsimony is a classical learning principle (Occam's Razor) — simpler edges are more likely to be correct.

**CANON Reference:**
Standard 5 (Guardian Asymmetry), Section "Guardian Feedback Weight", Provenance hierarchy in Confidence Dynamics

---

## Decision 3: Maintenance Cycle Timing

**Context:**
What triggers consolidation to run, and at what frequency? Should it be event-driven, timer-driven, or both?

**Decision:**
Implement **dual-trigger** timing:

- **Reactive trigger:** Cognitive Awareness drive > 0.6 threshold (system initiates consolidation when sufficiently "aware" of inconsistency)
- **Periodic fallback:** Every 5 minutes (not 60 minutes — Phase 1 testing requires frequent learning cycles to detect accumulation problems early)
- **Rate limit:** Minimum 30 seconds between consecutive cycles (prevent thrashing due to rapid event arrival)
- **Maximum cycle duration:** 60 seconds timeout (hard stop; incomplete consolidation rolls back or queues remainder)

**Implementation Details:**
- Timer kicks off at server start or after previous cycle ends
- If `cognitive_awareness_drive > 0.6`, consolidation runs immediately (supersedes timer)
- Consolidation job emits `CONSOLIDATION_CYCLE_STARTED` and `CONSOLIDATION_CYCLE_COMPLETED` events
- If cycle hits 60s timeout: emit `CONSOLIDATION_CYCLE_TIMEOUT`, save checkpoint, resume on next trigger
- Minimum 30s delay enforced between `CONSOLIDATION_CYCLE_COMPLETED` and next trigger (timer or reactive)

**Rationale:**
CANON states "pressure-driven with timer fallback." In Phase 1, we are testing whether the system learns. A 60-minute cycle means learning is invisible during a testing session. 5 minutes allows us to observe the effects of consolidation, contradiction detection, and drive relief in real-time. The reactive trigger ties consolidation to actual cognitive pressure (Cognitive Awareness), making it behavior-driven. The 30s rate limit prevents the system from spending all CPU on learning; the 60s timeout prevents individual cycles from starving other subsystems.

**CANON Reference:**
Section "Maintenance Cycle Timing", Piaget's accommodation/assimilation cycle notes, Philosophy 2 (Type 2 must carry explicit cost)

---

## Decision 4: Learning Job Scope

**Context:**
Which of the 7 v1 maintenance jobs belong in Epic 7 scope? Are all 7 jobs included, or are some deferred to future epics?

**Decision:**
**All 7 jobs are in Epic 7 scope**, as explicitly stated in the Phase 1 Roadmap:

1. **TemporalPatternJob** — detect `RESPONSE_TO` patterns from phrase timing (e.g., if phrase X always precedes phrase Y, create or strengthen `RESPONSE_TO` edge)
2. **ProcedureFormationJob** — cluster multiple `RESPONSE_TO` edges into `ActionProcedure` nodes (e.g., "greet → ask how you are → listen" becomes a procedure)
3. **PatternGeneralizationJob** — identify sibling clusters, propose `ConceptPrimitive` nodes (e.g., multiple procedures that follow a pattern suggest a concept)
4. **CorrectionProcessingJob** — process `SUPERSEDES` edges created by guardian corrections, create `CORRECTED_BY` edges, update confidence
5. **SentenceSplittingJob** — split multi-sentence phrase nodes into individual sentences (e.g., "Hello. How are you?" → two phrase nodes)
6. **SentenceStructureJob** — build template slots from sentence structure, create phrase patterns (e.g., "You said [X]" → `TemplateSlot` for [X])
7. **SymbolicDecompositionJob** — delegate to sub-services for word-level decomposition; integrate results into graph

**Execution Order:**
TemporalPattern → ProcedureFormation → CorrectionProcessing → SentenceSplitting → SentenceStructure → SymbolicDecomposition → PatternGeneralization

**Rationale:**
The Phase 1 Roadmap explicitly lists all 7 jobs. TemporalPattern is foundational (other jobs depend on RESPONSE_TO edges). CorrectionProcessing is high-priority because it processes guardian feedback immediately. SentenceSplitting happens early (enables structure analysis). PatternGeneralization runs last (requires accumulated data to identify clusters). The order respects dependency chains: temporal patterns must exist before procedure formation; procedures must exist before generalization.

**CANON Reference:**
Phase 1 Roadmap, Section "Maintenance Jobs", Epic 7 Scope Definition

---

## Decision 5: LLM Cost Tracking in Learning

**Context:**
Edge refinement and entity extraction use Claude API calls. How is this cost accounted for? Should the Drive Engine know about it?

**Decision:**
**Explicit cost tracking for every LLM call during consolidation:**

- Record token count (input + output) and latency (ms) for every LLM call during consolidation
- Emit `LEARNING_LLM_COST` event to TimescaleDB with: `{ cycle_id, job_type, tokens_in, tokens_out, latency_ms, model_id, cost_usd_estimate }`
- Drive Engine reads this cost metric via metrics API to apply **Cognitive Effort pressure** (cost increases effort perception)
- Cost data available via `/api/metrics/learning-cost` endpoint for development monitoring and budget alerts

**Implementation Details:**
- Every consolidation job initializes cost accumulator
- Wrap all Claude API calls with cost capture: `{ tokens, latency, cost }`
- Emit batch `LEARNING_LLM_COST` event at end of cycle with aggregated counts
- Drive Engine reads cost metric and applies pressure: `cognitive_effort_pressure = tokens_used / token_budget_per_cycle`
- Dashboard can display learning cost trend over time

**Rationale:**
CANON Philosophy 2 states: "Type 2 must always carry explicit cost — latency, cognitive effort drive pressure, compute budget. Without cost, Type 1 never develops." If the Learning subsystem uses the LLM without explicit cost, the Drive Engine has no signal to pressure the system toward Type 1 (graph-based) learning. Explicit cost tracking makes the trade-off visible: "refinement via LLM is expensive; maybe invest in Type 1 automation instead."

**CANON Reference:**
Philosophy 2 (Cost Discipline), Section "Type 1 vs Type 2 Arbitration", Drive Engine Integration

---

## Decision 6: Adaptive Batch Sizing (Piaget Recommendation)

**Context:**
Piaget's notes recommend reducing batch size when contradictions are detected. How should this be implemented?

**Decision:**
Implement **simple adaptive batch sizing** with contradiction-aware adjustment:

- **Default batch size:** 5 events per cycle
- **If previous cycle had ≥2 contradictions:** reduce to 3 events next cycle (allow more time for accommodation)
- **If previous 3 cycles had 0 contradictions:** maintain at 5 events (system is stable)
- **Hard floor:** never less than 1 event per cycle (ensure progress)
- **Hard ceiling:** never more than 5 events per cycle (CANON constraint on consolidation load)

**Implementation Details:**
- Consolidation job tracks: `{ cycle_id, contradiction_count, batch_size_used }`
- At end of each cycle, compute next batch size: `if contradiction_count >= 2: next_size = 3; elif contradiction_count == 0 for 3 cycles: next_size = 5; else: next_size = current`
- Store `next_batch_size` in cycle state; apply on next trigger
- Emit event: `{ event_type: BATCH_SIZE_ADJUSTED, from_size, to_size, reason }`
- Dashboard displays batch size trend and contradiction frequency

**Rationale:**
Piaget's accommodation requires more cognitive resources than assimilation. When the graph encounters contradictions (accommodation events), processing fewer events per cycle gives the system time to stabilize. The 3-cycle stability window prevents oscillation: if one cycle has contradictions, we don't immediately increase batch size again. This is a soft form of homeostasis — the system regulates its own cognitive load based on conflict level.

**CANON Reference:**
Piaget Integration Notes, Section "Accommodation Pressure", Philosophy 2 (Cognitive Load Management)

---

## Decision 7: Contradiction Drive Relief (Skinner Recommendation)

**Context:**
Skinner notes that contradictions lack explicit drive contingency. Without it, the system has no behavioral incentive to detect and resolve them well.

**Decision:**
**Link contradiction handling to drive relief:**

- Successful **contradiction detection** produces **Information Integrity drive relief** proportional to `confidence_gap` between conflicting edges: `relief = min(0.2, confidence_gap * 0.15)` (higher confidence gap = larger relief)
- **Contradiction resolution** (when guardian explicitly confirms resolution) produces additional **Cognitive Awareness relief**: `relief = 0.1` (fixed)
- **Unresolved contradictions** (still in review queue after 5 minutes) create mild **Anxiety pressure**: `pressure = 0.05` per unresolved contradiction (motivates guardian escalation or system re-examination)

**Implementation Details:**
- On `CONTRADICTION_DETECTED` event: if `confidence_gap >= 0.1`, emit `DRIVE_RELIEF_CANDIDATE` with `drive=information_integrity, magnitude = confidence_gap * 0.15`
- Drive Engine processes relief request and updates Information Integrity drive state
- On guardian resolution (via `CONTRADICTION_RESOLVED` event): emit `DRIVE_RELIEF_CANDIDATE` with `drive=cognitive_awareness, magnitude=0.1`
- Every 5 minutes, scan review queue for unresolved contradictions; emit `DRIVE_PRESSURE_CANDIDATE` with `drive=anxiety, magnitude=0.05 * unresolved_count`
- Track: "How many contradictions did system detect this cycle?" and "How many did system resolve?" (metrics)

**Rationale:**
Standard 2 (Contingency Requirement) mandates: "Every positive reinforcement traces to a specific behavior." Without drive relief for detecting and resolving contradictions, the system has no intrinsic motivation to handle them well. Information Integrity relief reinforces the *detection* of contradiction (more confident that something is wrong is valuable). Cognitive Awareness relief reinforces the *resolution* of contradiction (completing the sense-making loop). Anxiety from unresolved contradictions creates extrinsic pressure toward resolution, preventing the system from ignoring problems.

**CANON Reference:**
Standard 2 (Contingency Requirement), Skinner Integration Notes, Section "Reinforcement Schedules", Information Integrity and Cognitive Awareness drive definitions

---

## Cross-Decision Consistency

These 7 decisions form a coherent system:

- **Decisions 1–2** ensure that provenance and guardian feedback are never erased (sacred boundaries)
- **Decision 3** sets realistic timing for Phase 1 observation
- **Decision 4** defines the scope of consolidation work
- **Decision 5** ensures Type 2 learning carries explicit cost (drives Type 1 development)
- **Decisions 6–7** implement adaptive, behavior-driven consolidation (Piaget + Skinner)

Together, they instantiate the core CANON principles: provenance preservation, guardian asymmetry, cost discipline, and contingency-driven behavior.

---

## Approval & Implementation Status

| Aspect | Status |
|--------|--------|
| Cross-agent review | APPROVED |
| CANON consistency | VERIFIED |
| Dependent on | None (independent decisions) |
| Blocks | Epic 7 Sprint 1 implementation |
| Implementation lead | Learning subsystem team |

---

## Next Steps

1. Implement Decision 1 (provenance chains) in Neo4j entity/edge schema
2. Build Decision 2 (contradiction resolution) into consolidation job logic
3. Configure Decision 3 (timing) in consolidation scheduler
4. Map Decision 4 (7 jobs) to concrete implementation tasks
5. Integrate Decision 5 (cost tracking) with Drive Engine metrics
6. Implement Decisions 6–7 (adaptive sizing + drive relief) in consolidation loop closure
