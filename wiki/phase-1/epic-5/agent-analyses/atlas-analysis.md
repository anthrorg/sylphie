# Atlas Analysis: Decision Making and the World Knowledge Graph (Epic 5)

**Date:** 2026-03-29
**Agent:** Atlas, Knowledge Graph Architect
**Subject:** How the Decision Making subsystem interacts with, reads from, and writes to the WKG. Schema design, query patterns, confidence dynamics, action node representation, and Type 1/Type 2 arbitration at the graph level.

**Scope:** This analysis focuses on the knowledge graph representation layer. Decision Making's LLM integration (Type 2 deliberation), drive computation (handled by E4), and communication (handled by E6) are Meridian's and Drive's domains. This is about WHAT the graph looks like, HOW it is queried, and HOW it evolves.

---

## 1. Executive Summary

Decision Making (E5) is a **graph-reading and graph-writing subsystem**. Its primary function is:

1. **Retrieve** high-confidence action candidates from the WKG by context fingerprint
2. **Generate Predictions** (via Type 2 / Inner Monologue) about action outcomes
3. **Arbitrate** between Type 1 (graph-based) and Type 2 (LLM-based) decisions
4. **Execute** the selected action
5. **Encode** the outcome into Episodic Memory
6. **Report** outcomes to Drive Engine (via IPC) and Learning subsystem

The WKG schema must support all five of these operations efficiently. Current design carries over v1 `ActionProcedureData` (node_id, name, category, confidence, encounter_count, guardian_confirmed, parameters, retrieval_floor) but requires three major extensions:

- **Context Fingerprint Matching:** How does the retriever find actions relevant to the CURRENT situation (not just by category)?
- **Type 1 Graduation Tracking:** What properties track whether an action has graduated to Type 1 status?
- **Prediction-Outcome Pairing:** Where are predictions and their evaluation results stored so Drive Engine can compute MAE?
- **Episodic Memory Anchoring:** How do episodic memories link to WKG nodes and each other?

This analysis provides the schema, query patterns, and integration points.

---

## 2. Action Node Schema (Instance Level)

### 2.1 Complete Action Node Structure

Actions (procedures, reflexes, behaviors) are represented as `:Procedure` nodes in the WKG with rich properties:

```cypher
CREATE (action:Procedure:Action {
  // Identity
  node_id: 'proc_greet_jim_morning_001',
  name: 'greet_jim_morning',

  // Category and Trigger
  category: 'COMMUNICATION',                    // From v1 DriveCategory enum
  trigger_context: 'jim_present AND time.hour < 12',
  context_fingerprint: 'hash("jim_present AND time.hour < 12")',

  // Execution
  action_sequence: ['look_at', 'say_greeting'],
  parameters: {
    target_entity: 'person_jim',
    greeting_template: 'CASUAL'
  },

  // Type 1 / Type 2 Metadata
  type1_status: 'TYPE_1_GRADUATED',            // UNCLASSIFIED, TYPE_2_ONLY, TYPE_1_CANDIDATE, TYPE_1_GRADUATED, TYPE_1_DEMOTED
  type1_graduation_date: datetime('2026-03-15T14:30:00Z'),

  // Confidence (ACT-R)
  confidence: 0.87,
  base_confidence: 0.60,                        // From GUARDIAN provenance
  retrieval_count: 23,
  last_retrieved: datetime('2026-03-29T08:15:00Z'),
  last_used: datetime('2026-03-29T08:15:00Z'),
  encounter_count: 23,                          // v1 compatibility

  // Decay Metrics
  decay_rate: 0.08,                             // Per-action tunable (default 0.12 from ACT-R)
  hours_since_last_use: 2.5,                    // Updated on retrieval

  // Type 1 Graduation Criteria
  type1_confidence_threshold: 0.80,
  recent_prediction_mae: 0.06,                  // Last 10 uses; must be < 0.10
  prediction_evaluation_count: 10,              // Over how many uses computed

  // Provenance and Trust
  provenance: 'INFERENCE',                      // SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE
  guardian_confirmed: true,
  guardian_confirmation_count: 2,               // Guardian asymmetry: 2x weight

  // Reliability Tracking
  success_rate: 0.91,                           // Out of last 20 uses
  failure_count: 2,
  failure_circumstances: [
    { date: datetime('2026-03-20'), reason: 'context_changed', outcome_mae: 0.35 }
  ],

  // Metadata
  created_at: datetime('2026-02-15T10:00:00Z'),
  created_by: 'system',
  updated_at: datetime('2026-03-29T08:15:00Z'),
  version: 3
})
```

### 2.2 Node Label Semantics

- **`:Procedure`** — The primary type. Executable behavioral sequences.
- **`:Action`** — Alias for graphical type consistency. Same as `:Procedure`.
- **`:Reflex`** — A Type 1-graduated procedure (optional label, for indexing efficiency).
- **`:Type2Candidate`** — A procedure that has not yet met Type 1 graduation criteria (optional label).

### 2.3 Key Properties Explained

**`trigger_context` vs. `context_fingerprint`:**
- `trigger_context` is human-readable: "jim_present AND time.hour < 12"
- `context_fingerprint` is a deterministic hash of the context string
- Used for FAST indexed matching in context retrieval queries

**`type1_status` State Machine:**
```
UNCLASSIFIED
  ├─→ TYPE_2_ONLY        (confidence < 0.50, MAE unavailable)
  ├─→ TYPE_1_CANDIDATE   (0.50 ≤ confidence < 0.80 OR MAE ≥ 0.10)
  └─→ TYPE_1_GRADUATED   (confidence ≥ 0.80 AND MAE < 0.10)
         └─→ TYPE_1_DEMOTED  (MAE rises above 0.15, context changed)
```

**`recent_prediction_mae`:**
- Computed over the LAST 10 USES of this action (rolling window)
- Updated by Confidence Updater service after Drive Engine reports outcomes
- Critical for Type 1 graduation and demotion logic

**Confidence Tracking:**
- `confidence` is the current ACT-R value: `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`
- Updated lazily on RETRIEVAL, not stored separately in a dedicate table
- Enables the "Confidence Ceiling" constraint: no action exceeds 0.60 without retrieval-and-use

### 2.4 Edge Semantics for Actions

Actions don't exist in isolation. They connect to entities, preconditions, and outcomes:

```cypher
// What entities does this action reference?
(action:Procedure) -[:TARGETS {role: 'primary_target', provenance: 'GUARDIAN'}]-> (target:Entity)

// What preconditions must be true?
(action:Procedure) -[:REQUIRES_CONTEXT {entity_id: 'jim_present', confidence: 0.80}]-> (condition:Entity)

// What is the expected outcome entity?
(action:Procedure) -[:PRODUCES {outcome_type: 'EMOTIONAL_STATE', entity_id: 'jim_satisfied'}]-> (outcome:Entity)

// What is the observed outcome entity (from prediction evaluation)?
(action:Procedure) -[:RECENT_OUTCOME {use_index: 1, prediction_mae: 0.05, timestamp: datetime()}]-> (observed:Entity)

// What drive is this action connected to?
(action:Procedure) -[:DRIVEN_BY {drive_name: 'SOCIAL', baseline_pressure: 0.4}]-> (drive:Drive)

// What domain/category schema does it belong to?
(action:Procedure) -[:INSTANCE_OF]-> (category:ProcedureCategory)
```

---

## 3. Context Fingerprint Matching

### 3.1 The Core Problem

**Decision Making needs to retrieve actions QUICKLY for the current context.** A simple category-based query ("get all COMMUNICATION actions") returns 50+ candidates. A full Cypher traversal to evaluate `trigger_context` strings adds latency.

**Solution: Context Fingerprinting + Indexed Lookup**

### 3.2 Context Fingerprint Design

**During Action Consolidation (Learning subsystem):**
1. Guardian provides or system infers a `trigger_context` string: "jim_present AND time.hour < 12"
2. Compute SHA256(trigger_context) → e.g., "a7f3e2c..."
3. Store both `trigger_context` and `context_fingerprint` on the Procedure node
4. Create an index on `context_fingerprint` for O(1) lookup

**During Retrieval (Decision Making):**
1. Gather current context signals: {jim_present: true, time_hour: 8, location: 'kitchen', ...}
2. Construct a fingerprint query: "jim_present AND time.hour < 12"
3. Hash it: SHA256(...) → "a7f3e2c..."
4. Index lookup in Neo4j: MATCH (a:Procedure { context_fingerprint: "a7f3e2c..." })
5. Return all matching actions, sorted by confidence (descending)

### 3.3 Query Pattern: Retrieve Actions by Context

```typescript
interface RetrievalContext {
  person_present?: string[];        // e.g., ['jim', 'sarah']
  location?: string;                // e.g., 'kitchen'
  time_of_day?: string;             // e.g., 'morning', 'afternoon'
  recent_events?: string[];         // e.g., ['jim_greeted', 'task_completed']
  drive_state?: Record<string, number>;  // Current drive vector
  prediction_accuracy_threshold?: number; // Min acceptable MAE
}

// Build context fingerprint
const contextHash = buildContextFingerprint(ctx);

// Neo4j Query
MATCH (action:Procedure { context_fingerprint: $contextHash })
WHERE action.confidence >= 0.50
AND (action.type1_status = 'TYPE_1_GRADUATED' OR action.confidence >= $arbitration_threshold)
RETURN action
ORDER BY action.confidence DESC
LIMIT 20
```

### 3.4 Context Fingerprint Expression Grammar

**Expressiveness vs. Simplicity Trade-off:**

Context fingerprints should be human-parseable boolean expressions, not opaque tokens:

```
// Simple predicates
jim_present
time.hour < 12
location = 'kitchen'

// Conjunctions (AND implicit)
jim_present, time.hour < 12, location = 'kitchen'

// Disjunctions (explicit OR)
(jim_present OR sarah_present) AND location = 'kitchen'

// Negation
NOT jim_tired AND morning

// Recent event checking
recent_event = 'greeting_completed' [within 5 minutes]
```

**Storage:** Store the human-readable expression in `trigger_context` for debugging. Store the deterministic hash in `context_fingerprint` for indexing.

### 3.5 Context Fingerprint Matching Flow

```
+---------------------+
| Current Inputs      |
| - Person present    |
| - Drive state       |
| - Recent events     |
| - Location, time    |
+---------------------+
           |
           v
+---------------------+
| Build Fingerprint   |
| Hash expression     |
+---------------------+
           |
           v
+---------------------+
| Index Lookup (Neo4j)|
| O(1) retrieval      |
+---------------------+
           |
           v
+---------------------+
| Get Candidates      |
| Sorted by conf      |
+---------------------+
           |
           v
+---------------------+
| Arbitrate T1 vs T2  |
| (if multiple)       |
+---------------------+
           |
           v
+---------------------+
| Execute Action      |
+---------------------+
```

---

## 4. Confidence Dynamics Integration

### 4.1 ACT-R Formula Computation

**Formula:** `confidence = min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

**Implementation Strategy: Lazy Computation on Retrieval**

Rather than storing confidence as a static property, compute it dynamically when an action is retrieved. This ensures time decay is always current.

```typescript
interface ConfidenceComputationInput {
  base_confidence: number;         // 0.40 (SENSOR), 0.60 (GUARDIAN), 0.35 (LLM_GENERATED)
  retrieval_count: number;         // Number of successful uses
  last_retrieved_timestamp: Date;  // When was it last used?
  decay_rate: number;              // Action-specific or default 0.12
}

function computeConfidence(input: ConfidenceComputationInput): number {
  const now = Date.now();
  const hoursSinceLastUse = (now - input.last_retrieved_timestamp.getTime()) / (1000 * 60 * 60);

  const actrValue =
    input.base_confidence +
    (0.12 * Math.log(Math.max(1, input.retrieval_count))) -
    (input.decay_rate * Math.log(hoursSinceLastUse + 1));

  return Math.min(1.0, actrValue);
}

// Ceiling constraint (Immutable Standard 3)
function enforceCeiling(confidence: number, retrieval_count: number): number {
  if (retrieval_count === 0 && confidence > 0.60) {
    return 0.60;  // No knowledge exceeds 0.60 without retrieval-and-use
  }
  return confidence;
}
```

### 4.2 Retrieval Tracking in the Graph

**Every retrieval and use must be RECORDED, not just counted.**

```cypher
// Record a successful retrieval-and-use event
MATCH (action:Procedure { node_id: $action_id })
SET action.retrieval_count = action.retrieval_count + 1,
    action.last_retrieved = datetime.realtime(),
    action.last_used = datetime.realtime()
CREATE (action) -[:RETRIEVAL_EVENT {
  timestamp: datetime.realtime(),
  context: $context_fingerprint,
  success: true
}]-> (timestamp_node)
```

**Why record to an edge, not just increment a counter?**
- Enables historical analysis: "When was this action retrieved?"
- Supports GAP DETECTION: "This action was retrieved 10 times rapidly, then never again — confidence should decay fast"
- Feeds into Learning maintenance cycles: "What patterns do our action retrievals follow?"

### 4.3 Confidence Updater Service Integration

**Who writes confidence changes?** The Confidence Updater service (owned by Decision Making subsystem).

**When?** After:
1. Action is executed
2. Drive Engine reports outcome (via IPC)
3. Prediction accuracy is computed (MAE)
4. Type 1 graduation/demotion decision is made

**What does it write?**

```typescript
interface ConfidenceUpdate {
  action_id: string;
  new_confidence: number;
  base_confidence: number;  // May change if guardian confirms
  retrieval_count: number;
  recent_prediction_mae: number;  // Last 10 uses
  type1_status: 'UNCLASSIFIED' | 'TYPE_2_ONLY' | 'TYPE_1_CANDIDATE' | 'TYPE_1_GRADUATED' | 'TYPE_1_DEMOTED';
  reason: string;  // Why changed? e.g., "MAE improved to 0.06"
  timestamp: Date;
}

// Cypher update
MATCH (action:Procedure { node_id: $action_id })
SET action.confidence = $new_confidence,
    action.base_confidence = $base_confidence,
    action.retrieval_count = $retrieval_count,
    action.recent_prediction_mae = $recent_prediction_mae,
    action.type1_status = $type1_status,
    action.updated_at = datetime.realtime()
CREATE (action) -[:CONFIDENCE_UPDATE {
  reason: $reason,
  previous_confidence: $previous_confidence,
  new_confidence: $new_confidence,
  timestamp: datetime.realtime()
}]-> (timestamp_node)
```

### 4.4 Retrieval-and-Use Requirement for Confidence Ceiling

**Key Constraint (Immutable Standard 3):** "No knowledge exceeds 0.60 without at least one successful retrieval-and-use event."

**Implementation:**

```typescript
function checkConfidenceCeiling(
  action: Procedure,
  computed_confidence: number
): number {
  if (action.retrieval_count === 0) {
    return Math.min(0.60, computed_confidence);  // Hard ceiling
  }
  return computed_confidence;
}
```

This ensures:
- A newly created action (guardian-taught) starts at 0.60 but cannot be used until retrieved once
- After first successful retrieval-and-use, ceiling is lifted
- Prevents system from operating on untested knowledge at high confidence

---

## 5. Prediction Storage and Retrieval

### 5.1 Where Are Predictions Stored?

**Predictions are TWO-PART RECORDS:**

1. **TimescaleDB** (EVENT BACKBONE) — The prediction event itself
2. **WKG (Neo4j)** — Links from action nodes to predictions, and outcome tracking

### 5.2 Prediction Event Schema (TimescaleDB)

```sql
CREATE TABLE prediction_events (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),

  -- What action was predicted?
  action_id VARCHAR NOT NULL,

  -- What was the context?
  context_fingerprint VARCHAR NOT NULL,
  context_full TEXT,

  -- What did we predict would happen?
  prediction_type VARCHAR,        -- 'action_outcome', 'drive_change', 'entity_state'
  predicted_outcome JSONB,        -- { drive_deltas: {...}, entity_changes: [...] }
  predicted_probability FLOAT,    -- How confident was the prediction?

  -- Metadata
  prediction_source VARCHAR,      -- 'TYPE_1_REFLEX', 'TYPE_2_DELIBERATION', 'INNER_MONOLOGUE'
  drive_state JSONB,              -- Full drive vector at prediction time

  -- Linking
  episode_id UUID,                -- Links to episodic memory
  decision_making_cycle_id UUID,  -- Which DM cycle generated this?

  -- Outcome (populated later)
  actual_outcome JSONB,           -- What actually happened?
  outcome_recorded BOOLEAN,       -- Has outcome been recorded?
  outcome_timestamp TIMESTAMPTZ,  -- When did outcome occur?
  prediction_mae FLOAT,           -- Computed MAE after outcome

  INDEX (action_id, timestamp),
  INDEX (episode_id)
);
```

### 5.3 Prediction-Action Linking in WKG

```cypher
// For each prediction, create a link from the action
(action:Procedure) -[:MADE_PREDICTION {
  prediction_event_id: $event_id,
  timestamp: datetime(),
  confidence: 0.85,
  predicted_outcome: 'jim_smiles',
  source: 'TYPE_1_REFLEX'
}]-> (prediction_event_node:PredictionEvent {
  event_id: $event_id,
  timestamp: datetime(),
  source: 'timescaledb'  // Indicates the authoritative record is in TimescaleDB
})

// After outcome is known, create an outcome link
(action:Procedure) -[:RECENT_OUTCOME {
  prediction_event_id: $event_id,
  use_index: 1,           // Which of the last 10 uses is this?
  timestamp: datetime(),
  actual_outcome: 'jim_smiled',
  prediction_mae: 0.05,
  prediction_source: 'TYPE_1_REFLEX'
}]-> (outcome:Entity)
```

### 5.4 Querying Predictions for MAE Computation

**Drive Engine needs the last 10 prediction outcomes to compute MAE for Type 1 graduation:**

```typescript
// Neo4j Query: Get recent outcomes
MATCH (action:Procedure { node_id: $action_id })
      -[:RECENT_OUTCOME { use_index: [1,2,3,4,5,6,7,8,9,10] }]-> (outcome)
WITH action, COLLECT(outcome.prediction_mae) AS recent_maes
RETURN
  action.node_id,
  AVG(recent_maes) AS mean_absolute_error,
  action.confidence,
  CASE
    WHEN action.confidence > 0.80 AND AVG(recent_maes) < 0.10
      THEN 'TYPE_1_ELIGIBLE'
    ELSE 'KEEP_AS_TYPE_2'
  END AS graduation_recommendation
```

---

## 6. Type 1 Graduation Tracking

### 6.1 Graduation Criteria

**From CANON:**
- Confidence > 0.80
- Prediction MAE < 0.10 over last 10 uses
- Both criteria must hold simultaneously

**State Machine:**

```
UNCLASSIFIED (new action)
  ├─ Confidence < 0.50  → TYPE_2_ONLY
  │  │                     (insufficient data)
  │  │
  │  └─ Confidence ≥ 0.50 AND (no predictions OR MAE ≥ 0.10)
  │     → TYPE_1_CANDIDATE
  │        (eligible to try, but not graduated)
  │
  └─ Confidence ≥ 0.80 AND MAE < 0.10
     → TYPE_1_GRADUATED
        (ready for reflexive use)
        │
        ├─ MAE rises > 0.15
        │ → TYPE_1_DEMOTED
        │    (context changed, revert to Type 2)
        │
        └─ Stays ≥ 0.80 AND < 0.10
           → remains TYPE_1_GRADUATED
```

### 6.2 Graduation Tracking on Action Nodes

```cypher
CREATE (action:Procedure {
  // ... other properties ...

  // Type 1 Graduation Metadata
  type1_status: 'TYPE_1_GRADUATED',
  type1_graduation_date: datetime('2026-03-15T14:30:00Z'),
  type1_graduation_trigger: {
    confidence_at_graduation: 0.82,
    mae_at_graduation: 0.08,
    uses_before_graduation: 15
  },

  // Demotion Tracking (if demoted)
  type1_demotion_date: NULL,
  type1_demotion_reason: NULL,
  type1_demotion_trigger: {
    mae_at_demotion: NULL,
    confidence_at_demotion: NULL
  }
})
```

### 6.3 Graduation Arbitration Logic

**When Retrieving Actions:**

```typescript
interface ActionRetrievalLogic {
  // If Type 1 candidate is available AND meets threshold
  if (bestType1Action && bestType1Action.confidence >= 0.80) {
    // Type 1 wins (fast path, no LLM)
    return executeType1Action(bestType1Action);
  }

  // If highest-confidence option is Type 1 but confidence just below threshold
  if (highestConfidenceAction.confidence >= 0.75 && highestConfidenceAction.type1_status === 'TYPE_1_CANDIDATE') {
    // Borderline case: try Type 1 reflexively, but monitor MAE closely
    return executeType1Action(highestConfidenceAction, { borderline: true });
  }

  // Fallback to Type 2 deliberation
  return deliberateType2(situation, availableActions);
}
```

### 6.4 Demotion Detection

**When Outcomes Are Evaluated:**

```typescript
function checkForDemotion(action: Procedure, newMae: number, recentMaes: number[]): void {
  if (action.type1_status !== 'TYPE_1_GRADUATED') {
    return;  // Only demote from graduated status
  }

  if (newMae > 0.15) {
    // Prediction accuracy has degraded significantly
    action.type1_status = 'TYPE_1_DEMOTED';
    action.type1_demotion_date = new Date();
    action.type1_demotion_reason = 'prediction_accuracy_degraded';
    action.type1_demotion_trigger = {
      mae_at_demotion: newMae,
      confidence_at_demotion: action.confidence
    };

    // Log to graph
    graph.createDemotionEvent(action.node_id, newMae);
  }
}
```

---

## 7. Action-Context Pair Representation

### 7.1 Why Action-Context Pairs Matter

An action is only meaningful IN A CONTEXT. The same action ("say hello") has different outcomes in different contexts:
- Saying hello at 9 AM (expected) vs. 3 AM (unexpected)
- Saying hello to Jim (known) vs. stranger (unknown)

**The WKG must represent this pairing explicitly.**

### 7.2 Context as a First-Class Concept

Instead of embedding context strings on action nodes, create explicit Context nodes:

```cypher
CREATE (ctx:Context {
  node_id: 'ctx_morning_with_jim_001',
  fingerprint: 'a7f3e2c...',

  // Structured condition representation
  conditions: {
    time_of_day: 'morning',
    time_hour_min: 6,
    time_hour_max: 12,
    person_present: 'jim',
    location: 'home'
  },

  // Human-readable
  description: 'Jim is present, morning hours',

  // Context importance (for prioritization)
  specificity_score: 0.85,  // How narrowly defined is this context?
  frequency_in_episodes: 12,  // How often does this context occur?

  // Tracking
  created_at: datetime(),
  last_matched: datetime(),
  match_count: 12,

  provenance: 'GUARDIAN'  // Who defined this context?
})

// Link action to context (not just property)
(action:Procedure) -[:APPLICABLE_IN {
  confidence: 0.92,
  success_rate: 0.88,
  use_count: 12
}]-> (ctx:Context)
```

### 7.3 Context Matching Query Pattern

```typescript
// Given current state, find all applicable action-context pairs
interface ContextMatchResult {
  action: Procedure;
  context: Context;
  match_score: number;  // How well does current state fit this context?
  confidence: number;
}

// Neo4j Query
MATCH (action:Procedure) -[app:APPLICABLE_IN]-> (ctx:Context)
WHERE
  // Current state matches context conditions
  $current_time_hour >= ctx.conditions.time_hour_min AND
  $current_time_hour <= ctx.conditions.time_hour_max AND
  $person_present IN ctx.conditions.person_present
RETURN {
  action: action,
  context: ctx,
  match_score: ctx.specificity_score * app.success_rate,
  confidence: action.confidence
} AS candidate
ORDER BY match_score DESC, candidate.confidence DESC
LIMIT 10
```

---

## 8. Query Performance Requirements

### 8.1 Type 1 Must Beat Type 2 Latency

**Hard Constraint:** Type 1 action retrieval must complete in < 100ms to justify avoiding Type 2.

**Type 2 baseline:** LLM deliberation with context assembly = 800-1500ms (input tokens, inference, output parsing)

**Type 1 target:** < 100ms end-to-end
- Context fingerprint generation: < 5ms
- Neo4j index lookup: < 20ms
- Confidence computation: < 10ms
- Result serialization: < 5ms
- Safety/validation checks: < 20ms
- **Total: ~60ms**

### 8.2 Neo4j Indexing Strategy

```cypher
// Index 1: Fast context lookup by fingerprint
CREATE INDEX idx_procedure_context_fingerprint
  FOR (p:Procedure) ON (p.context_fingerprint);

// Index 2: Category + Type 1 status (for filtering)
CREATE INDEX idx_procedure_type1_category
  FOR (p:Procedure) ON (p.type1_status, p.category);

// Index 3: Confidence ordering (for arbitration)
CREATE INDEX idx_procedure_confidence
  FOR (p:Procedure) ON (p.confidence DESC);

// Index 4: Recent retrieval tracking (for decay computation)
CREATE INDEX idx_procedure_last_retrieved
  FOR (p:Procedure) ON (p.last_retrieved DESC);

// Index 5: Retrieval events (for MAE history)
CREATE INDEX idx_retrieval_event_action
  FOR ()-[r:RETRIEVAL_EVENT]-() ON (r.action_id, r.timestamp DESC);
```

### 8.3 Query Optimization Patterns

**Pattern 1: Fast Context Lookup**
```cypher
// Good: indexed lookup
MATCH (p:Procedure { context_fingerprint: $ctx_hash, type1_status: 'TYPE_1_GRADUATED' })
RETURN p ORDER BY p.confidence DESC LIMIT 5

// Bad: property scan
MATCH (p:Procedure)
WHERE p.trigger_context CONTAINS $substring
RETURN p
```

**Pattern 2: Type 1 Candidates with Confidence Filter**
```cypher
// Good: indexed filters
MATCH (p:Procedure)
WHERE p.confidence >= 0.80 AND p.type1_status IN ['TYPE_1_GRADUATED', 'TYPE_1_CANDIDATE']
RETURN p ORDER BY p.confidence DESC

// Bad: full scan + compute
MATCH (p:Procedure)
WITH p, (p.base + 0.12 * log(p.retrieval_count)) AS conf
WHERE conf >= 0.80
RETURN p
```

### 8.4 Caching Strategy

**What to Cache:**
- Context fingerprints (stable, used every decision cycle)
- Top-N actions by category (refreshed every 10 minutes)
- Confidence values (stale after 1 hour — decay matters)

**What NOT to Cache:**
- Drive state (changes frequently, small data)
- Episodic context (unique per decision)
- Prediction outcomes (must be current for MAE computation)

```typescript
interface RetrievalCache {
  contextHash: string;
  retrievedActions: Procedure[];
  timestamp: Date;
  ttl_ms: number;  // 5-10 seconds for context-based lookup
}
```

---

## 9. Confidence Updater WKG Writes

### 9.1 What the Confidence Updater Writes

The Confidence Updater service (owned by Decision Making) is the ONLY service that writes confidence changes to the WKG. It is driven by outcomes reported from Drive Engine via IPC.

**Write Pattern:**

```typescript
interface ConfidenceUpdateFlow {
  // 1. Drive Engine reports outcome via IPC
  outcome: {
    action_id: string;
    prediction_outcome: Record<string, any>;
    drive_deltas: Record<string, number>;
    success: boolean;
  };

  // 2. Confidence Updater retrieves action and recent history
  action = await graph.getAction(outcome.action_id);
  recentMaes = await graph.getRecentPredictionMaes(action.node_id, limit: 10);

  // 3. Compute new confidence (ACT-R)
  newConfidence = computeConfidence({
    base: action.base_confidence,
    count: action.retrieval_count + 1,
    decay_rate: action.decay_rate,
    hours_since_last: 0  // Just retrieved
  });

  // 4. Check Type 1 graduation eligibility
  const newMae = computeMae(recentMaes);
  const graduationEligible = newConfidence >= 0.80 && newMae < 0.10;

  // 5. Write updates to graph
  await graph.updateAction(action.node_id, {
    confidence: newConfidence,
    retrieval_count: action.retrieval_count + 1,
    recent_prediction_mae: newMae,
    type1_status: graduationEligible ? 'TYPE_1_GRADUATED' : action.type1_status,
    last_retrieved: new Date(),
    updated_at: new Date()
  });

  // 6. Log the update event
  await graph.createConfidenceUpdateEvent(action.node_id, {
    previous_confidence: action.confidence,
    new_confidence: newConfidence,
    reason: 'prediction_outcome_evaluated',
    mae_improved: newMae < action.recent_prediction_mae,
    timestamp: new Date()
  });
}
```

### 9.2 Guardian Confirmation Impact on Confidence

**Guardian confirmation weight = 2x** (CANON principle 4, "Guardian Asymmetry")

```typescript
// When guardian confirms an action is good
function applyGuardianConfirmation(action: Procedure): void {
  // Treat as 2x retrieval-and-use events
  action.retrieval_count += 2;
  action.base_confidence = Math.max(action.base_confidence, 0.70);
  action.guardian_confirmation_count += 1;

  // Recompute confidence (now higher due to 2x count boost)
  action.confidence = computeConfidence({
    base: action.base_confidence,
    count: action.retrieval_count,
    decay_rate: action.decay_rate,
    hours_since_last: 0
  });
}

// When guardian corrects an action (weight = 3x)
function applyGuardianCorrection(action: Procedure, feedback: string): void {
  // This is more severe than confirmation
  action.retrieval_count -= 3;  // Penalize existing count
  action.base_confidence = Math.min(action.base_confidence, 0.40);  // Reset trust
  action.type1_status = 'TYPE_2_ONLY';  // Force back to Type 2

  // Log the correction
  graph.createGuardianCorrectionEvent(action.node_id, {
    feedback: feedback,
    penalty_weight: 3,
    new_type1_status: 'TYPE_2_ONLY',
    timestamp: new Date()
  });
}
```

### 9.3 Write-Safety: Avoiding Confidence Race Conditions

**Problem:** Multiple systems might try to update confidence simultaneously (Drive Engine reporting outcome, Learning extracting new edges, Guardian confirming).

**Solution: Optimistic Locking with Version Numbers**

```cypher
// Write with version check
MATCH (action:Procedure { node_id: $action_id, version: $expected_version })
SET action.confidence = $new_confidence,
    action.version = $expected_version + 1,
    action.updated_at = datetime.realtime()
RETURN action

// If version mismatch, retry with exponential backoff
if (no rows affected) {
  log("Confidence update race condition detected, retrying");
  await sleep(10 + Math.random() * 90);  // 10-100ms backoff
  return await retryConfidenceUpdate(...);
}
```

---

## 10. Episodic Memory and WKG Integration

### 10.1 What Is Episodic Memory?

**From CANON:** Episodic Memory stores temporally-contextualized experiences that degrade gracefully — fresh episodes are detail-rich, older episodes contribute to semantic knowledge through consolidation.

**In the WKG:** Episodes are first-class nodes that link:
- Inputs (what the system observed)
- Predictions (what it expected to happen)
- Actions (what it did)
- Outcomes (what actually happened)
- Drive state (how it was feeling)

### 10.2 Episode Node Schema

```cypher
CREATE (ep:Episode {
  node_id: 'ep_2026_03_29_08_15_001',

  // Temporal anchoring
  timestamp: datetime('2026-03-29T08:15:30Z'),
  duration_ms: 245,  // How long was the decision cycle?

  // What was the situation?
  situation_description: 'Jim entered the kitchen',
  context_fingerprint: 'a7f3e2c...',

  // What was Sylphie's state?
  drive_state_snapshot: {
    system_health: 0.72,
    moral_valence: 0.65,
    curiosity: 0.48,
    social: 0.81,
    // ... all 12 drives
  },

  // Memory vividness (decreases over time)
  vividness: 1.0,  // 1.0 = fresh, 0.5 = semi-recent, 0.2 = consolidated
  consolidation_status: 'FRESH',  // FRESH, CONSOLIDATING, CONSOLIDATED

  // Metadata
  created_at: datetime('2026-03-29T08:15:30Z'),
  consolidated_into_schema: false,

  provenance: 'SENSOR'  // Observed directly
})

// Links to components of the episode
(ep:Episode) -[:RECEIVED_INPUT {
  input_type: 'VISUAL',
  content: 'person_jim_in_kitchen'
}]-> (input:Input)

(ep:Episode) -[:GENERATED_PREDICTION {
  action: 'greet_jim',
  expected_outcome: 'jim_acknowledges',
  confidence: 0.87
}]-> (prediction:Prediction)

(ep:Episode) -[:EXECUTED_ACTION]-> (action:Procedure)

(ep:Episode) -[:OBSERVED_OUTCOME {
  actual_outcome: 'jim_smiled_and_said_good_morning',
  prediction_matched: true
}]-> (outcome:Outcome)
```

### 10.3 Episodic Memory Decay and Consolidation

**Fresh episodes are detail-rich:**
```
ep_2026_03_29_08_15_001 (TODAY)
  ├─ Input: detailed sensory description
  ├─ Drive state: full snapshot
  ├─ Prediction: specific and detailed
  ├─ Action: full parameters
  └─ Outcome: observed vs. predicted
```

**Over time, episodes consolidate into semantic knowledge:**

```
ep_2026_03_15_14_30_001 (2 WEEKS AGO)
  ├─ Input: reduced to essential
  ├─ Drive state: only drives that changed
  ├─ Prediction: generalized pattern
  ├─ Action: abstracted category
  └─ Outcome: distilled learning

// During Learning consolidation cycle:
// Extract entities, create/update edges in main WKG
// Mark episode as CONSOLIDATED
// Reduce vividness to 0.1
```

### 10.4 Querying Recent Episodes (Decision Making Use)

```typescript
// Decision Making queries recent episodes to build context
interface RecentEpisodesQuery {
  // Get episodes from the last 30 minutes
  MATCH (ep:Episode)
  WHERE ep.timestamp > datetime.realtime() - duration({ minutes: 30 })
  AND ep.consolidation_status != 'CONSOLIDATED'
  RETURN ep
  ORDER BY ep.timestamp DESC
  LIMIT 10
}

// Use episodes to build context
const recentContext = {
  person_present: extractFromEpisodes('PERSON', episodes),
  recent_actions: extractFromEpisodes('ACTION', episodes),
  recent_outcomes: extractFromEpisodes('OUTCOME', episodes),
  interaction_pattern: analyzeEpisodeSequence(episodes)
};
```

### 10.5 Episode-to-WKG Consolidation

**Learning subsystem drives consolidation:**

```typescript
interface ConsolidationFlow {
  // 1. Select episodes marked for consolidation
  //    (older than 1 hour, vividness < 0.5)
  consolidationCandidates = await graph.queryEpisodes({
    timestamp_before: now - 60min,
    vividness_below: 0.5,
    consolidation_status: 'CONSOLIDATING'
  });

  // 2. For each episode, extract entities and edges
  for (const ep of consolidationCandidates) {
    const entities = extractEntities(ep);
    const edges = extractRelationships(ep);

    // 3. Upsert into WKG (with LLM help)
    for (const entity of entities) {
      await graph.upsertEntity(entity, {
        provenance: 'INFERENCE',  // Derived from episodic memory
        source_episode: ep.node_id
      });
    }

    // 4. Mark episode as consolidated
    await graph.updateEpisode(ep.node_id, {
      consolidation_status: 'CONSOLIDATED',
      vividness: 0.1,
      consolidated_at: new Date()
    });
  }
}
```

---

## 11. Schema Evolution and Type 1/Type 2 Implications

### 11.1 Runtime Schema Evolution

The WKG schema is not static. It evolves as Sylphie observes and learns.

**Example: Creating a New Procedure Category**

```
Initial state:
- Actions: [COMMUNICATION, MOTOR, COGNITIVE]

Observation: Sylphie creates 5 actions related to seeking information
- Action 1: ask_jim_about_X
- Action 2: search_for_Y_information
- Action 3: explore_new_environment
- Action 4: re_examine_known_entity
- Action 5: correlate_disparate_facts

Decision:
- These actions all share a pattern: motivated by Curiosity drive
- They produce similar outcomes: information gain
- Should we create a new schema type: CURIOSITY_DRIVEN_ACTION?

If yes:
- Create new category node: (:ProcedureCategory { name: 'CURIOSITY_DRIVEN', ... })
- Relink existing actions to both old + new category
- Update retrieval queries to use the new category

Impact on Type 1:
- These actions may have been unrelated before (separate context fingerprints)
- With a unified category, they can now compete in the same retrieval pool
- Increased action density in one category may push one action out (lower confidence rank)
```

### 11.2 Confidence Impact of Schema Changes

**When schema changes, action confidence stability is affected:**

```typescript
// Scenario: A procedure is reclassified
function handleProcedureReclassification(
  procedure: Procedure,
  old_category: string,
  new_category: string
): void {
  // The procedure's confidence was built in a specific retrieval context
  // Changing its category changes when it will be retrieved

  // Scenario A: Broader category = more competition = harder to stay Type 1
  if (new_category_density > old_category_density) {
    procedure.confidence *= 0.95;  // Slight penalty
  }

  // Scenario B: More specific category = less competition = easier to dominate
  if (new_category_density < old_category_density) {
    procedure.confidence *= 1.05;  // Slight boost
  }

  // Always log the change
  graph.createSchemaChangeEvent(procedure.node_id, {
    old_category,
    new_category,
    confidence_adjustment: procedure.confidence_adjustment,
    timestamp: new Date()
  });
}
```

---

## 12. Known Challenges and Design Decisions

### 12.1 Challenge: Context Fingerprint Brittleness

**Problem:** If context predicates change (e.g., "jim_present AND time.hour < 12" becomes "jim_present AND time.hour < 1"), old fingerprints don't match new contexts.

**Mitigation:**
- Store both fingerprint (for fast lookup) and full context string (for interpretation)
- On fingerprint mismatch, fall back to string parsing
- Learning subsystem must update context strings when Guardian corrects
- Confidence decay rate accelerates if context changes (penalty for instability)

### 12.2 Challenge: MAE Computation Window

**Problem:** Computing MAE over the last 10 uses assumes recent uses are representative. What if the first 5 uses were in one context and the last 5 in another?

**Mitigation:**
- Track context changes within the rolling window: recentOutcomes = [(outcome, context_fingerprint), ...]
- If context changed mid-window, flag as "contextual_boundary" and recompute MAE from most-recent-context-only
- Only allow Type 1 graduation if MAE is stable WITHIN a consistent context window

### 12.3 Challenge: Guardian Asymmetry vs. Algorithmic Confidence

**Problem:** Guardian confirms an action is good (2x weight). But algorithmic evaluation shows it's producing poor outcomes (high MAE). Whose signal wins?

**Decision (from CANON):** Guardian always wins.
- Guardian confirmation overrides algorithmic demotion
- But type 1 graduation STILL requires both confidence > 0.80 AND MAE < 0.10
- Guardian can confirm the action is valuable, but if predictions are unreliable, it stays Type 2

```typescript
function handleGuardianVsAlgorithmicConflict(
  action: Procedure,
  guardian_confirmed: boolean,
  algorithmic_mae: number
): Procedure {
  if (guardian_confirmed) {
    action.base_confidence = Math.max(0.70, action.base_confidence);  // Guardian weight
    action.confidence = recomputeConfidence(action);
  }

  // But Type 1 graduation still requires MAE < 0.10
  if (algorithmic_mae >= 0.10) {
    action.type1_status = 'TYPE_1_CANDIDATE';  // Eligible, but not graduated
  }

  return action;
}
```

### 12.4 Challenge: Prediction-Outcome Matching

**Problem:** The system makes a prediction ("if I do X, outcome Y happens"). But outcome Y is ambiguous (how do we measure if it "happened")?

**Example:**
- Prediction: "If I greet Jim, he will smile"
- What counts as "smile"? Subtle lip movement? Teeth showing? Duration?
- Who evaluates: LLM? Computer vision? Guardian feedback?

**Mitigation:**
- Outcomes are represented as ENTITIES in the WKG, not as abstract strings
- Prediction outcome: a reference to a WKG entity (e.g., person_jim_emotional_state:HAPPY)
- Actual outcome: also references an entity
- MAE is computed as distance between predicted entity state and actual entity state
- Ambiguous outcomes → lower confidence in evaluation → higher decay rate

---

## 13. Summary Table: WKG-DM Integration Points

| Operation | WKG Involvement | Latency Budget | Owner |
|-----------|-----------------|-----------------|-------|
| **Retrieve actions** | Index lookup (context_fingerprint) | < 20ms | Decision Making |
| **Compute confidence** | Read base + retrieval_count + last_retrieved | < 10ms | Decision Making |
| **Check Type 1 eligibility** | Read type1_status + recent_prediction_mae | < 5ms | Decision Making |
| **Execute action** | Read action_sequence + parameters | < 5ms | Executor Engine |
| **Generate prediction** | Inner Monologue reads action context | < 50ms (Type 2 latency) | Meridian (LLM) |
| **Record prediction** | Create edge to TimescaleDB event | < 5ms | Decision Making |
| **Report outcome** | IPC to Drive Engine | < 1ms (IPC) | Drive Engine |
| **Update confidence** | Write to action node + create event | < 20ms | Confidence Updater |
| **Track graduation** | Update type1_status field | < 5ms | Confidence Updater |
| **Consolidate episode** | Extract entities, upsert to schema | 100-500ms | Learning |
| **Guardian confirm** | Update base_confidence + confirmation_count | < 10ms | Confidence Updater |

---

## 14. Implications for Implementation (Epic 5 Design)

### 14.1 Modules Affected

1. **Decision Making Module** — Main consumer of WKG queries
   - Action Retriever Service (context fingerprint matching)
   - Confidence Updater Service (writes updated confidence)
   - Executor Engine (reads action sequences)

2. **Knowledge Module** — WKG query provider
   - IWkgService interface must support fast context-based retrieval
   - Must support lazy confidence computation
   - Must support batch updates for Type 1 graduation decisions

3. **Events Module** — Stores predictions and outcomes
   - TimescaleDB schema must link to WKG action nodes
   - Must support efficient MAE history queries

4. **Learning Module** — Drives consolidation
   - Must read fresh episodes
   - Must extract entities and upsert to WKG
   - Must update episode consolidation status

### 14.2 Key Design Decisions Required (for E5 Epic Planning)

1. **Context Fingerprint Algorithm** — What hash function? SHA256? FNV-1a? Is human-readability required?
2. **Confidence Computation Location** — Lazy on-read (recommended) or pre-computed fields?
3. **MAE Storage** — On action node as single field, or linked to outcome events?
4. **Episodic Memory Implementation** — Full separate graph or reuse WKG with special labels?
5. **Type 1 Graduation Authority** — Does Decision Making write type1_status, or is there a separate authority service?
6. **Guardian Confirmation Integration** — Which service writes guardian confirmation changes?

### 14.3 v1 Code to Lift

From `co-being/packages/backend/src/orchestrator/`:
- `action.types.ts` → v2 `ActionProcedureData` (expand with context_fingerprint, type1_status, recent_prediction_mae)
- `action-retriever.service.ts` → v2 `ActionRetrieverService` (adapt category lookup to Neo4j query)
- Confidence computation logic → v2 `ConfidenceService.compute()` (reuse ACT-R formula)
- Prediction logging → v2 `PredictionService` (adapt to TimescaleDB + WKG)

---

## 15. Conclusion

The Decision Making subsystem is deeply coupled to the WKG through:

1. **Action retrieval** — Context fingerprints enable fast lookup of applicable procedures
2. **Confidence dynamics** — ACT-R formula computed lazily on retrieval, with rigorous tracking of retrieval-and-use
3. **Type 1/Type 2 arbitration** — Graduation tracked explicitly on action nodes, driven by MAE from prediction outcomes
4. **Episodic memory** — Episodes link to actions, predictions, and outcomes; consolidation populates semantic schema
5. **Confidence updates** — Confidence Updater service is the sole writer of confidence changes, ensuring consistency

The schema design prioritizes:
- **Speed:** Context fingerprints for O(1) retrieval, index-backed Neo4j queries
- **Rigor:** Every confidence value traced to its base and retrieval history
- **Provenance:** Every edge carries source information (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE)
- **Contingency:** Confidence updates are contingent on actual prediction outcomes, enforcing the Contingency Requirement

The design passes the **Lesion Test**: if the LLM were removed, the WKG (with SENSOR + GUARDIAN + INFERENCE provenance) would remain operational, though degraded. Type 2 capabilities would be lost, but Type 1 reflexes would continue.

