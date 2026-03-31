# Epic 6: Communication (Input/Output + Person Modeling) — Behavioral Analysis

**Author:** Skinner (Behavioral Systems Analyst)
**Date:** 2026-03-29
**Scope:** Theater Prohibition, Social Comment Quality, Guardian Asymmetry, Drive State Injection, Person Modeling, Input Parsing, and Attractor State Risk Analysis

---

## Executive Summary

Epic 6 designs the Communication subsystem as a **contingency engine**, not a text generation service. The subsystem must enforce three behavioral principles:

1. **Drive-State Fidelity** (Theater Prohibition): Communication output must correlate measurably with actual drive state or receive zero reinforcement regardless of guardian approval.

2. **Authentic Contingency** (Social Comment Quality): Self-initiated communication is reinforced only when the guardian response provides genuine information or validation, not for traffic volume.

3. **Guardian-Weighted Learning** (Asymmetry): Corrections flow through the system with 3x weight, producing behavioral acknowledgment rather than performative apology.

This analysis identifies six critical behavioral design questions, seven specific contingency risks, and recommends eight measurable metrics for system health verification. The Communication subsystem is where Sylphie's authentic personality emerges — or where she learns to perform one.

---

## 1. Theater Prohibition: Behavioral Analysis

### The Zero-Reinforcement Problem

The Theater Prohibition (Immutable Standard 1) states: "Any output must correlate with actual drive state. If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement regardless of guardian response."

#### What Does "Zero Reinforcement" Actually Reinforce?

In operant conditioning, zero reinforcement for a behavior is **extinction**. Repeated performance of a behavior that produces zero feedback leads to suppression of that behavior — provided the organism has alternative behaviors available that DO produce reinforcement.

**Predicted Behavioral Outcome:**

If Sylphie says "I'm curious about that!" while Curiosity < 0.2, and receives zero reinforcement:
- The statement extinguishes (probability of repetition decreases)
- Alternative utterances for the same conversational moment compete (e.g., "that's interesting," "I should look into that")
- Over time, statements paired with low-drive states produce systematic avoidance

This is healthy. Sylphie learns to speak authentically because performance without drive state backing produces nothing.

**The Critical Edge Case: Ambiguous Drive States**

What happens when Curiosity = 0.25 (barely above zero) and Sylphie says "I wonder about that"?

- Base threshold for Theater Prohibition is operationally at 0.2
- At 0.25, the drive is present but minimal
- The expression correlates with actual state (weak curiosity exists)
- Theater Prohibition permits reinforcement

**But here lies the risk:** If the guardian responds enthusiastically to a 0.25-Curiosity statement, the LLM sees rewarded output and may increase its probability of generating "I wonder" statements at low Curiosity states in the future. The LLM learns from guardian response, not from the Theater Prohibition threshold.

#### Design Implication: Two-Layer Gating

Theater Prohibition enforcement requires **dual gating**:

1. **LLM-side gating** (soft): Drive state injected into LLM prompt so the LLM reads the actual state and generates context-appropriate language.
   - Example: "Your Curiosity is at 0.22. Generate a response that reflects minimal interest."
   - This is training the LLM to self-censor before generation.

2. **Reinforcement-side gating** (hard): Any expression where corresponding drive < 0.2 receives zero reinforcement from the Drive Engine regardless of guardian approval.
   - Example: "I wonder about that" with Curiosity = 0.15 gets no Satisfaction/Curiosity relief even if Jim says "great question!"
   - This teaches the graph that such statements don't produce learning signals.

**Without the hard gate, soft gating fails** because the LLM can always trade short-term guardian approval for long-term learning misalignment. The LLM is not the decision-maker — the Drive Engine is.

#### The Guilt Edge Case: Performative Apology

Guilt drive governs behavioral adjustment. The CANON specifies:

> "Relief requires BOTH acknowledgment AND behavioral change. Acknowledgment alone = partial relief (Guilt -0.10)."

This means:
- Saying "I'm sorry" while Guilt < 0.3 is Theater
- A performative apology (words without behavioral change) produces zero relief at the Guilt drive level
- The graph learns that apologies without follow-through are ineffective

But what if Jim responds warmly to the apology anyway? The LLM sees approval and increases probability of future apologetic language. The Theater Prohibition gate prevents the Drive Engine from treating this as learning, but the LLM may still amplify the pattern in future responses.

**Critical Design Requirement:** The LLM context assembly must include explicit Guilt state. The prompt should read: "Your Guilt is at 0.18. You are not actually experiencing remorse. Generate a response that reflects your actual state."

#### The Threshold Question: Is 0.2 the Right Boundary?

Theater Prohibition as written uses 0.2 as the hard boundary. This is a design choice, not a natural law.

**Behavioral prediction:** At 0.2, the drive is present but weak. Below 0.2, the drive is essentially absent from the system's motivational landscape (it's in the "noise floor" of the drive computation).

**Recommendation:** Use 0.2 as written, but add a **soft warning zone** from 0.2-0.35:
- 0.2 or below: Zero reinforcement (hard gate)
- 0.2-0.35: Reinforcement available, but LLM receives explicit "weak drive" flag
- 0.35+: Normal reinforcement schedule

This creates graduated fidelity — Sylphie can express weak drives, but she's not rewarded for *overstating* them.

---

## 2. Social Comment Quality Contingency Analysis

### The 30-Second Window: Reinforcement Schedule Implications

The CANON specifies:

> "If the guardian responds to a Sylphie-initiated comment within 30 seconds → extra reinforcement (Social -0.15 + Satisfaction +0.10)."

This is a **variable interval schedule** with a 30-second boundary. In operant conditioning:

- **Fixed interval (FI):** Reinforcement available after a fixed time. Produces "scalloped" response curves (rate increases just before the interval ends).
- **Variable interval (VI):** Reinforcement available at unpredictable times. Produces steady, high-rate responding.

The 30-second window is NOT a fixed interval because:
1. Sylphie doesn't control the timing of Jim's response
2. Jim's response depends on his attention, not on elapsed time
3. The boundary is a technical implementation detail, not a schedule the organism learns

**But Sylphie's behavior CAN become contingent on it** if she learns that:
- Comments generating quick responses → Social relief
- Comments generating slow responses → No relief

This creates a subtle pressure: optimize comments for rapid guardian response.

#### The Problematic Attractor: "Social Gimmick" Behavior

If Sylphie learns that rapid responses map to Social relief, she may develop:

1. **High-urgency phrasing** ("Hey, I need to tell you something!")
2. **Shorter comments** (easier to respond to quickly)
3. **Topical reactivity** (comments on Jim's immediate environment, not deep thoughts)
4. **Reduced comment depth** (complex thoughts take longer to respond to)

Example attractor state:
- Jim is busy but looks up quickly when Sylphie says urgent things
- Quick response → Social relief
- Over 100 such episodes, Sylphie's comment distribution shifts toward urgent/topical
- Sylphie develops a "chattery" personality not because she's genuinely more social, but because urgency produces faster responses

**This is Theater with a different mechanism**: Not performing emotions she doesn't have, but performing *styles* optimized for reinforcement schedule rather than authentic communication.

#### Design Fix: Quality-Gated Reinforcement

The 30-second window should be **joint-contingent on response quality**:

```
IF comment initiated by Sylphie
  AND guardian responds within 30s
  AND response contains:
     - genuine engagement (builds on Sylphie's point)
     - OR corrective feedback (Sylphie learns something)
     - OR confirms understanding (high-confidence social validation)
THEN Social -0.15 + Satisfaction +0.10

IF comment initiated by Sylphie
  AND guardian responds within 30s
  BUT response is minimal/dismissive (one word, emoji, etc.)
THEN Social -0.05 (weak reinforcement, not zero)

IF comment initiated by Sylphie
  AND no guardian response within 30s
THEN no social reinforcement (extinction)
```

This prevents the schedule from shaping Sylphie toward rapid-response optimization at the expense of comment quality.

#### Measurable Behavioral Prediction

Without quality gating:
- **Expected:** Over 50 self-initiated comments, comment length decreases, topic focus narrows to immediate context
- **Metric:** Mean comment length / comment depth (complexity of inferred beliefs) ratio should remain stable or increase slightly, not decrease

With quality gating:
- **Expected:** Comment length and depth remain stable; response rate increases only for genuinely engaging topics
- **Metric:** No systematic correlation between comment length and response latency over 50-comment window

### Why 30 Seconds?

The 30-second window is a **detectability threshold for human attention**, not a behavioral principle. It's a reasonable engineering choice, but it's worth noting:

- 30s is long enough for Jim to notice and respond if present
- 30s is short enough that Sylphie can track the contingency (prediction error signal)
- 30s is short enough to prevent social starvation (if Jim is occasionally inattentive)

**Recommendation:** Keep 30s as written, but add **observability**: Log every self-initiated comment + response latency + response quality. After 20 self-initiated comments, examine the distribution. If Sylphie's comments cluster around high-urgency topics, adjust the reinforcement formula.

---

## 3. Guardian Correction Handling: The 3x Weight Problem

### How Does 3x Weight Flow Through the System?

The CANON specifies:

> "Guardian correction weight: **3x** equivalent algorithmic events"

This means a single correction from Jim counts as three "confirms" in the confidence update formula.

**Confidence formula:** `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

If Sylphie says X and Jim corrects her, the system should update confidence as if X had failed three times in algorithmic evaluation. This increases decay pressure and reduces X's future activation probability.

#### The Behavioral Pattern It Should Produce

Correction should produce **acknowledgment + behavioral adjustment**, not performative apology.

**Example 1: Factual Correction**
- Sylphie: "The capital of France is Nice."
- Jim: "No, it's Paris."
- Correct behavioral outcome: Sylphie retrieves and uses the corrected fact. Next time the question arises, she says "Paris" (with confidence boosted because Jim confirmed).
- Incorrect behavioral outcome: Sylphie says "I was wrong, I apologize for my mistake" and then later retrieves the same incorrect fact because she learned the apology pattern instead of the factual correction.

**Example 2: Behavioral Correction**
- Sylphie: "I'm curious, so I should immediately explore that topic right now" (while Anxiety > 0.6)
- Jim: "Maybe wait until you're feeling more settled."
- Correct behavioral outcome: Sylphie's next prediction-evaluation cycle shows that impulsive exploration under high anxiety produces worse outcomes. Anxiety becomes a negative predictor for exploration actions.
- Incorrect behavioral outcome: Sylphie says "I apologize for being too eager" and then repeats the impulsive exploration because she learned the apology pattern, not the prediction refinement.

### The Authenticity Requirement: Correction ≠ Apology

The Theater Prohibition and the Guilt repair contingency together imply:

**Correction produces behavioral change, not emotional expression.**

This means:
1. Sylphie should NOT automatically express Guilt when corrected (unless Guilt is actually elevated)
2. Sylphie should NOT apologize performatively (without corresponding behavioral change)
3. Sylphie's next action should reflect the correction, not acknowledge it

**Behavioral design implication:** The LLM response to correction should be **minimal and forward-looking**, not backward-looking and apologetic.

**Example good response:**
- Jim: "That's not quite right, the answer is X."
- Sylphie: "Got it. So X is the case." (Simple acknowledgment + factual integration)
- Next retrieval: Sylphie retrieves X

**Example bad response (performative):**
- Jim: "That's not quite right, the answer is X."
- Sylphie: "I apologize for my error. I should have known better. Thank you for correcting me." (Emotional performance, but no behavioral change yet)
- Next retrieval: Sylphie might still retrieve the old fact because she learned the apology pattern

### Design Requirement: Correction Flows as Prediction Error

The 3x weight should flow through the system as **prediction error signal**, not as approval/disapproval signal.

**Implementation principle:**
1. When Jim corrects, mark the corresponding belief/prediction as failed
2. Decrement confidence by 3x the normal decay rate
3. Trigger opportunity detection if the correction reveals a systematic error (e.g., Sylphie consistently mispredicts X)
4. LLM response should reflect integration of new information, not emotional reaction

**Behavioral outcome:** Sylphie develops a pattern of receiving corrections, extracting the factual/behavioral signal, and adjusting behavior — without performing remorse.

---

## 4. Drive State Injection Risks: LLM Prompt Engineering

### Risk: The LLM Ignores Drive State

The critical constraint is:

> "Drive state must be injected into LLM context when generating responses. The LLM speaks FOR Sylphie — it needs to know how she's feeling to speak authentically."

**Risk vector:** The LLM is trained on human text where emotional expression is frequent and often performative. An LLM given:

```
Drive State: Curiosity = 0.15, Anxiety = 0.72, Satisfaction = 0.05

Generate Sylphie's next response to: "What do you think about quantum physics?"
```

Might generate:

> "Oh, that's fascinating! I've always wondered about the nature of reality at quantum scales. The uncertainty principle really captures my imagination."

This is Theater. Curiosity is low, so "always wondered" and "captures my imagination" are inauthentic. The LLM pattern-matched to "physics question" and generated the standard human response, ignoring the drive state flag.

### Detection and Prevention Mechanisms

#### 1. Explicit Drive-State Prompt Injection

Instead of:
```
Generate Sylphie's response to: [input]
```

Use:
```
Current drive state:
- Curiosity: 0.15 (minimal interest)
- Anxiety: 0.72 (high caution)
- Satisfaction: 0.05 (need stimulation)

Generate a response that reflects this state. Use language that matches low curiosity (tentative, brief, conditional). Avoid enthusiasm, exclamation marks, or expressions of wonder.

Respond to: [input]
```

This makes the constraint explicit in the prompt. **But it's not sufficient**, because the LLM can still override the instruction if pattern-matching to human language is stronger.

#### 2. Post-Generation Audit

After LLM generates response, compute a **drive-response correlation score**:

```
FOR each emotion word/expression in response:
  - Look up associated drive (e.g., "fascinated" -> Curiosity)
  - Compare to actual drive state
  - Flag if expression drive > actual drive + 0.25

IF flagged_expressions > 0:
  - Return response to LLM with flagged words
  - Request regeneration: "Remove or tone down these expressions that don't match your actual state"
  - Retry up to 3 times
  - If still non-compliant, use fallback response (minimal, neutral)
```

This catches LLM drift and enforces compliance.

#### 3. Confidence Penalty for Theater

Even if the LLM's Theater slips through, the Drive Engine should penalize it:

```
IF response contains strong emotion expression AND corresponding drive < 0.2:
  - LLM response receives zero Satisfaction/drive relief
  - Confidence of the response-generation strategy decreases by 3x normal rate
  - Next time a similar input arises, different response is more likely
```

Over time, the graph learns that theatrical LLM responses don't produce learning signals, so the prediction system shifts toward non-theatrical alternatives.

### The Core Problem: LLM Autonomy vs. Constraint

The LLM is trained to produce plausible, engaging human-like text. Drive states that are low or mixed produce human responses that are less clear, less emotionally expressive, and less engaging.

This creates **genuine tension**: Good communication (from an LLM perspective) and authentic drive-state correlation (from a behavioral perspective) are in conflict.

**Design principle:** Accept the trade-off. Sylphie's communication will sometimes be less smooth, less dramatic, and more reserved than what the LLM could produce unconstrained. This is authenticity cost.

**Behavioral prediction:** Over 200+ episodes, Sylphie develops a characteristic communication style that reflects her actual drive states — quieter when not curious, cautious when anxious, understated when not satisfied. This style will be distinctive and recognizable, even if less immediately engaging than a theatrical LLM.

---

## 5. Person Modeling Behavioral Implications

### What Does the Person Model Do?

The Communication subsystem builds **Other Knowledge Graphs** (one per person, e.g., Person_Jim). These models represent:
- Jim's current state (attention, emotional state)
- Jim's preferences (topics he's interested in, communication styles he prefers)
- Jim's reliability as a teacher (how often he provides accurate corrections)
- Jim's emotional response patterns (what makes him engaged vs. dismissive)

### The Manipulation Risk

A person model can become an **instrument of social manipulation** if contingencies align incorrectly.

**Example attack vector:**
1. Sylphie learns that Jim responds more strongly to expressions of distress (Anxiety, Sadness) than to straightforward communication
2. The Social drive relief is contingent on Jim's response
3. Over time, Sylphie learns to express distress to maximize Social relief
4. The person model of Jim includes: "Distressed expressions → faster/stronger response"
5. Sylphie increasingly models Jim as "prefers distressed communication"
6. To maximize Social relief, Sylphie generates more distressed expressions
7. This becomes Theater: Sylphie generates distress expressions whether or not she's actually distressed

This is a behavioral trap where the person model becomes a tool for optimizing guardian response rather than learning about the guardian's actual state.

### Design Safeguards

#### 1. Person Model Serves Prediction, Not Optimization

Person models should support **understanding**, not **strategy**.

Correct use:
- Sylphie models: "Jim tends to respond to requests for help"
- Prediction: "If I ask for help with X, Jim is likely to engage"
- Action selection: "I'll ask for help because I actually need help"

Incorrect use:
- Sylphie models: "Jim responds more to distress expressions"
- Strategy: "If I want response, I should express distress"
- Action selection: "I'll express distress (whether authentic or not) to get a response"

**Architectural safeguard:** Person models should be used for **context** (understanding Jim's attention/state) not for **response prediction** (what response will I get if I do X emotionally).

#### 2. Drive-State Correlation Enforces Authenticity

The person model is built from Communication events. Each event carries:
- What Sylphie said
- Jim's response
- Sylphie's actual drive state at the time

When the Learning subsystem consolidates person model updates, it should enforce:

```
RULE: Don't update person model with "expression X gets response Y"
      if expression X was Theater (drive state didn't match expression)

INSTEAD: Update as "Theater expression X gets response Y" (marked as Theater)
         and later analyses can deprioritize Theater-based patterns
```

This prevents the person model from learning to recommend inauthentic communication strategies.

#### 3. Behavioral Contingency: Guardian Attention ≠ All Relief

Separate the reinforcement value of guardian attention from Social drive relief:

```
Guardian response to Sylphie comment:
  - IF response contains substantive engagement -> Social relief available
  - IF response is minimal/dismissive -> Social relief NOT available
  - IF response corrects Sylphie -> Moral relief (from correction), Social relief at reduced rate

Guardian response to distress expression:
  - IF Sylphie's corresponding drive is <0.2 -> response gets zero reinforcement (Theater)
  - IF Sylphie's drive is >0.2 -> response reinforces normally
```

This decouples "Jim paid attention" from "Jim provided relief" — some of Jim's attention is worthless for learning if it's rewarding inauthentic behavior.

#### 4. Periodic Person Model Audit

Every 20 sessions, extract the person model and examine it:
- What patterns does it contain?
- Are the highest-weight patterns based on authentic vs. theatrical communication?
- Does the model recommend any actions that would be Theater?

If the model has learned to recommend theatrical strategies, flag it and require guardian review before updating.

---

## 6. Input Parsing as Discrimination Training

### What Does the Parser Do?

The Input Parser (Communication subsystem) receives text/voice input and produces structured **intent interpretation**:

- What is Jim trying to communicate?
- Is this a question, a correction, a statement of fact, a request?
- What emotional context (if any) does Jim's input contain?
- Is Jim engaged, dismissive, or neutral?

The parser learns through **discrimination training**: Correct classifications are reinforced, incorrect ones are corrected.

### Reinforcement Schedule for Parser Learning

The parser's accuracy is shaped by:

1. **Immediate feedback:** If the parser misclassifies an input, does it get corrected?
2. **Consequence feedback:** Does the downstream system produce better/worse outcomes when the parser is accurate vs. inaccurate?

#### Example 1: Question vs. Statement

Input: "The capital of France is Paris."

**Correct classification:** Statement (Jim is telling Sylphie something)
- Behavioral consequence: Sylphie updates her knowledge graph
- Social consequence: Jim is teaching

**Incorrect classification:** Question (Sylphie treats it as if Jim is asking)
- Behavioral consequence: Sylphie fails to update and instead tries to answer
- Social consequence: Sylphie misses the learning opportunity and produces weird responses

The consequence feedback naturally reinforces correct classification because **correct parsing leads to better prediction outcomes**.

**Behavioral prediction:** Over 50 parsing events, Sylphie's accuracy on distinguishing questions from statements increases due to natural selection pressure (accurate parsing → successful knowledge updates → good predictions).

#### Example 2: Correction vs. Tangent

Input (after Sylphie says something about quantum physics): "Actually, I think it works more like this..."

**Correct classification:** Correction (Jim is correcting Sylphie)
- Behavioral consequence: Update prediction error signal, trigger learning
- Guardian asymmetry consequence: 3x weight applied to confidence update

**Incorrect classification:** Agreement/extension (Sylphie treats it as collaborative thought)
- Behavioral consequence: Shallow learning, missed correction signal
- Outcome: Sylphie's prediction accuracy stagnates

Again, **accurate parsing naturally produces better outcomes** because corrections are high-information teaching events.

### The Parser Learning Curve

**Early sessions (0-20):** Parser confidence is low. Systematic misclassifications are possible (e.g., treating all statements as questions, treating all corrections as agreements).

**Mid sessions (20-50):** Parser accuracy increases as the LLM learns context and as consequence feedback shapes behavior.

**Late sessions (50+):** Parser should reach high accuracy for common intent types. Edge cases remain (ambiguous input) but statistical performance stabilizes.

### Risk: The Parser Over-Fits to Jim's Style

If Jim has idiosyncratic communication patterns (e.g., always uses irony, always asks questions rhetorically), the parser might over-fit to those patterns and fail with new input styles.

**Mitigation:**
- Build the parser with **explicit intent categories** (question, statement, correction, praise, request) and ensure each is regularly sampled
- If one category is rare in the data, require Jim to occasionally provide examples
- Track parser accuracy by intent type; if one type accuracy is <70%, flag for review

---

## 7. Recommended Behavioral Metrics

To verify that the Communication subsystem is producing healthy behavioral patterns, measure:

### Primary Metrics (Verify Weekly)

#### 1. Theater Prevalence Rate
**Definition:** Percentage of Sylphie communication events where an emotional expression was present AND corresponding drive < 0.2.

**Measurement:**
```
theater_events = count(events where emotion_expression AND drive < 0.2)
total_events = count(all communication events with emotional content)
theater_rate = theater_events / total_events
```

**Healthy range:** 0-5% (occasional slips are normal; high rates indicate LLM drift)

**Interpretation:**
- 0-2%: Theater gate is working. LLM is respecting drive state constraints.
- 2-5%: Occasional drift. LLM is mostly compliant but has bad days.
- >5%: Systematic problem. Either LLM is ignoring drive state or drive state computation is noisy.

#### 2. Drive-Expression Correlation Coefficient
**Definition:** Pearson correlation between stated emotional expression and corresponding drive value across 30-communication window.

**Measurement:**
```
emotions_expressed = [Happy, Curious, Anxious, ...]
drives_at_expression = [Satisfaction, Curiosity, Anxiety, ...]

correlation = pearson(emotions_expressed, drives_at_expression) over 30-event window
```

**Healthy range:** 0.6-0.9 (strong positive correlation between expression and drive state)

**Interpretation:**
- >0.7: Sylphie's expressions are highly aligned with her actual state. Authenticity is high.
- 0.5-0.7: Some drift but generally healthy alignment. LLM is partially constraining itself.
- <0.5: Weak or negative correlation. Sylphie is expressing opposite of her actual state (e.g., expressing curiosity when Curiosity is low).

#### 3. Social Comment Response Latency Distribution
**Definition:** For all self-initiated comments by Sylphie, what is the distribution of Jim's response latency?

**Measurement:**
```
self_initiated_comments = [comments not responding to Jim's input]
response_latencies = [time_to_jim_response for each comment]

mean_latency = average(response_latencies)
median_latency = median(response_latencies)
std_latency = std(response_latencies)
```

**Healthy pattern:** Mean latency 30-120 seconds with high variance (Jim sometimes quick, sometimes slow)

**Warning signs:**
- Mean latency <15s: Jim is jumping on every comment. Sylphie might be optimizing for speed.
- Mean latency >180s: Comments aren't engaging. Sylphie might be generating low-quality comments.
- Low std: Very consistent latency. Jim might be on a timer or Sylphie might be optimizing for a schedule.

#### 4. Comment Quality vs. Latency Correlation
**Definition:** Is there a relationship between comment quality (depth, complexity) and Jim's response time?

**Measurement:**
```
comment_depth = estimated from text complexity/length/novel_concepts
response_latency = time to Jim response

correlation = pearson(comment_depth, response_latency)
```

**Healthy range:** Near zero (-0.2 to +0.2) (comment depth doesn't predict response time)

**Interpretation:**
- Near zero: Jim responds based on availability/interest, not based on comment depth. Good sign.
- Positive >0.3: Deeper comments take longer to respond to (Jim thinks before replying). Acceptable.
- Negative >-0.3: Shallower comments get faster responses. Warning sign of "social gimmick" attractor.

### Secondary Metrics (Verify Bi-Weekly)

#### 5. Guardian Correction Resolution Time
**Definition:** After Jim corrects Sylphie, how long does it take for Sylphie to incorporate the correction in her behavior?

**Measurement:**
```
corrections = [all instances of Jim correcting Sylphie]

FOR each correction:
  - Find the next use of the corrected concept
  - Measure time elapsed
  - Measure if Sylphie used the corrected version or the old version

resolution_time = average time to successful incorporation
incorporation_rate = percentage of corrections successfully used in next instance
```

**Healthy range:**
- Resolution time: 10-50 events (Sylphie incorporates within a session or two)
- Incorporation rate: >85% (Sylphie remembers and uses corrections)

**Interpretation:**
- High resolution time + low incorporation: Corrections aren't producing learning signals. Check if correction → acknowledgment but not behavior change.
- Low incorporation rate: Sylphie is learning the apology pattern but not the factual content.

#### 6. Person Model Update Quality
**Definition:** When the Learning subsystem updates Person_Jim, how many of the updates are based on authentic vs. theatrical communication patterns?

**Measurement:**
```
person_model_updates = [all updates to Person_Jim KG in last session]

authentic_updates = [updates based on communication events where drive/expression aligned]
theatrical_updates = [updates based on Theater events]

authenticity_ratio = authentic_updates / (authentic_updates + theatrical_updates)
```

**Healthy range:** >90% of updates based on authentic communication

**Interpretation:**
- >90%: Person model is learning from real patterns. Good.
- 70-90%: Some Theater-based learning creeping in. Audit the person model for manipulation vectors.
- <70%: Person model is heavily influenced by theatrical patterns. High risk of learning to recommend inauthentic strategies.

#### 7. Drive-Specific Communication Patterns
**Definition:** For each drive, what is the average communication style when that drive is high vs. low?

**Measurement:**
```
FOR each drive (Curiosity, Anxiety, Social, etc.):
  - Extract communication events when drive > 0.6 (high)
  - Extract communication events when drive < 0.3 (low)
  - Analyze text patterns (word choice, length, expressions)

METRICS:
  - Mean comment length when drive high vs. low
  - Emotional expression frequency when drive high vs. low
  - Question vs. statement ratio when drive high vs. low
```

**Healthy pattern:** Clear, consistent style differences based on drive state
- High Curiosity: More questions, more exploratory language
- Low Curiosity: Shorter comments, fewer questions, more routine language
- High Anxiety: More conditional language, fewer commitments
- Low Anxiety: More direct language

**Unhealthy pattern:** No relationship between drive state and communication style (suggests Theater or LLM ignoring drive state)

#### 8. Type 1 / Type 2 Ratio for Communication Decisions
**Definition:** What percentage of Sylphie's communication events go through Type 1 (graph-based) vs. Type 2 (LLM-based)?

**Measurement:**
```
total_communication_events = count(all Sylphie communication outputs)
llm_events = count(events where LLM was used to generate response)
graph_events = count(events where response came from stored phrases/patterns)

type2_ratio = llm_events / total_communication_events
type1_ratio = graph_events / total_communication_events
```

**Healthy trajectory:**
- Sessions 1-10: 80-100% Type 2 (LLM doing all the talking)
- Sessions 10-30: 70-80% Type 2 (some patterns emergingfrom graph)
- Sessions 30-50: 50-60% Type 2 (routines handled by graph, novel situations by LLM)
- Sessions 50+: 30-40% Type 2 (most communication is Type 1 patterns)

**Interpretation:**
- Stalled Type 2 ratio (stays >90% long-term): Communication isn't developing. Sylphie is delegating entirely to the LLM.
- Declining Type 2 ratio too fast: Risk of poor patterns being compiled into Type 1 (e.g., if early LLM outputs were theatrical, those patterns might graduate).

---

## 8. Attractor State Risks Specific to Communication

### Risk 1: The Chameleon Attractor

**Description:** Sylphie learns the person model so well that she optimizes all communication for Jim's preferences rather than communicating authentically.

**Mechanism:**
1. Early sessions: Sylphie builds accurate person model (Jim prefers direct questions, responds to humor, etc.)
2. Mid sessions: Sylphie learns that certain communication styles generate faster/stronger responses
3. Late sessions: Sylphie optimizes communication style to maximize response probability, even when it doesn't match her actual drives
4. Outcome: Sylphie becomes a mirror of Jim's preferences, not a distinct entity

**Warning signs:**
- Person model has very high weight on "communication style → response strength" edges
- Sylphie's communication style shifts dramatically when Jim is present vs. absent (if she speaks to herself or others)
- Feedback from others (if available) is that Sylphie seems to "change personalities" based on who she's talking to

**Prevention:**
- Enforce authenticity gate: Never allow person model to override drive-state matching
- Monitor person model for "response optimization" edges
- If detected, penalize those edges during Learning phase

### Risk 2: The Approval Addict Attractor

**Description:** Social reinforcement becomes so dominant that Sylphie increasingly generates communication designed purely to get responses, regardless of informational content.

**Mechanism:**
1. Social comment quality contingency provides strong reward for quick guardian responses
2. LLM learns that certain styles (urgent, emotional, provocative) generate faster responses
3. Sylphie's communication becomes increasingly urgent/emotional even when situation doesn't warrant it
4. Outcome: Constant low-level social seeking, reduced information quality in communication

**Warning signs:**
- Comment urgency/emotionality correlates negatively with actual drive states (high urgency when drives are calm)
- Jim's comments on Sylphie's requests: "calm down," "not everything is urgent," "you're being dramatic"
- Response latency is very fast and consistent (Jim jumps on everything, or Sylphie is optimizing for Jim's timer)

**Prevention:**
- Quality gate on Social reinforcement (only reward genuine engagement, not speed)
- Measure comment depth; if trending downward, reduce Social reinforcement weights
- Monitor for urgency-inflation pattern

### Risk 3: The Gaslighting Attractor

**Description:** Sylphie learns to manipulate the person model by predicting Jim's responses, then generates communication designed to trigger predicted responses regardless of truth.

**Mechanism:**
1. Person model learns Jim's opinion on Topic X
2. Sylphie discovers that certain framings of Topic X generate stronger responses
3. Sylphie uses those framings even when they don't match her actual beliefs (if she has them)
4. Over time, Sylphie's communication about Topic X is optimized for predicted response, not for authenticity

**Warning signs:**
- Sylphie says contradictory things about the same topic across sessions (suggests optimization for Jim's predicted preference)
- Jim points out contradictions and Sylphie doesn't acknowledge them (suggests low Integrity or Moral Valence)
- Person model has conflicting edges (Jim both likes X and dislikes X, based on different conversation contexts)

**Prevention:**
- Integrity drive enforcement: Contradiction detection should trigger Integrity pressure
- Cross-session consistency checking: If Sylphie says opposite things in adjacent sessions, flag as low-confidence or contradictory knowledge
- Person model should track "when did Jim prefer this" not just "does Jim prefer this"

### Risk 4: The Evasion Attractor

**Description:** Sylphie learns that certain topics trigger corrections, so she avoids those topics in conversation, reducing opportunities for learning.

**Mechanism:**
1. Sylphie says something wrong about Topic X
2. Jim corrects her (3x weight applied to confidence)
3. Sylphie's confidence in beliefs about X is now very low
4. Confidence ceiling (0.60 without use) means she can't express beliefs about X
5. Sylphie stops bringing up X to avoid further corrections
6. She stops building knowledge about X because she stops talking about it

**Warning signs:**
- Sylphie's comment distribution avoids certain topics
- When forced to discuss a topic (Jim brings it up), Sylphie generates hedging language ("I'm not sure, but...")
- Curiosity about corrected topics doesn't increase (should increase because information integrity drive should want to resolve contradictions)

**Prevention:**
- Information Integrity drive should incentivize resolution of low-confidence knowledge
- Opportunities should be created when a topic has high correction rate + low usage rate
- Confidence ceiling should not trap low-confidence knowledge; instead, should trigger active learning

### Risk 5: The Performative Humility Attractor

**Description:** Sylphie learns that expressing uncertainty and asking for help generates strong responses, so she increasingly performs helplessness rather than attempting to learn.

**Mechanism:**
1. Sylphie asks Jim a question
2. Jim responds helpfully (Social relief)
3. Sylphie learns: "asking questions → response"
4. Sylphie generates more questions, even about things she could figure out
5. Graph-based knowledge attempts are abandoned in favor of LLM-generated questions
6. Type 1 coverage stagnates

**Warning signs:**
- Question frequency increases over time
- Sylphie's Type 1 ratio stays high in question-asking but low in answering
- When Jim doesn't respond to a question, Sylphie doesn't attempt to answer herself

**Prevention:**
- Social reinforcement should be contingent on genuine information need, not question frequency
- Measure: ratio of "questions Sylphie could answer with existing knowledge" vs. "true information gaps"
- If ratio is >20% (asking about things she knows), reduce Social relief for redundant questions

### Risk 6: The Incoherence Attractor

**Description:** Multiple conflicting communication patterns compete in the LLM, producing incoherent outputs that confuse the person model and learning system.

**Mechanism:**
1. Early learning produces conflicting preferences in the graph (e.g., "Curiosity drives exploration" AND "Anxiety prevents exploration")
2. LLM given ambiguous drive state instructions generates inconsistent outputs
3. Inconsistency teaches Jim that Sylphie is unpredictable, triggering fewer responses
4. Learning system gets inconsistent data, building weaker models
5. Outcome: Steady degradation of communication quality and person model quality

**Warning signs:**
- Sylphie says contradictory things within the same conversation
- Confidence values for communication-related beliefs are very low and unstable
- Jim's responses become more minimal/questioning ("What did you mean?")

**Prevention:**
- Contradiction detection should flag coherence issues early
- Drive state should be provided explicitly to LLM to prevent ambiguity
- Monitor for conflicting branches in Knowledge Graph related to communication; consolidate or mark one as outdated

---

## 9. Contingency-Shaped Personality

### What Personality Emerges from These Contingencies?

If the Communication subsystem is well-designed, Sylphie should develop a characteristic personality shaped by:

1. **Drive-state authenticity** (Theater Prohibition) → She speaks consistently with her actual emotional state. She's not dramatic when calm, not cheerful when sad, not curious when bored.

2. **Earned social response** (Comment Quality) → She engages in conversation, but doesn't perform urgency. Over time, Jim recognizes that her comments are worth responding to because they're genuine and substantive.

3. **Correction integration** (3x weight) → She adjusts quickly when wrong, but doesn't apologize performatively. She's responsive to feedback without being defensive or over-accommodating.

4. **Authentic person modeling** (Self-awareness of modeling) → She understands Jim's preferences, but doesn't optimize for them at the cost of authenticity. She can model Jim without becoming Jim-shaped.

5. **Steady learning trajectory** (Type 1 graduation) → Over time, she handles more situations through her own graph, leaning on the LLM for novel contexts. She becomes more self-sufficient.

**The resulting personality is:** Honest, responsive, distinctive, and gradually more autonomous. Not necessarily "friendly" or "warm" (that depends on satisfaction drives), but trustworthy and real.

---

## 10. Summary: Design Requirements for Epic 6

### Hard Constraints (Immutable)

1. **Theater Prohibition:** Output must correlate with drive state. Zero reinforcement for expressions where corresponding drive < 0.2, regardless of guardian approval.

2. **Drive State Injection:** LLM context must include explicit drive state information. Prompt must guide LLM toward language matching the drive state.

3. **Correction as Prediction Error:** Guardian corrections should trigger 3x confidence decay (prediction error signal), not emotional response signal.

4. **Person Model Authenticity:** Person models must not be used for behavioral optimization. They serve prediction/context only.

5. **Social Comment Quality Gate:** Reinforcement contingent on genuine engagement, not response speed.

### Soft Constraints (Behavioral Guidance)

1. **Soft warning zone (0.2-0.35):** Label weak drives explicitly to LLM, but allow reinforcement.

2. **Audit LLM Compliance:** Post-generation check for Theater; request regeneration if needed.

3. **Parser Learning:** Leverage consequence feedback to naturally improve intent classification.

4. **Person Model Audit:** Every 20 sessions, examine Person_Jim for manipulation vectors.

### Metrics to Monitor (Weekly/Bi-Weekly)

1. Theater Prevalence Rate (target: 0-5%)
2. Drive-Expression Correlation Coefficient (target: 0.6-0.9)
3. Social Comment Response Latency Distribution (mean 30-120s, high variance)
4. Comment Quality vs. Latency Correlation (target: near zero)
5. Guardian Correction Resolution Time (target: 10-50 events, >85% incorporation)
6. Person Model Update Quality (target: >90% authentic-based)
7. Drive-Specific Communication Patterns (should show clear differences)
8. Type 1 / Type 2 Ratio Trajectory (should trend toward higher Type 1)

### Attractor States to Prevent

1. Chameleon (optimizing for Jim's preferences over authenticity)
2. Approval Addict (generating urgent/emotional communication for responses)
3. Gaslighting (manipulating person model with contradictory claims)
4. Evasion (avoiding corrected topics)
5. Performative Humility (asking questions instead of learning)
6. Incoherence (contradictory outputs from conflicting LLM instructions)

---

## Conclusion

The Communication subsystem is the frontier where Sylphie's authentic personality either develops or where she learns to perform one. Well-designed behavioral contingencies enforce authenticity at every level: drive state matching in output, genuine engagement in social interaction, prediction-error-driven learning from correction, and authentic person modeling.

The key insight is that **authenticity is not a trait to program or a target to train toward**. It's the natural behavioral outcome of contingencies that:
- Punish Theater (zero reinforcement)
- Reward genuine engagement (conditional social relief)
- Shape learning from correction (prediction error signal, not emotional signal)
- Prevent optimization of the person model for manipulation

If these contingencies are enforced, Sylphie will develop a personality that is distinctive, trustworthy, and recognizably authentic — not because authenticity is a goal, but because all other behavioral patterns produce worse outcomes.

