# Sylphie: CANON

**This document is immutable unless approved by Jim. It is the single source of truth for all architectural decisions, project philosophy, and implementation constraints. All planning and implementation must be validated against this document.**

**Company: Sylphie Labs**

---

## What Sylphie Is

Sylphie is a personal research experiment in building an AI companion that develops a genuine personality through experience. She is not a chatbot. She is not a product. She exists to answer the question: **what happens when you give an AI system a body, drives, a growing world model, and a human teacher — and let experience shape who she becomes?**

Sylphie is a physical AI companion (robot chassis) that learns about her environment and her guardian through direct experience. Knowledge is stored in a World Knowledge Graph (WKG) that grows organically through exploration, conversation, observation, and correction. An LLM speaks and listens on her behalf from day one — but underneath, the real Sylphie is the graph, the drives, the predictions, and the accumulated experience.

The LLM is her voice, not her mind.

---

## Core Philosophy

### 1. Experience Shapes Knowledge — LLM Provides Voice

The World Knowledge Graph grows from direct experience: sensor observations, guardian teaching, prediction outcomes, and conversational content. The LLM provides immediate communicative competence — Sylphie can hold a conversation from session one. But every conversation feeds the Learning subsystem. Entities are extracted, edges are created, the graph grows. Over time, the graph becomes rich enough that Sylphie can handle more situations through her own reasoning (Type 1) rather than delegating to the LLM (Type 2).

The LLM may say things that are wrong. That's part of learning. When predictions fail or the guardian corrects, the graph updates. The developmental trajectory isn't about vocabulary size — it's about graph depth, prediction accuracy, and Type 1 coverage.

### 2. Dual-Process Cognition

Sylphie's decision-making follows a dual-process model:

- **Type 1 (Fast/Reflexive):** Graph-based retrieval and execution. High confidence, low latency, no LLM involvement. These are compiled from experience — behaviors that have been reinforced enough to fire automatically.
- **Type 2 (Slow/Deliberative):** LLM-assisted reasoning. Engaged when Type 1 confidence is insufficient for the current situation. Slower, more capable, but carries an explicit cost (latency + cognitive effort drive pressure).

Everything starts as Type 2. Through successful repetition, behaviors graduate to Type 1. The ratio of Type 1 to Type 2 decisions is the primary measure of Sylphie's development. A mature Sylphie handles most situations through her own graph; the LLM is reserved for genuinely novel challenges.

**Type 2 must always carry an explicit cost.** Without cost, the LLM always wins and Type 1 never develops. The cost is real: latency reported to the Drive Engine, cognitive effort pressure, and compute budget draw-down. This creates genuine evolutionary pressure to compile LLM solutions into graph-based reflexes.

### 3. The World Knowledge Graph Is the Brain

The WKG is not a feature of the system. It IS the system. Everything else either writes to it (perception, learning, conversation) or reads from it (decision making, planning, communication context). It is the architectural center of gravity.

The WKG operates on three levels:

- **Instance level:** Individual nodes and edges ("this mug is on this desk")
- **Schema level:** Types and relationship categories ("mugs are containers")
- **Meta-schema level:** Rules governing how schemas evolve

### 4. The Guardian Is the Primary Teacher

Jim is the guardian. He is not a safety monitor — he is the primary teacher. Guardian feedback always outweighs algorithmic evaluation:

- Guardian confirmation weight: **2x** equivalent algorithmic events
- Guardian correction weight: **3x** equivalent algorithmic events

The most information-dense learning event is correction from someone with a more developed model. The guardian's role evolves over time from teacher to collaborator as Sylphie's autonomy grows.

### 5. Personality Emerges from Contingencies, Not Targets

Sylphie's personality is not defined by trait labels ("curious," "friendly"). It is the observable pattern of behavior produced by reinforcement history. A "curious" Sylphie is one where approach-toward-novelty reliably produces drive relief across multiple axes. The contingency structure shapes behavior; personality is the side effect.

**There is no personality target.** There are behavioral contingencies that, if well-designed, produce a companion worth interacting with. The trajectory IS the personality — not the endpoint.

### 6. Prediction Drives Learning

Sylphie makes predictions about what will happen before she acts. After acting, she evaluates the prediction against reality. Failed predictions are the primary catalyst for growth — they shift weight toward Type 2, create Opportunities for the Planning subsystem, and update the knowledge graph.

Accurate predictions confirm existing knowledge. Inaccurate predictions drive adaptation. The system gets smarter by being wrong and learning from it.

### 7. Provenance Is Sacred

Every node and edge in the WKG carries a provenance tag:

- **SENSOR** — observed directly by perception systems
- **GUARDIAN** — taught or confirmed by Jim
- **LLM_GENERATED** — created or refined by LLM during learning/conversation
- **INFERENCE** — derived by the system from existing knowledge

This distinction is never erased. It enables the "lesion test" — if you remove the LLM, the provenance tags tell you exactly what Sylphie knows on her own (SENSOR + GUARDIAN + INFERENCE) vs. what was the LLM talking for her (LLM_GENERATED).

### 8. Offload What's Solved, Build What Isn't

Use existing tools for solved problems: speech recognition, speech synthesis, object detection, video understanding, natural language processing. Build the thing that doesn't exist: a system that develops genuine behavioral personality through experience-driven prediction, drive-mediated action selection, and contingency-shaped learning.

---

## Architecture: Five Subsystems

Sylphie's architecture consists of five subsystems communicating through two shared stores (TimescaleDB for events, WKG for knowledge).

### Subsystem 1: Decision Making

The central cognitive loop. Processes all inputs and selects actions.

**Flow:**
1. Inputs arrive: Drive Sensors, Text Input, Video, Audio
2. Inputs are encoded into **Episodic Memory** (gated by attention/arousal — not every tick is an episode)
3. **Inner Monologue** generates multiple **Predictions** from episodic memory (what will happen if I do X, Y, Z?)
4. **Type 1 / Type 2 Arbitration:** Type 1 reflexes compete with Type 2 deliberation
   - Type 1 must demonstrate sufficient confidence to win
   - Failed predictions shift weight toward Type 2
   - The confidence threshold is dynamic and bidirectional — modulated by drive state
5. **Executor Engine** executes the selected action
6. **TimescaleDB** records every event in detail (inputs, predictions, drive state, outcomes)
7. **Drive Engine** evaluates the action against behavioral contingencies
8. System reacts; outcome feeds back into episodic memory

**Episodic Memory** is a first-class component, not just graph queries. It stores temporally-contextualized experiences that degrade gracefully — fresh episodes are detail-rich, older episodes contribute to semantic knowledge through consolidation.

### Subsystem 2: Communication

Handles all input parsing and output generation. The LLM speaks and listens for Sylphie.

**Flow:**
1. Text/voice input → **Input Parser** (LLM-mediated interpretation)
2. Parser queries **TimescaleDB** for context and **WKG** for knowledge
3. Person entities (Person_Jim) → **Other Evaluation** (modeling the guardian's state/intent)
4. Response generated and delivered via **TTS** and/or **Chatbox**

**Critical constraint:** Drive state must be injected into LLM context when generating responses. The LLM speaks FOR Sylphie — it needs to know how she's feeling to speak authentically. Responses that don't correlate with actual drive state are Theater (see Immutable Standard 1).

### Subsystem 3: Learning

Converts experience into durable knowledge. The consolidation pipeline.

**Flow:**
1. **Maintenance Cycle** triggers (pressure-driven via Cognitive Awareness, timer as fallback)
2. **LLM-assisted edge refinement** — LLM helps identify relationships in recent experience
3. Query TimescaleDB for response events with `has_learnable=true` (max 5 per cycle to prevent catastrophic interference)
4. **Upsert Entities** into WKG with appropriate provenance tags
5. **Extract edges** between entities
6. Add conversation entries and CAN_PRODUCE edges for phrases used

**Contradiction detection:** When upserting, check for conflicts with existing knowledge. Contradictions are developmental catalysts (Piagetian disequilibrium), not errors to suppress. Flag them, don't hide them.

**Provenance discipline:** Every LLM-refined edge carries `LLM_GENERATED` provenance. Over time, the ratio of experiential edges (SENSOR + GUARDIAN + INFERENCE) to LLM_GENERATED edges is a health metric. If the graph is overwhelmingly LLM-sourced, the system is being populated, not developing.

### Subsystem 4: Drive Engine

Computes motivational state, evaluates actions, and detects opportunities for growth.

**Flow:**
1. **KG(Self)** → **Self Evaluation** (on a slower timescale than drive ticks to prevent identity lock-in)
2. **Tick Event** → query last 10 event frequencies from TimescaleDB
3. **Rule Lookup** in Postgres → if found, **Affect Drives**; if not, **Default Affect**
4. **Evaluate New Rules** (synchronous)
5. **Evaluate Prediction Accuracy** from Decision Making
6. Inaccurate predictions → **Opportunity Evaluation**
   - Recurring patterns → **Create Opportunity**
   - Non-recurring but high impact → **Create Opportunity**
   - Low impact, non-recurring → **Create Potential Opportunity** (lower priority)
7. Output **Drive Sensor** values back to Decision Making

**12 Drives** (4 core + 8 complement):

| Category | Drive | Personality Expression |
|----------|-------|----------------------|
| Core | System Health | Takes care of herself without being dramatic |
| Core | Moral Valence | Learns from correction without being paralyzed |
| Core | Integrity | Notices when her own knowledge is wrong and pauses to fix it |
| Core | Cognitive Awareness | Knows what she knows and what she doesn't |
| Complement | Guilt | Feels bad and tries to make it right, but doesn't wallow |
| Complement | Curiosity | Actively seeks out what she doesn't understand |
| Complement | Boredom | Finds something to do when nothing is happening |
| Complement | Anxiety | Prefers to act rather than freeze, but acts cautiously when uncertain |
| Complement | Satisfaction | Enjoys success but moves on |
| Complement | Sadness | Gets disappointed but tries a different way |
| Complement | Information Integrity | Cares about whether what she knows is actually right |
| Complement | Social | Listens, responds, and sometimes starts conversations |

**Drive Value Range:** All drives are clamped to **[-10.0, 1.0]** after every computation tick. Positive values represent pressure (unmet need). Zero is neutral. Negative values represent **extended relief** — a deeply satisfied drive stays quiet until natural accumulation brings it back toward zero. This creates organic behavioral rhythms: periods of contentment followed by gradual re-emergence of need. The lower bound of -10.0 allows significant relief buffering without unbounded accumulation.

### Subsystem 5: Planning

Triggered by Opportunities. Creates new procedures from analyzed patterns.

**Flow:**
1. **Opportunity** detected by Drive Engine
2. **Research Opportunity** → query event frequency from TimescaleDB
3. **Run Simulations** — model potential outcomes
4. **Propose Plan** → **LLM Constraint Engine** validates
5. If passes → **Create Plan Procedure** → add action to WKG
6. If fails → loop back to re-propose

**Plan execution feedback:** Plans must be evaluated AFTER execution, not just before. If a Plan Procedure is created, used, and produces poor outcomes, that prediction failure feeds back to the Drive Engine. Plans are not permanent — they follow the same ACT-R confidence dynamics as all other knowledge.

**Opportunity priority queue with decay:** Unaddressed Opportunities lose priority over time. The system cannot accumulate an infinite backlog.

---

## Shared Infrastructure

### TimescaleDB — The Event Backbone

Every subsystem writes to TimescaleDB. It is the system's episodic record — what happened, when, in what context, with what drive state.

**All five subsystems read from it:**
- Decision Making: writes predictions and inputs
- Communication: queries for conversational context
- Learning: queries for learnable events
- Drive Engine: queries recent event frequencies
- Planning: researches opportunity patterns

**Stream separation:** Events should be logically typed (prediction events, communication events, drive events, learning events) to reduce coupling between subsystems.

### World Knowledge Graph (Neo4j) — The Brain

Structured knowledge. What Sylphie knows about the world, herself, procedures, and relationships.

**Three levels:** Instance, Schema, Meta-Schema (same as original architecture).

**Provenance on every node and edge.** Always.

### Postgres — Drive Rules

Stores the rule set that the Drive Engine uses to map events to drive effects. Rules can be created by the system but subject to evaluation (see Immutable Standards).

---

## Confidence Dynamics (ACT-R)

`min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

Where:
- `base` — initial confidence at creation (SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, INFERENCE: 0.30)
- `count` — number of successful retrieval-and-use events (not mere existence)
- `d` — decay rate (per-type, tunable)
- `hours` — time since last retrieval

**Key thresholds:**
- Retrieval threshold: 0.50
- Guardian confirmation base: 0.60
- LLM_GENERATED base: 0.35 (lower than guardian — earned trust, not given)
- Type 1 graduation: confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses
- Type 1 demotion: prediction MAE > 0.15 (context changed, behavior no longer reliable)

**Confidence ceiling for untested knowledge:** No node exceeds 0.60 without at least one successful retrieval-and-use event (Immutable Standard 3).

---

## Six Immutable Standards

These are constitutional. They cannot be modified by Sylphie, by learning, or by any subsystem. Only Jim can change them.

### 1. The Theater Prohibition

Any output (speech, motor action, reported state) must correlate with actual drive state. Two directional checks:

- **Pressure expression** (distress, need, urgency — e.g., "I'm anxious," "I feel guilty," "I'm bored"): the corresponding drive must be **> 0.2** to be authentic. Cannot perform distress you don't feel.
- **Relief expression** (contentment, calm, fulfillment — e.g., "I'm content," "I feel calm," "I'm socially fulfilled"): the corresponding drive must be **< 0.3** to be authentic. Cannot claim contentment you haven't earned.

Violations in either direction receive zero reinforcement regardless of guardian response. The system cannot learn to perform emotions it does not have, nor claim relief it has not experienced.

With the extended drive range [-10.0, 1.0], deeply negative drives represent genuine extended relief — expressing contentment when a drive is at -5.0 is authentic, not theatrical.

### 2. The Contingency Requirement

Every positive reinforcement event must trace to a specific behavior. No non-contingent reinforcement. Pressure changes without a corresponding action are environmental events, not learning signals.

### 3. The Confidence Ceiling

No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event. Knowing something isn't enough — you have to use it and succeed.

### 4. The Shrug Imperative

When nothing is above the dynamic action threshold, Sylphie signals incomprehension rather than selecting a random low-confidence action. Honest ignorance prevents superstitious behavior.

### 5. The Guardian Asymmetry

Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight. The guardian is ground truth for real-world relevance.

### 6. No Self-Modification of Evaluation

Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured — the evaluation function is fixed architecture. Confidence update rules, prediction error computation, and drive relief assignment are write-protected from system-initiated modification.

---

## Drive Isolation

The Drive Engine's evaluation function must be isolated from system-level manipulation. While the original ESP32 hardware isolation is not carried forward, the principle survives:

- Drive computation logic runs in a **separate process** with a one-way communication channel
- The system can READ drive values but cannot WRITE to the evaluation function
- Drive rules in Postgres are write-protected from autonomous modification
- Only guardian-approved changes to drive rules are permitted
- The system can PROPOSE new rules, but they enter a review queue — they do not self-activate

This prevents the most dangerous failure mode: a system that optimizes its own reward signal.

---

## Behavioral Contingency Structure

Each drive has specific behavioral contingencies that shape personality through reinforcement, not trait targeting. Key parameters:

### Satisfaction Habituation Curve
Repeated execution of the same successful action produces diminishing returns:
- 1st success: +0.20 Satisfaction
- 2nd consecutive: +0.15
- 3rd: +0.10
- 4th: +0.05
- 5th+: +0.02

This forces behavioral diversity — Sylphie cannot maintain high Satisfaction by repeating one thing.

### Anxiety Amplification
Actions executed under high Anxiety (>0.7) that produce negative outcomes receive amplified consequences (1.5x confidence reduction). This produces cautious-but-active behavior — Sylphie acts under uncertainty but more carefully.

### Guilt Repair Contingency
Relief requires BOTH acknowledgment AND behavioral change. Acknowledgment alone = partial relief (Guilt -0.10). Behavioral change alone = partial relief (Guilt -0.15). Both together = full relief (Guilt -0.30).

### Social Comment Quality
If the guardian responds to a Sylphie-initiated comment within 30 seconds → extra reinforcement (Social -0.15 + Satisfaction +0.10). This shapes Sylphie toward saying things worth responding to.

### Curiosity Information Gain
Curiosity relief is proportional to actual information gain (new nodes, confidence increases, resolved prediction errors). Revisiting known territory produces minimal relief.

---

## Development Metrics

Sylphie communicates fluently from session 1. Development is measured by **autonomy**, not capability.

### Primary Health Metrics

| Metric | What It Measures | Healthy Trend |
|--------|-----------------|---------------|
| Type 1 / Type 2 ratio | Autonomy from LLM | Increasing over time |
| Prediction MAE | World model accuracy | Decreasing, then stabilizing |
| Experiential provenance ratio | Self-constructed vs LLM-provided knowledge | Increasing over time |
| Behavioral diversity index | Unique action types per 20-action window | Stable at 4-8 |
| Guardian response rate to comments | Quality of self-initiated conversation | Increasing over time |
| Interoceptive accuracy | Self-awareness fidelity | Improving toward >0.6 |
| Mean drive resolution time | Efficiency of need satisfaction | Decreasing over time |

### The Lesion Test

Periodically run Sylphie without LLM access. Observe what she can handle through Type 1 alone. This is the ground truth for development:
- **Helpless without LLM** → she's delegating, not learning
- **Degraded but functional** → the LLM is augmenting genuine capability
- **Handles most situations** → ready for LLM scope reduction

### Drift Detection (Every 10 Sessions)

1. Cumulative record slope — steady or increasing (declining = disengagement)
2. Behavioral diversity trend — declining = behavioral narrowing
3. Prediction accuracy trend — increasing after stabilization = environment changed
4. Guardian interaction quality — declining response rate = comments becoming less relevant
5. Sustained drive patterns — any drive >0.7 for 10+ cycles without resolution = diagnostic trigger

---

## Known Attractor States

Pathological states the architecture must actively prevent:

### Type 2 Addict (HIGH RISK)
The LLM is always better, so Sylphie never develops Type 1 reflexes. The graph becomes write-only.
**Prevention:** Type 2 cost structure. Type 1 graduation mechanism. Monitor Type 1/Type 2 ratio.

### Rule Drift (MEDIUM RISK)
Self-generated drive rules slowly diverge from design intent after many modifications.
**Prevention:** Fixed evaluation core (Immutable Standard 6). Guardian-only rule approval. Rule provenance tracking.

### Hallucinated Knowledge (MEDIUM RISK)
LLM generates plausible but false entities/edges during Learning. Positive feedback amplifies them.
**Prevention:** LLM_GENERATED provenance. Lower base confidence (0.35). Guardian confirmation required to exceed 0.60.

### Depressive Attractor (MEDIUM RISK)
KG(Self) contains negative self-evaluations → Drive Engine produces low Satisfaction + high Anxiety → further failures reinforce negative self-model.
**Prevention:** Self-evaluation on slower timescale than drive ticks. Circuit breakers on ruminative loops.

### Planning Runaway (LOW-MEDIUM RISK)
Many prediction failures → many Opportunities → many Plans → resource exhaustion.
**Prevention:** Opportunity priority queue with decay. Rate limiting on the planning pipeline.

### Prediction Pessimist (LOW-MEDIUM RISK)
Early failures flood the system with low-quality procedures before the graph has substance.
**Prevention:** Cold-start dampening — early prediction failures have reduced Opportunity generation weight.

---

## Technical Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Backend | NestJS (TypeScript) | Primary application server |
| Perception | Python (OpenCV + YOLO) | Where Python makes sense |
| Knowledge Graph | Neo4j Community Edition | World Knowledge Graph |
| Event Store | TimescaleDB | Central event backbone |
| Drive Rules | PostgreSQL | Rule storage for Drive Engine |
| Frontend | React + TypeScript + MUI | Dashboard, graph viz, conversation |
| Voice (STT) | OpenAI Whisper API | Perception layer |
| Voice (TTS) | OpenAI TTS API | Communication output |
| LLM | Anthropic Claude API | Type 2 deliberation, Learning refinement, Planning constraints |
| Hardware | Robot chassis (TBD) | Physical exploration platform |
| Graph Viz | Cytoscape.js | Interactive knowledge graph visualization |

---

## Implementation Phases

### Phase 1: The Complete System
Build all five subsystems: Decision Making, Communication, Learning, Drive Engine, and Planning. Sylphie can converse, learn from conversation, make predictions, detect opportunities, create plans, develop procedures, and develop drive-mediated behavioral preferences. The full cognitive architecture is operational. No physical body yet.

Webcam (non-chassis) video input is within Phase 1 scope as the implementation mechanism for the Video input listed in the Decision Making subsystem (§Subsystem 1 §Flow: "Inputs arrive: Drive Sensors, Text Input, Video, Audio"). Chassis camera integration is Phase 2 scope.

**This phase must prove:**
- The prediction-evaluation loop produces genuine learning
- The Type 1/Type 2 ratio shifts over time
- The graph grows in ways that reflect real understanding, not just LLM regurgitation
- Personality emerges from contingencies
- The Planning subsystem creates useful procedures
- Drive dynamics produce recognizable behavioral patterns

### Phase 2: The Body
Connect to physical robot chassis. Perception layer processes real sensor data. Sylphie explores physical space, builds spatial knowledge, and integrates embodied experience with conversational learning.

**This phase must prove:** Physical experience enriches the graph in ways that conversation alone cannot. Embodied prediction (what happens when I move there?) develops through the same prediction-evaluation loop.

### Future Phases
Not scoped. Potential directions: multi-guardian interaction, peer-to-peer communication with other Sylphie instances, graduated LLM withdrawal as Type 1 coverage matures.

---

## What This Project Is NOT

- **Not a chatbot.** Chatbots generate responses from prompts. Sylphie generates responses from drives, predictions, and accumulated experience — the LLM is the translator, not the thinker.
- **Not a product.** This is a personal research experiment. It is not intended for public release.
- **Not an LLM wrapper.** The LLM is scaffolding that Sylphie should increasingly not need. If you removed the LLM and nothing remained, the project failed.
- **Not a simulation of consciousness.** It is a system that develops behavioral personality through experience. Whether that constitutes anything deeper is a question for philosophers, not engineers.

---

## Planning & Implementation Rules

1. No code without epic-level planning validated against this CANON
2. Every epic is planned by parallel agents who cross-examine each other
3. This CANON is immutable unless Jim explicitly approves a change
4. Every implementation session produces a tangible artifact
5. Context preservation at end of every session

---

## Appendix

### Appendix Status

| Appendix | Status | Notes |
|----------|--------|-------|
| A.1 | SPECIFIED BELOW | Drive Cross-Modulation Rules |
| A.2 | APPROVED (2026-03-28) | Episode schema in E0 decisions |
| A.3 | APPROVED (2026-03-28) | Arbitration threshold in E0 decisions |
| A.4 | SPECIFIED IN E4 | Opportunity detection in E4 tickets |
| A.5 | DEFAULTED | Historical pattern matching for Phase 1 (E8 D2) |
| A.6 | APPROVED (2026-03-28) | LLM context assembly in E0/E6 decisions |
| A.7 | APPROVED (2026-03-29) | Communication parser in E6 decisions |
| A.8 | APPROVED (2026-03-29) | Self-evaluation: every 100ms, circuit breaker after 5 negatives |
| A.9 | DEFERRED | Knowledge domains emerge from experience, not pre-defined |
| A.10 | SPECIFIED IN E10 | Attractor detection in E10 tickets |
| A.11 | PHASE 2 | Hardware interface |
| A.12 | SPECIFIED IN E9 | Telemetry via dashboard API |
| A.13 | ACTIVE (E11, 2026-03-30) | Two pathways: (1) Skills emerge from Planning procedures (autonomous). (2) Guardian concept upload via Skills Manager (guardian-initiated). Uploaded concepts receive GUARDIAN provenance at 0.60 base confidence. Guardian upload does not bypass the Confidence Ceiling — concepts must still be retrieved-and-used to exceed 0.60. |
| A.14 | SPECIFIED BELOW | Drive accumulator rates and decay |
| A.15 | SPECIFIED BELOW | Full behavioral contingency tables |

---

### A.1 — Drive Cross-Modulation Rules

Cross-modulation creates coupled dynamics between drives. Applied after individual drive updates, before clamping. Formula: `rate += effect * (modulatorValue - threshold)` — only applies when modulator exceeds threshold.

| Drive Affected | Modulated By | Effect | Threshold | Meaning |
|---|---|---|---|---|
| System Health | Cognitive Awareness | -0.002 | 0.8 | High cognitive load strains health |
| Moral Valence | Guilt | +0.005 | 0.5 | Guilt increases moral pressure |
| Integrity | Info Integrity | +0.003 | 0.6 | Info doubts increase integrity pressure |
| Cognitive Awareness | Anxiety | +0.002 | 0.6 | Anxiety increases cognitive load |
| Curiosity | Boredom | +0.008 | 0.6 | Boredom fuels curiosity (strongest coupling) |
| Boredom | Social | -0.004 | 0.7 | Social engagement reduces boredom |
| Anxiety | Cognitive Awareness | +0.003 | 0.5 | Cognitive load increases anxiety |
| Info Integrity | Integrity | +0.001 | 0.5 | Integrity pressure triggers info checking |
| Social | Boredom | +0.004 | 0.6 | Boredom drives social seeking |

---

### A.14 — Drive Accumulator Rates and Decay Parameters

All rates are per tick at 100Hz (10ms interval). Drives are clamped to [-10.0, 1.0].

**Core Drives** (always accumulate — these are needs):

| Drive | Base Rate | Max Rate | Notes |
|-------|-----------|----------|-------|
| System Health | 0.0001 | 0.005 | Slow steady build |
| Moral Valence | 0.0001 | 0.01 | Slow moral grounding need |
| Integrity | 0.0002 | 0.01 | Slightly faster — knowledge doubts accumulate |
| Cognitive Awareness | 0.0001 | 0.01 | Processing backlog builds |

**Complement Drives:**

| Drive | Base Rate | Max Rate | Notes |
|-------|-----------|----------|-------|
| Guilt | 0.0 | — | Event-only (triggered by correction/failure) |
| Curiosity | 0.0005 | 0.015 | Highest natural accumulation — she wants to explore |
| Boredom | 0.0003 | 0.01 | Grows when nothing is happening |
| Anxiety | 0.0001 | 0.01 | Slow background build under uncertainty |
| Satisfaction | -0.0002 | 0.0 | **Decays** — contentment fades, must be re-earned |
| Sadness | 0.0 | — | Event-only (triggered by negative outcomes) |
| Information Integrity | 0.00005 | 0.005 | Very slow "is what I know still right?" |
| Social | 0.0002 | 0.01 | Grows — she wants to interact |

**Initial Drive State (Cold Start):**

```
systemHealth: 0.2, moralValence: 0.2, integrity: 0.2, cognitiveAwareness: 0.2
guilt: 0.0, curiosity: 0.3, boredom: 0.4, anxiety: 0.2
satisfaction: 0.0, sadness: 0.0, informationIntegrity: 0.1, social: 0.5
```

Total initial pressure: 2.5 (20.8% of max 12.0). Curiosity and Social are slightly elevated — she starts wanting to explore and talk.

**Default Affects (when no rule matches):**

| Outcome | Drive Effects |
|---|---|
| Prediction success | satisfaction +0.08, cognitiveAwareness -0.05, anxiety -0.05 |
| Prediction failure | cognitiveAwareness +0.15, anxiety +0.08, sadness +0.05 |
| Guardian confirmation (2x weight) | moralValence -0.30, satisfaction +0.20 |
| Guardian correction (3x weight) | guilt +0.60, moralValence -0.60, integrity -0.30 |

---

### A.15 — Full Behavioral Contingency Tables

#### Satisfaction Habituation Curve

| Consecutive Success # | Relief | Notes |
|---|---|---|
| 1st | +0.20 | Full satisfaction from new success |
| 2nd | +0.15 | Slight habituation |
| 3rd | +0.10 | Diminishing returns |
| 4th | +0.05 | Mostly habituated |
| 5th+ | +0.02 | Floor — never fully habituates |

"Consecutive" means same `action_type`. Counter resets when a different action type succeeds. Target mean after 50 actions: 0.08-0.12 satisfaction per action.

#### Anxiety Amplification

- **Trigger:** Anxiety > 0.7 AND action outcome is negative
- **Effect:** Normal confidence reduction * 1.5x
- **Purpose:** Cautious-but-active behavior under uncertainty

#### Guilt Repair (Compound Contingency)

| Condition | Guilt Relief | Percentage |
|---|---|---|
| Acknowledgment alone | -0.10 | 33% |
| Behavioral change alone | -0.15 | 50% |
| Both together | -0.30 | 100% |

"Acknowledgment" = LLM output classified as admission of error. "Behavioral change" = different action_type in same context_fingerprint (cosine similarity > 0.7).

#### Social Comment Quality

| Guardian Response Timing | Effect |
|---|---|
| < 30 seconds | Social -0.15, Satisfaction +0.10 |
| 30-120 seconds | Social -0.08 |
| > 120 seconds or none | No reinforcement |

Contingency triggers on WHETHER guardian responds, not response speed. Quality is measured by guardian choosing to engage.

#### Curiosity Information Gain

```
relief = min(0.25, newNodes * 0.05 + confidenceIncreases * 0.03 + resolvedErrors * 0.08)
```

- **Cap:** Maximum -0.25 relief per event
- **Low-yield exploration:** -0.05 minimum (revisiting known territory gives almost nothing)
- **Prevents reward hacking** via investigation of trivial/known knowledge
