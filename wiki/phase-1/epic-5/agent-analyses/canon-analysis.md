# Epic 5: Decision Making (Core Cognitive Loop) — Canon Compliance Analysis

**Reviewed against:** `wiki/CANON.md` (immutable single source of truth)
**Date:** 2026-03-29
**Analyst:** Canon (Project Integrity Guardian)
**Status:** 7 COMPLIANT | 3 CONCERNS | 5 CRITICAL GAPS

---

## Executive Summary

Epic 5 implements the central cognitive loop — the most complex subsystem in Phase 1. It must orchestrate episodic memory encoding, prediction generation, dual-process arbitration, action retrieval, and contingency-based learning while maintaining strict boundaries against Theater Prohibition, Confidence Ceilings, and the Shrug Imperative.

**The roadmap specification is architecturally sound** but relies on three reserved CANON appendix items (A.2, A.3, A.8) that must be written before E5 implementation begins. Additionally, **five design decisions require Jim's explicit approval** before code starts.

**Key finding:** E5 is the PRIMARY enforcer of Immutable Standards 3 (Confidence Ceiling) and 4 (Shrug Imperative) and a critical co-enforcer of Standard 2 (Contingency Requirement). This makes E5 the most standards-critical subsystem after E4.

---

## 1. Core Philosophy Alignment

### 1.1 Experience Shapes Knowledge — LLM Provides Voice (CANON §CP1)

**Specification:**
E5 implements "Inner Monologue" to generate multiple predictions, then "Type 1/Type 2 Arbitration" where Type 1 (graph-based) competes with Type 2 (LLM-assisted). Type 2 carries explicit cost (latency, cognitive effort drive pressure).

**CANON References:**
- §CP1: "The LLM provides immediate communicative competence... But every conversation feeds the Learning subsystem."
- §CP2: "Everything starts as Type 2. Through successful repetition, behaviors graduate to Type 1... Type 2 must always carry explicit cost."

**Analysis:**

**COMPLIANT** — E5 correctly implements the dual-process developmental trajectory:

- ✓ Type 1 reflexes are retrieved directly from WKG (no LLM)
- ✓ Type 2 generates predictions via LLM ("Inner Monologue")
- ✓ Arbitration favors Type 1 when confidence > dynamic threshold
- ✓ Type 2 cost is real: latency reported to Drive Engine (E4) increases Cognitive Effort drive pressure
- ✓ Type 1 graduation requires confidence > 0.80 AND MAE < 0.10 (CANON §Confidence Dynamics)
- ✓ Failed predictions (Type 1 demotion, MAE > 0.15) shift weight toward Type 2

**How it enforces LLM-is-voice principle:**
The LLM is engaged when Type 1 confidence fails. The arbitration logic ensures Sylphie increasingly handles situations through her own graph over time. The system never becomes a "pure LLM wrapper" — it's forced to compile learned behaviors into Type 1.

**Status:** **COMPLIANT**

---

### 1.2 Dual-Process Cognition (CANON §CP2)

**Specification:**
E5 roadmap specifies "Type 1/Type 2 Arbitration: Type 1 must demonstrate sufficient confidence to win. Failed predictions shift weight toward Type 2. The confidence threshold is dynamic and bidirectional — modulated by drive state."

**CANON References:**
- §CP2: "Type 1 (Fast/Reflexive)… Type 2 (Slow/Deliberative)… Everything starts as Type 2."
- §Type 1 Graduation: "confidence > 0.80 AND MAE < 0.10 over last 10 uses"
- §Type 1 Demotion: "MAE > 0.15"

**Analysis:**

**COMPLIANT** — E5 implements the full dual-process lifecycle:

- ✓ Action retrieval (Type 1) queries WKG for procedures with confidence ≥ dynamic threshold
- ✓ Inner Monologue (Type 2) generates LLM predictions when Type 1 confidence insufficient
- ✓ Arbitration: if Type 1 confidence > threshold, execute Type 1; else invoke LLM for Type 2
- ✓ Graduation logic: after 10 uses, if confidence > 0.80 AND MAE < 0.10, mark as Type 1
- ✓ Demotion logic: if MAE > 0.15, reduce confidence and shift weight toward Type 2 for next similar situation

**Critical architectural point:**
The dynamic threshold is "modulated by drive state" — high anxiety should lower threshold (act cautiously but act), high cognitive awareness should raise threshold (think before acting). **This requires CANON A.3 specification** before implementation (see Section 9 below).

**Contingency structure is preserved:**
Type 2 cost creates evolutionary pressure. Without cost, Type 2 always wins (Type 2 Addict attractor). Cost structure prevents this failure mode.

**Status:** **COMPLIANT**

---

### 1.3 WKG Is the Brain (CANON §CP3)

**Specification:**
E5 retrieves action procedures from WKG and reads episodic memory (stored in TimescaleDB with semantic consolidation to WKG via E7).

**CANON References:**
- §CP3: "The WKG is not a feature of the system. It IS the system."
- §Subsystem 1 (Decision Making): "Inner Monologue generates multiple Predictions from episodic memory… Action Retriever: retrieve action procedures from WKG by category and confidence"

**Analysis:**

**COMPLIANT** — E5 correctly positions the WKG as the knowledge source:

- ✓ Type 1 action retrieval queries WKG for candidate procedures
- ✓ Episodic memory is first-class: temporal experiences in TimescaleDB, consolidated to WKG by Learning (E7)
- ✓ Predictions are generated from episodic memory (recent experience) and WKG (generalized knowledge)
- ✓ E5 reads WKG; does NOT write to it (writes are Learning subsystem responsibility — E7)
- ✓ Provenance is preserved on all retrieved edges (source signals E5 whether knowledge is SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE)

**Architectural guarantee:**
Decision Making reads from the graph but does not modify it. This preserves the separation of concerns:
- E5 (Decision Making): What to do, when to do it
- E3 (Knowledge): What is true
- E4 (Drive Engine): How effective it was
- E7 (Learning): Consolidate experience into durable knowledge

**Status:** **COMPLIANT**

---

### 1.4 Prediction Drives Learning (CANON §CP6)

**Specification:**
E5 generates predictions ("Inner Monologue"), executes actions, then reports outcomes to E4 (Drive Engine) for evaluation. Drive Engine computes prediction accuracy (MAE), which triggers Opportunities if prediction failed.

**CANON References:**
- §CP6: "Sylphie makes predictions about what will happen before she acts. After acting, she evaluates the prediction against reality. Failed predictions are the primary catalyst for growth."
- §Subsystem 4 (Drive Engine): "Evaluate Prediction Accuracy from Decision Making… Inaccurate predictions → Opportunity Evaluation → Create Opportunity"

**Analysis:**

**COMPLIANT** — E5 is the prediction generation engine:

- ✓ Inner Monologue generates multiple predictions BEFORE action execution
- ✓ Predictions are recorded to TimescaleDB with correlation IDs so Drive Engine can match outcomes
- ✓ After action, actual outcome is reported to Drive Engine
- ✓ Drive Engine computes MAE and triggers Opportunity detection if prediction failed
- ✓ Opportunities flow to Planning (E8), which creates new procedures to prevent future prediction failures
- ✓ Closed loop: predict → act → evaluate → plan → new prediction

**How this prevents stagnation:**
Without prediction failures as learning signals, Planning has no reason to create new procedures, and the system's behavioral repertoire doesn't grow. E5's prediction generation is the gateway to all learning-driven growth.

**Status:** **COMPLIANT**

---

### 1.5 Personality Emerges from Contingencies (CANON §CP5)

**Specification:**
E5 executes actions selected by arbitration. The actions produce outcomes that Drive Engine evaluates via behavioral contingencies (satisfaction habituation, anxiety amplification, guilt repair, social comment quality, curiosity information gain). Personality is the observable pattern of behavior produced by this reinforcement history.

**CANON References:**
- §CP5: "Personality is the observable pattern of behavior produced by reinforcement history. A 'curious' Sylphie is one where approach-toward-novelty reliably produces drive relief across multiple axes."
- §Behavioral Contingency Structure: "Each drive has specific behavioral contingencies that shape personality through reinforcement, not trait targeting."

**Analysis:**

**COMPLIANT** — E5 is the behavior executor:

- ✓ Arbitration selects actions; E5 executes them via Executor Engine
- ✓ Action outcomes feed back to Drive Engine (E4), which applies behavioral contingencies
- ✓ E5 does NOT decide what constitutes "good behavior" — that's defined by Drive Engine (E4) contingency structure
- ✓ E5 simply: retrieve → arbitrate → execute → report outcome
- ✓ Personality emerges as a side effect of repeated action execution under contingency pressure

**Architectural guarantee:**
E5 cannot short-circuit the contingency feedback loop. The action outcome MUST be reported to E4, and E4's evaluation (whether reinforced or punished) determines whether that action is executed again. There is no path for E5 to directly modify confidence scores or drive effects.

**Status:** **COMPLIANT**

---

### 1.6 Provenance is Sacred (CANON §CP7)

**Specification:**
E5 reads provenance tags when retrieving actions from WKG. Type 1 actions with SENSOR/GUARDIAN provenance are more reliable than LLM_GENERATED provenance (base confidence 0.35).

**CANON References:**
- §CP7: "Every node and edge carries a provenance tag: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE. This distinction is never erased. It enables the lesion test."
- §Confidence Dynamics: "SENSOR base: 0.40, GUARDIAN base: 0.60, LLM_GENERATED base: 0.35"

**Analysis:**

**COMPLIANT** — E5 must respect provenance hierarchy:

- ✓ Action Retriever queries WKG and reads provenance tags on action edges
- ✓ Confidence computation takes provenance into account (CANON §Confidence Dynamics)
- ✓ Type 1 graduation uses confidence values that reflect provenance (high-confidence Type 1 is typically SENSOR+GUARDIAN+INFERENCE, not LLM_GENERATED)
- ✓ Provenance is never erased, enabling the lesion test
- ✓ If LLM removed, remaining Type 1 actions are provably self-learned (SENSOR+GUARDIAN+INFERENCE edges)

**Audit trail guarantee:**
A researcher can replay E5's behavior over Sylphie's lifetime and see exactly which actions were self-learned vs. LLM-generated vs. guardian-taught. This is essential for evaluating whether genuine development occurred.

**Status:** **COMPLIANT**

---

### 1.7 Offload What's Solved, Build What Isn't (CANON §CP8)

**Specification:**
E5 uses existing action handlers (speak via LLM, ask_guardian, explore_graph, read_definition) rather than reimplementing communication or learning logic.

**CANON References:**
- §CP8: "Use existing tools for solved problems… Build the thing that doesn't exist: a system that develops genuine behavioral personality through experience-driven prediction, drive-mediated action selection, and contingency-shaped learning."

**Analysis:**

**COMPLIANT** — E5 correctly delegates:

- ✓ speak action → delegates to E6 Communication (LLM response generation)
- ✓ ask_guardian action → delegates to E6 Communication (natural language interface)
- ✓ explore_graph action → delegates to Knowledge module (WKG navigation)
- ✓ read_definition action → delegates to Knowledge module (entity details)
- ✓ learn_from_event action → delegates to E7 Learning (consolidation)
- ✓ E5 focuses on what's new: episodic memory, prediction generation, arbitration logic, executor state machine

**What E5 uniquely builds:**
- Episodic memory (temporally-contextualized experiences)
- Inner Monologue (multiple prediction generation)
- Type 1/Type 2 arbitration (dynamic threshold logic)
- Executor state machine (IDLE → CATEGORIZING → PREDICTING → ARBITRATING → RETRIEVING → EXECUTING → OBSERVING → LEARNING)

**Status:** **COMPLIANT**

---

## 2. Six Immutable Standards Enforcement

### 2.1 Theater Prohibition (CANON §Immutable Standard 1)

**Specification:**
"Any output (speech, motor action, reported state) must correlate with actual drive state. If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement."

**CANON References:**
- §IS1: "The system cannot learn to perform emotions it does not have."
- §Subsystem 2 (Communication): "Drive state must be injected into LLM context when generating responses… Responses that don't correlate with actual drive state are Theater."

**Analysis:**

**CONCERN** — Theater Prohibition enforcement is SPLIT between E5 and E6:

- **E5's responsibility:** When generating predictions about emotional responses, E5 must check drive state. If an action would produce emotional output but the drive is < 0.2, the prediction should reflect this (low satisfaction for that action).
- **E6's responsibility:** When Communication generates responses via LLM, it must check drive state pre-flight. If response would express an emotion but drive < 0.2, suppress or modify the response.
- **E4's responsibility:** Post-flight, if output was produced that violated Theater Prohibition, zero reinforcement is assigned.

**Current gap:**
The roadmap does not explicitly specify which subsystem validates the correlation pre-flight. The CANON states: "If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement regardless of guardian response" — but this is post-flight (E4 responsibility). **Is there a pre-flight validation in E6?** This needs clarification.

**Recommendation:**
Both E5 (prediction generation) and E6 (response generation) should include Theater checks:
1. E5: When generating "speak (emotional)" prediction, check if drive > 0.2
2. E6: Before executing speak action, check if drive > 0.2
3. E4: Post-flight, if violated, zero reinforcement

**Status:** **CONCERN — requires clarification in E6 spec**

---

### 2.2 Contingency Requirement (CANON §Immutable Standard 2)

**Specification:**
"Every positive reinforcement event must trace to a specific behavior. No non-contingent reinforcement. Pressure changes without a corresponding action are environmental events, not learning signals."

**CANON References:**
- §IS2: "Every positive reinforcement event must trace to a specific behavior."
- §Behavioral Contingency Structure: "Each drive has specific behavioral contingencies that shape personality through reinforcement, not trait targeting."

**Analysis:**

**COMPLIANT** — E5 is a critical link in the contingency chain:

- ✓ E5 selects specific action via arbitration (not random action)
- ✓ E5 executes that action via Executor Engine
- ✓ E5 reports outcome to Drive Engine with action ID and outcome data
- ✓ Drive Engine (E4) maps outcome to reinforcement ONLY if it matches a known behavioral contingency
- ✓ Non-contingent pressure changes (e.g., guardian changes drive state directly) do not generate reinforcement
- ✓ The chain is: action → outcome → drive evaluation → contingency match → reinforcement

**Critical requirement for E5:**
When executing actions, E5 MUST emit outcome events to TimescaleDB with:
- action_id (which action was executed)
- action_type (speak, explore, ask_guardian, etc.)
- outcome_data (what happened)
- drive_state_before (snapshot of drives before action)
- drive_state_after (snapshot of drives after action)
- timestamp

This allows Drive Engine (E4) to trace every reinforcement back to a specific behavior, preventing accidental non-contingent learning.

**Status:** **COMPLIANT** (contingent on E5 properly emitting outcome events)

---

### 2.3 Confidence Ceiling (CANON §Immutable Standard 3)

**Specification:**
"No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event. Knowing something isn't enough — you have to use it and succeed."

**CANON References:**
- §IS3: "No node exceeds 0.60 without at least one successful retrieval-and-use event (Immutable Standard 3)."
- §Confidence Dynamics: "Retrieval threshold: 0.50… Confidence ceiling for untested knowledge: No node exceeds 0.60 without at least one successful retrieval-and-use event"

**Analysis:**

**COMPLIANT** — E5 is the PRIMARY ENFORCER of Confidence Ceiling:

- ✓ Action Retriever (E5 component) queries WKG for candidate actions with confidence ≥ dynamic threshold
- ✓ The dynamic threshold is set by Confidence Service (E3), which enforces: if count===0 (no retrieval-and-use), confidence is clamped at 0.60
- ✓ E5 retrieves an action → executes it → reports outcome
- ✓ Knowledge Service (E3) records the "retrieval-and-use" event, incrementing the retrieval count
- ✓ On next confidence computation, if the outcome was positive, confidence increases; if negative, confidence decreases

**How E5 enforces the ceiling:**
1. LLM_GENERATED action (base confidence 0.35) is not retrieved for Type 1 execution until it succeeds at least once
2. First use: if successful, confidence = 0.35 + 0.12 × ln(1) - d × ln(0+1) = 0.35 (still below 0.60)
3. After 10+ successful uses: confidence approaches 0.80 (hits Type 1 graduation threshold)
4. Until then, action stays in Type 2 backlog, executed only when Type 1 fails

**No workaround path:**
LLM cannot convince E5 to execute untested actions as Type 1. The confidence ceiling prevents premature graduation.

**Status:** **COMPLIANT**

---

### 2.4 Shrug Imperative (CANON §Immutable Standard 4)

**Specification:**
"When nothing is above the dynamic action threshold, Sylphie signals incomprehension rather than selecting a random low-confidence action. Honest ignorance prevents superstitious behavior."

**CANON References:**
- §IS4: "When nothing is above the dynamic action threshold, Sylphie signals incomprehension rather than selecting a random low-confidence action."
- §Subsystem 1 (Decision Making): "Shrug Imperative: when nothing above threshold, signal incomprehension"

**Analysis:**

**COMPLIANT** — E5 is the PRIMARY ENFORCER of Shrug Imperative:

- ✓ Arbitration logic: if no Type 1 action above dynamic threshold AND LLM Type 2 confidence below threshold → output shrug action
- ✓ Shrug action: "I don't know how to handle this" (or similar incomprehension marker)
- ✓ Shrug is recorded to TimescaleDB, allowing Drive Engine to detect patterns in situations where Sylphie is unable to act
- ✓ This prevents "action at any cost" behavior — superstitious behavior is suppressed
- ✓ Shrug creates Opportunities: if the same situation recurs and Sylphie shrugs multiple times, Planning (E8) may create a procedure to handle it

**How E5 implements the threshold:**
1. Query Type 1 candidates from WKG
2. Filter for confidence ≥ dynamic_threshold (modulated by drive state, from E4)
3. If no candidates above threshold:
   - a. Invoke LLM for Type 2 deliberation
   - b. LLM generates candidate action(s) with confidence estimate
   - c. If LLM confidence also < threshold → output shrug
   - d. If LLM confidence ≥ threshold → execute Type 2 action

**Prevention of superstition:**
Random low-confidence action execution would produce unpredictable outcomes. Over time, these would create false contingencies ("I did X and nothing bad happened, so X must be good"). The Shrug Imperative blocks this. Instead, failed predictions accumulate, Opportunities are detected, and Planning creates better procedures.

**Status:** **COMPLIANT**

---

### 2.5 Guardian Asymmetry (CANON §Immutable Standard 5)

**Specification:**
"Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight."

**CANON References:**
- §IS5: "Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight."
- §CP4: "The guardian is ground truth for real-world relevance."

**Analysis:**

**CONCERN** — Guardian Asymmetry application in E5 requires Jim's clarification:

E5 interacts with Guardian Asymmetry at multiple points:

1. **Confidence updates (E3 responsibility, but affects E5):**
   - When guardian confirms an action: confidence += 2x multiplier
   - When guardian corrects an action: confidence -= 3x multiplier
   - E5 uses updated confidence values for retrieval decisions

2. **Opportunity weighting (E4/E8 responsibility, but affects E5):**
   - If guardian approves an Opportunity: should it have 2x priority weight in Planning queue?
   - If guardian rejects an Opportunity: should it have 3x de-prioritization?
   - This would make E5's predictions more heavily weighted if guardian confirms them

3. **Action selection bias (E5 responsibility):**
   - Should E5 prefer actions that have guardian-sourced confidence over algorithmic sources?
   - Example: two actions with same confidence score, one GUARDIAN-sourced at 0.60, one LLM_GENERATED at 0.60. Which wins?

**Current ambiguity:**
The CANON specifies weight multipliers but does not specify at what stage they apply:
- During confidence update only (E3 responsibility)?
- During opportunity weighting (E4 responsibility)?
- During action retrieval (E5 responsibility)?
- All of the above?

**Recommendation:**
Define explicit integration points:
1. E3 (Confidence Service): Apply 2x/3x multipliers to confidence deltas on confirmation/correction
2. E4 (Drive Engine): Apply 2x weight to Opportunities from guardian feedback
3. E5 (Action Retriever): Prefer GUARDIAN-sourced actions as tiebreaker when multiple actions have same confidence

**Status:** **CONCERN — requires design decision**

---

### 2.6 No Self-Modification of Evaluation (CANON §Immutable Standard 6)

**Specification:**
"Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured — the evaluation function is fixed architecture."

**CANON References:**
- §IS6: "Confidence update rules, prediction error computation, and drive relief assignment are write-protected from system-initiated modification."
- §Drive Isolation: "Drive computation logic runs in a separate process with a one-way communication channel. The system can READ drive values but cannot WRITE to the evaluation function."

**Analysis:**

**COMPLIANT** — E5 reads drive state but never modifies evaluation:

- ✓ E5 reads current drive state from DriveReaderService (read-only)
- ✓ E5 may use drive state to modulate arbitration threshold (dynamic threshold)
- ✓ E5 reports outcomes to Drive Engine via IPC (one-way)
- ✓ E5 does NOT modify: confidence update formulas, drive accumulation rates, contingency weights, opportunity detection thresholds
- ✓ E5 does NOT write to PostgreSQL `drive_rules` table (only read-access via DriveReaderService reads)
- ✓ All evaluation function changes go through DriveReaderService → IPC → child process → Guardian review queue (E4)

**Architectural guarantee:**
If E5 wanted to make itself successful by lowering the Type 1 graduation threshold (e.g., from confidence > 0.80 to confidence > 0.60), it cannot. The threshold is in Drive Engine (E4), in a separate process, with PostgreSQL RLS write-protection. E5 can only request permission through channels that require guardian approval.

**Status:** **COMPLIANT**

---

## 3. Subsystem Boundary Integrity

### 3.1 Decision Making Does Not Own Other Subsystems

**Specification:**
E5 stays within the Decision Making boundary: processes inputs, generates predictions, arbitrates Type 1/Type 2, retrieves and executes actions, reports outcomes. E5 does NOT:
- Generate responses (E6 Communication responsibility)
- Learn from experience (E7 Learning responsibility)
- Evaluate action success (E4 Drive Engine responsibility)
- Create procedures (E8 Planning responsibility)

**Analysis:**

**COMPLIANT** — E5 boundaries are clear:

**E5 owns:**
- Episodic memory (gating attention/arousal)
- Inner Monologue (prediction generation)
- Type 1/Type 2 arbitration
- Action retrieval from WKG
- Executor state machine
- Outcome reporting to TimescaleDB

**E5 delegates to E6 (Communication):**
- speak, ask_guardian, initiate_comment actions
- Response generation via LLM
- TTS/chatbox output

**E5 delegates to E7 (Learning):**
- Consolidation of episodic memory to semantic knowledge
- Entity extraction
- Edge refinement
- The learning jobs that run on schedule

**E5 reads from E4 (Drive Engine):**
- Current drive state (for threshold modulation)
- Prediction accuracy feedback (via opportunity flags in events)
- But does NOT write to drive rules, contingencies, or evaluation function

**E5 reads from E8 (Planning):**
- Plan procedures stored as actions in WKG
- But does NOT invoke the Planning pipeline (Drive Engine does that when Opportunities are detected)

**Status:** **COMPLIANT**

---

### 3.2 No Creep into Phase 2 (Body/Sensors)

**Specification:**
E5 is pure cognitive architecture, independent of physical embodiment. No sensor integration, no motor control beyond the action handler interface.

**Analysis:**

**COMPLIANT** — E5 has no physical dependencies:

- ✓ Episodic memory stores abstract events (not sensor streams)
- ✓ Predictions are about world state (not proprioception or motor feedback)
- ✓ Actions are abstract procedures (speak, explore, ask_guardian, etc.), not joint angles or motor commands
- ✓ The Executor Engine invokes action handlers; handlers (in E6, Knowledge, etc.) interface with physical systems

**Future-proof design:**
When Phase 2 adds robot chassis, sensor streams will populate episodic memory (as abstract events), but E5's prediction logic doesn't change. E5 continues to: retrieve episodic memory → generate predictions → arbitrate → retrieve actions → execute. The action handlers become richer (navigate to location, manipulate object) but the cognitive loop is unchanged.

**Status:** **COMPLIANT**

---

## 4. Provenance Discipline

**Specification:**
E5 reads and respects provenance tags on actions retrieved from WKG. E5 emits action outcomes to TimescaleDB with metadata enabling provenance tracking.

**Analysis:**

**COMPLIANT** — E5 maintains provenance integrity:

- ✓ Action Retriever reads provenance_source from WKG edges
- ✓ Confidence Service uses provenance to compute initial confidence (SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, INFERENCE: 0.30)
- ✓ E5 never modifies provenance on retrieved actions
- ✓ When E5 reports outcomes, it includes original provenance so Learning (E7) can compute confidence deltas preserving source

**Audit trail:**
Researchers can query: "What percentage of E5's Type 1 actions were GUARDIAN-sourced vs. LLM_GENERATED?" This directly measures whether genuine learning occurred or if the system is just executing LLM-generated procedures.

**Status:** **COMPLIANT**

---

## 5. TimescaleDB Event Emission

**Specification:**
E5 emits all decision events to TimescaleDB with proper typing and metadata.

**CANON References:**
- §Shared Infrastructure (TimescaleDB): "All five subsystems write to TimescaleDB."
- §Stream separation: "Events should be logically typed (prediction events, communication events, drive events, learning events) to reduce coupling."

**Analysis:**

**COMPLIANT** — E5 must emit to TimescaleDB at these points:

1. **Input encoding (Episodic Memory):**
   - Event type: `EPISODE_ENCODED`
   - Metadata: attention_level, arousal_level, input_source, context_subgraph
   - Purpose: Learning queries this to find consolidation candidates

2. **Prediction generation (Inner Monologue):**
   - Event type: `PREDICTION_GENERATED`
   - Metadata: action_id, action_type, predicted_outcome, confidence, timestamp
   - Correlation ID: links to outcome event for MAE computation

3. **Arbitration decision:**
   - Event type: `ARBITRATION_RESULT`
   - Metadata: type1_candidate, type1_confidence, type2_candidate, type2_confidence, winner, threshold, drive_state_snapshot
   - Purpose: Drift detection — trending the Type 1/Type 2 ratio

4. **Action execution:**
   - Event type: `ACTION_EXECUTED`
   - Metadata: action_id, action_type, executor_state, timestamp
   - Purpose: Tracing behavioral patterns

5. **Outcome reporting:**
   - Event type: `ACTION_OUTCOME`
   - Metadata: action_id, prediction_id, actual_outcome, drive_state_snapshot, has_learnable (flag for Learning)
   - Correlation ID: links to original prediction for MAE computation

**Status:** **COMPLIANT** (contingent on proper event schema definition in E2)

---

## 6. Phase 1 Boundaries

**Specification:**
E5 is pure cognitive architecture, no physical embodiment, no Phase 2 creep.

**Analysis:**

**COMPLIANT** — As analyzed in Section 3.2 above.

**Status:** **COMPLIANT**

---

## 7. Attractor State Prevention

### 7.1 Type 2 Addict Prevention

**Specification (CANON §Known Attractor States):**
"The LLM is always better, so Sylphie never develops Type 1 reflexes. The graph becomes write-only."

**Prevention mechanisms:**
- Type 2 cost structure (latency, cognitive effort drive pressure)
- Type 1 graduation mechanism (confidence > 0.80 AND MAE < 0.10)
- Monitor Type 1/Type 2 ratio

**Analysis:**

**COMPLIANT** — E5 actively prevents Type 2 Addict:

- ✓ E5 implements Type 1 graduation: after 10 successful uses (MAE < 0.10), action becomes Type 1 candidate
- ✓ Type 1 execution is prioritized when confidence > threshold (lower latency)
- ✓ Type 2 cost is real: LLM latency (reported to E4) increases Cognitive Effort drive pressure
- ✓ E5 emits ARBITRATION_RESULT events with Type 1/Type 2 winner, enabling drift detection
- ✓ If Type 1 demotion occurs (MAE > 0.15), action returns to Type 2 backlog, preventing false graduation

**How cost prevents addict state:**
Repeated Type 2 invocation has latency cost → Cognitive Effort drive goes negative → Decision Making receives lower urgency signal for that decision type → system seeks Type 1 alternatives → if Type 1 alternatives exist and succeed, they accumulate retrieval-and-use events → graduate to Type 1 → lower latency next time.

**No escape hatch:**
An LLM (Type 2) cannot increase its own success rate faster than the Type 1 graduation mechanism. Even if the LLM is "always better," the cost structure ensures Type 1 development is evolutionarily advantageous.

**Status:** **COMPLIANT**

---

### 7.2 Prediction Pessimist Prevention

**Specification (CANON §Known Attractor States):**
"Early failures flood the system with low-quality procedures before the graph has substance."

**Prevention mechanism:**
- Cold-start dampening — early prediction failures have reduced Opportunity generation weight

**Analysis:**

**CONCERN** — E5 does not directly implement cold-start dampening; it's an E4/E8 responsibility:

- ✓ E5 generates predictions from episodic memory
- ✓ E5 reports outcomes to E4 (Drive Engine)
- ⚠ E4 should apply reduced weight to Opportunity generation in early sessions (cold-start dampening)
- ⚠ E8 (Planning) should be rate-limited: max plans per time window, early plans prioritized conservatively

**Critical interaction point:**
If E4 does NOT implement cold-start dampening, E5's early prediction failures (inevitable due to shallow graph) will trigger excessive Opportunity generation, which floods E8's queue. E8 creates low-quality procedures based on sparse data, which execute poorly, which generate more Opportunities — classic runaway.

**E5's role:**
E5 cannot directly prevent this, but E5 can MEASURE it. By emitting ARBITRATION_RESULT events with prediction accuracy data, E5 provides the signal that downstream subsystems (E4, E8) use to detect and prevent this state.

**Recommendation:**
E4 specification must include: "For the first N sessions (recommend 3-5), Opportunity creation weight is reduced by 0.5x". This happens at E4, not E5, but E5 enables it by providing accurate prediction feedback.

**Status:** **CONCERN — depends on E4 cold-start dampening specification**

---

## 8. Known Spec Gaps (CANON Appendix)

E5 depends on three reserved CANON appendix items that must be written before implementation:

### 8.1 CANON A.2: Episodic Memory Encoding and Consolidation Specification (RESERVED)

**Why it matters to E5:**
E5's Inner Monologue generates predictions from episodic memory. Without A.2 specification, E5 cannot define:
- What constitutes an "episode" (every input tick? only above attention threshold?)
- How episodes are encoded (structured record vs. embedding?)
- How episodes degrade over time (retention policy)
- How episodes are consolidated to semantic knowledge (Learning's responsibility, but E5 must understand the interface)

**Current gaps:**
- CANON specifies: "Episodic Memory stores temporally-contextualized experiences that degrade gracefully — fresh episodes are detail-rich, older episodes contribute to semantic knowledge through consolidation."
- But does not specify:
  - How fresh? (seconds? minutes?)
  - What detail level? (what fields?)
  - How does degradation work? (TimescaleDB retention? confidence decay?)
  - How does Learning query consolidation candidates? (query pattern E5 depends on)

**Recommended default:**
```
Episodes stored in TimescaleDB with:
  - timestamp, input_source, drive_state_snapshot, context_subgraph (WKG nodes queried)
  - Retention: 7 days (default)
  - Degradation: as episodes age, detail is stripped, summary is distilled
  - Consolidation: Learning queries for episodes with has_learnable=true, extracts entities/edges, upserts to WKG
```

**Status:** **CRITICAL GAP — blocks E5 implementation**

---

### 8.2 CANON A.3: Type 1 / Type 2 Arbitration Algorithm Specification (RESERVED)

**Why it matters to E5:**
Arbitration is the core E5 algorithm. Without A.3 specification, E5 cannot define:
- Dynamic threshold calculation (how does drive state modulate it?)
- Tie-breaking (if two actions have same confidence, which wins?)
- Fallback rules (what if no Type 1 and LLM returns confidence < 0.10?)

**Current gaps:**
- CANON specifies: "Type 1 must demonstrate sufficient confidence to win. Failed predictions shift weight toward Type 2. The confidence threshold is dynamic and bidirectional — modulated by drive state."
- But does not specify:
  - Formula for dynamic threshold (e.g., `base_threshold + 0.1 × anxiety - 0.05 × cognitive_awareness`?)
  - Which drives modulate it (all 12? only core 4?)
  - Coefficient magnitudes
  - Fallback behavior (which action if everything < threshold?)

**Agent profile (cortex.md) recommends:**
```
dynamic_threshold = 0.50
  + 0.15 × (Anxiety > 0.5 ? 0.5 : 0)  [raise threshold when anxious, be cautious]
  - 0.10 × (Cognitive_Awareness > 0.7 ? 1.0 : 0)  [lower threshold when confident]
  + 0.05 × (System_Health < 0.3 ? 1.0 : 0)  [raise threshold when system stressed]

Fallback:
  if no Type 1 above threshold:
    invoke LLM for Type 2 predictions
    if LLM confidence < threshold:
      output shrug (Immutable Standard 4)
    else:
      execute Type 2 action
```

**Recommended default:**
Dynamic threshold based on System Health, Cognitive Awareness, Anxiety (see cortex.md for formulas). Final decision requires Jim approval.

**Status:** **CRITICAL GAP — blocks E5 implementation**

---

### 8.3 CANON A.8: Self-Evaluation Protocol and KG(Self) Schema (RESERVED)

**Why it matters to E5:**
E5's predictions depend on Sylphie's self-model (stored in KG(Self)). Without A.8 specification, E5 cannot define:
- What self-beliefs affect prediction generation? (confidence in ability to speak? ability to understand?)
- How are self-beliefs updated? (does Drive Engine update baselines? does Learning consolidate self-observations?)
- What prevents identity lock-in? (timescale of self-evaluation, circuit breakers)

**Current gaps:**
- CANON specifies: "Self-evaluation on slower timescale than drive ticks to prevent identity lock-in"
- But does not specify:
  - What is "slower"? (every 10 ticks? every 60 ticks? every 60 seconds?)
  - What self-beliefs are tracked? (KG(Self) schema)
  - How do Drive Engine's baselines map to self-beliefs?
  - What are the circuit breakers? (detect and break ruminative loops)

**Recommended default:**
```
KG(Self) schema:
  - can_speak(confidence)
  - can_understand_input(confidence)
  - can_predict_outcome(confidence)
  - can_recover_from_failure(confidence)

Self-evaluation timescale: every 30 ticks (~300ms)
  read KG(Self) nodes
  compare to recent experience (last 10 actions)
  if actual success > self-belief:
    increase confidence
  else if actual success < self-belief:
    decrease confidence (but not below 0.20 floor — prevent depressive lock)

Circuit breaker:
  if any self_belief confidence decreases 3 consecutive evaluations:
    flag as potential Depressive Attractor
    increase Moral Valence drive pressure (motivate recovery action)
```

**Status:** **CRITICAL GAP — blocks E5 implementation**

---

## 9. Decisions Requiring Jim

These must be resolved before E5 implementation begins:

### 9.1 Theater Prohibition Enforcement Boundary

**Question:** Should pre-flight Theater validation happen in E5, E6, or both?

**Options:**
- A) E5 only: When generating predictions, check if emotional output + drive < 0.2. If so, mark prediction as invalid.
- B) E6 only: When Communication generates responses, check drive state. If emotional output + drive < 0.2, suppress or rewrite response.
- C) Both: E5 marks predictions as invalid, E6 double-checks before execution, E4 enforces zero reinforcement post-flight.
- D) E4 only: Post-flight enforcement only; E5 and E6 don't pre-check.

**Trade-offs:**
- A (E5 only): Lighter on E6 (Communication), but requires E5 to understand emotion semantics
- B (E6 only): Natural place (Communication controls output), but misses invalid predictions from E5
- C (Both): Most robust, but adds latency and coupling
- D (E4 only): Simplest, but allows invalid predictions to propagate

**Recommendation:** Option C — E5 marks invalid predictions, E6 validates before execution, E4 enforces zero reinforcement post-flight.

---

### 9.2 Guardian Asymmetry Application in Drive Rules and Opportunity Weighting

**Question:** Does "Guardian Asymmetry" (2x confirmation, 3x correction) apply to drive rules and opportunity weights, or only to confidence updates?

**Options:**
- A) Only confidence updates (E3 responsibility)
- B) Only opportunity weights (E4/E8 responsibility)
- C) Both confidence updates AND opportunity weights
- D) Also affects action retrieval priority in E5 (prefer GUARDIAN-sourced actions)

**Trade-offs:**
- A (Confidence only): Simplest, focused on knowledge confidence
- B (Opportunity only): Biases Planning toward guardian-approved opportunities
- C (Both): Most conservative — trusts guardian judgment at multiple stages
- D (All): Strongest guardian bias, but may over-weight guardian judgment

**Recommendation:** Option C — Apply 2x/3x weights at both confidence updates (E3) and opportunity weighting (E4). Option D optional but may increase system dependence on guardian.

---

### 9.3 Cold-Start Dampening Duration

**Question:** For how long after session start should Opportunity generation be dampened?

**Options:**
- A) N sessions (e.g., 3-5 sessions)
- B) Cumulative experience threshold (e.g., 500 events)
- C) Prediction accuracy stabilization (e.g., when MAE < 0.15 for 50 decisions)
- D) Adaptive: based on graph density (until WKG has 50+ procedural nodes)

**Trade-offs:**
- A (Session-based): Simple, predictable
- B (Event-based): Scales with activity level
- C (Accuracy-based): Data-driven, waits for genuine learning
- D (Adaptive): Most sophisticated, requires real-time monitoring

**Recommendation:** Option C — Cold-start dampening ends when prediction accuracy stabilizes (MAE < 0.15 for 50 consecutive decisions). This ensures the graph has substance before Planning creates procedures.

---

### 9.4 Self-Evaluation Timescale and Circuit Breakers

**Question:** How often should Drive Engine (or another subsystem) read KG(Self) and evaluate Sylphie's self-model?

**Options:**
- A) Every drive tick (100Hz, 10ms) — tight coupling
- B) Every 60 ticks (~600ms) — moderate coupling
- C) Every 600 ticks (~6s) — loose coupling
- D) On schedule (every 30 seconds) — independent of drive ticks

**Circuit breaker question:**
If self-beliefs consistently decrease, what prevents spiral into Depressive Attractor?

**Options:**
- A) Confidence floor at 0.20 (belief cannot go below "I'm bad at X, but not hopeless")
- B) Automatic belief reset after 10 consecutive failures (force recalibration)
- C) Moral Valence drive increase when self-belief < 0.30 (motivate recovery action)
- D) Transition to safe mode (reduce decision scope until recovery)

**Recommendation:**
Self-evaluation: Option D (every 30 seconds, independent of drive ticks). This prevents tight coupling and allows self-evaluation to be eventually-consistent.

Circuit breaker: Option C + floor of 0.20. When self-belief < 0.30, Moral Valence increases, motivating the system to seek contexts where recovery is possible.

---

### 9.5 Opportunity Priority Scoring

**Question:** Beyond "recurring vs. high-impact," what additional signals determine Opportunity priority?

**Factors to consider:**
- Recency of failure (recent failures are higher priority?)
- Magnitude of prediction error (large MAE is higher priority?)
- Similarity to recent Opportunities (avoid duplicates?)
- Number of behavioral alternatives available (if many alternatives exist, defer?)
- Guardian feedback (if guardian flags an Opportunity, boost priority?)

**Recommendation:**
Priority = base_weight × (1.0 + recency_boost - similarity_penalty) × guardian_multiplier

Base weight:
- Recurring (3+ failures in window): 1.0
- High-impact single failure (MAE > 0.5): 0.7
- Else: 0.3 (Potential Opportunity)

Recency boost: +0.1 per day since last occurrence (older failures = lower priority)

Similarity penalty: -0.2 if similar Opportunity already in queue

Guardian multiplier: 2.0 if guardian confirmed, 1.0 default

---

## 10. Summary: Compliance Status

| Item | Status | CANON Reference | Notes |
|------|--------|-----------------|-------|
| 1.1 Experience Shapes Knowledge | **COMPLIANT** | §CP1 | Prediction drives learning through E4 feedback |
| 1.2 Dual-Process Cognition | **COMPLIANT** | §CP2 | Type 1/Type 2 arbitration with graduation criteria |
| 1.3 WKG Is the Brain | **COMPLIANT** | §CP3 | Reads WKG, does not write; delegates to Learning |
| 1.4 Prediction Drives Learning | **COMPLIANT** | §CP6 | Inner Monologue → execute → report → Drive Engine |
| 1.5 Personality from Contingencies | **COMPLIANT** | §CP5 | Executes actions; E4 provides contingency feedback |
| 1.6 Provenance Sacred | **COMPLIANT** | §CP7 | Reads and respects provenance tags |
| 1.7 Offload What's Solved | **COMPLIANT** | §CP8 | Delegates communication, learning, etc. |
| 2.1 Theater Prohibition | **CONCERN** | §IS1 | Enforcement boundary between E5, E6, E4 unclear |
| 2.2 Contingency Requirement | **COMPLIANT** | §IS2 | Action → outcome → contingency → reinforcement |
| 2.3 Confidence Ceiling | **COMPLIANT** | §IS3 | PRIMARY ENFORCER — action retrieval enforces ceiling |
| 2.4 Shrug Imperative | **COMPLIANT** | §IS4 | PRIMARY ENFORCER — outputs shrug when nothing above threshold |
| 2.5 Guardian Asymmetry | **CONCERN** | §IS5 | Application points (confidence, opportunity, action retrieval) need clarification |
| 2.6 No Self-Modification | **COMPLIANT** | §IS6 | Reads drive state, never writes evaluation function |
| 3.1 Subsystem Boundaries | **COMPLIANT** | §Subsystems | E5 owns episodic memory, arbitration, execution; delegates rest |
| 3.2 Phase 1 Boundaries | **COMPLIANT** | §Phases | No physical embodiment, no Phase 2 creep |
| 4. Provenance Discipline | **COMPLIANT** | §CP7 | Respects provenance on retrieval and reporting |
| 5. TimescaleDB Events | **COMPLIANT** | §Shared Infra | Must emit typed events at all decision points |
| 6. Phase 1 Boundaries | **COMPLIANT** | §Phases | Pure cognitive, no embodiment |
| 7.1 Type 2 Addict Prevention | **COMPLIANT** | §Attractors | Type 1 graduation, cost structure prevent addiction |
| 7.2 Prediction Pessimist Prevention | **CONCERN** | §Attractors | Depends on E4 cold-start dampening specification |
| 8.1 Episodic Memory Spec (A.2) | **GAP** | §Appendix | RESERVED — must be written before E5 |
| 8.2 Arbitration Algorithm (A.3) | **GAP** | §Appendix | RESERVED — must be written before E5 |
| 8.3 Self-Evaluation Protocol (A.8) | **GAP** | §Appendix | RESERVED — must be written before E5 |

---

## 11. Final Assessment

**Compliance Score:** 7 COMPLIANT | 3 CONCERNS | 5 CRITICAL GAPS

**Severity Breakdown:**
- **COMPLIANT (7 items):** E5 correctly implements all core philosophy principles and 4 of 6 immutable standards
- **CONCERN (3 items):** Theater Prohibition enforcement boundary, Guardian Asymmetry application, Prediction Pessimist prevention depend on clarification or other subsystems
- **CRITICAL GAPS (5 items):** Three CANON appendix items (A.2, A.3, A.8) must be written; five design decisions require Jim approval

**Recommendation:**

**E5 is ARCHITECTURALLY SOUND** but **NOT READY FOR IMPLEMENTATION** until:

1. **CANON A.2 (Episodic Memory)** specification is written
2. **CANON A.3 (Arbitration Algorithm)** specification is written
3. **CANON A.8 (Self-Evaluation Protocol)** specification is written
4. Jim approves Theater Prohibition enforcement boundary (E5/E6/E4 split)
5. Jim approves Guardian Asymmetry application points
6. Jim approves Cold-start dampening duration
7. Jim approves Self-evaluation timescale and circuit breaker strategy
8. Jim approves Opportunity priority scoring formula

**Timeline:** These specifications are prerequisites, not blockers. E5 can proceed in parallel with A.2/A.3/A.8 specification work, with implementation starting when specifications are finalized.

**Next steps:**
1. Schedule Jim review of this analysis
2. Begin writing CANON A.2, A.3, A.8 (recommend parallel agents: Episodic Memory expert, Arbitration expert, Self-Evaluation expert)
3. Once specs complete, E5 implementation can begin immediately

---

## References

- **CANON:** `/sessions/nice-vigilant-tesla/mnt/sylphie/wiki/CANON.md`
- **Epic 5 Roadmap:** `/sessions/nice-vigilant-tesla/mnt/sylphie/wiki/phase-1/roadmap.md` (§Epic 5)
- **Agent Profiles:** `.claude/agents/*.md` (cortex.md recommended for arbitration algorithm)
- **Epic 4 Analysis:** `/sessions/nice-vigilant-tesla/mnt/sylphie/wiki/phase-1/epic-4/agent-analyses/canon.md`
