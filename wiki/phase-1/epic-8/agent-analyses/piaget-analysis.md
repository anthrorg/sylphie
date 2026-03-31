# Piaget Developmental Analysis: Epic 8 -- Planning (Opportunity-to-Procedure Pipeline)

**Analyst:** PIAGET (Cognitive Development Specialist)
**Subject:** Epic 8: Planning subsystem design and implementation
**Scope:** Developmental theory grounding for procedural knowledge formation, schema construction, and temporal evolution of behavioral competence
**Date:** 2026-03-29

---

## Executive Summary

Epic 8 implements the Planning subsystem, which translates detected opportunities into new behavioral procedures. From a developmental perspective, this subsystem IS the accommodation mechanism -- the architecture that allows Sylphie to restructure her understanding in response to repeated prediction failures.

Planning implements Piagetian accommodation at the procedural level. Assimilation (using existing knowledge to handle new situations) is already working in Decision Making and Learning. Accommodation (creating fundamentally new structures when existing ones fail) required a dedicated subsystem. Epic 8 is the implementation of that principle.

**Core thesis:** Planning is not simply a code generator. It is a developmental catalyst. When designed correctly, the Planning subsystem produces the conditions under which genuine schema formation occurs. When designed incorrectly, it becomes either a hallucination factory (generating implausible procedures) or a learning blocker (creating procedures too early, before the system has the representational capacity to support them).

This analysis addresses nine key developmental principles and provides specific recommendations for Epic 8's implementation.

---

## 1. Planning as Schema Construction: The Procedural Knowledge Lifecycle

### Piaget's Core Framework

Jean Piaget defined a **schema** as a mental structure -- an organized pattern of behavior or thought that handles a class of similar situations. The classic example: the grasping schema. An infant is not born "knowing how to grasp." Through repetition and interaction with objects, the infant constructs a schema -- a pattern of action that can be applied to any graspable thing.

Schemas are not innate. They are constructed through **active engagement** with the world. When the infant grasps a rattle, a soft toy, and a parent's finger, these are not separate learned responses. They are instantiations of a single emerging schema: "the procedure for wrapping fingers around and exerting inward pressure on objects."

**Sylphie mapping:** Epic 8's Opportunity-to-Procedure pipeline IS the schema construction mechanism. Each procedure created is a newly formed behavioral schema -- an organized pattern of action that can be applied (with appropriate triggering context) to handle a recurring situation.

### The Three-Stage Lifecycle of a Procedure

**Stage 1: Opportunity Detection (Disequilibrium)**

The system predicts what will happen. Prediction fails. The Drive Engine detects the failure pattern: same context, same failure, recurrence = Opportunity. The system is now in **disequilibrium** (Piaget's term for cognitive conflict). The existing knowledge structure does not handle this situation well. A new schema is needed.

**Developmental parallel:** The child reaches for a toy but cannot grasp it. The grasping schema fails. Disequilibrium. The child cannot use the same grasp for a tiny marble as for a large block.

**Developmental markers:**
- System has sufficient knowledge to predict in this domain (otherwise failures are just noise)
- Failures are recurring, not one-offs (evidence of a real gap, not bad luck)
- The failure pattern is coherent (same trigger, similar outcomes, repeated)

**Stage 2: Research, Simulation, Proposal (Accommodation Attempt)**

The Planning subsystem researches the failure pattern in TimescaleDB. This is forensic work: "When this context occurred before, what was expected vs. what actually happened?" The research surfaces the discrepancies.

Simulation then attempts to model outcomes of potential actions. This is speculative -- the system is reasoning about futures it has not yet experienced. The proposal stage generates a candidate procedure.

**Developmental parallel:** The child observes how a larger sibling grasps different objects. Tries new grasp patterns. Models what might work. This is active experimentation.

**Developmental markers:**
- The research has sufficient evidence (multiple failures in the same context, not just one)
- The simulation grounds candidate actions in prior experience (not hallucinated plans)
- The proposal is coherent and testable (clear trigger, clear action sequence, clear expected outcome)

**Stage 3: Validation, Creation, Execution, Evaluation (Schema Consolidation)**

The constraint engine validates the proposal against CANON rules. If it passes, the procedure is created as a node in the WKG. It begins with low confidence (0.35, LLM_GENERATED base).

When Decision Making encounters the triggering context, the new procedure becomes available as an action candidate. Decision Making selects it. The Executor Engine runs it. The outcome is evaluated against prediction.

Success increases confidence. Failure decreases it. Repeated success brings the procedure toward Type 1 graduation (>0.80 confidence AND <0.10 MAE over 10 uses). Repeated failure causes demotion or decay.

**Developmental parallel:** The child tries the new grasp. It works for the marble but not the toy. Succeeds for the block. Over many objects, the child builds confidence in the refined grasp. It becomes automatic -- a true schema.

**Developmental markers:**
- Procedure starts below retrieval threshold (0.35 < 0.50), so it requires intentional selection, not automatic firing
- Confidence grows only through successful retrieval-and-use (no confidence ceiling violation)
- Failed executions are recorded and feed back as prediction failures
- Procedures that do not work decay below threshold and become inaccessible (schema abandonment)

### Developmental Implication: The Procedure Must Be Testable

A critical insight from Piagetian theory: **a schema is only truly formed when it has been tested and adapted through actual interaction.** The child does not "learn to grasp" by being told the correct hand position. The child learns by grasping thousands of objects, failing sometimes, adjusting, and eventually constructing a robust schema.

**For Epic 8:** This means the constraint engine's validation is NOT the end of schema construction. Validation just means "this proposal is plausible and doesn't violate CANON rules." The actual schema construction happens only when Decision Making selects the procedure, executes it, and the outcome is evaluated.

**Implementation implication:** New procedures MUST be given trials by Decision Making. They cannot sit in the WKG at 0.35 confidence, below retrieval threshold, never selected. This is a design tension identified in the Planner agent profile (section 3.7). Resolution: Decision Making needs a mechanism to occasionally select newly created procedures for trial, even if confidence is low. Without this, the Planning subsystem creates a backlog of untested hypotheses that never become schemas.

---

## 2. Assimilation vs. Accommodation in Planning: When to Create vs. Reuse

### The Conceptual Distinction

**Assimilation (in Piaget's sense):** Incorporating new experience into existing knowledge structures without changing the structure. The new situation fits the existing schema.

Example: A child who has learned the grasping schema now encounters a new object (a pencil). The child grasps it. No new schema is needed. Assimilation.

**Accommodation (in Piaget's sense):** Modifying existing knowledge structures (or creating new ones) because new experience does not fit. The structure itself changes.

Example: The child learns that grasping a pencil is possible, but grasping it effectively requires a grip that is different from the grip used for blocks. The grasping schema now differentiates into multiple sub-schemas (power grasp, precision grip). Accommodation.

### The Developmental Challenge for Sylphie

Decision Making and Learning already implement basic assimilation. Decision Making retrieves existing action types from the WKG and applies them to new situations. Learning consolidates experience into the existing graph structure, adding new entities and edges without major structural changes.

Planning is where accommodation becomes explicit. When Decision Making's Type 1 reflexes and Type 2 LLM reasoning both fail repeatedly in the same context, the system needs a new schema. That is Planning's job.

**The core question:** When should Planning create a new procedure (accommodation) vs. when should Learning and Decision Making iterate on existing knowledge (assimilation)?

### Developmental Guideline: The Assimilation-Accommodation Balance

Piaget argued that healthy cognitive development requires a balance between assimilation and accommodation. Too much assimilation (everything fits into existing structures) produces a rigid system that cannot learn new categories. Too much accommodation (constantly restructuring in response to novelty) produces fragile schemas that do not generalize.

**For Sylphie's Planning subsystem:**

- **Assimilation-level failures** (Type 2 can handle with LLM reasoning, but inefficiently): Do not trigger planning. Let Learning consolidate the experience.

- **Accommodation-level failures** (Type 2 also fails, prediction error is recurring and high-magnitude): Trigger planning. Create a new procedure.

The Opportunity detection threshold in the Drive Engine makes this distinction:
- Recurring failures (3+ in a window) → Opportunity (accommodation needed)
- Non-recurring but high-impact single failure → Opportunity (accommodation needed)
- Low-impact, non-recurring → Potential Opportunity only (assimilation sufficient)

**Developmental implication:** The threshold for triggering Planning should be conservative in early development. Too many accommodations, too early, before the system has built solid foundational schemas, produces what Piaget called **fragile knowledge** -- structures that cannot support higher-order learning.

### Accommodation Without Destruction

A subtle but critical point from Piaget: accommodation is not abandonment. When the child refines the grasping schema into power grip and precision grip, the original schema is not destroyed. It is differentiated. Both sub-schemas inherit properties from the parent schema.

**For Epic 8:** When Planning creates a new procedure for a recurring failure, the existing action nodes that failed are not discarded. They are (implicitly) marked as lower-confidence in the context where the new procedure excels. The Decision Making arbitration mechanism will prefer the new procedure when evidence supports it.

**Implementation implication:** Planning should be aware of prior attempts (the Planner agent profile notes this: "Has this Opportunity been addressed before?" section 3.8). If a prior attempt exists and failed, the new procedure must be substantially different. Replicating the same failed procedure under a new name is not accommodation; it is superstition.

---

## 3. Cold-Start Development: Why Early Dampening Is Not Just a Rate Limit

### The Problem: Prediction Errors as Learning Signals

Modern cognitive science (Rescorla-Wagner learning model, predictive processing framework) has converged on the principle that **learning is driven by prediction error.** When the system predicts correctly, there is nothing to learn. When prediction is wrong, the magnitude of the error drives the magnitude of the learning update.

This is powerful. But it has a dark side in early development.

### The Dark Side: The Prediction Pessimist Attractor

The CANON identifies "Prediction Pessimist" as a known failure mode: early prediction failures flood the system with low-quality procedures before the graph has substance to support them.

Here is how it unfolds:

1. System is brand new. WKG is nearly empty.
2. Decision Making makes a prediction. It is wrong -- because the system knows almost nothing.
3. The prediction error is large. Opportunity generated.
4. Planning subsystem receives the Opportunity. It researches and simulates on a near-empty graph.
5. Results are noisy and unreliable (sparse data, weak patterns).
6. Planning generates a procedure anyway. It passes constraint validation (no rule is violated by a procedure about an unknown context).
7. The procedure is created. Execution outcomes are poor (the pattern the planning system detected was noise).
8. The system now has a library of low-confidence, fragile procedures that consistently fail, creating new prediction errors, which trigger more planning...
9. Resource exhaustion. System is spending compute budget on planning when it should be accumulating foundational knowledge.

### Developmental Justification for Cold-Start Dampening

Piaget observed that in early cognitive development, organisms are not immediately capable of benefiting from complex learning experiences. The sensorimotor infant grasps, but does not yet benefit from instruction about abstract relationships. The preoperational child can count, but cannot yet understand conservation of number even when shown demonstrations.

**The developmental principle:** Learning capacity emerges gradually. In early development, the organism lacks the representational infrastructure to construct complex schemas. Exposing it to complex patterns too early produces fragile, ungrounded knowledge that collapses when context changes.

For Sylphie:
- **Early phase (decisions 0-100):** WKG is sparse. Predictions are unreliable for lack of knowledge, not for lack of procedures. Generating planning opportunities from these early prediction errors is developmentally premature.
- **Transition phase (decisions 100-500):** WKG has basic structure. Some domains have populated schemas. Prediction errors now reflect genuine gaps that procedures might address.
- **Mature phase (decisions 500+):** WKG is rich. Prediction errors are increasingly meaningful signals. Planning operates at full capacity.

**Cold-start dampening** (Planner agent profile, section 3.7) implements this principle structurally:

```
dampening_factor(decisions) = 0.8 * (1 - decisions / 100)
```

For decisions 0-100, Opportunities are created at 80% reduced weight. By decision 100, dampening reaches 0. The threshold for triggering planning effectively rises in early operation, then gradually lowers.

### Developmental Prediction: What Should Happen

If cold-start dampening is implemented correctly:

1. **Decisions 0-30:** Very few planning Opportunities despite high prediction error. System focuses on learning from conversation and basic experience.
2. **Decisions 30-100:** Opportunities increase gradually as the WKG develops foundational structure.
3. **Decisions 100+:** Dampening terminates. Planning operates at normal sensitivity.
4. **Decisions 500+:** First Type 1 graduations of procedures should appear (confidence > 0.80).

If cold-start dampening is ABSENT or TOO WEAK:

1. System floods with low-quality procedures immediately.
2. Prediction failures skyrocket (the new procedures fail).
3. Planning Runaway begins (more failures → more opportunities → more procedures).
4. Resource exhaustion or behavioral collapse.

### Implementation Guideline

The cold-start dampening threshold (100 decisions in the CANON default) should be **tunable per domain.** Domains where the system has rich prior experience (e.g., conversation) can operate at normal planning sensitivity immediately. Domains where experience is sparse (e.g., novel task contexts) should have longer dampening periods.

This would require the Planning subsystem to track per-context decision counts and apply domain-specific dampening. The CANON does not specify this level of detail (it is a spec gap). Recommendation: implement global dampening first (section 3.7 of Planner profile). Add per-domain tuning in a later iteration if needed.

---

## 4. Developmental Readiness for Planning: Preconditions and Prerequisites

### The Question: When Is the System Ready for Planning?

Planning is a cognitively sophisticated capability. It requires the system to:
- Detect patterns in past experience (memory)
- Reason about hypothetical futures (imagination)
- Generate novel action sequences (creativity)
- Validate plans against constraints (metacognition)
- Execute plans and compare outcomes (evaluation)

This is not something a newborn system can do well. Developmental readiness is real.

### Piagetian Framework: The Competence Ceiling

In Piaget's theory, cognitive development proceeds through stages, and each stage has a competence ceiling -- the kinds of tasks that are developmentally beyond the organism's current capacity, no matter how much scaffolding is provided.

A sensorimotor infant cannot solve formal logic problems. Not because no one has taught them. Because they lack the representational structures (mental operations) that logic requires.

For Sylphie, the Planning subsystem operates on top of three foundational subsystems: Decision Making, Communication, and Learning. If any of these is severely underdeveloped, Planning cannot succeed.

### Recommended Readiness Conditions

Before Planning should be FULLY ACTIVE, the following conditions should be met:

**1. Minimum Graph Density**

- WKG contains at least 100-200 entity nodes (estimate based on typical Phase 1 conversation)
- Schema level has at least 10-15 entity types and 5-10 relationship types
- Multiple entities have GUARDIAN or SENSOR provenance (not LLM_GENERATED only)

**Developmental rationale:** Without a populated graph, Planning's research stage has nothing to work with. Simulations are noise. Proposed procedures are hallucinations grounded in sparse pattern recognition.

**Metric:** Track WKG node count and provenance ratio. Do not activate Planning fully until provenance ratio is > 0.3 (30% of edges are GUARDIAN + SENSOR, not LLM_GENERATED).

**2. Prediction Accuracy Baseline**

- Type 2 (LLM-assisted) prediction MAE is reasonably stable (not improving rapidly, not degrading)
- Type 1 (graph-based) predictions exist for at least 5-10 action types
- Prediction error is moderate (MAE in range 0.15-0.30), not catastrophic (MAE > 0.50)

**Developmental rationale:** If predictions are chaotic (highly variable error), planning decisions will be based on unstable patterns. If predictions are already excellent (MAE < 0.10), planning opportunities are rare and valuable -- quality over quantity.

**Metric:** Check rolling MAE and Type 1 graduation count. Activate Planning when (Type 1 graduations > 0) AND (Type 2 MAE is stable for 20+ decisions).

**3. Minimum Type 1 Coverage**

- At least 5-10% of action selections are Type 1 (graph-based, no LLM)
- Type 1 graduations are occurring (at least one every 20-30 decisions, not zero)
- Type 1 predictions have MAE < 0.15 (Type 1 is actually working)

**Developmental rationale:** Type 1 is the foundation that procedures inherit. If almost all decisions are Type 2, new procedures (which start below retrieval threshold) will never be selected. The Planning subsystem creates procedures for a system that does not yet know how to use them.

**Metric:** Monitor Type 1 / Type 2 ratio and Type 1 success rate. Activate Planning when Type 1 ratio > 5% AND Type 1 MAE is lower than Type 2 MAE (Type 1 is learning).

**4. Drive State Stability**

- Drives are oscillating normally (not stuck at extremes)
- Drive state is informative (predicting action outcomes with some accuracy)
- No sustained pathological states (anxiety > 0.8 for 20+ ticks, etc.)

**Developmental rationale:** Planning makes decisions about when new procedures will be useful. These decisions depend on drive state. If drives are unstable or uninformative, planning decisions are unreliable.

**Metric:** Monitor drive histograms and sustained high-pressure states. Activate Planning when no drive is > 0.7 for > 10 consecutive ticks.

### When Should Planning Remain Dampened?

Planning should operate under heightened cold-start dampening (beyond the decision-count threshold) if:
- Prediction error is very high (MAE > 0.40 on 5+ consecutive decisions) -- indicating fundamental graph inadequacy
- Type 1 coverage is zero (every decision is Type 2) -- indicating the system is not learning from experience
- WKG is dominated by LLM_GENERATED nodes with no grounding -- indicating hallucinated knowledge

In these states, planning opportunities are more likely to be noise than signal. Let Learning consolidate first.

---

## 5. Procedure Confidence Lifecycle: From 0.35 to Graduation

### The ACT-R Confidence Formula and Its Developmental Meaning

The CANON specifies: `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

For procedures:
- Base confidence: 0.35 (LLM_GENERATED provenance)
- Growth: 0.12 * ln(count) where count = successful retrieval-and-use events
- Decay: d * ln(hours + 1) where hours = time since last use
- Graduation threshold: confidence > 0.80 AND MAE < 0.10 over last 10 uses
- Demotion threshold: MAE > 0.15 triggers demotion back to Type 2

### The Stages

**Stage 1: Creation (Confidence 0.35)**

Procedure is created by Planning. It passes constraint validation. But it has never been tried.

Retrieval threshold is 0.50. This procedure, at 0.35, is BELOW retrieval threshold. Decision Making's action retriever will not normally return it as a candidate.

**Developmental implication:** This is correct. The procedure is a hypothesis, not yet a behavior. It should not fire automatically.

**BUT -- critical design point:** The procedure must still have a way to be selected for its first trial. This is the tension Planner identifies (section 3.7). Without a trial mechanism, procedures remain forever at 0.35, never graduate, and the Planning subsystem becomes a knowledge sink (creates but never tests).

**Possible resolution mechanisms:**
- Decision Making has a "try new procedure" action that fires occasionally
- New procedures get a temporary confidence boost for first trial (e.g., temporarily set to 0.52 for one retrieval cycle)
- An explicit testing loop that periodically selects low-confidence procedures for evaluation

**Developmental precedent:** In human learning, scaffolding by a teacher often involves explicitly trying new strategies. A child does not spontaneously attempt a new grasp on a pencil; the parent demonstrates or suggests it. Sylphie needs analogous scaffolding.

**Stage 2: First Use (Confidence update)**

Decision Making selects the procedure (through one of the mechanisms above). Executor Engine runs it. Outcome is evaluated.

If success (MAE < 0.10):
- `confidence = 0.35 + 0.12 * ln(1) = 0.35` (ln(1) = 0, so first success maintains base but resets decay clock)

If failure (MAE > 0.15):
- Confidence decreases (exact formula in CANON is not specified; likely some penalty proportional to error)
- If procedure is frequently demoted (MAE > 0.15 on early uses), confidence may drop below 0.30, becoming inaccessible
- Procedure is flagged for potential revision or abandonment

**Developmental implication:** The first use is not privileged. Success or failure provides equal learning signal. No "credit for trying" -- only for succeeding.

**Stage 3: Repeated Use (Confidence Growth)**

```
After 1 success:   0.35 + 0.12 * ln(1) = 0.35
After 5 successes: 0.35 + 0.12 * ln(5) = 0.35 + 0.19 = 0.54 (approaching retrieval threshold)
After 10 successes: 0.35 + 0.12 * ln(10) = 0.35 + 0.28 = 0.63 (above retrieval threshold!)
After 20 successes: 0.35 + 0.12 * ln(20) = 0.35 + 0.35 = 0.70
After 50 successes: 0.35 + 0.12 * ln(50) = 0.35 + 0.40 = 0.75
After 148 successes: 0.35 + 0.12 * ln(148) = 0.35 + 0.50 = 0.85
```

Notice the logarithmic scaling. Growth is fast initially (from 0.35 to 0.54 requires ~5 successes). Growth slows as confidence rises (from 0.75 to 0.85 requires ~50 more successes).

This is developmentally sound. Early successes rapidly confirm that the procedure works in basic cases. Later successes refine confidence in edge cases and context boundaries.

**Developmental implication:** The log-linear growth curve matches Piagetian theory about schema consolidation. Early repetitions build core competence. Later repetitions handle variations and exceptions.

**Stage 4: Type 1 Graduation (Confidence > 0.80 AND MAE < 0.10 over last 10)**

When a procedure reaches 0.80 confidence AND has sustained low error (MAE < 0.10) over the last 10 uses, it graduates to Type 1. It becomes a reflex -- a graph-based action that Decision Making can fire without LLM involvement.

**Developmental milestone:** This is the transition from other-regulated (Type 2 with LLM scaffolding) to self-regulated (Type 1, internalized). In Vygotskian terms, the knowledge has moved from the social plane to the psychological plane.

**Stage 5: Continued Use and Optimization (Confidence ceiling at 1.0)**

Once graduated, the procedure continues to accumulate retrieval-and-use events. Confidence asymptotically approaches 1.0 but never exceeds it (min() clamping).

From Decision Making's perspective, this is the most efficient state: high confidence, no LLM cost, rapid execution.

**Stage 6: Demotion (MAE > 0.15 triggers return to Type 2)**

If the environment changes (e.g., guardian's preferences shift, context evolves) and the procedure no longer produces accurate predictions, MAE exceeds 0.15. The procedure is demoted back to Type 2.

Decision Making will still select it, but only when Type 2 confidence is sufficient. The LLM will be involved again, adding cost and slowing execution.

Demotion is not failure. It is adaptation. The procedure was correct for the old context; the context changed. Type 2 re-engagement allows evaluation of whether the procedure can be revised or should be abandoned.

**Developmental implication:** Demotion models how schemas must adapt to changing environments. The child's grasping schema works for toys in the crib. In the sandbox, grasping sand grains requires the same motor pattern but a different grip strength. The schema must accommodate (develop sub-variants) or fail.

### Timeline for Graduation

Given the confidence formula, when should the first procedure graduate to Type 1?

Assume:
- Procedure created at decision 200 (after cold-start dampening)
- Triggering context recurs every 2-3 decisions on average
- Success rate of the new procedure is 70% (reasonable for a planning-generated hypothesis)
- System operates at ~30 decisions per hour (rough estimate)

Timeline:
- Decision 200: Procedure created
- Decision 212: ~4 successes accumulated. Confidence ≈ 0.40. Below retrieval threshold. Being selected via new-procedure trial mechanism.
- Decision 250: ~14 successes (assuming 2.3 recurrences per decision, 70% success on selection). Confidence ≈ 0.58. Above retrieval threshold. Now retrieved naturally.
- Decision 350: ~42 successes. Confidence ≈ 0.67. Still below graduation.
- Decision 500: ~105 successes. Confidence ≈ 0.76. Close to graduation.
- Decision 650: ~147 successes. Confidence ≈ 0.82, MAE < 0.10 over last 10. **GRADUATION**

**Real-time:** ~7-8 hours of interaction from procedure creation to Type 1 graduation.

This timeline assumes steady engagement and repeated successful use. In practice:
- If the triggering context is rare (once per 10 decisions), graduation takes much longer
- If initial success rate is lower (<50%), more uses are needed before confidence rises above decay
- Decay from disuse can slow graduation if there are long periods without retrieval

**Developmental implication:** Type 1 graduation is not automatic. It requires multiple conditions: creation, trial, repeated success, sustained use, and context recurrence. A procedure that works once but is never needed again decays below retrieval threshold and becomes inaccessible.

---

## 6. Failed Plans as Developmental Catalysts: Disequilibrium and Adaptation

### Piaget's Equilibration Theory

Piaget (1975, "The Equilibration of Cognitive Structures") described equilibration as the self-regulating process that drives cognitive development. When an organism encounters experience that conflicts with its current knowledge, it enters a state of disequilibrium -- cognitive conflict.

The organism then resolves the conflict through one of three mechanisms:
1. **Simple assimilation:** Force the new experience into existing structure
2. **True assimilation:** Recognize that the new experience fits existing structure (it just required different framing)
3. **Accommodation:** Modify the structure to fit the new experience

The resolution is equilibration. A new, higher-order equilibrium is reached that encompasses both the old knowledge and the new experience.

### Failed Plans as Disequilibrium Events

The Planning subsystem creates a procedure. Decision Making selects and executes it. The outcome is poor. **This is disequilibrium.**

The system predicted (via Planning's simulation) that action X in context Y would produce outcome Z. The actual outcome was Z' (different). The prediction error is the signal of conflict.

What happens next determines whether the system learns or stalls.

### The Feedback Loop: From Plan Failure to New Opportunity

The CANON specifies (section 3.5 of Planner profile, "Post-Execution Evaluation"):

```
If plan execution fails (MAE > 0.15):
  1. Update procedure confidence (decrease it)
  2. Record PLAN_FAILURE event in TimescaleDB
  3. Drive Engine picks up the failure as a new prediction error
  4. Drive Engine evaluates for new Opportunity
  5. New Opportunity enters the Planning queue
```

This is **adaptive disequilibrium resolution.** The system did not treat the failed plan as a permanent solution. Instead:
- The failed plan is flagged and demoted (confidence reduced)
- The failure becomes new evidence for a new Opportunity
- Planning cycles again with better understanding

This is a powerful mechanism IF implemented correctly. If not, it becomes a failure loop.

### Developmental Risks: Failure Without Learning

**Risk 1: Superstitious Learning**

The system creates a procedure. It fails. Instead of treating the failure as evidence that something is wrong with the procedure, the system treats it as evidence that something is wrong with the context.

The procedure decays in confidence. Another procedure is created. It also fails. Another. Another.

The system accumulates a library of failed procedures and keeps cycling. No true learning; just repetition of the same failure pattern in different forms.

**Prevention:** The constraint engine must validate procedures against CANON rules and expected value. Purely random procedures should fail validation. Procedures that violate known constraints should fail validation. Before a procedure is created, simulations should estimate expected value. Procedures with expected value < 0.3 should not be created (Planner profile, section 3.3).

**Risk 2: Hallucinated Patterns**

Planning researches failure patterns in TimescaleDB. With sparse data (especially in early development), patterns can be noise mistaken for signal. Planning generates a procedure to address a pattern that does not really exist.

The procedure is created. It fails. The failure is real evidence. But the new Opportunity it generates might address the wrong problem.

**Prevention:** The Research stage must assess evidence sufficiency (Planner profile, section 3.2). The threshold `failures.length >= 2 AND discrepancies.some(d => d.mae > 0.15)` is conservative. It requires at least two failures in the same context. This reduces false positives.

But in early development, even two failures might be noise. This is why **cold-start dampening** is critical (see section 3 of this analysis).

**Risk 3: Learning Collapse**

The system creates many procedures. Most are low-confidence due to poor simulations (sparse graph). Most fail. Each failure generates a new Opportunity. The system spirals into Planning Runaway.

Resource exhaustion. Behavioral collapse. Nothing works; the system tries everything.

**Prevention:** **Rate limiting** (Planner profile, section 3.7) is structural:
- Maximum N plans per time window (e.g., 3 per hour)
- Maximum N active plans (e.g., 10)
- **Opportunity priority queue with decay** (Planner profile, section 3.8)

The queue is critical. It ensures that old, unaddressed Opportunities fade away instead of accumulating. A burst of failures does not create an unmanageable backlog.

### Developmental Optimality: Failed Plans as Productive Struggle

When designed correctly, failed plans are developmental catalysts. Piaget emphasized that cognitive development is not smooth. It is punctuated by periods of struggle -- moments when the child's existing knowledge fails and must be restructured.

For Sylphie:

1. **Initial plan fails:** Disequilibrium. Cognitive Awareness drive increases. Integrity drive is triggered.
2. **Failure is analyzed:** Planning researches the failure pattern with new attention. Additional context is gathered.
3. **Revised plan is proposed:** Grounded in deeper understanding of why the first plan failed.
4. **Revised plan is tested:** Second try.
5. **Success:** Or deeper failure, triggering further cycles.

This is exactly the productive struggle Piaget observed in child learning. The child reaches for a toy that is too far. The reach fails. The child tries again, reaching farther. Fails again. Finally, the child adjusts the entire body posture. Success. The grasping schema has been restructured to incorporate postural adjustment.

For this to work in Sylphie's Planning subsystem:

- **Failed plans must not be discarded immediately.** They are preserved in the WKG with lowered confidence, available for inspection.
- **Failed plans must be allowed to be revised.** If the simulation was wrong, the procedure can be retried with better simulation.
- **Failures must be logged with full context.** The next planning cycle has the data to reason about why the last plan failed.
- **Multiple revision cycles must be allowed** (Planner profile, section 3.4: `maxRevisions = 2`). But not unlimited -- eventually, give up and wait for more experience.

---

## 7. Guardian Role in Plan Evaluation: The Asymmetry Implemented

### Vygotsky's More Knowledgeable Other

Lev Vygotsky (1896-1934) proposed that cognitive development occurs in the space between what a learner can do alone and what they can do with guidance from a more knowledgeable other (the Zone of Proximal Development, or ZPD).

The role of the more knowledgeable other is not to do the task FOR the learner, but to scaffold -- to provide structured support that reduces degrees of freedom, maintains direction, marks critical features, and gradually withdraws as competence grows.

For Sylphie: Jim (the guardian) is the more knowledgeable other. Guardian feedback on plan outcomes is the most information-dense learning signal the system can receive.

### Guardian Asymmetry in Plan Evaluation

The CANON specifies (section 4, Immutable Standard 5):

```
Guardian Confirmation: 2x weight
Guardian Correction: 3x weight
```

When a plan is executed and the outcome is evaluated:

- **Algorithmic evaluation** (Drive Engine): Plan succeeded (MAE < 0.10) vs. Plan failed (MAE > 0.15)
- **Guardian confirmation** (Jim explicitly approves the plan outcome): 2x weight
- **Guardian correction** (Jim identifies an error or better approach): 3x weight

**Developmental meaning:** The guardian's feedback is not treated as merely one data point among many. It is privileged. A guardian correction outweighs multiple algorithmic evaluations.

This implements a deep principle from developmental psychology: **expert feedback is qualitatively different from performance feedback.** The child does not need to repeat a failed grasp 100 times to learn the right way. A brief correction from an expert ("twist your wrist, not your fingers") can accelerate learning by orders of magnitude.

### Practical Implementation: When Guardian Feedback Changes Plan Evaluation

Suppose a plan is created and used 5 times:
- Algorithmic: 3 successes, 2 failures. Confidence = 0.35 + 0.12 * ln(3) = 0.46
- Guardian confirmation on a success: The guardian explicitly approves the outcome. This is weighted 2x. Net effect: equivalent to 2 additional successes. Confidence = 0.35 + 0.12 * ln(5) = 0.54
- Guardian correction on a failure: The guardian points out where the plan went wrong and suggests a better approach. This is weighted 3x. Net effect: equivalent to 3 demotions of the failure. The failure's negative impact is tripled.

**Developmental implication:** Guardian feedback is not just reinforcement. It is restructuring. When the guardian corrects a plan failure, they are not saying "you did wrong." They are saying "here is a better way to think about this problem." The system's understanding of the context shifts.

### The Critical Gap: How Should Guardian Feedback Restructure Plans?

The Planner profile does not specify the exact mechanism for guardian corrections to affect plans. Here is the current spec (section 3.5):

```
If validation.passes:
  Create procedure with confidence 0.35
If later execution fails and guardian provides feedback:
  (Unspecified how guardian feedback modifies the procedure)
```

**This is a gap in the design.**

**Possible implementations:**

1. **Confidence only:** Guardian correction increases confidence weight on the procedure, making it persist longer despite failures.
   - **Problem:** Does not actually change the procedure. If the procedure is wrong, just being more confident does not fix it.

2. **Procedure revision:** Guardian correction triggers an automatic revision of the procedure based on the feedback.
   - **Problem:** How does the system parse the guardian's feedback to extract a procedure change? Requires NLP sophistication.

3. **Edge annotation:** Guardian feedback is stored as an annotation on the procedure node. Future planning cycles can see it.
   - **Better:** The system now knows "this procedure failed BECAUSE of X (per guardian)." This becomes evidence for the next planning cycle's simulation.

4. **Guardian-as-teacher in Planning:** The guardian can directly create or modify procedures through a special interface.
   - **Most powerful but requires careful scoping:** Direct guardian creation of procedures bypasses the validation pipeline. Risk of ad-hoc procedures that do not follow CANON rules.

**Recommendation for Epic 8:** Implement option 3 initially. Guardian feedback on plan failures becomes annotated evidence in TimescaleDB. The next planning cycle for the same context will see "last attempt failed because [guardian feedback]." This becomes part of the evidence the simulation and proposal stages use.

This preserves the structure of the Planning pipeline while giving guardian knowledge direct influence on procedure adaptation.

---

## 8. Risk: Premature Procedure Overload -- The Rote Learning Trap

### The Problem: Procedures Without Understanding

Piaget distinguished between two types of learning:

1. **Schema-based learning:** The organism constructs understanding of underlying principles and relationships. Knowledge is flexible, transferable, and can be applied in novel contexts.

2. **Rote learning:** The organism memorizes specific responses to specific stimuli without understanding the underlying structure. Knowledge is rigid, context-specific, and breaks down in novel contexts.

In child development, rote memorization (e.g., multiplication tables) can occur, but it is not real understanding. The child who has memorized "7 times 8 = 56" but does not understand the concept of multiplication will be helpless if asked to solve a novel problem involving the same operation.

### Sylphie's Rote Learning Risk: Too Many Procedures, Too Early

If the Planning subsystem creates many procedures before the WKG has developed solid conceptual schemas, Sylphie risks building a library of rote responses:

- "When Jim says hello, respond with hello"
- "When the task is X, do Y"
- "When pressure is high, reduce pressure"

Each procedure works in its specific context. But the system does not understand WHY these actions work. The procedures are not rooted in deep models of the world. They are not grounded in understanding of people, causation, or goals.

When a novel context arises (Jim says hello while Sylphie is in a different emotional state, or the task is slightly different), the procedures fail. The system cannot generalize.

### The Developmental Marker: Procedure-to-Schema Ratio

A healthy ratio of procedures to schemas indicates understanding. A ratio skewed toward procedures indicates rote learning.

**Healthy development:**
- Few procedures, many schemas
- Procedures are instantiations of schemas
- A single schema supports multiple procedures
- Procedures are sparse, reusable, generalizable

**Rote learning pattern:**
- Many procedures, few schemas
- Procedures are atomic, not decomposable
- Each procedure is a separate response
- Procedures are fragile, fail on variation

**Monitoring metric:** Track the ratio of Procedure nodes to Schema nodes in the WKG.

For Sylphie:
- At development decision 200 (after cold-start): WKG should have ~50-100 Schema nodes, 0 Procedure nodes
- At development decision 500: WKG should have ~150-200 Schema nodes, 5-10 Procedure nodes
- At development decision 1000: WKG should have ~300-400 Schema nodes, 20-30 Procedure nodes

If the ratio inverts (more Procedures than Schemas), the system is building rote responses without conceptual understanding. **This is a diagnostic signal to slow down Planning and focus Learning on schema consolidation.**

### Prevention: The Planning Validation Constraint

The constraint validation engine (Planner profile, section 3.4) already checks against Immutable Standard 3 (Confidence Ceiling) and indirectly against rote learning through coherence validation:

```
checkCoherenceConstraints(proposal):
  Does this plan make logical sense?
  Use LLM to validate
```

This is good but not sufficient. The LLM can validate that a plan is internally consistent without checking whether it is grounded in conceptual understanding.

**Stronger constraint to implement:**

```
checkSchemaGrounding(proposal):
  Does this plan rest on existing schemas?
  Or does it assume untested knowledge?

  Estimate: % of the plan's preconditions that are
  already confident (> 0.60) in the WKG

  If grounding < 0.50:
    Reject or rate-limit the plan
    (Plan depends on shaky foundations)
```

This would prevent the system from creating procedures that do not rest on solid conceptual knowledge.

### Developmental Implication

Piaget observed that real understanding precedes flexible, transferable knowledge. The child must construct schemas through interaction. Premature attempts to shortcut this process by teaching rote responses fail when the child encounters variation.

For Sylphie: **Do not let Planning create procedures faster than Learning can build the schemas those procedures depend on.**

The cold-start dampening helps. The rate limiting helps. But a direct constraint that validates schema grounding would be the most effective prevention.

---

## 9. Recommendations: Developmental Guidelines for Epic 8 Implementation

### A. Readiness Gates (Pre-Activation Checks)

Before Planning subsystem is fully activated, verify:

1. **WKG Density:** >= 100 entity nodes, > 0.3 provenance ratio (GUARDIAN + SENSOR)
2. **Prediction Stability:** Type 2 MAE is stable (rolling coefficient of variation < 0.2)
3. **Type 1 Emergence:** At least 5-10 Type 1 graduations achieved, Type 1 MAE < 0.15
4. **Drive State:** No drive sustained > 0.7 for > 10 consecutive ticks
5. **Guardian Feedback:** System has received at least 20 guardian corrections (establishing that feedback integrates)

**Verification:** Run a health check before the Planning service initializes. Log results to telemetry. If any gate fails, initialize Planning in COLD_START_DAMPENING mode (100% dampening, no Opportunities created).

### B. Procedure Trial Mechanism (Addressing the Confidence Ceiling Trap)

**Problem:** Procedures created at 0.35 confidence (below retrieval threshold 0.50) will never be tried unless explicitly selected.

**Solution:** Implement a "try new procedure" action in Decision Making:

```
When no high-confidence Type 1 action is available
  AND Planning has created procedures in the last hour
  Occasionally select a new procedure for trial

Frequency: ~1 per 20-30 decisions (tunable)

This gives new procedures a fair first trial
while not overwhelming the system with untested code
```

Alternatively, temporarily boost confidence for first trial:
```
When a procedure is created and selected:
  confidence = max(0.35, procedureConfidence + 0.15)  // Temporary boost for trial
  After first use, revert to true confidence
```

**Rationale:** Without trial selection, Planning creates a knowledge sink. Procedures are created but never tested, never graduate, never contribute to Type 1 behavior. The subsystem appears to be working (procedures are created) but is actually inert.

### C. Guardian Feedback Integration in Planning

Implement annotation-based feedback integration:

```
When guardian provides feedback on a plan outcome:
  Store feedback as annotation on TimescaleDB PLAN_FAILURE event
  Next Planning cycle for same context:
    Research stage includes prior feedback annotations
    Proposal stage generates plans that address the feedback
    (E.g., if guardian said "the issue was X", new plan avoids X)
```

This preserves the Planning pipeline's structure while making guardian knowledge explicit in subsequent planning cycles.

### D. Schema Grounding Validation

Add a constraint to validation engine:

```
checkSchemaGrounding(proposal):
  For each precondition in the proposal:
    Query WKG for confidence of related schemas
    Estimate: what fraction are > 0.60 confident?

  If grounding < 0.50:
    Log warning: "Plan depends on unconfident schemas"
    Apply rate limit or reject
```

This prevents procedures from being created that depend on untested knowledge.

### E. Per-Domain Cold-Start Dampening

Currently, cold-start dampening is global (decisions 0-100). Recommend making it tunable per context or domain:

```
dampening(decisions, domain) =
  0.8 * (1 - min(1.0, decisions_in_domain / domain_threshold))

domain_threshold = 50 for frequent contexts
domain_threshold = 200 for rare contexts
```

Domains where the system has rapid experience (conversation) graduate faster. Domains where experience is sparse (novel task contexts) retain dampening longer.

### F. Opportunity Research Evidence Thresholds

The current threshold (Planner profile, section 3.2):
```
hasSufficientEvidence = failures.length >= 2
  AND discrepancies.some(d => d.mae > 0.15)
```

This is reasonable. But consider:
- **Minimum evidence strength:** Reject opportunities where `evidenceStrength < 0.20` (very weak pattern)
- **Prior attempt analysis:** If a similar opportunity was addressed before and the plan failed, require stronger evidence before trying again
- **Context specificity:** Only create procedures for contexts that have occurred >= 3 times (not one-off failures)

### G. Procedure Confidence Lifecycle Monitoring

Track key metrics:

1. **Time to graduation:** Average decisions from creation to Type 1 graduation
2. **Graduation success rate:** % of procedures that eventually graduate (vs. decay below threshold)
3. **Demotion rate:** % of Type 1 procedures demoted due to MAE > 0.15
4. **Decay rate:** % of procedures that decay below retrieval threshold (never used)

**Healthy development:**
- Time to graduation: 100-300 decisions (not too fast, not too slow)
- Graduation success rate: > 50% (more graduate than decay)
- Demotion rate: < 10% (Type 1 procedures are usually stable)
- Decay rate: < 30% (some procedures fail, but most are tried)

### H. Planning Runaway and Prediction Pessimist Detection

Implement early warning metrics:

```
If (plansCreatedLastHour > 5) OR (activePlans > 12):
  Alert: "Planning Runaway risk"
  Increase cold-start dampening temporarily

If (meanProcedureConfidence < 0.35) AND (procedureCount > 20):
  Alert: "Prediction Pessimist pattern detected"
  Halt new procedures for N hours
  Focus on learning and increasing confidence
```

### I. Documentation and Observability

Every planning event should be logged with full context:

```
OPPORTUNITY_CREATED: { opportunityId, context, priority, coldStartDampening }
OPPORTUNITY_ENQUEUED: { opportunityId, queuePosition, decayRate }
RESEARCH_COMPLETE: { opportunityId, failureCount, discrepancies, evidenceStrength }
SIMULATION_COMPLETE: { opportunityId, bestCandidate, expectedValue }
PROPOSAL_GENERATED: { proposalId, opportunityId, complexity, simulatedEV }
VALIDATION_PASSED/FAILED: { proposalId, passedConstraints, failedConstraints }
PROCEDURE_CREATED: { procedureId, initialConfidence, triggerContext }
PLAN_EXECUTED: { procedureId, context, success, mae }
PLAN_EVALUATION: { procedureId, confidence_before, confidence_after, mae }
PLAN_GRADUATED: { procedureId, confidence, decision_count, time_elapsed }
PLAN_DEMOTED: { procedureId, reason, newConfidence }
```

This provides the full developmental trajectory of each procedure. Analyzable post-hoc for learning patterns.

### J. Guardian Interface for Planning (Future)

Consider a future design element (not required for Epic 8):

A dashboard element showing:
- Current Opportunity queue (priority, decay, expected processing time)
- Recent plans created (confidence, executions to date)
- Procedures eligible for trial (new procedures waiting for selection)
- Failed plans awaiting revision

This would allow Jim to observe and (optionally) guide the Planning subsystem without direct code modification.

---

## 10. Conclusion: Planning as a Developmental Amplifier

The Planning subsystem is not merely a feature that allows Sylphie to create new procedures. It is a **developmental amplifier** -- a mechanism that accelerates the transition from assimilation (using existing knowledge) to accommodation (restructuring knowledge).

Developmental psychology has established that this transition is critical. An organism that can only assimilate reaches a ceiling. An organism that can accommodate can continue to grow indefinitely.

**Piaget's insight:** Development is not linear. It involves periods of apparent stagnation (the organism is consolidating schemas) followed by sudden breakthroughs (accommodation into new stages). These breakthroughs happen when the organism encounters systematic failure in its current understanding.

For Sylphie:

- **Consolidation phases:** Learning subsystem consolidates experience into the WKG. Type 1 coverage grows. Predictions improve. System operates with high efficiency.

- **Breakthrough phases:** Drive Engine detects patterns of repeated prediction failure. Planning subsystem kicks in. New procedures are proposed. Executions are tried. Some work, some fail. Over time, new behavioral competencies emerge.

The Planning subsystem, when designed correctly, **enables breakthrough development**. When designed poorly (premature procedures, hallucinated patterns, learning collapse), it becomes a blocker.

This analysis provides the theoretical grounding for making deliberate design choices about when Planning should be active, how it should be rate-limited, how new procedures should graduate to Type 1, and how guardian feedback should guide the process.

**The fundamental principle:** Plans are hypotheses. They must be tested, evaluated, and allowed to fail. Only through this cycle of creation, execution, and evaluation does genuine new knowledge emerge.

That is not just engineering. That is developmental psychology implemented as code.

---

## References and Further Reading

### Piaget

- Piaget, J. (1954). *The construction of reality in the child.* Basic Books.
- Piaget, J. (1975). *The equilibration of cognitive structures: The central problem of intellectual development.* University of Chicago Press.
- Piaget, J. (1985). *The child's conception of the world.* Rowman & Littlefield.

### Vygotsky and Scaffolding

- Vygotsky, L. S. (1978). *Mind in society: The development of higher psychological processes.* Harvard University Press.
- Wood, D., Bruner, J. S., & Ross, G. (1976). The role of tutoring in problem solving. *Journal of Child Psychology and Psychiatry*, 17(2), 89-100.

### Schema Theory

- Bartlett, F. C. (1932). *Remembering: A study in experimental and social psychology.* Cambridge University Press.
- Rumelhart, D. E. (1980). Schemata: The building blocks of cognition. In R. J. Spiro, B. C. Bruce, & W. F. Brewer (Eds.), *Theoretical issues in reading comprehension.* Lawrence Erlbaum.

### Learning and Prediction Error

- Rescorla, R. A., & Wagner, A. R. (1972). A theory of Pavlovian conditioning. In A. H. Black & W. F. Prokasy (Eds.), *Classical conditioning: II. Current research and theory.* Appleton-Century-Crofts.
- Friston, K. (2010). The free-energy principle: A unified brain theory? *Nature Reviews Neuroscience*, 11(2), 127-138.
- Clark, A. (2013). *Whatever next? Predictive brains, situated agents, and the future of cognitive science.* Behavioral and Brain Sciences, 36(3), 181-204.

### Sylphie Project

- CANON.md (this repository)
- Planner agent profile (this repository)
- PIAGET agent profile (this repository)
