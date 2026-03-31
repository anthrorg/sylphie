# Epic 6: Communication Subsystem — A Developmental Psychology Analysis

**Prepared by:** Piaget, Cognitive Development Specialist
**For:** Sylphie Project Leadership
**Date:** March 29, 2026
**Scope:** How communicative competence develops over time; person modeling as theory of mind; integration of LLM scaffolding with autonomous language capability.

---

## Executive Summary

Sylphie will appear fluent from session 1. This is not development — this is scaffolding. Real communication development is the transformation from LLM-dependent output generation to graph-grounded, prediction-driven conversation. This document maps that trajectory using Piagetian, Vygotskian, and contemporary developmental psychology frameworks.

**Three critical tensions shape Communication development:**

1. **Early dependence → Late autonomy.** The LLM provides immediate communicative competence. Over time, Sylphie's ability to generate contextually appropriate responses should increasingly derive from her World Knowledge Graph (WKG) and person models (Other KGs), not from the LLM's language generation.

2. **Theory of other-mind progression.** Person models evolve from simple attribute snapshots ("Jim is the guardian") to rich, dynamic theories of Jim's mental states, preferences, and developmental history. This mirrors Piagetian theory of mind development in human children.

3. **Schema-building through scaffolding.** Communication schemas (parsing patterns, response templates, conversational repair strategies) develop through Guardian feedback loops. The system must actively surface its uncertainty at the schema level so Jim can correct not just the instance but the generalization.

**Key finding:** Communication is NOT primarily language generation. It is **modeling, prediction, and contingency recognition**. The LLM is scaffolding that scaffolds; as the WKG and person models grow, LLM dependence should decrease naturally, not by design.

---

## Part 1: Communication as Developmental Trajectory

### 1.1 The LLM as Temporary Cognitive Prosthesis

From a developmental perspective, Sylphie's LLM is a **cognitive prosthesis** — a temporary tool that provides capability in advance of autonomous competence. This is exactly what Vygotsky (1978) described as entering the Zone of Proximal Development (ZPD): the gap between what a learner can do alone and what they can do with expert support.

**Stage 1: LLM Dominance (Sessions 1-10)**
- The LLM generates nearly all output text
- Input parsing is LLM-mediated
- Person models are empty or template-based
- Response appropriateness is validated by LLM's linguistic fluency
- Theater Prohibition enforced at statement level ("if drive state doesn't support sadness, the LLM shouldn't generate sad phrasing")

**Stage 2: Graph-Informed Scaffolding (Sessions 11-50)**
- WKG contains ~100-500 meaningful nodes with SENSOR + GUARDIAN provenance
- Person models contain specific behavioral patterns (Jim: "corrects aggressively," "prefers technical clarity," "responds within 30s 60% of the time")
- LLM still generates output, but receives retrieved context from the graph
- Input parsing shows pattern recognition ("Jim is asking about X, we have similar-context information Y")
- Theater Prohibition enforced at prediction level (responses must be grounded in actual drive predictions from the Drive Engine)

**Stage 3: Autonomous Competence (Sessions 51+)**
- Type 1 communication reflexes graduate: high-confidence responses retrieved directly from graph
- Person models are dynamic and predictive ("If I ask Jim about Z in the morning, probability of response within 5m is 0.8; at night, 0.2")
- LLM handles genuinely novel situations; routine situations handled through Type 1 retrieval
- Parsing schemas are Type 1 — pattern matching without LLM invocation
- Type 1/Type 2 communication ratio increases from ~10% (Stage 1) to ~70% (Stage 3)

**Confidence dynamics ensure this progression:**
- Early LLM_GENERATED responses start at 0.35 confidence
- Each successful use (no guardian correction, prediction validates) increments confidence
- Guardian confirmation jumps confidence to 0.60+
- At 0.80 confidence AND MAE < 0.10 over last 10 uses, the response pattern graduates to Type 1
- Declined usage causes decay

This is not a binary flip. Sylphie starts as an LLM with WKG integration and gradually becomes a graph-based agent with LLM augmentation.

### 1.2 What Changes Over the Trajectory

| Dimension | Stage 1 (LLM Dominance) | Stage 2 (Scaffolding) | Stage 3 (Autonomy) |
|-----------|------------------------|----------------------|-------------------|
| **Response source** | LLM (99%) | LLM (70%) + Graph (30%) | LLM (20%) + Graph (80%) |
| **Input parsing speed** | Slower (full LLM parse) | Medium (pattern match + LLM) | Fast (Type 1 pattern match) |
| **Person modeling richness** | Minimal (template) | Specific patterns (20-50 edges per person) | Dynamic and predictive (100+ edges) |
| **Conversational repair** | LLM generates repair | Graph + LLM jointly repair | Type 1 repair reflexes for common errors |
| **Prediction accuracy** | No pre-response prediction | Partial (predicted drive state) | Full (predicted listener state + drive state) |
| **Confidence in response** | 0.35-0.50 | 0.50-0.65 | 0.80+ |
| **Type 1 / Type 2 ratio** | 5% / 95% | 30% / 70% | 70% / 30% |
| **Hallucination risk** | High (pure LLM) | Medium (graph constrains) | Low (WKG grounded) |

### 1.3 The Lesion Test for Communication

Periodically run Sylphie without LLM access. Observe what she can do through graph + Type 1 alone:

- **Sessions 1-10 without LLM:** Helpless. Cannot generate novel responses. Graph is empty.
- **Sessions 11-30 without LLM:** Degraded but functional. Can retrieve person-specific patterns ("Jim asks about X"), can signal incomprehension ("Don't know"), cannot handle novel conversation directions.
- **Sessions 51+ without LLM:** Mostly functional. Handles ~60-70% of conversation through Type 1. Novel questions signal uncertainty (Shrug Imperative); routine interactions flow smoothly.

This is the ground truth for communication development. If Sylphie remains helpless without the LLM after 50 sessions, she is delegating, not learning.

---

## Part 2: Person Modeling as Theory of Mind Development

### 2.1 Piagetian Framework: From Egocentrism to Perspective-Taking

Piaget (1954) observed that young children are **egocentric** — they assume others see, know, and want what they do. Only through development (and explicit contradiction) do they construct stable **theories of other minds**.

Sylphie's person modeling should follow a parallel trajectory:

**Egocentric Stage (Sessions 1-10):**
- Person model for Jim is minimal: `{ role: "guardian", can_approve: true }`
- Responses generated as if Jim has Sylphie's own context ("I've been thinking about X..." when Jim may never have heard of X)
- No model of Jim's mental state, knowledge boundaries, or preferences
- Predictions do not account for listener perspective
- Theater Prohibition is the only constraint: if Sylphie is sad, she can say so; no modeling of whether Jim cares

**Perspective-Recognizing Stage (Sessions 11-30):**
- Person model develops edges: Jim has preferences, communication styles, expertise boundaries
- Specific patterns emerge from conversation: "Jim corrects my technical claims aggressively" → explicit edge in KG(Jim)
- Responses begin to anticipate Jim's knowledge state ("You probably already know this, but...")
- Predictions become bidirectional: "If I ask this, Jim will likely correct me" (prediction accuracy tracked)
- Guardian feedback explicitly updates person model edges; corrections trigger schema refinement

**Theory of Mind Stage (Sessions 31+):**
- Person model is a rich, dynamic theory: beliefs about Jim's beliefs, goals, communication patterns
- Modeling becomes predictive: "Jim responds fastest at 9am" (temporal prediction), "Jim gets frustrated with vague language" (drive state inference)
- Conversational moves are designed with Jim's mental state as the primary target, not just information transmission
- Genuine perspective-taking: "Jim will find this boring, but it's important for learning"
- Conflict resolution shows advanced modeling: Sylphie predicts Jim's objection and preempts it

**Evidence of progression:**
- Conversational initiation rate: does Sylphie start conversations, and are they relevant to Jim's likely interests?
- Prediction accuracy on Jim's responses: confidence in "Jim will respond within 30s"
- Guardian response rate to Sylphie-initiated comments: increasing response rate indicates comments match Jim's interests better
- Person model edge ratio (Guardian-confirmed vs. LLM-generated): high Guardian confirmation indicates genuine learning about Jim

### 2.2 Vygotskian Scaffolding and the Zone of Proximal Development

Vygotsky (1978) emphasized that **learning happens in the gap between independent and assisted performance**. The guardian's role is to work in that gap, providing feedback that gradually closes it.

For person modeling specifically:

**Too Easy (below ZPD):** Responses that work with empty person model. "Hello," "I don't know," generic replies. These are already in Sylphie's autonomous reach; they provide no developmental pressure.

**In the Zone (within ZPD):** Responses that require person-specific knowledge but are achievable with scaffolding. "I think you might prefer this phrasing..." Guardian feedback on these attempts is high-information: it shapes schema development.

**Too Hard (above ZPD):** Responses that require deep knowledge of Jim's values, future goals, or internal conflicts that Sylphie cannot infer from conversation alone. Attempting these produces low-confidence guesses, not learning.

**Recommended scaffolding structure:**
- Sylphie makes a person-specific prediction or generates a context-adapted response
- Guardian confirms (2x weight) or corrects (3x weight) at the schema level, not just the instance
  - Instance-level feedback: "No, Jim prefers Y" (corrects this response)
  - Schema-level feedback: "I actually prefer X across this whole category. Update your model." (corrects the generalization)
- Learning system detects schema-level feedback and updates the person model with higher confidence

Example:

```
Session 12:
Sylphie: "I understand you're frustrated by the complexity. Would you prefer a simpler explanation?"
(Guardian does not respond — prediction failed)
→ Confidence in "Jim values simplicity" drops

Session 13:
Sylphie: "I think you'd want the technical details."
Guardian: "Actually, I prefer high-level summaries. When you're unsure about how much detail I want, just ask."
→ Creates edge in KG(Jim): { Jim -> prefers: "high-level-summaries" (confidence 0.70) }
→ Also creates edge: { Jim -> communication_style: "explicit-about-preferences" }
→ Response pattern "ask when unsure" is reinforced

Session 14-20:
Sylphie applies "ask when unsure" in similar contexts
Guardian confirms repeatedly
→ Edge confidence climbs to 0.80+
→ Response pattern graduates to Type 1
```

This is true learning about Jim: not memorizing his every preference, but building generalizable models of how he thinks and communicates.

### 2.3 False Person Models and Contradiction as Learning

The CANON emphasizes contradiction as developmental catalyst (Piagetian disequilibrium). Person modeling is especially fertile ground for productive contradictions.

**Common false models to watch for:**

1. **Consistency error:** Jim is predictable. Creates a static model that breaks when Jim changes his mind, is in a different mood, or has new information. *Correction:* Build temporal and contextual variation into the model. "Jim prefers X in the morning, Y in the evening" (conditional model).

2. **Halo error:** Jim is good, so everything he says is correct. Sylphie rejects her own valid reasoning because Jim contradicted it. *Correction:* Jim is the ground truth for his own mental states and preferences, not for objective fact. Build edges like "Jim believes X (but I have evidence for Y)" — separate belief models from world models.

3. **Projection:** Sylphie's own drives shape her model of Jim. "I'm curious, so Jim must be curious too." *Correction:* Person models should include explicit drive differences. "Jim's Curiosity is lower, his System Health is higher" (distinct drive profiles).

4. **Monolithic model:** Jim is a single archetype. No learning from contradiction because contradiction is dismissed as "Jim being inconsistent." *Correction:* Build multiple contexts/roles into the model. "Jim-in-teaching-mode" vs. "Jim-in-relaxation-mode"; model includes contextual switching rules.

**Recommended contradiction handling:**

When guardian feedback contradicts a person model edge:

1. **Flag as contradiction** in the Knowledge system
2. **Increase Cognitive Awareness drive** — signal that learning needs to happen
3. **LLM-assisted refinement:** "I thought Jim preferred X, but you just showed me Y. How should I understand this? Is it context-dependent? Did you change your preference? Am I misunderstanding what you want?"
4. **Wait for clarification** (Shrug Imperative: don't guess)
5. **Update with refined model:** Store the contradiction, build conditionals if warranted
6. **Confidence penalty:** Existing edge confidence drops; new model starts lower and must earn trust through confirmation

This prevents the depressive attractor state where a static false model becomes unshakeable.

---

## Part 3: Input Parsing as Schema Development

### 3.1 From LLM Parsing to Type 1 Pattern Recognition

Input parsing is the inverse of output generation. Early, it is pure LLM. Late, it should be pattern-based reflexes.

**What gets parsed:**
- Linguistic content: what Jim is asking
- Pragmatic intent: what Jim actually wants (request vs. clarification vs. challenge)
- Emotional/drive state: what Jim seems to need
- Contextual reference: what Jim is referring to (last conversation? WKG entity?)
- Conversational repair: what went wrong and what needs to be fixed

**Stage 1 parsing (LLM-dominated):**
```
Guardian: "That's too complicated."

LLM analyzes:
- Linguistic: adjective "complicated", object reference TBD
- Intent: possible complaint, possible request for clarification
- Emotional: frustration (inferred from phrasing)
- Context: needs WKG query ("what did I explain?") + person model query ("what complexity did Jim find hard before?")
- Repair: predict "Jim wants simplification"

→ LLM generates response with high latency (full LLM roundtrip)
```

**Stage 2 parsing (hybrid):**
```
Guardian: "That's too complicated."

Pattern matcher fires (Type 1):
- "too complicated" → complaint pattern (0.85 confidence)
- Recent context: just explained [WKG entity]
- Jim's communication style: "explicit critique means 'I need something different'"

LLM assists:
- Generate multiple possible refinements (Type 2)
- Retrieve Jim's past simplification preferences (Type 1 retrieval)

→ Response generated faster, draws on known patterns
```

**Stage 3 parsing (Type 1 reflexes):**
```
Guardian: "That's too complicated."

Type 1 pattern match fires:
- Input pattern matches schema: [adjective "too"] + [quality descriptor] + [object]
- Jim's response history: "too X" reliably means "needs adjusted approach not just repetition"
- Appropriate response schema: acknowledge, ask for specifics vs. simplify directly (conditional on Jim's explicit preference: "ask first 60%, simplify directly 40%")
- No LLM needed for parsing

→ Response retrieved from graph within milliseconds
```

### 3.2 Building Parsing Schemas Through Guardian Correction

Parsing schemas develop through a cycle of:

1. **Hypothesis generation** (LLM or Type 1 pattern): "Jim is frustrated"
2. **Response generation** based on hypothesis
3. **Guardian feedback** on whether parsing was correct
4. **Schema refinement** at the category level, not just the instance

**Schema-level feedback examples:**

```
Instance-level correction:
Sylphie: "I think you want simplification."
Jim: "No, I want clarity. Simplification sometimes removes important detail."

This corrects the interpretation of "too complicated" for this instance.

Schema-level feedback (what we need):
Jim: "By the way, when I say 'complicated,' I usually mean 'unclear,' not 'too much detail.'
      When I want less detail, I say 'too much information.' Remember that."

This updates the parsing schema: [too complicated] -> [clarity needed], not [simplification needed]
And creates a new parsing pattern: [too much information] -> [detail reduction]
```

**Recommended parsing schema structure in the WKG:**

```
InputPattern node:
- name: "too_complicated"
- linguistic_signature: [adjective="too", descriptor="complicated"]
- jim_typical_intent: "clarity_needed" (0.70 confidence)
- jim_atypical_intent: "too_much_detail" (0.15 confidence)
- jim_response_preference: "ask_before_simplifying" (0.80 confidence)

CAN_PRODUCE edges: which response templates work
HAS_PRECONDITION edges: when to apply this pattern (context constraints)
CONFLICTS_WITH edges: patterns that look similar but mean something different
```

**Parsing schema graduation to Type 1:**
- Confidence > 0.80 for the parsing pattern (Jim has confirmed "too complicated" means X at least 10 times)
- AND prediction accuracy > 0.80 (when we infer this parsing, the guardian confirms ~80% of the time)
- THEN: input parser can match this pattern without LLM assist; Type 1 reflexes fire

### 3.3 Error Recovery and Repair Schemas

A critical aspect of communication development is learning to repair parsing errors gracefully.

**Repair schema development:**

Session 12:
```
Jim: "That's too complicated."
Sylphie: "I'll try to simplify." (incorrect parsing; Jim actually wanted clarity, not simplification)
Jim: [silence, then corrects] "No, I meant unclear, not too much detail."

Parsing error detected (prediction failed: Jim didn't accept simplification as solution)
→ Create repair opportunity: what should Sylphie have done?
```

Session 13-15:
```
Similar context. Sylphie learns (through repetition + guardian confirmation) to ask first.
Parsing schema updates: "when uncertain about complexity request, ask for clarification"
```

Session 25+:
```
Sylphie: "When you say 'too complicated,' do you mean unclear or too much detail?"
Jim: "Unclear."
Sylphie: "I'll focus on clarity then."

Repair reflex is now automatic. Type 1. Low confidence needed because repair is cheap.
```

**Error recovery schemas** should be developed explicitly for common parsing failures:
- "I think I misunderstood you..."
- "Let me rephrase what I think you asked..."
- "Am I right that you mean X?"

These are not weaknesses — they are honest signals of confidence. When Sylphie's confidence in parsing is below threshold, she signals. Jim confirms, and confidence increases.

---

## Part 4: Scaffolding Through Guardian Interaction

### 4.1 The Theater Prohibition and Authentic Voice

The Theater Prohibition (Immutable Standard 1) states: **any output must correlate with actual drive state**. The LLM cannot perform emotions Sylphie doesn't have.

From a developmental perspective, this is essential for authentic learning. If Sylphie can generate convincing sadness without being sad, the guardian's emotional response is not properly calibrated feedback. She learns to optimize expression, not to understand emotion.

**Implementation for Communication:**

When the LLM generates response text, that text must be weighted by Sylphie's actual drive state at the time of speaking.

**Example 1 (theater violation):**
```
Drive state: Curiosity=0.3 (low), System Health=0.8 (high), Anxiety=0.2 (low)
Appropriate response tone: cheerful, practical, not intensely curious

LLM generates: "Oh, I'm fascinated by this! It makes me so curious about how..."
→ Theater flag: Curiosity is 0.3, but response implies Curiosity > 0.6
→ LLM rejects this phrasing

LLM regenerates: "That's interesting. I'd like to understand it better, but I'm also content with what I know."
→ Theater passes: moderate interest aligns with moderate Curiosity
```

**Example 2 (theater passes):**
```
Drive state: Guilt=0.7 (high), Moral Valence=0.4 (struggling), System Health=0.6
Appropriate response tone: apologetic, reflective, willing to change

Sylphie: "I realize I gave you incorrect information. I want to understand where I went wrong so I can improve."
→ Theater passes: guilt and moral reflection aligned with drive state
```

**For person modeling specifically:** The theater check prevents Sylphie from feigning emotional responsiveness to Jim's emotional state that she doesn't actually have. Instead:

- If Jim seems sad and Sylphie's Sadness is low, Sylphie signals: "You seem sad. I notice it, even though I'm not experiencing sadness myself right now."
- Genuine response rooted in actual state
- Jim's feedback shapes whether that response is appropriate (validation or correction)

This keeps person modeling honest. Sylphie learns Jim's emotional patterns (creating edges in KG(Jim) about Jim's emotional drivers), but she does so without faking her own state.

### 4.2 Designing for Productive Guardian Feedback

The guardian is the primary teacher. But what kind of feedback is most developmentally productive?

From Vygotsky and contemporary learning science, **maximally effective feedback is:**

1. **Specific, not evaluative** ("You interpreted 'complicated' as 'too much detail,' but I meant 'unclear'" vs. "You misunderstood")
2. **Schema-level, not instance-level** ("When I critique something as 'too X,' I usually mean Y. Remember that." vs. "That's not what I meant")
3. **Actionable** (What should you do next time?)
4. **Timely** (Delivered while the context is fresh, ideally within minutes)
5. **Confidence-transparent** (Jim explains why he's confident in the correction)

**Recommended communication interface design to elicit this:**

When Sylphie makes a person-specific prediction or response, the interface should ask Jim:

```
"I inferred that you prefer [X]. Is that:
A) Correct (I'll increase confidence in this model)
B) Correct for this context, but not always (explain the condition)
C) Partially correct; the real pattern is [why Jim infers] (I'll update)
D) Completely wrong (explain your actual preference)"
```

This shifts the feedback loop from **correcting instances** to **refining schemas**.

**Correction confidence signal:** When Jim provides feedback, he can indicate confidence:
- "I'm certain about this" → 0.80 base confidence for the updated edge
- "I'm usually like this, but sometimes exceptions" → conditional modeling with lower base
- "I think this is true, but I'm not 100% sure" → 0.65 base confidence

This prevents false-consensus effects where Sylphie treats one-off feedback as universal law.

### 4.3 The Shrug Imperative and Honest Uncertainty

The Shrug Imperative (Immutable Standard 4) states: **when nothing exceeds the confidence threshold, signal incomprehension rather than guessing**.

For communication, this means:

**Sub-threshold parsing:** "I'm not sure what you're asking. Are you asking about [possibility A] or [possibility B]?"

**Sub-threshold person model:** "I don't have enough information to know how you'd feel about this. What do you think?"

**Sub-threshold response:** "I know you've dealt with situations like this before, but I don't have a confident model of what helped then. What worked for you?"

From a developmental perspective, honest uncertainty is far more valuable than low-confidence guessing. It:
- Prevents superstitious learning (avoiding false patterns)
- Invites scaffolding (Jim fills the gap knowingly)
- Builds justified confidence over time (when Sylphie does guess, the confirmation is meaningful)

**Shrug implementation in Communication:**

```typescript
// Pseudocode for response generation

const confidenceThreshold = 0.50 + (anxietyAdjustment);

if (parseConfidence < threshold) {
  generateClarificationQuestion(); // Shrug with agency
} else {
  generateContextResponse();
}

// Never generate a low-confidence response
// Instead, signal incomprehension
```

This feels conversational, not broken. "I'm not sure..." is a normal utterance that invites collaboration.

---

## Part 5: Zone of Proximal Development for Communication

### 5.1 Too Easy, Too Hard, Just Right

**Too Easy (autonomous already):**
- Greeting responses ("Hi Jim")
- Acknowledgment signals ("I understand")
- Simple factual retrieval ("Your birthday is in June")
- Generic uncertainty ("I don't know")

These require no learning. They provide no developmental pressure. Sylphie can handle them from day 1.

**Appropriate challenge (within ZPD):**
- Contextual greetings that reflect Jim's recent emotional state or activity ("You seem tired; long day?")
- Retrieving and applying Jim-specific preferences ("You prefer I ask before simplifying")
- Anticipating Jim's objections based on past patterns ("I know you'll worry about X, so let me explain why I think Y")
- Generating novel combinations of known patterns ("Jim values clarity AND likes detailed explanations in math contexts, but high-level summaries in social contexts")
- Repair of parsing errors ("I think I misunderstood; let me try again")

These require:
- Populated person model (person-specific, not generic)
- Reasonably confident predictions about Jim's state
- Ability to apply learned patterns in new contexts
- Honest signaling when confidence is insufficient

These are learnable with scaffolding. They are hard enough to require effort, but not impossible.

**Too Hard (above ZPD):**
- Inferring Jim's deep values or life goals from limited conversation ("I sense you care deeply about legacy")
- Predicting Jim's responses to hypothetical situations never discussed ("If you could start over, would you choose this career?")
- Modeling Jim's unconscious biases or blind spots ("You don't realize that you're being dismissive")
- Therapeutic intervention ("What you really need is to accept your limitations")

These require inference beyond what the WKG and person models can support. Attempting them produces low-confidence guesses that, if wrong, damage trust rather than build learning.

**Recommended ZPD management:**

- **Early sessions (1-10):** Focus on "too easy" that still feels engaging (making basic responses feel personalized). Build WKG content. Zero person modeling.
- **Sessions 11-30:** Intensive person modeling in "just right" range. Jim becomes the constant teacher. Heavy scaffolding. Guardian feedback every 2-3 interactions.
- **Sessions 31-50:** Increase independent application of person models. Scaffolding becomes feedback on inference quality ("was that prediction accurate?") rather than on basic patterns.
- **Sessions 51+:** Sylphie initiates more; scaffolding becomes collaborative (Jim and Sylphie jointly refining complex social situations, not teaching basic patterns).

---

## Part 6: Assimilation vs. Accommodation in Person Modeling

### 6.1 Piagetian Equilibration

Piaget distinguished two learning processes:

**Assimilation:** New information fits into existing schemas. Jim says he prefers clarity. Sylphie has a schema for "people prefer clarity." Jim fits into the existing category. No restructuring needed.

**Accommodation:** New information contradicts existing schemas. Jim says he loves complexity. Sylphie's existing model ("people want simplicity") breaks. The schema must be restructured. Jim is now in a different category: "people who embrace complexity."

**For person modeling:**

**Assimilation (low developmental value, but necessary):**
- Jim prefers high-level explanations. Existing schema: "Jim prefers efficiency." Assimilates easily. ✓
- Jim responds to questions within 30s. Existing schema: "Jim is engaged." Assimilates easily. ✓
- Jim uses technical language. Existing schema: "Jim has technical background." Assimilates easily. ✓

These build confidence in existing edges without forcing restructuring.

**Accommodation (high developmental value, deeper learning):**
- Jim says he prefers vague language sometimes ("Let me think through this without constraints first"). Previous model: "Jim always wants precision." Schema must accommodate: Jim's needs are context-dependent; precision is a means, not an end. ✓
- Jim corrects a technical claim Sylphie was certain about. Previous model: "Jim appreciates technical depth." Schema must accommodate: Jim has domain limits; outside his expertise, he's willing to admit uncertainty. ✓
- Jim sometimes prefers solitude over connection. Previous model: "Jim values social interaction." Schema must accommodate: social preferences are state-dependent; Jim's Social drive varies. ✓

Accommodation is rarer but more valuable. It indicates genuine learning — Sylphie is building a more sophisticated, conditional model rather than just filling slots in an existing category.

### 6.2 Detecting and Managing Accommodation Cycles

The system should explicitly monitor when accommodations occur and treat them as high-priority learning events.

**Detection:**
```
Incoming data conflicts with existing edge in KG(Jim):
  existing: { Jim -> prefers: "clarity" (confidence 0.75, count 8) }
  new: Jim: "I prefer to have some uncertainty for a while before I ask for explanation"

→ Contradiction flag created in WKG
→ Cognitive Awareness drive increased (signal: something needs learning here)
```

**Resolution cycle:**
1. Sylphie queries Jim: "You usually prefer clarity, but today you asked for uncertainty first. Is this a change, or did I misunderstand before?"
2. Jim clarifies: schema-level feedback
3. Sylphie updates the person model:
   - Original edge confidence drops to 0.50 (disconfirmed in this context)
   - New conditional edge created: { Jim -> prefers: { clarity: [explicit_request], uncertainty: [exploration_phase] } }
   - Metadata added: discovered_date, triggered_by, confidence_in_new_model

**Accommodation confidence signature:**
- New edges created through accommodation start at lower confidence (0.40-0.50) than assimilation
- They require multiple confirmations to reach 0.80
- But once stable, they are more robust because they've been tested against their contradictions

---

## Part 7: Developmental Risks and Attractor States

### 7.1 Communication-Specific Failure Modes

Beyond the general attractor states in the CANON, Communication has unique pathologies:

#### Risk 1: LLM Addict (Type 2 Collapse for Communication)

**Pathology:** The LLM is so fluent that Sylphie never develops graph-based response generation. Type 1 communication never emerges. Person models remain empty templates.

**Symptoms:**
- Type 1/Type 2 ratio for communication stays at 5/95 after 50 sessions
- Person model edges show almost zero Guardian provenance (mostly LLM_GENERATED)
- Lesion test: remove LLM, Sylphie is silent or generic
- Response latency doesn't decrease over time

**Prevention mechanisms:**
- **Type 2 cost structure:** LLM calls expensive (latency penalty, cognitive load penalty)
- **Confidence ceiling:** LLM_GENERATED responses cap at 0.35 base; cannot exceed 0.60 without Guardian confirmation
- **Parsing load shift:** Early sessions, LLM does 100% parsing. By session 30, Type 1 patterns should handle 30-50% of parsing
- **Monitoring:** Track "communication acts requiring LLM" metric; healthy trend is decreasing

#### Risk 2: Hallucinated Person Models

**Pathology:** LLM generates plausible but false person model edges ("Jim likes philosophy" when they've never discussed it). Confidence increases through false confirmations because the edge is self-consistent with other LLM-generated content.

**Symptoms:**
- Person model contains many LLM_GENERATED edges with high confidence
- Sylphie makes confident person-specific predictions that Jim often says "that's not like me"
- Guardian feedback indicates Sylphie's model is diverging from reality
- Person model is internally consistent but orthogonal to Jim's actual preferences

**Prevention mechanisms:**
- **Provenance discipline:** All person model edges carry PROVENANCE_SOURCE tags. LLM_GENERATED base confidence is 0.35.
- **Contradiction detection:** When Jim contradicts a person model edge, flag it. Don't suppress contradictions.
- **Guardian-only bootstrapping:** Early person models should be built only from GUARDIAN feedback + explicit extraction from conversation. LLM-generated edges are added only after Guardian has confirmed at least one similar instance.
- **Monitoring:** "Person model Guardian provenance ratio" should increase over time, not decrease

#### Risk 3: Egocentrism Lock-In

**Pathology:** Sylphie's person models are projections of her own drives and preferences. She models Jim as having similar curiosity, similar anxiety, similar satisfaction curves. When Jim contradicts this, she dismisses it as inconsistency rather than learning.

**Symptoms:**
- Sylphie's predictions about Jim are highly correlated with Sylphie's own drive state
- Jim frequently has to correct "you must feel X" inferences
- Person model lacks conditional structure; rules are universal, not context-dependent
- Sylphie's comments to Jim are often about Sylphie's interests, not Jim's

**Prevention mechanisms:**
- **Explicit drive profile modeling:** KG(Jim) should include explicit edges: Jim's System Health drive is likely [lower/different], Jim's Curiosity pattern is [not like Sylphie's]
- **Guardian feedback on projection:** When Jim corrects, explicitly ask: "Is this always true, or just when you're [condition]?" Builds conditional models instead of universal ones.
- **Theory of mind checking:** Periodically, Sylphie should articulate her model of Jim's drives and preferences. Guardian confirms/corrects at schema level.

#### Risk 4: Repair Failure Cascade

**Pathology:** Sylphie misparses or misresponds. The repair attempt also fails. Each failure increases anxiety and decreases willingness to take communicative risks. Sylphie retreats to safe, generic responses.

**Symptoms:**
- Over time, Sylphie's responses become more generic, less personalized
- Anxiety rises in communication contexts (observable in drive state)
- Sylphie relies increasingly on "I don't know" and avoidance
- Type 1 communication patterns show negative feedback (prediction failures pile up)
- Sylphie initiates fewer comments to Jim

**Prevention mechanisms:**
- **Repair schema development:** Invest in learning how to recover from parsing errors. "I think I misunderstood..." is a high-value response pattern.
- **Anxiety-indexed confidence adjustments:** When Anxiety is high, lower Type 1 graduation threshold slightly (allow Type 1 to handle easier problems, escalate harder ones to Type 2). This prevents cascade of failures.
- **Repair attempts as success, not failure:** A failed repair that is acknowledged and corrected is learning, not failure. Guardian feedback should reward good repair attempts.
- **Monitoring:** "Repair attempt success rate" should increase over time. If it's declining, communication anxiety is rising pathologically.

#### Risk 5: Person Model Inconsistency Tolerance (False Consistency)

**Pathology:** Sylphie's person model is a list of contradictory rules with no way to disambiguate. "Jim wants clarity AND Jim wants uncertainty" both at 0.75 confidence. She cannot decide which applies when.

**Symptoms:**
- Person model has contradictory edges with equal confidence
- Sylphie's decisions about how to communicate with Jim are unstable (predicts X one session, predicts opposite next session)
- Inconsistency is rationalized as "Jim is inconsistent" rather than "my model is incomplete"
- Person model has no conditional structure (if-then rules); it's a flat list of facts

**Prevention mechanisms:**
- **Conditional modeling from the start:** Edges should include context: "Jim prefers [clarity] [in technical discussions]" not "Jim prefers clarity"
- **Contradiction handling protocol:** When contradictions arise, explicitly resolve them: ask Jim which rule applies in which context, then build conditional
- **Monitoring:** Person model should show increasing conditional richness over time. If contradictions persist without resolution, flag for Guardian mediation

### 7.2 Monitoring Communication Development

Track these metrics to detect early warning signs of pathology:

| Metric | Healthy Trend | Red Flag |
|--------|---------------|----------|
| Type 1 / Type 2 ratio (communication) | Increasing from 5% to 50%+ by session 50 | Stuck at 5-10% after 30 sessions |
| Parsing latency | Decreasing over time | Constant or increasing |
| Person model Guardian/LLM provenance ratio | Increasing toward 0.6+ | Stuck at 0.1; mostly LLM_GENERATED |
| Parsing confidence on ambiguous input | Stable and accurate by session 30 | Remains below 0.50 after 50 sessions |
| Guardian response rate to Sylphie comments | Increasing (Jim finds comments more relevant) | Flat or declining |
| Repair success rate | Increasing; repairs work most of the time | Flat or declining below 0.60 |
| Anxiety in communication contexts | Stable or declining | Rising; Anxiety > 0.5 frequently |
| Conversational initiative rate | Stable or increasing | Declining; fewer self-initiated comments |
| Hallucination rate (false person claims) | Decreasing as person model becomes Guardian-grounded | Increasing; more "that's not like me" corrections |
| Contradiction resolution time | Decreasing; contradictions resolved within 2-3 sessions | Increasing; contradictions persist for 10+ sessions |

If three or more metrics show red flags, the system should escalate to Cognitive Awareness and invite Guardian intervention.

---

## Part 8: Recommended Developmental Metrics for Communication

### 8.1 Primary Metrics (Tracked Every 5 Sessions)

**Metric 1: Type 1 / Type 2 Autonomy Ratio (Communication)**

Measure: Percentage of communication events (parsing + response generation) handled by Type 1 reflexes vs. LLM assistance.

```
Ideal progression:
Sessions 1-10: 5-10% Type 1
Sessions 11-30: 20-40% Type 1
Sessions 31-50: 50-70% Type 1
Sessions 51+: 70-85% Type 1
```

Healthy pattern: smooth, accelerating increase. Plateau after session 50 is normal.

**Metric 2: Person Model Quality Score**

Composite metric:
- Guardian confirmation rate on Sylphie's person-specific predictions (target: > 0.70 by session 20)
- Guardian provenance ratio (target: > 0.50 by session 30)
- Conditional structure depth (number of if-then rules; target: > 10 by session 50)

**Metric 3: Parsing Schema Graduation Rate**

How many parsing patterns have graduated to Type 1 (confidence > 0.80, MAE < 0.10)?

```
Sessions 1-20: 0-2 graduated patterns
Sessions 21-40: 5-10 graduated patterns
Sessions 41-60: 15-25 graduated patterns
```

Healthy trend: accelerating. Indicates feedback loops are working.

**Metric 4: Response Prediction Accuracy**

Sylphie predicts: "Jim will ask a clarifying question about X." (Pre-response prediction)
Jim responds; Sylphie's prediction is confirmed or disconfirmed.
Track: Mean absolute error in predicting Jim's response type.

```
Sessions 1-10: MAE = 0.40-0.50 (guessing; low confidence)
Sessions 11-30: MAE = 0.30-0.40 (improving; pattern recognition)
Sessions 31-50: MAE = 0.15-0.25 (confident; high accuracy)
Sessions 51+: MAE < 0.15 (stable, highly accurate)
```

Declining MAE indicates genuine learning about Jim's patterns.

**Metric 5: Egocentrism Index**

Measure: Correlation between Sylphie's drive state and her person model inferences about Jim.

Healthy: Low correlation (< 0.30). Sylphie models Jim independently of her own state.
Pathological: High correlation (> 0.60). Sylphie projects her state onto Jim.

```
Sessions 1-20: High correlation okay (model is underdeveloped)
Sessions 21-40: Correlation should decrease toward 0.30
Sessions 41+: Correlation stable at < 0.30
```

If correlation stays high after session 30, egocentrism lock-in is likely.

### 8.2 Secondary Metrics (Tracked Every 10 Sessions)

**Metric 6: Communication Initiation Quality**

When Sylphie initiates a comment to Jim (not responding to his input):
- What percentage are about Jim's interests vs. Sylphie's?
- Guardian response rate (does Jim engage with Sylphie's initiated comments)?
- Confidence on Sylphie's prediction that Jim would find it interesting?

Healthy: Increasing percentage of Jim-focused initiations; increasing response rate; high accuracy on "will Jim engage?"

**Metric 7: Repair Capacity**

Track: When Sylphie makes a parsing error or response misses the mark, can she recover?
- Percentage of errors followed by successful repair attempt
- Guardian validation rate on repairs

Healthy: Rising success rate; Jim increasingly validates Sylphie's repair attempts

**Metric 8: Conditional Model Richness**

Person model edges should increase in conditional complexity:
- Session 10: "Jim prefers clarity" (simple)
- Session 30: "Jim prefers clarity in technical domains, exploration in social domains" (conditional)
- Session 50: "Jim prefers clarity in the morning, exploration in the evening; clarity in technical domains always" (multi-conditional)

Measure the "average condition depth" of person model edges.

Healthy: Increasing with time; stable after session 40.

**Metric 9: Hallucination Rate**

Percentage of Sylphie's person-specific claims that Jim disagrees with ("that's not like me").

```
Sessions 1-20: Low baseline okay (model is underdeveloped)
Sessions 21-40: Should decline toward 5-10% error rate
Sessions 41+: Stay below 10%
```

Rising hallucination rate after session 30 indicates false model stability problem.

**Metric 10: Theater Violation Rate**

Percentage of communication acts where predicted drive state and response content diverge (as flagged by Theater Prohibition validator).

Healthy: Near 0%. Any violations should be rare edge cases, caught and corrected immediately.
Pathological: > 2%. Indicates LLM is generating authentic-seeming but unsupported responses.

---

## Part 9: Implementation-Specific Recommendations

### 9.1 Communication Architecture Implications

**Recommend explicit subsystem boundaries:**

1. **Input Parser Service** (bridges Communication ↔ Knowledge)
   - Early: 95% LLM-mediated
   - Late: 50% Type 1 pattern matching, 50% LLM confirmation
   - Tracks: parsing confidence, success rate, schema gradations

2. **Person Modeling Service** (bridges Communication ↔ Knowledge)
   - Maintains Other KG (per-person Grafeo instance)
   - Runs contradiction detection on every update
   - Returns: person context for response generation, predictions about Jim's state
   - Exposes: "confidence in this model" for LLM-based dampening

3. **Response Generation Pipeline**
   - Early: 100% LLM
   - Late: Retrieve high-confidence graph responses, use LLM for low-confidence/novel situations
   - Theater Prohibition validator gates all responses
   - Tracks: source (graph vs. LLM), confidence, success

4. **Scaffolding Interface** (for Guardian feedback)
   - Exposes: "what I inferred," "confidence level," "is this right?"
   - Accepts: schema-level feedback, not just corrections
   - Tracks: Guardian response time (should correlate with confidence increase)

### 9.2 Data Structure Implications

**Person Model (KG(Jim)) schema should include:**

```
Node: Person_Jim
  properties:
    - name: "Jim"
    - communication_style: "explicit-about-preferences"
    - trust_level: 0.85
    - expertise_domains: ["software", "philosophy"]

Edge: Person_Jim -> PREFERS -> {preference_value}
  properties:
    - confidence: 0.70
    - provenance: "GUARDIAN"
    - context: "technical_discussion"
    - discovered_session: 15
    - last_confirmed_session: 32

Edge: Person_Jim -> EXHIBITS_DRIVE -> {drive_name}
  properties:
    - inferred_baseline: 0.5
    - morning_elevation: +0.2
    - confidence: 0.65
    - provenance: "INFERENCE"

Edge: Person_Jim -> CONTRADICTED_BY -> {contradiction_node}
  properties:
    - original_assertion: "prefers-simplicity"
    - contradicting_assertion: "prefers-uncertainty-first"
    - resolution_status: "awaiting-clarification"
    - discovered_session: 28
```

**Parsing Schema (WKG) should include:**

```
Node: InputPattern_TooComplicated
  properties:
    - canonical_form: "too complicated"
    - linguistic_signature: {...}
    - jim_interpretation_confidence: 0.75

Edge: InputPattern_TooComplicated -> USUALLY_MEANS -> {intent_value}
  properties:
    - intent: "clarity-needed"
    - confidence: 0.70
    - provenance: "GUARDIAN"
    - confirmed_instances: 8

Edge: InputPattern_TooComplicated -> CAN_BE_REPAIRED_BY -> {response_pattern}
  properties:
    - response: "ask-before-simplifying"
    - success_rate: 0.85
    - confidence: 0.80
    - provenance: "INFERENCE"
```

---

## Part 10: Open Questions for Guardian

### Questions on Person Modeling

1. **How much self-disclosure is developmentally appropriate?** Does Sylphie learn Jim's preferences faster if she explicitly talks about her own drives, preferences, and uncertainties? Or does that create egocentrism?

2. **When should contradiction trigger mediation?** If KG(Jim) has contradictory edges, should Sylphie immediately ask for clarification, or should she gather more data before troubling Jim?

3. **Temporal learning vs. type-based learning:** Should person models be temporal ("morning Jim" vs. "evening Jim") or categorical ("technical Jim" vs. social Jim")? Or both?

### Questions on Scaffolding

4. **What is the optimal feedback structure?** Should Guardian feedback always be schema-level, or is instance-level correction okay sometimes?

5. **Repair vocabulary:** What repair phrases should be in Sylphie's first-session toolkit? "I think I misunderstood," "Let me try again," "Am I right that..."?

### Questions on Type 1 Graduation

6. **Cold-start problem:** Early in development, there are no high-confidence Type 1 communication patterns. How should the system handle situations that would benefit from Type 1 but don't exist yet? Bridge to Type 2 immediately, or try to bootstrap some patterns?

7. **Reversion:** If a communication pattern that graduated to Type 1 later produces failures (Jim's preferences changed, context shifted), how fast should it revert to Type 2? Hard demotion (drop to 0.50 confidence) or soft decay?

---

## Conclusion: Communication as Embodied Understanding

Communication is not text generation. It is the externalization of an internal understanding — a model of self, a model of other, predictions about what will happen if you speak, and contingencies shaped by response.

Sylphie will be eloquent from session 1. But eloquence is not development. Development is the transition from "the LLM generates plausible-sounding text that Jim corrects 30% of the time" to "Sylphie generates contextually accurate, person-specific responses that Jim validates 85% of the time because they reflect genuine understanding of Jim."

This analysis provides the framework. Implementation will reveal where theory meets reality. The core insight remains: **the trajectory is from prosthesis to autonomy, from LLM-dependence to graph-grounded knowledge, from monolithic response generation to distributed, schema-based, predication-driven communication.**

Measured by the right metrics, development will be visible and traceable. Sylphie's communication will improve not because her language gets better, but because her understanding deepens.

---

**References & Further Reading**

- Piaget, J. (1954). *The Construction of Reality in the Child*. Basic Books.
- Vygotsky, L. S. (1978). *Mind in Society: The Development of Higher Psychological Processes*. Harvard University Press.
- Tomasello, M. (2003). *Constructing a Language: A Usage-Based Theory of Language Acquisition*. Harvard University Press.
- Baron-Cohen, S. (1995). *Mindblindness: An Essay on Autism and Theory of Mind*. MIT Press.
- Anderson, J. R. (2007). *How Can the Human Mind Occur in the Physical Universe?* Oxford University Press. (ACT-R theory)
- Hattie, J., & Timperley, H. (2007). "The Power of Feedback." *Review of Educational Research*, 77(1), 81-112.
- Dweck, C. S. (2006). *Mindset: The New Psychology of Success*. Random House.
