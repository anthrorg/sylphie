# Epic 8: Planning — Key Decisions

**Epic:** 8
**Phase:** 1
**Created:** 2026-03-29

---

## D1: Pipeline Architecture — Sequential 6-Stage with Async Queue Processing

**Decision:** The Planning pipeline follows 6 sequential stages (INTAKE → RESEARCH → SIMULATE → PROPOSE → VALIDATE → CREATE) with an asynchronous queue processing loop. Multiple Opportunities can be queued simultaneously, but each Opportunity is processed sequentially through all 6 stages.

**Rationale:** Sequential pipeline per-Opportunity ensures deterministic behavior and easier debugging. The queue handles concurrency — multiple Opportunities compete for processing time but don't run stages in parallel. This matches the CANON's emphasis on plans being grounded in evidence (each stage depends on the previous stage's output).

**CANON Reference:** §Subsystem 5: Planning, §Planning Simulation Methodology (A.5 reserved)

**Agents:** Planner, Forge

---

## D2: Simulation Methodology — Historical Pattern Matching (Phase 1 Default)

**Decision:** CANON Appendix A.5 (Simulation Methodology) is reserved. For Phase 1, use conservative historical pattern matching: "when action X was taken in context Y, outcome was Z." Estimate drive effects by averaging similar past actions' outcomes from the WKG. Success probability from event frequency.

**Rationale:** Full simulation is out of scope for Phase 1. Historical pattern matching is grounded in actual experience (CANON principle: Experience Shapes Knowledge). Conservative estimates prevent overconfident plans. Ashby analysis confirms this approach is adequate for Phase 1's variety requirements.

**CANON Reference:** §A.5 (reserved), Roadmap §Epic 8 recommended default

**Risk:** Sparse WKG in early operation means poor estimates. Mitigated by cold-start dampening and evidence sufficiency gates.

**Agents:** Planner, Ashby

---

## D3: Cold-Start Dampening — Linear Ramp (0.8 → 0.0 over 100 decisions)

**Decision:** Linear dampening from 80% weight reduction at decision 0 to 0% at decision 100. Configurable threshold.

**Rationale:** Prevents Prediction Pessimist attractor state. Piaget analysis confirms developmental justification — early failures reflect sparse representation, not inadequate planning. Ashby recommended sigmoid as an optimization but confirmed linear is adequate for Phase 1.

**Alternative Considered:** Sigmoid dampening matching ACT-R logarithmic growth. Deferred to Phase 1+ optimization based on runtime data.

**CANON Reference:** §Known Attractor States: Prediction Pessimist

**Agents:** Planner, Piaget, Ashby

---

## D4: Rate Limiting Parameters — 3 Plans/Hour, 10 Active Max, 50 Queue Max

**Decision:** Rate limiter enforces: max 3 plans created per 1-hour window, max 10 active plans (created but not yet evaluated), max 4000 LLM tokens per plan. Opportunity queue max size 50 with 10% hourly priority decay.

**Rationale:** Prevents Planning Runaway attractor state. Ashby stability analysis confirms these parameters are conservative and adequate for Phase 1 conversational environment. Queue equilibrium analysis shows queue_depth = 5 × failure_rate, meaning queue saturates only when failure rate exceeds 10/hour (pathological).

**CANON Reference:** §Known Attractor States: Planning Runaway, §Planner agent profile §3.7

**Agents:** Planner, Ashby

---

## D5: Procedure Confidence Lifecycle — Standard ACT-R, No Special Treatment

**Decision:** Plan procedures follow identical ACT-R confidence dynamics as all other knowledge. Base confidence 0.35 (LLM_GENERATED provenance). No special confidence boosting for plans. The retrieval threshold tension (0.35 < 0.50) is a dependency on E5 (Decision Making), not a Planning subsystem problem.

**Rationale:** CANON requires uniform confidence dynamics (Planner agent rule 3). Giving plans special treatment would violate the principle that all knowledge earns its place through use. The trial mechanism must be implemented in Decision Making (E5), not in Planning.

**CANON Reference:** §Confidence Dynamics (ACT-R), §Immutable Standard 3 (Confidence Ceiling), Planner agent §3.5

**Dependency:** E5 must implement a mechanism to trial procedures below retrieval threshold.

**Options for E5 (per Piaget/Planner consensus):**
- (A) "Try new procedure" reflex action that occasionally queries 0.30-0.50 confidence range
- (B) Temporary confidence boost for procedures < 24 hours old (first 3 uses at 0.60)
- (C) Dedicated "experimental" action selection alongside standard selection

**Agents:** Planner, Piaget, Canon, Forge

---

## D6: LLM Constraint Engine — Structured Validation, Not Judgment

**Decision:** The LLM constraint engine uses structured validation prompts with explicit PASS/FAIL outputs. The LLM checks coherence (does the plan make logical sense?) and assists with complex standard checks. It does NOT make decisions about whether to proceed. Deterministic checks (Immutable Standards 1-6) are implemented as code-level validators where possible, with LLM assisting only for natural-language coherence assessment.

**Rationale:** Canon analysis flagged the risk of the LLM becoming a decision-maker rather than a validator. CANON principle: "The LLM is her voice, not her mind." Constraint validation must be deterministic where possible. Max 2 revision attempts per failed proposal.

**CANON Reference:** §Core Philosophy: LLM Provides Voice, §Immutable Standards (all 6)

**Agents:** Canon, Planner, Forge

---

## D7: Post-Execution Evaluation — Mandatory, Not Optional

**Decision:** Every plan execution MUST produce a PlanEvaluation event. Plan failures are emitted as PLAN_FAILURE events that the Drive Engine can pick up for new Opportunity creation. This closes the feedback loop.

**Rationale:** CANON explicitly states: "Plans must be evaluated AFTER execution, not just before." Plans are hypotheses. Without post-execution evaluation, the system cannot learn from plan outcomes, and confidence never updates. Planner agent core principle: "Plans are hypotheses, not solutions."

**CANON Reference:** §Subsystem 5: Planning ("Plan execution feedback"), Planner agent §3.6

**Agents:** Planner, Canon

---

## D8: Developmental Readiness Gate — Configurable, Not Hard-Blocked

**Decision:** Planning activation uses configurable readiness checks: minimum WKG node count, minimum decision count (cold-start dampening serves this role), and minimum prediction history. These are soft gates via configuration, not hard-coded blocks.

**Rationale:** Piaget recommended developmental readiness gates (100+ WKG nodes before Planning activates). This is valid developmental theory but should be configurable rather than hard-coded. Cold-start dampening already provides the primary gate. Additional readiness checks are implemented as configurable thresholds.

**CANON Reference:** §Core Philosophy: Experience Shapes Knowledge

**Agents:** Piaget, Planner, Ashby

---

## D9: No Direct Subsystem Coupling — Events and WKG Only

**Decision:** Planning communicates with other subsystems exclusively through TimescaleDB events and WKG reads/writes. No direct service-to-service calls across module boundaries (except for read-only injections of IDriveStateReader and ILlmService).

**Rationale:** CANON architecture requires subsystem communication through shared stores. Forge enforces this structurally through NestJS module boundaries. Planning reads drive state (one-way), uses LLM service (for validation), reads/writes WKG, and reads/writes TimescaleDB events. No other cross-module dependencies.

**CANON Reference:** §Architecture: Five Subsystems, §Shared Infrastructure

**Agents:** Forge, Canon

---

## D10: Queue Priority Decay — Exponential at 10%/Hour

**Decision:** Opportunity priorities decay exponentially at 10% per hour. Queue is pruned of items below 0.01 priority. Max queue size 50 with lowest-priority eviction.

**Rationale:** Ashby stability analysis confirms exponential decay produces stable equilibrium. Priority drops to ~0.35 after 10 hours, ensuring stale Opportunities fade. Hard max size prevents unbounded accumulation even under burst failure conditions.

**CANON Reference:** §Subsystem 5: Planning ("Opportunity priority queue with decay")

**Agents:** Ashby, Planner
