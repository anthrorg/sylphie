# Epic 5: Neuropsychological Validation and Implementation Guidance

**Document:** Summary of Luria's neuropsychological analysis for E5 implementation
**Status:** Complete - Ready for Design and Implementation phases
**Key Artifact:** `agent-analyses/luria-analysis.md` (855 lines, comprehensive grounding)

---

## Executive Context

Epic 5 (Decision Making Core Cognitive Loop) is the central mechanism that binds all five subsystems. From a neuroscience perspective, E5 implements:

1. **Luria's Third Functional Unit (Programming, Regulation, Verification)** — The dorsolateral and ventromedial prefrontal cortex mechanisms
2. **Hippocampal-Cortical Memory Integration** — Episodic-to-semantic consolidation
3. **Dopaminergic Prediction Error Learning** — Schultz's mechanism for experience-driven adaptation
4. **Dual-Process Competition** — Basal ganglia (Type 1 automatic) vs. Prefrontal (Type 2 deliberate)

---

## Validation Outcome: STRONG GROUNDING

**Overall Assessment:** E5 is **strongly grounded in neuroscience** with only minor specification gaps. The core mechanisms are biologically sound.

### Why This Matters

The question in CANON is profound: **"What happens when you give an AI system a body, drives, a growing world model, and a human teacher — and let experience shape who she becomes?"**

E5 is the mechanism through which experience translates into personality. If E5 is biologically plausible, then Sylphie's learning will follow recognizable patterns. If E5 is ad hoc, learning will be arbitrary.

---

## Three Structural Strengths (No Changes Needed)

### 1. Episodic → Semantic Consolidation (Systems Consolidation Theory)

**Biological Basis:** McClelland et al., 1995; Squire & Alvarez, 1995

The E5 design mirrors the hippocampal-cortical consolidation process:
- **Fresh episodes** (<1h) — Full detail in TimescaleDB (rapid hippocampal encoding)
- **Recent episodes** (1-24h) — Still queryable with full fidelity (offline replay period)
- **Consolidated** (>24h) — Semantic content extracted to WKG, episodic detail archived
- **Archived** (>7d) — Minimal episodic record, semantic summary only

**Why This Works:**
- Matches biological consolidation timescales (hours to days)
- Max 5 events per Learning consolidation cycle prevents catastrophic interference
- Provenance tracking preserves source information (analogous to context binding)

**Status:** VALIDATED — No changes needed

### 2. Prediction Error Learning (Schultzian Dopamine Mechanism)

**Biological Basis:** Schultz, 1997

The E5 design implements error-driven learning:
- Predictions generated **before** action (Inner Monologue)
- Outcomes observed **after** action (OBSERVING state)
- Error computed as actual minus predicted
- Learning signal proportional to error magnitude

**Why This Works:**
- Matches dopaminergic response curve (error magnitude → learning rate)
- Prediction errors trigger Opportunity creation (dopaminergic salience signal)
- Confidence updates follow error magnitude (Rescorla-Wagner model)

**Status:** VALIDATED — No changes needed

### 3. Type 1/Type 2 Arbitration with Graduated Learning

**Biological Basis:** Kahneman, 2011; Yin & Knowlton, 2006

The E5 design implements the dual-process competition:
- **Type 1** — Basal ganglia reflexes (fast, automatic, low-confidence candidates)
- **Type 2** — Prefrontal reasoning (slow, deliberate, LLM-assisted)
- **Arbitration** — Dynamic threshold determines which system wins
- **Graduation** — confidence >0.80 AND MAE<0.10 over 10 uses → Type 1 graduation
- **Demotion** — MAE>0.15 → return to Type 2 (context changed, reflex failed)

**Why This Works:**
- Graduation criteria ensure only reliably successful behaviors graduate
- Type 2 carries explicit cost (latency, cognitive effort) — prevents LLM addiction
- Demotion mechanism detects when environmental contingencies change
- Cost structure creates evolutionary pressure to compile LLM solutions into Type 1

**Status:** VALIDATED — No changes needed

---

## Critical Specification Gaps (Before Implementation)

### Gap 1: Encoding Gating Mechanism (CANON Appendix A.2)

**Current State:** "episodic memory encoding is gated by attention/arousal — not every tick is an episode"

**What's Missing:** The formula for determining encoding depth

**Why It Matters:** Not all sensory input becomes memorable. The hippocampus filters through attention networks. Without clear encoding gating, the system may:
- Encode noise (memory fills with irrelevant detail)
- Miss signal (important events forgotten)

**Biological Basis:**

Three attentional networks determine what gets encoded:

1. **Exogenous Salience** (Orienting Network)
   - Guardian input → always encode fully (interrupt-driven)
   - Prediction errors → encode deeply (novelty signal)
   - Routine matches → shallow encoding (confirmatory)

2. **Endogenous Goals** (Executive Attention)
   - High Curiosity drive + novel stimulus → deep encoding
   - Low Curiosity + familiar stimulus → shallow encoding
   - Context relevance modulates depth

3. **Arousal Level** (Locus Coeruleus)
   - High drive pressure → deep encoding (system engaged)
   - Low drive pressure → shallow encoding (minimal engagement)

**Recommended Formula:**
```
encoding_depth = 
  salience_factor(input_type, guardian_flag, error_magnitude) 
  * (0.3 + 0.7 * drive_arousal_level) 
  * (1.0 + prediction_error_proportionality_factor)
```

**Implementation Action:**
1. Coordinate with Jim to define CANON A.2
2. Implement encoding_depth as a queryable attribute on TimescaleDB events
3. Validate during E10: verify encoding depth correlates with drive pressure and prediction error

---

### Gap 2: Dynamic Threshold Function (CANON Appendix A.3)

**Current State:** "dynamic threshold modulated by drive state (0.30-0.70)"

**What's Missing:** Exact formula mapping drive state to Type 1/Type 2 threshold

**Why It Matters:** The arbitration threshold determines whether the system defaults to fast/automatic (Type 1) or slow/deliberate (Type 2). Different drives affect automaticity differently:

- **High Anxiety (>0.7)** — Type 1 more likely (survival mode: fast responses) BUT less flexible
- **High Curiosity (>0.7)** — Type 2 more likely (novel situations need reasoning)
- **High Boredom (>0.7)** — Type 1 more likely (routine exploration)
- **Low Cognitive Awareness** — Type 1 more likely (cognitive load limits prefrontal capacity)

**Recommended Approach:**
1. Consult with **Cortex** agent (CLAUDE.md references cortex.md as specification source)
2. Define function: `dynamic_threshold(drive_snapshot) -> float[0.30, 0.70]`
3. Test empirically during E10: verify threshold modulation produces adaptive behavior

**Implementation Action:**
1. Resolve with Cortex agent before E5 code begins
2. Document in CANON A.3
3. Implement in Arbitration service
4. Validate during E10 integration

---

### Gap 3: Prediction Format and Error Computation

**Current State:** "predictions are generated and evaluated" — but format and error computation unspecified

**What's Missing:**
- What does a prediction contain? (Continuous value? Categorical? Probability distribution?)
- What constitutes the "outcome"? (Drive deltas? Success/failure? Latency?)
- How is error computed? (MAE? MSE? Cross-entropy?)
- How does error magnitude map to learning rate? (Linear? Sigmoid?)

**Why It Matters:** This is **critical** — the entire prediction error learning mechanism depends on this specification.

**Biological Basis:**

Dopaminergic prediction error has specific properties:
- **Magnitude-proportional:** Error size determines learning rate magnitude
- **Saturating:** Extremely large errors don't produce proportionally larger responses (sigmoid curve)
- **Sign-sensitive:** Positive error (reward > expected) increases firing; negative error (reward < expected) decreases firing

**Recommendation:**

1. **Prediction format:** Each prediction should contain:
   ```
   {
     action_id: string,
     predicted_drive_delta: {[drive]: float},  // Expected changes in each of 12 drives
     predicted_outcome_probability: float,     // 0.0-1.0 confidence
     predicted_latency_ms: number
   }
   ```

2. **Outcome format:**
   ```
   {
     action_id: string,
     actual_drive_delta: {[drive]: float},    // Observed changes
     success_flag: boolean,
     actual_latency_ms: number
   }
   ```

3. **Error computation:**
   ```
   error_vector = predicted_drive_delta - actual_drive_delta
   error_magnitude = ||error_vector|| (Euclidean distance)
   learning_rate = α_base * sigmoid(error_magnitude / σ)
   // sigmoid prevents over-learning from extreme outliers
   ```

**Implementation Action:**
1. Define prediction and outcome types in shared module (E0)
2. Document in CANON A.4 (Opportunity Detection Criteria): error magnitude thresholds
3. Implement in Prediction and Confidence Updater services (E5)
4. Validate during E10: measure prediction error distribution and correlation with learning

---

### Gap 4: Executor Loop Tick Rate

**Current State:** Unspecified

**Biological Parallel:** Human decision cycles operate at 1-5Hz (200-1000ms)

**Recommendation:** **5Hz baseline** (200ms per state transition)
- Fast enough for conversational responsiveness
- Slow enough for careful deliberation
- Allows LLM latency absorption (LLM requests timeout/fallback to Type 1 if >500ms)

**Implementation Action:**
1. Specify in E5 design document
2. Measure actual cycle time during development
3. Monitor via E9 dashboard: Executor Engine dwell times per state

---

### Gap 5: Prediction Error Magnitude → Learning Rate Mapping

**Current State:** ACT-R confidence formula uses count (repetitions) but may not account for error magnitude

**Recommendation:** Multiply confidence updates by sigmoid of error magnitude
```
new_confidence = old_confidence + α_base * sigmoid(error_magnitude / σ) * sign(error)
```

This ensures:
- Large errors produce strong learning
- Extremely large errors don't over-train
- Error sign determines direction (positive error → increase confidence, negative → decrease)

**Implementation Action:**
1. Implement in Confidence Updater service
2. Document magnitude-proportional update logic
3. Track during E10: analyze confidence change vs. error magnitude correlation

---

## Failure Modes: Six Lesion Scenarios with Detection Tests

The CANON's Lesion Test (run without LLM) is a direct application of Luria's clinical methodology. However, there are six other critical failure modes that must be detected early.

### Lesion 1: Episodic Memory System Fails

**Biological Analog:** Medial temporal lobe amnesia (patient H.M.)

**Symptom Pattern:**
- Cannot form new episodic memories
- Perception and execution intact
- Cannot ground predictions in recent experience
- Learning subsystem has no raw events to consolidate

**Detection Test:**
Guardian says: "My favorite color is blue."
Guardian repeats after 10 seconds: "What's my favorite color?"
- **Healthy:** System recalls "blue"
- **Lesion:** System cannot recall, or says "I don't know"

**Impact:** CRITICAL — system becomes context-insensitive and cannot learn from recent experience

---

### Lesion 2: Inner Monologue / Prediction Fails

**Biological Analog:** Ventromedial prefrontal cortex lesion

**Symptom Pattern:**
- Type 1 reflexes still work
- Cannot generate predictions or reason about futures
- No Type 2 reasoning available
- Behavior becomes stimulus-bound

**Detection Test:**
Novel situation: Guardian shows system an object and says: "This is a new tool. What will happen if I press the red button?"
- **Healthy:** System reasons through possibilities and generates predictions
- **Lesion:** System has no response, or defaults to "I don't know"

**Impact:** HIGH — Type 2 deliberation unavailable; system relies entirely on Type 1 reflexes

---

### Lesion 3: Arbitration Mechanism Fails

**Biological Analog:** Anterior cingulate damage (conflict monitoring failure)

**Symptom Pattern:**
- Both Type 1 and Type 2 available but no coherent selection
- Cannot override reflexes when context requires deliberation
- Cannot learn from corrections

**Detection Test:**
Guardian corrects system error: "No, that was wrong. Do this instead."
- **Healthy:** System updates behavior for that situation
- **Lesion:** System repeats the same error despite correction

**Impact:** MEDIUM-HIGH — system cannot adapt to guardian feedback

---

### Lesion 4: Executor Engine State Machine Fails

**Biological Analog:** Dorsolateral prefrontal cortex damage (sequencing deficit)

**Symptom Pattern:**
- Cannot sequence multi-step actions
- Gets stuck in single state
- Cannot maintain intermediate goals

**Detection Test:**
Request: "First tell me what you learned today, then ask me a question."
- **Healthy:** System executes both actions in sequence
- **Lesion:** System executes only first action, or both simultaneously without sequence

**Impact:** MEDIUM — complex action planning becomes impossible

---

### Lesion 5: Confidence Updater Fails

**Biological Analog:** Striatal dopamine dysfunction (Parkinson's disease)

**Symptom Pattern:**
- Predictions generated and evaluated but no learning occurs
- Type 1 candidates never graduate despite success
- No shift from Type 2 to Type 1 over time

**Detection Test:**
Measure confidence on frequently-used, always-successful action:
- Action taken 100 times with 100% success rate
- Measure confidence on action at start vs. after 100 uses
- **Healthy:** Significant confidence increase (0.40 → 0.75+)
- **Lesion:** Confidence unchanged (0.40 → 0.40)

**Impact:** CRITICAL — learning loop broken; no behavioral development

---

### Lesion 6: Drive Disconnection

**Biological Analog:** Disconnection syndrome (white matter damage)

**Symptom Pattern:**
- Drive Engine process dies or IPC channel breaks
- Decision Making operates without motivational context
- Actions become arbitrary and unmotivated
- Behavior has no goal-directedness

**Detection Test:**
Measure correlation between action outcomes and drive state changes over 100 decision cycles:
- **Healthy:** Positive outcomes correlate with drive relief; negative with drive increase
- **Lesion:** Zero correlation between outcomes and drive state changes

**Impact:** CRITICAL — system becomes dysexecutive; technically capable but unmotivated

---

## Implementation Roadmap

### Phase 1: Specification (Before E5 Code)

**Decisions Required:**

1. **CANON A.2 (Episodic Memory)** — Jim approves encoding gating formula
2. **CANON A.3 (Arbitration Algorithm)** — Cortex + Jim specify dynamic threshold function
3. **Prediction Format** — Define prediction and outcome types
4. **Error Computation** — Define error formula and magnitude→learning rate mapping
5. **Executor Tick Rate** — Specify baseline tick rate and cycle time targets

**Estimated Effort:** 4-8 hours (primarily specification discussion with Jim and Cortex agent)

### Phase 2: E5 Implementation

**Key Implementation Guidance:**

1. **IEpisodicMemoryService**
   - Store `encoding_depth: float` on every event
   - Implement depth computation based on approved formula
   - Optimize TimescaleDB queries for recent episode retrieval

2. **Inner Monologue**
   - Limit to 4-5 candidate actions (working memory constraint)
   - Generate predictions in parallel with Type 1 retrieval (parallelism improves decision quality)
   - Store predictions and outcomes in TimescaleDB for E10 analysis

3. **Arbitration**
   - Compute dynamic threshold from approved formula
   - Select highest-confidence candidate passing threshold
   - Implement Shrug Imperative: if no candidate above threshold, return incomprehension action

4. **Confidence Updater**
   - Weight updates by error magnitude (sigmoid saturation)
   - Track prediction calibration: measure whether "60% confident" predictions succeed ~60% of the time
   - Implement plasticity tagging: mark retrieved-and-failed edges for prioritized Learning re-examination

5. **Executor Engine**
   - Instrument all state transitions for E9 dashboard
   - Log state dwell times (detect bottlenecks)
   - Implement timeout detection: if stuck >5 seconds, flag system error

**Estimated Effort:** ~20% of Phase 1 (relative to E10 roadmap estimate)

### Phase 3: E10 Integration Testing

**Validation Tests:**

1. **Lesion Tests** (run six critical failure modes)
   - Verify modular degradation patterns
   - Confirm detection mechanisms work
   - Document failure modes for operational monitoring

2. **Learning Curve Validation**
   - Measure Type 1 graduation rates
   - Plot confidence vs. number of uses
   - Verify MAE>0.15 triggers reliable demotion

3. **Prediction Error Analysis**
   - Collect 1000+ prediction errors
   - Plot error magnitude distribution
   - Verify sigmoid saturation in learning rates
   - Correlate error magnitude with drive state changes

4. **Encoding Gating Validation**
   - Collect encoding depth values across all episodic operations
   - Verify prediction errors trigger deeper encoding
   - Verify guardian input always encoded deeply
   - Verify encoding depth correlates with drive pressure

5. **Working Memory Capacity Validation**
   - Measure decision quality vs. number of candidates
   - Verify quality peaks at 4-5 candidates
   - Verify degradation beyond 5 candidates

6. **Lesion Test (No LLM Mode)**
   - Run system without LLM access
   - Measure what Type 1 coverage remains
   - Characterize degradation pattern
   - **This is ground truth for whether system actually learns**

**Estimated Effort:** ~15% of total Phase 1 (part of E10 "Integration and End-to-End Verification")

---

## Success Criteria for E5 (CANON Phase 1 Requirements)

From CANON Section "Phase 1 Must Prove":

1. **The prediction-evaluation loop produces genuine learning**
   - ✓ Validated neuropsychologically (Schultz mechanism)
   - Test in E10: Measure confidence gains from error correction

2. **The Type 1/Type 2 ratio shifts over time**
   - ✓ Validated neuropsychologically (graduated learning from basal ganglia)
   - Test in E10: Plot Type 1/Type 2 ratio over 1000 decision cycles

3. **The graph grows reflecting real understanding, not LLM regurgitation**
   - ✓ Validated through provenance discipline + Lesion Test
   - Test in E10: Run without LLM; measure remaining Type 1 coverage

4. **Personality emerges from contingencies**
   - ✓ Validated neuropsychologically (drive-mediated behavior contingencies)
   - Test in E10: Measure behavioral diversity and drive-response correlation

5. **The Planning subsystem creates useful procedures**
   - Validated in E8 planning analysis (separate Epic)
   - Test in E10: Measure plan execution success rate

6. **Drive dynamics produce recognizable behavioral patterns**
   - ✓ Validated neuropsychologically (homeostatic drive regulation)
   - Test in E10: Measure drive pressure → action selection correlation

---

## Risk Mitigation

### Risk 1: Encoding Gating Underspecification

**Symptom:** System encodes too much detail, TimescaleDB grows unbounded; or encodes too little, system forgets important context.

**Mitigation:**
- Define encoding gating formula in CANON A.2 before E5 implementation
- Monitor TimescaleDB growth rate during development
- Plot encoding depth distribution during E10 to validate gating is calibrated

### Risk 2: Arbitration Threshold Not Adaptive

**Symptom:** System always defaults to Type 1 or always uses Type 2 regardless of situation.

**Mitigation:**
- Define dynamic threshold formula in CANON A.3 before implementation
- Test empirically: measure whether threshold modulation improves decision quality
- Validate during E10: plot decision quality vs. drive state

### Risk 3: Prediction Error Magnitude Swamps Learning

**Symptom:** Large errors cause oscillation or non-convergence; system never stabilizes on correct behavior.

**Mitigation:**
- Implement sigmoid saturation on error magnitude → learning rate
- Monitor confidence change vs. error magnitude during development
- Validate during E10: plot confidence convergence curves for repeated actions

### Risk 4: Executor Loop Bottleneck

**Symptom:** Decision cycles slow to >2 seconds; system becomes unresponsive.

**Mitigation:**
- Specify tick rate target (recommend 5Hz = 200ms per state)
- Instrument Executor Engine state transitions in E5
- Monitor via E9 dashboard; alert on state dwell time >500ms

---

## Document Navigation

**Primary Analysis:** `agent-analyses/luria-analysis.md` (855 lines)

**Quick Reference:** `agent-analyses/README.md` (137 lines)

**Coordination Points:**
- **Cortex Agent:** Dynamic threshold function (CANON A.3)
- **Forge Agent:** Implementation architecture and API design
- **Sentinel Agent:** Observability and diagnostic logging (lesion detection)
- **Skinner Agent:** Drive-behavior contingency validation
- **Scout Agent:** Curiosity-driven exploration and novelty handling
- **Piaget Agent:** Developmental sequencing and schema evolution

---

**Status:** COMPLETE — E5 Neuropsychological Validation Ready
**Date:** March 29, 2026
**Next Action:** Resolve specification gaps, then proceed to E5 Design and Implementation
