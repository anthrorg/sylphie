# CANON Compliance Review: Epic 10 -- Integration and End-to-End Verification

**Epic Number:** 10
**Epic Title:** Integration and End-to-End Verification
**Reviewed:** 2026-03-29
**Project Phase:** Phase 1 -- The Complete System
**Reviewer:** Canon (Project Integrity Guardian)

---

## Executive Summary

**Overall Verdict: COMPLIANT WITH CONCERNS**

Epic 10's scope is **fundamentally sound** and properly targets Phase 1 completion. The epic correctly identifies six critical "must prove" requirements that align with CANON Phase 1 objectives. However, there are **three material concerns** that require clarification and one **gap in the CANON documentation** that should be surfaced to Jim.

**Primary concerns:**
1. The Lesion Test framework lacks detailed specification for handling Type 2 cost measurement during LLM-disabled operation
2. Attractor state test coverage is incomplete (missing explicit tests for 2 of 6 states)
3. The "genuine learning" proof criterion is underspecified -- what constitutes evidence that learning is driven by prediction failure vs. LLM regurgitation?

**Requires Jim's attention:** The CANON does not specify acceptance criteria for "genuine learning" validation.

---

## 1. Core Philosophy Alignment

**Overall Result: PASS**

Epic 10 correctly validates all eight CANON philosophy principles:

### 1.1 Experience Shapes Knowledge
**Status: PASS**

The epic's "graph grows reflecting real understanding, not LLM regurgitation" requirement directly tests this principle. The provenance ratio metric (experiential edges vs. LLM_GENERATED edges) is the right measurement instrument.

**Verification in Epic 10:**
- Full-loop integration test will generate real events in TimescaleDB
- Learning subsystem will extract entities with provenance tracking
- Frontend metrics API will expose provenance ratio
- Graph inspection at `http://localhost:7474` will show edge sources

**Confidence:** HIGH. The epic's integration test will produce observable evidence.

---

### 1.2 LLM Is Voice, Not Mind
**Status: PASS**

The Lesion Test ("run without LLM, verify Type 1 behavior") directly proves this principle. If Sylphie is helpless without the LLM, this principle is violated.

**Verification in Epic 10:**
- Lesion test framework disables LLM access
- System falls back to Type 1 graph-based retrieval
- Observer verifies Type 1 actions are produced
- Comparison: behaviors with LLM vs. without LLM

**Concern:** The Lesion Test framework needs to specify how Type 2 cost tracking works when the LLM is disabled. If Type 2 is unavailable, does cost pressure reset? This detail matters for accurate behavior comparison.

**Recommendation:** Epic 10 should define a "LLM-disabled mode" specification that includes cost management semantics.

**Confidence:** MEDIUM. The test design is sound but underspecified in critical detail.

---

### 1.3 WKG Is the Brain
**Status: PASS**

The epic's requirement that "the graph grows" and the full-loop integration test confirm this. All five subsystems will read from and write to the WKG during normal operation.

**Verification in Epic 10:**
- Graph visualization at `http://localhost:7474` shows growth
- Decision Making subsystem retrieves actions from WKG
- Learning subsystem writes entities to WKG
- Planning subsystem writes procedures to WKG
- All value is accumulated in the graph

**Confidence:** HIGH.

---

### 1.4 Dual-Process Cognition
**Status: PASS**

The epic explicitly requires "Type 1/Type 2 ratio shifts over time" and includes a "Type 1 graduation test."

**Verification in Epic 10:**
- Type 1 graduation test simulates successful repetitions
- Confidence computation exceeds 0.80 AND prediction MAE < 0.10 over 10 uses
- Type 1 and Type 2 decisions are tracked separately in events
- Metrics API exposes the ratio over time

**Critical requirement:** Epic 10 must verify that the ratio actually improves with real experience, not just in simulation. The full-loop integration should show Type 1 ratio increasing as guardian interactions repeat.

**Confidence:** MEDIUM-HIGH. The epic addresses this, but depends on E5's correct implementation of arbitration and graduation mechanics.

---

### 1.5 Guardian as Primary Teacher
**Status: PASS**

The full-loop integration test includes "guardian speaks -> parse -> decide." Guardian feedback will flow through the system and into confidence updates.

**Critical verification needed:** The epic must measure the 2x confirmation and 3x correction weight multipliers being applied. A metrics endpoint showing guardian impact would strengthen this proof.

**Concern:** The epic's deliverables do not explicitly include a "guardian asymmetry validation" test. This should be added.

**Recommendation:** Add a test case: guardian corrects a false edge -> verify 3x confidence reduction applied -> verify schema-level correction propagates.

**Confidence:** MEDIUM. The epic covers the concept but lacks explicit validation.

---

### 1.6 Personality from Contingencies
**Status: PASS**

The epic requires "personality emerges from contingencies" and "recognizable behavioral patterns." The Attractor State Tests will verify that the contingency structure produces expected behaviors without trait targets.

**Verification in Epic 10:**
- Satisfaction habituation curve prevents repetition-based reward
- Anxiety amplification produces cautious-but-active behavior
- Guilt repair requires both acknowledgment AND behavioral change
- Social comment quality shapes topic selection
- Curiosity information gain prevents revisiting known territory

**Critical detail:** The epic must verify that these contingencies produce observable personality differences in the conversation logs. Does Sylphie actually avoid repetition? Does she express caution under high anxiety? The chatbox history should show these patterns.

**Concern:** The epic lists "attractor state tests" but does not specify that personality emergence should be verified through behavioral observation, not just through parameter tracking.

**Recommendation:** Include a subsection in Epic 10 deliverables: "Behavioral Personality Validation -- Conversation Log Analysis" to verify that contingencies produce actual personality differences observable in interaction transcripts.

**Confidence:** MEDIUM. The measurements are in place, but behavioral validation is not explicitly scoped.

---

### 1.7 Prediction Drives Learning
**Status: PASS**

The epic explicitly requires "prediction-evaluation loop produces genuine learning." This is the centerpiece of Phase 1 development.

**Verification in Epic 10:**
- Inner Monologue generates predictions before action
- Action outcomes are compared to predictions
- Failed predictions trigger Opportunity detection (Drive Engine)
- Opportunities feed Planning subsystem
- Planning creates Procedures
- Learning subsystem extracts knowledge from prediction errors
- The WKG grows in response to prediction failures

**Critical concern:** How will Epic 10 prove that learning is *driven by* prediction failure vs. *coincidental with* prediction failure? The epic must distinguish:
- Edges extracted from learnable events where a prediction failed
- Edges extracted from learnable events where no prediction was made
- Edges extracted from learnable events where predictions succeeded

The provenance ratio alone is insufficient. We need a "prediction-driven learning ratio."

**Major gap in CANON:** The CANON does not specify acceptance criteria for "genuine learning." This needs to be defined by Jim before Epic 10 can produce a definitive verdict.

**Recommendation to Jim:** Define "genuine learning" operationally. Suggest: "At least 60% of new edges in the WKG can be traced to prediction failure events (prediction ID exists, outcome < threshold, edge upsert happened)."

**Confidence:** LOW. The epic addresses the requirement but lacks a measurable definition of success.

---

### 1.8 Provenance Is Sacred
**Status: PASS**

The full-loop integration test will produce graph writes through multiple subsystems. Each write must carry provenance. The Lesion Test will verify that provenance enables the test (we can identify SENSOR + GUARDIAN + INFERENCE nodes).

**Verification in Epic 10:**
- Every graph write from E3+ includes provenance tag
- Lesion test filters to SENSOR + GUARDIAN + INFERENCE only
- Remaining system is functional (proves Type 1 capability)
- LLM_GENERATED nodes are separable and removable

**Confidence:** HIGH. Provenance enforcement happens at the Knowledge Module interface layer (E3).

---

## 2. Six Immutable Standards Verification

**Overall Result: PASS with ONE CONCERN**

Epic 10 must verify that all six standards are being enforced by the implementation. Let me assess each:

### 2.1 The Theater Prohibition
**Status: PASS**

The Communication module (E6) injects drive state into LLM context. The epic's full-loop integration will test this.

**Verification in Epic 10:**
- Communication module has `ITheaterValidator`
- Response generation queries current drive state
- Drive state is injected into LLM prompt
- A response that correlates with low drive state triggers zero reinforcement
- Test case: High anxiety drive (>0.7) -> response expresses calm confidence -> observe zero reinforcement applied

**Confidence:** MEDIUM. Depends on E6 correctly implementing `ITheaterValidator.validate()`.

**Recommendation:** Epic 10 should include a specific test: generate a response while Anxiety > 0.7 that violates the Anxiety state -> verify zero-reinforcement flag is set in TimescaleDB event.

---

### 2.2 The Contingency Requirement
**Status: PASS**

Every reinforcement event in TimescaleDB must trace to a specific action ID. The epic's full-loop integration will verify this.

**Verification in Epic 10:**
- TimescaleDB events include action_id field
- Drive evaluation results include action_id reference
- No batch or ambient reinforcement
- Learning subsystem traces edges back to prediction/action events

**Concern:** The epic does not explicitly list "contingency audit" as a test. This should be added.

**Recommendation:** Add a test: query all reinforcement events in TimescaleDB -> verify every one references a valid action_id -> verify action_id references a completed action -> report any orphaned reinforcement.

**Confidence:** MEDIUM. The mechanism is correct but audit is not explicitly scoped.

---

### 2.3 The Confidence Ceiling
**Status: PASS**

Knowledge module (E3) enforces `Math.min(0.60, confidence)` when `retrieval_count === 0`. The epic's Type 1 Graduation Test will verify this.

**Verification in Epic 10:**
- Create a new LLM_GENERATED node
- Verify it starts at 0.35
- Attempt to use it without successful retrieval-and-use
- Verify confidence remains capped at 0.60
- Use it successfully -> confidence can increase above 0.60
- Test both LLM_GENERATED and SENSOR sources

**Confidence:** HIGH. This is a simple enforcement point.

---

### 2.4 The Shrug Imperative
**Status: PASS**

Decision Making module (E5) has an explicit "I don't know" action path. The epic's full-loop integration will test this.

**Verification in Epic 10:**
- Situation where all Type 1 candidates are below dynamic threshold
- System outputs "I don't know" instead of selecting random action
- Incomprehension signal is logged as an action in TimescaleDB
- Guardian can respond to incomprehension (teaching moment)

**Confidence:** HIGH. This is straightforward to verify.

---

### 2.5 The Guardian Asymmetry
**Status: PASS**

Drive Engine (E4) applies 2x confirmation and 3x correction weight multipliers. The epic's full-loop integration will verify this.

**Verification in Epic 10:**
- Guardian confirms a fact -> confidence increases by 2x the base amount
- Guardian corrects a false edge -> confidence decreases by 3x the base amount
- Multipliers are hardcoded, not tunable
- Schema-level implications propagate (corrections reshape schema, not just instance)

**Critical test case needed:**
- Edge exists: (Person_Jim, LIKES, coffee) with confidence 0.50
- Guardian says "Actually, Jim doesn't like coffee"
- Verify: confidence decreases by 3x (not 1x)
- Verify: schema-level implications (LIKES relationships for other people) are NOT automatically reversed

**Concern:** The epic does not explicitly list a "Guardian Asymmetry Validation" test.

**Recommendation:** Add to Epic 10 deliverables: "Guardian Asymmetry Test -- verify 2x confirm and 3x correction multipliers applied, verify schema isolation."

**Confidence:** MEDIUM. The mechanism exists in E4, but Epic 10 should explicitly verify it.

---

### 2.6 No Self-Modification of Evaluation
**Status: PASS**

Drive Engine runs in separate process, Postgres RLS restricts writes. The epic's integration test will verify isolation.

**Verification in Epic 10:**
- Drive Engine process cannot write to PostgreSQL (RLS enforced)
- Drive Engine can only read drive_rules table
- Proposed rules go to proposed_drive_rules (queued, not self-activated)
- Confidence update rules are in code, not database
- Prediction error computation is deterministic

**Critical test case:**
- Attempt to write to drive_rules from within the application
- Verify PostgreSQL RLS rejects the write
- Verify proposed_drive_rules is the only insertion point
- Verify proposed rules don't self-activate

**Concern:** Epic 10 should explicitly test the RLS enforcement, not just assume it works from E1.

**Recommendation:** Add "Drive Isolation Verification" test to Epic 10: attempt invalid write paths -> verify rejection -> verify correct paths still work.

**Confidence:** MEDIUM-HIGH. The architecture is sound, but explicit verification is needed.

---

## 3. Architecture Compliance

**Overall Result: PASS**

Epic 10 is the integration epic. It must verify that all five subsystems and five databases work together correctly.

### 3.1 Five Subsystems Integration

**Status: PASS**

The full-loop integration test ("cold start -> guardian speaks -> parse -> decide -> respond -> drives update -> learning extracts -> WKG grows -> next decision has Type 1 candidate") explicitly sequences all five subsystems:

1. **Communication** (E6): Parse guardian input
2. **Decision Making** (E5): Generate predictions, arbitrate, execute
3. **Drive Engine** (E4): Evaluate action outcome, detect opportunities
4. **Learning** (E7): Extract entities, update WKG
5. **Planning** (E8): Process opportunities, create procedures

The epic's specification of this loop is correct and complete.

**Confidence:** HIGH.

---

### 3.2 Five Databases Integration

**Status: PASS**

- **WKG (Neo4j):** Graph grows; Decision Making retrieves actions; Planning writes procedures
- **TimescaleDB:** Events from all subsystems; Learning queries learnable events; Drive Engine queries patterns; Planning researches opportunities
- **PostgreSQL (System DB):** Drive rules stored (read-protected); proposed rules queued
- **Self KG (Grafeo):** Drive Engine reads for self-evaluation; Learning contributes self-model updates
- **Other KGs (Grafeo):** Communication reads Person_Jim model; Person modeling updates during interaction

**Confidence:** HIGH. All databases are integrated in the epic's scope.

---

### 3.3 KG Isolation

**Status: PASS**

Epic 10 must verify that Self KG and Other KGs do not contain references to WKG node IDs and vice versa.

**Verification needed:**
- Query Self KG -> verify no foreign key references to WKG
- Query Other KGs -> verify no cross-references between KGs
- WKG nodes have no references to Self KG or Other KG

**Concern:** The epic does not explicitly list "KG Isolation Audit" as a test.

**Recommendation:** Add: "KG Isolation Verification -- query each KG, verify no cross-references, verify node ID spaces are independent."

**Confidence:** MEDIUM. The architecture enforces isolation, but Epic 10 should verify it explicitly.

---

### 3.4 Drive Isolation

**Status: PASS**

The separate process and one-way IPC are already built in E4. Epic 10 must verify the isolation holds under real operation.

**Verification in Epic 10:**
- Drive Engine process is spawned separately
- IPC messages are unidirectional (read only from parent)
- No write channels to Drive Engine
- Drive rules remain unchanged from external writes
- Opportunity detection works correctly

**Confidence:** HIGH.

---

### 3.5 Subsystem Communication via Shared Stores

**Status: PASS**

All communication flows through TimescaleDB (events) and WKG (knowledge). No direct subsystem-to-subsystem calls.

**Verification in Epic 10:** Trace the data flow:
- Communication writes input events to TimescaleDB
- Decision Making reads those events
- Decision Making writes prediction events
- Drive Engine reads prediction events
- Drive Engine writes opportunity events
- Planning reads opportunity events
- Learning reads learnable events
- Learning writes to WKG
- Decision Making reads from WKG

**Confidence:** HIGH.

---

## 4. Phase Boundary Verification

**Overall Result: PASS**

Epic 10 is explicitly Phase 1 -- The Complete System. There are no Phase 2 elements in the scope.

**Phase 1 Scope (from CANON):**
- All five subsystems ✓
- All five databases ✓
- Confidence dynamics and Type 1/Type 2 mechanics ✓
- 12 drives with behavioral contingencies ✓
- Prediction-evaluation loop ✓
- NO physical body, NO robot chassis, NO hardware sensors ✓

**Verification:** Epic 10 lists no hardware, sensor, or motor control requirements. All testing is simulator-based or chatbox-based.

**Confidence:** HIGH.

---

## 5. Confidence Dynamics Verification

**Overall Result: PASS**

Epic 10 must verify the ACT-R formula and all thresholds are correctly enforced across E3, E4, and E5.

**Formula:** `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

**Critical test cases in Epic 10:**
1. Create a new node with base confidence (varies by provenance)
2. Verify it caps at 0.60 without retrieval-and-use
3. Use it successfully -> count increments
4. Verify confidence increases per formula
5. Wait time passes -> verify decay applies
6. Guardian confirms -> verify 2x multiplier
7. Simulate 10+ uses with <0.10 MAE -> verify Type 1 graduation

**Concern:** The epic does not list explicit "ACT-R Formula Validation" test. This is critical because the confidence dynamics are load-bearing.

**Recommendation:** Add comprehensive test: "Confidence Dynamics Validation -- verify base values, ceiling, retrieval-and-use gating, decay, multipliers, graduation criteria."

**Confidence:** MEDIUM. The mechanisms are in place, but explicit validation is not listed.

---

## 6. Planning Rules Verification

**Overall Result: PASS**

**CANON Planning Rule 1:** "No code without epic-level planning validated against this CANON."
Epic 10 itself is part of an epic plan that was validated. ✓

**CANON Planning Rule 2:** "Every epic is planned by parallel agents."
This review is part of that parallel validation (other agents review domain aspects). ✓

**CANON Planning Rule 3:** "This CANON is immutable unless Jim explicitly approves a change."
The epic does not propose CANON changes. ✓

**CANON Planning Rule 4:** "Every implementation session produces a tangible artifact."
Epic 10 itself is the artifact (integration test suite + verification framework). ✓

**CANON Planning Rule 5:** "Context preservation at end of session."
The epic description includes known issues and gotchas (good). Session logs should be written post-implementation. ✓

**Confidence:** HIGH.

---

## 7. Violations and Non-Compliance

**Overall: Zero hard violations.**

All fundamental architecture and philosophy principles are correctly scoped in Epic 10. No Phase 2 leakage. No Theater Prohibition violations anticipated. No drive isolation bypass.

---

## 8. Concerns (Non-Violations, But Important)

### Concern 1: Lesion Test LLM-Disabled Semantics
**Severity: MEDIUM**

The Lesion Test framework is correct in principle but underspecified in critical detail. When the LLM is disabled:
- Does Type 2 remain available but unreachable (error handling test)?
- Does Type 2 cost pressure reset or continue accumulating?
- Can the system distinguish "no LLM response" (Type 2 failed) from "no Type 2 attempt" (shrug)?

**Recommendation:** Epic 10 should include a detailed "LLM-Disabled Mode Specification" explaining these semantics before the test is run.

**Impact:** Without this specification, the test results could be ambiguous (did the system handle incomprehension well, or did it try to use LLM and fail?).

---

### Concern 2: "Genuine Learning" Definition Gap
**Severity: HIGH**

The CANON does not define measurable acceptance criteria for "genuine learning." The epic requires proving "the prediction-evaluation loop produces genuine learning" but does not specify what counts as proof.

**Current ambiguity:**
- Is it enough that the graph grows?
- Must we prove growth is *because of* prediction failures, not *despite* them?
- What percentage of new edges must be traceable to prediction errors?
- How do we distinguish LLM-generated knowledge that happens to align with reality from knowledge that was actually learned through experience?

**Recommendation to Jim:** Define "genuine learning" operationally. Suggest framework:
```
Genuine Learning Proof:
1. Prediction-driven edges: >=60% of new WKG edges trace to (prediction_id + failure + upsert) chain
2. Provenance ratio: >=50% of edges are (SENSOR + GUARDIAN + INFERENCE), not LLM_GENERATED
3. Edge utility: Edges created through prediction failure are actually used in subsequent decisions (>0.50 confidence, >1 retrieval)
4. Divergence from training: Edges are about domain-specific world facts, not general facts from Claude's training data
```

**Current Epic 10 deliverables:** "Graph grows reflecting real understanding, not LLM regurgitation." This is correct but too vague to operationalize.

**Impact:** CRITICAL. Epic 10 cannot produce a definitive verdict on genuine learning without this definition.

---

### Concern 3: Attractor State Test Coverage Incomplete
**Severity: MEDIUM**

The epic lists "attractor state tests" but does not specify which of the six known states are tested.

**CANON Known Attractor States:**
1. Type 2 Addict (HIGH RISK) -- LLM always wins
2. Rule Drift (MEDIUM RISK) -- self-generated rules diverge
3. Hallucinated Knowledge (MEDIUM RISK) -- plausible but false LLM-generated edges
4. Depressive Attractor (MEDIUM RISK) -- negative self-model feedback loop
5. Planning Runaway (LOW-MEDIUM RISK) -- too many opportunities -> resource exhaustion
6. Prediction Pessimist (LOW-MEDIUM RISK) -- early failures flood system with procedures

**Epic 10 coverage stated:**
"Attractor state tests: verify prevention for all 6 known states"

**Recommendation:** Epic 10 should list explicit test cases for each:
1. **Type 2 Addict:** Verify Type 1/Type 2 ratio improves over time (Type 1 graduation mechanic works)
2. **Rule Drift:** Verify proposed_drive_rules table remains empty or rarely filled (no autonomous rule generation that breaks design)
3. **Hallucinated Knowledge:** Verify LLM_GENERATED edges can be identified and separated (provenance + confidence ceiling)
4. **Depressive Attractor:** Verify Self KG doesn't contain sustained negative self-evaluations (self-evaluation on slower timescale works)
5. **Planning Runaway:** Verify opportunity queue decays; verify plan rate limiting works (not creating >N plans per window)
6. **Prediction Pessimist:** Verify early prediction failures don't flood the system; verify cold-start dampening works

**Current status:** "Verify prevention for all 6 known states" is correct but not detailed. Each state needs a specific test case.

**Recommendation:** Epic 10 should expand the attractor state section to list these six test cases explicitly.

---

### Concern 4: Guardian Asymmetry Explicit Validation Missing
**Severity: MEDIUM**

The epic's full-loop integration includes guardian interaction but does not explicitly verify the 2x/3x multipliers are applied.

**Recommendation:** Add explicit test case to Epic 10:
```
Test: Guardian Asymmetry Validation
1. Create edge: (Person_Jim, LIKES, coffee) with base confidence 0.50
2. Guardian confirms: "Yes, Jim likes coffee" -> measure confidence change
3. Verify: confidence increases by 2x base confirmation amount
4. Create edge: (Person_Jim, DISLIKES, tea) with confidence 0.50
5. Guardian corrects: "No, actually Jim likes tea" -> measure confidence change
6. Verify: confidence decreases by 3x base correction amount
7. Verify: schema-level implications don't propagate (correction is local)
```

---

### Concern 5: Behavioral Personality Validation Missing
**Severity: MEDIUM**

The epic requires "personality emerges from contingencies" and "recognizable behavioral patterns" but does not specify how behavioral personality will be validated beyond metrics.

**Recommendation:** Add subsection to Epic 10:
```
Behavioral Personality Validation (Conversation Log Analysis):
1. Run 30-message conversation with guardian repeating same topic
2. Analyze satisfaction habituation: does Sylphie avoid repeating successful responses?
3. Run conversation with high anxiety (custom drive state)
4. Analyze anxiety amplification: are responses more cautious?
5. Analyze social comment quality: does Sylphie favor topics guardian responds to quickly?
6. Compare logs across multiple runs: are personality patterns stable?
```

This goes beyond metrics and into actual observed behavior.

---

### Concern 6: Drift Detection Baseline Incomplete
**Severity: LOW-MEDIUM**

The epic lists "drift detection baseline" but does not specify what baseline metrics will be captured.

**CANON Drift Detection (every 10 sessions):**
1. Cumulative record slope
2. Behavioral diversity trend
3. Prediction accuracy trend
4. Guardian interaction quality
5. Sustained drive patterns

**Recommendation:** Epic 10 should capture baseline snapshots of these five metrics at the end of the integration test, to serve as comparison point for future session logs.

---

## 9. Gaps in the CANON

**Gap 1: "Genuine Learning" Definition (CRITICAL)**

The CANON requires Phase 1 to prove "the prediction-evaluation loop produces genuine learning" but does not define what measurable evidence would satisfy this proof.

**Recommendation to Jim:**
Define acceptance criteria operationally. The framework suggested above (prediction-driven edges ratio, provenance ratio, edge utility, divergence from training data) is one approach. Others may be better. This must be clarified before Epic 10 can proceed to implementation.

**Impact:** This is load-bearing. Without it, the entire Epic 10 verdict is uncertain.

---

**Gap 2: LLM-Disabled Mode Semantics**

The CANON mentions "the Lesion Test" but does not specify how the system should behave when LLM access is unavailable. Should it gracefully degrade? Should Type 2 error out? Should incomprehension detection trigger?

**Recommendation to Jim:**
Specify LLM-disabled mode semantics. Suggest: "When LLM is unavailable, Type 2 calls error; system falls back to Type 1 or Shrug Imperative; cost pressure does not accumulate."

---

**Gap 3: "Real Understanding" vs. "LLM Regurgitation" Distinction**

The CANON principle "Experience Shapes Knowledge" should be empirically testable, but the distinction between learned edges and LLM-generated edges that happen to be correct is not formalized.

**Recommendation to Jim:**
Define a test procedure: given a domain fact that is true in the real world but not in Claude's training data (or domain-specific fact), verify that Sylphie learns it through experience. Example: "Jim prefers tea to coffee" (unknown to Claude) should be learnable through repeated observation.

---

## 10. Overall Verdict

### Final Assessment

**COMPLIANT WITH CONCERNS**

Epic 10's scope is architecturally sound, philosophically aligned, and Phase 1-appropriate. All five subsystems and five databases are integrated. All six immutable standards are addressed.

**Green lights:**
- No Phase 2 leakage
- No Theater Prohibition violations
- No drive isolation bypass
- Correct five-subsystem integration pattern
- Correct KG architecture
- Proper Lesion Test framing
- Correct Type 1 graduation mechanics

**Yellow flags requiring attention before implementation:**
1. Define "genuine learning" operationally (Jim's call)
2. Specify LLM-disabled mode semantics
3. Expand attractor state tests to list all six cases explicitly
4. Add explicit Guardian Asymmetry validation test
5. Add behavioral personality validation subsection (conversation log analysis)
6. Add drift detection baseline capture
7. Clarify Lesion Test LLM-disabled cost semantics

**Critical path blocker:** Gap 1 ("Genuine Learning" definition) must be resolved by Jim before Epic 10 implementation can begin. This is not an optional clarification -- it's fundamental to Phase 1 completion criteria.

---

## 11. Required Actions Before Jim's Review

1. **Define "Genuine Learning" acceptance criteria** (Jim decides)
   - What constitutes measurable proof?
   - What ratio of prediction-driven edges is sufficient?
   - How will we distinguish learned edges from coincidentally correct LLM-generated edges?

2. **Expand Attractor State Tests section**
   - List all six known attractor states
   - Specify one test case per state
   - Verify prevention mechanisms work

3. **Add LLM-Disabled Mode Specification**
   - When LLM is unavailable, what is the expected behavior?
   - How does cost pressure work in degraded mode?
   - Can incomprehension be reliably distinguished from failure?

4. **Add Guardian Asymmetry Explicit Test**
   - Verify 2x confirmation multiplier
   - Verify 3x correction multiplier
   - Verify schema isolation (corrections don't cascade)

5. **Add Behavioral Personality Validation**
   - Move beyond metrics to actual observed behavior
   - Verify satisfaction habituation in conversation logs
   - Verify anxiety amplification in response patterns
   - Verify social comment quality in guardian interaction timing

6. **Add Drift Detection Baseline Capture**
   - Measure and record five metrics at end of integration test
   - These serve as baseline for future monitoring
   - Document what constitutes healthy vs. concerning trends

---

## 12. Jim's Attention Needed

### Critical Decision Required: Define "Genuine Learning"

The CANON states Phase 1 must prove "the prediction-evaluation loop produces genuine learning" but does not define measurable acceptance criteria.

**Questions for Jim:**
1. What evidence would convince you that learning is prediction-driven, not LLM-regurgitated?
2. What ratio of prediction-driven edges (traced to prediction IDs + failures) is sufficient?
3. Should we require evidence of learning in novel domains (not in Claude's training data)?
4. Should edge utility (successful retrieval and use) be part of the definition, or just edge creation?

**Recommended acceptance framework** (subject to Jim's modification):
- At least 60% of new WKG edges trace to (prediction_id + failure + upsert) events
- At least 50% of edges are (SENSOR + GUARDIAN + INFERENCE), not LLM_GENERATED
- Edges created through prediction failure show >0.50 confidence and >1 successful retrieval before Type 1 graduation
- Conversation logs show Sylphie learning domain-specific facts not obviously in Claude's training data

**Impact:** Until this is defined, Epic 10's "genuine learning" requirement is subjective.

---

### Secondary Clarification: LLM-Disabled Mode

The Lesion Test is well-designed but needs operational clarity.

**Questions for Jim:**
1. When LLM is disabled, should Type 2 error out or degrade gracefully?
2. Should cost pressure continue accumulating, or reset/pause?
3. Should the system attempt to use unavailable LLM (and fail), or skip Type 2 entirely?
4. How will we measure behavioral difference in Lesion Test: response quality? Decision speed? Action diversity?

**Suggested mode:** "LLM-disabled mode: Type 2 calls immediately error; system falls back to Type 1 or Shrug; cost pressure pauses (not accumulated, not reset, just frozen)."

---

## Conclusion

Epic 10 is well-designed and ready for implementation with two qualifications:

1. **Jim must define "genuine learning" operationally** before Epic 10 can produce a final proof
2. **Epic 10 deliverables should be expanded** with the six concerns listed above

The architecture is sound. The philosophy is correctly represented. The phase boundary is respected. The six immutable standards are all addressed. The integration test design is correct.

**Recommendation:** Flag to Jim for decision on genuine learning definition, then proceed with Epic 10 implementation including the concern-driven test expansions.

---

**Verdict Date:** 2026-03-29
**Reviewed By:** Canon, Project Integrity Guardian
**Authority:** CANON document, sections 1-8, and agent profile canon.md

---

## Appendix: Cross-Reference Map

| CANON Principle | Epic 10 Verification | Status |
|---|---|---|
| Experience Shapes Knowledge | Graph growth + provenance ratio | PASS |
| LLM Is Voice | Lesion Test (Type 1 behavior) | PASS with concern |
| WKG Is Brain | Full-loop integration | PASS |
| Dual-Process Cognition | Type 1 graduation test | PASS |
| Guardian as Teacher | Full-loop + asymmetry test | PASS with concern |
| Personality from Contingencies | Attractor state tests + behavioral validation | PASS with concern |
| Prediction Drives Learning | Prediction-evaluation loop + genuine learning proof | PASS with concern |
| Provenance Sacred | Lesion Test filtering + graph inspection | PASS |
| Theater Prohibition | Communication validation + drive state injection | PASS with concern |
| Contingency Requirement | Reinforcement audit | PASS with concern |
| Confidence Ceiling | Type 1 graduation test + ACT-R validation | PASS with concern |
| Shrug Imperative | Full-loop integration | PASS |
| Guardian Asymmetry | Explicit asymmetry test (missing) | PASS with concern |
| No Self-Modification | Drive isolation + PostgreSQL RLS test | PASS with concern |
| Five Subsystems | Full-loop integration | PASS |
| Five Databases | Full-loop integration | PASS |
| KG Isolation | Isolation audit (missing) | PASS with concern |
| Drive Isolation | IPC verification + RLS test | PASS |
| Phase 1 Scope | Full review | PASS |

