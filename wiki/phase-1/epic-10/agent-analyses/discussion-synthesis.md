# Epic 10: Cross-Examination Synthesis
## Integration and End-to-End Verification Planning Discussion

**Date:** 2026-03-29
**Prepared for:** Jim (Guardian Review)
**Agent Panel:** Canon (integrity), Proof (QA), Ashby (systems), Piaget (development), Skinner (behavior), Luria (neurosystems), Forge (architecture)

---

## EXECUTIVE SUMMARY

All seven agents converge on **one critical conclusion:** Epic 10 is architecturally and philosophically sound, but **one material definition gap must be resolved by Jim before implementation can proceed.**

**Status:** READY TO IMPLEMENT with Jim's input on "genuine learning" definition.

**Key findings:**
- All agents agree on the technical approach to integration testing
- All agents identify the same six attractor states as the primary risk surface
- Science agents (Piaget, Skinner, Luria) align with architecture agents (Forge, Ashby, Canon)
- One blocker: Canon flags that "genuine learning" lacks measurable acceptance criteria
- One consistency issue: Agents use different terminology for the same phenomena (cross-referenced below)

---

## 1. POINTS OF AGREEMENT

### 1.1 Core Architecture is Sound

**Unanimous agreement across all agents:**

The five-subsystem integration pattern (Communication → Decision Making → Drive Engine + Learning + Planning) is correct. The data flow through TimescaleDB (events) and WKG (knowledge) is correct. The phase boundary (Phase 1 scope, no hardware) is properly maintained.

- **Canon:** "Architecturally sound, philosophically aligned"
- **Proof:** "Verification strategy for each must-prove item is correct"
- **Ashby:** "Integration testing must be systems-level testing, not component-level"
- **Forge:** "Five subsystems + five databases integration is load-bearing"

**Implementation consequence:** Proceed with the full-loop integration test as specified.

---

### 1.2 The Six Attractor States Are the Primary Risk Surface

**Unanimous agreement:** The six known pathological attractors are the central failure modes to detect and prevent.

| Attractor State | Risk Level | All Agents Agree On Detection | Measurement Priority |
|---|---|---|---|
| Type 2 Addict | HIGH | Type 1/Type 2 ratio metrics | CRITICAL |
| Rule Drift | MEDIUM | Rule provenance audit | CRITICAL |
| Hallucinated Knowledge | MEDIUM | Provenance ratio + confidence ceiling | CRITICAL |
| Depressive Attractor | MEDIUM | Self-KG negativity tracking | IMPORTANT |
| Planning Runaway | LOW-MEDIUM | Opportunity queue depth | IMPORTANT |
| Prediction Pessimist | LOW-MEDIUM | Early-phase error dampening | IMPORTANT |

- **Ashby:** Provides detailed metrics for each attractor (Type 1 retrieval-and-use ratio, rule provenance, LLM_GENERATED confidence distribution, etc.)
- **Luria:** Translates each attractor to neuropsychological equivalent and provides lesion test signatures
- **Skinner:** Frames attractor detection through behavioral measurement (habituation collapse, drive correlation drift, etc.)
- **Forge:** Identifies what monitoring services must be built

**Implementation consequence:** Attractor state detection is non-negotiable in Epic 10 deliverables.

---

### 1.3 Lesion Test Design Is Correct

**Unanimous agreement on three lesion types:**

1. **Lesion 1: Remove LLM** (Luria's analog: prefrontal cortex damage)
   - Expected outcome: Type 1 capability revealed; system falls back to graph-based retrieval
   - Healthy development trajectory: 10-20% Type 1 early → 40-60% by month 2-6 → 70-80%+ by month 6+

2. **Lesion 2: Remove WKG** (Luria's analog: semantic memory loss)
   - Expected outcome: Reasoning degrades; stimulus-bound behavior; loss of generalization
   - Diagnostic value: Proves graph is actually being read, not write-only

3. **Lesion 3: Remove Drive Engine** (Luria's analog: motivational substrate loss)
   - Expected outcome: Behavioral apathy; loss of goal-directed preference; personality flattening
   - Diagnostic value: Proves drives are shaping real behavior, not LLM confabulation

All agents agree on the developmental sequencing and diagnostic failure patterns for each lesion.

**Implementation consequence:** All three lesions are load-bearing. Partial implementation (only one lesion) is insufficient.

---

### 1.4 Type 1/Type 2 Ratio Is the Central Metric

**Unanimous agreement:** The ratio must improve over time (from Type 2-dominated to Type 1-capable) to prove learning is happening.

- **Canon:** "Type 1 graduation test" is required for Phase 1 completion
- **Proof:** 7 separate verification levels for Type 1/Type 2 shift
- **Ashby:** "Type 1 confidence strongly predicts Type 1 win rate" as health metric
- **Piaget:** Rising ratio = internalization (Vygotsky); maturation of behavior
- **Skinner:** Type 1 ratio reflects autonomy from external support
- **Luria:** Type 1 ratio indicates genuine capability vs. delegated thinking
- **Forge:** Ratio must be tracked in real-time events and metrics API

**Implementation consequence:** Type 1/Type 2 decision tracking is non-negotiable in all subsystems.

---

### 1.5 Guardian Feedback Must Be Explicitly Validated

**Unanimous agreement:** The 2x/3x confidence multipliers and guardian asymmetry must be tested explicitly.

Current Epic 10 specification addresses this in concept but does not list explicit test cases. All agents recommend adding:

```
Test: Guardian Asymmetry Validation
1. Create edge: (Person_Jim, LIKES, coffee) @ confidence 0.50
2. Guardian confirms → verify confidence increases by 2x base amount
3. Create edge: (Person_Jim, DISLIKES, tea) @ confidence 0.50
4. Guardian corrects → verify confidence decreases by 3x base amount
5. Verify: schema isolation (correction doesn't cascade to other schemas)
```

**Implementation consequence:** This test must be explicitly added to Epic 10.

---

### 1.6 Provenance Tracking Enables Everything

**Unanimous agreement:** Provenance tags (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE) are not documentation—they are structural.

- **Canon:** "Provenance is sacred; enables Lesion Test"
- **Proof:** Provenance ratio is the primary metric for "genuine learning"
- **Piaget:** Experiential provenance ratio tracks knowledge construction
- **Luria:** Provenance distinguishes hallucinated from learned knowledge
- **Ashby:** Provenance composition reveals which attractor state the system is approaching

Without provenance, no lesion test validity, no attractor detection, no learning proof.

**Implementation consequence:** Verify provenance enforcement in Knowledge Module (E3) before Epic 10 starts.

---

### 1.7 Full-Loop Integration Pattern Is Correct

**Unanimous agreement on the end-to-end flow:**

```
Cold start → Guardian input → Communication parses →
Decision Making predicts → Execute action →
Drive Engine evaluates + detects opportunities →
Learning extracts entities → WKG grows →
Next decision retrieves from WKG → Type 1 candidate competes with Type 2 →
Ratio improves
```

All agents verify this pattern at different levels of analysis, and all agree it's load-bearing.

**Implementation consequence:** Full-loop test must complete this entire flow in a single test run.

---

## 2. POINTS OF TENSION

### 2.1 "Genuine Learning" Definition Gap (HIGHEST PRIORITY)

**Canon's concern (HIGH SEVERITY):**
The CANON requires Phase 1 to prove "prediction-evaluation loop produces genuine learning" but does not operationally define what evidence satisfies this.

**The tension:** Different agents interpret "genuine learning" differently:

- **Proof:** Defines it as prediction error → confidence update → MAE improvement trajectory
- **Piaget:** Defines it as knowledge construction (assimilation/accommodation balance) with rising provenance ratio
- **Luria:** Defines it as semantic memory that enables reasoning independent of LLM
- **Canon:** Acknowledges the ambiguity and flags it as a blocker

**Surface manifestation of the tension:**

```
Proof says: "MAE should drop from ~0.5 to ~0.2 within 20-30 sessions"
Piaget says: "Experiential provenance ratio should rise to >0.6 by session 30"
Luria says: "Lesion Test (WKG removal) should degrade behavior by ~40-60%"
Canon says: "All of the above are necessary but are they sufficient?"
```

**Where agents align:** All agree that provenance + MAE improvement + Lesion Test results (together) constitute the proof. But none explicitly define the minimum threshold.

**What Jim must decide:**

Operational definition. Suggest framework (subject to Jim's revision):

```
Genuine Learning Proof Requirements (ALL must be met):
1. Prediction-driven edges: >=60% of new WKG edges trace to (prediction_id + failure + upsert) events
2. Provenance ratio: >=50% of edges are (SENSOR + GUARDIAN + INFERENCE), not LLM_GENERATED
3. Edge utility: Edges created via prediction failure show >0.50 confidence and >1 successful retrieval
4. Behavioral validation: Lesion Test (remove WKG) causes >40% degradation in reasoning tasks
5. Domain specificity: Conversation logs show learning of facts not obviously in Claude's training data
```

**Implementation consequence:** BLOCKER. Define before Epic 10 implementation.

---

### 2.2 LLM-Disabled Mode Semantics (MEDIUM PRIORITY)

**Canon's concern (MEDIUM SEVERITY):**
The Lesion Test framework is correct but underspecified. When LLM is disabled, what happens to Type 2?

**Different agent interpretations:**

- **Proof:** Type 2 calls error immediately; system falls back to Type 1 or Shrug
- **Luria:** Type 2 latency becomes infinite; cost pressure question: does it pause, reset, or accumulate?
- **Forge:** Requires DI pattern that substitutes a mock LLM that errors immediately
- **Ashby:** Wants to measure behavioral difference: does response quality drop? Decision speed change? Action diversity shift?

**The tension:**
- If cost pressure accumulates during LLM-disabled mode → test may be measuring cost effects, not capability
- If cost pressure resets → system gets artificial relief, doesn't reflect real operation
- If cost pressure pauses → need to define what "paused" means

**Where agents align:** All agree the semantics must be specified before running the test. The test design depends on it.

**What Jim must decide:**

LLM-disabled mode specification:

```
Suggested mode:
- Type 2 calls: error immediately with specific error code
- Error handling: caught by Decision Making, triggers fallback-to-Type-1 logic
- Cost pressure: pauses (not accumulated, not reset, frozen at current value)
- Incomprehension detection: Shrug Imperative activates if no Type 1 candidate meets threshold
- Duration: single session or multiple sessions?
- Measurement: compare (response quality, decision latency, action diversity) between normal and disabled modes
```

**Implementation consequence:** Define before running Lesion Test. Affects test interpretation.

---

### 2.3 Behavioral Validation Missing From Epic 10 Specification (MEDIUM PRIORITY)

**Canon's concern (MEDIUM SEVERITY):**
Epic 10 specifies metrics (Type 1 ratio, MAE, provenance) but does not require behavioral analysis of conversation logs.

**Different agent emphasis:**

- **Piaget:** "Developmental personality should be observable in behavioral patterns"
- **Skinner:** "Five contingencies operating simultaneously should produce recognizable personality"
- **Luria:** "Drive-mediated personality should be observable; apathy when drives removed"
- **Canon:** "Personality emerges from contingencies" requires behavioral validation, not just metrics

**The tension:**
Metrics can be gamed or misleading. A system can show correct drive values without actual personality emergence. Only behavioral analysis (reading conversation logs, observing action sequences) proves personality is real.

**Where agents align:** All recommend adding a subsection to Epic 10:

```
Behavioral Personality Validation (Conversation Log Analysis):
1. Run 30-message conversation with guardian repeating same topic
2. Analyze satisfaction habituation: does Sylphie avoid repeating successful responses?
3. Run conversation with high anxiety (custom drive state injection)
4. Analyze anxiety amplification: are responses more cautious?
5. Analyze social comment quality: does Sylphie favor topics guardian responds to quickly?
6. Compare logs across multiple runs: are personality patterns stable?
7. Verify: personality is correlated with actual drive state, not independent of it
```

**What Jim must decide:**

Is behavioral personality validation required for Phase 1 completion, or is it "nice to have"?

**Implementation consequence:** If required, add 2-3 test cases to Epic 10 (moderate complexity).

---

### 2.4 Test Coverage for All 6 Attractor States (LOW PRIORITY)

**Canon's concern (LOW SEVERITY):**
Epic 10 says "attractor state tests: verify prevention for all 6 known states" but does not list explicit test cases for each.

**Agent elaboration level:**

- **Ashby:** Provides detailed metrics for each (highest detail)
- **Luria:** Provides neuropsychological equivalent and lesion test signature for each
- **Forge:** Identifies what services must be built to monitor each
- **Proof:** Mentions them but less detail than Ashby/Luria

**Where agents align:** All recommend expanding Epic 10 to list one explicit test per attractor state.

**Implementation consequence:** Moderate expansion (6 test cases, each straightforward).

---

### 2.5 Terminology Alignment (LOW PRIORITY)

**Observation:** Different agents use different terminology for the same concepts. This is not a conflict, just a note for implementation.

| Concept | Canon | Proof | Piaget | Skinner | Luria | Ashby | Forge |
|---|---|---|---|---|---|---|---|
| Type 1 excellence | Type 1 graduation | Confident autonomous action | Internalization | Automatized behavior | Habit system | Reflex action | Graph-based decision |
| Prediction error → learning | Prediction-evaluation loop | High-error prediction triggers Learning | Disequilibration | Stimulus-response mismatch | Forward model error | Negative feedback correction | Outcome comparison event |
| Personality from rules | Contingency structure | Reinforcement history | Behavioral shaping | Behavioral profile | Valuation system | Attractor basin | Drive-mediated action |

**Implementation consequence:** Use Canon's terminology in Epic 10 implementation (it's the official language).

---

## 3. CANON'S SPECIFIC CONCERNS AND HOW OTHER AGENTS ADDRESS THEM

### Concern 1: "Genuine Learning" Definition Gap

**Canon flagged:** CRITICAL blocker. CANON does not define measurable acceptance criteria.

**How other agents address it:**

- **Proof:** Provides three-level verification framework (event integrity, confidence updates, learning pipeline integration) with concrete SQL queries
- **Piaget:** Provides five tests (provenance archaeology, Lesion Test, contradiction handling, entity entropy, behavioral prediction)
- **Luria:** Provides diagnostic failure patterns that distinguish hallucinated knowledge from learned knowledge
- **Ashby:** Provides "knowledge retrieval-and-use ratio" as proxy metric (>40% of mature knowledge has non-zero retrieval count = healthy)

**Agents' consensus suggestion to Jim:**
Combine all approaches: provenance ratio + MAE trajectory + Lesion Test + behavioral validation. All four together constitute proof.

---

### Concern 2: Lesion Test LLM-Disabled Semantics

**Canon flagged:** MEDIUM blocker. Test design depends on cost pressure semantics.

**How other agents address it:**

- **Luria:** Provides complete developmental trajectory (10-20% Type 1 early → 70-80% by month 6) as baseline for interpreting LLM-disabled performance
- **Ashby:** Provides "Type 2 cost structure effectiveness" metrics (latency distribution, cognitive burden, compute budget) to validate cost is real
- **Forge:** Provides DI pattern for LLM substitution (mock that errors immediately)

**Agents' consensus suggestion to Jim:**
Semantic choice is Jim's call. Proposed: "Type 2 cost pressure pauses (frozen) during LLM-disabled mode" because:
- It preserves the distinction between "cost is preventing use" vs. "system is incapable"
- It avoids artificial relief (reset) or punishment (accumulation)
- It allows accurate measurement of Type 1 capability

---

### Concern 3: Attractor State Test Coverage Incomplete

**Canon flagged:** MEDIUM. Coverage statement is correct but not detailed.

**How other agents address it:**

- **Ashby:** Provides 4 detailed metrics per attractor state (e.g., for Type 2 Addict: Type 1/Type 2 ratio, retrieval-and-use ratio, Type 2 cost effectiveness, confidence threshold analysis)
- **Luria:** Provides lesion test signature for each (e.g., for Type 2 Addict: LLM removal causes catastrophic failure)
- **Skinner:** Provides behavioral measurement framework for each

**Agents' consensus:** Epic 10 should list all six states explicitly with one test case per state (straightforward expansion).

---

### Concern 4: Guardian Asymmetry Explicit Validation Missing

**Canon flagged:** MEDIUM. Epic covers the concept but lacks explicit test.

**How other agents address it:**

- **Proof:** Provides concrete SQL query for confidence updates verification
- **Skinner:** Provides behavioral contingency test: measure drive state changes after guardian confirmation vs. correction
- **Ashby:** Provides "Guardian response rate" as health metric (should track when guardian provides feedback, system should improve)

**Agents' consensus:** Add explicit test case (5-10 lines, concrete scenario provided in Canon's concern section).

---

### Concern 5: Behavioral Personality Validation Missing

**Canon flagged:** MEDIUM. Personality metrics don't guarantee personality emergence.

**How other agents address it:**

- **Piaget:** Provides "Behavioral Prediction" test (classifier on subgraph predicts action selection)
- **Skinner:** Provides detailed "emergent pattern verification" protocol (behavioral portfolio analysis, habituation pattern, anxiety-behavior correlation, guilt repair tracking, social comment evolution, curiosity exploration)
- **Luria:** Notes "behavioral flattening" as diagnostic failure pattern (personality vanishes when drives removed = personality was LLM confabulation)

**Agents' consensus:** Add subsection to Epic 10 with 5-6 conversation log analysis tests (moderate additional effort).

---

### Concern 6: Drift Detection Baseline Incomplete

**Canon flagged:** LOW-MEDIUM. Coverage statement is correct but not detailed.

**How other agents address it:**

- **Ashby:** Provides "cumulative rule drift score" metric (L2 distance from baseline rules)
- **Luria:** Provides "drive distribution at stable state" as baseline (mean drive values should be stable after session 20)
- **Skinner:** Provides "behavioral portfolio analysis" over rolling windows

**Agents' consensus:** Straightforward to add. Epic 10 should snapshot these metrics at end of integration test.

---

## 4. SCIENCE VS. TECHNICAL TRADEOFFS

### Tradeoff 1: Provenance Tracking Cost vs. Learning Proof Value

**Science requirement (Piaget, Luria, Ashby):** Every node and edge must carry full provenance (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE).

**Technical cost (Forge):** Requires updating Knowledge Module (E3) to tag every write.

**Resolution:** Forge confirms this is already required by Epic 3 (Knowledge Module), so no additional cost. Verification: Proof's E3 review confirms provenance enforcement is in place.

**Implementation consequence:** No tradeoff. Proceed.

---

### Tradeoff 2: Lesion Test Complexity vs. Reliability Gain

**Science requirement (Luria, Piaget, Ashby):** Three separate lesion types, each with multiple diagnostic failure patterns.

**Technical cost (Forge):** Requires:
- DI pattern for LLM substitution (moderate)
- WKG fallback strategy (moderate)
- Drive Engine mock (moderate)
- Test orchestration harness (complex)

**Resolution:** Forge proposes modular lesion modes (lesion-modes/ directory with separate strategies). Can be built incrementally (Phase 1: just LLM lesion, Phase 2: add WKG and Drive Engine lesions).

**Implementation consequence:**
- **Phase 1 requirement:** LLM lesion (CRITICAL for Type 1/Type 2 proof)
- **Post-Phase 1:** WKG and Drive Engine lesions (important but lower priority)

Suggest Jim approves LLM lesion as Phase 1 requirement, defer others if timeline is tight.

---

### Tradeoff 3: Real-Time Metrics Computation vs. Monitoring Overhead

**Science requirement (Ashby, Proof, Piaget, Skinner, Luria):** Track 7+ health metrics continuously (Type 1/Type 2 ratio, MAE, provenance ratio, rule drift, attractor proximity, behavioral diversity, etc.).

**Technical cost (Forge):** Requires:
- Metrics computation service (periodic aggregation, complex queries)
- Real-time dashboard or API endpoint
- Attention to database performance (large TimescaleDB queries)

**Resolution:** Forge proposes lazy computation (metrics computed on demand, cached, invalidated at fixed intervals). Can start with batch metrics (computed every N events), upgrade to real-time later.

**Implementation consequence:**
- **Phase 1:** Batch metrics (computed end-of-session) sufficient
- **Later:** Real-time streaming if needed for monitoring

---

### Tradeoff 4: Behavioral Analysis Rigor vs. Test Automation

**Science requirement (Piaget, Skinner, Luria):** Conversation log analysis requires human judgment (is personality actually observable?) alongside metrics.

**Technical cost:** Manual review time, not easily automated.

**Resolution:** Piaget suggests two approaches:
1. **Automated-first:** Behavioral portfolio analysis, habituation pattern detection, anxiety-behavior correlation (all computable from TimescaleDB events)
2. **Human-in-the-loop:** Guardian reads sample conversation logs, scores personality emergence on rubric

**Implementation consequence:**
- Start with automated metrics (no additional cost)
- Add human-review section to Epic 10 deliverables (moderate additional effort, critical for final verdict)

---

### Tradeoff 5: Type 2 Cost Magnitude vs. Type 1 Evolutionary Pressure

**Science requirement (Skinner, Ashby):** Type 2 must carry explicit cost (latency, cognitive effort drive pressure) to create evolutionary pressure toward Type 1.

**Technical cost (Forge):** Requires accurate latency measurement and drive integration.

**Resolution:** Ashby provides detection metric: "If Type 2 latency is <100ms (cost is negligible), system is losing the cost-based evolutionary pressure toward Type 1." This is testable and actionable.

**Implementation consequence:** Epic 10 should include a test: measure Type 2 latency distribution; if median <100ms, raise flag. This is low-cost validation.

---

## 5. KEY DESIGN DECISIONS BASED ON CROSS-EXAMINATION

### Decision 1: Provenance Is Non-Negotiable

**Source:** All agents agree.

**What it means:** Every single write to the WKG must be tagged with provenance. No exceptions.

**Verification in Epic 10:** Audit Knowledge Module (E3) to confirm enforcement at write time.

**How it's used:**
- Lesion Test filters to SENSOR + GUARDIAN + INFERENCE only
- Provenance ratio metric identifies hallucinated knowledge
- Learning subsystem traces edges back to originating events

---

### Decision 2: Type 1/Type 2 Ratio Is the Central Performance Metric

**Source:** Unanimous agreement across all agents (Canon, Proof, Ashby, Piaget, Skinner, Luria, Forge).

**What it means:**
- Every decision event must record whether it was Type 1 (graph-based) or Type 2 (LLM-assisted)
- Healthy Phase 1 shows monotonic increase in Type 1 ratio (from ~10% early to ~70-80% by month 6)
- Type 1 ratio plateauing at <30% after month 2 is a RED FLAG

**Verification in Epic 10:**
- Metrics API exposes Type 1/Type 2 ratio over time
- Full-loop test verifies ratio improves as guardian interactions repeat
- Lesion Test (remove LLM) verifies Type 1 capability exists

---

### Decision 3: Attractor State Detection Is Part of Integration Testing

**Source:** Ashby, Luria, Piaget, Proof all emphasize.

**What it means:**
Epic 10 must explicitly test that all six known pathological attractors are NOT happening:

1. Type 2 Addict — LLM dominates, Type 1 never graduates (detect: ratio <20% after month 2)
2. Rule Drift — Rules gradually diverge from design (detect: cumulative drift score growing >0.1/session)
3. Hallucinated Knowledge — False LLM-generated edges persist (detect: LLM_GENERATED >50% of graph)
4. Depressive Attractor — Negative self-model feedback loop (detect: KG(Self) has sustained negative evaluations)
5. Planning Runaway — Too many opportunities, resource exhaustion (detect: opportunity queue depth growing)
6. Prediction Pessimist — Early failures overwhelm system (detect: MAE >0.20 after month 2, Opportunity generation >10x execution)

**Verification in Epic 10:**
- Each attractor has 3-5 specific metrics
- Healthy development shows all metrics in healthy range
- Any metric in warning range triggers detailed investigation

---

### Decision 4: Guardian Asymmetry Must Be Explicitly Tested

**Source:** Canon flagged, all agents emphasize, especially Proof and Skinner.

**What it means:**
- Guardian confirmation: confidence increases by 2x base amount (not 1x)
- Guardian correction: confidence decreases by 3x base amount (not 1x)
- Corrections are local to the specific edge/schema, not cascading

**Verification in Epic 10:**
Add explicit test case (Canon provides concrete scenario).

---

### Decision 5: Lesion Test Is Phase 1 Completion Requirement

**Source:** Luria, Piaget, Canon all emphasize.

**What it means:**
At minimum, LLM Lesion Test must be implemented and pass:
- Remove LLM access
- System falls back to Type 1
- Behavior degrades gracefully (not catastrophically)
- Type 1 capability is revealed

**Phase 1 minimum:** LLM lesion only (most critical).
**Nice-to-have for Phase 1:** WKG and Drive Engine lesions (important for full picture, can defer if timeline tight).

**Verification in Epic 10:**
- Lesion test passes with healthy developmental trajectory
- Lesion Test fails = attractor state detected = must investigate

---

### Decision 6: Behavioral Validation Complements Metrics

**Source:** Piaget, Skinner, Luria all emphasize.

**What it means:**
Metrics (Type 1 ratio, MAE, provenance) are necessary but not sufficient. Must also observe actual behavior in conversation logs.

**Examples of behavioral validation:**
- Satisfaction habituation: does system actually avoid repeating successful responses?
- Anxiety amplification: do high-anxiety responses actually show caution?
- Social comment quality: does system actually learn to produce response-eliciting comments?
- Guilt repair: does system actually chain acknowledgment to behavioral change?

**Verification in Epic 10:**
Add 5-6 conversation log analysis test cases alongside metrics tests.

---

## 6. UNRESOLVED ISSUES FOR JIM

### Issue 1: Define "Genuine Learning" (CRITICAL BLOCKER)

**What needs to be decided:** Operational acceptance criteria for Phase 1's core claim: "the prediction-evaluation loop produces genuine learning."

**Suggested framework (subject to Jim's revision):**

All of the following must be met:
1. **Prediction-driven edges:** >=60% of new WKG edges trace to (prediction_id + failure + upsert) events
2. **Provenance ratio:** >=50% of edges are (SENSOR + GUARDIAN + INFERENCE), not LLM_GENERATED
3. **Edge utility:** Edges created via prediction failure show >0.50 confidence and >1 successful retrieval
4. **Lesion Test validation:** WKG Lesion test causes >40% degradation in reasoning tasks
5. **Domain specificity:** Conversation logs demonstrate learning of facts not obviously in Claude's training data (optional but recommended)

**Impact:** Blocks Epic 10 implementation.

---

### Issue 2: Specify LLM-Disabled Mode Semantics (MEDIUM PRIORITY)

**What needs to be decided:** When LLM is disabled in Lesion Test, what happens to Type 2 cost pressure?

**Option A (Suggested):** Cost pressure pauses (frozen at current value)
- Pro: Preserves distinction between "cost prevents use" vs. "system incapable"
- Pro: Avoids artificial relief or punishment
- Con: Requires careful semantics documentation

**Option B (Alternative):** Cost pressure resets to zero
- Pro: System gets "fresh start" without cost burden
- Con: May overestimate actual Type 1 capability

**Option C (Alternative):** Cost pressure accumulates normally
- Pro: Matches real-world operation (cost doesn't pause)
- Con: Test results ambiguous (is system failing due to cost or incapability?)

**Impact:** Affects test validity and interpretation.

---

### Issue 3: Is Behavioral Personality Validation Required for Phase 1? (MEDIUM PRIORITY)

**What needs to be decided:** Must Epic 10 include conversation log analysis to verify personality emergence, or is metrics validation sufficient?

**Option A (Suggested):** Yes, include behavioral validation
- Pro: Proves personality is real, not just metric artifacts
- Con: Moderate additional effort, requires human judgment

**Option B (Alternative):** No, metrics sufficient
- Pro: Fully automated
- Con: May miss important failure modes (personality could be theater)

**Impact:** Affects Epic 10 scope and effort estimate.

---

### Issue 4: Are WKG and Drive Engine Lesions Required for Phase 1? (LOW-MEDIUM PRIORITY)

**What needs to be decided:** Minimum viable testing for Phase 1 completion.

**Option A (Suggested for Jim's consideration):**
- **Required:** LLM Lesion (proves Type 1 capability exists)
- **Recommended:** WKG Lesion (proves graph is being read, not just written)
- **Optional:** Drive Engine Lesion (nice to confirm drives shape behavior, can defer)

**Impact:** Affects Epic 10 scope. LLM lesion is CRITICAL. Others scale with available time.

---

### Issue 5: Baseline for "Genuine Learning" Metrics (MEDIUM PRIORITY)

**What needs to be decided:** What specific numbers constitute success?

**Examples from agent analyses:**

| Metric | Suggested Threshold | Source |
|---|---|---|
| Type 1/Type 2 ratio by month 2-6 | >=40% Type 1 | Luria, Ashby |
| Prediction MAE by month 2 | <0.20 (from ~0.50) | Proof, Piaget |
| Experiential provenance ratio by month 1-30 | 0→0.3→0.6 trajectory | Piaget, Ashby |
| Knowledge retrieval-and-use ratio (mature entities) | >40% with non-zero retrieval count | Ashby |
| Behavioral diversity per 20-action window | 4-8 unique action types | Skinner, Luria |
| Rule drift cumulative score | <0.1 per session | Ashby |

**Impact:** Without specific thresholds, "healthy" vs. "concerning" is ambiguous.

---

## 7. RECOMMENDED TICKET STRUCTURE

### Epic 10 Ticket Breakdown (Based on Agent Consensus)

**Total estimated effort:** 5-8 weeks for full implementation (moderate complexity, high integration testing rigor).

#### **Tier 1: Core Integration (Weeks 1-2)**

**T10.1: Full-Loop Integration Test Harness**
- Create TestEnvironment service
- Bootstrap all 5 subsystems + 5 databases
- Implement test fixtures (database snapshots, drive state setup, event injection)
- Output: End-to-end test passes with clean startup/teardown
- Acceptance: Cold start → guardian input → decision → response → learning cycle completes

**T10.2: Decision Path Instrumentation**
- Verify every decision records Type 1/Type 2 winner, confidence, latency, dynamic threshold
- Verify every prediction has matching outcome event
- Verify confidence updates via ACT-R formula after outcome
- Output: Metrics API endpoint returning decision telemetry
- Acceptance: SQL queries for decision tracing return expected results

**T10.3: TimescaleDB Event Verification**
- Verify all 5 subsystems write to TimescaleDB with correlation IDs
- Verify event schema consistency
- Implement event querying for test validation
- Output: Event verification scripts for integration test
- Acceptance: Event traces are queryable and complete

---

#### **Tier 2: Core Metrics (Weeks 2-3)**

**T10.4: Type 1/Type 2 Ratio Metrics**
- Compute Type 1/Type 2 ratio over rolling windows (per-session, per-20-decision)
- Track Type 1 confidence and latency vs. Type 2 latency and cost pressure
- Verify ratio improves monotonically over time (or detects plateauing as red flag)
- Output: Metrics dashboard endpoint showing ratio trajectory
- Acceptance: Ratio improves from ~10% Type 1 (early) to ~40%+ (after 20+ decisions)

**T10.5: Prediction Accuracy Metrics (MAE)**
- Compute Mean Absolute Error of predictions across rolling windows
- Track per-session and cumulative MAE
- Verify downward trend (from ~0.5 to ~0.2 over 30 sessions)
- Output: MAE trending API
- Acceptance: MAE trajectory matches healthy development baseline

**T10.6: Provenance Ratio Metrics**
- Compute (SENSOR + GUARDIAN + INFERENCE) / total for all edges
- Track ratio over time
- Detect LLM_GENERATED dominance as warning
- Output: Provenance composition API
- Acceptance: Ratio rises from 0 (cold start) to 0.5+ (by session 30)

---

#### **Tier 3: Attractor State Detection (Weeks 3-4)**

**T10.7: Type 2 Addict Detection**
- Monitor Type 1/Type 2 ratio, knowledge retrieval-and-use ratio, Type 2 cost structure, confidence threshold
- Flag if Type 1 ratio plateaus <20% after month 2
- Output: Attractor detection alert service
- Acceptance: Test scenario confirms early detection of Type 2 Addict conditions

**T10.8: Rule Drift Detection**
- Snapshot baseline rules at epic-10 start
- Compute L2 distance from baseline each session
- Track rule provenance (GUARDIAN vs. system-generated)
- Flag if drift >0.3 cumulative or >0.1 per session
- Output: Rule drift monitoring service
- Acceptance: Baseline snapshot and drift alerts working

**T10.9: Hallucinated Knowledge Detection**
- Monitor LLM_GENERATED node confidence distribution
- Flag if LLM_GENERATED >50% of graph
- Verify low-confidence nodes are properly tagged
- Output: Hallucination detection alerts
- Acceptance: Test catches planted false high-confidence nodes

**T10.10: Remaining Attractor Detection (Depressive, Planning, Prediction Pessimist)**
- Implement detection for remaining 3 attractors (moderate complexity)
- Output: Complete attractor state monitoring
- Acceptance: All 6 attractor states have detection metrics

---

#### **Tier 4: Lesion Testing (Weeks 4-5)**

**T10.11: LLM Lesion Test (CRITICAL for Phase 1)**
- Create mock LLM that errors immediately
- DI pattern for LLM substitution
- Run full-loop test without LLM access
- Verify Type 1 behavior emerges gracefully
- Document failure modes (Type 2 Addict, behavioral flattening, etc.)
- Output: LLM Lesion test harness + results
- Acceptance: Type 1 capability verified; system degrades gracefully without LLM

**T10.12: WKG Lesion Test (Recommended)**
- Create WKG fallback (empty graph mode)
- Run full-loop test without WKG access
- Verify system degrades appropriately
- Output: WKG Lesion test harness + results
- Acceptance: >40% behavioral degradation observed (expected for healthy system)

**T10.13: Drive Engine Lesion Test (Optional/Nice-to-have)**
- Create Drive Engine mock (all drives = 0)
- Run full-loop test without drives
- Verify personality flattens (behavioral diversity drops >20%)
- Output: Drive Engine Lesion test harness + results
- Acceptance: Behavioral flattening confirmed when drives disabled

---

#### **Tier 5: Guardian Asymmetry & Behavioral Tests (Weeks 5-6)**

**T10.14: Guardian Asymmetry Validation**
- Test case: create edge, guardian confirms, verify 2x multiplier
- Test case: create edge, guardian corrects, verify 3x multiplier
- Test case: verify schema isolation (correction doesn't cascade)
- Output: Guardian asymmetry test cases
- Acceptance: All three test cases pass with expected multipliers

**T10.15: Behavioral Personality Validation**
- Run 30-message conversation with repeated topics, analyze satisfaction habituation
- Run conversation with high anxiety, analyze cautious response patterns
- Analyze social comment quality (does system learn response-eliciting types?)
- Analyze guilt repair chaining (acknowledgment + behavioral change)
- Analyze curiosity-driven exploration (preferential targeting of high-information-gain)
- Output: Behavioral analysis test cases + conversation log samples
- Acceptance: 5+ behavioral patterns observable in logs, correlated with drive state

---

#### **Tier 6: Drift Detection & Final Validation (Weeks 6-8)**

**T10.16: Drift Detection Baseline**
- Capture baseline snapshots of 5 drift metrics at epic-10 end:
  1. Cumulative record slope (learning productivity over time)
  2. Behavioral diversity trend
  3. Prediction accuracy trend
  4. Guardian interaction quality
  5. Sustained drive patterns
- Output: Baseline snapshot stored for future monitoring
- Acceptance: All 5 metrics captured and documented

**T10.17: Final Integration Validation**
- Run full-loop integration test with all subsystems (no lesions)
- Verify complete flow: input → decision → drive update → learning → growth
- Document conversation samples showing emergent behavior
- Run metrics suite and verify all in healthy ranges
- Output: Final integration test report
- Acceptance: Full-loop test completes cleanly; all metrics pass healthy thresholds

**T10.18: Documentation & Session Log**
- Write Epic 10 session log (20 lines, as per CANON)
- Document known issues and gotchas for next session
- Create Epic 10 completion checklist
- Output: Session log + completion documentation
- Acceptance: All findings documented; no unresolved blockers

---

### Effort Estimates by Tier

| Tier | Tickets | Effort | Dependencies |
|---|---|---|---|
| Core Integration | T10.1-T10.3 | 2 weeks | None (blockers: E0-E4 must be complete) |
| Core Metrics | T10.4-T10.6 | 1-2 weeks | T10.1-T10.3 (E5, E6, E7 complete) |
| Attractor Detection | T10.7-T10.10 | 1-2 weeks | T10.4-T10.6 (E4 Drive Engine complete) |
| Lesion Testing | T10.11-T10.13 | 1-2 weeks | T10.1 (DI pattern for substitution) |
| Guardian + Behavioral | T10.14-T10.15 | 1-2 weeks | T10.1 (full-loop working) |
| Drift Baseline + Final | T10.16-T10.18 | 1-2 weeks | All above |
| **TOTAL** | **18 tickets** | **5-8 weeks** | **E0-E9 complete** |

---

### Recommended Implementation Order

1. **Start with Tier 1** (integration harness + instrumentation) — unblocks everything else
2. **Parallel: Tier 2** (core metrics) while Tier 1 finalizes — moderate dependencies
3. **Parallel: Tier 4 (LLM Lesion)** — critical for Phase 1 proof, moderate effort
4. **Then Tier 3** (attractor detection) — depends on Tier 2 metrics
5. **Then Tier 5** (guardian asymmetry + behavioral) — depends on Tier 1
6. **Last: Tier 6** (drift baseline + final validation) — summarizes everything

---

## 8. CROSS-AGENT VALIDATION SUMMARY

### Where All 7 Agents Agree (No Ambiguity)

- **Architecture is sound** — Five subsystems, five databases, proper phase boundary
- **Lesion Test design is correct** — Three types (LLM, WKG, Drive Engine), proper diagnostics
- **Type 1/Type 2 ratio is central metric** — Must improve over time
- **Provenance is structural, not optional** — Enables everything
- **Guardian asymmetry must be tested** — 2x/3x multipliers explicit
- **Six attractor states are the risk surface** — All have detection metrics
- **Full-loop integration is the right approach** — All five subsystems must integrate

### Where Agents Disagree or Have Gaps (Need Jim's Decision)

- **"Genuine Learning" definition** — Different agents emphasize different aspects; Canon flags as blocker
- **LLM-disabled cost pressure semantics** — Different plausible interpretations
- **Behavioral validation requirement** — All recommend it, but is it required for Phase 1?
- **Minimum lesion set** — LLM is critical; others debatable depending on timeline

### Consistency of Evidence

**Across all agent analyses, the same concepts appear repeatedly from different angles:**

- **Type 1/Type 2 ratio** mentioned by: Canon, Proof (7 levels), Ashby, Piaget, Skinner, Luria, Forge
- **Provenance tracking** mentioned by: Canon, Proof, Piaget, Luria, Ashby, Forge
- **Attractor state detection** mentioned by: Canon, Proof, Ashby, Luria, Forge
- **Guardian asymmetry** mentioned by: Canon, Proof, Skinner, Ashby
- **Behavioral validation** mentioned by: Canon, Piaget, Skinner, Luria

This high consistency across different agent disciplines (systems theory, developmental psychology, behavioral science, neurosystems, architecture) suggests the analysis is robust.

---

## 9. FINAL RECOMMENDATIONS TO JIM

### Immediate Actions (Before Epic 10 Implementation)

1. **Define "Genuine Learning" acceptance criteria** (1-2 day review)
   - Use suggested framework or provide your own
   - Answer: provenance ratio + MAE improvement + Lesion Test results + behavioral validation?
   - Impact: BLOCKS implementation

2. **Specify LLM-Disabled Mode Semantics** (1-2 hour decision)
   - Suggested: cost pressure pauses
   - Impact: Affects Lesion Test interpretation

3. **Decide on Behavioral Validation Requirement** (1 hour decision)
   - Included in Phase 1 Epic 10, or deferred to Phase 2?
   - Impact: Affects Epic 10 scope

4. **Decide on Lesion Set Scope** (1 hour decision)
   - Minimum: LLM Lesion (critical)
   - Recommended: LLM + WKG Lesions
   - Optional: All three (WKG + Drive Engine)
   - Impact: Affects effort estimate

---

### Implementation Approach (After Jim's Decisions)

1. **Start with Tier 1-2** (integration test harness + core metrics) — foundational
2. **Parallel: LLM Lesion** (T10.11) — critical for Phase 1 proof
3. **Iteratively add tiers** as time permits, prioritizing attractor detection over behavioral validation if timeline is tight
4. **Write session log at end** (T10.18) — document all findings

---

### Risk Mitigation

**Highest risk:** Jim's decisions on "genuine learning" definition and behavioral validation scope. Clarifying these early (before Epic 10 starts) prevents scope creep and rework.

**Technical risks (Forge flags):**
- Database state management in tests (multiple lesion modes need isolated snapshots)
- Startup ordering (all 5 subsystems must initialize cleanly)
- Drive Engine process isolation (ensure IPC doesn't break during tests)

All technical risks are manageable; agent analyses provide clear implementation patterns.

---

## CONCLUSION

Epic 10 is well-designed and ready for implementation **with Jim's input on the three decision points above.**

All seven agents converge on the same architectural approach, the same risk surface (six attractors), and the same core metrics (Type 1/Type 2 ratio, MAE, provenance ratio). The science agents (Piaget, Skinner, Luria) and technical agents (Forge, Ashby, Canon) are aligned. Proof's verification strategy provides concrete, testable mechanisms for each Phase 1 "must prove" requirement.

**The recommended ticket structure balances Phase 1 completion requirements with implementation complexity, prioritizing LLM Lesion, Type 1/Type 2 metrics, and attractor state detection as load-bearing, with behavioral validation and additional lesions scaling with available timeline.**

**Status for Jim's review:** READY TO PROCEED with Jim's three clarifications.

---

**Prepared by:** Discussion Synthesis Agent (cross-examination coordinator)
**Date:** 2026-03-29
**For:** Jim, Guardian and Architectural Authority

