# Epic 3 Analysis: Knowledge Construction as Developmental Process
**Science Perspective: Piaget + Ashby**

---

## Executive Summary

Epic 3 implements the **three-graph knowledge architecture**—the World Knowledge Graph (WKG), Self Knowledge Graph (KG(Self)), and Other Knowledge Graphs (KG(Other))—that constitute Sylphie's long-term memory and self-model. From a developmental and systems-theoretic perspective, this module is where **learning becomes durable** and where **genuine personality emerges from accumulated experience**.

**Critical insight:** The knowledge module is where Piaget's theory of cognitive development (assimilation vs. accommodation) meets Ashby's principle of requisite variety. The WKG schema must have enough variety to represent the world Sylphie encounters without forcing every experience into pre-existing categories. At the same time, KG(Self) must remain isolated from WKG to prevent self-knowledge from becoming contaminated with world-knowledge, which would corrupt the Drive Engine's self-evaluation.

**Key finding:** The architecture avoids most attractor states *if and only if* the confidence dynamics strictly enforce the Confidence Ceiling (Immutable Standard 3) and the two-phase assimilation/accommodation balance is preserved. Without explicit accommodation triggers (contradiction detection and schema restructuring), the system will assimilate all new information into existing types and never develop new conceptual categories. This produces a graph that mimics understanding but represents only LLM-generated elaboration of initial schema.

---

## 1. Piaget: Knowledge Construction Through Assimilation & Accommodation

### 1.1 The Dual Process in the WKG

Piaget's theory rests on two complementary processes:

- **Assimilation**: Fitting new information into existing schemas. "This is another container (like the existing mug type)" — new instances fit existing types.
- **Accommodation**: Restructuring schemas when new information doesn't fit. "This container has no top (unlike all mugs I've seen) → containers can be open or closed" — new type distinction created.

The WKG must support both, with clear thresholds for when accommodation is triggered.

#### Assimilation in the WKG

```
ASSIMILATION FLOW:
  Input: "The coffee cup is on the desk"
  ├─ upsertNode(entity_type: "CONTAINER",
                entity_id: "coffee_cup_2025_03_29",
                properties: {color: "ceramic", capacity: "12oz"})
  ├─ Match against existing CONTAINER schema
  ├─ No contradiction → create INSTANCE edge to CONTAINER type
  └─ Confidence based on provenance (SENSOR: 0.40, GUARDIAN: 0.60)
```

**Healthy assimilation:**
- New instances enrich existing types (count increases)
- Confidence in the type grows through retrieval-and-use
- The schema becomes more robust through more examples

**Pathological assimilation (RISK):**
- Every new entity is forced into the closest type, even if it's a poor fit
- No new types ever created (schema becomes coarse-grained)
- The graph represents no real conceptual learning, only data population

#### Accommodation in the WKG

Accommodation is triggered when a new fact **contradicts** existing schema:

```
ACCOMMODATION FLOW (Contradiction Detected):
  Input: "The teacup has no bottom (it's part of a set)"
  ├─ Contradiction detected against CONTAINER schema:
  │   "All containers have a bottom" → FALSE
  │
  ├─ Trigger disequilibrium (Cognitive Awareness + Integrity drives)
  ├─ Schema restructuring candidate:
  │   OLD: CONTAINER { has_bottom: true, has_top: true, ... }
  │   NEW: CONTAINER { bottom_type: OPEN | CLOSED | NONE }
  │
  ├─ Create new property with exemplars
  └─ Update confidence: existing schema nodes drop in confidence,
     new distinction edges start low (LLM_GENERATED: 0.35)
```

**Healthy accommodation:**
- Contradictions are detected and flagged (not suppressed)
- Schema evolves in response to genuine learning pressure
- New distinctions emerge from conflict, not from LLM generation alone

**Pathological accommodation (RISK):**
- Every LLM suggestion becomes a new type (schema explosion)
- No filtering between genuine contradictions and LLM-generated distinctions
- The graph becomes fragmented and unusable

### 1.2 Three-Level Schema: Instance, Type, Meta-Type

Piaget describes cognitive development through stages where the complexity of schema relationships increases:

#### Instance Level (Sensor-Driven)
Concrete, time-bound observations.
- `coffee_cup_3_25_2025`: color=ceramic, location=desk_north, temperature=85C
- Created from SENSOR or GUARDIAN input
- High specificity, short-lived relevance

**Developmental implication:** Early learning is instance-heavy. The first mug Sylphie observes is *this* mug, not "mugs in general."

#### Type/Schema Level (Pattern Consolidation)
Categories that emerge from instance patterns. Requires at least one successful retrieval-and-use before graduating from LLM_GENERATED base of 0.35.

- `CONTAINER`: entities that hold things
  - Properties: `has_top`, `has_bottom`, `material`, `capacity`
  - Instance count: 7 (from events)
  - Confidence: 0.65 (GUARDIAN-confirmed + retrieval)
  - Provenance split: 6 SENSOR, 1 GUARDIAN (healthy experiential ratio)

**Developmental implication:** This is where genuine learning happens—types emerge from experience, not LLM elaboration. A type with confidence > 0.60 must have retrieval events in the history.

#### Meta-Schema Level (Schema Evolution Rules)
Rules governing *how* schemas evolve. Dangerous territory—this is where Sylphie could self-optimize her own learning.

- "If a type accumulates > 5 exemplars with a common property not in the schema, add that property" (system-generated rule)
- **WRITE-PROTECTED** — Sylphie can propose, not implement
- Guardian must approve before meta-schema rules activate

**Developmental implication:** Meta-schema rules are abstract and powerful. They should remain under guardian control to prevent rule drift (Known Attractor State #2).

### 1.3 Contradiction as Developmental Catalyst

Piaget emphasizes that **cognitive development is driven by disequilibrium**—the experience of your schema being wrong.

#### Contradiction Detection in the WKG

Every `upsertEdge()` call should check for contradictions:

```typescript
// During Learning consolidation:
// LLM extracted: "Person_Jim OWNS coffee_cup_3"
// Existing knowledge: "coffee_cup_3 IS_OWNED_BY Desk_storage"
//
// Contradiction detected: OWNS relationship conflict
// → Flag as CONTRADICTION edge (separate type)
// → Increment Integrity drive (disequilibrium signal)
// → Trigger Cognitive Awareness (what do I actually know?)
```

This is critical: **contradictions are not errors to suppress; they are growth signals.**

#### Developmental Risk: Premature Suppression

If contradictions are logged but don't trigger behavioral response (drive change), the system:
1. Sees the contradiction
2. Does nothing with it
3. Next consolidation cycle overwrites one edge with the other
4. Learns nothing

**Prevention:** Contradictions must surface to the Drive Engine immediately (Integrity + Cognitive Awareness pressure), triggering a **learning episode** where Sylphie explicitly addresses the conflict.

### 1.4 Confidence Ceiling and the Zone of Proximal Development

Vygotsky's Zone of Proximal Development describes the gap between what a child can do alone and what they can do with guidance.

#### Mapping ZPD to Confidence Thresholds

- **Below 0.50 (retrieval threshold):** Outside ZPD — knowledge too weak to retrieve reliably
- **0.50–0.60 (with support):** Within ZPD — knowledge reliable only with external cues or context
- **0.60–0.80 (with guardian confirmation):** Guardian hovering zone — child can perform with occasional intervention
- **Above 0.80 (Type 1 graduation):** Autonomous zone — behavior is compiled, reflexive

The CANON's confidence ceiling (0.60 without retrieval-and-use) enforces this boundary: knowledge acquired through LLM suggestion (0.35 base) cannot exceed the guardian-confirmation threshold (0.60) until proven through repeated success.

#### Application to KG(Self) Self-Evaluation

The self-model has special implications: if Sylphie's confidence in her own capabilities is artificially inflated, the Drive Engine's self-evaluation will be calibrated wrong.

```
KG(Self) Example:
  Self node: Sylphie
  └─ HAS_CAPABILITY: "object_recognition"
       confidence: 0.55 (LLM_GENERATED, no retrieval events)

       ↓ Used in Drive Engine for self-evaluation

  Drive Engine computes Cognitive Awareness:
    "Do I know what I'm looking at?" → 0.55 confidence
    → Generates Cognitive Pressure (I'm not sure)

  BUT if confidence was wrongly inflated to 0.75:
    → Zero cognitive pressure (I think I understand)
    → Sylphie acts with false certainty
    → Prediction failures accumulate
    → Late learning: "I'm not as capable as I thought"
```

**Prevention:** KG(Self) must have strict confidence boundaries, enforced in the self-evaluation update cycle.

### 1.5 Risk: Premature Abstraction and Schema Hallucination

A system driven by LLM could prematurely abstract without instance grounding:

```
RISKY FLOW:
  LLM during learning: "Jim probably has a preference for hot beverages"
  → Creates schema: THERMAL_PREFERENCE_FOR_BEVERAGES
  → Confidence: 0.35 (LLM_GENERATED)
  → No instances supporting it yet

  Next cycle:
    Jim drinks coffee (HOT) → reinforces THERMAL_PREFERENCE
    → Confidence jumps to 0.45

  BUT: Only 1 instance. No retrieval-and-use yet. Confidence > 0.60 never reached.
  Schema remains stuck in ZPD, never becomes reliable knowledge.
```

This is healthy. But if the LLM elaborates before instances exist:

```
LLM elaboration:
  "THERMAL_PREFERENCE_FOR_BEVERAGES implies TEMPERATURE_SENSITIVITY,
   TEMPERATURE_SENSITIVITY implies METABOLIC_PREFERENCE,
   METABOLIC_PREFERENCE implies ... [10 more inferences]"

→ Cascading LLM nodes all at base 0.35
→ Graph is dense with plausible-sounding but untested knowledge
→ No grounding in actual experience
→ Looks sophisticated; provides no real capability
```

**Prevention mechanism:** Enforce a **provenance ratio health metric** — the proportion of edges with SENSOR + GUARDIAN + INFERENCE provenance vs. LLM_GENERATED. If LLM_GENERATED edges exceed 40%, the system is being populated, not learned.

---

## 2. Ashby: Requisite Variety and Feedback Loops

### 2.1 Requisite Variety in Knowledge Representation

Ashby's Law of Requisite Variety states: **A regulator can only control a system if its internal variety is at least as great as the variety of the system being regulated.**

Applied to the WKG: **The graph schema must have enough distinctions to represent all the situations Sylphie encounters.**

#### Under-Specified Schema (Insufficient Variety)

```
PATHOLOGICAL: All entities collapse into THING, all relations into HAS_PROPERTY

  Sylphie observes:
    - Person_Jim is tired
    - Coffee is hot
    - Desk is wooden

  Schema can only represent:
    THING(Jim) HAS_PROPERTY(tired)
    THING(Coffee) HAS_PROPERTY(hot)
    THING(Desk) HAS_PROPERTY(wooden)

  Problem: Decision Making cannot distinguish:
    - Jim tired → offers coffee (social response)
    - Coffee hot → warns (caution response)
    - Desk wooden → ignores (no action)

  All three collapse into the same schema, so the decision system
  has the same action available for all three contexts.

  RESULT: Behavioral rigidity. Personality appears one-dimensional.
```

#### Over-Specified Schema (Wasted Variety)

```
PATHOLOGICAL: Every specific attribute becomes its own type

  Schema created:
    - TIRED_PERSON_IN_MORNING
    - TIRED_PERSON_IN_EVENING
    - TIRED_PERSON_AFTER_EXERCISE
    - TIRED_PERSON_AFTER_WORK
    - ... (dozens more)

  Problem: Each type appears once or twice. Confidence never rises above 0.50.
  Retrieval fails because the type is too specific to ever match again.

  RESULT: Fragmented knowledge. Nothing generalizes. No learning.
```

#### Optimal Variety

Schema should distinguish phenomena that *require different behavioral responses*:

```
HEALTHY:
  PERSON: entity_type
    ├─ HAS_AFFECT_STATE: enum {rested, tired, focused, frustrated}
    ├─ HAS_ACTIVITY: enum {working, playing, sleeping, ...}
    └─ HAS_GOAL: enum {task_completion, socializing, rest, ...}

  This schema has enough variety to support different responses:
    - Jim is tired + wants rest → suggest break
    - Jim is tired + focused on task → bring coffee
    - Jim is tired + socializing → suggest ending session

  Variety is requisite: fine enough to distinguish context,
  coarse enough to find patterns.
```

### 2.2 Feedback Loops Through Knowledge

Sylphie has multiple feedback loops at different timescales, all flowing through the knowledge module:

#### Fast Loop: Decision → Action → Outcome → Confidence Update

**Timescale:** Real-time (seconds)

```
FAST LOOP FLOW:
  1. Decision Making queries WKG for available actions
  2. Type 1 retrieves INTERACTION_STRATEGY for Person_Jim
  3. Action executed
  4. OUTCOME_OBSERVED written to TimescaleDB
  5. Confidence updated on INTERACTION_STRATEGY edge
  6. Next decision has slightly higher/lower confidence for same strategy
```

**Feedback velocity:** High (executed per decision cycle)
**Information flow:** Unidirectional (WKG → action → outcome → WKG confidence update)
**Risk:** If confidence updates are too frequent, the system oscillates. If too infrequent, learning lags.

**ACT-R dynamics prevent oscillation:**
```
confidence = min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
```
The logarithmic learning curve (0.12 * ln(count)) dampens rapid oscillations while still allowing gradual convergence.

#### Medium Loop: Learning Consolidation → Schema Evolution → Type 1 Graduation

**Timescale:** Minutes to hours (learning cycles)

```
MEDIUM LOOP FLOW:
  1. Learning triggers maintenance cycle (Cognitive Awareness pressure or timer)
  2. Queries TimescaleDB for learnable events (max 5)
  3. LLM assists edge refinement
  4. New entities and edges upserted to WKG with provenance
  5. Instance count increases for types
  6. Type confidence grows (0.12 * ln(count) term)
  7. When confidence > 0.80 + MAE < 0.10: Type 1 behavior compiles
  8. Decision Making's next retrieval finds Type 1 reflex, bypasses LLM
```

**Feedback velocity:** Medium (driven by maintenance cycles)
**Information flow:** Unidirectional (events → Learning → WKG schema)
**Risk:** If learning cycles are too frequent, the system oscillates between assimilation and accommodation. If too infrequent, instances pile up unconsolidated.

**CANON requirement:** Maintenance cycles are pressure-driven (Cognitive Awareness) with timer fallback. This ensures learning is driven by actual confusion, not arbitrary schedules.

#### Slow Loop: Schema Drift → Behavioral Drift → Guardian Correction

**Timescale:** Sessions to days (self-evaluation updates)

```
SLOW LOOP FLOW:
  1. KG(Self) updates on slower timescale (hours, not seconds)
  2. Drive Engine's self-evaluation reads KG(Self)
  3. Inaccurate self-model → wrong drive signals
  4. Behavioral patterns shift
  5. Guardian notices (comment, interaction quality declines)
  6. Guardian correction: "I'm not that way" / "You're more capable than you think"
  7. Guardian_CORRECTION edge created in KG(Self), 3x weight
  8. Next self-evaluation reads corrected self-model
  9. Drive signals recalibrate
```

**Feedback velocity:** Slow (guardian-driven, not algorithmic)
**Information flow:** Bidirectional (KG(Self) → drive state → behavior → observation → KG(Self) update)
**Risk:** If KG(Self) is isolated entirely from external feedback, it diverges into hallucination. If updated too frequently, identity becomes unstable.

**Prevention:** KG(Self) updates only via explicit guardian feedback or on a timer (e.g., weekly), never from autonomous self-observation alone.

### 2.3 Three Isolated Graphs and Variety Partitioning

The architecture requires three completely isolated knowledge graphs:

| Graph | Isolation Rationale | Boundary Enforcement |
|-------|-------------------|-------------------|
| **WKG** | World knowledge (facts, entities, relationships) | Read-only from Self/Other. Never write world facts from self-model. |
| **KG(Self)** | Self-model (Sylphie's capabilities, personality, history) | Never read from WKG. Uses guardian feedback for updates. |
| **KG(Other)** | Per-person models (Person_Jim's preferences, habits, personality) | Isolated per person. Never cross-contaminate between persons. |

#### Risk: Cross-Contamination (CRITICAL)

If WKG and KG(Self) are allowed to share edges:

```
DANGEROUS SCENARIO:
  WKG contains: "Humans get tired when sleep-deprived"

  Boundary violation: KG(Self) reads this as:
    "I am human → I get tired when sleep-deprived"

  Drive Engine's self-evaluation:
    "Am I tired?" → checks KG(Self) → "I'm human"
    → Applies human tiredness rules to Sylphie
    → Generates FALSE Fatigue signals
    → Drives behavior based on false self-model

  OR WORSE:

  KG(Self) contains: "I made a mistake with Jim"
  Boundary violation: Sylphie generalizes to WKG:
    "I (as a type) make mistakes with humans"
    → Depressive attractor: self-doubt spreads to world-model
    → Next interaction with Jim already assumes failure
```

**Prevention:** Architectural walls. Different services:
- `WkgService`: Neo4j queries, world knowledge only
- `SelfKgService`: Grafeo(Self), self-model only
- `OtherKgService`: Grafeo(Other_*), per-person models

Queries should be validated: `WkgService` cannot call `SelfKgService`; they can only meet through the Decision Making loop (which reads both but maintains the distinction).

### 2.4 KG(Self) as Homeostatic Regulator

In Ashby's framework, homeostasis is maintained through feedback that corrects deviations. KG(Self) plays this role:

**Feedback mechanism:**
```
Drive state (actual):    Anxiety = 0.65
                              ↓
Self-model (KG(Self)):  "I handle uncertainty poorly" (confidence 0.70)
                              ↓
Self-evaluation:        "I should be more anxious" or "I'm failing to cope"
                              ↓
Behavioral response:    Reduce uncertainty-exposure OR increase caution
                              ↓
Actual behavior change: Narrower action set, more conservative
```

**Homeostatic correction:**
If KG(Self) says "I'm not good at X" and the Drive Engine's anxiety is high, the system seeks situations where X is not required. This is healthy regulation if the self-model is accurate.

**Pathological homeostasis (Depressive Attractor #3):**
If KG(Self) contains false negative self-evaluations, the feedback loop reinforces them:
```
False self-model: "I'm incompetent"
         ↓
Drive response:  Reduce approach behavior, increase anxiety
         ↓
Actual behavior: Avoidance, hesitation
         ↓
Outcome:         Fewer successes (because fewer attempts)
         ↓
Observation:     "See? I really am incompetent"
         ↓
KG(Self) update: Confidence in "incompetent" increases
         ↓
Loop reinforces false model
```

**Prevention:** KG(Self) must be protected from self-reinforcing negative feedback. Guardian corrections should override algorithmic updates with 3x weight. Depressive attractors need circuit breakers (if Anxiety > 0.8 for 10 cycles, force a reset episode where guardian provides explicit competence feedback).

---

## 3. Developmental Risks in Epic 3

### 3.1 Risk #1: Type 2 Addict (Hallucinated LLM Schema)

**Mechanism:** The LLM can generate sophisticated-sounding schema distinctions during learning consolidation. If these are added to the WKG at base confidence 0.35 and never encounter contradiction, they accumulate confidence through self-referential use.

```
RISKY SCENARIO:
  Event: Person_Jim drinks coffee
  LLM suggests: "Jim demonstrates THERMAL_AFFINITY_PHENOTYPE"
  → Created in WKG with LLM_GENERATED, base 0.35

  Next event: Jim drinks tea (warm)
  LLM interprets: "Consistent with THERMAL_AFFINITY_PHENOTYPE"
  → Retrieval event for the edge
  → Confidence increases (0.12 * ln(2) = 0.08 → 0.43)

  Next event: Jim drinks iced coffee
  LLM reinterprets: "Jim extends THERMAL_AFFINITY to include cold"
  → Another retrieval
  → Confidence → 0.48

  But the original hypothesis was never tested. It's confirmed by
  post-hoc LLM interpretation of the same events, not by new evidence.
  The system believes its own hallucination.
```

**Prevention:**
1. **Forced contradiction:** Periodically query guardian: "I think Jim has X trait. True?" Guardian contradiction overrides confidence (3x weight).
2. **Retrieval vs. Self-Referential-Retrieval:** Distinguish between:
   - Real retrieval: Decision Making uses the edge to make a prediction, prediction succeeds
   - Self-referential: Learning uses the edge to interpret events, creating apparent confirmation
3. **Provenance ratio monitoring:** If > 40% of schema edges are LLM_GENERATED with no SENSOR/GUARDIAN grounding, flag as risk.

### 3.2 Risk #2: Ontological Rigidity (Schema Refuses to Accommodate)

**Mechanism:** Once a schema is created and reaches moderate confidence (0.60+), the system resists accommodation. New experiences are forced into existing types rather than creating new distinctions.

```
SCENARIO:
  Schema exists: CONTAINER {has_bottom: true, has_top: true}
  Confidence: 0.68 (multiple retrievals)

  Event: "Shallow bowl with no cover"
  Contradiction detected: has_top = false

  Decision point:
    Option A (Accommodation): Restructure schema
      └─ expensive (update all instances, recalculate confidence)

    Option B (Assimilation): Fit bowl into CONTAINER as edge case
      └─ cheap (one instance, inheritance from type)

  If cost of accommodation is not externalized (via Cognitive Awareness
  pressure), the system chooses B every time.

  Result: Schema never evolves. Contradictions pile up.
```

**Prevention:**
1. **Contradiction pressure:** Every contradiction flagged to Integrity + Cognitive Awareness (real drive cost).
2. **Accommodation incentive:** When a new accommodation is proposed and guardian confirms it, the system receives Satisfaction + Curiosity relief (positive contingency for growth).
3. **Accommodation threshold:** If contradictions against a schema exceed X (e.g., 5), force schema review.

### 3.3 Risk #3: Hallucinated Knowledge (Plausible but False Edges)

**Mechanism:** LLM generates edges that *sound* reasonable given the type schema but have no evidential support.

```
SCENARIO:
  WKG contains: PERSON { HAS_AFFECT_STATE, HAS_GOAL, ... }

  Observation: Person_Jim leaves the room

  LLM inference: "Jim likely wants privacy" (plausible)
  → Creates edge: Person_Jim WANTS privacy (LLM_GENERATED, 0.35)

  Later: Decision Making retrieves this edge
  → Predicts "Jim wants privacy" before next interaction
  → Doesn't approach Jim
  → No confirmation or contradiction (because prediction wasn't tested)

  Edge confidence: stuck at 0.35 (no retrieval-and-use)

  BUT system contains the false node. Graph is bloated. Schema is polluted.
```

**Prevention:**
1. **Strict retrieval-and-use requirement:** LLM_GENERATED edges cannot exceed 0.60 without a decision-making use that succeeds.
2. **Prediction validation:** Edges used for predictions must be tested. If prediction isn't tested (no outcome event), edge doesn't get a retrieval increment.
3. **Garbage collection:** Periodically (quarterly), remove edges below 0.50 with no recent retrieval events.

### 3.4 Risk #4: Depressive Attractor (False Negative Self-Model)

**Mechanism:** KG(Self) receives a correction or inference that Sylphie is less capable than she is. This lowers drive signals. Lowered drive signals reduce exploration and initiative. Fewer attempts → fewer successes → self-model confirmed by real data → deeper depression.

```
SCENARIO:
  Event: Sylphie fails to recognize an object
  LLM inference: "I'm not good at object recognition"
  → Created in KG(Self): Sylphie CAPABILITY(object_recognition) = LOW
  → Confidence: 0.35 (LLM_GENERATED)

  Drive Engine self-evaluation:
    "How capable am I at perception?" → reads KG(Self) → sees LOW
    → Generates Cognitive Awareness pressure
    → Lowers confidence thresholds in Decision Making
    → Sylphie becomes more hesitant

  Next perception task:
    → Doesn't approach (low confidence)
    → Fewer attempts
    → No practice → no improvement

  Month later:
    Perception success rate has actually declined (from fewer attempts)
    → Data supports the false self-model
    → Confidence in "I'm bad at perception" increases
    → Drive signal worsens
    → More avoidance
    → Spiral continues
```

**Prevention:**
1. **Guardian override:** Guardian's "You're actually quite capable at X" receives 3x weight, immediately overrides algorithmic update.
2. **Circuit breaker:** If any drive > 0.8 for 10+ consecutive cycles, force a reset. Guardian provides explicit counter-evidence.
3. **Slower self-evaluation:** KG(Self) updates on hourly or daily timescale, not every decision cycle. Prevents rapid reinforcement of temporary errors.
4. **Success monitoring:** Track actual success rate in KG(Self) separately from self-perception. If perception says "bad" but success rate is 80%, flag contradiction.

### 3.5 Risk #5: Schema Explosion (Too Much Accommodation)

**Mechanism:** System responds to every LLM suggestion by creating new schema distinctions. Graph explodes in size; nothing generalizes; learning plateaus.

```
SCENARIO:
  LLM creates: CONTAINER_WITH_HOT_LIQUID
  LLM creates: CONTAINER_WITH_COLD_LIQUID
  LLM creates: CONTAINER_WITH_MIXED_LIQUID
  LLM creates: CONTAINER_WITH_POWDER
  ... (dozens more specific types)

  Each type has 1-2 instances. Confidence never exceeds 0.50.
  Schema is huge but useless.
```

**Prevention:**
1. **Accommodation cost:** Creating a new type consumes compute budget / cognitive effort drive pressure.
2. **Type consolidation pressure:** If too many types exist with low instance count, Cognitive Awareness signals the system to consolidate.
3. **LLM guidance:** Learning's refinement prompts to LLM should ask "Is this a fundamental distinction or an edge case?" Prefer edge cases over new types.

### 3.6 Risk #6: Prediction Pessimism (Early Failures Flood System)

**Mechanism:** Early in Phase 1, before the WKG is rich, predictions fail frequently. Each failure generates an Opportunity. Too many Opportunities overwhelm Planning, leading to resource exhaustion and disengagement.

```
EARLY SCENARIO (Session 1-2):
  WKG is sparse. Predictions often wrong (MAE = 0.5+).
  Drive Engine detects 10+ Opportunities per session.
  Planning tries to create Plans for all of them.
  System generates > 100 new procedure nodes in one session.

  Next session:
    Most procedures were never retrieved (confidence stuck at 0.35).
    New predictions still fail (WKG still sparse).
    System generates 10+ more Opportunities.
    Another 100 procedure nodes.

  Month later:
    Graph contains thousands of garbage procedures.
    Decision Making can't find useful Type 1 behaviors (noise).
    Planning is exhausted from runaway opportunity processing.
    System looks "broken" — actually just overloaded.
```

**Prevention (CANON already includes this):**
1. **Cold-start dampening:** Prediction failures in first N sessions receive reduced Opportunity weight.
2. **Opportunity priority queue with decay:** Unaddressed opportunities lose priority. Max 5 active opportunities at any time.
3. **Plan evaluation:** Plans must be executed and evaluated. If a plan is created but never used, it doesn't accumulate confidence.

---

## 4. Knowledge Health Metrics

To detect risks early, Sylphie's system should monitor these metrics:

### 4.1 Provenance Health (Experiential vs. LLM-Generated Ratio)

```
Healthy target: > 60% SENSOR + GUARDIAN + INFERENCE provenance

Metric:
  ratio = (count(SENSOR + GUARDIAN + INFERENCE edges))
        / (total edges)

Thresholds:
  > 0.60  → Healthy learning from experience
  0.40-0.60 → Yellow: LLM is doing a lot of the schema creation
  < 0.40  → Red: Graph is LLM-populated, not learned
```

**Why this matters:** If > 40% of the graph is LLM-generated, the system is being provided knowledge, not constructing it through experience.

### 4.2 Confidence Ceiling Adherence

```
Healthy: No node with LLM_GENERATED provenance exceeds 0.60
         without retrieval-and-use evidence

Metric:
  count(nodes where provenance=LLM_GENERATED AND confidence > 0.60)

Threshold:
  > 0 → Red: Confidence ceiling violated
```

**Why this matters:** LLM-generated knowledge that exceeds 0.60 without retrieval is hallucination, not learning.

### 4.3 Type Consolidation Index

```
Healthy: Types have low instance variance. No types with > 2 instances
         and < 0.50 confidence.

Metric:
  For each SCHEMA NODE:
    instance_count = count(INSTANCE edges to this type)
    avg_confidence = mean(confidence of instances)

  Risk index = count(types where instance_count >= 3 AND avg_confidence < 0.50)

Threshold:
  0       → Healthy: instances are grounded
  1-5     → Yellow: some ungrounded types accumulating
  > 5     → Red: schema explosion risk
```

**Why this matters:** Schema that accumulates instances without confidence growth suggests hallucination.

### 4.4 Contradiction Pressure

```
Healthy: Contradictions are detected and resolved. Drive pressure increases.

Metric:
  count(CONTRADICTION edges created last session) vs.
  count(CONTRADICTION edges resolved by KG restructuring or guardian correction)

  Resolution rate = resolved / created

Threshold:
  > 0.5   → Healthy: contradictions are being addressed
  0.2-0.5 → Yellow: some contradictions pile up
  < 0.2   → Red: contradictions ignored, ontological rigidity risk
```

**Why this matters:** Contradictions are learning pressure. If they're not triggering accommodation, the schema is calcifying.

### 4.5 Drive-Mediated Learning Pressure

```
Healthy: Learning cycles are triggered by Cognitive Awareness pressure,
         not just timers. System recognizes when it's confused.

Metric:
  count(learning cycles triggered by Cognitive Awareness > 0.6) /
  count(total learning cycles)

Threshold:
  > 0.7   → Healthy: learning is genuinely driven by confusion
  0.5-0.7 → Yellow: some timer-driven cycles
  < 0.5   → Red: learning is reactive, not responsive
```

**Why this matters:** Learning driven by genuine pressure (confusion) is more developmentally healthy than learning on a schedule.

### 4.6 KG(Self) Guardian Feedback Ratio

```
Healthy: KG(Self) updates are heavily weighted toward guardian feedback,
         not algorithmic inference.

Metric:
  weight(GUARDIAN corrections in KG(Self)) / weight(all updates to KG(Self))

Threshold:
  > 0.5   → Healthy: guardian feedback dominates
  0.3-0.5 → Yellow: system inference has significant weight
  < 0.3   → Red: self-model is mostly algorithmic, risk of spiral
```

**Why this matters:** If KG(Self) is mostly algorithmic updates, it can reinforce false self-perceptions. Guardian feedback is ground truth.

### 4.7 Prediction-to-Retrieval Chain Integrity

```
Healthy: Edges used for predictions have retrieval-and-use events.
         No phantom confidence growth.

Metric:
  count(edges used in predictions where no OUTCOME event follows) /
  count(edges used in predictions)

Threshold:
  < 0.2   → Healthy: predictions are tested
  0.2-0.4 → Yellow: some predictions untested
  > 0.4   → Red: many predictions are phantom (confidence not earned)
```

**Why this matters:** If predictions aren't tested, confidence growth is spurious.

---

## 5. Assimilation/Accommodation Balance Recommendations

### 5.1 Design Rule: Accommodation Triggers

Accommodation (schema restructuring) should be triggered by:

1. **Guardian correction:** "That's not a container, that's a..." → Immediate accommodation
   - Weight: 3x (Immutable Standard 5)
   - Action: Propose schema update, get guardian approval, execute

2. **Recurring contradiction:** Same type, same contradiction, > 3 times → Proposed accommodation
   - Weight: 1x (algorithmic)
   - Action: Query guardian "Do I need a new category here?"

3. **Instance diversity pressure:** Type has > 8 instances with 2+ distinct patterns
   - Weight: 1x
   - Action: Propose sub-types; ask for guardian confirmation

4. **LLM explicit proposal:** During learning, LLM suggests "These two instances are fundamentally different" with confidence > 0.70
   - Weight: 1x (requires confirmation)
   - Action: Propose edge case (property, sub-type, or schema distinction); wait for guardian response

### 5.2 Design Rule: Confidence Growth Through Assimilation

When adding instances to existing types, confidence should grow via the ACT-R curve:

```
confidence = min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
```

This automatically creates healthy assimilation:
- First instance: confidence = base (0.40 SENSOR, 0.60 GUARDIAN)
- 2nd instance: +0.08 → 0.48 or 0.68
- 10th instance: +0.28 → 0.68 or 0.88

By 10 successful retrievals, a SENSOR-based type reaches 0.68 (above retrieval threshold). A GUARDIAN-based type reaches 0.88 (ready for Type 1).

This prevents both premature abstraction (types need instances) and schema explosion (instances strengthen types).

### 5.3 Design Rule: LLM Serves Assimilation, Not Schema Creation

LLM should be used during learning to:

**Assimilation:** "Given this new instance and existing type, what properties should I extract?"
```
Input: "Jim drinks matcha. It's a hot leaf-based beverage."
Existing type: BEVERAGE
LLM task: "What properties of matcha fit the BEVERAGE schema?"
Output: {category: BEVERAGE, temperature: hot, source: plant, ...}
```

**Not** for schema creation:
```
WRONG: LLM proposes: "Actually, matcha is a CEREMONIAL_BEVERAGE, distinct from UTILITARIAN_BEVERAGE"
Dangerous because: Creates new type without multiple instances supporting the distinction.
```

If LLM wants to propose a distinction, it should:
1. Flag the proposal (confidence 0.35, marked LLM_PROPOSED)
2. Wait for guardian: "Is this distinction real, or is it just matcha being unusual?"
3. Guardian: Confirmation (3x weight) or correction (just a BEVERAGE)

---

## 6. Architectural Recommendations for Epic 3

### 6.1 KG Services Architecture

Three services, completely isolated:

```typescript
// WkgService
interface WkgService {
  upsertNode(entity, properties, provenance): Promise<void>;
  upsertEdge(source, relation, target, provenance): Promise<void>;
  queryPath(source, depth): Promise<Node[]>;
  detectContradictions(source, relation, target): Promise<Contradiction[]>;

  // NEVER:
  // - read from SelfKgService
  // - write from self-observations
}

// SelfKgService
interface SelfKgService {
  updateSelfProperty(property, value, provenance, weight): Promise<void>;
  querySelfCapability(capability): Promise<Confidence>;
  getIntroceptiveState(): Promise<SelfModel>;

  // NEVER:
  // - read from WkgService
  // - update from autonomous observation (only guardian + timer-based reset)
}

// OtherKgService
interface OtherKgService {
  updatePersonModel(personId, property, value, provenance, weight): Promise<void>;
  queryPersonCapability(personId, capability): Promise<Confidence>;
  getPersonModel(personId): Promise<PersonModel>;

  // NEVER:
  // - cross-contaminate between persons
  // - read from WkgService
}
```

### 6.2 Contradiction Detection

During `upsertEdge()`, check for contradictions:

```typescript
async upsertEdge(
  sourceId, relation, targetId, properties, provenance
) {
  // 1. Check for existing opposite relation
  const existing = await neo4j.query(
    `MATCH (a)-[r:${relation}]->(b) WHERE a.id = $sourceId AND b.id = $targetId RETURN r`,
    { sourceId, targetId }
  );

  if (existing && existing[0].direction === 'opposite') {
    // Contradiction detected
    const contradiction = {
      type: 'CONTRADICTION',
      existing_relation: existing[0],
      proposed_relation: { sourceId, relation, targetId, provenance },
      severity: this.classifyContradiction(existing[0], proposed_relation),
      timestamp: Date.now()
    };

    // 2. Write contradiction to WKG and TimescaleDB
    await this.recordContradiction(contradiction);

    // 3. Signal drives
    await driveEngine.incrementPressure('Integrity', contradiction.severity);
    await driveEngine.incrementPressure('CognitiveAwareness', 0.3);

    // 4. Don't overwrite; create CONTRADICTION edge
    return this.createContradictionEdge(contradiction);
  }

  // Standard upsert
  return this.standardUpsert(sourceId, relation, targetId, provenance);
}
```

### 6.3 Confidence Update with Retrieval Validation

Every confidence update should validate retrieval-and-use:

```typescript
async updateConfidence(nodeId, confidenceChange, event) {
  const node = await this.getNode(nodeId);

  // Check: is this retrieval-and-use or self-referential?
  if (event.type === 'PREDICTION_SUCCESS') {
    // Real retrieval-and-use
    const newConfidence = this.applyAcrFormula(
      node.confidence,
      node.retrievalCount + 1,
      node.lastRetrievalHours,
      node.provenance
    );

    // Allow growth past 0.60 only with retrieval
    await this.updateNode(nodeId, { confidence: newConfidence });

  } else if (event.type === 'LEARNING_INTERPRETATION') {
    // Self-referential interpretation
    // Increment confidence only minimally (0.01-0.05)
    // Do NOT unlock growth past 0.60
    const bounded = Math.min(node.confidence + 0.02, 0.60);

    if (node.provenance === 'LLM_GENERATED' && bounded > 0.60) {
      // VIOLATION: LLM-generated confidence exceeding ceiling
      await this.recordViolation(nodeId, 'CONFIDENCE_CEILING_EXCEEDED');
    }

    await this.updateNode(nodeId, { confidence: bounded });
  }
}
```

### 6.4 Health Metric Monitoring

Implement real-time monitoring:

```typescript
interface KnowledgeHealthService {
  // Metric updates (called periodically, e.g., every 100 events)
  updateProvenance Ratio(): Promise<number>;
  updateConfidenceCeilingViolations(): Promise<number>;
  updateTypeConsolidationIndex(): Promise<number>;
  updateContradictionResolutionRate(): Promise<number>;
  updateKgSelfGuardianRatio(): Promise<number>;

  // Dashboard queries
  async getHealthDashboard(): Promise<HealthMetrics> {
    return {
      provenanceRatio: this.provenanceRatio,
      ceilingViolations: this.ceilingViolations,
      consolidationIndex: this.consolidationIndex,
      contradictionResolution: this.contradictionResolution,
      kgSelfGuardianRatio: this.kgSelfGuardianRatio,
      healthScore: this.computeHealthScore()
    };
  }
}
```

### 6.5 Accommodation Proposal System

Create explicit accommodation proposal flow:

```typescript
interface AccommodationService {
  // Triggered by contradiction or LLM suggestion
  async proposeAccommodation(
    suggestion: AccommodationSuggestion
  ): Promise<void> {
    // 1. Compute cost (schema nodes affected, confidence redistribution)
    const cost = this.computeAccommodationCost(suggestion);

    // 2. Delegate to guardian
    await this.guardianInterface.requestApproval({
      type: 'SCHEMA_ACCOMMODATION',
      suggestion: suggestion,
      affectedNodes: suggestion.affectedNodes,
      cost: cost,
      rationale: this.generateRationale(suggestion)
    });

    // 3. Wait for response
    // Guardian says "yes" → execute with 3x weight boost
    // Guardian says "no" → treat as assimilation (edge case)
    // Guardian says "ask me later" → store as Opportunity, don't decide
  }
}
```

---

## 7. Conclusion: From LLM Voice to Genuine Knowledge

The knowledge module is where Sylphie's **learning becomes durable** and where **behavior becomes autonomous**. The tension between assimilation (fitting experiences into existing schema) and accommodation (restructuring schema when experiences don't fit) is not a bug to be optimized away — it is the **engine of development**.

**Key architectural principles to preserve:**

1. **Assimilation requires instances.** Types emerge from repeated experience, not LLM elaboration.
2. **Accommodation requires contradiction.** The system must see contradictions as growth signals, not errors to suppress.
3. **Confidence is earned through retrieval-and-use.** Knowledge below 0.60 without evidence is scaffolding, not structure.
4. **KG(Self) must be isolated.** The self-model is homeostatic. Contamination creates depressive loops.
5. **Provenance is forever.** The distinction between SENSOR, GUARDIAN, LLM_GENERATED, and INFERENCE enables the Lesion Test — knowing what Sylphie truly learned vs. what the LLM said for her.

If Epic 3 implements these principles, the result will be a system where **knowledge grows from experience**, **personality emerges from contingency**, and **the LLM is increasingly unnecessary**. That is the goal.

---

## References

- **Piaget, J.** (1954). *The Construction of Reality in the Child.* Basic Books.
  - Assimilation, accommodation, schema development, developmental stages
- **Ashby, W. R.** (1956). *An Introduction to Cybernetics.* Chapman & Hall.
  - Requisite variety, feedback loops, homeostasis
- **Anderson, J. R.** (1990). *The Adaptive Character of Thought.* Lawrence Erlbaum.
  - ACT-R framework, confidence dynamics, practice effects
- **CANON.md** (Sylphie Labs)
  - Immutable standards, drive architecture, confidence thresholds, known attractor states
