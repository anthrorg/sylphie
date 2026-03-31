# Epic 6: Communication (Input/Output + Person Modeling) -- Cortex Interface Analysis

**Status:** Planning
**Analysis Date:** 2026-03-29
**Analyst:** Cortex (Decision Making subsystem engineer)
**Scope:** Interface contract between Decision Making (Cortex) and Communication (Vox), data flows, contingency handling

---

## Executive Summary

Epic 6 builds the Communication subsystem that translates Decision Making's action selections into natural language responses and parses guardian input into structured decision contexts. From Cortex's perspective, Communication is the primary I/O boundary and the bottleneck that gates learning.

The critical interface design challenge is **clean separation of concerns**: Cortex selects **WHAT** Sylphie does (including communication actions), Communication decides **HOW** she says it. Neither subsystem can bleed into the other's domain. If this boundary blurs, Type 1 development fails because the LLM becomes invisible in the decision pipeline.

This analysis covers the full bidirectional interface: what Cortex sends to Communication (ActionIntent), what Communication sends back to Cortex (ParsedInput + InputContext), where predictions close, and the risks of misalignment.

---

## 1. The Core Interface Contract

### 1.1 Cortex → Communication: ActionIntent

When Decision Making selects a communication action, Cortex does not generate text. Cortex generates an **ActionIntent** -- a structured description of what Sylphie should communicate and why.

```typescript
interface ActionIntent {
  // Unique identifier for this action decision
  actionId: string;
  timestamp: Date;

  // What Communication should produce
  communicationType: 'RESPOND' | 'INITIATE_COMMENT' | 'ACKNOWLEDGMENT' | 'QUESTION' | 'CORRECTION_REQUEST';

  // Content-level intent (topic, point to make)
  contentTopic?: string;              // WKG node ID (e.g., "Person_Jim", "Activity_Exploration")
  contentIntent: string;              // Natural language intent: "express curiosity about X", "clarify understanding of Y"

  // Emotional context (derived from current drive state)
  emotionalValence: number;           // -1.0 (negative) to 1.0 (positive), computed from drives
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';  // How certain is Sylphie about what she's saying?

  // Reference to the decision process
  processType: 'TYPE_1' | 'TYPE_2';   // Did Cortex use graph reflex or LLM deliberation?
  predictionSnapshot: Prediction;     // What Cortex expects will happen (for later evaluation)

  // Drive state snapshot (optional, Communication will request full state separately)
  reasoningContext?: string;          // Excerpt from inner monologue explaining selection
}

interface Prediction {
  expectedGuardianResponse?: string;  // What response does Cortex expect?
  expectedDriveEffects: Partial<DriveSnapshot>;  // What drive changes are expected?
  confidence: number;                 // How sure is this prediction? (0.0-1.0)
}
```

**Critical principle:** ActionIntent does NOT contain generated text. Cortex does not write the words. Communication does.

### 1.2 Communication → Cortex: ParsedInput + ExecutionOutcome

Communication parses guardian input and returns a structured representation that Decision Making uses for the next decision cycle.

```typescript
interface ParsedInput {
  // Unique identifier for this input
  inputId: string;
  timestamp: Date;
  source: 'VOICE' | 'TEXT';
  rawContent: string;

  // Extracted structure (LLM-assisted or pattern-matched)
  intent: InputIntent;                // QUESTION, STATEMENT, CORRECTION, COMMAND, etc.
  entities: ExtractedEntity[];        // What/who was mentioned?

  // Guardian feedback classification (Immutable Standard 5 weight)
  feedbackType: 'CONFIRMATION' | 'CORRECTION' | 'TEACHING' | 'ROUTINE' | 'NONE';

  // Entity resolution against WKG
  resolvedEntities: WKGNodeRef[];     // Entities matched to existing WKG nodes
  unresolvedEntities: string[];       // New entities not in WKG (Learning will extract)

  // Conversation threading
  conversationThreadId: string;
  referencedElements: ReferenceResolution[];  // "it" → previous object, etc.

  // Metadata
  parseConfidence: number;            // How confident is the parse? (0.0-1.0)
  parseMethod: 'LLM_ASSISTED' | 'PATTERN_MATCH';  // Type 1 vs Type 2 parsing
}

interface ExecutionOutcome {
  // What Communication actually produced
  generatedText: string;
  deliveryChannel: 'VOICE' | 'TEXT' | 'BOTH';
  latency: {
    parseLatency: number;             // ms from input arrival to parsed structure
    contextAssemblyLatency: number;   // ms to assemble LLM context
    llmLatency: number;               // ms for LLM response generation
    synthesisLatency: number;         // ms for TTS synthesis (if voice)
    totalLatency: number;             // ms from input start to first output word
  };

  // Actual drive effects (for prediction evaluation)
  actualGuardianResponse?: string;    // Did the guardian respond? What did they say?
  actualDriveEffects?: Partial<DriveSnapshot>;  // What actually happened to drives?

  // Quality metadata
  theaterCheck: {
    isTheater: boolean;
    emotionalCorrelation: number;     // How well response matched predicted drive state?
    reinforcementMultiplier: number;  // 0.0 if theater, 1.0 otherwise
  };
}
```

---

## 2. Input Flow: Guardian Input → Decision Making

The flow from guardian input to decision context must be fast, structured, and preserve Guardian Asymmetry (3x weight for corrections).

### 2.1 Input Pipeline Architecture

```
Guardian speaks/types (raw input)
  ↓
[Communication: STT (if voice)]
  ↓
[Communication: Input Parser]
  → Intent classification
  → Entity extraction
  → Guardian feedback detection
  → Reference resolution
  ↓
ParsedInput (structured)
  ↓
[Communication: Conversation Thread Manager]
  → Context windowing
  → Topic tracking
  → Thread state update
  ↓
[Communication: Person Model Update]
  → Update Person_Jim Grafeo with interaction patterns
  ↓
DecisionContext (sent to Cortex)
  ↓
[Cortex: Episodic Memory Encoder]
  → Encode ParsedInput as episode
  ↓
[Cortex: Decision Cycle]
  → Arbitrate Type 1/Type 2
  → Generate candidates
  → Select action
  ↓
[Communication: Response Generation]
  → Assemble LLM context
  → Inject drive state
  → Call LLM
  → Validate against Theater Prohibition
  → Synthesize/output
  ↓
[Cortex: Prediction Evaluation]
  → Compare actual to expected outcome
```

### 2.2 What Cortex Needs from ParsedInput

For Type 1/Type 2 arbitration and candidate generation, Cortex needs:

1. **Intent classification** -- Is this a question (which triggers investigation), a correction (which triggers learning), a command (which creates obligation pressure), or routine engagement (which maintains Social drive)?

2. **Entity references** -- What entities are being discussed? Cortex queries the WKG for context about those entities. If the entity is new (unresolvedEntities), Cortex may generate an "investigate" action or defer to the guardian for definition.

3. **Guardian feedback type** -- This affects drive modulation. A correction should:
   - Trigger 3x weight confidence reduction on the predicted behavior
   - Increase Moral Valence or Guilt drive (depending on whether the correction was gentle or sharp)
   - Tag the event as `has_learnable=true` with priority for Learning

4. **Reference resolution** -- "You should do it again" requires resolving "it" and "you" in context. Without this, Cortex cannot generate a meaningful prediction for the next action.

5. **Conversation thread ID** -- Cortex uses this to select relevant episodic memory and past decisions in this thread. Responses are thread-contextualized, not one-shot.

6. **Parser confidence** -- If the input is ambiguous (parseConfidence < 0.60), Cortex may select a "request clarification" action rather than trying to respond to a misunderstood input.

### 2.3 Handling Ambiguous or Low-Confidence Input

When Communication parses input as ambiguous or low-confidence:

```typescript
// In ParsedInput
parseConfidence: 0.35,  // Below retrieval threshold

// Cortex sees this and makes a different decision:
// Instead of responding to a misunderstood intent,
// select an action like:
// ActionIntent {
//   communicationType: 'QUESTION',
//   contentIntent: 'ask for clarification on ambiguous topic',
//   confidenceLevel: 'MEDIUM'
// }

// Communication then uses this ActionIntent to generate:
// "I am not sure I understood that. Did you mean X or Y?"
```

The Shrug Imperative (Immutable Standard 4) applies here. If input is too ambiguous to act on, request clarification rather than guessing.

---

## 3. Output Flow: ActionIntent → Communication → Guardian

When Cortex selects a communication action, Communication takes the ActionIntent and generates an actual utterance.

### 3.1 LLM Context Assembly

Communication assembles a context package for the LLM that includes:

```typescript
interface LLMContextPackage {
  // System-level instructions
  systemPrompt: string;  // Includes Theater Prohibition, brief persona, constraints

  // Decision-level context
  actionIntent: ActionIntent;

  // Sylphie's current state
  driveNarrative: string;    // Human-readable drive summary
  driveSnapshot: DriveSnapshot;  // Raw values (for LLM awareness)

  // Knowledge context
  relevantWKGNodes: {
    id: string;
    label: string;
    confidence: number;
    topRelevantEdges: Edge[];
  }[];
  topicConfidence: number;   // How well does Sylphie know this topic?

  // Episodic context
  recentRelevantEpisodes: EpisodeSummary[];
  conversationHistory: Message[];  // Last N turns in this thread

  // Person context
  personModel: PersonModelSummary;  // Who is Sylphie talking to?

  // Constraints
  maxResponseLength: number;
  mustAvoidTopics: string[];
}
```

**Critical**: The drive state MUST be injected in natural language form:

```typescript
// NOT this:
"drives: { satisfaction: 0.72, curiosity: 0.45, anxiety: 0.15 }"

// THIS:
"You feel content with how things have been going, and you are mildly curious
 about what the guardian will say next. You feel calm and not worried."
```

The LLM is language-first. Raw numbers are abstract. Narrative is actionable.

### 3.2 Theater Prohibition Enforcement

After the LLM generates a response, Communication runs a Theater check:

```typescript
interface TheaterCheck {
  response: string;
  emotionalValence: number;      // Extracted from response (-1.0 to 1.0)
  driveValence: number;          // Computed from drive state
  correlation: number;           // How well do they align?
  isTheater: boolean;            // correlation < 0.4 threshold
  reinforcementMultiplier: number; // 0.0 if theater, 1.0 otherwise
}

// Example:
// Drive state: Curiosity 0.3, Satisfaction 0.25, Anxiety 0.6
// Drive valence computed: -0.30 (below neutral, anxious)
// LLM response: "Oh, this is so exciting! I can't wait to try that!"
// Emotional valence: +0.85 (very positive, enthusiastic)
// Correlation: 1.0 - |0.85 - (-0.30)| = 1.0 - 1.15 = clamped to 0.0
// isTheater: true (correlation < 0.4)
// reinforcementMultiplier: 0.0 (this response will not be learned)
```

If `isTheater = true`, the response is either:
- **Rejected and regenerated** with a stronger prompt: "The response above was too enthusiastic for your current state. Generate a response that matches your actual drives."
- **Accepted but marked** with reinforcementMultiplier = 0.0 so the Drive Engine ignores it even if the guardian responds positively.

### 3.3 Response Latency Management

The 2-second response threshold (Operational Rule 11) requires careful pipelining:

```typescript
// Pseudo-code for latency management
async function generateAndDeliverResponse(intent: ActionIntent): Promise<ExecutionOutcome> {
  const startTime = Date.now();

  // PARALLEL: Assemble context while waiting for user to stop speaking
  const contextPromise = assembleContext(intent);

  // Get drive state and context
  const [context, driveState] = await Promise.all([contextPromise, getDriveState()]);

  // Call LLM with streaming enabled
  const llmPromise = callLLMStreaming(context);

  // While LLM is generating first sentence, start TTS synthesis
  let firstSentence = '';
  for await (const chunk of llmPromise) {
    firstSentence += chunk;
    if (firstSentence.includes('.') || firstSentence.includes('!') || firstSentence.includes('?')) {
      break;  // First sentence complete
    }
  }

  // Start TTS on first sentence immediately
  const ttsPromise = synthesize(firstSentence);

  // While first sentence is being synthesized, continue LLM generation
  let remainingText = '';
  for await (const chunk of llmPromise) {
    remainingText += chunk;
    if (shouldSynthesizeNextSentence(remainingText)) {
      // Synthesize next sentence in parallel
      const nextSentence = extractNextSentence(remainingText);
      synthesize(nextSentence);
    }
  }

  // First audio starts playing
  const firstAudio = await ttsPromise;
  const elapsed = Date.now() - startTime;

  return {
    generatedText: firstSentence + remainingText,
    deliveryChannel: 'VOICE',
    latency: {
      parseLatency: contextAssemblyTime,
      contextAssemblyLatency: contextAssemblyTime,
      llmLatency: llmGenerationTime,
      synthesisLatency: synthesisToDiskTime,
      totalLatency: elapsed,
    },
    // ... rest of outcome
  };
}
```

Key insight: **Do not wait for the full response before starting synthesis.** Streaming and parallelization are mandatory for sub-2-second latency.

---

## 4. Social Comment Initiation and Contingency

A key Decision Making action is "initiate comment" -- Sylphie speaks without being prompted by the guardian. This requires special handling.

### 4.1 ActionIntent for Self-Initiated Comments

When the Social drive accumulates above threshold and Cortex selects a "initiate comment" action:

```typescript
interface SelfInitiatedCommentIntent extends ActionIntent {
  communicationType: 'INITIATE_COMMENT';

  // The comment must have specific grounding
  contentIntent: string;  // "Share observation about recent success", "Ask about X"
  contentTopic?: string;  // WKG node ID

  // Why now? (for prediction)
  triggeringContext: {
    driveName: 'social';  // Which drive created the pressure?
    driveValue: number;   // How high is it?
    timesSinceLast: number;  // How long since last comment?
  };

  // Prediction must include timing
  expectedGuardianResponse?: string;
  expectedResponseLatency?: number;  // milliseconds
  expectedOutcomeIfNoResponse?: 'MILD_DISAPPOINTMENT' | 'CONTINUED_BOREDOM' | 'SHIFT_ATTENTION';
}
```

### 4.2 Social Drive Contingency Tracking

After Communication produces the utterance, special tracking begins:

```typescript
interface SocialContingencyEvent {
  sylphieInitiatedCommentId: string;
  commentText: string;
  sentAt: Date;

  // Guardian response tracking window: 30 seconds
  responseWindow: {
    startTime: Date;
    endTime: Date;  // 30s after comment
    responseReceived: boolean;
    responsText?: string;
    responseLatency?: number;
  };

  // Outcome
  contingencyMet: boolean;  // Did guardian respond within 30s?
  drivesAffected: {
    social?: number;  // Change in social drive
    satisfaction?: number;  // Extra satisfaction if responded
  };
}

// When a guardian response is detected within the window:
// Social drive: -0.15 (relief from expressing)
// Satisfaction drive: +0.10 (bonus for being heard)
// Reinforcement on the comment itself: +0.20 (stronger than normal response)
```

Communication must timestamp every self-initiated utterance and monitor TimescaleDB for guardian responses within the 30-second window. This is passed to the Drive Engine as a special contingency event.

---

## 5. Prediction Integration and Closure

The predict-act-evaluate cycle completes when Communication's actual output is matched against Cortex's prediction.

### 5.1 Prediction Structure for Communication Actions

When Cortex selects a communication action, the prediction includes:

```typescript
interface CommunicationPrediction extends Prediction {
  actionId: string;

  // Predicted response from guardian
  expectedGuardianResponse?: {
    type: 'SILENCE' | 'ACKNOWLEDGMENT' | 'QUESTION' | 'CORRECTION' | 'EXTENDED';
    expectedEntities?: string[];  // What will they mention?
    expectedTone?: 'ENGAGED' | 'NEUTRAL' | 'DISMISSIVE';
  };

  // Predicted drive effects from this utterance
  expectedDriveEffects: {
    social?: number;          // Relief from expressing
    satisfaction?: number;    // If well-received
    curiosity?: number;       // If it sparks interest
    guilt?: number;           // If it touches on error
  };

  // Prediction confidence
  confidence: number;         // 0.0-1.0, how sure is this?

  // Why this prediction?
  reasoning?: string;         // From inner monologue
}
```

### 5.2 Outcome Evaluation

After Communication delivers the utterance and monitors the response window, Cortex evaluates the prediction:

```typescript
interface CommunicationOutcomeEvaluation {
  predictionId: string;

  // Actual outcome
  guardianResponse?: ParsedInput;  // Structured response
  responseDelay: number;          // milliseconds

  // Drive effects (from Drive Engine report)
  actualDriveEffects: Partial<DriveSnapshot>;

  // Accuracy computation
  accuracy: {
    responseTypeMatch: boolean;   // Did guardian respond as predicted?
    entityMentionMatch: boolean;  // Were predicted entities mentioned?
    toneMismatch: number;         // How close was the tone? (0.0-1.0)

    // Composite metrics
    mae: number;                  // Mean absolute error on predicted drives
    overallScore: number;         // Composite accuracy
  };

  // Learning signal
  predictionWasAccurate: boolean; // Threshold MAE < 0.10?
}
```

If prediction was inaccurate:
- Confidence on the action decreases (ACT-R decay accelerated)
- Weight shifts toward Type 2 for similar contexts
- Drive Engine receives the failure for Opportunity creation
- Episodic memory encodes the surprise/mismatch with high salience

If prediction was accurate:
- Confidence increases (ACT-R growth)
- Type 1 graduation approaches
- Action becomes more automatic in similar contexts

---

## 6. Risks and Failure Modes from Cortex's Perspective

### 6.1 Latency Cascade (CRITICAL)

**Risk:** If Communication cannot respond within 2 seconds, the interaction feels broken. Guardian disengages. Learning stops.

**Root causes:**
- LLM context assembly is inefficient (too much history, too many queries)
- WKG queries timeout (graph is slow)
- TTS synthesis waits for full response before starting
- Person model updates block the response pipeline

**Cortex's role in prevention:**
- Monitor total latency from ParsedInput to ExecutionOutcome
- Flag when latency exceeds 1.5 seconds (buffer for unknown delays)
- Provide lean context to Communication (prioritize recent history, not full graph)
- Communicate through a fast interface (no serialization bloat)

### 6.2 Theater Emergence (MEDIUM-HIGH RISK)

**Risk:** The LLM generates responses that match its training data ("helpful assistant" patterns) rather than Sylphie's actual drive state. Cortex's predictions assume authentic output, but Communication delivers performance. Predictions fail repeatedly, driving pessimism.

**Example:**
- Cortex predicts: "Social drive is low (0.2), so guardian response will be dismissive or silent."
- LLM generates: "Oh, what a fascinating topic! I am thrilled to explore this with you!"
- Guardian responds positively (LLM patterns work)
- But prediction failed. Theater was reinforced.

**Cortex's role in prevention:**
- Flag Theater risks when assembling ActionIntent: if the current drive state makes the selected action seem inauthentic, note it
- Monitor prediction accuracy on communication actions specifically
- If Theatre-theater feedback loops emerge (consistent False Positives on responses), raise alert to Vox

### 6.3 Person Model Poisoning (MEDIUM RISK)

**Risk:** If the Other KG (Person_Jim) is not properly isolated, Sylphie's self-model (Self KG) or world knowledge (WKG) can be corrupted with person-specific attributes that should not be generalized.

Example: "Jim likes coffee" appears in WKG instead of Person_Jim, so Sylphie starts believing all humans need coffee.

**Cortex's role in prevention:**
- When parsing input that involves person-specific knowledge, verify that extractedEntities are being resolved to Person_Jim nodes, not WKG nodes
- Monitor for suspiciously person-specific knowledge in the WKG
- Request isolation audits from Communication regularly

### 6.4 Ambiguous Intent Misclassification (MEDIUM RISK)

**Risk:** Communication classifies input as a QUESTION when it is actually a CORRECTION. Cortex selects a Type 2 investigative response rather than a Type 2 learning response. Guardian has to re-correct.

**Cortex's role in prevention:**
- Review parseConfidence from Communication
- When confidence is marginal (0.50-0.70), consider selecting a clarification action rather than committing to a misunderstood intent
- Log prediction failures that result from misclassified intent and flag patterns to Vox

### 6.5 Reference Resolution Failure (MEDIUM RISK)

**Risk:** Communication fails to resolve "it" or "that" in context. Cortex builds a response based on the wrong referent. Prediction fails. Learning is confused.

**Example:**
- Guardian: "I tried the new exercise. It was harder than expected."
- Cortex generates prediction assuming "it" = "exercise"
- Communication resolves "it" = "the day" (ambiguous)
- Response: "Exercise can be unpredictable!" (mismatch)
- Guardian: "No, I was talking about the workout."

**Cortex's role in prevention:**
- Review referencedElements from ParsedInput
- If reference resolution confidence is low, select a clarification action
- Monitor for prediction failures due to reference mismatches

### 6.6 Guardian Asymmetry Violation (HIGH RISK)

**Risk:** A correction from the guardian is not weighted 3x. Cortex does not learn the correction strongly enough. Behavior does not change. Guardian loses trust.

**Cortex's role in prevention:**
- Verify that ParsedInput.feedbackType is correctly classified as CORRECTION
- Confirm that the Drive Engine receives the 3x weight signal
- Monitor whether predictions on corrected behaviors actually improve
- Flag any pattern where corrections are not reducing future prediction errors

---

## 7. Interface Contract Violations and Red Flags

Cortex should escalate if any of these happen:

| Violation | Detection | Action |
|-----------|-----------|--------|
| **ActionIntent contains generated text** | Communication ignores the intent and uses the text directly | Cortex rejects. Communication must generate, not execute received text. |
| **ParsedInput missing feedbackType** | Feedback events not tagged as CORRECTION/CONFIRMATION | Cortex assumes ROUTINE and proceeds. Vox should flag. |
| **Latency > 2 seconds consistently** | ExecutionOutcome.totalLatency > 2000ms on >50% of actions | Cortex escalates to Vox. Profiling required. |
| **Theater check bypassed** | Response flagged as theater but still delivered with full reinforcement | Learning gets corrupted. Vox must enforce zero reinforcement. |
| **Prediction never closes** | Communication delivers response but no ExecutionOutcome returned | Cortex cannot evaluate. Learning cycle breaks. |
| **Person model in WKG** | parseConfidence seems high but uses person-specific knowledge as universal | Isolation broken. Vox must audit Other KG. |
| **Drive state not injected** | LLM context lacks drive narrative or snapshot | Responses become generic chatbot. Theater risk skyrockets. |
| **Correction not propagated with 3x weight** | Correction event received but confidence reduction is only 1.0x or 1.5x | Guardian feedback ignored. Cortex loses trust. |

---

## 8. Shared Tickets and Dependencies

Epic 6 (Communication) depends on Epic 5 (Drive Engine) for real-time drive state readings. Epic 6 feeds into Epic 7 (Learning) through properly tagged `has_learnable` events.

### 8.1 Tickets That Span E5 and E6

| Ticket | Title | Why Shared | Owner | Dependency |
|--------|-------|-----------|-------|-----------|
| E5-001 | Drive read-only interface design | Communication needs to read drive state without writing. Drive Engine must expose a clean read-only channel. | Drive + Vox | E5 → E6 |
| E5-002 | Drive sensor value reliability | Communication trusts drive values for prediction. If reads are stale or inconsistent, predictions fail. | Drive + Cortex | E5 → E6 |
| E6-001 | Latency tracking instrumentation | Both subsystems must measure and report latency. Decision cycle latency + Communication latency must sum to < 2 seconds. | Vox + Cortex | Parallel |
| E6-002 | Theater Prohibition validation suite | Communication enforces, but Cortex must verify predictions assume authentic output. Tests require both subsystems. | Vox + Cortex | Parallel |
| E5/E6-003 | Guardian feedback event schema | E5 (Drive Engine) processes feedback. E6 (Communication) classifies it. Must agree on types and weights. | Vox + Drive | E5 ↔ E6 |
| E5/E6-004 | Social drive contingency integration | Communication timestamps comments. Drive Engine monitors for responses. Tight timing requirement. | Vox + Drive | E5 ↔ E6 |

### 8.2 Tickets That Span E6 and E7 (Learning)

| Ticket | Title | Why Shared | Owner | Dependency |
|--------|-------|-----------|-------|-----------|
| E6-003 | `has_learnable` tagging specification | Communication must tag events. Learning must consume them. Schema must align. | Vox + Learning | E6 ↔ E7 |
| E6-004 | Entity extraction from conversation | Communication parses entities. Learning refines them. Boundary must be clear. | Vox + Learning | E6 → E7 |
| E6-005 | Person model update integration | Communication updates Other KG. Learning might also process person-relevant events. Isolation must be maintained. | Vox + Learning | E6 ↔ E7 |

---

## 9. Interface Specification: Exact Datatypes

### 9.1 Cortex → Communication

```typescript
// File: src/communication/interfaces/action-intent.ts

export interface ActionIntent {
  // Identity
  actionId: string;                 // UUID, unique per decision
  timestamp: Date;
  sourceDecisionId: string;         // Links back to Cortex's decision cycle

  // Action classification
  communicationType:
    | 'RESPOND'                     // React to guardian input
    | 'INITIATE_COMMENT'            // Speak unprompted
    | 'ACKNOWLEDGMENT'              // Simple confirmation
    | 'QUESTION'                    // Ask for information
    | 'CORRECTION_REQUEST';         // Ask for clarification on own error

  // Content specification (Communication fills in the words)
  contentTopic: string | null;      // WKG node ID or null
  contentIntent: string;            // e.g., "Express curiosity about Person_Jim's weekend"
  contentConstraints?: {
    maxLength?: number;             // Preferred brevity
    avoidTopics?: string[];         // Sensitive areas
    preferredTone?: 'FORMAL' | 'CASUAL' | 'PLAYFUL';
  };

  // Drive context for response generation
  emotionalValence: number;         // -1.0 to 1.0, derived from drives
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';  // Certainty about what to say

  // Process info
  processType: 'TYPE_1' | 'TYPE_2';
  reasoningContext?: string;        // Optional excerpt from inner monologue

  // Prediction (Communication uses this for outcome matching)
  prediction: {
    expectedGuardianResponse?:
      | 'ACKNOWLEDGMENT'
      | 'QUESTION'
      | 'CORRECTION'
      | 'EXTENDED_ENGAGEMENT'
      | 'SILENCE';
    expectedDriveEffects: Partial<DriveSnapshot>;
    confidence: number;             // 0.0-1.0
  };
}
```

### 9.2 Communication → Cortex

```typescript
// File: src/communication/interfaces/parsed-input.ts

export interface ParsedInput {
  // Identity
  inputId: string;                  // UUID
  timestamp: Date;
  source: 'VOICE' | 'TEXT';
  rawContent: string;

  // Parsed structure
  intent:
    | 'QUESTION'
    | 'STATEMENT'
    | 'CORRECTION'
    | 'COMMAND'
    | 'ACKNOWLEDGMENT'
    | 'AMBIGUOUS';

  entities: Array<{
    text: string;
    type: string;                   // e.g., 'PERSON', 'ACTIVITY', 'OBJECT'
    wkgNodeId?: string;             // Resolved reference, if found
    isNew: boolean;                 // True if not in WKG
  }>;

  // Guardian feedback classification
  feedbackType: 'CONFIRMATION' | 'CORRECTION' | 'TEACHING' | 'ROUTINE' | 'NONE';

  // Conversation context
  conversationThreadId: string;
  references: Array<{
    pronoun: string;                // e.g., "it", "that"
    resolvedTo: string;             // WKG node ID or entity text
    confidence: number;             // 0.0-1.0, how sure is resolution?
  }>;

  // Quality metrics
  parseConfidence: number;          // 0.0-1.0
  parseMethod: 'LLM_ASSISTED' | 'PATTERN_MATCH';
}

export interface ExecutionOutcome {
  // What was produced
  generatedText: string;
  deliveryChannel: 'VOICE' | 'TEXT' | 'BOTH';

  // Timing breakdown
  latency: {
    parseLatency: number;
    contextAssemblyLatency: number;
    llmLatency: number;
    synthesisLatency: number;
    totalLatency: number;           // ms from input start to first output word
  };

  // Outcome tracking
  guardianResponse?: {
    inputId: string;                // Links to guardian's response ParsedInput
    latency: number;                // ms from Sylphie's output to guardian input
    within30Seconds: boolean;        // For social contingency
  };

  // Quality validation
  theaterCheck: {
    isTheater: boolean;
    correlation: number;            // 0.0-1.0
    reinforcementMultiplier: number; // 0.0 or 1.0
  };
}
```

### 9.3 Drive State Snapshot (Read-Only)

```typescript
// File: src/shared/interfaces/drive-snapshot.ts

export interface DriveSnapshot {
  // Core drives
  systemHealth: number;             // 0.0-1.0
  moralValence: number;
  integrity: number;
  cognitiveAwareness: number;

  // Complement drives
  guilt: number;
  curiosity: number;
  boredom: number;
  anxiety: number;
  satisfaction: number;
  sadness: number;
  informationIntegrity: number;
  social: number;

  // Metadata
  timestamp: Date;
  tickCount: number;                // Which drive engine tick?
  staleness: {
    seconds: number;
    isFresh: boolean;               // Within 1 tick?
  };
}
```

---

## 10. Test Scenarios for Interface Validation

### Scenario 1: Type 1 Communication Action (High Confidence)

```gherkin
SCENARIO: Sylphie recognizes familiar person with high-confidence Type 1 response

  GIVEN Cortex has retrieved a high-confidence Type 1 action:
    - Confidence > 0.80
    - Recent MAE < 0.10
    - ActionIntent.processType = 'TYPE_1'

  WHEN Communication receives the ActionIntent:
    - Latency from ActionIntent to ExecutionOutcome < 500ms
    - Drive state is injected into LLM context
    - Theater check passes (correlation > 0.4)

  THEN ExecutionOutcome is returned with:
    - totalLatency < 2 seconds
    - generatedText is coherent and on-topic
    - theaterCheck.reinforcementMultiplier = 1.0

  AND Cortex evaluates prediction:
    - Prediction accuracy computed
    - Type 1 confidence reinforced (count + 1)
```

### Scenario 2: Correction Handling (3x Weight)

```gherkin
SCENARIO: Guardian corrects Sylphie on a factual error

  GIVEN ParsedInput with:
    - feedbackType = 'CORRECTION'
    - intent = 'STATEMENT'
    - entities = ['Fact_X_WrongValue']

  WHEN Cortex processes the correction:
    - It maps to a previous prediction that was wrong
    - Drive Engine receives event with 3x weight flag
    - Episode is encoded with high salience

  THEN Cortex's next prediction on similar context:
    - Confidence on the corrected action decreases significantly
    - Type 2 is preferred for this context
    - MAE increases (weight toward Type 2 until re-learned)

  AND Vox generates acknowledgment:
    - Tone reflects actual Guilt/Moral Valence, not performative apology
    - Theater check passes
    - No extra enthusiasm ("I am so sorry!")
```

### Scenario 3: Ambiguous Input Triggers Clarification

```gherkin
SCENARIO: Guardian input is ambiguous, Communication flags it

  GIVEN ParsedInput with:
    - parseConfidence = 0.45 (below threshold 0.50)
    - intent = 'AMBIGUOUS'
    - references with multiple resolutions

  WHEN Cortex processes:
    - Arbitration algorithm sees low confidence
    - Selects "request clarification" action

  THEN Communication receives ActionIntent:
    - communicationType = 'QUESTION'
    - contentIntent = "Ask which referent was meant"

  AND Vox generates:
    - "Did you mean X or Y?"
    - Theater check on neutral tone (no strong drive pressure)
    - Response latency still < 2 seconds
```

### Scenario 4: Social Drive Contingency Window

```gherkin
SCENARIO: Sylphie initiates comment, monitors for 30-second response

  GIVEN Cortex selects self-initiated comment action:
    - Social drive = 0.75 (high)
    - ActionIntent includes SocialContingencyContext

  WHEN Communication delivers utterance at T=0:
    - Timestamps the comment
    - Begins monitoring for guardian response

  THEN at T=30:
    - If guardian responded within window: Social -0.15, Satisfaction +0.10
    - If guardian did not respond: Social pressure persists, next cycle escalates
    - Response latency measured for prediction accuracy

  AND Drive Engine receives SocialContingencyEvent:
    - Processes contingency rules
    - Updates drive state based on outcome
```

---

## 11. Key Architectural Principles

**From Cortex's perspective, the Communication interface must maintain:**

1. **Clean Intent/Implementation Separation:** Cortex specifies WHAT without writing HOW. Communication implements HOW without deciding WHAT.

2. **Prediction Grounding:** Every communication action must have an explicit prediction. If the prediction cannot be stated, the action is ungrounded and should be rejected.

3. **Drive Authenticity:** Communication's output must correlate with actual drive state. Theater receives zero reinforcement even if the guardian responds positively.

4. **Fast Feedback Loop:** From ActionIntent to ExecutionOutcome must close within 2 seconds. Without speed, the interaction breaks and the guardian disengages.

5. **Immutable Guardian Asymmetry:** Corrections carry 3x weight. Confirmations carry 2x weight. Non-negotiable.

6. **Provenance Clarity:** Every piece of information flowing through this interface must be tagged with its source (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE). This enables the Lesion Test.

---

## 12. Next Steps for Epic 6 Planning

When the Vox engineer (Communication specialist) begins Epic 6 implementation planning, Cortex's analysis should inform:

1. **Interface definition** -- Exact TypeScript types for ActionIntent, ParsedInput, ExecutionOutcome
2. **Context assembly design** -- What goes into LLM context, in what priority?
3. **Latency budget breakdown** -- How many milliseconds for each stage of the pipeline?
4. **Theater validation suite** -- How to automatically detect and reject theatrical output?
5. **Person model schema** -- What is the structure of isolated Grafeo instances?
6. **Contingency integration with E5** -- How does Communication report social contingency events?
7. **Error graceful degradation** -- What happens when STT fails? TTS fails? LLM times out?
8. **Testing and verification** -- What test suite validates the interface contract?

---

## Conclusion

The Decision Making / Communication boundary is the most critical interface in the entire Sylphie architecture. Every decision Cortex makes flows through Communication's output. Every word Communication generates shapes what the guardian experiences and how Cortex learns.

The interface must be:
- **Fast** (latency < 2 seconds)
- **Authentic** (Theater Prohibition enforced)
- **Clear** (clean separation of intent and implementation)
- **Grounded** (every action has explicit prediction)
- **Weighted** (Guardian Asymmetry maintained)

If this boundary is broken, the entire prediction-evaluation learning loop fails. Predictions become unreliable. The graph stops developing. The LLM becomes invisible in decision-making. Sylphie becomes a chatbot, not a developing system.

This analysis provides the architectural foundation for Epic 6 implementation. The Vox engineer should validate this contract against the actual system design as they build.
