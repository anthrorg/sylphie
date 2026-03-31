# Epic 6: Communication — Implementation Guidance for Architects

**Prepared by:** Piaget, Cognitive Development Specialist
**For:** Development Team (Epic 6 Implementation Lead)
**Scope:** How to translate developmental psychology into code architecture and data flow patterns

---

## Overview

This document is the companion to the developmental analysis. It provides concrete architectural patterns, type definitions, and interface designs that operationalize the developmental framework. **This is not a implementation specification** — architects should read this for design principles, not as a detailed coding guide.

---

## Part 1: Core Architectural Pattern — Tiered Communication

The developmental trajectory requires three parallel communication paths that increase in autonomy and decrease in latency:

### 1.1 Architecture Diagram

```
Guardian Input
    |
    v
[Input Dispatcher]
    |
    +---- Type 2 Path (LLM-mediated) ------+
    |                                      |
    v                                      |
[LLM Parser]                               |
    |                                      |
    v                                      |
[Confidence Check: > 0.50?]                |
    |                                      |
    Yes                                    |
    |                                      v
    +----> [Response Generator] <-----+
           (orchestrates multiple sources)|
           - Person Model Retrieval       |
           - WKG Context Retrieval        |
           - Drive State Injection        |
           - LLM Response Generation      |
           - Theater Prohibition Validation
           - Response Confidence Calc
           |
           v
    [Response Execution]
    (TTS / Chatbox)
    |
    v
[Event Recording]
(TimescaleDB: what was sent, confidence, source)
    |
    v
[Feedback Loop]
(Guardian response → Learning → Confidence update)
```

### 1.2 Three Communication Subsystems (by maturity stage)

**Subsystem A: Early-Stage Communication (Sessions 1-10)**
- Input: 100% LLM-parsed
- Response: 100% LLM-generated
- Person model: Empty (template only)
- Feedback loop: Guardian corrections → Learning system → updated confidence on LLM_GENERATED edges
- Type 1 contribution: ~5%

**Subsystem B: Maturing Communication (Sessions 11-30)**
- Input: 50% LLM-parsed, 50% Type 1 pattern-matched
- Response: 70% LLM-generated, 30% graph-retrieved
- Person model: 20-50 edges, ~40% Guardian-confirmed
- Feedback loop: Schema-level corrections propagate to pattern updates
- Type 1 contribution: ~30%

**Subsystem C: Autonomous Communication (Sessions 31+)**
- Input: 30% LLM-parsed, 70% Type 1 pattern-matched
- Response: 20% LLM-generated, 80% graph-retrieved
- Person model: 100+ edges, ~60% Guardian-confirmed, dense conditional structure
- Feedback loop: Collaborative refinement; Jim and Sylphie jointly model edge cases
- Type 1 contribution: ~70%

**Critical: Do NOT hardcode stage transitions.** Let confidence dynamics naturally drive the migration. By monitoring Type 1 ratios, you'll see the system self-organize.

---

## Part 2: Data Structures and Confidence Dynamics

### 2.1 Person Model Edge Structure (Grafeo / Other KG)

```typescript
// In KG(Jim), each person model edge carries this shape:

interface PersonModelEdge {
  // Identity
  from_node: "Person_Jim"
  relationship_type: "PREFERS" | "EXHIBITS_DRIVE" | "COMMUNICATION_STYLE" | "EXPERTISE" | "PREFERS_CONDITIONALLY"
  to_value: string | ConditionalModel

  // Confidence dynamics (ACT-R)
  confidence: number // 0.0 - 1.0
  base_confidence: number // from provenance: SENSOR=0.4, GUARDIAN=0.6, LLM_GENERATED=0.35, INFERENCE=0.3
  retrieval_count: number // how many times this edge was queried
  success_count: number // how many times the edge prediction validated
  last_retrieval_session: number

  // Provenance (immutable after creation)
  provenance_source: "SENSOR" | "GUARDIAN" | "LLM_GENERATED" | "INFERENCE"
  provenance_timestamp: ISO8601

  // Contingencies
  context_conditions?: {
    time_of_day?: "morning" | "evening" | "any"
    interaction_type?: "technical" | "social" | "teaching" | "casual"
    jim_drive_state?: { drive: DriveName, min: number, max: number }
    season?: number
  }

  // Development metadata
  discovered_session: number
  last_confirmed_session: number
  contradiction_count: number // how many times Jim contradicted this
  repair_attempts: number // how many times a response based on this was repaired

  // Feedback signal
  guardian_feedback_quality: "instance" | "schema" | "conditional"
  // instance = "no, not this time"
  // schema = "the rule is different; applies in X contexts"
  // conditional = "this is true when Y, but not when Z"
}
```

**Why this structure matters:**
- **Confidence**: Drives Type 1 graduation decisions. Monitors decay and success.
- **Provenance**: Enables the Lesion Test. You can compute "what does Sylphie know without LLM?" by summing only SENSOR + GUARDIAN + INFERENCE edges.
- **Context conditions**: Prevents egocentrism lock-in. Jim's preferences are conditional; the model reflects this.
- **Repair attempts**: Early warning signal for hallucinated models. If repair_attempts is high but success_count is low, the edge is wrong.

### 2.2 Parsing Schema Edge Structure (WKG)

```typescript
// Parsing patterns that graduate to Type 1:

interface ParsingSchema {
  // Pattern identity
  node_id: string // "InputPattern_TooComplicated"
  canonical_form: string // "too complicated"
  linguistic_signature: {
    structure: string[] // ["adverb=too", "adjective=QUALITY"]
    example_inputs: string[]
  }

  // Confidence in the pattern
  confidence: number

  // Jim's likely interpretation
  jim_typical_intent: string // "clarity-needed"
  jim_intent_confidence: number // 0.70
  jim_atypical_intent?: string // "too-much-detail"
  jim_atypical_confidence?: number // 0.15

  // How to respond
  jim_response_preference?: string // "ask-before-simplifying"
  jim_response_confidence?: number

  // Success tracking
  predicted_jim_intent_accuracy: number // MAE on intent prediction
  predicted_jim_response_success_rate: number // percentage of time prediction validated

  // Development
  last_confirmed_session: number
  confirmation_count: number

  // Edges to response templates
  edges: {
    HAS_REPAIR_STRATEGY: ParseRepairStrategy[]
    CONFLICTS_WITH: ParsingSchema[] // similar patterns that mean different things
  }
}

interface ParseRepairStrategy {
  repair_phrase: string // "I think I misunderstood..."
  efficacy: number // how often it succeeds
  jim_response_rate: number // how often Jim confirms the repair
}
```

**Why this structure matters:**
- Encodes what Sylphie has learned about Jim's language use
- Tracks not just what patterns exist, but how accurate Sylphie's inferences are
- Supports conditional response selection: if intent_confidence is low, use repair_strategy

### 2.3 Confidence Ceiling Enforcement

```typescript
// Critical: LLM_GENERATED edges cannot exceed 0.60 without Guardian confirmation

function getRetrievalThreshold(confidence: number, provenance: ProvenanceSource): boolean {
  const RETRIEVAL_THRESHOLD = 0.50;
  return confidence >= RETRIEVAL_THRESHOLD;
}

function canExceedCeiling(edge: PersonModelEdge): boolean {
  // Standard: confidence <= 0.80 without successful use
  // Special case: LLM_GENERATED max 0.60 without Guardian confirmation

  if (edge.provenance_source === "LLM_GENERATED") {
    if (edge.confidence > 0.60 && !hasGuardianConfirmation(edge)) {
      return false; // Blocked. Immutable Standard 3: Confidence Ceiling
    }
  }

  if (edge.confidence > 0.80 && edge.success_count < 10) {
    return false; // Must use it successfully at least 10 times
  }

  return true;
}
```

**This is a gating function that must be enforced at write-time in the graph layer.**

---

## Part 3: The Response Generation Pipeline

### 3.1 Staged Response Selection

```typescript
interface ResponseGenerationContext {
  guardian_input: string
  parse_confidence: number
  jim_person_model: PersonModelEdge[]
  jim_drive_inference: { drive: DriveName, estimated_value: number }[]
  sylphie_drive_state: DriveSnapshot
  wkg_context: KnowledgeEdge[] // relevant WKG context
  recent_episodes: EpisodicMemory[] // what happened recently
}

// Main response generation orchestration:

async function generateResponse(
  context: ResponseGenerationContext
): Promise<{ response: string; confidence: number; source: "type1" | "type2" }> {

  // Stage 1: Can we retrieve from graph?
  const type1_candidates = retrieveType1Responses(context);

  if (type1_candidates.length > 0 && type1_candidates[0].confidence > 0.80) {
    // Type 1 wins. Latency: <100ms
    const response = type1_candidates[0].text;
    const validated = validateTheaterProhibition(response, context.sylphie_drive_state);

    if (validated) {
      recordEvent("communication_type1_response", { response, confidence: type1_candidates[0].confidence });
      return { response, confidence: type1_candidates[0].confidence, source: "type1" };
    }
    // Theater violation: fall through to Type 2
  }

  // Stage 2: Type 2 (LLM)
  const llm_context = assembleContextForLLM(context);
  const llm_response = await callLLM(llm_context);
  const llm_confidence = estimateResponseConfidence(llm_response, context);

  const validated = validateTheaterProhibition(llm_response, context.sylphie_drive_state);
  if (!validated) {
    // Rewrite with drive-state alignment
    const rewritten = await callLLMWithConstraint(
      llm_context,
      `Rewrite this response to align with actual drive state: ${JSON.stringify(context.sylphie_drive_state)}`
    );
    recordEvent("communication_theater_correction", { original: llm_response, rewritten });
    return { response: rewritten, confidence: llm_confidence * 0.9, source: "type2" };
  }

  recordEvent("communication_type2_response", { response: llm_response, confidence: llm_confidence });
  return { response: llm_response, confidence: llm_confidence, source: "type2" };
}
```

### 3.2 Context Assembly for LLM

The LLM must receive rich context to make good decisions. But this context assembly is a cost — it should only happen for Type 2 calls, not Type 1.

```typescript
async function assembleContextForLLM(context: ResponseGenerationContext): Promise<string> {

  const sections = [];

  // Section 1: Who Jim is (person model)
  const jim_summary = summarizePersonModel(context.jim_person_model);
  sections.push(`## Jim's Preferences and Patterns\n${jim_summary}`);

  // Section 2: Drive state (Theater Prohibition requires this)
  sections.push(`## Your Current Drive State\n${JSON.stringify(context.sylphie_drive_state, null, 2)}`);

  // Section 3: Recent context
  sections.push(`## Recent Conversation\n${formatRecentEpisodes(context.recent_episodes)}`);

  // Section 4: Relevant knowledge
  sections.push(`## Relevant Knowledge\n${formatWKGContext(context.wkg_context)}`);

  // Section 5: The constraint
  sections.push(`## Constraints\n- Your response must correlate with your drive state (no theater/acting)\n- Use Jim-specific patterns where known\n- If uncertain about Jim's preference, ask for clarification rather than guessing`);

  return sections.join("\n\n");
}
```

**This is expensive, so it MUST be measured.** Track:
- Time to assemble context
- Time for LLM call
- Total Type 2 latency
- Compare to Type 1 latency (should be 10-100x faster)

---

## Part 4: Person Model Development Cycle

### 4.1 Guardian Feedback Processing

The learning system must distinguish instance-level from schema-level feedback.

```typescript
interface GuardianFeedback {
  session_id: number
  response_id: string
  feedback_type: "confirmation" | "correction"
  feedback_level: "instance" | "schema" | "conditional"

  // What the feedback contained
  content: string // Guardian's explanation
  confidence_signal: number // 0.5 - 1.0 ("I'm sure" vs "I think")

  // For corrections: what is the correct model?
  corrected_edge?: {
    relationship_type: string
    to_value: string
    context_conditions?: object
  }
}

// Processing function:

async function processPersonModelFeedback(feedback: GuardianFeedback) {

  if (feedback.feedback_level === "instance") {
    // Corrects this response, but doesn't change the generalization
    // Example: "No, I didn't mean that this time"

    const existing_edge = getPersonModelEdge(feedback.corrected_edge);
    existing_edge.confidence -= 0.10; // Slight decrease; one contradiction isn't conclusive
  }

  else if (feedback.feedback_level === "schema") {
    // Corrects the pattern itself
    // Example: "I actually prefer X across this whole category"

    const existing_edge = getPersonModelEdge(feedback.corrected_edge);
    existing_edge.confidence = 0.50; // Reset to uncertain
    existing_edge.last_confirmed_session = currentSession();

    // Create new edge with feedback provenance
    upsertPersonModelEdge({
      ...feedback.corrected_edge,
      confidence: feedback.confidence_signal * 0.70, // Guardian-weighted but not certain yet
      provenance_source: "GUARDIAN",
      guardian_feedback_quality: "schema"
    });
  }

  else if (feedback.feedback_level === "conditional") {
    // Refines the rule to be conditional
    // Example: "This is true when Y, but not when Z"

    const existing_edge = getPersonModelEdge(feedback.corrected_edge);
    existing_edge.confidence = 0.50; // Disconfirmed as universal

    // Create conditional edges
    const condition_a = { ...feedback.corrected_edge, context_conditions: { scenario: "Y" } };
    const condition_b = { ...feedback.corrected_edge, context_conditions: { scenario: "Z" } };

    upsertPersonModelEdge({
      ...condition_a,
      confidence: feedback.confidence_signal * 0.70,
      provenance_source: "GUARDIAN"
    });

    upsertPersonModelEdge({
      ...condition_b,
      confidence: feedback.confidence_signal * 0.70,
      provenance_source: "GUARDIAN"
    });

    // Metadata
    Cognitive Awareness += 0.10; // Learning event
  }

  // Weight the feedback
  const weight = feedback.feedback_type === "confirmation" ? 2.0 : 3.0; // Guardian Asymmetry
  const weight_adjusted = weight * feedback.confidence_signal;

  // Record learning event
  recordLearningEvent("person_model_update", {
    feedback_level,
    weight: weight_adjusted,
    edges_affected: updatedEdgeCount()
  });
}
```

### 4.2 Contradiction Detection and Escalation

When new data contradicts existing person model edges, the system should flag and resolve.

```typescript
async function checkPersonModelContradictions() {

  const all_jim_edges = getAllPersonModelEdges("Person_Jim");

  for (const edge of all_jim_edges) {

    // Check: does recent conversation contradict this edge?
    const recent_interactions = getRecentInteractions(limit: 10);

    for (const interaction of recent_interactions) {

      const predicted_behavior = predict(edge);
      const actual_behavior = extract(interaction);

      if (predicted_behavior !== actual_behavior) {

        // Contradiction detected
        createContradictionNode({
          edge_id: edge.id,
          predicted: predicted_behavior,
          actual: actual_behavior,
          session: currentSession(),
          confidence: 0.70 // One contradiction isn't definitive
        });

        // Escalate to Cognitive Awareness
        Cognitive_Awareness += 0.15;

        // Optionally ask Jim
        if (Cognitive_Awareness > 0.6) {
          generateClarificationQuestion(edge, predicted_behavior, actual_behavior);
        }
      }
    }
  }
}

// Clarification question example:
function generateClarificationQuestion(edge, predicted, actual) {
  const message = `
    I thought you preferred [${predicted}], but you just showed me [${actual}].
    Is this:
    A) Context-dependent? (explain when each applies)
    B) A change in your preference?
    C) Me misunderstanding what you want?
  `;
  return message;
}
```

This prevents false models from stabilizing through confirmation bias.

---

## Part 5: Input Parsing Schema Graduation

### 5.1 Parsing Confidence Calculation

```typescript
interface ParsingAttempt {
  input: string
  hypothesis: { schema: string; confidence: number } // What pattern does this match?
  prediction: string // What is Jim asking?
  guardian_response: string // What Jim actually meant
}

function calculateParsingConfidence(attempt: ParsingAttempt): number {

  // ACT-R formula, applied to parsing patterns
  // base + 0.12 * ln(count) - d * ln(hours + 1)

  const schema = getParsingSchema(attempt.hypothesis.schema);

  const confidence = Math.min(
    1.0,
    schema.base_confidence +
      0.12 * Math.log(schema.confirmation_count + 1) -
      DECAY_RATE * Math.log(hoursSinceLastUse(schema) + 1)
  );

  return confidence;
}

// When does parsing graduate to Type 1?

function canGraduateParsingSchemaToType1(schema: ParsingSchema): boolean {

  const high_confidence = schema.confidence > 0.80;
  const high_accuracy = schema.predicted_jim_intent_accuracy < 0.10; // MAE
  const sufficient_usage = schema.confirmation_count >= 10;

  return high_confidence && high_accuracy && sufficient_usage;
}

// If these conditions are met, the Input Parser can use this schema without LLM:

function parseInputWithType1(input: string): { prediction: string; confidence: number } {

  for (const schema of Type1_ParsingSchemas) {
    if (schema.canMatch(input)) {

      return {
        prediction: schema.jim_typical_intent,
        confidence: schema.confidence
      };
    }
  }

  // No Type 1 schema matches; defer to Type 2
  return { prediction: null, confidence: 0 };
}
```

### 5.2 Repair Strategy Learning

When Sylphie misparsed and recovered, the repair strategy should be recorded.

```typescript
async function learnRepairStrategy(
  original_parsing: string,
  guardianCorrection: string,
  repair_phrase: string
) {

  // Find the parsing schema that misparsed
  const schema = getParsingSchema(original_parsing);

  // Add repair strategy to the schema
  const strategy: ParseRepairStrategy = {
    repair_phrase,
    efficacy: 0.50, // Starts uncertain
    jim_response_rate: 0, // Will increase with use
    provenance_source: "INFERENCE",
    discovered_session: currentSession()
  };

  schema.repair_strategies.push(strategy);

  // Record learning event
  recordLearningEvent("repair_strategy_learned", {
    schema_id: schema.id,
    repair_phrase,
    corrected_interpretation: guardianCorrection
  });

  // Drive effect: Anxiety down (repair was successful)
  // Moral Valence up (learned from mistake)
  // Cognitive Awareness down (resolved uncertainty)
}

// Later, when parsing confidence is low, offer repair:

function generateRepairOffer(schema: ParsingSchema): string[] {

  const high_efficacy_repairs = schema.repair_strategies
    .filter(s => s.efficacy > 0.70)
    .sort((a, b) => b.jim_response_rate - a.jim_response_rate);

  if (high_efficacy_repairs.length > 0) {
    return high_efficacy_repairs.map(r => r.repair_phrase);
  }

  // Fallback: generic repair
  return ["I think I misunderstood. Can you clarify what you mean by that?"];
}
```

---

## Part 6: Monitoring and Instrumentation

### 6.1 Communication Health Dashboard

```typescript
interface CommunicationMetrics {
  // Type 1 / Type 2 ratio
  type1_percentage: number // target: increasing from 5% to 70%
  type2_percentage: number

  // Person modeling
  person_model_edges: number // target: 100+ by session 50
  guardian_confirmed_ratio: number // target: > 0.50 by session 30
  hallucination_rate: number // target: < 0.10

  // Parsing schemas
  type1_parsing_schemas: number // target: 15+ by session 50
  parsing_accuracy_mae: number // target: < 0.15 by session 30

  // Response generation
  average_response_latency_ms: number // Type 1 ~100ms, Type 2 ~1000ms
  theater_violation_rate: number // target: near 0%
  guardian_disagreement_rate: number // target: < 0.15

  // Development indicators
  prediction_accuracy_on_jim_response: number // target: > 0.80 by session 50
  conversational_initiative_rate: number // how often Sylphie starts
  repair_success_rate: number // when Sylphie repairs, how often Jim accepts

  // Health warnings
  red_flags: {
    type1_stalled: boolean // stuck at 5-10% after 30 sessions
    hallucination_rising: boolean // > 0.10 and increasing
    anxiety_in_communication: boolean // Communication Anxiety > 0.5 frequently
    guardian_response_declining: boolean // fewer replies to Sylphie's comments
    contradiction_backlog: number // unresolved contradictions
  }
}

async function computeCommunicationMetrics(): Promise<CommunicationMetrics> {

  const last_n_sessions = 50; // sliding window
  const events = queryEvents("communication", { limit: 1000, last_n_sessions });

  return {
    type1_percentage: countEventType(events, "type1") / events.length,
    person_model_edges: countPersonModelEdges(),
    guardian_confirmed_ratio: sumEdgesWithProvenanceGUARDIAN() / countPersonModelEdges(),
    hallucination_rate: countGuardianCorrections() / events.length,
    // ... compute remaining metrics
  };
}
```

### 6.2 Early Warning System

```typescript
async function checkCommunicationHealth() {

  const metrics = await computeCommunicationMetrics();
  const current_session = getCurrentSession();

  // Red flag: Type 1 stalled
  if (current_session > 30 && metrics.type1_percentage < 0.10) {
    Cognitive_Awareness += 0.20;
    recordAlert("Communication_Type1_Stalled", {
      current_ratio: metrics.type1_percentage,
      expected: 0.20,
      sessions: current_session
    });
  }

  // Red flag: Hallucination rising
  if (metrics.hallucination_rate > 0.15 &&
      metrics.hallucination_rate > lastSession.hallucination_rate) {
    Cognitive_Awareness += 0.15;
    Information_Integrity -= 0.10;
    recordAlert("Communication_Hallucination_Rising", { rate: metrics.hallucination_rate });
  }

  // Red flag: Anxiety in communication
  if (queryCommunicationAnxiety() > 0.5) {
    recordAlert("Communication_Anxiety_High");
    // Sylphie should retreat to safer patterns temporarily
    lowerCommunicationRiskThreshold(0.05); // Increase threshold for Type 1 selection
  }

  // Red flag: Guardian response declining
  const response_rate = metrics.guardian_response_rate;
  if (response_rate < 0.50) {
    recordAlert("Guardian_Response_Rate_Low", { rate: response_rate });
    // Comments are not relevant or interesting
    Social -= 0.10;
    Curiosity += 0.05; // Motivation to understand what Jim cares about
  }
}
```

---

## Part 7: Critical Implementation Constraints

### Constraint 1: Provenance Immutability

Once an edge is created with PROVENANCE_SOURCE, that source cannot be changed. This is architectural — not a business rule, but a constraint.

```typescript
// This should be impossible:

upsertPersonModelEdge({
  from: "Person_Jim",
  to: "prefers_clarity",
  provenance_source: "LLM_GENERATED", // Created as LLM
  confidence: 0.35
});

// Later:

edge.provenance_source = "GUARDIAN"; // ERROR: immutable
```

**Why:** The Lesion Test depends on provenance fidelity. If provenance drifts, you can't answer "what does Sylphie know on her own?"

### Constraint 2: Theater Prohibition is Gating

Theater Prohibition enforcement must happen before response execution, not after. If the LLM generates a response that violates Theater, it should be rewritten or rejected, not sent and then flagged.

```typescript
// CORRECT:

const response = await generateResponse(context);
const theater_check = validateTheaterProhibition(response, context.sylphie_drive_state);

if (!theater_check) {
  const rewritten = await rewriteForTheaterCompliance(response, context.sylphie_drive_state);
  executeResponse(rewritten); // Sent only if compliant
} else {
  executeResponse(response);
}

// WRONG:

const response = await generateResponse(context);
executeResponse(response);
recordTheaterViolation(response); // Too late; already sent theater
```

### Constraint 3: Confidence Ceiling Check at Write-Time

When upserting person model edges, check the ceiling before writing.

```typescript
// CORRECT: Check before write

async function upsertPersonModelEdge(edge: PersonModelEdge) {

  if (!canExceedCeiling(edge)) {
    const capped_edge = { ...edge, confidence: 0.60 };
    recordConfidenceCeiling({
      original_confidence: edge.confidence,
      capped_to: 0.60,
      edge_id: edge.id
    });
    await write(capped_edge);
  } else {
    await write(edge);
  }
}

// WRONG: Trust that confidence will be checked later

async function upsertPersonModelEdge(edge: PersonModelEdge) {
  await write(edge); // If confidence is 0.95 and provenance is LLM_GENERATED, we have a violation
}
```

### Constraint 4: Callback Asymmetry Must be Enforced

Guardian confirmations weight 2x. Corrections weight 3x. This is not a soft suggestion.

```typescript
async function applyGuardianAsymmetry(
  feedback: GuardianFeedback,
  target_edge: PersonModelEdge
) {

  if (feedback.feedback_type === "confirmation") {
    // Weight: 2x
    const boost = 0.10 * 2; // Double the normal confidence increment
    target_edge.confidence = Math.min(1.0, target_edge.confidence + boost);
  } else if (feedback.feedback_type === "correction") {
    // Weight: 3x
    const penalty = 0.10 * 3;
    target_edge.confidence = Math.max(0.0, target_edge.confidence - penalty);
  }
}
```

This should be enforced at the Learning system layer, not left to individual services.

---

## Part 8: Integration Points with Other Subsystems

### Decision Making ↔ Communication

```typescript
// Decision Making sends:
// - current drive_state (needed for Theater Prohibition)
// - recent_episodes (needed for context)
// - inner_monologue predictions (what will happen if we speak?)

// Communication sends back:
// - response (executed action)
// - response_confidence (how sure are we?)
// - response_source (type1 or type2)
```

### Learning ↔ Communication

```typescript
// Learning asks:
// - Which communication events should be consolidated?
// - What person model edges should be extracted?

// Communication sends:
// - Recent communication events (queries, responses, repairs)
// - Guardian feedback (confirmations, corrections)
// - Parsing accuracy (did we parse correctly?)

// Learning sends back:
// - Refined person model edges (with Guardian feedback integrated)
// - Extracted patterns (new parsing schemas)
```

### Drive Engine ↔ Communication

```typescript
// Drive Engine reads:
// - Communication response latency (Type 2 is cognitively costly)
// - Guardian response rate (Social drive indicator)
// - Prediction accuracy on Jim's responses (Information Integrity)

// Drive Engine affects:
// - Cognitive Awareness (when contradictions arise)
// - Anxiety (in communication situations)
// - Social drive (when Jim responds to Sylphie's comments)
// - Moral Valence (when Sylphie makes and repairs mistakes)
```

### Planning ↔ Communication

```typescript
// Planning asks:
// - Can we create a procedure for responding to [input pattern]?
// - Should we try a new response strategy?

// Communication provides:
// - Opportunity: parsing pattern that fails frequently
// - Opportunity: response template that Jim contradicts often
// - Constraint: response must be Theater-compliant
```

---

## Conclusion: The Measurement Problem

**The hardest part of implementing this architecture is measurement.**

You must measure:
- Type 1 vs Type 2 adoption (clear)
- Person model quality (fuzzy: what makes a model "good"?)
- Parsing accuracy (clear when Guardian corrects, but what about correct parses Jim doesn't explicitly validate?)
- Response appropriateness (subjective)
- Development velocity (are we learning faster than we're hallucinating?)

**Recommended approach:**
1. Start with objective, clear metrics: Type 1 ratio, latency, Guardian correction rate
2. Layer in subjective metrics carefully: weekly review of whether Sylphie's models match Jim's actual preferences
3. Use the Lesion Test periodically (weekly or bi-weekly) to ground-truth development
4. Let Guardian feedback drive confidence, not algorithmic certainty

The system will tell you if it's working. If Type 1 ratio is climbing, person models are Guardian-grounded, and repair success is increasing, communication development is real.

If Type 1 ratio is flat, person models are mostly LLM_GENERATED, and repairs fail regularly, something is broken. Fix it before it becomes an attractor state.

---

**Prepared for the Epic 6 implementation team. Use this as a bridge between psychology (developmental analysis) and engineering (code).**
