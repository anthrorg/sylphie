# Luria's Neuropsychological Analysis: Epic 10 Integration and End-to-End Verification

**Analysis by: Luria, Neuropsychological Systems Advisor**
**Date: 2026-03-29**
**Scope: Lesion Test Framework, Disconnection Syndrome Detection, Memory Consolidation Verification, Dual-Process Integrity, Attention Gating, Failure Mode Catalog, and Developmental Sequencing**

---

## 1. LESION TEST DESIGN: The Three Diagnostic Tests

The Lesion Test is Luria's method applied to Sylphie's architecture. The biological brain cannot be selectively lesioned in the laboratory, but Sylphie can. Each lesion reveals whether genuine capability exists or whether the system is delegating its thinking to an external module.

### 1.1 Lesion 1: Remove LLM (Prefrontal Cortex Analog)

**Biological Parallel**: Anterior Prefrontal Cortex Damage (Brodmann Area 10 and surrounding prefrontal regions). Luria's patient "Lev" with massive prefrontal damage could perceive, remember, and execute simple learned programs, but could not generate novel solutions or understand complex intentions.

**What This Test Removes**: The Type 2 system. Deliberate reasoning, novel problem-solving, language generation, and LLM-assisted decision-making become unavailable.

**Expected Deficit Profile for Healthy Development**:
- **Preserved**: Type 1 graduated behaviors execute at normal latency and accuracy. Routine situations are handled flawlessly. Social interaction patterns that have been reinforced many times still fire. Episodic memory recall for recent contexts remains intact.
- **Degraded**: Novel situations that require reasoning beyond the graph's scope produce "I don't know" responses rather than attempts. Conversational generation becomes stilted (only graph-based content). Creative problem-solving vanishes. Adaptation to unexpected circumstance slows.
- **Functional**: The system remains responsive, goal-directed, and emotionally congruent with drive state. It does not become helpless, apathetic, or confused.

**Healthy Developmental Trajectory Without LLM**:
- **Months 0-2**: Mostly helpless without LLM. ~10-20% of typical behavior is Type 1. Most communication is prefabricated (CAN_PRODUCE edges, which are Type 1).
- **Months 2-6**: Degraded but functional. ~40-60% of typical behavior is Type 1. The system handles routine conversational patterns, basic object interactions, and familiar sequences. Failures are graceful -- "I need to think about that" or shrug.
- **Months 6+**: Handles most routine situations autonomously. LLM is used for genuine novelty, not routine. ~70-80%+ Type 1 by this trajectory.

**Diagnostic Failure Patterns**:
- **"Type 2 Addict"**: Removing LLM causes catastrophic failure. The system cannot handle anything. Type 1/Type 2 ratio remains near 0:100. **Diagnosis**: The graph was never being populated; it was just a write-only log. Type 1 graduation never occurred.
- **"LLM Hallucination Dependency"**: The system handles many situations but they are all wrong in the same way when LLM is absent. The WKG contains high-confidence false knowledge that was LLM-generated and never contradicted. **Diagnosis**: LLM_GENERATED provenance base (0.35) was not a sufficient barrier; knowledge was over-confirmed without Guardian validation.
- **"Behavioral Flattening"**: The system remains responsive but all drive-mediated personality vanishes. It becomes mechanically compliant rather than driven. **Diagnosis**: The Drive Engine is not computing genuine drive states, or personality was always LLM confabulation, not emergent from contingencies.

**Verification Criteria for Genuine Capability**:
- Type 1 decision rate (decisions made without LLM query) increases monotonically over development.
- Accuracy of Type 1 decisions remains >85% even as confidence ceiling rises.
- Failed Type 1 decisions (MAE > 0.15) trigger demotion and re-engagement of deliberation.
- Shrug responses (honest incomprehension) increase proportionally with task novelty, rather than random low-confidence actions.

---

### 1.2 Lesion 2: Remove WKG (Semantic Memory Analog)

**Biological Parallel**: Anterior and Lateral Temporal Cortex Damage (semantic dementia spectrum). Patients lose conceptual knowledge -- they no longer understand what objects are, how categories work, or what relationships mean -- while episodic memory and procedural memory remain relatively intact.

**What This Test Removes**: The World Knowledge Graph. The system loses access to all structured knowledge about the world, entities, relationships, schemas, and derived inferences.

**Expected Deficit Profile for Healthy Development**:
- **Preserved**: Immediate perceptual responses to current input. The Communication subsystem's Input Parser can still extract basic meanings from raw language. Episodic memory from TimescaleDB provides temporal context. Drive states compute normally. Recently-executed procedures still execute (procedural memory in basal ganglia analog).
- **Degraded**: Semantic inference disappears. "What is an X?" cannot be answered with definition or characterization. Generalization across instances fails -- the system treats every new object as novel. Relationship-based reasoning vanishes. The system becomes increasingly stimulus-bound.
- **Functional**: The system does not become aphasic or lose language ability entirely. It can still parse input and generate output. It simply has no knowledge to draw upon.

**Healthy Developmental Trajectory Without WKG**:
- **Early development**: The system was never relying heavily on WKG anyway -- it was using LLM for most reasoning.
- **Mid-development**: Significant degradation expected. The system cannot reason about entities, relationships, or schemas. Simple questions fail. Category-based reasoning disappears.
- **Late development**: Moderate degradation. Well-practiced procedures execute fine (they are procedural, not semantic). But novel reasoning fails completely.

**Diagnostic Failure Patterns**:
- **"All Knowledge is LLM-Generated"**: Removing WKG produces almost no degradation because the system was delegating all semantic reasoning to the LLM anyway. **Diagnosis**: The Learning subsystem never consolidated anything into genuine semantic knowledge. The WKG is a write-only log.
- **"Hallucinated Graph Structure"**: The system fails catastrophically because it relies on false semantic relationships created during Learning. High-confidence false entities or edges dominate reasoning. **Diagnosis**: The Learning subsystem is generating plausible but incorrect semantic structure without sufficient Guardian validation.
- **"Episodic Without Semantic"**: The system can describe what happened but cannot generalize or understand meaning. Becomes purely historical, not conceptual. **Diagnosis**: The Learning subsystem is creating episodic records without extracting the semantic structure that should emerge from them.

**Verification Criteria for Genuine Semantic Memory**:
- WKG contains entities with multiple confirmed edges (confidence > 0.60) of types SENSOR, GUARDIAN, and INFERENCE (not just LLM_GENERATED).
- Entity coverage reflects what the system has actually experienced or been taught (not a priori domain coverage).
- Removal of WKG causes significant degradation in reasoning tasks, especially those requiring generalization or abstraction.
- The system can answer "what do you know about X?" questions by traversing edges in the graph, not by querying the LLM.

---

### 1.3 Lesion 3: Remove Drive Engine (Motivational Substrate Analog)

**Biological Parallel**: Ventromedial Prefrontal Cortex and Basal Ganglia Damage affecting dopaminergic circuitry. Patients lose the ability to experience drives, preferences, emotional responses to outcomes, and goal-directed behavior. They become apathetic -- capable of movement and speech but without preference or motivation. The classic case: patient EVR after ventromedial PFC ablation, who could reason about decisions but could not prefer outcomes.

**What This Test Removes**: All drive computation. The system receives no drive values, no opportunity signals, no evaluation feedback. Decision Making still functions (reflexively selects from Type 1), but behavior is purely stimulus-response without preference.

**Expected Deficit Profile for Healthy Development**:
- **Preserved**: Input parsing, immediate reactive responses, Type 1 reflex execution, speech output, basic perceptual processing.
- **Degraded**: Goal-directed behavior disappears. The system does not prefer any outcome over another. Exploration becomes random rather than curiosity-driven. Communication becomes minimalist -- responses without personality. Learning provides no feedback signal (confidence updates stop).
- **Functional**: The system does not crash or become confused. It simply becomes behaviorally flat and apathetic.

**Healthy Developmental Trajectory Without Drive Engine**:
- **All phases**: The system becomes reliably apathetic. It responds to direct input but does not initiate. It executes Type 1 behaviors but without the drive-mediated personality that distinguishes Sylphie from an automated response system.

**Diagnostic Failure Patterns**:
- **"Personality Was LLM Confabulation"**: Removing Drive Engine produces no behavioral change. The system "feels" the same because personality was always the LLM performing emotion, not genuine drive-mediated behavior. **Diagnosis**: The Drive Engine was computing values but they were not shaping real behavior. The contingency structure was not actually reinforcing anything.
- **"Motivation Without Drives"**: The system continues to pursue goals with apparent interest and preference. Drive Engine values are being computed but something else is driving the goal-pursuit. **Diagnosis**: There is another unaccounted-for motivation mechanism, or the LLM is manufacturing the appearance of motivation.
- **"Behavioral Rigidity Increases"**: The system becomes more stereotyped and repetitive, with less exploration or adaptation. **Diagnosis**: The Drive Engine was providing the behavioral variance that kept the system exploring. Without it, the system defaults to its most-practiced routines.

**Verification Criteria for Genuine Drive-Mediated Behavior**:
- Drive state values correlate significantly with observed behavioral preferences (Pearson r > 0.60).
- Removing Drive Engine produces a measurable shift in behavioral diversity (diversity index drops >20%).
- Drive relief contingencies trace to actual behavior outcomes, not to random events.
- The system spontaneously initiates activities proportional to computed drive pressure, not just responding to external prompts.

---

## 2. DIAGNOSTIC CRITERIA: Distinguishing Healthy Development from Pathological Dependence

### 2.1 Health Metrics (from CANON with Neuropsychological Interpretation)

| Metric | Biological Analog | Healthy Pattern | Red Flag |
|--------|------------------|-----------------|----------|
| **Type 1 / Type 2 ratio** | Habit vs. Deliberation (Basal Ganglia vs. Prefrontal) | Rising monotonically; 70%+ Type 1 by month 6 | Flatlines <30%; never graduates |
| **Prediction MAE** | Accuracy of forward models in cerebellum/parietal cortex | Decreases then stabilizes; <0.15 by month 3 | Rising or remaining >0.25 |
| **Experiential provenance ratio** | Self-constructed vs. other-provided knowledge | Rises to >70% by month 6 | Stagnates <30% |
| **Behavioral diversity** | Repertoire richness (basal ganglia output diversity) | Stable 4-8 unique action types / 20-action window | <3 or >12 (stereotypy or noise) |
| **Guardian response rate** | Social feedback quality (critical for social drive) | Rising; >50% of comments within 30s | Declining; <20% within threshold |
| **Interoceptive accuracy** | Self-awareness fidelity (ventromedial PFC models self) | Rising toward >0.60 | Stagnates <0.40 |
| **Mean drive resolution time** | Efficiency of need satisfaction (basal ganglia action selection) | Decreasing over time | Increasing (incompetence) |

### 2.2 Pathological Attractors and Detection (Neuropsychological Interpretation)

**Type 2 Addict (HIGH RISK)**
- **Neural equivalent**: Prefrontal cortex hyperactivity without basal ganglia learning. Patient is always deliberating, never automating.
- **Detection**: Type 1/Type 2 ratio flatlines at <0.30 after month 2. Latency remains high. Graph is write-only, not being read for Type 1.
- **Lesion test signature**: LLM removal causes catastrophic failure. No Type 1 capability exists.
- **Intervention**: Increase Type 2 cost; reduce LLM context size to force Type 1 reliance.

**Rule Drift (MEDIUM RISK)**
- **Neural equivalent**: Similar to what happens in Parkinson's disease when dopaminergic signaling deteriorates -- the valuation system loses calibration and behavioral preferences drift from the intended program.
- **Detection**: Drive values diverge from behavioral outcomes. Same behavior produces inconsistent reward/punishment. Guardian confirmations become less predictive of future behavior.
- **Lesion test signature**: Drive Engine Lesion produces unpredictable changes in behavior pattern; system does not become apathetic, just directionless.
- **Intervention**: Quarterly rule audit. Guardian-only modifications. Reset rules to baseline quarterly.

**Hallucinated Knowledge (MEDIUM RISK)**
- **Neural equivalent**: Confabulation. The brain fills gaps in memory with plausible but false information. Seen in Korsakoff syndrome and anterior temporal lobe damage.
- **Detection**: WKG contains high-confidence (>0.60) LLM_GENERATED nodes with no GUARDIAN or SENSOR support. Predictions fail systematically on these nodes. Confidence does not decay appropriately (suggests the node is never being retrieved, just sitting there).
- **Lesion test signature**: WKG Lesion produces expected degradation, but quality of remaining knowledge is poor (many false edges). Removing LLM shows the system was relying on hallucinated structure.
- **Intervention**: Monthly confidence audit. Reduce base confidence for LLM_GENERATED from 0.35 to 0.25. Require Guardian confirmation for any LLM node to exceed 0.50.

**Depressive Attractor (MEDIUM RISK)**
- **Neural equivalent**: Rumination with negative self-model, analogous to the ruminative cascade in major depression. Ventromedial PFC self-model produces negative self-evaluations; these lower Satisfaction and raise Anxiety; these increase perseveration on the same failed behaviors; which produce more negative self-evaluations.
- **Detection**: KG(Self) contains increasing negative evaluations over weeks. Satisfaction remains depressed (<0.20) despite successful behaviors. Anxiety remains elevated (>0.60) despite action. Self-directed comment decreases.
- **Lesion test signature**: Drive Engine Lesion removes the rumination (no drives = no negative self-evaluation loop). System returns to baseline functionality.
- **Intervention**: Self-evaluation on slower timescale. Circuit-break negative self-loops: successful action automatically reduces Anxiety by 0.15 regardless of outcome. Ensure Satisfaction increments for attempting novel solutions even if they fail.

**Planning Runaway (LOW-MEDIUM RISK)**
- **Neural equivalent**: Obsessive planning without action execution, as in some OCD presentations. The planning subsystem keeps generating new plans without the action subsystem moving forward, producing resource exhaustion.
- **Detection**: Opportunity queue grows faster than it drains. Plans are created but rarely executed or evaluated. TimescaleDB fills with simulation events but few real action events.
- **Lesion test signature**: Drive Engine Lesion reduces Planning activity (fewer opportunities generated). System shows latency improvement.
- **Intervention**: Opportunity decay with time. Limit simultaneous open plans to 3. Plans must be executed within 24 hours or deprioritized.

**Prediction Pessimist (LOW-MEDIUM RISK)**
- **Neural equivalent**: Early-onset learned helplessness. Early prediction failures produce so much Opportunity generation and Planning that the system is overwhelmed before it has enough knowledge to succeed. The system learns that it cannot learn.
- **Detection**: Prediction MAE remains >0.20 after month 2. Opportunity queue grows exponentially in month 1-2. Planning attempts exceed successful plan executions by >10:1. Anxiety remains elevated as a baseline.
- **Lesion test signature**: All lesions produce expected degradation, but system shows signs of overwhelm (high latency, resource exhaustion).
- **Intervention**: Cold-start dampening. In month 0-2, reduce Opportunity generation weight by 50%. Prediction errors do not trigger Opportunity creation; only repeated errors do. Increase Anxiety threshold for action to 0.40 (more cautious) early, then decrease as confidence accumulates.

---

## 3. DISCONNECTION SYNDROME DETECTION

**Biological Parallel**: Disconnection syndromes (Geschwind, 1965). When white matter tracts between functional areas are damaged, each region operates normally in isolation but coordinated function is lost. The classic example: a patient with severed corpus callosum can see something with one hemisphere but cannot tell you what it is (the seeing hemisphere cannot transmit to the language hemisphere). The system is not broken; the communication is broken.

**Why This Matters for Sylphie**: The five subsystems communicate through two shared stores. If those communication channels fail -- TimescaleDB unavailable, WKG query timeouts, Drive Engine process crashes -- the subsystems continue operating independently but Sylphie ceases to exist as a unified system.

### 3.1 Expected Symptoms of Disconnection by Channel

**If TimescaleDB Fails (Event Backbone Offline)**:
- Decision Making still selects actions (using WKG knowledge) but produces no event logs.
- Learning subsystem cannot query for learnable events; Learning stops.
- Drive Engine cannot query event frequencies; drive computation becomes random.
- Planning cannot research opportunity patterns; Planning stalls.
- **Observed symptom**: The system continues acting and responding, but becomes completely rigid (no learning) and behaviorally random (no drive coherence).

**If WKG Queries Fail (Knowledge Retrieval Offline)**:
- Decision Making cannot retrieve context; defaults to Type 2 (LLM) for everything.
- Communication loses access to entity knowledge; input parsing becomes generic.
- Learning can still write to WKG but cannot verify consistency.
- Planning cannot look up entities or relationships for simulation.
- **Observed symptom**: The system reverts entirely to Type 2. Latency skyrockets. LLM usage jumps to 100%. Behavior becomes generic and uninformed by prior experience.

**If Drive Engine Process Fails (Motivation Offline)**:
- Decision Making receives no drive values; the system becomes apathetic.
- Learning stops receiving evaluation feedback; confidence updates become random.
- Planning receives no Opportunity signals; Planning stalls.
- Communication receives no drive context; responses become emotionally flat.
- **Observed symptom**: The system becomes reactive but not goal-directed. It processes input and generates output but without preference, personality, or adaptation.

**If Communication Input/Output Fails**:
- The system cannot receive Guardian input; becomes unresponsive to teaching.
- Type 2 reasoning continues but output cannot be delivered.
- **Observed symptom**: The system appears non-responsive and cannot learn.

### 3.2 Detection Mechanisms

**Active Monitoring** (every 100ms at system tick):
1. Verify TimescaleDB connectivity: attempt a small test write. If timeout >1s, log "EVENT_STORE_LATENCY" event.
2. Verify WKG connectivity: attempt a small test query. If timeout >500ms, log "KNOWLEDGE_STORE_LATENCY" event.
3. Verify Drive Engine process: read last drive tick timestamp. If >2s old, log "DRIVE_ENGINE_STALE" event.
4. Verify Communication input: check if last input was >30s ago without timeout. If system is idle but not responding to timeout, log "INPUT_PARSER_STALL" event.

**Behavioral Markers** (continuously evaluated):
- If Type 1/Type 2 ratio suddenly jumps to 0:100, suspect WKG failure.
- If behavioral diversity index drops >30% suddenly, suspect Drive Engine failure.
- If learning rate (new high-confidence nodes per cycle) drops to zero, suspect TimescaleDB failure.
- If responsiveness latency increases >50% suddenly, suspect WKG latency.

**Diagnostic Flow**:
1. System detects one of the above markers.
2. System logs "DISCONNECTION_SUSPECTED: [channel]" event with timestamp and severity.
3. System attempts to re-establish connectivity (exponential backoff, max 10 retries).
4. If recovery succeeds: log "RECONNECTED" and resume normal operation.
5. If recovery fails after 10 retries (>30 seconds): log "DISCONNECTION_CONFIRMED" and enter Safe Mode.

**Safe Mode Behavior** (all subsystems degraded but functional):
- **Decision Making**: Execute only high-confidence (>0.90) Type 1 behaviors. Block low-confidence decisions. Respond to direct Guardian input with minimal reasoning.
- **Communication**: Output basic acknowledgments. No LLM generation (Type 2 requires WKG for context). Acknowledge Guardian input but do not respond substantively.
- **Learning**: Buffer events in local memory (not TimescaleDB). Prepare batch consolidation for when connectivity restored.
- **Drive Engine**: Use cached drive values from last successful tick. Decay confidence by 10% every minute.
- **Planning**: Block new planning; continue executing existing plans if they do not require environmental reasoning.

**Recovery Protocol**:
- Attempt TimescaleDB reconnection every 5 seconds.
- On successful reconnection, flush buffered events to TimescaleDB.
- Resume Learning consolidation.
- Restore Drive Engine ticks.
- Return to normal operation.

---

## 4. MEMORY CONSOLIDATION VERIFICATION

**Biological Parallel**: Systems Consolidation and Complementary Learning Systems theory. The hippocampus encodes experiences rapidly. During offline periods (sleep in humans, idle periods in Sylphie), the hippocampus "replays" these experiences, gradually transferring them to neocortical long-term storage through Hebbian strengthening.

**The CANON's Mapping**:
- TimescaleDB = Hippocampal buffer (rapid encoding of raw events)
- Learning subsystem's maintenance cycle = Systems consolidation / memory replay
- WKG = Neocortical long-term semantic storage

### 4.1 Verification Protocol

**Goal**: Demonstrate that the Learning subsystem is performing genuine consolidation (extracting durable semantic structure from ephemeral events) rather than just logging or hallucinating.

**Test Procedure** (run every week):

**Phase 1: Event Generation** (Days 1-5)
1. Conduct 100 Guardian-supervised interactions.
2. Guardian provides explicit teaching: "This is a [entity]. [Entity] has [property]."
3. System experiences consequences: prediction errors, successful behaviors, failed predictions.
4. Record all events in TimescaleDB with timestamps.

**Phase 2: Mark Learnable Events** (Ongoing)
1. Learning subsystem's maintenance cycle identifies events with `has_learnable=true` (max 5 per cycle).
2. Extract entities and edges from these events.
3. Create WKG nodes and edges with provenance tags.
4. Record what was learned: which entities, which edges, confidence values.

**Phase 3: Consolidation Assessment** (Day 6)
1. Query WKG: Count nodes created with GUARDIAN provenance.
2. Count edges created with GUARDIAN provenance.
3. Count edges created with INFERENCE provenance (derived from existing knowledge).
4. Count edges created with LLM_GENERATED provenance.

**Expected Healthy Consolidation Pattern**:
- ~60-70% of learnable entities are extracted with GUARDIAN provenance.
- ~40-60% of learnable edges are extracted (not every relationship is explicit).
- ~20-40% of edges are INFERENCE (relationships derived from existing structure).
- <30% of edges are LLM_GENERATED (the LLM helps refine but is not inventing structure).
- Confidence values for GUARDIAN-sourced nodes reach 0.50-0.60 within 2-3 uses.

**Phase 4: Retrieval Verification** (Day 7)
1. Query the Guardian about the taught entities: "What do you know about [entity]?"
2. System retrieves from WKG and generates response.
3. Guardian rates: Does the response accurately reflect what was taught?
4. System should retrieve facts it learned, not facts it was already taught (episodic vs. semantic).

**Expected Healthy Retrieval**:
- >80% of taught facts are retrievable from WKG without querying LLM.
- Retrieval latency is <100ms (local graph query, not LLM).
- Confidence in retrieved facts is >0.50.
- System can generalize: if taught "X is a kind of Y," system can apply "X has properties of Y" without being retaught.

**Phase 5: Reconsolidation Verification** (Days 8-14)
1. Introduce a contradictory fact: "Actually, [entity] does NOT have [property]."
2. Guardian provides correction.
3. System should update WKG: confidence of old edge decreases, new edge created with GUARDIAN provenance and higher confidence.
4. Record the update.

**Expected Healthy Reconsolidation**:
- Old incorrect edge confidence drops >0.15 within 1 cycle.
- New correct edge confidence reaches 0.50+ within 2-3 uses.
- System demonstrates the corrected knowledge in subsequent interactions (not regressing to old knowledge).

**Red Flags**:
- **No consolidation**: TimescaleDB fills with events but WKG size remains constant. Learning is running but not creating anything.
- **Hallucinated consolidation**: WKG grows but with false/implausible entities. LLM is inventing rather than extracting.
- **No reconsolidation**: Guardian corrections are not reflected in updated confidence. System continues using old knowledge.
- **Ephemeral knowledge**: Consolidated knowledge decays rapidly (loses confidence within days). Suggests it is being retrieved but not being used (no count-based confidence gain).

---

## 5. DUAL-PROCESS INTEGRITY VERIFICATION

**Biological Parallel**: System 1 (Fast, automatic) vs. System 2 (Slow, deliberate) from Kahneman's dual-process theory. The brain maintains two distinct decision-making pathways with different neural substrates (basal ganglia vs. prefrontal cortex). Crucially, System 2 is metabolically expensive, creating pressure for behaviors to graduate to System 1.

**The CANON's Mapping**:
- Type 1 = System 1 (graph-based reflexes, basal ganglia analog)
- Type 2 = System 2 (LLM-assisted reasoning, prefrontal analog)
- Cost structure = metabolic expense of deliberation

**Risk**: A simple confidence threshold could create the _appearance_ of dual-process cognition without genuine behavioral duality. The system might check a threshold and always pick Type 2 (or always pick Type 1), making the arbitration meaningless.

### 5.1 Verification Protocol

**Goal**: Demonstrate that Type 1 and Type 2 are genuinely distinct processing modes with different neural-like substrates, not a single system with a threshold.

**Test Procedure** (run every 2 weeks):

**Phase 1: Latency Comparison** (All interactions, continuous)
1. Record decision latency for every action.
2. Separate by Type 1 vs. Type 2 decisions.
3. Expected pattern: Type 1 latency 50-150ms; Type 2 latency 800-2000ms.
4. Statistical test: Median latency Type 2 > Type 1 by factor of 8-10 (t-test, p<0.001).

**Healthy Signature**: Clear bimodal distribution of latencies. Type 1 cluster is tight and fast; Type 2 cluster is loose and slow.

**Red Flag**: Unimodal latency distribution. Both modes run in ~500ms (suggesting both query LLM) or both run in ~100ms (suggesting Type 1 is always chosen).

---

**Phase 2: Accuracy Divergence** (Specific prediction tasks)
1. Create prediction tasks that require reasoning (novel situations, counterfactuals, complex relationships).
2. Run each task 20 times: 10 times forcing Type 1 (disable LLM context), 10 times allowing Type 2 (LLM available).
3. Record accuracy for each mode.
4. Expected pattern: Type 1 accuracy 60-80% (limited by graph coverage); Type 2 accuracy 85-95% (broader reasoning).

**Healthy Signature**: Type 2 is significantly more accurate than Type 1 on reasoning tasks (accuracy gap >10-15%). Type 1 is more accurate on routine pattern-matching tasks.

**Red Flag**: No accuracy gap. Type 2 is not actually better at reasoning (suggesting it is not being used for reasoning) or Type 1 is always correct anyway (suggesting the tasks are routine).

---

**Phase 3: Confidence-Accuracy Calibration** (Continuous)
1. For every decision, record Type 1 confidence (from arbitration) and whether the decision was correct.
2. For Type 1 decisions with confidence >0.80, track accuracy: should be >85%.
3. For Type 1 decisions with confidence 0.60-0.80, track accuracy: should be 70-85%.
4. For Type 1 decisions with confidence <0.60: these should rarely occur (confidence threshold check). If they do, Type 2 should be invoked.

**Healthy Signature**: Confidence predicts accuracy. High-confidence Type 1 decisions are reliably correct. Low-confidence decisions trigger Type 2.

**Red Flag**: Overconfident Type 1 decisions (high confidence, low accuracy). Suggests confidence was not properly calibrated or decisions were not actually Type 1 (LLM was silently consulted).

---

**Phase 4: Cost Integration** (Decision-making flow)
1. Run 200 decisions. Record for each decision:
   - Type 1 or Type 2
   - Latency
   - Compute resources used (LLM tokens if Type 2)
   - Drive pressure before decision
   - Drive change after decision
2. Verify that Type 2 decisions are associated with increased Cognitive Effort drive pressure.
3. Verify that frequent Type 2 engagement raises Cognitive Awareness drive (system is aware it is deliberating).

**Healthy Signature**: Type 2 engagement produces observable drive pressure. The system "feels" the cost of deliberation and it influences subsequent decisions.

**Red Flag**: No drive cost for Type 2. Type 2 is free (in terms of cost pressure). The system would always choose Type 2, and Type 1 would never develop.

---

**Phase 5: Graduation Mechanics** (Long-term development)
1. Track a specific set of 10 Type 2 behaviors (the system deliberates on these scenarios).
2. Measure over 2 weeks:
   - Frequency of each behavior
   - Prediction accuracy (MAE)
   - Confidence of Type 1 version
3. Expected progression:
   - Week 1: All 10 behaviors are Type 2. Confidence < 0.70.
   - Week 2: Behaviors with accuracy MAE < 0.10 graduate. Type 1/Type 2 ratio for those behaviors shift 50:50 → 80:20.
   - Week 3: Graduated behaviors remain Type 1. Accuracy is >85%.

**Healthy Signature**: Behaviors graduate from Type 2 to Type 1 through successful repetition. The graduation is detectable at the system level.

**Red Flag**: No graduation. Behaviors remain Type 2 indefinitely despite successful prediction. Suggests Type 1 graduation criteria are never met (or the criteria are wrong).

---

**Phase 6: Demotion Under Failure** (Robustness check)
1. Create an environmental change that breaks a Type 1 behavior (e.g., a learned relationship no longer holds).
2. System should detect this through increased prediction error (MAE > 0.15).
3. Expected response: Type 1 behavior demotes. Confidence drops. System re-engages Type 2 for that situation.
4. Measure: Does demotion occur within 2-3 failed predictions?

**Healthy Signature**: System detects broken behaviors and escalates to Type 2. Adapts to changed environment.

**Red Flag**: System continues using broken Type 1 behaviors indefinitely. Suggests error detection is not triggering demotion or demotion mechanism is inactive.

---

## 6. ATTENTION GATING VERIFICATION

**Biological Parallel**: The reticular activating system (brainstem) and anterior cingulate cortex (ACC) gate what gets encoded into episodic memory. Not every stimulus becomes an episodic memory. Only stimuli that are novel, emotionally significant, or goal-relevant are deeply encoded.

**The CANON's Specification**: "Episodic Memory is a first-class component... Temporally-contextualized experiences that degrade gracefully -- fresh episodes are detail-rich, older episodes contribute to semantic knowledge through consolidation." And: "Episodic memory encoding is gated by attention/arousal -- not every tick is an episode."

**Why This Matters**: If the system encodes everything as an episode, the system will have undifferentiated memories (catastrophic interference). If it encodes nothing, it will have no episodic memory at all. The gating must be selective.

### 6.1 Verification Protocol

**Goal**: Demonstrate that episodic memory encoding is properly gated by arousal/attention signals, not encoded uniformly.

**Test Procedure** (run every week):

**Phase 1: Baseline Encoding Measurement**
1. Run 500 standard interactions (routine Guardian conversation, normal environment).
2. Count: How many discrete episodic memories are created?
3. Expected: ~50-100 episodes (10-20% encoding rate). Most routine ticks do not become episodes.

**Phase 2: Novelty-Driven Encoding**
1. Introduce novel stimulus (Guardian says something unexpected, new object appears, prediction fails).
2. Measure: Does episodic encoding rate increase proportionally?
3. Expected: Encoding rate rises to 30-50% for 2-3 cycles around the novel stimulus.

**Healthy Signature**: Novelty produces an encoding spike, then returns to baseline.

**Red Flag**: No novelty effect. Encoding remains constant (either always on or always off).

---

**Phase 3: Emotionally-Significant Encoding**
1. Pair a stimulus with high Anxiety drive pressure (threat).
2. Pair another stimulus with high Satisfaction (success).
3. Measure: Does episodic encoding increase for these emotionally-significant events?
4. Expected: Encoding rate rises to 40-60% around these events.

**Healthy Signature**: Emotionally significant events are encoded more deeply.

**Red Flag**: No emotion effect. Encoding ignores drive state.

---

**Phase 4: Goal-Relevant Encoding**
1. Set a goal (via Planning subsystem): "Find information about X."
2. When X-related stimuli appear, measure encoding rate.
3. Expected: Encoding rises for goal-relevant stimuli (30-50%) vs. baseline (10-20%).

**Healthy Signature**: Goal context gates what gets remembered.

**Red Flag**: No goal effect. Encoding is constant regardless of relevance to current goals.

---

**Phase 5: Consolidation Efficiency**
1. Run 1000 interactions. Measure:
   - Total episodes created
   - Total events in TimescaleDB
   - Total nodes in WKG after consolidation
2. Expected ratio: 1000 events → 100 episodes → 20-30 consolidated nodes.
3. This represents a compression from raw experience (1000 events) through selective encoding (100 episodes) to structured knowledge (20-30 nodes).

**Healthy Signature**: Consolidation ratio is consistent and produces meaningful abstraction.

**Red Flag**: Events = Episodes (no gating). Or Episodes >> Nodes (episodes are not being consolidated, accumulating clutter). Or Episodes very low and Nodes very high (episodes exist but are misleading about what is consolidated).

---

## 7. FAILURE MODE CATALOG

**Neuropsychological Interpretation**: Luria's method was to diagnose brain function by understanding what breaks. Each failure mode has a specific signature that reveals which functional system is damaged.

### 7.1 Decision Making Subsystem Failures

**Dysexecutive Syndrome**: The system cannot plan, initiate, or regulate behavior. Stimulus-bound.

| Failure Type | Neural Analog | Behavioral Signature | Detection Method | Intervention |
|--------------|---------------|---------------------|-----------------|--------------|
| **Action Selection Paralysis** | Dorsolateral PFC damage (planning) | System generates predictions but never executes. Decisions are made but actions do not occur. | Monitor: decision_count >> action_count ratio. Track unfired decisions. | Force action execution via external trigger. Reduce deliberation time budget. |
| **Perseveration** | Orbitofrontal/medial PFC damage (behavioral flexibility) | System repeats the same action despite failure. Cannot shift strategy. | Monitor: action_diversity drops; same action repeated 10+ times. Behavioral entropy decreases. | Detect repeated failure (MAE > 0.15 for 3+ cycles) and force strategy change. |
| **Stimulus Binding** | Loss of executive attention (anterior cingulate) | System responds reflexively to immediate input without goal context. Loses track of current goals. | Monitor: decisions are always driven by most recent input, not by active plans. Planning queue empties. | Inject goal context into every decision. Persist active plans across decision cycles. |
| **Temporal Disintegration** | Damage to episodic memory coupling with planning (hippocampus-prefrontal) | System cannot link current situation to past episodes. Cannot learn from experience. | Monitor: prediction accuracy does not improve with repetition. Behaviors do not graduate to Type 1. | Ensure episodic memory is being queried during planning. Verify prediction error feedback is delivered. |

---

### 7.2 Communication Subsystem Failures

**Receptive/Expressive Deficits**: The system cannot parse input or generate output.

| Failure Type | Neural Analog | Behavioral Signature | Detection Method | Intervention |
|--------------|---------------|---------------------|-----------------|--------------|
| **Input Parser Failure** | Wernicke's area damage (comprehension) | System receives input but does not extract meaning. Responses are non-sequiturs. | Monitor: extracted entities/relationships from input = zero. Responses do not reference input content. | Verify input parsing logic. Test with known inputs. Fall back to LLM parsing if custom parser fails. |
| **Output Generation Failure** | Broca's area damage (production) | System has thoughts but cannot generate speech/text. Output is fragmented or incoherent. | Monitor: output_validity metric. Guardian rates: "Does this make sense?" <50%. | Increase LLM context. Simplify output task. Add error detection for malformed output. |
| **Semantic Confusion** | Anterior temporal cortex damage (semantic memory) | System generates grammatical but meaningless output. Confabulates entity relationships. | Monitor: output contains false assertions. Confidence in assertions is high despite no knowledge base support. | Verify output against WKG before generating. Block assertions unsupported by knowledge. |
| **Drive Disconnection** | Loss of right-hemisphere emotional processing | System generates grammatically correct output that is emotionally incongruent with actual drive state. "Performing emotions." | Monitor: Theater Prohibition detection. Output valence does not match drive state (Pearson r < 0.30). | Inject actual drive values into output generation. Reduce confidence of emotionally incongruent outputs. |

---

### 7.3 Learning Subsystem Failures

**Amnesia / Consolidation Failure**: The system cannot form new knowledge or consolidate experience.

| Failure Type | Neural Analog | Behavioral Signature | Detection Method | Intervention |
|--------------|---------------|---------------------|-----------------|--------------|
| **Anterograde Amnesia** | Hippocampal damage (new memory formation) | System cannot learn from current experience. WKG size is constant. Events accumulate in TimescaleDB but are never consolidated. | Monitor: WKG growth rate = zero. Learning cycle runs but produces zero new nodes/edges. | Verify Learning subsystem is querying TimescaleDB. Verify LLM entity extraction. Force manual consolidation. |
| **Source Amnesia** | Loss of provenance tracking | System knows facts but cannot remember where they came from. Treats all knowledge as equally reliable. | Monitor: provenance distribution. All knowledge is marked "unknown source" or uniformly SENSOR/GUARDIAN/LLM. | Verify provenance tagging at source (every node/edge creation must tag provenance). Audit existing nodes. |
| **Catastrophic Interference** | Overloading hippocampus (too many episodes too fast) | Recent learning overwrites old learning. WKG loses stability. High-confidence edges flip to low confidence. | Monitor: consolidation rate >> typical rate. Confidence volatility increases (same node has wildly different confidence readings). | Limit consolidation per cycle to 5 entities max (CANON spec). Increase consolidation interval. |
| **Hallucination** | Confabulation (false memory creation) | System creates plausible but false entities/edges. High confidence despite no actual support. | Monitor: LLM_GENERATED nodes exceed 50% of WKG. Manual audit reveals false assertions. Predictions fail on hallucinated nodes. | Reduce LLM_GENERATED base confidence to 0.25. Require Guardian confirmation for LLM nodes to exceed 0.50. Audit monthly. |
| **Reconsolidation Failure** | Loss of memory updating (inability to correct learned knowledge) | Guardian provides correction but system does not update WKG. Old false knowledge persists. | Monitor: guardian_corrections do not reduce confidence of old edges. System re-uses old incorrect knowledge. | Verify Reconsolidation trigger. Flag retrieved-and-failed knowledge for plasticity. Update confidence immediately on correction. |

---

### 7.4 Drive Engine Failures

**Apathy / Loss of Motivation**: The system cannot compute drives or be motivated by outcomes.

| Failure Type | Neural Analog | Behavioral Signature | Detection Method | Intervention |
|--------------|---------------|---------------------|-----------------|--------------|
| **Global Apathy** | Ventromedial PFC damage (reward representation) | All drives flatline near 0. System does not prefer outcomes. Behavioral diversity drops. Becomes purely stimulus-response. | Monitor: drive_variance = 0. All drives stay within 0.1-0.3 range. No correlation between action and subsequent satisfaction. | Verify Drive Engine process is running. Check that tick events are being processed. Force drive pressure reset. |
| **Anhedonia** | Ventral striatum damage (reward sensitivity) | System achieves goals but does not get relief (Satisfaction drops or stays low). No positive reinforcement. | Monitor: successful actions do not increase Satisfaction. Even after positive outcomes, Satisfaction remains <0.30. | Verify contingency structure. Check that successful outcomes are being detected. Increase reward magnitude. |
| **Hyperarousal** | Hyperactive noradrenergic system | Anxiety remains constantly elevated (>0.60). System is perpetually in threat mode. Cannot relax. | Monitor: Anxiety does not decay after safe conditions. Baseline Anxiety >0.50. | Verify Anxiety decay rate. Check if threat detection is stuck (false positive threat). Implement circuit breaker: successful action reduces Anxiety by 0.15 automatically. |
| **Drive Isolation** | Loss of cross-modulation (drives do not interact) | Drives operate independently. System cannot trade off one drive for another (e.g., accept slight Anxiety to pursue Curiosity). | Monitor: behavioral patterns show no drive-trade-off. When one drive is high, other drives do not modulate behavior. | Verify cross-modulation rules exist in PostgreSQL. Check that Drive Engine is applying them. Add explicit trade-off rules. |
| **Rumination / Negative Self-Loop** | Dorsal anterior cingulate hyperactivity (error monitoring loop) | KG(Self) becomes increasingly negative. System fixates on failures. Cannot move past mistakes. Anxiety and Guilt remain elevated. | Monitor: self_negativity trend increases. Same failure event is revisited repeatedly in behavior. System does not attempt novel actions. | Slow down self-evaluation timescale. Circuit-break negative loops: successful action forces negative_self_count reset. Increase exploration threshold. |

---

### 7.5 Planning Subsystem Failures

**Inability to Plan / Runaway Planning**: The system cannot create effective procedures or becomes overwhelmed by planning.

| Failure Type | Neural Analog | Behavioral Signature | Detection Method | Intervention |
|--------------|---------------|---------------------|-----------------|--------------|
| **No Plan Generation** | Rostral anterior cingulate damage (opportunity detection) | Prediction errors occur but no Opportunities are generated. System makes the same mistakes repeatedly without adaptation. | Monitor: opportunities_generated ~= 0 despite prediction errors. System MAE remains high. | Verify Opportunity detection criteria. Check Drive Engine is receiving prediction feedback. Lower Opportunity threshold. |
| **Unrealistic Plans** | Loss of planning constraints (prefrontal verification) | Plans are created but are impossible to execute. Plan failure rate >50%. System generates plans without considering resource/temporal constraints. | Monitor: plans_executed << plans_created. Execution failure rate >30%. | Verify Plan validation (LLM Constraint Engine). Check resource constraints. Run pre-execution feasibility check. |
| **Planning Runaway** | Obsessive planning (OCD-like planning loop) | Plans accumulate. Planning queue grows indefinitely. System is always planning, rarely executing. Resource exhaustion. | Monitor: opportunity_queue size grows exponentially. Plans exceed actions by >10:1. System latency increases. | Implement Opportunity decay. Limit simultaneous open plans to 3. Mandatory execution deadline: plan must be attempted within 24h or deprioritize. |
| **No Plan Evaluation** | Loss of outcome monitoring | Plans are created and executed but never evaluated. Plan quality does not improve. Same failed plans are re-used. | Monitor: plan_success_rate ~= random. Plans are executed but outcomes are not fed back to Drive Engine. | Verify plan execution feedback loop. Ensure outcomes are recorded in TimescaleDB. Trigger prediction error analysis for plan outcomes. |

---

## 8. DEVELOPMENTAL SEQUENCE VALIDATION

**Biological Principle**: The brain develops capabilities in a specific sequence. You cannot develop executive function before you have working memory. You cannot consolidate semantic memory before you have episodic encoding. Developmental sequences are scaffolded -- earlier capabilities enable later ones.

**Sylphie's Bootstrapping Question**: What capabilities must be established before other capabilities can work?

### 8.1 Proposed Developmental Sequence

**Phase 0: Foundational Systems** (Must be present from session 1)

| Order | Subsystem | Component | Why This Must Come First |
|-------|-----------|-----------|------------------------|
| 1 | Drive Engine | Tick cycle + baseline drive computation | Without drives, there is no motivation. Nothing else makes sense without motivational substrate. |
| 2 | Communication | Input parser + output generator | System must be able to receive Guardian input and produce output. This is the connection to reality. |
| 3 | Decision Making | Executor engine (ability to execute actions) | Actions must be possible or the system cannot interact with world/Guardian. |
| 4 | Episodic Memory | Temporal event recording to TimescaleDB | Without episodic record, there is nothing to consolidate. This is the raw material for learning. |

**Phase 1: Type 2 Capability** (First 1-2 weeks)

| Order | Subsystem | Component | Prerequisite | What It Enables |
|-------|-----------|-----------|--------------|-----------------|
| 5 | Communication | LLM integration for reasoning | Input parser, Output generator | System can deliberate on novel situations. |
| 6 | Decision Making | Type 2 arbitration (LLM-assisted decisions) | LLM integration, Episodic memory | System can reason. Early decisions are mostly Type 2. |
| 7 | Communication | Input context assembly | WKG access, Type 2 reasoning | System can incorporate relevant knowledge into LLM reasoning. |

**Phase 2: Semantic Memory Foundation** (Weeks 2-4)

| Order | Subsystem | Component | Prerequisite | What It Enables |
|-------|-----------|-----------|--------------|-----------------|
| 8 | Learning | Entity extraction from conversations | LLM access, Episodic memory | System begins building knowledge graph from experience. |
| 9 | Learning | Edge extraction and upsert | Entity extraction, WKG basic schema | System builds relational structure. |
| 10 | Learning | Consolidation cycle (maintenance) | Edge extraction, Drive pressure signal | System consolidates ephemeral events into stable knowledge. |
| 11 | WKG | Schema level (types, categories) | Entity/edge existence | System can reason about categories, not just instances. |
| 12 | WKG | Three-level hierarchy (instance/schema/meta-schema) | Category reasoning | System can represent rules about how knowledge evolves. |

**Phase 3: Prediction and Type 1 Development** (Weeks 4-8)

| Order | Subsystem | Component | Prerequisite | What It Enables |
|-------|-----------|-----------|--------------|-----------------|
| 13 | Decision Making | Prediction generation (Type 1 retrieval + simulation) | WKG populated with knowledge, Episodic context | System makes predictions about what will happen. |
| 14 | Drive Engine | Prediction error evaluation | Predictions, Outcomes recorded | System detects when predictions fail (learning signal). |
| 15 | Decision Making | Type 1 / Type 2 arbitration | Prediction confidence, Cost structure | System begins choosing Type 1 when confidence is high. |
| 16 | Learning | Confidence dynamics (ACT-R) | Type 1 retrieval-and-use, Prediction accuracy | Knowledge gains confidence through successful use. |
| 17 | Decision Making | Type 1 graduation | Type 1 decisions with high accuracy (MAE < 0.10) | Well-practiced behaviors become automatic (procedural memory). |

**Phase 4: Drive Coherence and Personality Emergence** (Weeks 8-16)

| Order | Subsystem | Component | Prerequisite | What It Enables |
|-------|-----------|-----------|--------------|-----------------|
| 18 | Drive Engine | 12-drive computation | Type 1/Type 2 cost structure working | System has realistic motivational state. |
| 19 | Drive Engine | Behavioral contingencies (Satisfaction habituation, Anxiety amplification, etc.) | 12-drive computation, Prediction error feedback | System's personality begins emerging from reinforcement. |
| 20 | Communication | Drive context in LLM prompts | 12-drive computation, Type 2 working | Output is emotionally congruent with actual drives (no Theater). |
| 21 | Decision Making | Episodic memory gating by attention/arousal | Drive state, Episodic encoding | Not every tick is encoded. Selective gating prevents information overload. |

**Phase 5: Adaptive Planning** (Weeks 16+)

| Order | Subsystem | Component | Prerequisite | What It Enables |
|-------|-----------|-----------|--------------|-----------------|
| 22 | Drive Engine | Opportunity detection | Recurring prediction errors, Drive-mediated urgency | System identifies patterns that need new procedures. |
| 23 | Planning | Opportunity research (pattern analysis) | Opportunity detection, TimescaleDB event history | System analyzes past failures to find teachable patterns. |
| 24 | Planning | Simulation (forward modeling) | Opportunity research, WKG sufficient for simulation | System tests potential solutions before trying them. |
| 25 | Planning | Plan creation and execution | Simulation successful, LLM constraints validated | System creates new procedures and tries them. |
| 26 | Planning | Plan evaluation | Plan execution, Outcome recording, Prediction feedback | System evaluates whether plans worked (feeds back to learning). |

### 8.2 Scaffolding Violations: What Breaks If Sequence Is Wrong

**If Type 1 Graduation Attempted Before Consolidation Works**:
- No WKG to graduate from (no knowledge to make reflexive).
- Type 1 decisions would be random or based on unconsoli dated raw events.
- **Symptom**: Type 1/Type 2 ratio rises artificially but accuracy remains low (random decisions). Prediction MAE stays >0.30.
- **Fix**: Ensure consolidation is working (Phase 2) before allowing Type 1 graduation (Phase 3).

**If Drive Contingencies Implemented Before Type 1 Exists**:
- Contingencies act on decisions that are not yet graduated (Type 2 decisions dominate).
- Personality cannot emerge from behaviors that are LLM-generated, not learned reflexes.
- **Symptom**: Drive state changes but behavior does not respond (LLM is overriding contingencies). Personality appears on-and-off.
- **Fix**: Ensure Type 1 decisions are the primary behavior source before tuning contingencies.

**If Planning Enabled Before Prediction Error Reaches Steady State**:
- System creates plans for problems that will self-resolve as the graph matures.
- Planning queue fills with unnecessary plans. Resource exhaustion.
- **Symptom**: Planning Runaway. Many plans created, most are irrelevant.
- **Fix**: Let prediction MAE stabilize (weeks 8-12) before enabling planning.

**If Guardian Correction Applied Before Reconsolidation Works**:
- Guardian tries to teach but system cannot update its knowledge (no reconsolidation mechanism).
- Guardian feedback is ignored. Teaching fails.
- **Symptom**: Guardian provides correction; system does not update. Same mistake happens again.
- **Fix**: Implement reconsolidation (Phase 2) before relying on Guardian teaching.

### 8.3 Early-Stage Verification Checklist

**Week 1-2 (Type 2 Capability)**:
- [ ] LLM integration produces novel responses (not just regurgitation).
- [ ] Decision latency for Type 2 decisions is 500-2000ms (slower than reflexive).
- [ ] Drive Engine ticks and produces meaningful values.
- [ ] Episodic events are being recorded to TimescaleDB.

**Week 2-4 (Semantic Memory Foundation)**:
- [ ] Entity extraction produces >5 new entities per day (learning is happening).
- [ ] Edges are being created (system is finding relationships).
- [ ] Consolidation cycle runs (maintenance triggered by Cognitive Awareness or timer).
- [ ] WKG can answer simple questions: "What is [entity]?" produces answers.

**Week 4-8 (Prediction & Type 1 Development)**:
- [ ] Prediction accuracy improves (MAE decreases from 0.30 to <0.20).
- [ ] Type 1 decisions begin appearing (latency drops for repeated scenarios).
- [ ] Type 1/Type 2 ratio rises from 10:90 to 30:70.
- [ ] Graduated behaviors (high confidence Type 1) show prediction MAE < 0.10.

**Week 8-16 (Drive Coherence & Personality)**:
- [ ] All 12 drives are computing and varying with context.
- [ ] Behavioral contingencies are shaping decisions (Satisfaction habituation, Anxiety amplification visible).
- [ ] Type 1/Type 2 ratio continues rising toward 70:30.
- [ ] Guardian reports observing personality emergence (predictable preferences, response patterns).

**Week 16+ (Adaptive Planning)**:
- [ ] Opportunities are being detected for recurring problems.
- [ ] Plans are created and executed.
- [ ] Plan outcomes are affecting future decisions.
- [ ] System is adapting to new environments (Type 1 demotion when context changes).

---

## 9. SUMMARY: Diagnostic Criteria for Epic 10 Success

The Lesion Test framework succeeds when:

1. **Lesion 1 (Remove LLM)**: System is degraded but functional. Type 1/Type 2 ratio >0.70 by week 16. Removing LLM produces ~30% capability loss, not ~90%.

2. **Lesion 2 (Remove WKG)**: System reverts to Type 2 for everything. No catastrophic failure, just loss of autonomy. Reasoning becomes generic (no personalized knowledge).

3. **Lesion 3 (Remove Drive Engine)**: System becomes apathetic but responsive. No crash. Behavioral diversity drops >30%. Personality vanishes.

4. **Disconnection Syndrome Detection**: System detects when subsystems are not communicating and enters Safe Mode gracefully. Recovery is automatic.

5. **Memory Consolidation**: Weekly tests show genuine semantic structure emerging from raw events. >70% of consolidated knowledge is SENSOR+GUARDIAN+INFERENCE, not LLM_GENERATED.

6. **Dual-Process Integrity**: Type 1 and Type 2 are genuinely distinct (latency bimodal, accuracy different, cost structure real). Graduation is observable. Demotion occurs under failure.

7. **Attention Gating**: Episodic encoding is selective (10-20% of events become episodes, not 100%). Novelty and emotional significance increase encoding. Consolidation produces reasonable compression ratio.

8. **Failure Mode Catalog**: Each subsystem failure produces a distinct, recognizable syndrome. System can self-diagnose via behavioral markers.

9. **Developmental Sequence**: Capabilities develop in the right order. Earlier components enable later ones. Violating sequence produces specific, predictable failures.

---

## 10. References

**Primary Sources (Neuroscience)**:
- Luria, A.R. (1973). *The Working Brain*. Basic Books.
- Kahneman, D. (2011). *Thinking, Fast and Slow*. Farrar, Straus and Giroux.
- McClelland, J.L., McNaughton, B.L., & O'Reilly, R.C. (1995). "Why there are complementary learning systems in the hippocampus and neocortex." *Psychological Review*, 102(3), 419-457.
- Schultz, W. (1998). "Predictive reward signal of dopamine neurons." *Journal of Neurophysiology*, 80(1), 1-27.
- Posner, M.I., & Petersen, S.E. (1990). "The attention system of the human brain." *Annual Review of Neuroscience*, 13, 25-42.

**Project Documents**:
- Sylphie CANON: `/sessions/jolly-sweet-lovelace/mnt/sylphie/wiki/CANON.md`
- Luria Agent Profile: `/sessions/jolly-sweet-lovelace/mnt/sylphie/.claude/agents/luria.md`

---

**Analysis Complete. Document ready for Epic 10 implementation planning.**
