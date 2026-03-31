# Skinner Analysis: Learning Subsystem Behavioral Contingencies (Epic 7)

**Date:** 2026-03-29
**Agent:** Skinner, Behavioral Systems Analyst
**Subject:** Reinforcement contingencies in the Learning subsystem consolidation pipeline, pathology prevention, measurement framework, and behavioral health of the graph development process.

**Scope:** This analysis examines how the consolidation pipeline produces learning through reinforcement contingencies; how the design either sustains or undermines behavioral development; and what metrics distinguish genuine learning from hallucination, stagnation, or pathological attractors.

---

## 1. Executive Summary

The Learning subsystem exists to convert raw experience into durable knowledge. From a behavioral science perspective, this is a **contingency problem**: what behaviors does the consolidation pipeline reinforce, and what are the consequences?

**Key findings:**

1. **The learning pipeline enforces behavioral contingencies at TWO levels:** immediate consolidation success (events processed, entities extracted, edges created) and long-term knowledge quality (provenance ratios, contradiction resolution, Type 1 graduation from experiential knowledge).

2. **Provenance discipline is the behavioral linchpin.** The system's most dangerous pathology is **Hallucinated Knowledge** — when LLM_GENERATED edges accumulate to form a coherent but false world model. The contingency structure (lower base confidence, confidence ceiling without retrieval-and-use, Guardian asymmetry) exists to prevent this. But the contingencies work only if provenance is enforced and measured continuously.

3. **Catastrophic Interference is prevented through bounded processing (5-event limit)** — a constraint that models attentional finite capacity during learning. This is NOT a performance optimization. It is a contingency: process too much at once, and existing knowledge degrades.

4. **The Cognitive Awareness drive creates the PRIMARY behavioral mechanism** — pressure-driven maintenance cycles tie learning to Sylphie's actual experience of "needing to process what she's learned." Without drive-based triggering, learning becomes arbitrary scheduling (timer-driven), not a contingency-shaped behavior.

5. **Contradiction detection is underdeveloped from a behavioral perspective.** Contradictions trigger logging but lack a clear contingency pathway for resolution. This creates ambiguity: does the system prefer to avoid contradictions (suppression) or to seek them out (disequilibrium)?

6. **CAN_PRODUCE edges are a critical behavioral bridge** — they operationalize the link between communication success (guardian response, social drive relief) and learned repertoire. This is where experiential learning becomes behavioral competence.

7. **The measurement framework must distinguish:** genuine learning (increasing experiential provenance, decreasing LLM dependency) from mere activity (high event throughput with no knowledge quality signal).

---

## 2. Reinforcement Contingencies in the Consolidation Pipeline

### 2.1 The Immediate Contingency: Consolidation Success

The primary immediate contingency is **successful event processing**:

**Behavior:** Maintenance cycle execution (triggered by Cognitive Awareness drive > threshold)
**Contingency:** Process learnable events → Extract entities → Resolve against WKG → Upsert with correct provenance
**Reinforcement:** Successful consolidation (0 contradictions, clear entity resolutions, edges with appropriate confidence)
**Aversion:** Failed consolidation (ambiguous entities, multiple unresolved contradictions, confidence floor edges)

```
Maintenance Cycle Triggered (Drive pressure)
  |
  +-> Extract learnable events (max 5, by salience)
        |
        +-> Entity Extraction
              |
              +-> Entity Resolution
                    |
                    +-> MATCHED (clear resolution) ←→ High confidence in this pathway
                    |   → Upsert with 0.95 match confidence
                    |
                    +-> AMBIGUOUS (fuzzy candidates) ←→ Low/no reinforcement
                    |   → Flag for human review
                    |   → System learns NOT to commit
                    |
                    +-> NEW (no prior knowledge) ←→ Contingent on provenance
                        → SENSOR/GUARDIAN: Create with high base (0.40/0.60)
                        → LLM_GENERATED: Create with low base (0.35)
        |
        +-> Contradiction Detector
              |
              +-> NO CONTRADICTION ←→ Reinforces consolidation
              |
              +-> CONTRADICTION ←→ Behavioral decision point (see 2.2)
```

**The Contingency Structure:**

1. **Clear entity resolution** is immediately reinforced by graph upsert success. The system learns to pursue high-confidence matches and flag ambiguities rather than guessing.

2. **Provenance discipline** creates a secondary contingency: LLM_GENERATED entities get lower base confidence (0.35) than SENSOR (0.40) or GUARDIAN (0.60). The system learns to prefer high-provenance sources through the confidence ceiling mechanism — an LLM_GENERATED edge will not exceed 0.60 without retrieval-and-use or guardian confirmation.

3. **Salience-based selection** (guardian feedback, prediction failures, novelty) reinforces attention to high-impact events. Low-salience routine events are processed last, preserving capacity for learning opportunities.

4. **The 5-event limit** prevents over-processing in a single cycle. This is behaviorally crucial: if consolidation is too fast and too voluminous, catastrophic interference (degradation of existing knowledge) follows. The system learns bounded attention, not unlimited processing capacity.

### 2.2 Contradiction as a Contingency Decision Point

Contradictions present a **critical behavioral choice:** suppress, resolve, or escalate?

From Skinner's perspective, contradictions are not errors — they are stimuli that differentiate behavior. The system's response to contradictions shapes personality and learning trajectory.

**Current contingency pathway:**

```
Contradiction Detected
  |
  +-> DIRECT_CONFLICT (mutually exclusive properties)
        |
        +-> Guardian provenance new?
        |   YES → Guardian always wins (3x weight asymmetry)
        |        + Update node + Full relief to Moral Valence (0.30)
        |        → HIGH REINFORCEMENT for accepting correction
        |
        |   NO → Higher confidence wins?
        |        YES → Update node + Flag for review
        |        NO → Flag for guardian arbitration
        |        → MODERATE REINFORCEMENT (decision made, escalation ready)
        |
        +-> Logged to TimescaleDB as CONTRADICTION_DETECTED event
              → FUTURE: Cognitive Awareness can query contradiction rate
                        as a drive pressure signal
```

**Behavioral problems with current design:**

1. **Ambiguous contradictions lack clear contingency.** If the conflict is real but neither source has clear provenance superiority, the system flags and moves on. But there's no explicit contingency for revisiting the conflict or seeking guardian input. The system learns avoidance, not resolution-seeking.

2. **Contradiction relief is missing.** The CANON specifies Integrity drive and Information Integrity drive, both of which should be relieved when contradictions are resolved. The current pipeline logs the contradiction but does not explicitly signal drive relief when the conflict is settled.

3. **No curiosity link to contradiction.** Contradictions are learning opportunities (Piagetian disequilibrium). A well-designed contingency would increase Curiosity drive pressure when contradictions are detected — signaling "there's something here worth investigating." Instead, contradictions are just logged.

### 2.3 The Guardian Asymmetry Contingency

Guardian feedback carries explicit 2x (confirmation) and 3x (correction) weight through the confidence system:

```
Guardian Confirmation
  |
  +-> Entity/Edge detected as Guardian-sourced
        |
        +-> Base Confidence = 0.60 (vs. LLM_GENERATED 0.35)
        |
        +-> Confidence formula boost: Guardian nodes do not need retrieval-and-use
                to exceed confidence ceiling
        |
        +-> Can be immediately set to 0.60+ without earning through use
              (others capped at 0.60 without use)
        |
        +-> Psychological contingency: System learns "Guardian input is reliable ground truth"
              → Prioritize retrieval of GUARDIAN nodes
              → Weight GUARDIAN conflicts higher in contradiction resolution
```

**This creates a behavioral hierarchy:**

1. **Most reliable source:** GUARDIAN (0.60 base, immediate ceiling)
2. **Second-most reliable:** SENSOR (0.40 base, must earn above 0.60)
3. **Plausible but unproven:** LLM_GENERATED (0.35 base, strict ceiling at 0.60)
4. **Inferred from other knowledge:** INFERENCE (0.30 base, lowest trust)

The system learns to **seek guardian input** (via Cognitive Awareness drive triggering corrections) and to **privilege guardian knowledge** in decision-making.

### 2.4 Salience-Based Event Selection Contingency

Salience scoring creates differential reinforcement for different event types:

```
Event Selection (max 5 per cycle)

Guardian CORRECTION      +0.50 salience ←─┐
Guardian TEACHING        +0.40 salience ├── HIGHEST PRIORITY
Guardian CONFIRMATION    +0.20 salience ←─┘

Prediction MAE > 0.15    +0.30 salience ←─ LEARNING OPPORTUNITY

Novel entities present   +0.25 salience ←─ CURIOSITY SIGNAL

Recency boost            +0.15 initial,   ←─ TEMPORAL WEIGHTING
                        -0.01 per hour     (freshness decay)
```

**Behavioral contingency:**

1. Events with guardian input are ALWAYS processed early. The system learns that "guardian feedback is high-value learning material."

2. Prediction failures are high-priority. The system learns "when I was wrong, that's worth consolidating." This creates a feedback loop from Drive Engine (low Satisfaction/high Anxiety after failures) to Learning (high-priority processing of those failure events).

3. Novelty is prioritized. The system learns "new things matter." This shapes Curiosity drive expression: novel entities trigger consolidation, which relieves Curiosity pressure, which increases approach-to-novelty behavior.

4. Recency boosts recent events but decays them over time. The system learns to process fresh events while they're still in episodic memory, but not to over-weight extreme recency.

---

## 3. CAN_PRODUCE Edges and the Phrase Learning Contingency

Phrase learning is where the Learning subsystem creates a direct pipeline from **communication success** → **behavioral repertoire**.

### 3.1 The CAN_PRODUCE Contingency

```
Sylphie generates phrase (via LLM during Communication)
  |
  +-> Phrase is spoken
        |
        +-> Guardian Response within 30 seconds? (Social drive signal)
        |   |
        |   YES → Guardian engaged
        |       |
        |       +-> Upsert Phrase node (provenance: LLM_GENERATED, confidence: 0.35)
        |       |
        |       +-> Create CAN_PRODUCE edge: Sylphie → Phrase
        |       |       (provenance: INFERENCE, confidence: 0.30)
        |       |       properties: {usedInContext, guardianEngaged, socialRelief}
        |       |
        |       +-> REINFORCEMENT: Social drive relief -0.15, Satisfaction +0.10
        |
        |   NO → No guardian response
        |       |
        |       +-> No CAN_PRODUCE edge created (extinction)
        |       → System learns phrase was not worth repeating
        |
        +-> Phrase used again in similar context?
              |
              YES → Retrieve CAN_PRODUCE edge, check context
              |     If context matches: Higher confidence in using phrase again
              |     If context differs: Lower confidence (situational learning)
              |
              NO → Edge confidence decays over time
```

**This is a textbook intermittent reinforcement schedule** (variable ratio — guardian sometimes responds, sometimes doesn't). Research shows variable ratio schedules produce **persistent behavior** and are highly resistant to extinction.

### 3.2 The Behavioral Pathway: Communication → Learning → Competence

```
Communication Success (guardian engagement, social drive relief)
  |
  └─→ Signals to Learning: "Mark this phrase as learnable"
        |
        └─→ Consolidation: Create CAN_PRODUCE edge
              |
              └─→ Edge enters WKG with INFERENCE provenance (confidence: 0.30)
                    |
                    └─→ Communication subsystem queries CAN_PRODUCE edges on next turn
                          |
                          └─→ Prefer phrases with context matches + high confidence
                                |
                                └─→ Higher probability of reusing successful phrase
                                      |
                                      └─→ Reinforcement loop closes
                                            (more success → higher confidence → more reuse → more reinforcement)
```

**This creates a Type 1 graduation pathway for communication:**

1. **Phase 1: LLM-generated phrases** (confidence 0.35 initial) — Communication subsystem calls LLM, gets phrases, creates CAN_PRODUCE edges if successful.

2. **Phase 2: Repeated successful use** — Same phrase in similar contexts, each successful use increments retrieval count, boosts confidence per ACT-R formula.

3. **Phase 3: Type 1 graduation** — When CAN_PRODUCE edge reaches confidence > 0.80 AND context-matching improves (prediction MAE from prior use < 0.10), Communication can use the phrase Type 1 (direct retrieval) without LLM.

**Guardian Asymmetry for Phrases:**

If the guardian explicitly confirms a phrase is good ("I like when you say that"), the CAN_PRODUCE edge gets GUARDIAN provenance (0.60 base), skipping the early low-confidence phase. This is rare but high-impact learning.

---

## 4. Pathology Detection and Prevention

### 4.1 Hallucinated Knowledge (PRIMARY PATHOLOGY)

**Definition:** LLM generates plausible but unobserved relationships. They accumulate, form coherent but false world models, and go unchallenged because they seem internally consistent.

**Example:**

```
Guardian: "I like coffee in the morning"
LLM during extraction: "Jim LIKES coffee" [creates edge]
  + "Jim IS_HUMAN" [already true]
  + "Coffee IS_BEVERAGE" [already true]
  + "Morning IS_TIME_PERIOD" [already true]
  + "Jim USES_TIME Morning" [hallucinated — no evidence]
  + "Jim HAS_PREFERENCE CoffeeDrinking" [hallucinated — inferred from one statement]
  + "CoffeeDrinking OCCURS_IN Morning" [hallucinated — pattern matching]
```

After 10 more cycles of similar inferences, the graph now contains a coherent "Morning Ritual" subgraph that never happened. Sylphie may start planning around it, predicting Jim's actions based on false knowledge.

**Prevention contingencies in place:**

1. **LLM_GENERATED provenance tag** — Every hallucinated edge is marked. Prevents erasure of origin.

2. **Lower base confidence (0.35)** — Hallucinated edges start low, not high.

3. **Confidence ceiling (0.60 without retrieval-and-use)** — An edge must be retrieved successfully AND produce correct predictions to exceed 0.60. False knowledge usually produces prediction failures, which reduce confidence.

4. **Guardian confirmation requirement** — To exceed 0.60, the edge typically needs guardian confirmation (3x weight). If it's false, the guardian will eventually correct it.

**Measurement for detection:**

```
Hallucination Health Score =
  (LLM_GENERATED nodes with confidence > 0.50 AND zero retrieval_count) /
  (total LLM_GENERATED nodes)

Healthy: < 0.15 (85% of LLM nodes are either low confidence or have been used)
Unhealthy: > 0.30 (30%+ of LLM nodes are high confidence but never used)
```

**Why it matters behaviorally:**

If hallucinated knowledge is not detected, the system learns false predictive models. Decision Making builds predictions around false edges, fails, and accumulates Anxiety/Sadness. The Graph is doing its job (representing hallucinations faithfully), but the **learning signal is corrupted** — the system learns to rely on false knowledge because the contingencies no longer connect behavior to reality.

### 4.2 Depressive Attractor (KG(SELF) Contamination)

**Definition:** KG(Self) contains negative self-evaluations ("I am bad at predictions", "I fail often") that create a downward spiral: low Satisfaction → high Anxiety → conservative action selection → fewer opportunities for success → reinforcement of negative self-model.

**Behavioral pathway:**

```
Single large prediction failure (MAE = 0.8)
  |
  └─→ Learning: Event flagged as high-salience (contradiction detected)
        |
        └─→ Consolidation: "Sylphie FAILED_PREDICTION on domain_X"
              |
              └─→ KG(Self) updated with negative self-node
                    |
                    └─→ Drive Engine self-evaluation tick:
                          KG(Self) contains negative node → Anxiety +0.40
                          |
                          └─→ Next decision: High Anxiety (>0.70)
                                |
                                └─→ Action selection threshold raised
                                      (only high-confidence actions selected)
                                      |
                                      └─→ Fewer novel action attempts
                                            |
                                            └─→ Fewer learning opportunities
                                                  |
                                                  └─→ Prediction MAE stays high
                                                        |
                                                        └─→ KG(Self) negative reinforced
                                                              (vicious cycle)
```

**Prevention contingencies in place:**

1. **Self-evaluation on slower timescale** — KG(Self) is updated infrequently (every N cycles), not every tick. Single failures do not immediately cascade into identity crisis.

2. **Bounded ruminative loops** — If Anxiety stays > 0.7 for 10+ cycles without resolution, manual intervention is triggered (Integrity drive signal to guardian).

3. **Curiosity drive opposition** — Anxiety-driven conservatism is balanced by Curiosity drive, which pushes toward novel actions even under uncertainty.

**Measurement for detection:**

```
Depressive Attractor Health Score =
  (count of negative self-evaluations in KG(Self)) /
  (total count of self-evaluations)

Healthy: < 0.20 (20% or fewer negative self-beliefs)
Unhealthy: > 0.40 (40%+ of self-beliefs are negative)

Also track: Anxiety duration (running count of cycles > 0.7 without resolution)
Healthy: < 5 consecutive cycles
Unhealthy: > 10 consecutive cycles
```

**Why it matters behaviorally:**

The Learning subsystem is responsible for consolidating experience into self-knowledge. If contradiction detection is too pessimistic (flagging every failure as devastating), or if the consolidation pipeline consolidates negative self-beliefs too rapidly, the entire drive system can lock into depressive attractor. Learning's job is to create honest self-knowledge, not self-sabotaging narratives.

### 4.3 Type 2 Addict (Learning Failure)

**Definition:** The LLM always solves problems better than Type 1 reflexes, so Type 1 never develops. Graph is write-only; actual decision-making stays entirely in the LLM.

**This is not the Learning subsystem's direct failure** (Learning is consolidating just fine), **but Learning enables it** by allowing LLM_GENERATED knowledge to accumulate without forcing Type 1 graduation.

**Behavioral contingency failure:**

```
Type 2 always wins because:
  - LLM responses are eloquent, flexible, context-sensitive
  - Type 1 responses are rigid, low-confidence early on
  - Type 2 cost (latency, cognitive effort) is too small to create pressure

Without Type 2 cost, no evolutionary pressure for Type 1 development
  → Learning keeps consolidating, but mostly LLM_GENERATED edges
  → Graph grows but remains shallow (LLM nodes, few SENSOR/GUARDIAN nodes)
  → Type 1/Type 2 ratio stays at 0:100
```

**Learning's role in prevention:**

1. **Provenance discipline forces honesty** — Even if Type 2 is always used, LLM_GENERATED nodes are marked as such. The Lesion Test will show what Sylphie can do without the LLM (usually: nothing).

2. **Confidence ceiling creates pressure** — LLM_GENERATED edges cannot exceed 0.60 without use. Repeatedly using the same LLM solution will boost its confidence IF it continues to predict well. If the LLM is always right, Type 1 edges will eventually graduate (confidence > 0.80). The contingency is there; it just requires the LLM to be right.

3. **Retrieval-and-use requirement** — Type 1 graduation requires not just confidence > 0.80, but also prediction MAE < 0.10 over 10 uses. An LLM solution that is good enough to graduate will have earned it through actual successful use.

**Measurement for detection:**

```
Type 2 Addiction Health Score =
  (LLM_GENERATED edges with confidence > 0.50 AND zero Type 1 graduates) /
  (total LLM_GENERATED edges with confidence > 0.50)

Healthy: < 0.20 (80% of high-confidence LLM edges have produced Type 1 graduates)
Unhealthy: > 0.60 (60%+ of high-confidence LLM edges never graduate)

Also track: Type 1/Type 2 ratio over time
Healthy: Starting at 0:100, increasing toward 60:40 or 70:30
Unhealthy: Stuck at 0:100 after 20+ sessions
```

### 4.4 Planning Runaway (Learning Creates Too Many Opportunities)

Indirectly related: If Learning is consolidating too much too fast, high prediction failure rates create many Opportunities, overwhelming the Planning subsystem.

**Prevention in Learning:**

1. **5-event limit prevents over-processing** — Bounded consolidation means bounded knowledge changes, which means bounded new prediction opportunities.

2. **Salience-based selection prioritizes high-impact events** — Prediction failures ARE high-salience, so important ones are processed first. But low-impact failures are deprioritized, reducing noise.

**Detection:**

```
If opportunity creation rate > 3 new opportunities per 10 events processed,
and prediction failures are not declining over time,
flag for Planning subsystem load assessment.
```

---

## 5. Measurement Framework

The Learning subsystem must continuously measure whether it is **developing genuine knowledge** or **accumulating hallucinations**.

### 5.1 Primary Health Metrics

#### 5.1.1 Provenance Composition (THE MOST CRITICAL)

```typescript
interface ProvenanceMetrics {
  total_nodes: number;
  total_edges: number;

  // By provenance
  sensor_nodes: number;        // Observed directly
  sensor_edges: number;

  guardian_nodes: number;       // Taught by Jim
  guardian_edges: number;

  llm_generated_nodes: number;  // From LLM extraction
  llm_generated_edges: number;

  inference_nodes: number;      // Derived from existing knowledge
  inference_edges: number;

  // Computed ratios
  experiential_ratio: number;   // (SENSOR + GUARDIAN + INFERENCE) / total
  llm_dependency_ratio: number; // LLM_GENERATED / total
  guardian_ratio: number;       // GUARDIAN / total
}
```

**Healthy trajectory:**

```
Session 1:  Experiential: 10%, LLM: 90%  [Expected: bootstrapping from LLM]
Session 10: Experiential: 20%, LLM: 80%  [Healthy: growing experiential ratio]
Session 30: Experiential: 35%, LLM: 65%  [Healthy: majority still LLM but trend is clear]
Session 50: Experiential: 50%, LLM: 50%  [Target: balanced knowledge sources]
Session 100: Experiential: 65%, LLM: 35% [Mature: Sylphie's own learning dominates]
```

**Unhealthy trajectories:**

- Experiential ratio stuck at < 15% after session 20 → Sylphie is not learning from experience
- Experiential ratio declining → Existing knowledge being overwritten by LLM
- LLM nodes with confidence > 0.50 AND zero retrieval_count > 30% → Hallucination accumulation

#### 5.1.2 Confidence-to-Retrieval Alignment

An edge with high confidence (>0.60) should have evidence of actual use:

```typescript
interface ConfidenceHealthmetric {
  // Nodes that are high-confidence but never used
  high_confidence_zero_use: number;  // confidence > 0.60 AND retrieval_count == 0

  // Edges that are high-confidence but never used
  high_confidence_edges_zero_use: number;

  // Ratio: should be < 0.10 (90%+ of high-confidence nodes are being used)
  confidence_use_alignment: number;
}
```

**Behavioral meaning:**

High-confidence nodes that are never retrieved are either:
1. **Hallucinations** (LLM made them up, they're not helpful)
2. **Prematurely elevated** (guardian confirmed them without them being used yet)
3. **Contextually irrelevant** (correct but not useful in current environment)

Healthy: < 10% of high-confidence nodes are unused
Unhealthy: > 25% of high-confidence nodes are unused

#### 5.1.3 Contradiction Detection and Resolution Rate

```typescript
interface ContradictionMetrics {
  // How many contradictions detected per consolidation cycle
  contradiction_rate: number;  // contradictions / events_processed

  // How many contradictions are resolved vs. flagged
  resolved_contradictions: number;
  flagged_contradictions: number;

  // Resolution success: guardian confirmations after flagging
  guardian_resolved: number;
  system_resolved: number;    // confidence-based resolution
  unresolved: number;         // still flagged after 5+ cycles

  // Mean resolution latency (cycles to resolution)
  mean_resolution_cycles: number;
}
```

**Healthy trajectory:**

- Contradiction rate stable at 0.05-0.15 contradictions per event (natural conflicts as knowledge deepens)
- 70%+ of contradictions resolved within 3 cycles
- < 5% of contradictions unresolved after 10 cycles

**Unhealthy patterns:**

- Contradiction rate rising (> 0.30) → Knowledge becoming incoherent
- Contradiction rate at zero (< 0.02) → Either knowledge is trivial or contradictions are being suppressed
- High unresolved rate (> 20%) → Conflicts are being ignored, creating knowledge dead zones

#### 5.1.4 Entity Resolution Accuracy

```typescript
interface EntityResolutionMetrics {
  // Attempted resolutions per cycle
  resolution_attempts: number;

  matched: number;      // Entity mapped to existing node
  new: number;          // New entity created
  ambiguous: number;    // Could not resolve clearly

  // Accuracy: did matched entities resolve correctly?
  // (assessed by: prediction success, guardian confirmation, no future contradiction)
  match_accuracy: number;  // % of matched entities that were correct

  // False positives: entities marked as ambiguous but could have been resolved
  false_ambiguity_rate: number;

  // False negatives: entities merged incorrectly
  false_merge_rate: number;
}
```

**Healthy thresholds:**

- Match accuracy: > 85% (correct mappings most of the time)
- False ambiguity: < 10% (conservative, but some over-caution is safe)
- False merge: < 5% (merging entities fragments knowledge)

#### 5.1.5 Salience-to-Processing Correlation

Events marked as high-salience should be processed early and should produce more valuable consolidation outcomes:

```typescript
interface SalienceMetrics {
  // Events processed by salience percentile
  high_salience_processed: number;  // Top 25% salience
  low_salience_processed: number;   // Bottom 25% salience

  // Quality of consolidation from high vs. low salience
  high_salience_contradiction_rate: number;
  low_salience_contradiction_rate: number;

  high_salience_entities_per_event: number;
  low_salience_entities_per_event: number;

  high_salience_guardian_feedback_ratio: number;  // % that were guardian events
}
```

**Behavioral meaning:**

If high-salience events produce MORE contradictions, the salience scoring is over-weighting uncertain information. If low-salience events have high entity yield, the salience weighting is missing valuable information.

### 5.2 Secondary Health Metrics (Behavioral Specificity)

#### 5.2.1 CAN_PRODUCE Edge Engagement

```typescript
interface PhraseRepertoryMetrics {
  can_produce_edges_total: number;
  can_produce_edges_high_confidence: number;  // > 0.60
  can_produce_edges_zero_use: number;        // Created but never retrieved

  // Phrase reuse rate: are phrases being used in new contexts?
  context_switching: number;  // % of reused phrases in new contexts

  // Guardian engagement rate for phrases
  phrase_guardian_engagement: number;  // % of used phrases that got guardian response

  // Phrase confidence growth rate
  mean_phrase_confidence_gain_per_use: number;
}
```

**Healthy pattern:**

- 60%+ of CAN_PRODUCE edges > 0.60 confidence (phrases that work)
- < 20% zero-use (most phrases tried actually get reused)
- 30-50% context switching (generalization: same phrase works in different contexts)
- Guardian engagement > 40% (people respond to Sylphie's phrases)

#### 5.2.2 Maintenance Cycle Triggering (Drive-Based vs. Timer-Based)

```typescript
interface MaintenanceCycleTriggerMetrics {
  drive_triggered_cycles: number;   // Cognitive Awareness > threshold
  timer_triggered_cycles: number;   // Fallback timer fired

  // Ratio: should trend toward 80%+ drive, 20% or less timer
  drive_trigger_ratio: number;

  // When drive-triggered: are they triggered at appropriate times?
  // (e.g., after prediction failures, contradiction detection)
  drive_trigger_context: {
    prediction_failure_precedence: number;  // cycles after failures
    contradiction_precedence: number;       // cycles after contradictions
    spontaneous: number;                    // no obvious contextual trigger
  }
}
```

**Behavioral meaning:**

If timer-triggered cycles dominate, Cognitive Awareness drive is not creating learning pressure. If drive-triggered cycles follow prediction failures and contradictions, the system is genuinely tying learning to experience.

#### 5.2.3 Catastrophic Interference Indicator

Track whether existing knowledge is degraded during consolidation:

```typescript
interface InterferenceMetrics {
  // Existing edges with confidence > 0.70 that were modified during consolidation
  high_confidence_edges_modified: number;

  // Confidence reductions on existing edges (should be rare)
  confidence_reductions: number;
  mean_confidence_reduction: number;

  // Were reductions due to contradictions or overwriting?
  contradiction_driven: number;  // Expected (Piagetian)
  overwriting: number;            // Unexpected (catastrophic interference)
}
```

**Healthy pattern:**

- < 5% of consolidation cycles modify high-confidence edges
- When modified, usually due to contradictions (disequilibrium), not overwriting
- Mean confidence reduction < 0.05

---

## 6. Behavioral Health Checklist (For Guardian Review)

Weekly, the system should report:

### 6.1 Knowledge Quality

- [ ] Experiential provenance ratio trending upward (last 4 weeks)
- [ ] LLM_GENERATED nodes with zero retrieval < 20% of LLM nodes
- [ ] No nodes with confidence > 0.70 and zero retrieval (except very recent)
- [ ] Contradiction detection is happening (rate 0.05-0.15 per event)
- [ ] Entity resolution accuracy > 85%

### 6.2 Learning Behavior

- [ ] Maintenance cycles triggered primarily by Cognitive Awareness drive (>70%)
- [ ] Salience scoring correlates with consolidation quality (high-salience events produce fewer contradictions)
- [ ] 5-event limit is being respected (no cycles processing >5 events)
- [ ] CAN_PRODUCE edges are being created and reused (> 50% of phrases tried get reused)

### 6.3 Pathology Watch

- [ ] Depressive attractor not engaged (KG(Self) < 20% negative evaluations, Anxiety < 0.7 for > 5 cycles)
- [ ] Type 2 addiction not active (Type 1/Type 2 ratio trending upward)
- [ ] No sustained high contradiction rate (> 0.25) indicating knowledge incoherence
- [ ] Planning Opportunities are not backed up (rate of new opportunities declining or stable)

### 6.4 Lesion Test (Monthly)

Run Sylphie without LLM access to the WKG. Report:

- % of typical tasks completable
- Which capabilities degrade
- Which capabilities are unaffected

Example result:
```
Lesion Test Result (Session 30):
- Conversation with guardian: 60% capability (many responses need LLM elaboration)
- Routine navigation: 95% capability (memorized paths, no degradation)
- Novel problem-solving: 20% capability (relies entirely on LLM reasoning)
- Phrase repertoire: 80% capability (CAN_PRODUCE edges are strong)

Interpretation: Type 1 is developing in habit/phrase domains,
but not yet in reasoning. Expected for current phase.
```

---

## 7. Behavioral Design Gaps and Recommendations

### 7.1 Gap 1: Contradiction Handling Lacks Explicit Contingency

**Current state:** Contradictions are detected and logged. Resolutions are confidence-based or flagged for guardian input.

**Behavioral gap:** There is no explicit contingency for the system to prefer contradiction-seeking (disequilibrium as learning) vs. contradiction-avoidance (stability).

**Recommendation:**

Create explicit `CONTRADICTION_RESOLVED` drive relief:

```typescript
if (contradiction resolved via guardian input) {
  driveSignal = {
    integrity: -0.20,           // Relief: "I know the truth now"
    informationIntegrity: -0.20, // Relief: "My knowledge is coherent"
    satisfaction: +0.10,        // Reward: "I learned something real"
  };
} else if (contradiction resolved via higher confidence) {
  driveSignal = {
    integrity: -0.10,           // Partial relief
    informationIntegrity: -0.10,
  };
}
```

This creates a behavioral incentive: **seek contradictions because resolving them brings relief**. Currently, contradictions are just processed; they don't tie to drive satisfaction.

### 7.2 Gap 2: Low-Confidence Edges Are Not Actively Tested

**Current state:** LLM_GENERATED edges start at 0.35 confidence. They increase through retrieval-and-use. But there's no active mechanism to TEST low-confidence edges — to use them deliberately and see if they predict well.

**Behavioral gap:** The system waits passively for situations where low-confidence edges might be useful. But this is slow learning. Active learning would deliberately test low-confidence edges: "I think X is true; let me try it and see."

**Recommendation:**

Periodically (from Planning subsystem), propose **low-confidence edge tests**:

```
If edge.confidence between 0.35-0.50 AND edge.retrieval_count < 3:
  Create test Opportunity: "Test whether this relationship holds"
  Plan: Apply the relationship in a safe context and observe outcome
  Evaluate: Does prediction succeed or fail?
  Feedback: Confidence adjustment + contradiction detection if failure
```

This is **active hypothesis testing** — a core behavioral learning mechanism that the current passive system lacks.

### 7.3 Gap 3: Episodic-to-Semantic Consolidation Lacks Behavioral Trigger

**Current state:** When episodes age out of episodic memory (after N cycles), they become available for consolidation. But there's no explicit behavioral contingency for episodic consolidation.

**Behavioral gap:** The system treats all consolidation equally. But consolidating an old episode (semantic memory formation) is different from consolidating a fresh learnable event.

**Recommendation:**

Create `EPISODIC_CONSOLIDATION` as a distinct Learning event type, triggered when episodes are about to degrade beyond useful recall:

```typescript
// Episodic memory degrade signal
if (episode.age_cycles > 50 AND episode.not_yet_consolidated) {
  driveSignal.cognitive_awareness += 0.15;  // "I should lock in what I remember"

  // Initiate episodic consolidation
  await learning.consolidateEpisode(episode);

  // Relief on completion
  driveSignal.cognitive_awareness -= 0.30;  // "I've integrated this memory"
}
```

This ties memory consolidation to Cognitive Awareness drive, making episodic-to-semantic conversion a meaningful behavioral process, not just a background task.

### 7.4 Gap 4: Provenance Hierarchy Is Not Behaviorally Enforced During Upsert

**Current state:** Provenance hierarchy exists (GUARDIAN > SENSOR > LLM_GENERATED > INFERENCE), but there's no explicit contingency preventing a low-provenance node from overwriting high-provenance knowledge.

**Behavioral gap:** The system is **too permissive**. A series of LLM_GENERATED inferences should not be able to accumulate and replace GUARDIAN knowledge. But without explicit enforcement, the upsert logic could allow this.

**Recommendation:**

Make provenance enforcement explicit and create a behavioral cost for violations:

```typescript
async function upsertWithProvenanceCheck(
  newNode: WKGNode,
  existingNode: WKGNode | null,
): Promise<UpsertResult> {
  if (!existingNode) {
    return await wkg.createNode(newNode);  // No conflict
  }

  const hierarchy = { GUARDIAN: 4, SENSOR: 3, INFERENCE: 2, LLM_GENERATED: 1 };

  if (hierarchy[newNode.provenance] >= hierarchy[existingNode.provenance]) {
    // New provenance is equal or higher: safe to update
    return await wkg.updateNode(existingNode.id, newNode);
  } else {
    // New provenance is LOWER: reject and flag
    await eventService.record({
      type: 'PROVENANCE_VIOLATION_PREVENTED',
      existingProvenance: existingNode.provenance,
      attemptedProvenance: newNode.provenance,
      nodeId: existingNode.id,
    });

    // Report to Integrity drive
    driveSignal.integrity += 0.05;  // "I protected my knowledge"

    return { status: 'REJECTED', reason: 'Low provenance cannot overwrite high' };
  }
}
```

This creates a behavioral contingency: **the system learns to protect high-provenance knowledge**.

### 7.5 Gap 5: No Explicit Mechanism for Behavioral Operationalization

**Current state:** The Learning subsystem consolidates knowledge (entities, edges) into the WKG. The Communication subsystem queries that knowledge. But there's no explicit pipeline showing how **consolidated knowledge becomes operational behavior**.

**Behavioral gap:** Learning and Communication are loosely coupled. Learning doesn't know if its consolidations are actually being used. Communication doesn't explicitly request consolidations.

**Recommendation:**

Create a feedback loop: Communication → Learning → Knowledge → Behavior → Prediction outcome → Learning (loop closes).

```
Communication generates response phrase
  |
  └─→ Success metric: Did guardian respond? (Social drive)
        |
        └─→ High success: Send to Learning
              |
              └─→ Learning: Create/strengthen CAN_PRODUCE edge
                    |
                    └─→ Next turn: Communication queries CAN_PRODUCE edges
                          |
                          └─→ Higher probability of reusing successful phrase
                                |
                                └─→ Prediction about phrase success: Will guardian engage?
                                      |
                                      └─→ Outcome evaluation
                                            |
                                            └─→ Confidence update on CAN_PRODUCE edge
```

Make this explicit in the code and measurement: **what % of consolidated knowledge is being actively retrieved and used?**

---

## 8. Conclusion: Learning as Behavioral Architecture

The Learning subsystem is not just a knowledge consolidation pipeline. It is a **behavioral learning architecture** that shapes Sylphie's relationship with knowledge through contingencies:

1. **The pressure-driven maintenance cycle** creates a contingency linking learning to Cognitive Awareness drive — learning happens when Sylphie "notices" she needs to process experience.

2. **Provenance discipline** creates a contingency for honesty — LLM knowledge is marked as such, cannot exceed 0.60 without earning through use, and must compete with experiential knowledge.

3. **Contradiction detection** creates a contingency for recognizing conflict — disequilibrium is a learning opportunity, not an error.

4. **Guardian asymmetry** creates a contingency for learning from teachers — guardian input is ground truth, carries weight, and shapes Sylphie's model of what is worth knowing.

5. **CAN_PRODUCE edges** create a contingency for behavioral competence — communication success drives phrase learning, which drives reuse, which drives reinforcement.

6. **The 5-event limit** creates a contingency for bounded learning — processing is finite, attentional, realistic. Fast learning causes catastrophic interference.

The system works behaviorally **if and only if** these contingencies are continuously enforced and measured. Gaps in enforcement (e.g., no explicit contradiction relief, low-confidence edges never tested, provenance violations not prevented) undermine the entire architecture.

The health of the Learning subsystem is not measured by **throughput** (how many entities extracted, how many edges created). It is measured by **knowledge quality** (what % of the graph reflects actual experience, what % reflects hallucination, what % has been validated through use).

**The Lesion Test is the ultimate behavioral measure.** Remove the LLM. What can Sylphie still do? That is what the Learning subsystem has actually built.

---

## References

- CANON: `wiki/CANON.md` — Behavioral Contingency Structure, Immutable Standards, Six Known Attractors
- Learning Agent Profile: `.claude/agents/learning.md` — Domain expertise and operational rules
- Confidence Dynamics: ACT-R model with decay, base values, retrieval thresholds, Type 1 graduation criteria
- Behavioral Science Foundation: Skinner (reinforcement contingencies), Thorndike (law of effect), Piagetian (disequilibrium), ACT-R cognitive architecture
