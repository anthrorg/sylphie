# CANON Compliance Analysis: Epic 8 -- Planning (Opportunity-to-Procedure Pipeline)

**Reviewed:** 2026-03-29
**Project Phase:** Phase 1 -- The Complete System
**Reviewer:** Canon (Project Integrity Guardian)
**Document Status:** IMMUTABLE

---

## Overall Verdict: **COMPLIANT WITH CONCERNS**

Epic 8 (Planning subsystem) is architecturally sound and aligned with the CANON's core philosophy, five-subsystem model, and Six Immutable Standards. However, four specific areas require explicit handling before implementation begins to prevent subtle violation risks that could emerge during coding.

---

## 1. Core Philosophy Alignment

### 1.1 Experience Shapes Knowledge

**Status: PASS**

**Evidence:**
- CANON: WKG grows from direct experience, not pre-population.
- E8 Planner Profile (Section 3.2): "Research Opportunity → query event patterns from TimescaleDB" -- research is forensic. Plans must trace to observed prediction failures, not LLM speculation.
- Section 3.6 (Post-Execution Evaluation): Plans are tested against reality. Failed plans feed back as prediction failures to the Drive Engine. Plans are hypotheses.

**Assessment:** Epic 8 respects experience-first development. Plans do not pre-populate the WKG; they are created from researched patterns and evaluated after execution.

---

### 1.2 LLM Is Voice, Not Mind

**Status: PASS WITH CLARIFICATION NEEDED**

**Evidence:**
- CANON: LLM translates. Graph, drives, predictions select action.
- E8 Planner Profile (Section 3.4): "LLM Constraint Engine uses the LLM to validate proposed plans against a set of constraints. This is where the LLM serves as a sanity check -- not as a decision maker, but as a validator."
- Constraint validation checks proposals against objective rules (Theater Prohibition, Contingency Requirement, Confidence Ceiling, etc.).

**Assessment:** The LLM's role is clearly defined as validator, not decision-maker. However, see CONCERN 1 (below).

---

### 1.3 WKG Is the Brain

**Status: PASS**

**Evidence:**
- Procedure creation (Section 3.5) writes validated plans to the WKG as action nodes.
- Plans follow ACT-R confidence dynamics like all other knowledge.
- Plans are retrieved and selected by Decision Making from the WKG.
- All planning events recorded in TimescaleDB (immutable event record).

**Assessment:** Value accumulates in the WKG (procedures become action nodes). All subsystems access them through shared stores.

---

### 1.4 Dual-Process Cognition

**Status: PASS**

**Evidence:**
- CANON: Type 1 graduates from successful repetition. Type 2 carries cost.
- E8 Planner (Section 3.5 Confidence Lifecycle): Plans start at 0.35 (LLM_GENERATED), graduate to Type 1 at confidence > 0.80 AND MAE < 0.10 over last 10 uses.
- Plans follow the same ACT-R formula as all knowledge. No special treatment.

**Assessment:** Epic 8 respects Type 1/Type 2 mechanics. Plans are tested and earned, not assumed.

---

### 1.5 Guardian As Primary Teacher

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.4): "Guardian Asymmetry (Immutable Standard 5). Guardian feedback on plan outcomes carries 2x (confirmation) and 3x (correction) weight."
- Post-execution evaluation (Section 3.6) updates procedure confidence; guardian feedback would apply standard 2x/3x multipliers.

**Assessment:** Guardian asymmetry is integrated into plan evaluation. No violations.

---

### 1.6 Personality from Contingencies

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.7, 3.8): Opportunity research identifies discrepancies between expected and actual outcomes. Plans are designed to address those discrepancies.
- Plans are behavioral responses to environmental contingencies, not personality trait targets.

**Assessment:** Plans are contingency-driven responses, not personality prescriptions. Compliant.

---

### 1.7 Prediction Drives Learning

**Status: PASS**

**Evidence:**
- CANON: Failed predictions are primary catalyst for growth.
- E8 Planner (Section 3.1, 3.2): Opportunity detection is triggered by prediction failures. "Recurring patterns of prediction failure → Create Opportunity."
- Plans are created to address recurring prediction failures.

**Assessment:** The Planning subsystem is the direct instantiation of this principle. Compliant.

---

### 1.8 Provenance Is Sacred

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.5): Procedure nodes created with "provenance: 'LLM_GENERATED', confidence: 0.35" -- explicit provenance on plan creation.
- CANON Immutable Standard 3 (Confidence Ceiling): No knowledge exceeds 0.60 without retrieval-and-use. LLM_GENERATED starts at 0.35.

**Assessment:** Provenance is enforced at the creation boundary. Plans are tagged as LLM_GENERATED from the constraint engine.

---

## 2. Six Immutable Standards Check

### Standard 1: Theater Prohibition

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.4, checkImmutableStandards): "Does this plan involve expressing emotions without drive support?" -- constraint check explicitly prevents plans that express emotions Sylphie is not actually feeling.
- Plans that fail the Theater check are rejected.

**Assessment:** The constraint engine prevents theatrical plans. Compliant.

**Implementation Note:** The code example checks for `involvesUnsupportedEmotionalExpression()` but does not detail the logic. This is acceptable in a specification phase. Implementation must verify that plans involving communication actions are cross-checked against current drive state (injected from Drive Engine).

---

### Standard 2: Contingency Requirement

**Status: PASS WITH ATTENTION REQUIRED**

**Evidence:**
- E8 Planner (Section 3.4, checkImmutableStandards): "Does every reinforcement in this plan trace to a specific behavior?" -- constraint checks that planned actions correspond to measurable contingencies.
- Plans that assume non-contingent reinforcement (passive ambient reinforcement, time-based relief) are rejected.

**Assessment:** The constraint check is present and framed correctly. However, the implementation detail is vague.

**Attention Required:** See CONCERN 2 (below) -- constraint validation must explicitly verify that every step in the plan's action sequence has a corresponding drive effect hypothesis and does not assume non-contingent relief.

---

### Standard 3: Confidence Ceiling

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.4, checkImmutableStandards): "Does this plan assume knowledge above 0.60 without retrieval-and-use?" -- constraint check prevents plans that depend on unproven knowledge.
- CANON: "No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event."
- E8 Planner (Section 3.5): Plans created at confidence 0.35, not 0.60 or higher.

**Assessment:** Confidence Ceiling is respected. Compliant.

**Implementation Note:** The constraint check must verify that every knowledge node referenced in a plan's action sequence has sufficient confidence. If a step depends on a 0.35-confidence node, the entire plan's expected value rating should account for that uncertainty.

---

### Standard 4: Shrug Imperative

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.4, checkImmutableStandards): "Does this plan have a 'do nothing' option for uncertainty?" -- the constraint engine checks that plans include abort conditions or uncertainty handlers.
- Plans without uncertainty handling are rejected.

**Assessment:** The Shrug Imperative is integrated into constraint validation. Plans must gracefully degrade when encountering unexpected contexts.

---

### Standard 5: Guardian Asymmetry

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.4): "Guardian Asymmetry (Immutable Standard 5). Guardian feedback on plan outcomes carries 2x (confirmation) and 3x (correction) weight."
- Post-execution evaluation (Section 3.6) follows standard ACT-R confidence updates. Guardian feedback multipliers apply (standard to all subsystems).

**Assessment:** Guardian asymmetry is inherited from the shared confidence system. No special handling needed. Compliant.

---

### Standard 6: No Self-Modification of Evaluation

**Status: PASS**

**Evidence:**
- E8 Planner (Section 3.4, checkImmutableStandards): "Does this plan attempt to modify how success is measured?" -- constraint check explicitly prevents plans that would alter the evaluation function.
- Plans cannot modify confidence formulas, drive relief assignments, or prediction error computation.
- Plans can only propose new behavioral procedures, not new evaluation rules.

**Assessment:** Plans cannot write to evaluation logic. They can propose new rules (to PostgreSQL review queue), but the evaluation function itself is write-protected. Compliant.

---

## 3. Architecture Compliance

### 3.1 Five Subsystems

**Status: PASS**

**Subsystem Interactions:**

| Subsystem | Relationship to Epic 8 | Status |
|-----------|------------------------|--------|
| Decision Making | Planning creates procedures; Decision Making selects them | PASS |
| Communication | Planning may create communication action plans; flows through normal Cortex-to-Vox path | PASS |
| Learning | Learning consolidates experience; Planning researches those patterns | PASS |
| Drive Engine | Drive Engine detects Opportunities; Planning receives and processes them | PASS |
| Planning | Central to this epic | PASS |

**Assessment:** Epic 8 respects subsystem boundaries. Planning does not bypass other subsystems. It creates artifacts (procedures) that integrate with Decision Making and Learning.

---

### 3.2 Five Databases

**Status: PASS**

**Database Usage in Epic 8:**

| Database | Usage | Compliance |
|----------|-------|-----------|
| WKG (Neo4j) | Stores procedure nodes, queries context, retrieves knowledge for research | PASS |
| TimescaleDB | Event backbone; Planning researches event patterns, logs all planning events | PASS |
| PostgreSQL (System DB) | Read-only access to drive rules; optionally proposes new rules (review queue, no autonomy) | PASS |
| Self KG (Grafeo) | Drive state lookup for context; plans consider current self-model | PASS |
| Other KG (Grafeo) | Planning may consider person models when designing communication plans | PASS |

**Assessment:** No cross-database contamination. Appropriate read/write patterns.

---

### 3.3 KG Isolation

**Status: PASS**

**Evidence:**
- E8 Planner does not create edges between Self KG and WKG.
- E8 Planner does not create edges between Other KGs.
- Procedure nodes belong to WKG only.

**Assessment:** KG isolation is respected. No violations.

---

### 3.4 Drive Isolation

**Status: PASS**

**Evidence:**
- E8 Planner reads drive state (via DriveReaderService observable) but does not write to drive computation.
- E8 Planner can propose new rules (to review queue in PostgreSQL), but rules are not self-activated.
- Drive Engine runs in separate process. Planning cannot bypass this.

**Assessment:** One-way communication is maintained. Planning cannot modify evaluation function or drive rules autonomously. Compliant.

---

### 3.5 Subsystem Communication

**Status: PASS**

**Evidence:**
- Opportunities are communicated through TimescaleDB events (shared store), not direct interface.
- Plans created in WKG (shared store), not sent directly to Decision Making.
- All planning events logged to TimescaleDB.

**Assessment:** All communication through shared stores. No direct internal coupling. Compliant.

---

## 4. Phase Boundary Check

**Status: PASS**

**Phase 1 Scope:** All five subsystems (Decision Making, Communication, Learning, Drive Engine, Planning) operational without physical body.

**Epic 8 Scope:**
- Opportunity research from TimescaleDB event patterns ✓
- Outcome simulation (CANON A.5 reserved -- specification gaps noted) ✓
- Plan proposal (LLM-assisted) ✓
- LLM constraint validation ✓
- Procedure creation in WKG ✓
- Post-execution evaluation ✓
- Rate limiting, cold-start dampening, priority decay ✓

**Phase 2 Concerns:** None detected. Epic 8 contains no robot hardware, physical sensor, motor control, or embodied exploration elements.

**Assessment:** FULLY WITHIN PHASE 1. Compliant.

---

## 5. Confidence Dynamics Check

**Status: PASS WITH CLARIFICATION**

### ACT-R Formula Compliance

**CANON Formula:** `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

**E8 Application:**
- E8 Planner (Section 3.5): "Plans start at low confidence (like all new knowledge)."
- Plans created with `confidence: 0.35` (LLM_GENERATED base).
- Plans follow "same confidence formula as all other knowledge."

**Confidence Lifecycle (E8 Section 3.5):**
1. Creation: 0.35
2. First success: Maintains base; `0.35 + 0.12 * ln(1) = 0.35` (no growth from single success, which is correct per formula)
3. 5 successful uses: `0.35 + 0.12 * ln(5) = 0.35 + 0.19 = 0.54` (approaching retrieval threshold 0.50)
4. Graduation: confidence > 0.80 AND MAE < 0.10 over last 10 uses
5. Demotion: MAE > 0.15 (context changed, demoted back to Type 2)
6. Decay: Unused plans decay per ACT-R formula; eventually drop below 0.50 retrieval threshold

**Assessment:** ACT-R mechanics are correctly applied. Graduation/demotion criteria are appropriate.

### Potential Tension: New Plans Below Retrieval Threshold

**Issue:** Plans are created at confidence 0.35. Retrieval threshold is 0.50. New plans would never be selected.

**Status:** ACKNOWLEDGED IN PROFILE

**E8 Planner (Section 6, Interactions, Planner <-> Cortex):** "New plans start at 0.35 confidence, which is below the retrieval threshold (0.50) in standard ACT-R. This means newly created plans would never be selected. Resolution: Decision Making must have a mechanism for giving new plans a trial -- perhaps a dedicated 'try new procedure' action that fires occasionally, or a temporary confidence boost for untested plans."

**Assessment:** The tension is identified but deferred to Decision Making (Cortex) for resolution. This is appropriate -- it is not a violation, but a design challenge that Cortex must address. Canon notes this as a design dependency that must be verified during E5 implementation.

---

## 6. Planning Rules Check

**Status: PASS**

### CANON Planning Rules

1. **"No code without epic-level planning validated against this CANON"** -- PASS (this analysis validates E8 planning).
2. **"Every epic is planned by parallel agents who cross-examine each other"** -- Not directly applicable to E8 (this is meta-planning about how epics are planned).
3. **"This CANON is immutable unless Jim explicitly approves a change"** -- PASS (no CANON changes proposed by E8).
4. **"Every implementation session produces a tangible artifact"** -- PASS (planning implementation sessions must produce module stubs, interfaces, and documentation).
5. **"Context preservation at end of every session"** -- PASS (E8 sessions must document known attractor states, rate limiter state, queue state for next session).

**Assessment:** All planning rules respected. Compliant.

---

## 7. Specific Risk Analysis for Epic 8

### RISK 1: LLM Constraint Engine -- Validator or Decision Maker?

**Risk Level:** MEDIUM
**Status:** REQUIRES IMPLEMENTATION VERIFICATION

**CANON Requirement:** LLM is voice, not mind. LLM translates; does not decide.

**E8 Specification:** The constraint engine uses LLM to validate plans against objective constraints. The LLM does NOT decide whether to create a plan -- it validates whether a proposed plan violates safety/feasibility/coherence/Immutable Standard rules.

**Violation Risk:** If implementation allows the LLM's validation logic to become subjective ("this plan seems good") rather than objective constraint-checking ("does this plan violate Theater Prohibition?"), the LLM becomes a decision-maker.

**Mitigation Required Before Coding:**
- Constraint validation must use structured prompts with explicit rule checks (Section 3.4 example shows this correctly).
- Each constraint check (Theater, Contingency, etc.) must have deterministic pass/fail logic, not fuzzy LLM judgment.
- The LLM output must be parsed to extract binary pass/fail decisions, not treated as qualitative advice.
- Revision loop (Section 3.4) has maximum 2 revisions per proposal. If LLM cannot generate a passing plan after 2 revisions, the opportunity is deferred, not repeatedly refined.

**Verdict:** ACCEPTABLE with implementation discipline.

---

### RISK 2: Constraint Validation Depth

**Risk Level:** MEDIUM
**Status:** SPECIFICATION INCOMPLETE

**CANON Requirement:** Immutable Standard 2 (Contingency Requirement) -- Every positive reinforcement must trace to a specific behavior.

**E8 Specification Gap:** Section 3.4 shows a `checkContingencyConstraint()` that asks "Does every reinforcement in this plan trace to a behavior?" but implementation details are absent.

**Violation Risk:** Implementation could perform only shallow checks (e.g., "does the plan mention drive effects?") rather than deep structural verification that every step has a corresponding, measurable contingency.

**What Deep Verification Looks Like:**
- For each action step in the plan's sequence, identify:
  - What specific behavior is performed
  - What specific drive effect is expected
  - How that effect will be measured/evaluated
  - What constitutes success vs. failure for that step
- Reject plans where:
  - Action steps lack corresponding drive effect hypothesis
  - Drive effects are "ambient" (not tied to specific actions)
  - Success criteria are unmeasurable

**Mitigation Required Before Coding:**
- Write explicit test cases for contingency validation (e.g., "plan that assumes non-contingent relief must fail").
- Document the depth of verification required in constraint engine specification.
- During E8 implementation, ensure Constraint Validation Service validates to this depth.

**Verdict:** ACCEPTABLE provided implementation specification is explicit before coding begins.

---

### RISK 3: Procedure Creation Provenance

**Risk Level:** LOW
**Status:** COMPLIANT

**CANON Requirement:** Every node and edge carries provenance. LLM_GENERATED provenance indicates LLM involvement.

**E8 Specification:** Procedures created with `provenance: 'LLM_GENERATED', confidence: 0.35` (Section 3.5).

**Assessment:** Provenance is explicit and correct. No violation risk.

---

### RISK 4: Plans Are Hypotheses, Not Solutions

**Risk Level:** LOW
**Status:** COMPLIANT

**CANON Requirement:** Plans must be evaluated AFTER execution. Plans are not permanent.

**E8 Specification:**
- Section 3.6 (Post-Execution Evaluation): Plans are evaluated against actual outcomes. MAE is computed. Confidence is updated per ACT-R.
- Failed plans create new prediction failures that feed back to Drive Engine.
- Plans can be demoted (MAE > 0.15) back to Type 2.
- Unused plans decay and drop below retrieval threshold (disappear).

**Assessment:** Plans are treated as testable hypotheses. No violation risk.

---

### RISK 5: Rate Limiting and Planning Runaway

**Risk Level:** MEDIUM
**Status:** COMPLIANT WITH CAVEATS

**CANON Reference:** Known Attractor State: Planning Runaway. "Many prediction failures → many Opportunities → many Plans → resource exhaustion."

**E8 Mitigation (Section 3.7, 3.8):**
- Rate limiter: max 3 plans per hour, max 10 active plans, max 4000 tokens per plan.
- Cold-start dampening: Opportunities at reduced weight in first 100 decisions (80% dampening at decision 0, linearly to 0% at decision 100).
- Opportunity queue: max 50 items, priority decay 10% per hour, lowest-priority dropped when full.

**Assessment:** Structural prevention mechanisms are in place. The parameters (3 plans/hour, 50-item queue, etc.) are reasonable defaults but may need tuning based on observed behavior.

**Caveat:** These are not code-level guarantees. Implementation must enforce these limits structurally (not as soft guidelines).

---

### RISK 6: Cold-Start Dampening

**Risk Level:** LOW
**Status:** COMPLIANT

**CANON Reference:** Known Attractor State: Prediction Pessimist. "Early failures flood the system with low-quality procedures before the graph has substance."

**E8 Mitigation (Section 3.7):** Cold-start dampening reduces Opportunity generation weight in first 100 decisions. Computation: `return 0.8 * (1 - totalDecisions / 100)` for decisions < 100.

**Assessment:** The mechanism is simple, justified, and prevents the attractor state. Compliant.

---

### RISK 7: Plans Cannot Self-Activate Without Validation

**Risk Level:** LOW
**Status:** COMPLIANT

**CANON Reference:** Immutable Standard 6 (No Self-Modification). Plans cannot modify evaluation function or self-activate.

**E8 Specification:**
- Plans are created and written to WKG.
- Decision Making selects plans (Decision Making owns action selection, not Planning).
- Plans start at 0.35 confidence (below retrieval threshold). Decision Making must provide mechanism to trial new plans.
- Plans follow standard ACT-R confidence dynamics (no special self-activation rules).

**Assessment:** Plans do not self-activate. They earn selection through Decision Making's action retrieval logic. Compliant.

**Dependency:** See CONCERN 1 (below) -- Decision Making must implement a mechanism for trialing low-confidence plans, or newly created procedures will never be used.

---

### RISK 8: New Procedure Retrieval Threshold Tension

**Risk Level:** MEDIUM
**Status:** FLAGGED FOR E5 RESOLUTION

**Tension:** Plans created at 0.35 confidence. Retrieval threshold is 0.50. New plans would not be retrieved.

**E8 Specification (Section 6, Interactions):** Acknowledged. Deferred to Decision Making for resolution.

**Possible Resolutions (not Epic 8's responsibility, but mentioned for completeness):**
- Option A: Temporary confidence boost for untested plans (e.g., 0.35 → 0.60 for first 3 uses, then standard ACT-R).
- Option B: Dedicated action in Decision Making for trialing new procedures (e.g., "try new procedure" fires occasionally).
- Option C: Lower retrieval threshold for new plans (0.35 → retrievable).
- Option D: Pre-graduation mechanism (plans above 0.35 but below 0.50 can be selected with additional cost/scrutiny).

**Status:** ACCEPTABLE -- This is a design dependency, not a violation. E5 (Decision Making) must address it.

---

## 8. CANON Gaps and Appendix Sections

### Reserved Appendix Sections Relevant to Epic 8

**A.4 -- Opportunity Detection and Classification Criteria**

**Status:** RESERVED, PARTIALLY ADDRESSED IN CANON BODY

**E8 Specification Reference:** Section 3.2 of Planner profile identifies "Recurring patterns of prediction failure → Create Opportunity" and "Non-recurring but high impact → Create Opportunity," but exact classification logic is not fully specified in CANON.

**E8 Fills This Gap Partially:**
- Opportunity Research (Section 3.2, Planner) researches patterns and computes evidence strength.
- Evidence strength formula accounts for failure count, discrepancy consistency, and prior attempts.

**Remaining Gap:** Exact thresholds for "recurring" (how many failures?) and "high impact" (MAE > what?) are not specified in CANON. E8 specification uses examples but not strict thresholds.

**Recommendation for Jim:** Consider whether A.4 should be expanded with specific thresholds before E4 (Drive Engine) implementation, or whether E4 can define these thresholds with E8 dependency and Canon coordination.

**For E8 Approval:** This is acceptable. E8's specification provides operational detail that fills the gap sufficiently for implementation.

---

**A.5 -- Planning Simulation Methodology**

**Status:** RESERVED, PARTIALLY ADDRESSED IN E8

**E8 Specification (Section 3.3, Planner):** Outcome Simulator generates candidate actions, predicts drive effects, estimates success probability, estimates information gain, computes expected value.

**Implementation Approach:** "historical pattern matching" until more detailed simulation methodology is available.

**Assessment:** E8 acknowledges A.5 is reserved and provides a conservative, safe approach (historical matching) until the full methodology is specified. This is appropriate.

**Recommendation for Jim:** A.5 could be expanded with more sophisticated simulation (e.g., Markov chain, Bayesian inference) if desired, but E8 is not blocked on this. Historical matching is a valid starting point.

---

### E8-Specific Specification Gaps (Not Appendix)

**Gap 1: Exact Constraint Validation Rules**

**Identified in Risk 2 (above).** The CANON specifies that plans must not violate Immutable Standards, but the exact logic for each constraint check is underspecified.

**E8 Addresses This:** Planner profile (Section 3.4) provides code examples for each constraint, but these are examples, not exhaustive specifications.

**Recommendation:** Before E8 implementation, produce a detailed constraint validation specification document that lists every rule, pass/fail conditions, and error cases for each constraint check.

---

**Gap 2: Opportunity Priority Queue Decay Function**

**Specified in E8 (Section 3.8):** Decay rate 10% per hour. `currentPriority * Math.pow(1 - 0.10, hours)`.

**Assessment:** This is operational specification sufficient for implementation. No gap.

---

## 9. Subsystem Integration Verification

### Planning <-> Drive Engine

**Expected Behavior:**
1. Drive Engine detects prediction failure pattern.
2. Drive Engine publishes Opportunity to TimescaleDB.
3. Planning subscribes to Opportunity events, dequeues by priority.
4. Planning researches pattern, simulates outcomes, proposes plan.
5. Planning creates procedure in WKG.
6. Decision Making selects procedure (when confidence allows).
7. Executor executes procedure.
8. Procedure outcome is reported (drive state changes, prediction accuracy computed).
9. Planning evaluates execution, updates procedure confidence.
10. If execution fails, feeds back as prediction failure to Drive Engine (cycle continues).

**Implementation Dependency:** E8 requires E4 (Drive Engine) to be operational for Opportunity events. E8 can progress in parallel with E4 but cannot fully test without E4.

---

### Planning <-> Decision Making

**Expected Behavior:**
1. Planning creates procedure nodes in WKG with confidence 0.35.
2. Decision Making queries WKG for action candidates by category and confidence.
3. Procedure nodes appear in query results (no special handling).
4. Decision Making's action retrieval logic must handle new, low-confidence procedures.

**Integration Tension (Acknowledged):** New plans at 0.35 confidence are below 0.50 retrieval threshold. Decision Making must provide a mechanism to trial them. This is a design dependency E5 must resolve.

**Status:** DEPENDENCY IDENTIFIED, ACCEPTABLE.

---

### Planning <-> Learning

**Relationship:** Learning consolidates experience. Planning researches those patterns.

**Expected Behavior:**
1. Learning runs maintenance cycle, extracts entities and edges from TimescaleDB events.
2. Planning researches context patterns in TimescaleDB (same event stream).
3. Better WKG knowledge → better planning research → better simulations.

**Tight Coupling Risk:** NONE. They communicate through shared stores (TimescaleDB, WKG), not direct interfaces.

---

### Planning <-> Communication

**Relationship:** Minimal. Some plans may involve communication actions.

**Expected Behavior:**
1. Planning may create plans with communication action steps (e.g., "ask guardian about X").
2. These plans are procedures in WKG, subject to same confidence dynamics.
3. Decision Making selects the procedure (normal action selection).
4. Executor calls Communication subsystem to perform the action (normal flow).

**Status:** COMPLIANT. No direct Epic 8 impact on Communication implementation.

---

## 10. Known Attractor State Prevention

### Planning Runaway Prevention: VERIFIED

**Mechanism:**
- Rate limiter (max 3 plans/hour, max 10 active, max 4000 tokens/plan)
- Opportunity priority queue with decay
- Maximum queue size 50

**Assessment:** SUFFICIENT.

---

### Prediction Pessimist Prevention: VERIFIED

**Mechanism:**
- Cold-start dampening (80% weight reduction at decision 0, decays to 0% at decision 100)
- Dampening prevents early failures from flooding system with procedures before graph has substance

**Assessment:** SUFFICIENT.

---

### Other Known Attractor States

**Type 2 Addict:** Planning does not exacerbate this. Responsibility of Decision Making (E5) to ensure Type 1 graduates and Type 2 carries cost.

**Rule Drift:** Planning proposes rules to review queue but cannot self-activate them. Responsibility of Drive Engine (E4) to maintain write-protected rules.

**Hallucinated Knowledge:** Planning inherits provenance discipline from Knowledge module. All procedures marked LLM_GENERATED (0.35 base confidence). Must be earned through use. Responsibility of Knowledge (E3) to enforce provenance.

**Depressive Attractor:** Planning does not exacerbate this. Responsibility of Drive Engine (E4) and Self KG (E3) to manage self-evaluation and circuit-break ruminative loops.

---

## 11. Checklist Results

### 1. Core Philosophy Alignment

| Principle | Status | Evidence |
|-----------|--------|----------|
| Experience Shapes Knowledge | PASS | Plans researched from observed failures, tested after execution |
| LLM Is Voice, Not Mind | PASS | LLM validates, does not decide. Constraint engine is objective. |
| WKG Is the Brain | PASS | Procedures written to WKG, retrieved by Decision Making |
| Dual-Process Cognition | PASS | Plans follow ACT-R, graduate from 0.35 to Type 1 at 0.80 |
| Guardian As Primary Teacher | PASS | Guardian feedback applies standard 2x/3x multipliers to plan confidence |
| Personality from Contingencies | PASS | Plans designed to address behavioral contingencies, not personality traits |
| Prediction Drives Learning | PASS | Planning triggered by prediction failures, creates growth-enabling procedures |
| Provenance Is Sacred | PASS | Procedures marked LLM_GENERATED with explicit provenance |

**Overall: PASS**

---

### 2. Six Immutable Standards Check

| Standard | Status | Key Evidence |
|----------|--------|--------------|
| Theater Prohibition | PASS | Constraint engine rejects plans with unsupported emotional expression |
| Contingency Requirement | PASS | Constraint engine verifies all reinforcements trace to behaviors |
| Confidence Ceiling | PASS | Plans at 0.35 base, no special exceptions to retrieval threshold |
| Shrug Imperative | PASS | Constraint engine requires uncertainty handlers and abort conditions |
| Guardian Asymmetry | PASS | Inherited from shared confidence system, 2x/3x multipliers apply |
| No Self-Modification of Evaluation | PASS | Plans cannot modify evaluation function; proposed rules enter review queue |

**Overall: PASS**

---

### 3. Architecture Compliance

| Component | Status | Evidence |
|-----------|--------|----------|
| Five Subsystems | PASS | Respects subsystem boundaries, integrates via shared stores |
| Five Databases | PASS | Appropriate read/write patterns, no cross-database contamination |
| KG Isolation | PASS | Self KG, Other KG, WKG never cross-connected |
| Drive Isolation | PASS | One-way read-only communication, cannot modify evaluation function |
| Subsystem Communication | PASS | All communication through TimescaleDB and WKG, not direct interfaces |

**Overall: PASS**

---

### 4. Phase Boundary

| Requirement | Status |
|-------------|--------|
| All work within Phase 1 scope | PASS |
| No Phase 2 leakage (hardware, sensors, motors) | PASS |

**Overall: PASS**

---

### 5. Confidence Dynamics

| Aspect | Status | Evidence |
|--------|--------|----------|
| ACT-R formula respected | PASS | Plans follow standard formula with LLM_GENERATED 0.35 base |
| Graduation criteria (0.80 + MAE<0.10) | PASS | Specified in Section 3.5 |
| Demotion criteria (MAE>0.15) | PASS | Specified in Section 3.5 |
| Decay on disuse | PASS | Plans drop below 0.50 retrieval threshold over time |

**Overall: PASS WITH CLARIFICATION**

New procedure retrieval threshold tension acknowledged and deferred to E5 (Decision Making) for resolution. This is acceptable.

---

### 6. Planning Rules

| Rule | Status |
|------|--------|
| No code without epic planning | PASS |
| Epic planned by parallel agents | N/A (meta-planning) |
| CANON is immutable | PASS |
| Every session produces tangible artifact | PASS |
| Context preservation at session end | PASS |

**Overall: PASS**

---

### 7. Specific Risks for Epic 8

| Risk | Level | Status | Mitigation |
|------|-------|--------|-----------|
| LLM constraint engine validator vs. decision maker | MEDIUM | FLAGGED | Structured prompts, deterministic checks, max 2 revisions per proposal |
| Constraint validation depth | MEDIUM | FLAGGED | Explicit test cases for contingency verification before coding |
| Procedure provenance | LOW | COMPLIANT | Explicit LLM_GENERATED tagging |
| Plans as hypotheses | LOW | COMPLIANT | Post-execution evaluation integrated |
| Rate limiting and Planning Runaway | MEDIUM | COMPLIANT | Structural limits enforced (not soft guidelines) |
| Cold-start dampening | LOW | COMPLIANT | Formula: 80% dampening at decision 0, decays to 0% at 100 |
| Plans cannot self-activate | LOW | COMPLIANT | Plans don't self-activate; selected by Decision Making |
| New procedure threshold tension | MEDIUM | FLAGGED | Design dependency for E5 to resolve |

**Overall: COMPLIANT WITH CONCERNS (see below)**

---

### 8. CANON Gaps

| Gap | Status | Impact on E8 | Recommendation |
|-----|--------|--------------|-----------------|
| A.4 (Opportunity Detection Criteria) | Reserved, partially addressed | E8 provides operational detail sufficient for implementation | May wish to expand with exact thresholds before E4 |
| A.5 (Planning Simulation Methodology) | Reserved, partially addressed | E8 uses conservative historical matching approach | Acceptable; can enhance later |

**Overall: ACCEPTABLE**

---

## Violations

**None identified.**

---

## Concerns

### CONCERN 1: LLM Constraint Engine Must Be Deterministic, Not Judgmental

**Priority:** HIGH
**Phase:** Must be addressed in implementation specification before E8 code begins

**Detailed Issue:**

The Planner profile correctly identifies that the LLM's role is to validate plans against constraints, not to decide whether to create plans. However, the line between "validation" and "judgment" is subtle. Implementation can easily drift into subjective LLM evaluation ("does this plan seem reasonable?") rather than objective constraint-checking ("does this plan violate the Theater Prohibition?").

**Why This Matters:**

- CANON Principle 1: "LLM Is Voice, Not Mind." If the LLM's validation logic becomes subjective judgment, the LLM is deciding plans, not translating them.
- CANON Principle 2: "Dual-Process Cognition." The Planning subsystem must make planning decisions through its structure (evidence strength, simulations, constraint checks), not by delegating to the LLM.

**Current Specification (Acceptable But Needs Refinement):**

Planner profile Section 3.4 shows code examples with constraint checks like:
```typescript
private async checkCoherenceConstraints(proposal: PlanProposal): Promise<ConstraintCheckResult> {
  const prompt = this.buildCoherencePrompt(proposal);
  const response = await this.llmService.call(prompt);
  return this.parseConstraintResponse(response, 'COHERENCE');
}
```

This example is reasonable (coherence is a subjective assessment that needs LLM judgment), but it must not become the pattern for all constraint checks. Checks like "Theater Prohibition" and "Contingency Requirement" should be deterministic:

```typescript
// GOOD: Deterministic check
private checkTheaterProhibition(proposal: PlanProposal): boolean {
  const communicationSteps = proposal.procedure.actionSequence.filter(
    s => s.action.type === 'COMMUNICATION'
  );

  for (const step of communicationSteps) {
    // For each communication action, verify current drive state supports emotional expression
    const requiredDrive = this.mapEmotionToDrive(step.action.emotion);
    if (!requiredDrive) return true; // No emotion, no check needed

    const driveState = await this.driveReader.getCurrentState();
    if (driveState[requiredDrive] < 0.2) return false; // Violation
  }

  return true; // All checks pass
}
```

**Required Fix Before Coding:**

1. **Categorize each constraint into deterministic vs. subjective:**
   - Deterministic (no LLM): Theater Prohibition, Contingency Requirement, Confidence Ceiling, No Self-Modification
   - Subjective (LLM-assisted): Coherence, Feasibility
   - Hybrid (deterministic foundation + LLM refinement): Safety constraints

2. **For each deterministic constraint, define the exact pass/fail logic** in pseudocode before implementation.

3. **For subjective constraints, define parsing rules** that extract binary pass/fail from LLM output (not fuzzy scoring).

4. **Revision loop limit:** Max 2 revisions per proposal. If LLM cannot generate a passing plan after 2 revisions, the opportunity is deferred.

5. **Structured prompt pattern:** Use the same prompt template for all constraint checks, with explicit "PASS" or "FAIL" in LLM output.

**Acceptance Criteria:**

- E8 implementation must include constraint validation unit tests that verify deterministic checks pass/fail as expected.
- E8 implementation must include LLM prompt templates for subjective checks with documented parsing rules.
- E8 implementation must enforce 2-revision limit.

---

### CONCERN 2: Contingency Requirement Must Be Verified Deeply

**Priority:** HIGH
**Phase:** Must be addressed in constraint validation specification before E8 code begins

**Detailed Issue:**

Immutable Standard 2 (Contingency Requirement): "Every positive reinforcement event must trace to a specific behavior."

The Planner profile (Section 3.4) shows a constraint check asking "Does every reinforcement in this plan trace to a behavior?" but the implementation details are vague. Shallow implementation could allow plans that assume non-contingent relief (e.g., "Sylphie feels less Anxiety simply because time passed" or "Satisfaction increases passively from success of other actions").

**Why This Matters:**

Non-contingent reinforcement prevents learning. If Sylphie can get drive relief without doing anything specific, she has no incentive to develop new behaviors. Plans that assume non-contingent relief teach learned helplessness, not competence.

**Current Specification Gap:**

Planner profile Section 3.4 provides structure but not depth:
```typescript
private allReinforcementsContingent(proposal: PlanProposal): boolean {
  // Does every reinforcement in this plan trace to a specific behavior?
  // Implementation not shown
}
```

**What Deep Verification Must Check:**

For each action step in the plan's action sequence:
1. **Identify the action:** What specific behavior is performed? (e.g., "ask guardian about topic X")
2. **Identify the expected drive effect:** What drive is expected to change? By how much? (e.g., "Curiosity -0.20")
3. **Verify the mechanism:** How does this specific action produce this specific drive effect?
   - Is there a precedent in the WKG for similar actions producing similar effects?
   - Does the drive effect depend solely on this action, or are there other conditions?
   - Would the drive effect occur if the action were not performed?
4. **Reject if:**
   - Action step has no corresponding drive effect hypothesis
   - Drive effects are "ambient" (e.g., "Satisfaction increases over time")
   - Success is conditional on uncontrollable factors (e.g., "guardian must respond favorably")
   - Reinforcement is decoupled from the specific behavior (e.g., "if this action succeeds, other unrelated actions also get reinforced")

**Example of Violation:**

```
PLAN: "When Sylphie is Anxious, wait 5 minutes. Anxiety should decrease."

Analysis:
- Action: Wait 5 minutes
- Expected drive effect: Anxiety -0.15
- Problem: This assumes non-contingent Anxiety relief (time-based decay).
  The action (waiting) is not the contingency; time is.
  This plan violates the Contingency Requirement.
- REJECT
```

**Example of Compliance:**

```
PLAN: "When Sylphie is Anxious and the guardian is present, ask the guardian for reassurance.
       The guardian's reassuring response is expected to reduce Anxiety."

Analysis:
- Action: Ask guardian for reassurance (specific behavior)
- Expected drive effect: Anxiety -0.15 (conditional on guardian's response)
- Contingency: The behavior (asking) is contingent on the desired effect (reassurance).
  Success depends on the guardian responding, but the action itself is specific and contingent.
- ACCEPT (because the action, not time or ambient conditions, is the contingency)
```

**Required Fix Before Coding:**

1. **Expand constraint validation specification with a detailed contingency verification algorithm.**

2. **Define rules for acceptable vs. unacceptable contingencies:**
   - Acceptable: Specific behavior → measurable drive effect
   - Unacceptable: Time passage, environmental state change (with no action), passive relief

3. **For each drive that can be affected by a plan, list the contingencies** (actions that reliably produce that drive effect) in a reference table.

4. **During constraint validation, cross-check plan action sequences against contingency reference table.**

5. **Test cases:** Create a suite of test plans:
   - One that violates contingency (non-contingent relief) -- MUST REJECT
   - One that respects contingency (specific action → specific drive effect) -- MUST ACCEPT
   - One that is ambiguous (action depends on conditions outside system control) -- Define policy and test accordingly

**Acceptance Criteria:**

- E8 implementation includes a contingency reference table (part of WKG schema or configuration).
- E8 implementation includes unit tests for contingency validation with passing and failing examples.
- All E8 implementation constraint validation for Contingency Requirement references this table and applies deep verification logic.

---

### CONCERN 3: Procedure Retrieval Threshold Creates Orphan Plans

**Priority:** MEDIUM
**Phase:** Design dependency for E5 (Decision Making), but E8 must acknowledge and coordinate

**Detailed Issue:**

Plans are created at confidence 0.35 (LLM_GENERATED base). The retrieval threshold is 0.50. A newly created plan will not be retrieved by Decision Making's standard action selection logic. It is an orphan -- created but never used.

**Why This Matters:**

Plans cannot graduate to Type 1 if they are never tried. If newly created plans are not selected, they decay below the retrieval threshold and disappear. The Planning subsystem cannot fulfill its purpose (creating new behavioral procedures) if Decision Making cannot select the procedures it creates.

**Current Specification:**

Planner profile Section 6 (Interactions, Planner <-> Cortex) acknowledges this:
> "New plans start at 0.35 confidence, which is below the retrieval threshold (0.50) in standard ACT-R. This means newly created plans would never be selected. Resolution: Decision Making must have a mechanism for giving new plans a trial -- perhaps a dedicated 'try new procedure' action that fires occasionally, or a temporary confidence boost for untested plans."

This is a dependency identified but deferred to Decision Making. This is acceptable at the specification level, but it requires explicit coordination.

**Possible Resolutions (not Epic 8's decision, but important for context):**

1. **Option A: Temporary confidence boost for new plans**
   - On creation, set procedure confidence to 0.60 (retrieval threshold) for first 3 uses.
   - After 3 uses, apply standard ACT-R formula.
   - Risk: New plans might be over-selected early on, consuming resources.

2. **Option B: Dedicated "try new procedure" action in Decision Making**
   - Decision Making includes a reflexive action: "try new procedure" that fires occasionally (e.g., 5% of decisions).
   - When fired, Decision Making selects a random untested procedure (confidence < 0.50).
   - Risk: If the new procedure fails repeatedly, the "try new procedure" action itself may lose confidence.

3. **Option C: Lower retrieval threshold for new plans**
   - New procedures (confidence 0.35) are retrievable.
   - Older, tested procedures require 0.50 for retrieval.
   - Risk: Asymmetric retrieval logic adds complexity.

4. **Option D: Pre-graduation mechanism**
   - Plans above 0.35 but below 0.50 are retrievable but with an additional cost/scrutiny check.
   - Risk: Unclear what "additional cost" means.

**Why This Is E8's Concern:**

If E5 (Decision Making) is implemented without a resolution to this tension, E8's procedures will never be used, and the Planning subsystem will appear to fail (procedures created but not selected). This could lead to:
- False belief that Planning is broken
- Workarounds in E8 code that artificially inflate procedure confidence at creation
- Violation of confidence dynamics principles

**What E8 Must Do:**

1. **Document the dependency explicitly in E8 implementation plan:**
   - "Planning subsystem requires Decision Making to implement mechanism for trialing new procedures (confidence 0.35) that are below the standard retrieval threshold (0.50)."

2. **Coordinate with E5 planner (Cortex):**
   - Propose that E5 includes a "try new procedure" mechanism or temporary confidence boost.
   - Verify E5 implementation includes this mechanism.

3. **Test the integration:**
   - E8 implementation must include integration tests that verify newly created procedures are actually selected by Decision Making.
   - If E5 does not implement a mechanism, E8 tests will fail, triggering coordination.

**Acceptance Criteria:**

- E8 implementation plan explicitly documents this dependency.
- E8 and E5 (Cortex) are coordinated on the resolution before either begins.
- Integration tests verify newly created procedures are selected and trialed.

---

### CONCERN 4: Simulation Methodology (A.5) Is Reserved

**Priority:** LOW
**Phase:** Specification gap, acceptable for Phase 1 if historical matching is used

**Detailed Issue:**

CANON Appendix A.5 (Planning Simulation Methodology) is reserved for detailed specification. E8 specification proposes "historical pattern matching" as a conservative starting point (Section 3.3, Planner profile).

**Why This Matters:**

Simulation is a critical stage in the planning pipeline. Poor simulation produces plans with bad expected values. The system might create many plans that fail in practice, flooding TimescaleDB with failed plan evaluations and driving Opportunities back to the queue.

**Current Specification (Conservative):**

Planner profile Section 3.3:
```typescript
const similarActions = knowledge.filter(n =>
  n.type === 'Action' && this.isSimilarAction(n, action)
);

if (similarActions.length > 0) {
  // Aggregate historical drive effects from similar actions
  for (const similar of similarActions) {
    const historicalEffects = similar.properties.averageDriveEffects;
    if (historicalEffects) {
      for (const [drive, effect] of Object.entries(historicalEffects)) {
        effects[drive] = (effects[drive] ?? 0) + (effect as number);
      }
    }
  }
  // Average across similar actions
  const count = similarActions.length;
  for (const drive of Object.keys(effects)) {
    effects[drive] /= count;
  }
}
```

This is naive averaging. It works if:
- Similar actions exist in the WKG
- Similar actions have reliable drive effect data
- Averaging is appropriate for the domain

This breaks if:
- No similar actions exist (sparse WKG in cold start)
- Drive effect data is noisy (contradictory outcomes)
- Outcomes depend on context (averaging hides important variation)

**Why E8 Doesn't Require A.5 Expansion:**

1. Cold-start dampening (Section 3.7) prevents the system from creating many plans early on.
2. Rate limiting (max 3 plans/hour) limits the impact of poor simulations.
3. Post-execution evaluation (Section 3.6) demotes failed plans quickly.
4. Prediction failure from failed plans triggers new Opportunities, which can be researched with A.5 once it's specified.

The system is resilient to poor simulations in Phase 1. A.5 can be expanded in later phases once more experience is available.

**What E8 Must Do:**

1. **Document the simulation limitation in E8 implementation plan:**
   - "Phase 1 uses conservative historical averaging for outcome simulation. A.5 (Planning Simulation Methodology) is reserved for Phase 1+. More sophisticated simulation (Markov chains, Bayesian inference) may be added once the system has more experience."

2. **Implement guards against poor simulations:**
   - Proposals with low expected value (e.g., < 0.3) are rejected even if constraints pass.
   - Plans are post-evaluated and quickly demoted if they fail.

3. **Collect simulation accuracy metrics:**
   - After execution, compare simulated expected value to actual outcome.
   - Log these metrics for A.5 expansion analysis.

**Acceptance Criteria:**

- E8 implementation plan documents the simulation approach and its limitations.
- E8 implementation includes guards (low expected value rejection, quick demotion on failure).
- E8 implementation collects simulation accuracy metrics.
- A.5 expansion is explicitly a future task, not Phase 1 blocker.

---

## 12. Required Actions Before Approval

1. **Produce detailed Constraint Validation Specification**
   - For each of the six Immutable Standards, define deterministic pass/fail logic (or LLM parsing rules for subjective checks).
   - Define structured prompt templates for LLM calls.
   - Define 2-revision-max limit and "give up" strategy.

2. **Produce Contingency Verification Algorithm**
   - Define rules for acceptable vs. unacceptable contingencies.
   - Create contingency reference table (actions that reliably produce drive effects).
   - Specify how constraint validation cross-checks plan action sequences against this table.
   - Create unit test cases (passing and failing examples).

3. **Coordinate with E5 (Decision Making) on Procedure Retrieval**
   - Resolve how newly created procedures (confidence 0.35, below 0.50 threshold) are trialed.
   - Verify E5 implementation includes the mechanism before E8 implementation begins.
   - Create integration tests to verify the flow end-to-end.

4. **Document A.5 Gap and Historical Matching Approach**
   - Add session log note that A.5 (Planning Simulation Methodology) is reserved.
   - Document that Phase 1 uses historical averaging.
   - Plan A.5 expansion as future work (Phase 1+ or Phase 2).

5. **Define Simulation Accuracy Metrics**
   - Specify what metrics are collected (simulated vs. actual expected value, etc.).
   - Plan analysis strategy for improving simulations in future phases.

---

## 13. Jim's Attention Needed

### Item 1: A.4 and A.5 Specification Timing

**Question:** Should A.4 (Opportunity Detection Criteria) and A.5 (Planning Simulation Methodology) be expanded before E4 and E8 implementation, or can they be specified during implementation with E4/E8 filling gaps operationally?

**Impact:**
- **Expand before:** Cleaner CANON, E4/E8 follow spec, longer planning phase.
- **Specify during:** E4/E8 define operational detail, faster to code, CANON updated as appendices.

**Recommendation:** E8 specification in Planner profile is sufficient for Phase 1 implementation. Recommend deferring A.4/A.5 expansion to Phase 1+ (after initial runtime experience). This is not a blocker for E8 code.

---

### Item 2: New Procedure Retrieval Threshold Resolution

**Question:** How should Decision Making (E5) trial newly created procedures that are below the retrieval threshold (0.35 < 0.50)?

**Impact:**
- Missing resolution means Planning procedures are orphaned and never used.
- E8 and E5 must coordinate on this design dependency.

**Recommendation:**
- Preferred Option: Decision Making includes a reflexive "try new procedure" action that fires occasionally (5% of decisions). This maintains the clean confidence dynamics without special cases.
- Alternative: Temporary confidence boost for new procedures (first 3 uses at 0.60, then standard ACT-R). Simpler to implement, but asymmetric with normal confidence rules.
- Decision needed before E5 implementation begins.

---

### Item 3: Constraint Validation Rigor

**Question:** How strict should constraint validation be? Should failed validations cause the opportunity to be deferred indefinitely, or should the system eventually give up and try anyway?

**Impact:**
- Strict validation prevents bad plans but may cause missed growth opportunities.
- Lenient validation allows some bad plans to be tried and learned from.

**Recommendation:**
- E8 specification correctly proposes: "If a proposal fails validation, revise and re-validate. Max 2 revisions. If still failing, defer the opportunity."
- This balances safety (no bad plans executed) with learning (opportunity remains queued for future attempts).
- Current spec is acceptable. No change needed.

---

## Summary

**Epic 8 (Planning subsystem) is CANON-COMPLIANT with manageable concerns.**

The planning pipeline (research → simulate → propose → validate → create) is well-architected and grounded in the CANON's core principles. Rate limiting, cold-start dampening, and priority decay prevent known attractor states. Plans are treated as testable hypotheses, not permanent solutions.

Four concerns require explicit handling before implementation:

1. **LLM constraint validation must be deterministic, not judgmental.** Structured prompts, explicit pass/fail logic, max 2 revisions.
2. **Contingency verification must be deep, not shallow.** Each plan step must have a corresponding, measurable drive effect contingency.
3. **New procedure retrieval threshold requires E5 coordination.** E5 must trial procedures below the 0.50 retrieval threshold.
4. **A.4 and A.5 are gaps but acceptable for Phase 1.** Operational detail provided by E8 is sufficient; full specification can be deferred.

With these concerns addressed in implementation planning and E5 coordination, Epic 8 is ready for code.

---

**Document Prepared By:** Canon, Project Integrity Guardian
**Date:** 2026-03-29
**CANON Version:** Current (immutable)
**Next Review Point:** E8 implementation session 1 (verify concern mitigations are in place)
