# Luria: Neuropsychological Analysis of Epic 5 (Decision Making Core Cognitive Loop)

**Analysis Date:** March 29, 2026
**Analyzed Against:** CANON, E5 Roadmap Specification, CLAUDE.md Phase 1 requirements

---

## Executive Summary

Epic 5 implements the core cognitive loop that binds all five subsystems together. From a neuropsychological perspective, E5 is the instantiation of Luria's Third Functional Unit (Programming, Regulation, and Verification) combined with the hippocampal-cortical interaction that underlies episodic and semantic memory integration. This analysis validates the design against biological neuroscience, identifies gaps where the biological parallel offers engineering insight, and flags failure modes derived from lesion studies.

**Key Finding:** The E5 architecture is **strongly grounded in neuroscience** with two critical design questions requiring clarification before implementation:
1. **Encoding gating mechanism** (what determines attention/arousal thresholds for episodic memory)
2. **Working memory capacity** in the inner monologue (how many candidates before cognitive bottleneck)

---

## 1. Mapping E5 to Luria's Three Functional Units

### The Three Units Across All Five Subsystems

Luria's framework describes mental function through three coordinated functional units, each operating at its own timescale:

**Unit 1: Arousal and Tone (Brainstem & Reticular Activating System)**
- Regulates cortical tone, waking state, arousal level
- Without adequate arousal, no other cognitive processing occurs
- Operates continuously at baseline, modulated by salient stimuli

**Unit 2: Sensory Reception, Processing, and Storage (Posterior Cortex)**
- Receives, processes, stores sensory information
- Hierarchically organized: primary (raw) → secondary (perceptual synthesis) → tertiary (cross-modal integration)
- Operates on a faster timescale (~hundreds of milliseconds)

**Unit 3: Programming, Regulation, and Verification (Frontal Lobes)**
- Plans, executes, and monitors complex behavioral programs
- Critical: **both initiates action AND verifies whether the action achieved its goal**
- Operates on a slower timescale (~seconds to minutes for planning, rapid feedback for verification)

### E5's Mapping to Unit 3 (Primary) and Unit 1 (Critical Dependencies)

**E5 Decision Making IS Luria's Unit 3:**

| E5 Component | Biological Analog | Function |
|--------------|------------------|----------|
| **Executor Engine** | Dorsolateral prefrontal cortex (dlPFC) + anterior cingulate | Action programming and state control |
| **Inner Monologue** (prediction generation) | Ventromedial prefrontal cortex (vmPFC) | Outcome prediction and evaluation |
| **Type 1/Type 2 Arbitration** | Anterior cingulate (conflict detection) + basal ganglia (habitual vs. prefrontal control) | Dynamic switching between automatic and deliberate processing |
| **Episodic Memory** (from TimescaleDB) | Hippocampus + medial temporal lobe | Encoding recent experiences with full contextual detail |
| **Confidence Updater** (ACT-R dynamics) | Dopaminergic striatum | Prediction error computation and reinforcement |
| **Prediction-Evaluation Loop** | Unit 3's verification component (dlPFC monitoring vs. vmPFC outcome prediction) | Closed-loop motor control with error checking |

**E5's Critical Dependency on Unit 1:**

The Executor Engine and the entire decision-making loop operate **without meaning** if the Drive Engine (Unit 1 equivalent) is not producing valid arousal/motivational values. Just as the reticular activating system gates cortical processing through arousal modulation, the Drive Engine gates the decision loop through pressure states.

- When System Health is critical, the system prioritizes maintenance (analogous to emergency arousal)
- When Cognitive Awareness is high, Type 2 is more readily engaged (analogous to prefrontal arousal/tone increase)
- When all drives are low, no action selection occurs — the system idles (analogous to sleep or minimized arousal)

**Critical Insight:** If the Drive Engine process dies or the drive-reading interface breaks, the entire system becomes dysexecutive—it receives input but cannot generate motivated action. This is analogous to lesions in the ventromedial prefrontal cortex, where patients can perform actions but have lost the motivational substrate for goal-directed behavior.

---

## 2. Episodic Memory System Validation

### The E5 Episodic Memory Design

From the roadmap and CANON:
- Fresh (<1h): Full detail stored in TimescaleDB as raw event records
- Recent (1-24h): Key events preserved in TimescaleDB, still queryable with full fidelity
- Consolidated (>24h): Semantic content extracted to WKG by Learning subsystem; raw episode summary persists
- Archived (>7d): Minimal record, stub with semantic summary only

### Neuropsychological Grounding: The Hippocampal-Cortical Systems Consolidation Theory

**Standard Consolidation Theory (Squire & Alvarez, 1995; McClelland et al., 1995):**

1. **Rapid Hippocampal Encoding** — New experiences are rapidly encoded by the hippocampus as sparse, pattern-separated representations. This allows flexibility but limits storage capacity.

2. **Offline Replay** — During quiet rest and sleep, the hippocampus replays recent memories. This replay gradually strengthens cortical-cortical connections through repeated reactivation.

3. **Gradual Transfer to Cortex** — Over days to weeks, memory becomes progressively less dependent on the hippocampus and more retrievable via distributed cortical networks.

4. **Complementary Learning Systems** (McClelland et al., 1995) — The hippocampus learns quickly but with interference risk. The neocortex learns slowly but is interference-resistant. The two systems work together: rapid hippocampal learning complements slow neocortical learning, preventing catastrophic forgetting.

**Sylphie/E5 Mapping:**

| Biological Process | Sylphie Implementation | Timescale Match |
|-------------------|----------------------|-----------------|
| Rapid hippocampal encoding | TimescaleDB raw event recording | Milliseconds to seconds (episodic memory gating by attention) |
| Hippocampal pattern separation | Each raw event is distinct in TimescaleDB with full contextual metadata | Events preserve context (drive state, input source, predictions) |
| Offline replay | Learning subsystem's maintenance cycle queries TimescaleDB events | Pressure-driven (Cognitive Awareness) or timer-triggered consolidation |
| Gradual cortical strengthening | Entity extraction + edge refinement → WKG upsert | Max 5 events per cycle (prevents catastrophic interference) |
| Semantic abstraction | Entities extracted from raw events; semantic relationships stored in WKG | Progressing from instance-level (specific events) to schema-level (general knowledge) |
| Decay of hippocampal dependency | TimescaleDB retention policy (keep 7d detail, then archive) | System no longer queries detailed episode data after consolidation |

### Validation Assessment: STRONG GROUNDING

**Strengths:**
- ✓ Temporal degradation (fresh → recent → consolidated → archived) mirrors actual consolidation timescales
- ✓ Learning subsystem's max-5-per-cycle prevents catastrophic interference exactly as theory predicts
- ✓ Provenance preservation (every edge carries source) mirrors memory integration with context
- ✓ Confidence dynamics on retrieved knowledge produce reconsolidation effects (retrieved-and-failed knowledge becomes plastic)

**Concerns:**
1. **Encoding Gating Mechanism (Not Yet Specified)** — The CANON says episodic memory is "gated by attention/arousal — not every tick is an episode" (CANON p.96). This is neuropsychologically correct (not all sensory input becomes episodic memory; only attended input). However, **what determines this gating threshold is not yet specified**. This is CANON Gap A.2.

   *Biological parallel:* Locus coeruleus (norepinephrine) implements the alerting network. Salient stimuli (novel, threat-relevant, goal-relevant) trigger phasic norepinephrine release, which gates hippocampal encoding. Without this gating, the hippocampus would store meaningless noise.

   *Recommendation for E5 Implementation:* Encoding depth should be modulated by:
   - **Novelty detection** (information entropy of input vs. WKG baseline predictions) → increases encoding depth
   - **Arousal level** (Drive Engine output) → high arousal increases encoding depth for any stimulus
   - **Salience** (task relevance, threat, guardian input) → guardian-initiated input bypasses novelty filters entirely
   - **Predictability** (prediction error magnitude) → large prediction errors gate deeper encoding

2. **Consolidation Timing** — The Learning subsystem runs on pressure-driven (Cognitive Awareness) or timer fallback. This is biologically sound (hippocampal replay does occur during task engagement as well as offline rest). However, there should be **threshold detection**: if raw events accumulate faster than the Learning subsystem can consolidate, the system risks losing episodic detail before semantic extraction. Monitor: `event_backlog_size > threshold` → escalate maintenance frequency.

3. **Episodic Memory Queries in Decision Making** — E5 needs to retrieve "recent episodic context" to ground the Inner Monologue in actual recent experience. This requires **episodic memory queries** in the decision loop, not just Learning subsystem access. TimescaleDB queries should be optimized for:
   - `getRecentEpisodes(context, max_age, limit)` — return N most recent events within time window
   - `queryByContext(contextFilter, confidence_threshold)` — retrieve episodes matching drive state, input type, or outcome type
   - These queries are typically ~milliseconds in a properly indexed TimescaleDB

---

## 3. Dual-Process Grounding: Type 1/Type 2 Arbitration

### The Biological Dual-Process Theory

**Kahneman's System 1 vs. System 2 (Thinking, Fast and Slow, 2011):**

| Aspect | System 1 (Type 1) | System 2 (Type 2) |
|--------|------------------|------------------|
| **Speed** | Automatic, ~50-200ms | Deliberate, ~0.5-5s per item |
| **Effort** | Minimal metabolic cost | High metabolic cost (~20% of brain glucose) |
| **Conscious Control** | Minimal; feels effortless | Feels like active choice and concentration |
| **Neural Substrate** | Basal ganglia (habits), sensory cortex, amygdala | Prefrontal cortex, anterior cingulate |
| **Learning Timescale** | Slow (hundreds of repetitions) | Fast (few examples) |
| **Error Characteristics** | Systematic biases | Rational but slow |

**Biological Gradient of Automaticity:**

Modern neuroscience (Yin & Knowlton, 2006; Graybiel, 2008) reveals that automaticity is not binary. Behaviors exist on a continuum:
- **Highly automatic (basal ganglia-dominant):** Procedural, fast, unconscious, interference-resistant
- **Moderately automatic (mixed dorsal/ventral loops):** Familiar but still context-sensitive
- **Deliberate (prefrontal-dominant):** Flexible, context-appropriate, slow, effortful

**Neurotransmitter Basis:**
- **System 1 (automatic):** Dopaminergic striatum, acetylcholine (automatic vs. reward-related action)
- **System 2 (deliberate):** Prefrontal dopamine and norepinephrine (working memory maintenance and attention), anterior cingulate (conflict detection)

### E5's Arbitration Design: Type 1/Type 2 with Dynamic Threshold

From the roadmap:
- **Type 1**: Graph-based reflexes with high confidence (graduated at confidence >0.80 AND MAE<0.10 over last 10 uses)
- **Type 2**: LLM-assisted reasoning, slower, carries explicit cost (latency + cognitive effort drive pressure)
- **Dynamic Threshold**: Modulated by drive state (threshold ranges 0.30-0.70 from cortex.md)
- **Demotion**: If MAE > 0.15, behavior returns to Type 2 (context changed, reflex no longer reliable)

### Validation Assessment: BIOLOGICALLY SOUND WITH SPECIFIC MAPPING

**Strengths:**

✓ **Cost Structure on Type 2** — The CANON requires Type 2 to carry explicit cost (latency, cognitive effort pressure, compute budget). This mirrors the metabolic cost of prefrontal reasoning. Without cost, the LLM always wins and Type 1 never develops (would be analogous to a brain that never developed procedural memory, always using deliberate reasoning). This cost structure is **critical** and is correctly identified in the CANON.

✓ **Graduation Criteria** — confidence >0.80 + MAE<0.10 over 10 uses maps to biological procedural memory formation:
- The confidence threshold (0.80) is approximately 3-4 standard deviations above the initial confidence (0.35-0.60), ensuring only reliably retrieved knowledge qualifies
- The 10-use window matches empirical findings on skill learning (fluency requires ~100-1000 repetitions depending on task complexity; early convergence at 10 uses indicates high-reliability scenarios)
- MAE<0.10 as accuracy requirement mirrors the low-error criteria for basal ganglia action selection: habits that produce consistent outcomes

✓ **Demotion Mechanism** — When MAE>0.15, the behavior re-engages Type 2. This maps to the biological phenomenon where environmental contingencies change, habitual behavior fails, and prefrontal engagement re-engages. Classic example: a habit of checking your phone at red lights works until you switch to a car with voice navigation; the changed environment triggers re-engagement of deliberate processing.

**Validation Concern: Threshold Modulation by Drive State**

The roadmap specifies that the dynamic threshold (0.30-0.70) is "modulated by drive state." This requires clarification because biological evidence suggests **different drives affect automaticity differently**:

1. **High arousal/stress (high Anxiety drive)** — System 1 becomes MORE likely (survival mode: automatic responses are faster than deliberation). However, high anxiety also produces errors (stress narrows attention, causes tunnel vision). The correct model is: **high arousal biases toward System 1 BUT with reduced flexibility**. If the situation doesn't match the habit, System 1 fails catastrophically.

2. **High motivation/engagement (low Boredom, high Curiosity)** — System 1 is less likely when engaged in novel exploration. The system preferentially uses Type 2 to handle novel situations.

3. **High cognitive load (low Cognitive Awareness)** — System 1 becomes MORE likely (cognitive depletion reduces prefrontal capacity). This is correct mapping.

4. **Goal-directedness (Social drive, Satisfaction drive)** — These drives modulate what Type 1 behaviors are retrieved (selection bias), not the threshold itself.

**Recommendation for E5 implementation:**
- Define the exact threshold function: `dynamic_threshold(drive_state) -> float[0.30, 0.70]`
- Consult cortex.md agent profile (referenced in roadmap as source for this specification)
- Test empirically during E10 (Integration): measure whether threshold modulation produces adaptive behavior (e.g., higher threshold in novel situations reduces reliance on potentially inappropriate habits)

**Critical Check: Can Type 1 and Type 2 Run in Parallel?**

The biological analogy suggests they might compete in parallel rather than sequentially. In the brain:
- System 1 (basal ganglia) and System 2 (prefrontal) operate **simultaneously**
- The anterior cingulate monitors for conflict
- Whichever system produces stronger activation wins

This suggests E5 should **generate predictions from both Type 1 AND Type 2 candidates in parallel**, evaluate both, and let arbitration select the highest-confidence candidate. This would be more biologically accurate than "try Type 1, fall back to Type 2."

---

## 4. Attention and Arousal Gating for Episodic Memory Encoding

### The Three Attentional Networks (Posner & Petersen, 1990; Fan et al., 2002)

**Alerting Network (Locus Coeruleus, Norepinephrine)**
- Achieving and maintaining readiness to respond
- Tonic alertness (baseline vigilance) vs. phasic alertness (sudden heightened readiness)
- Modulates sensory gating at thalamus and cortex

**Orienting Network (Parietal Cortex, Temporal-Parietal Junction)**
- Selecting specific information from the input stream
- Endogenous (goal-directed, top-down) vs. exogenous (stimulus-driven, bottom-up)
- Produces attention shifts and depth-of-processing modulation

**Executive Attention (Anterior Cingulate, Prefrontal Cortex)**
- Conflict monitoring and resolution
- Error detection and correction
- Cognitive control in novel situations

### Mapping to E5: Encoding Depth Determination

The CANON specifies episodic memory is "gated by attention/arousal" but does not specify the mechanism. Here is the neuroscientific basis for the encoding gating decision:

**What Should Gate Episodic Encoding Depth:**

1. **Stimulus-Driven Salience (Exogenous, Orienting Network)**
   - Guardian input → always encode fully (exogenous orienting, high salience)
   - Negative outcomes (prediction error) → encode at higher depth (saliency from unexpected discrepancy)
   - Positive outcomes matching prediction → encode at lower depth (confirmatory, low information gain)

2. **Goal-Directed Attention (Endogenous, Orienting Network)**
   - Current system goals (from Drive Engine) determine what stimulus dimensions get encoded deeply
   - High Curiosity + novel entity mentioned → deep encoding of that entity
   - Low Curiosity + routine situation → shallow encoding of non-salient details

3. **Arousal Level (Alerting Network, Locus Coeruleus tone)**
   - High Drive Pressure (total pressure >0.6) → increase encoding depth for all stimuli (system is activated)
   - Low Drive Pressure (total pressure <0.3) → shallow encoding unless stimulus is exogenously salient
   - **Rationale:** High arousal indicates the system is engaged and predictions matter; low arousal indicates few motivated goals, so memory detail is less critical

4. **Predictability (Anterior Cingulate Conflict Detection)**
   - Prediction error (actual ≠ predicted) → increase encoding depth
   - Prediction matches (confirmatory) → shallow encoding
   - Prediction confidence determines encoding speed (high-confidence predictions → faster shallow encoding; low-confidence predictions → slower, deeper encoding)

**Proposed Implementation for E5:**

```
encoding_depth = f(
  exogenous_salience(input_type, guardian_input_flag, prediction_error_magnitude),
  endogenous_goal_relevance(current_drive_priorities, entity_novelty_relative_to_WKG),
  arousal_level(drive_total_pressure),
  prediction_confidence_mismatch(predicted_confidence, actual_outcome)
)
```

Where `encoding_depth` ranges 0.0 (skip encoding entirely) to 1.0 (full detail with rich contextual metadata).

**Biological Comparison:**
- Locus coeruleus firing rate is proportional to task arousal (polyphasic firing in alertness, tonic firing in attention)
- Hippocampal encoding strength correlates with norepinephrine levels (during high-salience events)
- Anterior cingulate activity predicts depth-of-processing in working memory tasks

**Specific Recommendation for E5:**

Define and implement `encodeEpisodicMemory(input, context) -> depth: float[0.0, 1.0]`:
- Compute 4 orthogonal factors (exogenous salience, endogenous relevance, arousal, conflict)
- Multiply or combine in a specified way (recommend: `depth = salience * (0.3 + 0.7 * arousal) * (1 + prediction_error_factor)`)
- Store the computed `depth` value with the event in TimescaleDB (allows later analysis of encoding patterns)
- Use depth during Learning consolidation: shallow events may be skipped in maintenance cycles; deep events prioritized for edge extraction

---

## 5. Prediction Error Neuroscience: Dopaminergic Learning Signal

### Schultz's Dopamine Hypothesis (1997)

**The Discovery:**
Wolfram Schultz recorded from dopamine neurons in primate midbrain (ventral tegmental area, VTA) during learning tasks. The critical finding:

**Dopamine fires not to reward, but to reward prediction error:**
- **Expected reward** → dopamine continues baseline firing (no surprise)
- **Unexpected reward** → dopamine spikes (positive prediction error: actual > predicted)
- **Expected reward withheld** → dopamine dips below baseline (negative prediction error: actual < predicted)
- **Unexpected punishment** → dopamine dips below baseline (negative prediction error)

This is the neural implementation of the **Rescorla-Wagner learning rule:**
```
ΔV = α * (R - V)
where V = expected value, R = actual reward, α = learning rate
```

**Implication:** Learning rate is proportional to prediction error magnitude. Large errors drive learning; zero error drives no learning.

### E5's Prediction-Evaluation Loop Implementation

From the roadmap and CANON:

1. **Prediction Generation (Inner Monologue):** Before action selection, generate multiple predictions for candidate actions
2. **Action Execution:** Execute highest-confidence action
3. **Outcome Observation:** Record actual outcome
4. **Prediction Error Computation:** actual - predicted
5. **Learning Signal:** Error magnitude drives confidence updates, Opportunity detection, and drive state changes

**Mapping to Dopaminergic Learning:**

| Biological Process | E5 Implementation |
|-------------------|------------------|
| Dopamine baseline | Prediction matching (expected outcome occurs) |
| Dopamine spike (positive error) | Unexpected positive outcome → Satisfaction increase |
| Dopamine dip (negative error) | Unexpected negative outcome → Anxiety/Moral Valence increase, Opportunity creation |
| Error-driven learning rate | ACT-R confidence formula: magnitude of error determines magnitude of confidence update |
| Generalization of learning | Failed prediction flags knowledge edge for re-examination (retrieval-induced plasticity) |

### Validation Assessment: STRONG GROUNDING

**Strengths:**

✓ **Error-Driven Learning** — E5's design computes prediction error and uses it to drive learning. This is directly Schultzian.

✓ **Opportunity Detection from Prediction Failure** — When prediction error exceeds threshold, the Drive Engine creates Opportunities. This maps to dopaminergic novelty/salience signals that trigger planning (prefrontal-striatal circuits).

✓ **Magnitude-Proportional Updates** — The confidence updater should implement magnitude-proportional learning. The ACT-R formula in CANON uses `count` (repetitions) but should also weight by error magnitude on each trial.

**Implementation Gaps:**

1. **Prediction Error Magnitude Not Yet Specified** — The roadmap says predictions are "generated before action" and "evaluated after" but does not specify:
   - What constitutes the "prediction" (continuous value? categorical? probability distribution?)
   - What constitutes the "outcome" (continuous? categorical? multi-dimensional?)
   - How error is computed (MAE? MSE? cross-entropy for categorical?)
   - How error magnitude maps to learning rate (linear? sigmoidal? logarithmic?)

   *Biological basis:* Dopamine response is proportional to error magnitude but saturates (strong response to ~2x expected reward, weaker response to 10x expected). Suggests sigmoid mapping: `learning_rate = α_base * sigmoid(error_magnitude / σ)`

2. **Prediction Confidence vs. Outcome Certainty** — The design distinguishes:
   - **Prediction confidence** (how sure the action is in the candidate set)
   - **Outcome accuracy** (MAE on past predictions for Type 1 graduation)

   But it should also track **prediction calibration**: does a "60% confident" prediction actually succeed ~60% of the time? Miscalibration (overconfidence) is a common failure mode. Recommendation: track prediction calibration as a health metric.

**Critical Recommendation for E5 Implementation:**

Define the prediction error computation explicitly:
- **Continuous outcome space (e.g., drive deltas, latency, success count):** Use MAE or MSE
- **Categorical outcome space (e.g., success/failure, outcome type):** Use cross-entropy or classification error
- **Multi-dimensional outcomes (drive vector):** Use weighted Euclidean distance or separate error per dimension
- **Map error to learning rate:** Implement sigmoid saturation to prevent over-learning from extreme outliers

Document in CANON Appendix A.4 (Opportunity Detection Criteria) the error thresholds that trigger Opportunity creation vs. "normal learning variation."

---

## 6. Temporal Dynamics and Timescale Alignment

### Biological Timescales Across Brain Systems

| Process | Timescale | Neural Substrate |
|---------|-----------|------------------|
| Sensory transduction | <10ms | Peripheral receptors |
| Perception (primary sensory cortex) | 50-100ms | V1, A1, etc. |
| Attention shifting | 100-200ms | Parietal/frontal attention networks |
| Working memory hold | 1-30s | Prefrontal cortex (decay ~10s without rehearsal) |
| Deliberate decision making | 0.5-5s | Prefrontal cortex + parietal |
| Motor execution | 100-500ms | Motor cortex + cerebellum |
| Feedback-based learning (single trial) | 10s-1min | Striatum + dopamine |
| Habit formation | hours-days for simple skills, weeks for complex | Basal ganglia + cortex |
| Episodic consolidation | hours-days (first consolidation), days-weeks (systems consolidation) | Hippocampus → cortex transfer |
| Semantic knowledge integration | days-months | Cortical networks |

### E5 Timescales

**Executor Loop Tick:**
- The roadmap specifies an Executor Engine with a state machine: IDLE -> CATEGORIZING -> PREDICTING -> ARBITRATING -> RETRIEVING -> EXECUTING -> OBSERVING -> LEARNING
- **No tick rate specified** (CANON Gap A.3)

**Biological Analog for Decision Cycle:**
The human decision cycle for routine actions operates on a ~1-5 second timescale:
- Action planning (prefrontal): 0.5-2s
- Motor execution: 0.1-0.5s
- Sensory feedback reception: <0.1s
- Error detection and correction: 0.2-1s

**Recommendation for E5:**

Define tick rate based on intended use case:
- **Fast (10Hz = 100ms per state transition):** Suitable for reactive decision-making (catching a falling object, responding to urgent input)
- **Normal (2-5Hz = 200-500ms):** Suitable for conversational interaction and routine tasks
- **Slow (1Hz = 1s per state):** Suitable for deliberative reasoning (planning novel sequences)

The system should probably run at **2-5Hz baseline** with the ability to speed up (alert mode) or slow down (complex reasoning mode).

**Critical Implementation Detail:**

The 8-state machine (IDLE → CATEGORIZING → PREDICTING → ARBITRATING → RETRIEVING → EXECUTING → OBSERVING → LEARNING) should take **at least 2 cycles** (400-800ms at 5Hz) to complete. This allows:
- Sufficient time for prediction generation (Inner Monologue) in PREDICTING state
- Sufficient time for Type 1 and Type 2 competition in ARBITRATING state
- Sufficient time for LLM completion in PREDICTING or ARBITRATING if Type 2 is selected

Monitor: If average cycle time >1s at 5Hz baseline, the system is bottlenecked (likely LLM latency). This should trigger:
- Adaptive speedup of non-LLM paths
- Offline prediction generation (generate predictions in advance, don't wait for PREDICTING state)
- Prediction caching (reuse predictions from recent similar contexts)

### Consolidation Timescale

**Episodic to Semantic Transfer:**
- Fresh (<1h): Detail-rich, not yet consolidated
- Recent (1-24h): Still in Working Memory/Short-Term Storage
- Consolidated (>24h): Transferred to semantic storage (WKG)
- Archived (>7d): Minimal episodic record

This maps to biological consolidation:
- Immediate period (minutes to hours): Hippocampus-dependent, interference-sensitive
- Intermediate period (hours to days): Gradual cortical strengthening
- Remote period (days to months): Cortical-dominant, interference-resistant

**Validation:** The E5 spec is sound. No changes needed.

### Type 1 Graduation Timescale

The Type 1 graduation criteria: **confidence >0.80 AND MAE<0.10 over last 10 uses**

How long is 10 uses at 5Hz?
- At 5Hz baseline with 8-state cycle = 1.6s per decision cycle
- 10 uses = 16 seconds of clock time

This is **too fast for genuine procedural learning**. Humans develop procedural memory much more slowly:
- Simple motor skill (e.g., typing a key sequence): ~100-1000 repetitions
- Complex skill (e.g., driving): thousands of repetitions over weeks
- Expert-level skill: millions of repetitions over years

**However:** Sylphie's learning environment is constrained (primarily conversational, not embodied exploration). The 10-use window may be appropriate for this domain:
- If Sylphie learns a specific conversational response or routine action with high success rate early, it can graduate quickly
- The higher bar (MAE<0.10 AND confidence >0.80) prevents premature graduation

**Recommendation:** Validate empirically in E10 (Integration). Measure:
1. How many use cycles occur before first Type 1 graduation
2. Whether graduated Type 1s show stable performance or regress
3. Whether demotion (MAE>0.15) occurs in early-graduated behaviors

If demotion is frequent, either:
- Increase the use window (50 uses instead of 10)
- Increase the confidence threshold (0.85 instead of 0.80)
- Increase the accuracy requirement (MAE<0.05 instead of 0.10)

---

## 7. Failure Modes from Lesion Studies

### Luria's Lesion Method

Luria diagnosed brain function by mapping the pattern of deficits that emerged when specific brain regions were damaged. The principle: **each brain region contributes a specific capability; removing that capability reveals the function.**

Applying this to E5: what happens when each E5 component fails?

### Lesion 1: Episodic Memory System Fails (TimescaleDB unavailable)

**Biological Analog:** Medial temporal lobe amnesia (patient H.M.)

**Symptom Pattern:**
- Can still perceive and respond in the moment (sensory cortex intact)
- Can still execute habits and Type 1 reflexes (basal ganglia intact)
- **Cannot form new declarative memories**
- Cannot ground deliberation in recent experience

**E5 Manifestation:**
- Decision Making can still retrieve Type 1 candidates
- Communication can still process guardian input
- **Cannot generate informed predictions (Inner Monologue has no episodic context)**
- Learning subsystem cannot consolidate because raw events are unavailable
- **System operates purely on WKG reflexes and drive state, without situational context**

**Detection Strategy:**
- Monitor: TimescaleDB query latency and error rates
- Expected behavior: system becomes rigid and context-insensitive
- Diagnostic test: Guardian repeats the same phrase twice in quick succession. If the system cannot notice the repetition (no episodic memory of the first occurrence), episodic memory is broken.

**Biological Analogy Validity:** HIGH. Patient H.M. and other temporal lobe amnesia patients demonstrate exactly this pattern: automatic responding preserved, declarative learning gone, no context-dependent adjustment.

---

### Lesion 2: Inner Monologue / Prediction Generation Fails (LLM unavailable during PREDICTING state)

**Biological Analog:** Ventromedial prefrontal cortex lesion with preserved motor execution

**Symptom Pattern:**
- Can still execute Type 1 reflexes (fast path)
- **Cannot generate novel predictions or evaluate contingencies**
- Behavior becomes stimulus-bound and rigid
- Cannot plan or reason about future outcomes

**E5 Manifestation:**
- When a situation requires Type 2 reasoning (no Type 1 candidate above threshold), the system has no predictions to evaluate
- Arbitration defaults to Type 1 with lowest action energy cost (reflex)
- System becomes reactive rather than deliberative
- **Cannot use prediction error for learning** — if no prediction was generated, no error can be computed

**Detection Strategy:**
- Monitor: LLM service availability and timeout errors
- Expected behavior: system defaults to low-cost reflexes regardless of drive state or context
- Diagnostic test: Present a novel situation that requires reasoning. If the system has no Type 2 response, Inner Monologue is broken.
- **This is the baseline behavior for Type 1-only operation in the Lesion Test** (CANON p.329)

**Biological Validity:** HIGH. vmPFC lesions produce "myopia for the future" — intact sensation and habit, no ability to simulate consequences. Patient EVR (from Antonio Damasio's case studies) demonstrates this.

---

### Lesion 3: Type 1/Type 2 Arbitration Fails

**Biological Analog:** Anterior cingulate damage with conflicting prefrontal and basal ganglia signals

**Symptom Pattern:**
- Both Type 1 and Type 2 responses available but **no coherent selection mechanism**
- System alternates randomly or perseverates on inappropriate behavior
- High conflict (error) signals ignored
- Cannot override habitual responses when context changes

**E5 Manifestation:**
- Type 1 candidates generated, Type 2 candidates available, but no arbitration logic
- Executor Engine stuck in ARBITRATING state, cannot advance
- Or, arbitration selects Type 1 reflexes even when all are low-confidence

**Detection Strategy:**
- Monitor: Arbitration decision latency and error distribution
- Expected behavior: poor decision quality, high prediction error rates
- Diagnostic test: Provide strong guardian correction ("that was wrong, do this instead"). If the system ignores the correction and repeats the same action, arbitration is damaged.

**Biological Validity:** HIGH. Anterior cingulate damage produces perseveration and inability to shift behavior despite error feedback. Patient with anterior cingulate lesion shown stop-sign task: if stop-sign changes location, patient cannot update response; if told "you're wrong," patient cannot implement correction.

---

### Lesion 4: Executor Engine State Machine Fails

**Biological Analog:** Dorsolateral prefrontal cortex damage with preserved basal ganglia

**Symptom Pattern:**
- Cannot initiate or sequence complex actions
- Behavior breaks down into disconnected segments
- Cannot maintain goals or re-engage after distraction
- Stimulus-bound (responds immediately to each input without internal plan)

**E5 Manifestation:**
- Executor Engine state transitions fail (stuck in single state)
- Decision loop does not progress through complete cycle
- System receives input but does not move through CATEGORIZING → PREDICTING → ... → EXECUTING
- Actions execute but without planning or prediction context

**Detection Strategy:**
- Monitor: Executor Engine state transitions and dwell time in each state
- Expected behavior: incomplete decision cycles, actions without context
- Diagnostic test: Request a multi-step action ("first say X, then observe Y, then respond if Z happens"). If the system executes only the first step or executes all steps simultaneously, executor engine is damaged.

**Biological Validity:** MEDIUM. dlPFC lesions produce "sequencing deficits" and "action schema fragmentation," but execution can still occur through direct stimulus-response. Not a perfect analogy because the Executor Engine is not spatially localized, but the failure pattern (loss of planning and sequencing) is correct.

---

### Lesion 5: Confidence Updater (ACT-R Dynamics) Fails

**Biological Analog:** Striatal dopamine dysfunction (Parkinson's disease; schizophrenia)

**Symptom Pattern:**
- Actions can still execute but learning does not occur
- Prediction error signals are not reinforcing
- Behaviors do not improve with repetition
- Type 1 graduation never happens (no confidence increase)

**E5 Manifestation:**
- Predictions generated and evaluated but confidence values do not update
- Type 1 candidates remain low-confidence despite successful repetitions
- No shift from Type 2 to Type 1 over time
- **The learning loop is broken** — experience does not produce improvement

**Detection Strategy:**
- Monitor: Confidence update logs and Type 1 graduation rates
- Expected behavior: flat learning curve (Type 1/Type 2 ratio does not improve over time)
- Diagnostic test: Measure confidence on a frequently-used, always-successful action after 100 executions. If confidence is unchanged from initial value, confidence updater is broken.

**Biological Validity:** VERY HIGH. Parkinson's patients lose the ability to learn new habits because dopaminergic striatum is damaged. Learning loss is distinct from execution loss (they can execute learned habits but cannot form new ones). This exactly matches the E5 failure pattern.

---

### Lesion 6: Disconnection Between Subsystems (Drive Engine Output Unavailable)

**Biological Analog:** Disconnection syndrome (damage to white matter tracts connecting brain regions)

**Symptom Pattern:**
- Individual regions intact but cannot communicate
- Coordinated behavior breaks down
- System operates in isolation without integration
- No motivational substrate for action

**E5 Manifestation:**
- Drive Engine process dies or IPC channel breaks
- Decision Making receives no drive state (all drives = null/undefined)
- Arbitration has no motivational context for threshold modulation
- System cannot determine what to prioritize or why
- **Becomes dysexecutive** — technically capable of execution but unmotivated

**Detection Strategy:**
- Monitor: Drive state freshness (timestamp of last received snapshot)
- Expected behavior: decisions become unmotivated and arbitrary; prediction error does not modulate drive state
- Diagnostic test: Measure whether drive state changes correlate with action outcomes. If no correlation, disconnection occurred.

**Biological Validity:** HIGH. Disconnection syndromes produce exactly this pattern — behavior fragments because subsystems cannot communicate. Callosal damage (disconnecting hemispheres) produces dramatic examples where left hemisphere acts without coordination from right.

---

## 8. Reconsolidation During Retrieval: Retrieved-and-Failed Knowledge

### The Reconsolidation Phenomenon

When a consolidated memory is actively retrieved, it temporarily becomes **labile** (plastic, modifiable) again. This reconsolidation window lasts ~10-60 minutes and allows the memory to be updated with new information (Nader & Hardt, 2009).

**Key finding:** A memory that is retrieved and finds a mismatch (prediction error) becomes more plastic than dormant knowledge. This is adaptive: knowledge that is being actively used and producing errors is exactly what needs updating.

**Implication for learning:** Retrieved-and-failed knowledge should receive **stronger confidence updates** than dormant knowledge that fails (because dormant knowledge was never relied upon).

### E5 Implementation: Retrieval-Induced Plasticity

**Current Design (Implicit):**
When a Type 1 candidate is retrieved for prediction and produces a prediction error:
1. Prediction error is computed (OBSERVING state)
2. Confidence updater receives signal: prediction_error > threshold
3. Confidence decreases (negative update)
4. If MAE > 0.15, Type 1 demotion occurs

**Missing: Explicit Plasticity Signal**

The design should explicitly tag retrieved-and-failed knowledge for **prioritized re-examination**:

```
On prediction error during OBSERVING:
  if (candidate was retrieved for prediction):
    // Reconsolidation signal
    mark_edge_for_plasticity(candidate.source_edge, plasticity_window = 30min)
    // Prioritize for next maintenance cycle
    Learning.prioritize_for_examination(candidate.source_edge)
```

**Benefit:** Learning subsystem knows to examine retrieved-and-failed edges before dormant edges, implementing the reconsolidation principle.

### Recommendation for E5

Define `PlasticityCost` or `RecentlyRetrievedFlag` on WKG edges:
- Set to true when edge is retrieved during prediction
- Decays over 30-60 minutes (reconsolidation window)
- Learning subsystem prioritizes high-plasticity edges in maintenance cycles

This ensures that knowledge actively being used and failing gets updated before less-relevant knowledge.

---

## 9. Working Memory Capacity Constraints: Inner Monologue

### Cowan's Working Memory Model

George Miller (1956) proposed "The Magical Number Seven, Plus or Minus Two" — humans can hold ~7 items in working memory.

George Cowan's revision (2001): The actual limit is ~4 items, but chunking can increase apparent capacity.

**Mechanism:** Prefrontal cortex maintains activation of task-relevant information. Beyond ~4 chunks, decay and interference make maintenance impossible.

**Implications:**
- Conscious attention can focus on ~1 item
- Working memory can hold ~4 items simultaneously
- Each item has limited detail (though chunks can be complex)

### E5 Inner Monologue Capacity

The Inner Monologue generates multiple predictions from episodic memory before action selection. **No candidate limit is specified.**

**Question:** How many candidate actions should the system consider before arbitration?
- 1 candidate: Too narrow, no choice
- 4 candidates: Matches working memory capacity
- 7 candidates: Upper limit (Millerish)
- 10+ candidates: Exceeds working memory, quality degrades

**Biological Constraint:** If human working memory tops out at ~4 items, and arbitration must compare predictions, then **more than 4-5 candidates becomes cognitively intractable**.

**Recommendation for E5:**

Implement candidate limitation:
```
candidates = retrieve_top_N_by_confidence(N=4, min_confidence=threshold)
predictions = [predict(c) for c in candidates]
arbitrated = arbitrate(predictions, drive_state)
```

**Benefits:**
1. Matches biological working memory capacity
2. Reduces cognitive effort (fewer comparisons)
3. Forces the system to prioritize (retrieve best candidates, not all candidates)
4. Prevents "decision paralysis" from too many options

**Implementation Detail:** The "top 4 by confidence" approach naturally selects high-confidence Type 1 candidates first, falling back to lower-confidence Type 2 candidates if insufficient Type 1 candidates exist.

**Test in E10:** Measure decision latency and quality as a function of candidate count. Plot should show:
- Performance increases with candidates 1→4 (more options improve decision quality)
- Performance plateaus or declines for candidates 5+ (cognitive overload)

---

## 10. Summary of Design Validation and Gaps

### Strong Grounding (No Changes Needed)

| Component | Biological Basis | Confidence |
|-----------|------------------|------------|
| Episodic → Semantic consolidation | Systems Consolidation Theory | VERY HIGH |
| ACT-R confidence dynamics | Hebbian plasticity + LTP/LTD | HIGH |
| Type 1/Type 2 graduation | Procedural memory formation | HIGH |
| Prediction error learning | Dopaminergic prediction error (Schultz) | VERY HIGH |
| Temporal degradation (fresh→archived) | Hippocampal-cortical consolidation timescale | HIGH |
| Retrieval-induced plasticity concept | Reconsolidation theory | HIGH |
| Guardian asymmetry (2x/3x weight) | Primacy of explicit teaching in development | MEDIUM-HIGH |

### Gaps Requiring Specification Before E5 Implementation

| Gap | Specification Needed | Biological Basis | Impact |
|-----|---------------------|------------------|--------|
| **Encoding Gating** | What determines attention/arousal thresholds for episodic memory? | Locus coeruleus (norepinephrine) + anterior cingulate | HIGH — affects what experiences are remembered |
| **Prediction Format** | What do predictions look like? (Continuous? Categorical? Probability distribution?) | Depends on outcome space (varies by task domain) | CRITICAL — affects error computation and learning signals |
| **Dynamic Threshold Function** | How exactly does drive state modulate Type 1/Type 2 threshold? | Varies by drive (Anxiety ≠ Curiosity effect on automaticity) | MEDIUM — affects adaptive behavior |
| **Executor Loop Tick Rate** | How fast does the decision cycle run? (10Hz? 1Hz? Adaptive?) | Biological decision cycles: 1-5Hz | MEDIUM — affects system responsiveness |
| **Prediction Error Magnitude Mapping** | How does error magnitude map to learning rate? (Linear? Sigmoid?) | Dopaminergic response is sigmoidal (saturates at high errors) | MEDIUM — affects learning speed |
| **Working Memory Limit for Candidates** | Should Inner Monologue limit candidates to ~4? | Cowan's working memory capacity | LOW-MEDIUM — minor optimization |

### Failure Mode Detection Strategies (for E10)

| Lesion | Detection Test | Expected Finding |
|--------|---|---|
| Episodic Memory (TimescaleDB) | Repeat guardian statement; observe if system notices repetition | System cannot detect repetition; context-insensitive behavior |
| Inner Monologue (Prediction) | Novel situation requiring reasoning | System defaults to low-cost reflexes; no Type 2 reasoning |
| Arbitration | Guardian correction; observe if system updates | System perseverates on previous choice |
| Executor Engine | Multi-step action request | System executes only one step or all steps simultaneously |
| Confidence Updater | Measure confidence after 100 repetitions of successful action | Confidence remains unchanged (no learning) |
| Drive Disconnection | Measure correlation between action outcomes and drive changes | Zero correlation; system behavior unmotivated |

---

## 11. Recommendations for E5 Implementation

### Before Writing Code

1. **Approve or specify CANON Appendix A.2 (Episodic Memory Encoding Gating)**
   - Recommendation: Implement encoding gating as `depth = salience * arousal * (1 + prediction_error_factor)`
   - Document in CANON A.2 the exact formula and parameter ranges

2. **Approve or specify CANON Appendix A.3 (Type 1/Type 2 Arbitration Algorithm)**
   - Recommendation: Collect drive state, compute threshold = 0.5 + 0.2 * (anxiety_effect + boredom_effect - curiosity_effect)
   - Define which drives modulate threshold and how (consult cortex.md)
   - Specify whether Type 1 and Type 2 run in parallel or sequentially

3. **Define Prediction Format and Error Computation**
   - Specify: What does a prediction contain? (E.g., "Action X will produce drive delta [Satisfaction: +0.15, Anxiety: -0.05, ...]")
   - Specify: How is error computed? (E.g., "Euclidean distance in 12-dimensional drive space")
   - Add to CANON A.4 (Opportunity Detection Criteria) the specific error thresholds

4. **Specify Executor Loop Tick Rate**
   - Recommendation: Baseline 5Hz (200ms per cycle)
   - Document: Expected cycle time per state
   - Add to E9 (Dashboard API): expose Executor Engine state transitions and dwell times for monitoring

### During E5 Implementation

1. **Episodic Memory Service**
   - Implement `IEpisodicMemoryService`:
     - `encode(input, context, depth: float) -> Episode`
     - `getRecentEpisodes(max_age, limit) -> Episode[]`
     - `queryByContext(filter, confidence_threshold) -> Episode[]`
   - Store computed `encoding_depth` with each episode for later analysis

2. **Inner Monologue**
   - Implement `generatePredictions(candidates: ActionCandidate[], episodic_context: Episode[]) -> Prediction[]`
   - Limit to 4-5 candidates (working memory constraint)
   - Each prediction includes: action_id, predicted_drive_delta, predicted_confidence_for_this_outcome

3. **Type 1/Type 2 Arbitration**
   - Compute dynamic threshold from drive state
   - Implement parallel evaluation: generate both Type 1 and Type 2 predictions if insufficient Type 1 candidates
   - Select highest-confidence candidate passing threshold
   - Implement Shrug Imperative: if no candidate above threshold, return shrug action (honest incomprehension)

4. **Confidence Updater Enhancement**
   - Weight updates by error magnitude: `Δconfidence = α_base * sigmoid(|error| / σ)`
   - Track prediction calibration: measure if "60% confident" predictions actually succeed ~60% of the time
   - Implement plasticity tagging: mark retrieved-and-failed edges for prioritized re-examination

5. **Executor Loop**
   - Document state machine fully
   - Instrument all state transitions for E9 dashboard
   - Implement timeout detection: if stuck in single state >5 seconds, flag as system error
   - Monitor: total cycle time vs. target tick rate

### During E10 (Integration Testing)

1. **Lesion Tests**
   - Run Sylphie with TimescaleDB unavailable → observe episodic memory lesion pattern
   - Simulate prediction failure → observe Inner Monologue lesion pattern
   - Disable arbitration → observe decision consistency degradation
   - Run without LLM (Type 1 only) → verify baseline Lesion Test

2. **Learning Curve Validation**
   - Measure Type 1 graduation rates
   - Plot: confidence vs. number of uses
   - Verify: significant confidence increase by use 10 for successful actions
   - Verify: rapid demotion if MAE > 0.15

3. **Prediction Error Distribution**
   - Collect all prediction errors over 1000 decision cycles
   - Plot error magnitude distribution
   - Verify: sigmoidal saturation (large errors don't produce proportionally larger learning signals)
   - Verify: error magnitudes correlate with drive state changes

4. **Working Memory Capacity**
   - Measure decision quality vs. number of candidates evaluated
   - Verify: quality peaks at 4-5 candidates
   - Verify: diminishing returns or degradation beyond 5 candidates

5. **Attention/Arousal Gating**
   - Collect encoding depths across episodic memory operations
   - Verify: prediction errors are encoded more deeply than routine operations
   - Verify: guardian input is always encoded at high depth
   - Verify: encoding depth correlates with drive pressure (high arousal → deeper encoding)

---

## 12. Conclusion: Biological Plausibility and System Health

**Overall Assessment:** E5 is **strongly grounded in neuroscience** with only minor specification gaps. The core insight — that decision making arises from coordinated interaction between episodic memory, dual-process arbitration, prediction error learning, and drive-mediated motivation — is **biologically sound and cognitively appropriate**.

**The Three Key Structural Strengths:**
1. **Episodic → Semantic consolidation** maps directly to hippocampal-cortical systems
2. **Prediction error learning** implements Schultz's dopaminergic mechanism
3. **Type 1/Type 2 arbitration with graduated learning** mirrors basal ganglia/prefrontal competition

**The Critical Vulnerabilities to Monitor:**
1. **Encoding gating underspecified** — without clear attention/arousal thresholds, the system may encode noise or miss signal
2. **No working memory limit on candidates** — Inner Monologue may bloat and slow decision-making
3. **Prediction format undefined** — implementation cannot proceed without knowing what a prediction contains

**The Lesion Test as Ground Truth:**
The CANON's Lesion Test (run without LLM, observe what remains) is a direct application of Luria's methodology. E5 should be designed with lesion testing in mind from day one. The degradation pattern when each subsystem fails will reveal whether the architecture is genuinely modular or whether hidden dependencies exist.

**Final Recommendation:**

E5 is ready to implement once the three specification gaps are resolved. The biological grounding is sound; the design is coherent; the failure modes are predictable. During implementation, instrument everything for E9 and E10 — particularly Executor Engine state transitions, episodic memory encoding depths, and prediction error magnitudes. These observables will be the ground truth for whether the system is developing genuine behavioral personality or merely executing LLM-generated responses.

The question posed in CANON (Section on "What Sylphie Is") is profound: **what happens when you give an AI system a body, drives, a growing world model, and a human teacher — and let experience shape who she becomes?** E5 is the mechanism through which experience translates into personality. Get this right, and the rest follows.

---

**Prepared by:** Luria, Neuropsychological Systems Advisor
**For:** Sylphie Labs, Epic 5 Planning Phase
**Status:** Ready for Implementation with Noted Specification Gaps
**Next Review Point:** E5 Design Document (before code), then E10 Integration Testing
