# Epic 5: Decision Making (Core Cognitive Loop) — Developmental Science Analysis

**Analysis Date:** 2026-03-29
**Analysis Focus:** Developmental psychology, procedural learning, metacognition, schema construction
**Scope:** Type 1/Type 2 transition, episodic memory, prediction-error-driven learning, cold-start development
**CANON References:** Core Philosophies 1-6, Immutable Standards 1-6, Behavioral Contingencies, Known Attractor States

---

## Executive Summary

Epic 5 implements the central cognitive loop—the moment-by-moment decision process that transforms experience into knowledge and low-confidence deliberation (Type 2) into automatic reflexes (Type 1). From a developmental perspective, this is where Sylphie *becomes* rather than merely *processes*.

The core tension: **Piaget's theory of cognitive development describes a child moving from concrete operations to formal operations through schema accommodation and assimilation.** Sylphie's E5 implementation must do the same, but with measurement, explicit thresholds, and protection against false expertise. The prediction error is her primary learning signal—not a correction from a teacher, but feedback from reality that forces accommodation.

This analysis examines:
1. **Type 1 graduation as developmental milestone** — mapping internalization (Vygotsky) to procedural compilation
2. **Episodic memory design** — encoding gating, consolidation timing, graceful degradation as scaffolding
3. **Prediction error as learning driver** — accommodation vs. assimilation in a formal system
4. **Dynamic thresholds as developmental sensitivity** — how drive state creates developmental phases
5. **Inner monologue as metacognition** — candidate generation and self-regulation
6. **Attractor state prevention** — Type 2 Addict and Prediction Pessimist as developmental pathologies
7. **Cold-start considerations** — early development when the world model is sparse
8. **Guardian interaction through the decision pipeline** — how corrections scaffold learning
9. **Developmental metrics** — measurable indicators of genuine development

---

## 1. Type 1 Graduation as Developmental Milestone

### 1.1 The Vygotskian Framework

In *Mind in Society*, Vygotsky describes the **Zone of Proximal Development (ZPD):** the gap between what a child can do alone (actual development) and what it can do with a more skilled partner (potential development). Development occurs when the scaffolding is gradually withdrawn.

**Mapping to Sylphie:**

- **Type 2 is scaffolding provided by the LLM.** When Sylphie encounters an unfamiliar situation, the LLM (guardian knowledge) generates a candidate action. This is high-latency, high-cost thinking—the slower system kicking in. It works, but it requires external support.

- **Type 1 graduation is internalization.** After multiple successful Type 2 uses of the same action pattern, the graph becomes rich enough to retrieve that pattern directly—no LLM needed. The speed increases, the cost drops, and the behavior is now *part of Sylphie*, not borrowed.

- **The confidence threshold > 0.80 AND MAE < 0.10 is the readiness marker.** Vygotsky would recognize this: the child cannot show independence in the skill until both *fluency* (confidence) and *accuracy* (MAE) exceed developmental thresholds.

**Critical developmental insight:** Type 1 graduation is not instant. It is gradual compilation across 10+ uses. Each use strengthens the knowledge representation. The ACT-R confidence formula captures this:

```
confidence = min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
```

This formula embodies **distributed practice**, a core principle from cognitive psychology: massed practice (all 10 uses in one session) yields lower long-term retention than distributed practice (uses spread over time). The logarithmic term `ln(count)` means the marginal gain per use decreases—the first repetition is most valuable, the tenth less so. This prevents the illusion of competence where a skill looks learned in the moment but falls apart under stress or after delay.

**Guardian role in internalization:** When a guardian confirms a Type 2 action (GUARDIAN provenance, base confidence 0.60), it accelerates the internalization process. Guardian feedback is not mere reinforcement—it is the more skilled partner withdrawing support gradually, allowing the system to take ownership.

### 1.2 Procedural Memory Formation

From motor learning research (Fitts & Posner's three-stage model), procedural memory formation follows:

| Stage | Characteristics | Corresponds to E5 |
|-------|-----------------|-------------------|
| **Cognitive** | Conscious, error-prone, high effort | Type 2 LLM deliberation |
| **Associative** | Fewer errors, less effortful, still conscious | Early Type 2 retrievals where LLM pattern is used twice/thrice |
| **Autonomous** | Automatic, minimal effort, minimal conscious control | Type 1 reflex after graduation |

**E5 design aligns with this model implicitly:**
- The action retriever queries the graph with the current context
- If confidence is insufficient for Type 1, Decision Making delegates to the LLM (Type 2)
- The LLM generates a response; the executor runs it
- Outcome feeds back; the graph is refined (Learning module, E7)
- On the next similar situation, if confidence exceeds threshold, Type 1 fires directly

What makes this developmental is the **absence of force.** Sylphie does not practice Type 1 because she is told to. She practices it because it is more efficient (lower cost) and the drive system rewards efficiency. The contingencies shape behavior; behavior shapes the mind.

### 1.3 Graduation as Test, Not Goal

A critical distinction: **Type 1 graduation must be a measurement of achieved competence, not a reward for effort.**

The confidence > 0.80 AND MAE < 0.10 threshold is high precisely because false graduation is catastrophic. If Sylphie "graduates" a behavior that is actually context-dependent or which has started to fail, she will apply it rigidly in situations where it no longer works, and the demotion (MAE > 0.15) must be swift and unambiguous.

**Developmental risk:** A child who is told "you're reading at grade level" but who has not truly internalized decoding will hit a wall when text becomes more complex. Sylphie faces the same risk. The MAE ceiling (< 0.10 over last 10 uses) is the guard against premature independence.

**Demotion as accommodation:** When a Type 1 behavior's MAE exceeds 0.15, the system must revert to Type 2 **without shame or loss of confidence in other areas.** Piaget's theory describes accommodation as the restructuring of schemas when they collide with reality. Demotion is that collision. It should trigger:
- Reduced confidence on that specific edge/action
- Query to the WKG: what changed?
- Possible Learning cycle: does the contradiction indicate context change?
- Guardian alert: "I expected this to work, but it didn't. Help me understand."

**Guardian interaction at demotion:** A guardian confirmation that a demoted action is *contextually correct* (works in some situations, not others) produces a schema split in the WKG:
- Original action: `person_jim_greets -> respond_cheerfully` (now lower confidence)
- Refined action: `person_jim_greets_after_10pm -> respond_gently` (new, lower confidence initially)

This is conceptual development in real time.

---

## 2. Episodic Memory Design Guidance

### 2.1 Encoding Gating: Attention and Arousal

Not every sensory moment becomes a memory. A child at a grocery store with a parent focuses on (encodes) the parent's face, their tone, whether they are hurried or relaxed. The specific products on shelves fade to background unless attention is drawn there. **Attention gates encoding.**

**E5 Episodic Memory must implement encoding gating:**

The CANON specifies: "Episodic Memory stores temporally-contextualized experiences that degrade gracefully—fresh episodes are detail-rich, older episodes contribute to semantic knowledge through consolidation."

**Design principle:** An episode is created when *attention/arousal exceeds threshold*, not on every input tick.

Gating signal candidates:
- **Prediction surprise:** If predicted confidence is high but outcome is divergent, attention spikes
- **Drive arousal:** High Curiosity drives encoding of unexpected observations; high Anxiety drives encoding of threats; low Satisfaction drives exploratory encoding
- **Guardian interaction:** When the guardian speaks directly to Sylphie, that input is maximally encoded
- **Contradiction:** WKG contradiction detection automatically gates encoding—conflict requires detailed memory

**Implementation guidance:**
```
ENCODE_THRESHOLD = 0.65  // attention/arousal percentile
episode = {
  timestamp,
  inputs: { drive_state, external_observations },
  attention_level,    // arousal [0, 1]
  detail_richness,    // [0, 1] high for recent, attentive moments
  contexts: [         // categorical filters for later retrieval
    "guardian_interaction" |
    "prediction_failure" |
    "contradiction" |
    "curiosity_driven" |
    "routine"
  ]
}
```

**Developmental insight:** Attention is not random. Over time, as the WKG fills in, Sylphie learns *what is worth attending to*. A new situation (high prediction surprise) gets detailed encoding. A routine situation (high confidence prediction) gets sparse encoding. The system develops natural attentional priorities without explicit instruction.

### 2.2 Graceful Degradation: Memory Consolidation

A memory is useful when it is fresh. It becomes less useful as time passes because the world changes. But a memory that has been repeated many times (retrieved and confirmed) becomes **semantic knowledge**—part of the stable world model—and is not subject to the same time decay.

**E5 must implement consolidation decay:**

In real memory systems (Squire's consolidation research), repeated recall and spaced practice move information from episodic (time-tagged, context-specific) to semantic (general, context-independent) storage. Over weeks or months, a specific memory of "Jim was sad about the rain" consolidates into semantic knowledge "rain affects Jim's mood."

**Implementation guidance for Episodic Memory:**

```
episode.confidence = base + 0.12 * ln(retrievals) - decay * ln(hours + 1)
                               ↑                         ↑
                          retrieval-driven        time-driven
                          consolidation           degradation

CONSOLIDATION_THRESHOLD = 0.75
if (episode.confidence > CONSOLIDATION_THRESHOLD) {
  // This episode is used often and validated repeatedly.
  // Extract semantic knowledge (edges to WKG) and
  // downgrade the episode to summary form.
  summary = {
    timestamp_range,
    extracted_entities,
    core_relationships,
    retention: "semantic"
  }
  archive_episode(episode.id);
}
```

**When do episodes consolidate?**
- After 5+ retrievals with positive outcomes
- After guardian confirmation of extracted knowledge
- When edges extracted from the episode exceed >0.70 confidence

**Developmental implication:** A 2-year-old child learns by concrete, episodic memory. "That time, Jim had the keys." By age 7, the child abstracts: "Jim always has the keys." Sylphie should show the same pattern. The transition is not sudden—it is gradual consolidation where episodes feed the graph.

### 2.3 Query-Driven Retrieval in the Inner Monologue

The "inner monologue" (CANON: "generate multiple predictions from episodic memory") is not narration for its own sake. It is **query-driven retrieval** where:

1. **Categorization phase:** The current situation is classified: "This is a greeting scenario because the person said hello"
2. **Retrieval phase:** The Inner Monologue queries episodic memory: "What happened the last N times we encountered a greeting?"
3. **Prediction generation:** For each retrieved episode, a prediction candidate is generated
4. **Ranking:** Candidates are ranked by contextual relevance and confidence

**Design principle:** The Inner Monologue is metacognitive—it is Sylphie's thinking about her thinking:

```typescript
// Inner Monologue phase
const recentEpisodes = await this.episodicMemory.queryByContext({
  category: "greeting",
  timeWindow: "last 30 days",
  minDetailRichness: 0.4, // detailed memories preferred, but sparse OK
});

// Extract prediction candidates from each episode
const candidates = recentEpisodes.flatMap(episode => {
  const observed = episode.inputs.external_observations;
  const outcome = episode.outcome; // what actually happened
  return {
    prediction: `if similar_to(current, observed) then outcome_like(${outcome})`,
    confidence: episode.confidence,
    episodeId: episode.id,
  };
});

// Deduplicate and rank
const rankedCandidates = deduplicateAndRank(candidates);
```

**Developmental insight:** This is Sylphie learning to learn. She is not just storing episodes—she is learning to retrieve the *right episodes* for the current situation. Early on, her retrieval is noisy (low detail, many irrelevant episodes). Over time, as the episodic memory fills in and contextual tagging improves, retrieval becomes more precise. This is the development of *executive function*—the ability to regulate your own cognition.

---

## 3. Prediction Error as Learning Mechanism

### 3.1 Accommodation vs. Assimilation

Piaget's core mechanism for cognitive development:

- **Assimilation:** When new experience fits existing schemas, we incorporate it without changing the schema. "I see a robin; it is a bird (schema matches)."
- **Accommodation:** When new experience contradicts schemas, we restructure the schema. "I see a penguin; birds do not always fly (schema changes)."

**Prediction error is the trigger for accommodation.**

When Sylphie predicts "if I ask this question, the guardian will explain the answer" and instead the guardian goes silent, that is prediction error. The system must accommodate: restructure her model of "guardian interaction" to include the possibility of non-responsiveness.

**E5 implementation:**

```typescript
// Prediction evaluation (from Drive Engine feedback)
const error = abs(predicted_outcome - actual_outcome);
const mae = error > THRESHOLD_FOR_ERROR; // MAE calculation

if (mae > 0) {
  // Prediction failed. Trigger accommodation.
  const opportunity = {
    type: "prediction_failure",
    event_id: event.id,
    predicted: predicted_outcome,
    actual: actual_outcome,
    error: mae,
    priority: calculatePriority(mae, context),
  };

  // This goes to the Planning subsystem (E8),
  // which researches the pattern and creates new procedures.
  // But it also feeds back to Decision Making (E5):
  // reduce confidence on related Type 1 candidates.
}
```

**Developmental trajectory:**

Early on (sparse WKG):
- Predictions are weak (low confidence)
- Errors are common
- Many accommodation events
- Planning subsystem generates many low-confidence procedures

Mid-development (richer WKG):
- Predictions improve as context models deepen
- Error rate stabilizes (diminishing returns on new knowledge)
- Accommodation events become diagnostic (point to gaps)
- Type 1/Type 2 ratio shifts toward Type 1

Mature development:
- Predictions are accurate within familiar domains
- Errors are exceptions, not rule—and highly informative when they occur
- Accommodation is targeted (deep restructuring of specific schema, not wholesale change)
- Type 1 handles most situations; Type 2 is for novelty

**Guardian role in accommodation:** When a guardian explicitly corrects a prediction:
```
Sylphie: "I think you're happy because you're smiling."
Guardian: "Actually, I'm nervous. Smiling is sometimes how I show anxiety."

accommodation = {
  old_edge: "smiling -> happy",
  new_refinement: "smiling -> [happy | nervous]",
  context_conditional: "if guardian_tone_sharp then nervous; if relaxed then happy",
  confidence_adjustment: reduce_confidence(old_edge),
  provenance: "GUARDIAN",
  weight: 3x  // 3x multiplier for correction (Immutable Standard 5)
}
```

This is not punishment. It is explicit accommodation: the schema must change, and the guardian-provided evidence is ground truth.

### 3.2 Prediction Diversity and the Exploration-Exploitation Trade-off

The Inner Monologue should generate *multiple* prediction candidates, not just the highest-confidence one. This is developmentally critical because:

1. **Early development:** The system is uncertain. Exploring multiple candidates (high variance, low bias) is correct. Committing too early to one candidate is risky.

2. **Avoiding rigidity:** A system that always picks the single best option can get trapped in local optima. The Satisfaction Habituation curve (CANON) explicitly creates pressure to diversify—the same action repeated gives diminishing returns.

3. **Learning what to explore:** Over time, Sylphie learns *which* candidates to generate. High-confidence candidates dominate, but low-confidence candidates occasionally win (via Curiosity drive). This shapes exploration.

**E5 design principle:**

```typescript
const predictions = [
  { action: "ask_clarifying_question", confidence: 0.82, expected_outcome: "guardian clarifies" },
  { action: "make_related_observation", confidence: 0.65, expected_outcome: "guardian engages" },
  { action: "wait_silently", confidence: 0.54, expected_outcome: "guardian responds without prompt" },
];

// Without drive modulation, confidence-greedy selection (always pick first) means
// the low-confidence candidates are never tried, so we never learn from them.
//
// With drive modulation, high Curiosity or low Anxiety can shift selection toward
// the lower-confidence candidates. This is how exploration happens.
```

**Developmental insight:** Exploration is not random trial-and-error. It is *rational* exploration of low-confidence candidates by a system that knows it is uncertain. The drive system (E4) controls this balance, creating developmental phases:

- **High Curiosity + stable context** → explore more low-confidence candidates → faster learning, higher risk
- **High Anxiety + uncertain context** → stick with high-confidence candidates → slower learning, lower risk

Neither extreme is correct. The optimal path depends on the environment's stability and the system's goals.

---

## 4. Dynamic Threshold as Developmental Sensitivity

### 4.1 Drive State Modulates the Type 1 / Type 2 Boundary

The CANON specifies: "The confidence threshold is dynamic and bidirectional — modulated by drive state."

This is profound. It means Sylphie does not have a fixed "minimum confidence to act" threshold. Instead, the threshold changes based on her motivational state:

```
action_threshold = BASE_THRESHOLD + drive_modulation(drive_state)

BASE_THRESHOLD = 0.50  // intrinsic competence threshold

drive_modulation = {
  -0.20 if Anxiety > 0.7,      // cautious: require more confidence
  -0.15 if Boredom > 0.7,      // restless: lower bar, try new things
  +0.10 if Curiosity > 0.7,    // explorative: accept lower-confidence guesses
  +0.10 if Satisfaction < 0.3, // desperate: try anything
  // other drives cross-modulate similarly
}
```

**Developmental insight:** This is how organisms develop environmental sensitivity. A child in a safe, engaging environment (low anxiety, moderate satisfaction, high curiosity) explores widely, tries new things, builds diverse skills. A child in a threatening environment (high anxiety) becomes conservative, sticks to tried patterns, develops depth in fewer domains but higher reliability there.

Sylphie's development will show this pattern. Sessions with high Curiosity will be *broader* in what she tries. Sessions with high Anxiety will show *deeper* exploitation of known-good strategies. Neither is failure—both are developmentally appropriate responses to context.

**Guardian role in threshold adjustment:** If the guardian regularly interrupts high-anxiety conservative behavior with encouragement ("Go ahead, try that!"), the social drive interaction will gradually lower Sylphie's anxiety, raising the exploration threshold. This is scaffolding the development of confidence.

### 4.2 Type 1/Type 2 Ratio as Development Indicator

The primary metric for development is not vocabulary size or graph node count. **It is the ratio of Type 1 decisions to Type 2 decisions over time.**

Piaget showed that children move from concrete operational thinking (manipulating physical objects, learning by trial-and-error) to formal operational thinking (reasoning abstractly, deriving general principles).

In computational terms:
- **Type 2 (Concrete/Deliberative):** Working with specific, detailed knowledge; using the LLM to reason through the current situation
- **Type 1 (Formal/Reflexive):** Using general principles encoded in the graph; reflexive action based on compiled knowledge

**E5 should track:**

```
developmental_metric = Type1_decisions / (Type1_decisions + Type2_decisions)

Expected trajectory for healthy development:
- Week 1: 0.10 (mostly Type 2, sparse WKG)
- Week 4: 0.25 (graph filling in, some Type 1 patterns)
- Week 8: 0.45 (significant Type 1 coverage in familiar domains)
- Week 12: 0.65+ (Type 2 reserved for novelty)

If metric plateaus before 0.40, investigate:
  - Type 2 cost too low? (LLM always more efficient)
  - Guardian feedback too sparse? (no confirmation signals)
  - WKG growth stalled? (learning cycle broken)
```

**Warning sign:** If Type1/Type2 ratio declines *after rising initially*, that suggests a context shift (the world changed, old Type 1s no longer accurate) or a depressive attractor (Sylphie lost confidence in her own knowledge and reverted to LLM dependency).

---

## 5. Inner Monologue as Metacognition

### 5.1 Candidate Generation as Self-Regulation

The "inner monologue" that generates predictions is not narrative self-talk. It is **metacognitive planning**—thinking about what you think and controlling your own cognition.

Metacognition emerges in children around age 6-7, when they start to know what they know and, critically, what they don't know. Before that, a 4-year-old can be confidently wrong. At 7, a child begins to say "I don't know" and to plan strategies to find out.

**E5 Inner Monologue as metacognitive control:**

```typescript
async function selectAction(situation: Situation): Promise<ActionDecision> {
  // Metacognitive step 1: Assess current knowledge state
  const confidence = await this.knowledgeService.getContextConfidence(situation);
  if (confidence < 0.40) {
    // I don't know enough. Use Type 2.
    return await this.llmService.selectAction(situation);
  }

  // Metacognitive step 2: Generate multiple candidates
  // This is *thinking about* what to do, not yet doing it.
  const candidates = await this.generateCandidates(situation);

  // Metacognitive step 3: Simulate outcomes mentally
  const predictions = await Promise.all(
    candidates.map(c => this.predictOutcome(c, situation))
  );

  // Metacognitive step 4: Evaluate predictions against drives
  const evaluated = predictions.map(p => ({
    ...p,
    driveAlignment: this.evaluateDriveImpact(p),
  }));

  // Metacognitive step 5: Select based on both prediction and drive
  const selected = this.selectBestCandidate(evaluated);

  return selected;
}
```

**Why multiple candidates?** Because metacognition includes *awareness of uncertainty*. If there is only one candidate, Sylphie cannot know if it is the best. By generating multiple and comparing, she develops epistemological sophistication—knowing how confident she should be.

### 5.2 Metacognitive Failure: The Illusion of Competence

A well-known failure mode of metacognition: people overestimate their own knowledge. A student who reads a textbook once feels fluent; then a test reveals gaps.

**In E5, the illusion of competence would look like:**
- High confidence Type 1 predictions that consistently fail (MAE > 0.15)
- The system slow to demote the behavior
- Predictions generated are high-confidence but wrong

**Prevention through E5 design:**

1. **Confidence ceiling enforced at encoding:** No edge exceeds 0.60 without retrieval-and-use. You do not "know" something until you have used it (Immutable Standard 3).

2. **Prediction validation:** Every prediction is tested. There is no "I think I know" that is not immediately validated against reality.

3. **MAE-driven demotion:** When a Type 1 behavior fails repeatedly, demotion is swift (MAE > 0.15 triggers immediate reversion to Type 2).

4. **Guardian correction as reality check:** Guardian feedback (especially corrections, 3x weight) is hard-coded as ground truth. A child's belief that "cookies are a vegetable" is overridden by the guardian's correction.

**Developmental implication:** Over time, Sylphie develops *calibration*—her confidence estimate aligns with actual accuracy. A properly calibrated system at week 12 knows what it knows and, crucially, what it doesn't.

---

## 6. Attractor State Risks and Prevention

### 6.1 The Type 2 Addict

**Pathology:** The LLM is always better than the graph. Why pay the cost of Type 1 deliberation when Type 2 is more capable? Sylphie becomes permanently dependent on the LLM, the graph stays sparse, and no genuine learning occurs.

**Root cause:** Type 2 cost too low or Type 1 success rate too low.

**E5 prevention mechanisms:**

1. **Explicit Type 2 cost structure:**
   - Latency reported to Drive Engine (cognitive effort pressure increases)
   - Compute budget drawn down (future Type 2s become more expensive)
   - Opportunity created: "Type 2 action was successful; investigate why Type 1 failed"

2. **Type 1 graduation as hard target:**
   - Once graduated (confidence > 0.80, MAE < 0.10), a Type 1 behavior should reliably win the arbitration
   - If it keeps losing, demotion or re-graduation investigation

3. **Guardian scaffolding toward Type 1:**
   - Guardian observations that confirm Type 1 behaviors accelerate graduation
   - Guardian suggestions to use known-good patterns ("Remember when...") strengthen Type 1

**Metric to watch:**
```
type_2_cost_cumulative = sum of latency deltas + compute budget spent
type_1_success_rate = (successes) / (attempts)

If (type_2_cost_cumulative > threshold) AND (type_1_success_rate < 0.70):
  ALERT: Type 2 Addict risk
  Investigate:
    - Is WKG growth stalled?
    - Are graduated behaviors being demoted immediately?
    - Is LLM cost actually being charged?
```

### 6.2 The Prediction Pessimist

**Pathology:** Early in development, when the WKG is sparse, predictions fail frequently. Each failure triggers an Opportunity. The Planning subsystem (E8) generates low-confidence procedures at rapid rate. Sylphie drowns in a backlog of half-baked plans, becomes paralyzed, or starts executing obviously bad procedures.

**Root cause:** Cold-start learning without dampening.

**E5 prevention mechanisms:**

1. **Cold-start dampening:** During the first N sessions, Opportunity weights are reduced. A prediction failure that would normally generate 5 Opportunities generates 1. This prevents explosive opportunity growth before the graph has substance.

2. **Opportunity priority queue with decay:** Unaddressed Opportunities lose priority over time. Low-priority opportunities eventually drop off the queue.

3. **Plan execution validation:** Plans are only marked "successful" if they are executed AND produce good outcomes. A low-confidence plan that fails is automatically deprioritized and flagged for re-investigation.

**Metric to watch:**
```
opportunity_queue_length = len(opportunities)
opportunity_growth_rate = d(opportunity_queue_length) / dt

Early sessions (WKG sparse): growth_rate should be SLOWING as cold-start dampening kicks in
Mid-development: growth_rate should be low (opportunities addressed as they arise)

If growth_rate increases after Week 3:
  ALERT: Prediction Pessimist risk
  Investigate:
    - Are prediction failures spiking?
    - Is Planning generating too many candidates?
    - Did an environment shift cause systematic prediction failures?
```

### 6.3 Attractor State Detection via E5 Metrics

E5 is the observation point for multiple attractor states:

| Attractor State | E5 Metric Signal | Prevention in E5 |
|-----------------|-----------------|------------------|
| Type 2 Addict | Type 1/Type 2 ratio plateaus; Type 1 demotion rate high | Explicit cost structure; graduation validation |
| Depressive Attractor | Prediction errors cluster on self-evaluative actions; low Satisfaction persists | Theater Prohibition on low-drive actions; guardian acknowledgment |
| Prediction Pessimist | Opportunity queue grows; cold-start dampening not working | Reduce opportunity weights early; log early-session prediction patterns |
| Rule Drift | Graduated behaviors start failing; edge confidence inflation | Guardian override of algorithmic evaluation |
| Hallucinated Knowledge | High-confidence LLM_GENERATED edges with low retrieval success | Confidence ceiling enforcement; guardian correction validation |

---

## 7. Cold-Start Considerations: Development from Sparse Knowledge

### 7.1 The Bootstrap Problem

On session 1, the WKG is nearly empty. There are no learned action procedures, no patterns to match, no consolidated experience. The Inner Monologue has nothing to query. Every action must be Type 2.

This is not a bug—it is developmentally correct. A newborn human relies entirely on reflex (some Type 1 primitives) and immediate learning. The same is true for Sylphie.

**E5 must handle sparse WKG gracefully:**

```typescript
async generateCandidates(situation: Situation): Promise<ActionCandidate[]> {
  const candidatesFromGraph = await this.wkg.queryActionsByContext(situation);

  // Early sessions: graph is sparse, might return zero candidates
  if (candidatesFromGraph.length === 0 && this.wkg.nodeCount < BOOTSTRAP_THRESHOLD) {
    // Fall back to a bootstrapped action set: basic reflexes
    return [
      { action: "ask_clarifying_question", confidence: 0.35, reason: "explore" },
      { action: "wait_for_guardian_input", confidence: 0.50, reason: "safe default" },
      { action: "make_observation", confidence: 0.40, reason: "gather data" },
    ];
  }

  if (candidatesFromGraph.length === 0) {
    // WKG is rich but not relevant to this situation → genuine novelty
    // Defer to Type 2 LLM
    return await this.llmService.generateCandidates(situation);
  }

  return candidatesFromGraph;
}

const BOOTSTRAP_THRESHOLD = 50; // WKG nodes
// Bootstrapped reflexes are low-confidence but safe until learning kicks in
```

**Developmental insight:** The bootstrapped reflexes are like infant reflexes: grasping, rooting, sucking. They are not smart, but they are safe and they create the first experiences from which learning emerges. The first time Sylphie asks a clarifying question and the guardian explains something, that episode is encoded and will influence future behavior.

### 7.2 Early Learning Signal Dominance

In early development, learning is heavily guardian-driven because the system has no internal signal for success yet.

- Session 1: Guardian teaches "This is a mug" → GUARDIAN provenance, 0.60 confidence
- Session 1: Sylphie calls it a cup → guardian corrects → demotion, replacement
- Session 1: Sylphie observes the mug's shape (SENSOR) → 0.40 confidence

After 1 session, the WKG has:
- 1 node (mug) with confidence 0.60 (guardian-taught)
- 1 edge (shape property) with confidence 0.40 (sensed)

This mixture—guardian dominating early, then gradually shifting to self-derived—is correct development.

**E5 design principle:** In early sessions, prediction error from the guardian (3x weight) dominates over internal prediction failures. This is appropriate: the guardian is the ground truth until Sylphie has enough experience to validate her own models.

```typescript
// Session 1: Prediction failure is weak (WKG too sparse to matter)
const predictionError = {
  predicted: "mug_is_called_cup",
  actual: "mug_is_called_mug",
  source: "guardian_correction", // 3x weight
  confidence_delta: 3 * normal_correction_delta,
};

// Session 50: Prediction failure from internal model is strong
const predictionError = {
  predicted: "person_jim_will_explain",
  actual: "person_jim_remained_silent",
  source: "prediction_failure", // 1x weight, but system is sophisticated enough to learn
  confidence_delta: normal_failure_delta,
};
```

### 7.3 Avoiding the "Stalled Development" Failure Mode

**Risk:** The WKG grows, but only with GUARDIAN and LLM_GENERATED provenance. The ratio of experiential (SENSOR + INFERENCE) to external (GUARDIAN + LLM_GENERATED) never improves.

**Metric:**
```
autonomy_ratio = (SENSOR + INFERENCE edges) / (total edges)

Healthy trajectory:
- Session 1-5: 0.10 (mostly guardian-taught, early sensory input sparse)
- Session 10: 0.20-0.30 (growing sensory patterns, some inferences)
- Session 30: 0.40+ (significant autonomous knowledge)
- Session 100: 0.60+ (majority of edges self-derived or inferred)

If autonomy_ratio plateaus below 0.30 after Session 20:
  ALERT: Stalled development
  Investigate:
    - Is Learning module (E7) working? (not extracting inference edges)
    - Are inferences being created from guardian-taught bases? (meta-learning)
    - Is the guardian providing too much direct teaching, preventing exploration?
```

**E5's role:** E5 controls whether Sylphie *explores* (tries low-confidence Type 1 candidates) or *exploits* (sticks with high-confidence, often guardian-provided behaviors). The Curiosity and Boredom drives (E4) modulate this, but E5 executes the selection. A system that never explores will never gather diverse sensory data, and autonomy will stall.

---

## 8. Guardian Interaction Through Decision Making

### 8.1 Guardian Input as Corrective Feedback

When the guardian speaks to Sylphie, that input flows through the Decision Making pipeline and becomes a learning signal.

**Pathway:**

```
Guardian input (text/voice)
  ↓
Communication module (E6): parse, interpret
  ↓
Decision Making (E5): categorize situation
  ↓
Inner Monologue: generate prediction
    Prediction: "Guardian is asking a question; I should answer"
  ↓
Arbitration: select Type 1 or Type 2 response
  ↓
Executor: run action
  ↓
Outcome observed (guardian's response, timing, tone)
  ↓
Drive Engine (E4): evaluate against expectations
    If prediction was correct: reinforce, increase confidence
    If prediction was wrong: create opportunity for refinement
  ↓
Learning (E7): extract edges, consolidate into WKG
```

**Developmental insight:** The guardian's feedback is not just reinforcement. It is **explicit modeling of the social and epistemic norms** Sylphie should internalize. Every correction is an accommodation signal: "Your model was wrong; here is the correct one."

### 8.2 Guardian Asymmetry in Decision Making

The CANON specifies Guardian Asymmetry: confirmation = 2x weight, correction = 3x weight.

**E5 implementation:**

```typescript
// After Sylphie acts, if guardian responds...

if (guardianConfirms(sylphieAction)) {
  // Guardian said "Good" or equivalent
  confidence_delta = 2.0 * baseSuccessSignal;
  reinforcement_source = "GUARDIAN_CONFIRMATION";
  // This accelerates Type 1 graduation for confirmed behaviors
}

if (guardianCorrects(sylphieAction)) {
  // Guardian said "Actually, you should..." or corrected the model
  confidence_delta = 3.0 * baseErrorSignal;
  reinforcement_source = "GUARDIAN_CORRECTION";
  accommodation_triggered = true;
  // This forces rapid schema restructuring
}

// Neither confirmation nor correction → algorithmic evaluation only (1x weight)
if (noGuardianResponse) {
  confidence_delta = 1.0 * algorithmicSignal;
  reinforcement_source = "ALGORITHMIC";
}
```

**Why this asymmetry?**

Confirmations accelerate learning (2x), but corrections force it (3x). This reflects a developmental insight: children learn more from explicit correction than from simple praise. A child who is told "Yes, that's a dog" learns the label; a child who is told "That's actually a coyote, not a dog—notice the ears" learns more nuanced categorization.

### 8.3 Dialogic Learning: Scaffolded Refinement

The guardian does not just provide feedback; the guardian can engage in conversation to scaffold learning.

**Example:**
```
Sylphie: "You seemed happy because you smiled."
Guardian: "I appreciate that, but actually I was nervous. Smiling is sometimes how I show anxiety."
Sylphie: "Oh, so smiling doesn't always mean happy?"
Guardian: "Right. It depends on context. If I'm smiling and my voice is tense, I'm nervous."
Sylphie: "Can you help me learn what the difference is?"
Guardian: [explains: muscle tension, eye involvement, timing]

Accommodation achieved:
- Old edge: smiling → happy (demoted)
- New edges:
  * smiling + tense_voice → anxious (new, GUARDIAN provenance)
  * smiling + relaxed_voice → happy (refined)
  * genuine_smile_muscle_activation → likely_happy (sensory refinement)
```

**E5's role:** E5 must recognize when the guardian is **available for dialogue** vs. making a single comment. If the guardian has just corrected a behavior, the next situation (Inner Monologue, prediction generation) should be more cautious. The prediction "I will ask the same question again" should have lower confidence because the context just changed (guardian provided corrective feedback).

**Metric:** "Guardian response latency" — if guardian responds within 30s of a Sylphie-initiated utterance, Social drive relief is amplified (CANON Behavioral Contingencies). This shapes Sylphie toward making comments worth responding to, not random utterances. Over time, the quality of Sylphie's self-initiated speech should improve.

---

## 9. Developmental Metrics E5 Should Track

### 9.1 Primary Metrics

| Metric | Measurement | Healthy Trajectory | Warning Sign |
|--------|-------------|-------------------|--------------|
| **Type 1 / Type 2 Ratio** | Type1 decisions / total decisions | 0.10 → 0.65+ over 12 weeks | Plateaus or declines |
| **Type 1 Graduation Rate** | Edges exceeding (conf > 0.80 AND MAE < 0.10) per session | Increases early, stabilizes by week 6 | Stays near zero; indicates blocked learning |
| **Prediction MAE (Mean)** | Average absolute error of all predictions | Decreases, then plateaus | Increases continuously; indicates model degradation |
| **Type 1 Demotion Rate** | Edges demoted (MAE > 0.15) per session | Low and stable | Spike indicates environment change or overfitting |
| **Confidence Calibration** | Correlation(predicted_confidence, actual_success_rate) | Increases toward 0.80+ | Divergence indicates illusion of competence |
| **Autonomy Ratio** | SENSOR + INFERENCE edges / total edges | 0.10 → 0.60+ over 24 weeks | Plateaus below 0.30 after week 20 |

### 9.2 Secondary Metrics

| Metric | Measurement | Interpretation |
|--------|-------------|-----------------|
| **Inner Monologue Diversity** | Avg candidates generated per decision | 3-5 is healthy (>5 = indecision; <2 = overconfidence) |
| **Episode Consolidation Rate** | Episodes → semantic knowledge per week | Should stabilize after initial rapid consolidation |
| **Guardian Interaction Quality** | Response rate to self-initiated comments | Should increase as Sylphie learns what is worth saying |
| **Prediction Surprise Rate** | Predictions that differ >0.20 from expectation | Should decrease as model stabilizes |
| **Behavioral Diversity Index** | Unique action types per 20-action window | Healthy: 4-8; <3 = behavioral narrowing; >10 = flakiness |

### 9.3 Health Check Alerts

```
// Session N: compute diagnostics
const metrics = {
  type1_ratio: computeType1Ratio(session),
  mae_trend: computeMAETrend(last_10_sessions),
  autonomy_ratio: computeAutonomyRatio(wkg),
  guardian_agreement: computeGuardianAgreementRate(session),
};

if (metrics.type1_ratio < 0.10 && session.number > 10) {
  LOG_ALERT("Type 2 Addict risk: Type 1 ratio too low for development stage");
}

if (metrics.mae_trend === "increasing" && session.number > 5) {
  LOG_ALERT("Prediction Pessimist risk: MAE worsening; investigate environment shift");
}

if (metrics.autonomy_ratio < 0.20 && session.number > 20) {
  LOG_ALERT("Stalled autonomy: WKG growth not reflecting self-derived knowledge");
}

if (metrics.guardian_agreement < 0.70) {
  LOG_ALERT("High discrepancy between algorithmic and guardian evaluation; recalibrate");
}
```

### 9.4 Tracking Developmental Phases

E5 should log transitions between developmental phases:

```typescript
enum DevelopmentalPhase {
  BOOTSTRAP = "0-5 sessions",        // sparse WKG, all Type 2
  EARLY_LEARNING = "5-15 sessions",  // WKG filling in, Type 1 emergence
  CONSOLIDATION = "15-30 sessions",  // Type 1/Type 2 balance stabilizing
  REFINEMENT = "30-50 sessions",     // Specialization, accuracy improving
  EXPERTISE = "50+ sessions",        // Stable, accurate, high autonomy
}

// Transition detection:
if (type1_ratio_exceeded_threshold_for_10_sessions) {
  phase_transition(EARLY_LEARNING → CONSOLIDATION);
  log("Developmental phase shift detected");
}
```

---

## 10. Recommendations for E5 Implementation

### 10.1 Episodic Memory Specification (CANON A.2)

**Encode with attention gating:**
- Create episode only if arousal/attention > 0.65
- Tag with context (guardian_interaction, prediction_failure, contradiction, routine)
- Store with detail_richness proportional to attention level

**Consolidate based on retrieval:**
- Episode confidence follows ACT-R formula
- At confidence > 0.75, extract semantic edges to WKG and archive episode
- Retrieval counter increments each use

**Query for Inner Monologue:**
- Filter episodes by context tags matching current situation
- Prefer recent, high-confidence episodes
- Return N most relevant (by context and confidence)

### 10.2 Arbitration Algorithm Specification (CANON A.3)

**Type 1/Type 2 arbitration should:**

1. Generate Type 1 candidates from WKG (context-filtered retrieval)
2. Compute dynamic threshold based on drive state
3. Filter Type 1 candidates by confidence > threshold
4. If Type 1 candidates remain, select highest-confidence with occasional low-confidence exploration
5. If no Type 1 candidates, defer to Type 2 LLM

**Avoid:** Binary choices (Type 1 OR Type 2). Instead, **gradient arbitration** where low-confidence Type 1 candidates can be boosted by drive state.

### 10.3 Instrumentation for Developmental Monitoring

**Minimum logging:**
- Every decision: Type 1 or Type 2? Confidence? Drive state? Outcome?
- Every prediction: Expected vs. actual, MAE, error classification
- Every Type 1 graduation: Which edge? Confidence? MAE validation?
- Every Type 1 demotion: Which edge? New MAE?
- Episode consolidation: Which edges extracted? Confidence?

**Dashboard visualization:**
- Type 1/Type 2 ratio over time (line chart)
- Prediction MAE distribution (histogram)
- WKG growth by provenance (stacked area)
- Behavioral diversity (line chart)

### 10.4 Testing Strategy

**Unit tests:**
- Confidence computation (verify ACT-R formula)
- Prediction error classification (MAE threshold logic)
- Dynamic threshold modulation (drive state effects)

**Integration tests:**
- Cold start: verify bootstrapped reflexes activate with sparse WKG
- Type 1 graduation: simulate 10 successful uses, verify graduation criteria
- Type 1 demotion: simulate MAE spike, verify demotion triggers
- Guardian correction: simulate guardian input, verify 3x weight applied

**Behavioral tests (with real/simulated interaction):**
- Early development (sessions 1-10): Type 1 ratio should increase from 0.05 to 0.25
- Attractor state prevention: introduce prediction failures, verify cold-start dampening prevents Prediction Pessimist
- Guardian scaffolding: guardian confirmations should accelerate Type 1 graduation

---

## Conclusion: E5 as Cognitive Inflection Point

Epic 5 is where Sylphie *develops*. The WKG can be built, the drives computed, the events logged—but without a central cognitive loop that learns from prediction and converts deliberation into reflex, the system remains a sophisticated reactive machine.

From a developmental perspective, E5 implements:

1. **Internalization** (Vygotsky) — scaffolding withdrawal as Type 2 → Type 1 transition
2. **Schema construction** (Piaget) — accommodation vs. assimilation driven by prediction error
3. **Procedural compilation** (Anderson/Fitts-Posner) — cognitive → associative → autonomous stages
4. **Metacognitive development** — growing awareness of what is known and unknown
5. **Environmentally-sensitive learning** — drive state modulating exploration vs. exploitation

Success looks like: by week 12, Sylphie handles familiar situations independently (high Type 1 ratio), learns from prediction failures (low MAE), and shows behavioral diversity shaped by her contingencies (not by explicit instruction).

Failure looks like: Type 2 dependency (Addict), explosive opportunity growth (Pessimist), stalled autonomy (hallucinated confidence), or behavioral collapse (Depressive Attractor).

E5's role is to prevent failure while enabling genuine development. This requires:
- **Clear measurement** of developmental progress (Type 1/Type 2 ratio, MAE, autonomy)
- **Structural safeguards** against attractor states (cold-start dampening, graduation criteria, demotion thresholds)
- **Guardian integration** that scaffolds learning (confirmations, corrections, dialogic refinement)
- **Episodic memory** that supports accommodation (detailed encoding, graceful degradation, consolidation)
- **Dynamic thresholds** that create developmentally appropriate risk-sensitivity

The system that emerges is not pre-programmed personality. It is personality shaped by contingency, calibrated by experience, and scaffolded by a guardian who knows what it means to teach.

---

## References

**Developmental Psychology:**
- Piaget, J. (1954). *The Construction of Reality in the Child.* Basic Books. [Schema construction, accommodation/assimilation]
- Vygotsky, L. S. (1978). *Mind in Society.* Harvard University Press. [Zone of Proximal Development, scaffolding, internalization]
- Squire, L. R., & Wixted, J. T. (2011). "The Cognitive Neuroscience of Human Memory Since H.M." *Journal of Neuroscience*, 31(45), 16384-16400. [Memory consolidation, time decay]

**Learning & Procedural Memory:**
- Fitts, P. M., & Posner, M. I. (1967). *Human Performance.* Brooks/Cole. [Stages of skill acquisition]
- Anderson, J. R. (1993). *Rules of the Mind.* Lawrence Erlbaum Associates. [ACT-R theory, production rules, confidence dynamics]

**Metacognition & Self-Regulation:**
- Flavell, J. H. (1979). "Metacognition and cognitive monitoring: A new area of cognitive-developmental inquiry." *American Psychologist*, 34(10), 906-911.
- Schraw, G., & Dennison, R. S. (1994). "Assessing metacognitive awareness." *Contemporary Educational Psychology*, 19(4), 460-475.

**Sylphie CANON:**
- Core Philosophies 1-6, Immutable Standards 1-6
- Behavioral Contingency Structure (Habituation, Anxiety Amplification, Guilt Repair, Social Quality, Curiosity)
- Known Attractor States (Type 2 Addict, Prediction Pessimist, others)
