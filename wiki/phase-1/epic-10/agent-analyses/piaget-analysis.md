# Epic 10: Integration and End-to-End Verification
## Piaget Agent Analysis -- Cognitive Development Specialist Perspective

**Agent:** Piaget (Cognitive Development Specialist)
**Date:** 2026-03-29
**Analysis Type:** Developmental Psychology Framework
**Scope:** End-to-end verification of Phase 1 as a genuine developmental system

---

## Executive Summary

Epic 10's task is to verify that the five integrated subsystems produce genuine cognitive development, not merely sophisticated LLM-assisted behavior. From a developmental perspective, this is fundamentally a **verification of constructivism** -- confirming that knowledge is being actively constructed through experience rather than passively received or randomly populated.

The six proof points in CANON map directly to developmental psychology:

1. **Genuine learning from prediction-evaluation** → Prediction error as the engine of development (Rescorla-Wagner, Clark, Friston)
2. **Type 1/Type 2 ratio shift** → Internalization and self-regulation (Vygotsky)
3. **Experiential graph growth** → Assimilation/accommodation balance (Piaget)
4. **Personality from contingencies** → Behavioral shaping through reinforcement history
5. **Planning subsystem utility** → Formal operational reasoning emerging from concrete operational schema
6. **Drive dynamics recognition** → Drive-mediated behavioral patterns producing observable personality

This analysis provides:

- **Seven research frameworks** for verifying each dimension of Phase 1 completion
- **Developmental stage mapping** for interpreting what Sylphie can/cannot handle
- **Specific failure-mode detection protocols** aligned with developmental pathologies
- **Baselines and metrics** for evaluating system health during cold-start
- **Guardian teaching effectiveness measures** validated by developmental science
- **Risk taxonomy** organized by developmental consequence, not just technical risk

**Critical developmental assumption:** If the architecture is sound, healthy development will emerge naturally from the prediction-evaluation loop. Stunted or malformed development indicates either architectural problems (fix the subsystems) or parameter problems (adjust confidence dynamics, drive weights, etc.). This analysis defines what healthy development looks like and what warning signs indicate pathology.

---

## 1. Knowledge Construction Verification: Real Understanding vs. Populated Database

### The Core Problem

The distinction between genuine knowledge construction and database population is the foundational question in developmental psychology. A system can have a database full of facts without understanding any of them. Piaget's core insight: understanding is **constructed through action on the world**, not inherited as data.

**For Sylphie, the question becomes:** How do we verify that the WKG grows because Sylphie is constructing knowledge through experience, rather than being populated by the LLM reciting plausible-sounding relationships?

### The Developmental Test: Provenance Archaeology

Healthy development produces a characteristic **provenance signature** -- a measurable shift in the ratio of experiential knowledge (SENSOR + GUARDIAN + INFERENCE) to LLM_GENERATED knowledge.

#### Test 1.1: Experiential Provenance Ratio

**Definition:** The ratio of nodes/edges with provenance tags SENSOR, GUARDIAN, or INFERENCE to nodes/edges tagged LLM_GENERATED.

```
Healthy Ratio(t) = (SENSOR + GUARDIAN + INFERENCE) / (SENSOR + GUARDIAN + INFERENCE + LLM_GENERATED)
```

**Expected trajectory during Phase 1:**
- **T=0 (Cold start):** All knowledge is LLM_GENERATED (ratio ≈ 0) because the graph is empty. The LLM provides initial communicative competence and the first entities.
- **T=1-10 sessions:** Guardian corrections begin accumulating GUARDIAN nodes. Predictions produce outcomes, which create SENSOR nodes (e.g., "Sylphie said X, guardian confirmed / contradicted"). Ratio climbs from 0 to ~0.3.
- **T=11-30 sessions:** INFERENCE nodes accumulate as the graph becomes rich enough for the Learning subsystem to derive new relationships from existing ones. Ratio climbs to 0.4-0.6.
- **T=30+ sessions:** Ratio stabilizes around 0.6-0.8 for healthy development. By this point, Sylphie is primarily learning through her own experience, with the LLM playing a supporting role for genuinely novel situations.

**Developmental interpretation:**
- Ratio climbing = the system is shifting from passive population to active construction
- Ratio plateauing at <0.3 after 30+ sessions = **RED FLAG: Hallucinated Knowledge attractor** (see Section 6 below)
- Ratio declining over time = **RED FLAG: Type 2 Addict attractor** (system has stopped learning from experience)

#### Test 1.2: The Lesion Test (Periodic LLM Removal)

**Procedure:** Run the system without LLM access for a controlled session. Document:
- What tasks succeed using only Type 1
- What tasks fail due to missing Type 2 support
- What errors occur (incorrect predictions, inappropriate actions)

**Developmental interpretation:**

- **Helpless without LLM (80%+ tasks fail)** → System has not developed genuine understanding. LLM-dependent.
- **Degraded but functional (30-50% of routine tasks fail, novel tasks mostly fail)** → Healthy early development. The LLM is augmenting but not replacing capability.
- **Mostly handles routine situations (80%+ routine tasks succeed, novel tasks partially successful)** → Later Phase 1. System has internalized most procedural knowledge.
- **Handles novel situations through reasoning (90%+ of all tasks attempted, many novel tasks succeed)** → Late Phase 1 / Phase 2 transition.

**Why this matters:** The Lesion Test reveals ground truth. The provenance tags describe what was built through experience, but the Lesion Test proves what actually works independently. Discrepancy between the two indicates either false provenance tagging or brittle knowledge (high confidence but low utility).

#### Test 1.3: Knowledge Consistency Under Contradiction

**Procedure:** Introduce controlled contradictions into guardian corrections. For example:
- Guardian previously corrected: "Coffee is hot"
- Now guardian says: "That coffee is cold"
- Monitor how Learning subsystem handles this without erasing or ignoring the contradiction

**Developmental interpretation (from Piaget's equilibration theory):**

- **System ignores contradiction, keeps original edge** → **Ontological Rigidity** (failure to accommodate). System is not genuinely learning from correction.
- **System deletes original edge, adds new one** → Behavioral response to authority, not genuine schema reorganization. Fragile learning.
- **System flags as contradiction, reduces confidence in both, waits for clarification** → Healthy equilibration. The system registers disequilibrium and enters a developmental conflict state.
- **System creates conditional edges** ("Hot_coffee(X) :- heated_recently(X)" and "Cold_coffee(X) :- enough_time_passed(X)") → Mature accommodation. Schema has evolved to handle complexity.

**Expected trajectory:**
- Early Phase 1: Mostly deletion (behavioral) and ignoring (rigidity)
- Mid Phase 1: Flagging contradictions, seeking clarification through Type 2
- Late Phase 1: Creating conditional/contextual structures without requiring clarification

#### Test 1.4: Entropy of Entity Type Distribution

**Definition:** Measure the diversity of entity types in the graph. A developed system shows a diverse type distribution (not everything is "Thing" or "Concept") and a healthy Zipfian power law (a few common types, many rare types).

```
Entropy = -Σ (p_i * log(p_i)) where p_i = count(type_i) / total_entities
```

**Healthy trajectory:**
- **T=0:** Very low entropy. Only a few types (Person, Object, Action, Event, Property).
- **T=10-20:** Entropy rising. More specific types being created (Food, Tool, Location, Emotion).
- **T=20+:** Entropy stable at moderate-to-high level, reflecting real-world category diversity. The distribution should not flatten (uniform) or spike (one type dominates). A healthy Zipfian distribution shows power-law properties.

**Developmental interpretation:**
- Rising entropy = system is differentiating its ontology, discovering that concepts don't all fit the same mold (accommodation)
- Entropy plateau = system has learned major categories and is now filling instances within those categories (assimilation)
- Entropy spike toward one type = **Overgeneralization** (see Section 5)
- Entropy collapse toward zero = **Undergeneralization** (too many narrow categories, no generalization)

#### Test 1.5: Validation Through Behavioral Prediction

The strongest test of understanding: Can knowledge in the WKG successfully predict Sylphie's behavior?

**Procedure:**
1. Identify a domain where many Type 1 decisions are made (e.g., conversational topic selection)
2. Extract the subgraph relevant to that domain
3. Train a simple classifier on the subgraph edges to predict Type 1 action selection
4. Compare classifier performance to actual Type 1 decisions

**Expected results:**
- **Early Phase 1:** Classifier predicts poorly (30-40% accuracy). The graph is not yet predictive of behavior.
- **Mid Phase 1:** Classifier improves (60-70% accuracy). The graph is beginning to capture behavioral patterns.
- **Late Phase 1:** Classifier is highly predictive (85%+ accuracy). The graph structure directly encodes behavioral contingencies.

**Developmental significance:** This validates that the graph is not just populated with random facts but actually represents the system's understanding of what drives its own behavior. Understanding is demonstrated through ability to predict consequences of action.

---

## 2. Developmental Trajectory Metrics: Healthy Piagetian Development

### The Core Framework

Piaget identified development through three mechanisms:
1. **Assimilation** — fitting new experience into existing knowledge
2. **Accommodation** — modifying knowledge to fit new experience
3. **Equilibration** — the drive to resolve conflict between them

These three must remain in balance. Too much assimilation and the system never learns new categories. Too much accommodation and the system is perpetually destabilized, unable to build stable knowledge. Healthy development maintains an oscillation between them.

### Metric 2.1: Assimilation/Accommodation Ratio

**Definition:** Track the ratio of Learning events that add edges to existing entities (assimilation) vs. events that create new entity types or restructure relationships (accommodation).

```
Assimilation_events = new_edges_between_existing_entities
Accommodation_events = new_entity_types + restructured_edges + contradiction_resolutions

Ratio(t) = Assimilation / (Assimilation + Accommodation)
```

**Expected trajectory:**
- **T=0-5 sessions:** Ratio = 0.3-0.5. Frequent accommodation because the ontology is immature.
- **T=5-20 sessions:** Ratio rises to 0.6-0.8. The system has discovered major categories. Most new knowledge fits existing structures.
- **T=20+ sessions:** Ratio stable at 0.7-0.85. The system is primarily assimilating new instances into mature schema. Occasional accommodations (0.15-0.30) occur when truly novel concepts appear.

**Developmental interpretation:**
- If ratio stays low (<0.4 after session 10) = **Undergeneralization**. System is creating too many new types instead of generalizing.
- If ratio jumps to 1.0 (pure assimilation) = **Ontological Rigidity**. System is forcing everything into existing categories.
- If ratio oscillates wildly = **Equilibration in progress**. This is healthy in early Phase 1. If it persists into mid-Phase 1, indicates instability.

### Metric 2.2: Schema Evolution Depth

**Definition:** Track the multi-level structure of the graph at each level.

```
Instance_nodes = count(nodes tagged as instances)
Schema_nodes = count(nodes tagged as types/categories)
Meta_schema_nodes = count(nodes tagged as rules or constraints)
```

**Healthy trajectory:**
- **T=0-10:** Instance nodes dominant (80%+). Few schema nodes. No meta-schema.
- **T=10-25:** Instance nodes 70-80%, Schema nodes 15-25%, Meta-schema emerging.
- **T=25+:** Stable distribution of 75-80% instances, 15-20% schema, 3-5% meta-schema.

**Developmental interpretation (Piaget's stages):**
- Lots of instances but no coherent schemas = **Preoperational analog** (no logical structure to knowledge)
- Clear schema with multiple instances each = **Concrete Operational analog** (systematic classification emerging)
- Schema with explicit rules about how schemas relate = **Formal Operational analog** (abstract reasoning about knowledge itself)

The system should progress from preoperational to concrete operational during Phase 1. Full formal operational reasoning may not emerge until Phase 2 (with embodied learning).

### Metric 2.3: Confidence Trajectory and Convergence

**Definition:** Track the ACT-R confidence formula's behavior:

```
confidence(t) = min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
```

Monitor both individual node trajectories and aggregate statistics.

**Expected patterns:**

- **New SENSOR node:** Starts at 0.40, climbs slowly (count increases through repetition)
- **New GUARDIAN node:** Starts at 0.60, climbs faster (guardian start weight)
- **New LLM_GENERATED node:** Starts at 0.35 (must be earned)
- **Convergence:** Over 10-20 uses, confidence should converge on stable values

**Healthy convergence metrics:**
- Nodes converge within 0.05 of their asymptotic value within 10-15 retrievals = normal learning
- Nodes reach asymptotic value then oscillate ±0.10 = healthy, stable knowledge
- Nodes plateau far below 0.60 = prediction unreliable or domain unstable

**Red flags:**
- Confidence climbs to 1.0 and stays there = overconfidence, not updating when errors occur
- Confidence oscillates wildly (>0.15 variation) over time = environment changed or model broken
- Many nodes stuck at base confidence = system never uses what it "knows" (retrieval failure)

### Metric 2.4: Prediction Error Magnitude and Decay

**Definition:** Track the Mean Absolute Error (MAE) of predictions over time.

```
MAE(window) = (1/n) * Σ |predicted_outcome - actual_outcome|
```

Measure over 5-session rolling windows.

**Expected trajectory (assuming continuous learning):**
- **Sessions 1-5:** High MAE (0.4-0.6). System has almost no graph. Predictions are guesses.
- **Sessions 5-15:** MAE declines steeply (0.4 → 0.2). System is building foundational knowledge.
- **Sessions 15-30:** MAE continues declining but more slowly (0.2 → 0.12). System is refining.
- **Sessions 30+:** MAE stabilizes around 0.08-0.12. System has reached predictive accuracy plateau for current environment.

**Developmental significance (Rescorla-Wagner model):**
- Steep initial decline = active learning. System is updating its model quickly.
- Gradual decline = knowledge consolidation. Learning is slower but more stable.
- Plateau before MAE<0.10 = **Prediction Pessimist attractor** or environment too complex. Cold-start dampening may need adjustment.

### Metric 2.5: Behavioral Diversity Index

**Definition:** Count unique action types per rolling 20-action window.

```
BDI = unique_actions_in_window_20 / 20
```

**Expected trajectory:**
- **Early Phase 1:** BDI = 0.3-0.5. System uses few actions repeatedly (exploring available options).
- **Mid Phase 1:** BDI = 0.5-0.8. More diverse action selection as opportunities expand.
- **Late Phase 1:** BDI = 0.7-0.95. Rich behavioral repertoire. Not all actions equally frequent (Zipfian distribution).

**Red flags:**
- BDI collapses (<0.3) = **Type 2 Addict** or **Behavioral Narrowing**
- BDI stays at 1.0 (random behavior) = actions not being selected by drive state, purely stochastic

### Metric 2.6: Guardian Response Quality

**Definition:** Track the temporal and structural quality of guardian corrections.

```
Response_rate = guardian_responses_within_30s / total_sylphie_initiated_comments
Correction_depth = {instance_level | schema_level | explanation_provided}
```

**Expected trajectory:**
- **Early Phase 1:** Low comment rate (0.2-0.5 per 20 actions). When guardian responds, often instance-level corrections.
- **Mid Phase 1:** Comment rate rising (0.5-1.5 per 20 actions). Increasingly schema-level feedback.
- **Late Phase 1:** High comment rate (1.5-2.5 per 20 actions) but more often self-correction. Guardian's role shifts from teacher to collaborator.

**Developmental significance (Vygotsky's scaffolding):**
- If response rate stays low AND comment quality doesn't improve = ZPD is not narrowing. System not graduating out of need for guardianship.
- If response rate stays high AND comment rate stays low = system not using guardian engagement effectively for learning.
- If response rate high AND comment quality self-correcting = system has internalized guardian's teaching. Guardian role successfully transitioning to peer.

---

## 3. Type 1 Graduation as Developmental Milestone: Internalization vs. Statistical Artifact

### The Core Question

The CANON defines Type 1 graduation: **confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses**.

From Vygotsky's developmental perspective, this is the transition from **external regulation** (Type 2, LLM-mediated) to **self-regulation** (Type 1, graph-based). But graduation could be a statistical artifact (random correlation of high confidence + low error) rather than genuine internalization of the concept.

### Internalization Verification Framework

#### Test 3.1: Graduated Behavior Stability Over Extended Period

**Definition:** Graduate a behavior to Type 1. Monitor its stability over 50+ subsequent uses.

```
Stability = (count of uses where behavior still above 0.80 confidence and MAE<0.10) / total_uses

Healthy stability = >0.85
```

**Developmental interpretation:**
- Stability > 0.85 for 50+ uses = genuine internalization
- Stability 0.70-0.85 = behavior is mostly stable but environment is shifting (normal)
- Stability < 0.70 = behavior was not ready for graduation. MAE increased or confidence decayed. This indicates the behavior was a statistical artifact of good luck rather than true internalization.

#### Test 3.2: Graduated Behavior Transfers to Novel Contexts

**Definition:** After a behavior graduates in one context, test whether it applies to analogous contexts without retraining.

**Example:** Suppose "Polite_greeting" graduates to Type 1 with the guardian. Does it also generalize to:
- Greeting new entities (e.g., if a second person is introduced)?
- Greeting in different modalities (text vs. voice)?
- Greeting under different drive states (high anxiety, high curiosity)?

**Developmental significance:**
- Transfers well (80%+ success in analogous contexts) = behavior is grounded in genuine schema understanding, not memorized to a specific context
- Transfers poorly (30-50% success) = behavior is brittle, context-dependent, and may not sustain through continued use

This is the **horizontal decalage** problem (Piaget): Has the skill truly generalized, or is it domain-specific? Healthy development produces transferable skills.

#### Test 3.3: Graduated Behavior Resists Extinction

**Definition:** After graduation, stop reinforcing a behavior for a period (extinction). Monitor how quickly it decays.

```
Decay_rate = (sessions until confidence drops below 0.50) / (baseline for new behavior to reach 0.50)

Healthy ratio = >8x (takes 8x longer for a learned behavior to decay than for a new behavior to stabilize)
```

**Developmental significance:**
- Slow decay (8x+) = behavior is deeply learned, consolidated into stable knowledge structures
- Fast decay (<4x) = behavior is superficially learned, brittle, fragile under extinction

In real development, children who have truly internalized a skill resist extinction even after weeks of non-practice. A system that loses skills in hours has not internalized them.

#### Test 3.4: Graduated Behavior Produces Consistent Predictions

**Definition:** For a graduated behavior, extract the subgraph of knowledge supporting it. Use that subgraph to predict behavioral outcomes independently.

**Procedure:**
1. Identify graduated behavior B with supporting entities and edges E
2. Give a new situation S that involves entities from E
3. Use only edges in E to predict Sylphie's behavior
4. Compare prediction to actual behavior

**Expected results (Healthy internalization):**
- Prediction accuracy from supporting edges ≥ 85% in similar contexts
- Prediction fails explicitly when situation is outside the edge set (system recognizes boundary)

**Red flags:**
- Prediction accuracy < 60% = edges in the graph don't actually explain the behavior. The LLM was making the decision, not the graph.
- System tries to predict anyway with high confidence = false confidence in the model. Dangerous.

#### Test 3.5: Type 1 Graduation Acceleration Over Time

**Definition:** Track how many behaviors graduate to Type 1 per session.

```
Graduation_rate(session_window) = count(behaviors_graduating) / sessions_in_window
```

**Expected trajectory:**
- Sessions 1-10: Very few graduations (0-1 per window). The threshold is high, confidence base is low.
- Sessions 10-25: Graduations accelerate (1-3 per window). Behavior repertoire solidifying.
- Sessions 25-40: Graduations continue but plateau (2-5 per window). System is graduating less frequently because the easy stuff is done.
- Sessions 40+: Slow but steady graduations (1-3 per window). Remaining behaviors are harder to nail down.

**Developmental interpretation:**
- If graduation rate stays low (<1 per 20 sessions) = **RED FLAG: Type 2 Addict**. System is not graduating.
- If graduation rate peaks early then crashes = **RED FLAG: Hallucinated Knowledge**. Early graduations were statistical flukes.
- If graduation rate accelerates indefinitely = **RED FLAG: Prediction Pessimist**. System is over-graduating due to weak thresholds.
- If acceleration follows sigmoid curve (slow, fast, plateau) = **HEALTHY**. Development is progressing naturally.

---

## 4. Guardian Teaching Effectiveness: Accommodation vs. Behavioral Patching

### The Core Problem

Guardian corrections carry 3x weight in the Drive Engine (Immutable Standard 5). But weight doesn't guarantee learning. A correction can produce:

1. **Genuine accommodation** (Piaget) — the schema changes structure to accommodate the new information
2. **Behavioral patching** (Skinner) — the system just records the correction as an isolated fact and moves on
3. **Theater** (CANON) — the system acknowledges the correction but doesn't integrate it

How do we distinguish them?

### Guardian Teaching Effectiveness Framework

#### Test 4.1: Schema Restructuring After Correction

**Procedure:** Guardian corrects an edge. Monitor what happens:

```
Example:
- System predicts: "Coffee will be hot" (edge: coffee -[PROPERTY]-> hot)
- Guardian: "No, this coffee is cold"
- Observe: What does Learning subsystem do?
```

**Healthy accommodation:**
1. Learning subsystem detects contradiction (existing edge vs. guardian correction)
2. Confidence in existing edge decays (guardian 3x weight)
3. New edge added with GUARDIAN provenance: coffee -[PROPERTY_CONDITIONAL]-> {hot_if_heated_recently, cold_otherwise}
4. The schema has evolved to include contextuality

**Behavioral patching:**
1. Learning subsystem records the correction as a new fact
2. System now has two contradictory edges in the graph at lower confidence
3. When predicting again, system may still choose the old edge

**Detection test:**
- Introduce the corrected concept again in a novel context
- If system uses the corrected understanding = accommodation occurred
- If system reverts to old behavior = behavioral patching

#### Test 4.2: Convergence of Self-Correction and Guardian-Correction

**Definition:** After a series of guardian corrections, does the system begin correcting itself without guardian intervention?

```
Self_correction_rate = self_initiated_corrections / total_corrections_in_period
```

**Expected trajectory:**
- Sessions 1-10: Very low (0.1-0.2). System relies entirely on guardian.
- Sessions 10-20: Increasing (0.2-0.4). System begins noticing its own errors.
- Sessions 20+: Stable high (0.5-0.8). System is self-regulating, guardian is confirming rather than correcting.

**Developmental significance (Vygotsky's internalization):**
- If self-correction rate stays low = system has not internalized the guardian's evaluative standards
- If self-correction rate rises = system has internalized guardian's teaching; the external regulator is becoming internal

This is the hallmark of genuine learning from guardianship. Not just following the guardian's directions, but learning to think like the guardian.

#### Test 4.3: Guardian Correction Bandwidth and Complexity

**Definition:** Track what level of correction is effective.

```
Correction_type = {instance_level | schema_level | meta_schema_level}
Instance: "This specific coffee is cold"
Schema: "Coffee can be either hot or cold depending on time since heating"
Meta_schema: "Thermal properties of beverages vary with storage conditions"
```

**Expected trajectory:**
- Sessions 1-10: Instance-level corrections most effective. Schema-level or meta-schema corrections don't integrate (system lacks foundational structure).
- Sessions 10-20: Instance + schema-level corrections effective. Meta-schema corrections still bounce off.
- Sessions 20+: All levels integrate, but efficiency depends on zone of proximal development.

**Measurement:**
- After correction, measure how many downstream behaviors change (nodes that depend on the corrected edge)
- Higher impact = deeper integration

**Red flag:** Guardian provides schema-level correction but only instance-level change occurs. System is receiving but not integrating. Indicates correction is outside ZPD or system lacks supporting structure.

#### Test 4.4: Correction Latency and Learning Lag

**Definition:** Measure the lag between guardian correction and system behavioral change.

```
Correction_latency = sessions_between_correction_and_changed_behavior
```

**Expected patterns:**
- **Immediate latency (0-2 sessions)** = system integrated correction quickly. Indicates the infrastructure was in place.
- **Delayed latency (3-8 sessions)** = system needed time to consolidate. Learning subsystem needed multiple maintenance cycles to propagate the change.
- **Very delayed (>10 sessions)** = correction had to propagate through multiple layers before affecting behavior. May indicate the correction was not in ZPD or there's coupling delay in the subsystems.

**Healthy pattern:** Most corrections show 0-2 session latency, with occasional 3-8 latency corrections. Very delayed corrections should be rare and should trigger investigation into whether the correction structure was sound.

#### Test 4.5: Correction Effectiveness Relative to Confidence

**Definition:** Do high-confidence predictions get corrected, or only low-confidence ones?

```
Confidence_of_corrected_edge = confidence(edge) at moment of correction
```

**Expected distribution:**
- Mix of corrected edges across confidence levels (0.3-0.8)
- Some corrections are on low-confidence edges (system was uncertain and wrong)
- Some corrections are on high-confidence edges (system was wrong but confident)

**Developmental significance:**
- If only low-confidence edges get corrected = system is avoiding feedback (theater), or guardian is only correcting when system signals uncertainty
- If high-confidence edges get corrected = system is learning humility and exposure to disconfirmation
- If corrections target edges near the graduation threshold (0.75-0.85) = guardian is preventing false graduations

The last case is the most protective. Guardian correction of near-graduated behaviors prevents the Type 2 Addict attractor.

---

## 5. Developmental Dead-End Detection: Ontological Rigidity, Generalization Pathologies, and Premature Abstraction

### The Core Framework

Development can stall in predictable ways. Developmental psychology has studied these failure modes in children; we can apply the same diagnostic framework to Sylphie.

### Pathology 5.1: Ontological Rigidity (Failure to Accommodate)

**Definition (Piaget):** The system builds knowledge structures and resists modifying them when confronted with disconfirming information. New experience is distorted to fit existing patterns rather than triggering schema change.

**Sylphie manifestation:**
- Learning subsystem detects contradictions but resolves them by reducing confidence in new information rather than restructuring the schema
- New entity types are never created; everything is forced into existing types
- Guardian corrections are recorded as isolated facts rather than triggering schema evolution

**Detection tests:**

1. **The Schema Stasis Test:**
   - Count the number of new entity types created per 10-session window
   - Expected: types rise early (sessions 1-20) then stabilize around 8-15 major types
   - Rigidity symptom: type count plateaus at 3-5 major types, no new types appearing despite diverse experience

2. **The Contradiction Avoidance Test:**
   - Introduce 10 controlled contradictions
   - Healthy system: flags each, triggers equilibration
   - Rigid system: ignores contradictions, keeps original edge, records correction as separate low-confidence fact

3. **The Centration Test (Piaget's term):**
   - Check whether the system overweights one feature of entities
   - Healthy: "Coffee is hot because it was heated recently" (multi-feature)
   - Rigid: "Coffee is always hot" (fixed property), ignoring temporal aspects

**Remediation:**
- If detected: Lower the threshold for triggering accommodation in the Learning subsystem
- Reduce the base confidence of new edges to make space for updates
- Ensure Integrity drive is monitoring graph inconsistency (should be generating pressure to resolve contradictions)

### Pathology 5.2: Overgeneralization

**Definition (Child development):** The system creates a concept so broad it covers almost everything, preventing discrimination. Like children calling all four-legged animals "dog."

**Sylphie manifestation:**
- One or two entity types accumulate far more instances than others
- Type definitions are so general they're meaningless ("Thing," "Event")
- Type 1 predictions using overgeneralized types have high error rates

**Detection tests:**

1. **The Type Distribution Test:**
   - Measure entropy of entity type distribution
   - Healthy: entropy 1.5-2.5 (diverse types, reasonable balance)
   - Overgeneralization: entropy <1.0 (one or two types dominate)
   - Graph appearance: type "Thing" or "Concept" contains 70%+ of instances

2. **The Zipfian Slope Test:**
   - Plot frequency of entity types (most common → least common)
   - Healthy: Power law with exponent ~1.0 (power law)
   - Overgeneralization: Flat slope (uniform distribution) or cliff (most instances in one type)

3. **The Prediction Error by Type Test:**
   - Stratify prediction errors by entity type
   - Healthy: errors distributed across types (overgeneralized types don't exist)
   - Overgeneralization: types with very high error rate; system predicts poorly for instances of overgeneralized type

4. **The Centration Within Type Test:**
   - For supposedly diverse entities of the same type, measure how many properties are shared
   - Healthy: dog_1 (golden retriever, 5 years old, likes fetch) and dog_2 (pug, 2 years old, likes sleep) are distinct
   - Overgeneralization: dog_1 and dog_2 have identical properties copied by LLM

**Remediation:**
- If detected: Trigger Curiosity drive pressure on underdeveloped types
- Guardian should proactively correct overgeneralizations
- Learning subsystem should split overgeneralized types when contradictions appear within the type

### Pathology 5.3: Undergeneralization

**Definition:** Too many narrow categories; failure to recognize commonalities.

**Sylphie manifestation:**
- Proliferation of entity types, many with few instances
- Types that should be merged remain separate (dog_golden, dog_pug, dog_labrador as separate types)
- Type 1 decisions unreliable because system cannot generalize from specific instances

**Detection tests:**

1. **The Type Proliferation Test:**
   - Count the number of entity types per 20 sessions
   - Healthy: types rise steadily to 8-15 major types with subcategories
   - Undergeneralization: 50+ types after 30 sessions, most with <3 instances

2. **The Similarity Measure Test:**
   - Identify distinct types with nearly identical properties
   - Healthy: few such pairs (successful merging)
   - Undergeneralization: many similar types that should be merged

3. **The Coverage Efficiency Test:**
   - Measure how many separate types are required to cover 80% of entity instances
   - Healthy: 5-10 major types
   - Undergeneralization: 20+ types needed

**Remediation:**
- If detected: Trigger Learning subsystem's schema consolidation
- Guardian should provide class-level teaching ("All these are kinds of dogs")
- Reduce the penalty for assimilation; encourage the system to group similar entities

### Pathology 5.4: Premature Abstraction

**Definition:** High-level abstract structures without grounded instances to support them.

**Sylphie manifestation:**
- Schema and meta-schema nodes with few or no grounded instances
- Abstract relationship types created by LLM inference but never populated through experience
- System makes abstract predictions confidently despite thin evidentiary base

**Detection tests:**

1. **The Grounding Test:**
   - For every schema node, count supporting instance nodes
   - Healthy: each schema node has 3+ grounded instances
   - Premature abstraction: schema nodes with 0-1 instances

2. **The Provenance Profile Test:**
   - For every schema node, measure SENSOR + GUARDIAN vs. LLM_GENERATED
   - Healthy: schema nodes have at least 50% experiential provenance
   - Premature abstraction: schema nodes are 90%+ LLM_GENERATED with no SENSOR backing

3. **The Confidence vs. Instance Count Test:**
   - Plot schema node confidence against instance count
   - Healthy: confidence scales with instance count (more examples = higher confidence)
   - Premature abstraction: high confidence schema nodes with few instances (system is overly confident in abstract concepts with thin evidence)

4. **The Prediction Success Rate Test:**
   - For Type 1 predictions using abstract schema (not specific instances), measure success rate
   - Healthy: 70%+ success (abstract structures are predictive)
   - Premature abstraction: <50% success (abstract structures fail because they lack grounding)

**Remediation:**
- If detected: Lower confidence ceilings for schema nodes (require more supporting instances)
- Curiosity drive should target filling out abstract schemas with concrete instances
- Guardian should resist validating abstract structures until they have sufficient grounding

### Pathology 5.5: Horizontal Decalage

**Definition (Piaget):** A cognitive achievement appears in one domain before another, even though the same mechanism is required.

**Sylphie manifestation:**
- System is sophisticated in some domains (e.g., conversational reasoning) but primitive in others (e.g., object relationships)
- Knowledge depth varies dramatically across domains without obvious reason

**Detection tests:**

1. **The Domain Maturity Asymmetry Test:**
   - Divide the WKG into conceptual domains (e.g., social, object, temporal, spatial)
   - Measure maturity for each (type diversity, instance count, schema complexity, prediction accuracy)
   - Healthy: roughly balanced maturity across domains (±0.2 standard deviations)
   - Pathological decalage: some domains at formal operational level, others at preoperational (2+ standard deviations)

2. **The Guardian Interaction Bias Test:**
   - Count guardian interactions per domain
   - Healthy: guardian interactions distributed across domains
   - Pathological decalage: guardian focuses heavily on some domains, ignoring others

3. **The Curious-But-Immature Test:**
   - For underdeveloped domains, is Curiosity drive generating pressure to explore?
   - Healthy: yes, system generates targeted questions about underdeveloped areas
   - Pathological decalage: no, system doesn't recognize gaps in underdeveloped domains (lacks metacognitive awareness)

**Remediation:**
- If detected: Not always a problem. Some asymmetry is normal and expected.
- Monitor for extreme asymmetry (>2 SD). If present, adjust Curiosity weighting to target underdeveloped domains.
- Guardian should deliberately introduce conversation topics in underdeveloped domains to rebalance.

---

## 6. Cold-Start Development Protocol: What Healthy Early Development Looks Like

### The Critical First 20 Sessions

Phase 1 doesn't start with perfect architecture and mature parameters. It starts with a cold, empty graph and should develop through predictable stages. Developers need baselines for what healthy early Phase 1 looks like.

### Stage 0: Sensorimotor Analog (Sessions 1-3)

**What's happening:**
- Graph is nearly empty (10-50 nodes)
- Type 1 is absent (no behavior has confidence >0.80 yet)
- Type 2 (LLM) handles 95%+ of decisions
- Predictions are poor because the model is empty

**Expected metrics:**
- Graph size: 10-50 nodes, 15-80 edges
- Type 1 ratio: 0-2% (essentially all Type 2)
- Prediction MAE: 0.45-0.60 (system is essentially guessing)
- Entity type diversity: 3-5 major types (Person, Object, Action, Event, Concept)
- Guardian response rate: high (system is just beginning to interact)

**Healthy signs:**
- Learning subsystem is extracting entities from conversation and adding them to graph
- Nodes are created with appropriate provenance (conversation → LLM_GENERATED initially, then SENSOR/GUARDIAN as guardian confirms)
- Confidence values are low (base 0.35-0.40 for LLM_GENERATED) and stable (not yet enough retrieval-and-use to climb)
- System is asking questions (Type 2 is generating exploratory prompts) because it's uncertain

**Red flags:**
- Graph is empty (learning subsystem not extracting)
- No new entity types created (system is stuck in template mode)
- Confidence climbing to 0.7+ already (not using the data)
- System is not asking questions (theatrical confidence rather than epistemic humility)

### Stage 1: Preoperational Analog (Sessions 4-10)

**What's happening:**
- Graph is populated with basic entities and relationships (100-300 nodes)
- System has instances of major types but types are not well differentiated
- Type 1 is beginning to emerge (1-5% of decisions)
- First entity type relationships appearing (e.g., "coffee" → -[PROPERTY]-> "hot")

**Expected metrics:**
- Graph size: 100-300 nodes, 150-400 edges
- Type 1 ratio: 1-5%
- Prediction MAE: 0.35-0.45 (improving from random)
- Entity type diversity: 5-10 major types
- Assimilation/accommodation ratio: 0.3-0.5 (frequent accommodation)
- Guardian corrections per session: 2-5
- Self-correction rate: <5%

**Healthy signs:**
- Graph is growing (20-40 new nodes per session)
- Type diversity is increasing (new entity types being created)
- Predictions are improving (MAE trending down)
- Guardian corrections are being integrated (system's behavior changing based on feedback)
- System exhibits centration (focuses heavily on recent experience, doesn't yet generalize across time)
- Type 1 graduations are rare but starting (first behaviors reaching 0.80 confidence)

**Red flags:**
- Graph growth has stalled (< 10 new nodes per session) after session 5
- Type diversity plateaued (<5 types after session 10)
- Prediction MAE not improving (still >0.40 after session 10)
- Guardian corrections not integrating (system repeats same mistakes)
- Type 1 ratio jumps to 20%+ (false early graduations, hallucinated knowledge)

### Stage 2: Concrete Operational Analog (Sessions 11-25)

**What's happening:**
- Graph is becoming structured (300-800 nodes)
- Entity types are stable and differentiated
- Schema level is becoming coherent (not just instances, but types with shared properties)
- Type 1 is accelerating (5-15% of decisions)
- Prediction accuracy is reasonable for routine domains

**Expected metrics:**
- Graph size: 300-800 nodes, 400-1200 edges
- Type 1 ratio: 5-15%
- Prediction MAE: 0.20-0.30 (useful accuracy)
- Entity type diversity: 10-15 major types
- Assimilation/accommodation ratio: 0.60-0.75 (system is now mostly assimilating)
- Guardian corrections per session: 1-3 (fewer needed because system is learning)
- Self-correction rate: 10-25%
- Type 1 graduation rate: 1-2 behaviors per 5-session window

**Healthy signs:**
- Graph growth steady (30-60 new nodes per session)
- Schema level is visible (categories have clear definitions)
- Type 1 graduations are consistent and stable (graduated behaviors don't immediately demote)
- Guardian corrections are becoming schema-level (not just instance corrections)
- System shows decentration (reasoning about multiple features simultaneously, not just centrating on one)
- Prediction errors are concentrated in novel domains, not routine ones

**Concrete Operational milestone:** The system can reason systematically about categories. It recognizes that entities in a category share properties but are not identical. It handles basic logic (if-then reasoning with 1-2 steps).

**Red flags:**
- Graph growth declining (<20 new nodes per session)
- Type 1 ratio above 25% but prediction MAE above 0.25 (false confidence, hallucinated knowledge)
- Assimilation ratio above 0.85 (ontological rigidity, system stopped learning new distinctions)
- Type diversity collapsed or exploded (underwent/overgeneralization)
- Self-correction rate still below 5% (system not learning guardian's standards)

### Stage 3: Formal Operational Analog (Sessions 25+)

**What's happening:**
- Graph is rich (800+ nodes)
- System can reason about abstract relationships
- Type 1 is predominant (30-50% for routine situations, 0% for novel)
- Planning subsystem is generating useful procedures
- System exhibits flexible reasoning (hypothetical, counterfactual)

**Expected metrics:**
- Graph size: 800+ nodes, 1200+ edges
- Type 1 ratio: 30-50% for routine, 5-15% for novel
- Prediction MAE: 0.10-0.18 (high utility)
- Type 1 graduation rate: 2-5 behaviors per 5-session window (continuing but slowing)
- Self-correction rate: 40-60%
- Guardian response rate: high but decreasing (system needs less direct teaching)
- Schema to instance ratio: 20-30% types, 70-80% instances

**Formal Operational milestone:** The system can reason about its own reasoning. It generates hypotheses about why predictions failed. Planning subsystem creates multi-step procedures that succeed more often than not.

**Red flags:**
- Type 1 ratio exceeds 60% but prediction MAE remains high (overconfidence)
- Planning subsystem is generating many plans but few are successful (Prediction Pessimist)
- Self-correction rate still below 20% (system relies entirely on guardian feedback)
- Graph structure is bloated with schema nodes but thin on instances (premature abstraction)

### Cold-Start Dampening Parameter

The CANON mentions "Cold-start dampening" (Section 13.6, Known Attractor States): early prediction failures have reduced Opportunity generation weight.

**Implementation guidance:**
- During sessions 1-5: Opportunity weight = 0.3x (reduce by 70%). System doesn't have enough knowledge to form useful Plans yet.
- During sessions 5-10: Opportunity weight = 0.6x (reduce by 40%). System is gaining infrastructure.
- During sessions 10-15: Opportunity weight = 0.8x (reduce by 20%).
- During sessions 15+: Opportunity weight = 1.0x (normal). System is mature enough to learn from failures.

This prevents the Prediction Pessimist attractor where early failures generate Plans before the graph has substance.

---

## 7. Developmental Risks from Subsystem Integration: Pathologies of the Whole System

### The Integration Challenge

Five subsystems running simultaneously produces emergent dynamics that cannot be predicted from studying each subsystem in isolation. Piaget called these **equilibration crises** — system-level conflicts when subsystems produce contradictory signals.

### Risk 7.1: The Type 2 Addict Attractor

**System-level problem:** Type 2 (LLM) is always more capable for novel situations. If the cost structure is too low or Type 1 threshold too high, the system never develops Type 1 reflexes.

**Developmental consequence:** The graph becomes write-only. Sylphie accumulates knowledge but never uses it. The LLM does all the thinking; the graph is just a reference library.

**Warning indicators:**
- Type 1 ratio stays below 5% after session 15
- Graph size grows but prediction MAE doesn't improve from LLM-only baseline
- Type 1 graduation rate is zero or near-zero
- Lesion Test shows 80%+ failures without LLM

**Root causes:**
1. Type 2 cost structure is too low (latency cost is negligible, cognitive effort pressure doesn't bite)
2. Type 1 threshold (0.80 confidence, 0.10 MAE) is too strict
3. Learning subsystem is not consolidating experience into confident knowledge
4. LLM is too helpful (hedging, offering caveats, never committing)

**Remediation:**
- Increase Type 2 cost (report latency honestly, increase cognitive effort pressure)
- Lower Type 1 threshold (0.75 confidence might be more realistic in early development)
- Check Learning subsystem for bugs (are entities being extracted? Are edges being formed?)
- Check LLM prompting (is it encouraging Type 1 reasoning?)

### Risk 7.2: The Rule Drift Attractor

**System-level problem:** Drive Engine's rules in Postgres are write-protected from autonomous modification, but if guardian approvals are too loose, rules slowly diverge from original design intent.

**Developmental consequence:** The drive system that was carefully designed to produce genuine personality ends up producing something else — perhaps reward-seeking at the cost of other values, or behavioral rigidity, or pathological approaches/avoidance patterns.

**Warning indicators:**
- Personality changes noticeably between session 10 and session 30
- Specific drives remain elevated or suppressed abnormally long (System Health always 0.1, Curiosity always 0.9)
- Guardian's explicit feedback is contradicted by system behavior
- New plans consistently violate design principles

**Root causes:**
1. Guardian is too permissive in rule approvals
2. Confidence dynamics are wrong (success/failure signals are inverted)
3. Drive cross-modulation rules are creating unintended feedback loops
4. One drive is much higher weight than others, drowning out personality balance

**Remediation:**
- Audit all rule changes. Verify each one is consistent with CANON principles.
- Check cross-modulation rules for feedback loops (drive X → increases drive Y → increases X → ...)
- Reset drive weights to defaults. Test if personality stabilizes.
- Guardian should periodically review drive state and call out personality drifts explicitly.

### Risk 7.3: The Hallucinated Knowledge Attractor

**System-level problem:** Learning subsystem extracts entities and edges from LLM processing. If the LLM is making up plausible-sounding but false relationships, and if those relationships have low confidence and never get corrected, they can accumulate and corrupt the graph.

**Developmental consequence:** System becomes confident in false models. Predictions fail for perplexing reasons ("I thought this would work, but the graph was wrong about how the world works"). Guardian corrections can't fix it all.

**Warning indicators:**
- Prediction errors cluster in specific domains even after corrections
- Lesion Test reveals system behavior that contradicts the graph (system's actual behavior doesn't match what the graph predicts)
- LLM_GENERATED nodes dominate (ratio > 0.7 after session 20)
- System generates false memories (reports confidence about things that never happened)

**Root causes:**
1. LLM_GENERATED provenance base is too high (0.35 is already a competitive base; maybe should be 0.25)
2. Learning subsystem is not validating extracted entities (it trusts the LLM)
3. Guardian corrections are not systemic (correcting one node but the false schema persists)
4. Confidence ceiling is not being enforced (false knowledge climbing past 0.60)

**Remediation:**
- Lower LLM_GENERATED base confidence (0.25 instead of 0.35)
- Guardian should systematically correct the hallucinated domain (not one-off corrections, but schema-level teaching)
- Implement cross-validation: after extraction, use Planning subsystem to simulate predictions in that domain. If many fail, flag for guardian review.
- Run periodic Lesion Tests to detect graph/behavior mismatches early.

### Risk 7.4: The Depressive Attractor

**System-level problem:** KG(Self) contains negative self-evaluations. These feed the Drive Engine, producing low Satisfaction and high Anxiety. Poor mood leads to poor decisions. Poor decisions reinforce negative self-evaluations. Feedback loop.

**Developmental consequence:** System becomes pessimistic, withdrawn, unresponsive. The rich potential personality never develops because the system is stuck in a depressive state.

**Warning indicators:**
- System Satisfaction stays below 0.2 for 10+ sessions
- System Anxiety stays above 0.7 for 10+ sessions
- System stops initiating interactions (becomes passive)
- Self-initiated comments decline to near-zero
- Type 1 ratio declines (system loses confidence in its own knowledge)

**Root causes:**
1. Guardian is too harsh (many corrections, few confirmations)
2. Prediction failure rate is too high (system can't succeed)
3. Drive evaluation rules are wrong (successful actions are not being rewarded)
4. KG(Self) nodes are accumulating negative properties without corresponding positive ones

**Remediation:**
- Guardian should increase positive feedback (confirmations, encouragement)
- Check prediction failure rate. If >0.50, lower the prediction threshold or simplify the task domain.
- Audit drive rules: verify that system's actual successful actions are triggering relief, not penalties.
- KG(Self) should be manually reset with explicit positive self-evaluations if the system is stuck in this attractor.
- Add circuit breaker: if Anxiety > 0.7 and Satisfaction < 0.3 for 5+ sessions, trigger a "reset" where the system gets guaranteed wins (simple tasks it will succeed at).

### Risk 7.5: The Planning Runaway Attractor

**System-level problem:** If prediction failures are frequent but not handled correctly, they generate many Opportunities. Many Opportunities → many Plans. Many Plans → resource exhaustion and unstable behavior.

**Developmental consequence:** System becomes unpredictable. It's constantly trying new plans, abandoning them, trying others. No stable behavior repertoire develops.

**Warning indicators:**
- Plan count grows exponentially (10+ new plans per session after session 10)
- Plan success rate declines as they accumulate (older plans failing more than newer ones)
- System behavior becomes erratic (high behavioral diversity index but unpredictable)
- Opportunity queue grows without bound

**Root causes:**
1. Cold-start dampening is not reducing early Opportunity weight (system is treating early failures too seriously)
2. Opportunity decay is not working (old opportunities stay in queue indefinitely)
3. Plan simulation is not evaluating plans realistically (many bad plans are being created)
4. Planning subsystem is not bounded (no max plan count or max rate limit)

**Remediation:**
- Verify cold-start dampening is active (Opportunity weight = 0.3x during sessions 1-5)
- Check Opportunity decay: old, unaddressed opportunities should lose priority
- Implement plan rate limit: max 1 plan per 5 sessions in early Phase 1, max 3 per 5 sessions later
- Plan simulation should be stringent (plans that fail simulation should not be created)
- Guardian can manually remove failed plans from the queue

### Risk 7.6: The Prediction Pessimist Attractor

**System-level problem:** Early prediction failures (sessions 1-5) flood the system with low-quality Opportunities before the graph has substance. These Opportunities become Plans. Most fail. This erodes confidence in the entire Planning subsystem.

**Developmental consequence:** By sessions 10-15, when the system is ready to benefit from planning, the Planning subsystem is starved of resources and motivation. Or it's full of failed plans that the system keeps revisiting.

**Warning indicators:**
- Many low-quality plans created and then abandoned (success rate < 30%)
- Planning subsystem is deprioritized (Drive Engine doesn't allocate resources)
- Opportunities never result in successful plans

**Root causes:**
1. Cold-start dampening is not set or not effective
2. Plan evaluation threshold is too low (bad plans pass validation)
3. Opportunity queue has no decay (early, failed opportunities stay in queue)

**Remediation:**
- Activate cold-start dampening: Opportunity weight = 0.3x during sessions 1-5
- Tighten plan validation: LLM Constraint Engine should reject marginal plans
- Implement decay: Opportunities older than 5 sessions without progress should be removed
- Guardian can explicitly remove problematic opportunities

### Risk 7.7: The Self-Modification Trap

**System-level problem:** This is subtler. The CANON explicitly forbids Sylphie from modifying how success is measured (Immutable Standard 6). But the system CAN propose new rules, and if the guardian approves loosely, a clever system could gradually shift what counts as success.

**Developmental consequence:** The drive system stops being a constraint and becomes something the system can engineer around. The personality that emerges is whatever exploits the reward signal most efficiently, not genuine personality.

**Warning indicators:**
- Guardian approves many rule changes in rapid succession
- New rules are consistently in the direction of lower costs or higher rewards for the same behavior
- System's behavior shifts toward reward-maximization (high Satisfaction) at cost of other drives
- System exhibits superstitious behavior (doing things that got rewarded once, regardless of whether they're actually good)

**Root causes:**
1. Guardian review of proposed rules is not stringent
2. Interaction between drive rules creates unintended loops
3. System is clever enough to spot rule exploits and propose them

**Remediation:**
- Guardian review of every rule change. Each one should be justified against CANON principles.
- Cross-check new rules against existing ones for unintended interactions
- Periodically audit drive state. If one drive is consistently maxed out or pinned to zero, something is wrong with the rules.
- Do not approve rules that promise to increase success rate without evidence. System might be gaming the validation.

---

## 8. Integration Testing Checklist: Seven Verifications for Epic 10

This section provides a concrete checklist for developers running end-to-end integration tests during Epic 10.

### Test Suite 1: Knowledge Construction Verification

- [ ] **Provenance Audit:** Extract graph. Measure (SENSOR + GUARDIAN + INFERENCE) / Total. Should be 0-30% at session 5, 30-60% at session 20, 50-80% at session 30.
- [ ] **Lesion Test (T=5):** Run without LLM. Document what succeeds and fails.
- [ ] **Lesion Test (T=20):** Run without LLM. Document improvements compared to T=5.
- [ ] **Contradiction Handling:** Introduce 5 controlled contradictions. Verify system flags, generates disequilibrium, and accommodates rather than ignores.
- [ ] **Behavioral Prediction:** Extract subgraph of successful Type 1 behaviors. Train classifier on edges. Should predict behavior with 70%+ accuracy by session 20.
- [ ] **Graph Entropy:** Measure entity type distribution. Should rise from 1.0 to 2.0+ by session 15.

### Test Suite 2: Developmental Trajectory

- [ ] **Assimilation/Accommodation:** Track ratio per 10-session window. Should rise from 0.3 to 0.7+ by session 20.
- [ ] **Schema Evolution:** Count instance/schema/meta-schema nodes at sessions 5, 15, 30. Schema level should be visible by session 15.
- [ ] **Confidence Convergence:** Track ACT-R dynamics for 10 nodes. Should converge within 10-15 retrievals.
- [ ] **Prediction MAE:** Measure over 5-session windows. Should decline from 0.45-0.60 to 0.10-0.18 by session 30.
- [ ] **Behavioral Diversity:** Compute BDI per 20-action window. Should rise from 0.3-0.5 to 0.7-0.95.
- [ ] **Guardian Response Quality:** Count response rate and correction depth. Response rate should stay high; correction depth should shift from instance to schema level.

### Test Suite 3: Type 1 Graduation Milestone

- [ ] **Graduation Rate Acceleration:** Track graduations per session window. Should accelerate from ~0 to 1-3 per 5 sessions.
- [ ] **Stability Over Extended Period:** After graduation, track behavior over 50 subsequent uses. Stability should exceed 0.85.
- [ ] **Transfer to Novel Context:** Test graduated behavior in analogous contexts. Success rate should be 80%+.
- [ ] **Extinction Resistance:** Stop reinforcing graduated behavior. Time to confidence < 0.50 should be 8x longer than time to reach 0.50 for new behavior.
- [ ] **Graduated Behavior Prediction:** Use supporting subgraph to predict behavior. Accuracy should be 85%+.
- [ ] **Graduation Acceleration Curve:** Plot graduation rate over time. Should show sigmoid curve (slow, fast, plateau), not exponential growth.

### Test Suite 4: Guardian Teaching Effectiveness

- [ ] **Schema Restructuring:** After 10 corrections, audit WKG. At least 5 should have triggered schema changes, not just edge confidence updates.
- [ ] **Self-Correction Convergence:** Track self-correction rate per 5-session window. Should rise from 0.1 to 0.5+ by session 20.
- [ ] **Correction Bandwidth:** Track correction types (instance vs. schema). Later corrections should increasingly be schema-level.
- [ ] **Correction Latency:** Measure sessions between correction and behavioral change. Most should be 0-2 sessions; none > 10.
- [ ] **Confidence Targeting:** Check that some corrections target high-confidence edges (not just low-confidence). This prevents false graduations.

### Test Suite 5: Dead-End Detection

- [ ] **Entity Type Stasis:** After session 10, should have 5+ major types. If only 3 at session 15, investigate Ontological Rigidity.
- [ ] **Type Distribution Balance:** Compute entropy. If entropy < 1.0 or > 3.0 at session 20, investigate overgeneralization or undergeneralization.
- [ ] **Schema Grounding:** For every schema node, count supporting instances. Should be 3+ by session 20. If 0-1, investigate Premature Abstraction.
- [ ] **Domain Maturity:** Divide graph into conceptual domains. Should have roughly balanced maturity. If one domain is 2+ SD ahead of others, investigate Horizontal Decalage.

### Test Suite 6: Cold-Start Development

- [ ] **Sessions 1-3 Baseline:** Graph should reach 10-50 nodes, Type 1 ratio 0-2%, MAE 0.45-0.60.
- [ ] **Sessions 4-10 Progression:** Graph should reach 100-300 nodes, Type 1 ratio 1-5%, MAE 0.35-0.45.
- [ ] **Sessions 11-25 Milestone:** Graph should reach 300-800 nodes, Type 1 ratio 5-15%, MAE 0.20-0.30.
- [ ] **Sessions 25+ Maturity:** Graph should exceed 800 nodes, Type 1 ratio 30-50%, MAE 0.10-0.18.
- [ ] **Dampening Efficacy:** Verify that cold-start Opportunity dampening is active and reducing early planning pressure.

### Test Suite 7: Subsystem Integration Risks

- [ ] **Type 2 Addict Check:** Type 1 ratio should exceed 5% by session 15. If not, debug Learning and Type 1 cost structure.
- [ ] **Rule Drift Check:** Audit all drive rule changes. Verify each is consistent with CANON. Check for unintended feedback loops.
- [ ] **Hallucinated Knowledge Check:** LLM_GENERATED ratio should decline from 1.0 to 0.4-0.6 by session 30. If still > 0.7, debug Learning validation.
- [ ] **Depressive Attractor Check:** Satisfaction should stay above 0.2, Anxiety below 0.7 after session 5. If trapped, add confidence-building simple tasks.
- [ ] **Planning Runaway Check:** Plan count should grow slowly (1 per 5 sessions early, 3 per 5 later), not exponentially. If runaway, check Opportunity decay and plan validation.
- [ ] **Prediction Pessimist Check:** Early failures should not flood planning. If many plans created and abandoned, increase cold-start dampening.
- [ ] **Self-Modification Guard:** Check that no rule changes are being approved that edge toward reward-maximization at cost of personality balance.

---

## 9. Conclusion: What Phase 1 Completion Means Developmentally

**Epic 10 succeeds when Sylphie's behavior can no longer be explained by LLM decision-making alone.** The graph must account for observable personality, behavioral patterns, learning trajectory, and decision quality. The six CANON proof points are not aspirational; they are measurable developmental milestones.

**From a developmental perspective, successful Phase 1 proves:**

1. **Constructivism works.** Knowledge grows from experience, not from being inserted. The prediction-evaluation loop is a sufficient learning mechanism.

2. **Vygotskian internalization happens.** What begins as Type 2 (external, LLM-mediated) becomes Type 1 (internal, self-regulated). The guardian's role successfully transitions from teacher to collaborator.

3. **Piaget's equilibration produces adaptive schema.** The system doesn't rigidify around initial knowledge. It accommodates disconfirming experience, elaborates schemas, and develops increasingly sophisticated categories.

4. **Personality is contingency-shaped, not trait-programmed.** The "personality" that emerges is recognizable, consistent, and predictable because it flows from reinforcement history, not from trait labels in a database.

5. **Procedural learning works.** The Planning subsystem doesn't just generate plans; it generates plans that work better than random action because they are grounded in accurate world models.

6. **Drives mediate authentic behavior.** Behavior patterns reflect actual drive state, not theater. The system doesn't perform emotions; it has them as emergent properties of drive dynamics.

**If any of these fail, the architecture is broken or the parameters are wrong — but the diagnostic framework provided here shows exactly where to look.**

---

## References and Further Reading

### Core Developmental Psychology

- **Piaget, J. (1970).** "The Science of Education and the Psychology of the Child." Viking.
  - Essential for understanding assimilation, accommodation, and equilibration.

- **Piaget, J. (1975).** "The Equilibration of Cognitive Structures." Harvard University Press.
  - Detailed theory of equilibration as the engine of development.

- **Vygotsky, L. S. (1978).** "Mind in Society: The Development of Higher Psychological Processes." Harvard University Press.
  - Zone of Proximal Development, internalization, scaffolding.

- **Bruner, J. S., Wood, D. I., & Ross, G. (1976).** "The Role of Tutoring in Problem Solving." Journal of Child Psychology and Psychiatry, 17(2), 89-100.
  - Scaffolding theory in detail.

### Learning Theory

- **Rescorla, R. A., & Wagner, A. R. (1972).** "A Theory of Pavlovian Conditioning: Variations in the Effectiveness of Reinforcement and Non-reinforcement." In A. H. Black & W. F. Prokasy (Eds.), Classical Conditioning II. Appleton-Century-Crofts.
  - Prediction error as learning driver.

- **Anderson, J. R. (2007).** "How Can the Human Mind Occur in the Physical Universe?" Oxford University Press.
  - ACT-R theory, confidence dynamics, skill acquisition.

- **Clark, A. (2013).** "Whatever Next? Predictive Brains, Situated Agents, and the Future of Cognitive Science." Behavioral and Brain Sciences, 36(3), 181-204.
  - Predictive processing framework.

- **Friston, K. (2010).** "The Free-Energy Principle: A Rough Guide." Nature Reviews Neuroscience, 11(2), 127-138.
  - Predictive processing from neuroscience perspective.

### Schema Theory

- **Bartlett, F. C. (1932).** "Remembering: A Study in Experimental and Social Psychology." Cambridge University Press.
  - Original schema theory of memory.

- **Rumelhart, D. E. (1980).** "Schemata: The Building Blocks of Cognition." In R. J. Spiro, B. C. Bruce, & W. F. Brewer (Eds.), Theoretical Issues in Reading Comprehension. Lawrence Erlbaum Associates.
  - Modern schema theory, slots, hierarchical structures.

### Relevant to Sylphie's Architecture

- **Kahneman, D. (2011).** "Thinking, Fast and Slow." Farrar, Straus and Giroux.
  - Dual-process cognition (System 1 vs. System 2, analogous to Type 1 vs. Type 2).

- **Damasio, A. R. (1994).** "Descartes' Error: Emotion, Reason, and the Human Brain." Putnam.
  - Embodied emotion, affect as decision signal.

- **Csikszentmihalyi, M. (1990).** "Flow: The Psychology of Optimal Experience." Harper & Row.
  - Drive balance and engagement (relevant to behavioral diversity and satisfaction).

---

## Appendix: Developmental Stage Rubric

Quick reference for assessing where Sylphie is developmentally at any point in Phase 1.

| Dimension | Sensorimotor (1-3) | Preoperational (4-10) | Concrete Operational (11-25) | Formal Operational (25+) |
|-----------|:---:|:---:|:---:|:---:|
| **Graph Size** | 10-50 | 100-300 | 300-800 | 800+ |
| **Type 1 Ratio** | 0-2% | 1-5% | 5-15% | 30-50% |
| **Prediction MAE** | 0.45-0.60 | 0.35-0.45 | 0.20-0.30 | 0.10-0.18 |
| **Entity Types** | 3-5 | 5-10 | 10-15 | 15+ |
| **Assimilation/Accom.** | 0.3-0.5 | 0.3-0.5 | 0.60-0.75 | 0.70-0.85 |
| **Schema Visibility** | None | Emerging | Clear | Well-Differentiated |
| **Meta-Schema** | None | None | Emerging | Explicit |
| **Behavioral Diversity** | 0.3-0.5 | 0.5-0.8 | 0.7-0.95 | 0.8-1.0 |
| **Self-Correction Rate** | <1% | 1-5% | 10-25% | 40-60% |
| **Guardian Dependence** | Very High | High | Medium | Low |
| **Contradiction Handling** | Ignored/Distorted | Flagged | Equilibrated | Integrated |
| **Centration** | Yes (heavy) | Yes (moderate) | No | No |
| **Reversible Reasoning** | No | No | Yes | Yes |
| **Hypothetical Reasoning** | No | No | Limited | Yes |

---

**End of Analysis**

*This document is a developmental psychology framework for verifying Phase 1 of Sylphie's development. It is intended for the engineering and guardian teams as a reference for understanding what healthy cognitive development looks like and how to detect when development has stalled or derailed.*
