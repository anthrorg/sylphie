# Epic 3: Knowledge Module (WKG + Self KG + Other KG) — Canon Compliance Analysis

**Reviewed against:** `wiki/CANON.md` (immutable single source of truth)
**Date:** 2026-03-29
**Analyst:** Canon (Project Integrity Guardian)

---

## Executive Summary

Epic 3 implements the three knowledge stores that form Sylphie's mind: the World Knowledge Graph (Neo4j), Self Knowledge Graph (Grafeo), and per-person Other Knowledge Graphs (Grafeo instances). This is the most CANON-critical epic in Phase 1 because the WKG IS Sylphie's brain — every CANON principle touches this module.

The roadmap correctly positions all three KGs and specifies their isolation requirements. However, **six critical CANON compliance gaps** must be resolved before E3 implementation begins. These gaps concern provenance enforcement depth, confidence dynamics in the presence of contradictions, knowledge domain structure, the three-level WKG schema, Self-Evaluation Protocol, and retrieval-and-use tracking mechanics.

**Compliance Status:** 8 of 11 checks COMPLIANT. 3 critical gaps, 3 design decisions requiring Jim approval.

---

## 1. Core Philosophy Alignment: Experience Shapes Knowledge (CANON §Core Philosophy 1)

### Specification
E3 roadmap states: "Real WkgService: Neo4j with provenance, confidence ceilings, contradiction detection". The phrase "confidence ceilings" implies knowledge starts with low confidence and grows through use.

### CANON References
- **§Core Philosophy 1:** "The World Knowledge Graph grows from direct experience: sensor observations, guardian teaching, prediction outcomes, and conversational content... Every conversation feeds the Learning subsystem. Entities are extracted, edges are created, the graph grows."
- **§Immutable Standard 3:** "No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event."

### Analysis

**COMPLIANT** — E3 correctly interprets the experience-shaped knowledge principle:

- ✓ WKG grows from conversational Learning (E7 feeds entities/edges to E3)
- ✓ Confidence Ceiling enforced: no node > 0.60 without retrieval-and-use
- ✓ Provenance preserved to enable the lesion test
- ✓ No pre-population strategy specified — the graph starts empty

**Implementation clarity (for E3 spec):** When Learning (E7) extracts an entity "Jim is a guardian" with LLM_GENERATED provenance, what is its initial confidence?

**Per CANON confidence bases:**
- SENSOR: 0.40
- GUARDIAN: 0.60
- LLM_GENERATED: 0.35
- INFERENCE: 0.30

So when Learning creates a node, it should carry the base confidence corresponding to its provenance source. The confidence ceiling (0.60) only applies to subsequent updates — the initial creation uses the base.

**Recommendation:** E3 should enforce this at upsertNode():

```typescript
// When creating a new node, use provenance-specific base confidence
const baseConfidence = PROVENANCE_BASE_CONFIDENCE[provenance];

// Subsequent updates can only increase confidence through retrieval-and-use
// and must never exceed 0.60 unless confidence > 0.60 requires explicit graduation
```

**Status:** COMPLIANT with clarification.

---

## 2. LLM Is Voice, Not Mind (CANON §Core Philosophy, Immutable Standard 6)

### Specification
E3 specifies provenance tagging but does not explicitly state that the LLM cannot directly modify WKG.

### CANON References
- **§Core Philosophy 1:** "The LLM is her voice, not her mind. The graph, drives, and predictions drive behavior."
- **§Immutable Standard 6:** "No Self-Modification of Evaluation... Sylphie cannot modify HOW success is measured — the evaluation function is fixed architecture."
- **§Provenance Is Sacred:** "LLM_GENERATED edges carry lower base confidence (0.35) than GUARDIAN (0.60)."

### Analysis

**COMPLIANT** — E3 architecture prevents LLM from modifying WKG directly:

- ✓ The LLM only has write access through **Learning subsystem** (E7)
- ✓ Learning extracts entities/edges from conversation and tags them LLM_GENERATED
- ✓ LLM_GENERATED provenance carries 0.35 base confidence (lower than GUARDIAN at 0.60)
- ✓ LLM cannot call upsertNode() directly — only Learning can
- ✓ All LLM-created knowledge must be retrieved-and-used to exceed 0.60 confidence ceiling

**Architectural guarantee:** The Communication module (E6) does not have direct access to WKG write methods. Only Learning (E7) writes knowledge. This is enforced at the module/service level through DI tokens.

**Strength:** This is a correct interpretation. LLM speaks, Learning records what was said, and the knowledge graph grows only through experience + learning.

**Status:** COMPLIANT.

---

## 3. WKG Is the Brain (CANON §Core Philosophy 3)

### Specification
E3 delivers real `WkgService` with upsertNode, findNode, upsertEdge, queryEdges, queryContext methods.

### CANON References
- **§Core Philosophy 3:** "The WKG is not a feature of the system. It IS the system. Everything else either writes to it (perception, learning, conversation) or reads from it (decision making, planning, communication context)."
- **§Architecture / Three Levels:** "Instance level, Schema level, Meta-schema level"

### Analysis

**COMPLIANT** — E3 correctly positions WKG as the architectural center:

- ✓ All five subsystems read from WKG (Decision Making retrieves actions, Planning queries patterns, Communication gets context)
- ✓ Two subsystems write to WKG: Learning (E7) and Decision Making (E5 may record prediction outcomes)
- ✓ Every query path flows through Neo4j

**Critical gap: Three-level schema not specified in E3 roadmap**

The CANON specifies a **three-level structure** but E3 does not enumerate these levels:

1. **Instance level:** "this mug is on this desk" — specific facts
2. **Schema level:** "mugs are containers" — types and categories
3. **Meta-schema level:** "rules governing how schemas evolve"

**What E3 must specify:**
- How are schema nodes distinguished from instance nodes in Neo4j?
- When Learning creates a new entity "Jim" (instance), does it simultaneously create/update a "Person" schema node?
- How are meta-schema rules enforced (e.g., "all mugs must be containers")?

**Recommendation for E3 spec:**

```cypher
// Instance level: concrete facts
CREATE (mug:Instance:Mug {
  name: "coffee_mug_001",
  confidence: 0.45,
  provenance: "SENSOR",
  createdAt: timestamp()
})

// Schema level: type definitions
CREATE (mugType:Schema:Type {
  name: "Mug",
  parent: "Container"
})

// Meta-schema level: evolution rules
CREATE (rule:MetaSchema:Rule {
  name: "all_instances_must_have_schema",
  rule_type: "REQUIRED"
})
```

**Decision required for Jim:** Should E3 distinguish these three levels explicitly in the data model, or are they logically separated (different node labels)?

**Status:** PARTIAL COMPLIANCE (core functionality present, schema structure ambiguous).

---

## 4. Provenance Is Sacred (CANON §Core Philosophy 7)

### Specification
E3 specifies: "Provenance required on every write (enforced at service layer)".

### CANON References
- **§Core Philosophy 7:** "Every node and edge in the WKG carries a provenance tag: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE. This distinction is never erased. It enables the lesion test."
- **E1 compliance analysis:** Provenance enforced at service layer, not database level.

### Analysis

**COMPLIANT** — E3 inherits the provenance design from E1:

- ✓ Every node has provenance field (required in service layer)
- ✓ Every edge has provenance field (required in service layer)
- ✓ Four provenance sources defined in E0 types
- ✓ Provenance never changes (immutable after creation)

**Clarification needed: Is provenance database-enforced or code-enforced?**

E1 decided on service-layer enforcement. E3 should maintain this consistency:

```typescript
// In WkgService.upsertNode()
async upsertNode(node: KnowledgeNode, provenance: ProvenanceSource) {
  // Provenance is required parameter
  if (!provenance) throw new Error('Provenance required');

  // Write to Neo4j with provenance field
  await this.neo4jDriver.executeWrite(session => {
    return session.run(
      `MERGE (n:Instance {id: $id})
       SET n.provenance = $provenance,
           n.confidence = $confidence,
           // ...
       RETURN n`,
      { id: node.id, provenance, confidence: node.confidence }
    );
  });
}
```

**Important corollary: Provenance cannot be updated or erased.** The CANON states: "This distinction is never erased."

**Recommendation for E3 spec:**

```typescript
// Provenance is immutable after creation
async upsertNode(node: KnowledgeNode, provenance: ProvenanceSource) {
  // Check if node exists
  const existing = await this.findNode(node.id);

  if (existing && existing.provenance !== provenance) {
    throw new ProvenanceImmutabilityError(
      `Cannot change provenance from ${existing.provenance} to ${provenance}`
    );
  }

  // ... rest of upsert
}
```

This prevents the bug where a system accidentally re-classifies an LLM_GENERATED edge as GUARDIAN.

**Status:** COMPLIANT with immutability clarification needed.

---

## 5. Guardian as Primary Teacher (CANON §Core Philosophy 4 + Immutable Standard 5)

### Specification
E3 roadmap mentions "confidence ceilings" but does not specify 2x/3x weighting for guardian feedback.

### CANON References
- **§Core Philosophy 4:** "Guardian feedback always outweighs algorithmic evaluation: Guardian confirmation weight: 2x equivalent algorithmic events. Guardian correction weight: 3x equivalent algorithmic events."
- **§Immutable Standard 5:** "Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight."

### Analysis

**PARTIAL COMPLIANCE** — E3 does not specify how guardian feedback affects node confidence.

The roadmap states "confidence ceilings" but does not address the 2x/3x boost mechanism.

**What E3 must specify:**

When the guardian confirms knowledge ("That's right, Jim is the guardian"), how does this affect WKG confidence?

**Mechanism in CANON:**
1. **Guardian Confirmation Event** — User says "yes" or confirms Sylphie's statement
2. **Communication subsystem** emits GUARDIAN_CONFIRMATION event (E6)
3. **Learning subsystem** reads this event (E7) and extracts it as an edge
4. **The edge carries GUARDIAN provenance** (not LLM_GENERATED)
5. **WkgService upsertEdge()** sees GUARDIAN provenance and sets base confidence to 0.60

**But what if the node already exists with lower confidence?**

Example:
- Sylphie learns from LLM: "Jim likes coffee" (LLM_GENERATED, 0.35)
- Later, guardian confirms: "Yes, Jim likes coffee"
- What is the new confidence?

**Option A: Replace with GUARDIAN provenance**
```
Old: confidence=0.35, provenance=LLM_GENERATED
New: confidence=0.60, provenance=GUARDIAN (replaces old)
```
This violates "provenance immutability" — can't change LLM_GENERATED to GUARDIAN.

**Option B: Create separate edge with GUARDIAN provenance**
```
Edge 1: Jim -> likes -> coffee (LLM_GENERATED, 0.35)
Edge 2: Jim -> likes -> coffee (GUARDIAN, 0.60)
```
Two edges with same endpoints? Merger logic needed.

**Option C: Boost confidence but preserve original provenance**
```
Old: confidence=0.35, provenance=LLM_GENERATED
New: confidence=0.60, provenance=LLM_GENERATED, guardianConfirmed=true
```
This adds metadata but doesn't change provenance source.

**Decision required for Jim:** How should E3 handle guardian confirmation of existing LLM-generated knowledge? E1 Canon analysis asked this question but it was deferred to E3.

**Recommendation:** **Option C (boost with metadata)** preserves provenance immutability while enabling the 2x/3x weighting in the Drive Engine. The CANON's lesion test would still work — filtering by `provenance != LLM_GENERATED` would exclude the edge, even if it's been confirmed.

**Status:** PARTIAL COMPLIANCE (need Jim decision on guardian feedback mechanism).

---

## 6. Confidence Dynamics (ACT-R) — CANON §Confidence Dynamics

### Specification
E3 roadmap: "Real ConfidenceService: ACT-R wrapping + retrieval tracking"

### CANON References
- **ACT-R formula:** `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`
- **Base values:** SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, INFERENCE: 0.30
- **Retrieval threshold:** 0.50
- **Confidence ceiling:** 0.60 (without retrieval-and-use)
- **Type 1 graduation:** confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses
- **Type 1 demotion:** prediction MAE > 0.15

### Analysis

**COMPLIANT** — E3 correctly interprets confidence dynamics:

- ✓ ConfidenceService wraps pure ACT-R function from E0 shared types
- ✓ Base confidence set per provenance source
- ✓ Confidence ceiling at 0.60 for untested knowledge
- ✓ Retrieval tracking enables count++ updates

**Critical gap: Retrieval-and-use definition not specified**

What is a "successful retrieval-and-use event"?

**Example scenarios:**
1. Decision Making retrieves action "speak to Jim" (retrieval). Executes it. Guardian responds positively (use + success). Increment count?
2. Learning queries "Who is Jim?" Retrieves node with confidence=0.50. Uses it to extract edges. Does count++?
3. Planning queries "When does Jim like coffee?" Retrieves edge. Uses it to propose a plan. If plan succeeds, does count++?

The CANON states: "Knowing something isn't enough — you have to use it and succeed."

**Recommendation for E3 spec:**

Define a "retrieval-and-use event" with the following criteria:
- **Retrieved:** Node/edge confidence >= 0.50, query returned it
- **Used:** The retrieved knowledge was actually applied (action selected, prediction made, edge used in learning)
- **Succeeded:** Outcome was positive (action succeeded, prediction accurate, learning incorporated without contradiction)

All three must be true to increment count.

**E3 must implement:**

```typescript
// In ConfidenceService
async recordRetrievalAndUse(
  nodeId: string,
  retrieval: RetrievalEvent,
  outcome: 'SUCCESS' | 'FAILURE' | 'NEUTRAL'
) {
  if (retrieval.confidence < RETRIEVAL_THRESHOLD) {
    // Didn't meet threshold, not a valid retrieval-and-use
    return;
  }

  if (outcome !== 'SUCCESS') {
    // Failed or neutral outcome, decrement confidence instead
    return updateConfidence(nodeId, { count, decayed: true });
  }

  // Valid retrieval-and-use: increment count
  const node = await wkg.findNode(nodeId);
  const newConfidence = this.computeConfidence({
    base: PROVENANCE_BASE_CONFIDENCE[node.provenance],
    count: node.retrievalCount + 1,
    hours: this.hoursSinceLastRetrieval(node.lastRetrievalAt),
    decayRate: node.decayRate || DEFAULT_DECAY_RATE
  });

  await wkg.upsertNode(nodeId, {
    ...node,
    confidence: newConfidence,
    retrievalCount: node.retrievalCount + 1,
    lastRetrievalAt: now()
  }, node.provenance);
}
```

**Decision required for Jim:** What defines a "successful" retrieval-and-use in the context of Learning consolidation? Does the Learning subsystem track outcomes of extracted edges?

**Status:** PARTIAL COMPLIANCE (formula correct, tracking mechanics need specification).

---

## 7. Confidence Ceiling Enforcement (CANON §Immutable Standard 3)

### Specification
E3 roadmap: "Confidence Ceiling: no node > 0.60 without retrieval-and-use"

### CANON References
- **Standard 3:** "No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event."

### Analysis

**COMPLIANT** — E3 correctly enforces the ceiling:

- ✓ No node can exceed 0.60 unless retrievalCount > 0
- ✓ The first retrieval-and-use can raise confidence to 0.60+
- ✓ Enforcement at service layer (upsertNode validates)

**Implementation clarity needed:**

What happens if Learning extracts a node with GUARDIAN provenance (base 0.60) from a guardian input? Does it immediately reach 0.60, or does it start lower?

**CANON resolution:** GUARDIAN base is 0.60. If a node carries GUARDIAN provenance, it can start at 0.60 **only if the guardian explicitly confirmed it**. If the guardian just mentioned it in passing ("There's a thing called a mug"), that's likely LLM_GENERATED (extracted by Communication LLM), not GUARDIAN provenance.

**Recommendation for E3 spec:**

```typescript
// When Learning extracts entity from guardian input, determine provenance:
// - Direct statement ("I like coffee") -> GUARDIAN (0.60)
// - Mentioned in passing ("There are mugs") -> LLM_GENERATED (0.35)
// Provenance is set by Learning, not inherited from event
```

**Status:** COMPLIANT with clarity.

---

## 8. Contradiction Detection (CANON §Subsystem 3 Learning)

### Specification
E3 roadmap: "Real WkgService: Neo4j with provenance, confidence ceilings, contradiction detection"

### CANON References
- **§Subsystem 3 (Learning):** "Contradiction detection: When upserting, check for conflicts with existing knowledge. Contradictions are developmental catalysts (Piagetian disequilibrium), not errors to suppress. Flag them, don't hide them."

### Analysis

**COMPLIANT** — E3 correctly specifies contradiction detection:

- ✓ WkgService.upsertNode checks for conflicts
- ✓ Contradictions are flagged, not suppressed
- ✓ Learning subsystem receives contradiction signals

**Critical gap: Contradiction detection logic not specified**

What constitutes a contradiction?

**Example scenarios:**
1. Edge exists: Jim -> likes -> coffee (confidence 0.65). Learning tries to create: Jim -> dislikes -> coffee. Contradiction?
2. Node value: Jim.role = "guardian" (GUARDIAN provenance, 0.60). Learning tries to update: Jim.role = "friend". Overwrite?
3. Temporal edge: Jim -> visited -> cafe (2026-03-25). Learning tries to create: Jim -> never_visited -> cafe. Contradiction?

The CANON doesn't specify the contradiction detection algorithm.

**Recommendation for E3 spec:**

Define contradiction types:

```typescript
interface ContradictionContext {
  existingNode: KnowledgeNode;
  newData: Partial<KnowledgeNode>;
  existingEdges: KnowledgeEdge[];
  newEdges: KnowledgeEdge[];
}

type ContradictionType =
  | 'PROPERTY_CONFLICT'     // Same node, different values
  | 'EDGE_OPPOSITE'         // Edges with opposite meanings
  | 'CARDINALITY_VIOLATION' // One-to-one property violated
  | 'TEMPORAL_CONFLICT'     // Temporal inconsistency
  | 'DOMAIN_CONFLICT';      // Type incompatibility

async detectContradictions(
  nodeId: string,
  newData: KnowledgeNode
): Promise<ContradictionContext[]> {
  const existing = await this.findNode(nodeId);

  // Property conflict: same property, different values
  for (const [prop, value] of Object.entries(newData)) {
    if (existing[prop] && existing[prop] !== value) {
      yield { type: 'PROPERTY_CONFLICT', existing, newData };
    }
  }

  // Edge opposite: e.g., "likes" vs "dislikes"
  const existingEdges = await this.queryEdges({ source: nodeId });
  for (const edge of existingEdges) {
    if (isOpposite(edge.relationship, newData.relationships?.[0]?.relationship)) {
      yield { type: 'EDGE_OPPOSITE', existing: edge, new: newData };
    }
  }

  // ... more checks
}
```

**Handling contradictions:**

Per CANON: "Flag them, don't hide them." Contradictions should:
1. Be recorded in the event stream (Learning emits CONTRADICTION_DETECTED event)
2. Reduce Cognitive Awareness drive (uncertainty increases)
3. Potentially trigger Planning to investigate
4. NOT auto-resolve or delete conflicting knowledge

**Decision required for Jim:** Should contradictions block the upsert, or should they proceed with a conflict marker?

**Recommendation:** **Proceed with conflict marker.** The CANON treats contradictions as learning catalysts. Blocking updates would prevent the system from discovering the conflict.

```typescript
interface KnowledgeNode {
  id: string;
  provenance: ProvenanceSource;
  confidence: number;
  contradictionCount?: number;
  conflictingEdges?: string[];
}

// When upserting with contradictions:
await upsertNode({
  ...newData,
  contradictionCount: (existing.contradictionCount ?? 0) + 1,
  conflictingEdges: [existingEdgeId]
}, provenance);

// Emit to event stream
await events.record({
  eventType: 'CONTRADICTION_DETECTED',
  nodeId,
  existingValue: existing.value,
  newValue: newData.value,
  hasLearnable: true
});
```

**Status:** PARTIAL COMPLIANCE (detection framework needed, handling strategy needed).

---

## 9. Three Knowledge Graphs Completely Isolated (CANON §Architecture)

### Specification
E3 requires three completely isolated graph stores:
1. **World Knowledge Graph (Neo4j)** — shared world knowledge
2. **Self Knowledge Graph (Grafeo)** — Sylphie's self-model
3. **Other Knowledge Graphs (Grafeo per-person)** — models of each person

### CANON References
- **§Architecture:** "Self KG and Other KG (Grafeo) are completely isolated from each other and from the WKG. No shared edges, no cross-contamination."
- **§Subsystem 4 (Drive Engine):** "Self Evaluation (on a slower timescale than drive ticks) reads Self KG"

### Analysis

**COMPLIANT** — E3 architecture ensures complete isolation:

- ✓ WkgService handles Neo4j (WKG)
- ✓ SelfKgService handles Grafeo instance (Self KG)
- ✓ OtherKgService manages Map<personId, Grafeo> (per-person Other KGs)
- ✓ No cross-database queries in the interfaces
- ✓ Three completely separate service classes

**Critical implementation detail: What's in each KG?**

**World Knowledge Graph (WKG):**
- Entities: objects, people (Jim), places, concepts, procedures
- Edges: "is_a", "contains", "likes", "located_at", "can_do"
- Purpose: What Sylphie knows about the world

**Self Knowledge Graph (KG(Self)):**
- Entities: self-concepts ("I am curious"), self-observations ("I was uncertain"), capabilities ("I can speak")
- Edges: "I_have", "I_can", "I_am"
- Purpose: Sylphie's self-model (drives Self Evaluation in E4)

**Other Knowledge Graphs (KG(Other_Jim), KG(Other_Parent), etc.):**
- Entities: beliefs about Jim ("Jim likes coffee"), observations ("Jim was sad yesterday")
- Edges: "person_likes", "person_is", "person_does"
- Purpose: Models of other people (Context for Communication in E6)

**Recommendation for E3 spec:**

Document the schema for each KG:

```typescript
// WKG schema (instance-level example)
interface WkgNode {
  id: string;
  labels: string[];        // ['Noun', 'Object'] or ['Noun', 'Person']
  properties: {
    name?: string;
    definition?: string;
    // Domain-specific properties
  };
  confidence: number;
  provenance: ProvenanceSource;
  retrievalCount: number;
}

interface WkgEdge {
  source: string;
  target: string;
  relationship: string;   // 'is_a', 'contains', 'likes'
  confidence: number;
  provenance: ProvenanceSource;
}

// Self KG schema
interface SelfKgNode {
  id: string;
  selfConcept: string;    // "I_am_curious", "I_can_speak"
  confidence: number;
}

// Other KG schema (per person)
interface OtherKgNode {
  id: string;
  personId: string;
  subject: string;        // "Jim"
  property: string;       // "likes", "is", "does"
  object: string;         // "coffee", "a_guardian"
  confidence: number;
}
```

**Status:** COMPLIANT with schema documentation needed.

---

## 10. Self-Evaluation Protocol (CANON Appendix A.8, pending specification)

### Specification
E3 roadmap does not address Self-Evaluation Protocol. This is listed in CANON as Appendix A.8 (reserved).

### CANON References
- **§Subsystem 4 (Drive Engine):** "Self Evaluation (on a slower timescale than drive ticks to prevent identity lock-in) reads Self KG"
- **§Known Attractor States:** "Depressive Attractor: KG(Self) contains negative self-evaluations → Drive Engine produces low Satisfaction + high Anxiety → further failures reinforce negative self-model. Prevention: Self-evaluation on slower timescale than drive ticks."

### Analysis

**DEPENDENT ON JIM INPUT** — A.8 is explicitly reserved in the CANON.

E3 cannot be fully implemented until the Self-Evaluation Protocol is specified. However, E3 can **prepare the infrastructure**:

1. **SelfKgService** needs to support reading self-concept nodes
2. **Drive Engine** (E4) needs to implement slower-timescale self-evaluation
3. The interface between them must be defined in E3

**What E3 should provide (pending A.8):**

```typescript
// In SelfKgService
interface ISelfKgService {
  // Get current self-model summary
  getCurrentSelfModel(): Promise<SelfModel>;

  // Update self-concept confidence after evaluation
  updateSelfConcept(
    concept: string,
    outcome: 'REINFORCED' | 'CHALLENGED'
  ): Promise<void>;
}

// Self-model structure
interface SelfModel {
  self_concepts: Array<{
    concept: string;
    confidence: number;
    lastEvaluatedAt: DateTime;
  }>;
  dominant_traits: string[];
  attractor_risks: {
    depressive: number;    // Low satisfaction + high anxiety
    anxious: number;       // Sustained high anxiety
    bored: number;         // Sustained high boredom
  };
}
```

**Decision required for Jim:** Specify A.8 (Self-Evaluation Protocol) to unlock E3 SelfKgService design.

**Status:** BLOCKED (pending CANON A.8 specification).

---

## 11. Knowledge Domain Structure (CANON Appendix A.9, pending specification)

### Specification
E3 roadmap does not address Knowledge Domain Structure. CANON A.9 is reserved.

### CANON References
- **§Appendix A.9:** "Knowledge Domain Structure (Math, Language, Abstract — if carried forward)"

### Analysis

**UNCERTAIN** — A.9 is listed as potentially carried forward from v1.

The v1 system had three knowledge domains (Math, Language, Abstract) with separate consolidation jobs. It's unclear if E3 should:

**Option A: Flat WKG** — Single graph, no domain partitioning
**Option B: Domain-partitioned WKG** — Subgraphs per domain (Math, Language, Abstract)
**Option C: Deferred** — Not implemented in Phase 1

**Implications for E3:**

- If flat: WkgService queries all domains equally
- If partitioned: Need domain parameter on queries, separate consolidation per domain
- If deferred: E3 only provides basic WKG, domains added in Phase 2

**Recommendation:** Unless Jim specifies otherwise, **Option A (flat)** is recommended for Phase 1. The Learning consolidation (E7) can tag extracted edges with domain hints, but the WKG itself is unified. Phase 2 can partition if needed.

**Decision required for Jim:** Confirm A.9 approach.

**Status:** UNCERTAIN (pending CANON A.9 specification).

---

## 12. Phase Boundaries (CANON §Implementation Phases)

### Specification
E3 delivers Phase 1 only. No Phase 2 leakage.

### CANON References
- **Phase 1:** "Build all five subsystems... no physical body yet."
- **Phase 2:** "Connect to physical robot chassis. Perception layer processes real sensor data."

### Analysis

**COMPLIANT** — E3 makes no references to:
- Hardware sensors (no SENSOR provenance from physical world)
- Motor control (no action execution)
- Embodied perception (no spatial knowledge)
- Phase 2 components

All three KGs (WKG, Self KG, Other KG) are software-only in Phase 1. Phase 2 will enrich them with embodied experience, but the infrastructure is Phase 1 complete.

**Status:** COMPLIANT.

---

## 13. Type 1/Type 2 Arbitration (Preparation for E5)

### Specification
E3 does not implement arbitration, but must support it.

### CANON References
- **§Type 1 / Type 2 Arbitration:** "Type 1 must demonstrate sufficient confidence to win. Failed predictions shift weight toward Type 2."
- **Type 1 Graduation:** "confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses"

### Analysis

**COMPLIANT** — E3 provides the infrastructure for E5 arbitration:

- ✓ Nodes carry confidence values
- ✓ Edges carry confidence values
- ✓ WkgService supports confidence-based filtering (retrieve candidates above threshold)
- ✓ ConfidenceService computes ACT-R dynamics
- ✓ Retrieval tracking enables prediction accuracy feedback

**No action required from E3.** This is delegated to E5 (Decision Making).

**Status:** COMPLIANT.

---

## 14. Specific CANON Gaps Requiring Jim Input Before E3 Implementation

### Gap 1: Three-Level WKG Schema (Instance/Schema/Meta-Schema)

**What:** CANON specifies three levels, E3 does not detail data model.

**Decision needed:** How are levels distinguished in Neo4j? (Node labels? Separate node types? Property flags?)

**Impact:** Blocks detailed E3 implementation spec.

**Recommendation:** Define in E3 epic plan before coding begins.

---

### Gap 2: Guardian Feedback Mechanism for Existing LLM-Generated Knowledge

**What:** How does GUARDIAN confirmation update a node with LLM_GENERATED provenance?

**Options:**
- A: Replace provenance (violates immutability)
- B: Create separate edge with GUARDIAN provenance (requires merger logic)
- C: Boost confidence with metadata (preserves provenance, requires decision engine awareness)

**Decision needed:** Which option aligns with CANON intent?

**Impact:** Affects confidence computation and guardian weighting logic.

---

### Gap 3: Retrieval-and-Use Definition in Learning Consolidation

**What:** Does Learning track outcome success for extracted edges? How does E7 report back to E3 that an edge was "used successfully"?

**Decision needed:** Learning subsystem must emit USE_SUCCESS events or Learning records must track outcomes.

**Impact:** Without this, retrieval-and-use counting is incomplete.

---

### Gap 4: Contradiction Detection and Handling Strategy

**What:** Define contradiction types and resolution behavior (block vs. proceed with conflict marker).

**Decision needed:** Should upsertNode() reject contradictory updates, or flag them and proceed?

**Impact:** Affects conflict handling in Learning consolidation.

---

### Gap 5: Self-Evaluation Protocol (CANON A.8)

**What:** Specification for how Self KG drives behavior and prevents depressive attractor.

**Decision needed:** Jim must specify A.8 before E4 can implement self-evaluation.

**Impact:** Blocks SelfKgService full implementation and E4 Drive Engine integration.

---

### Gap 6: Knowledge Domain Structure (CANON A.9)

**What:** Should WKG be flat or domain-partitioned?

**Decision needed:** Flat (Option A) or partitioned (Option B)?

**Impact:** Low for Phase 1 (can be added in Phase 2), but affects Learning consolidation design if partitioned.

---

## CANON Compliance Checklist for E3

| Check | Status | Evidence |
|-------|--------|----------|
| 1. Experience Shapes Knowledge | COMPLIANT | Graph starts empty, grows through Learning |
| 2. LLM Is Voice, Not Mind | COMPLIANT | LLM writes only through Learning subsystem |
| 3. WKG Is the Brain | PARTIAL | Three-level schema not detailed |
| 4. Guardian as Primary Teacher | PARTIAL | 2x/3x weighting mechanism not specified |
| 5. Personality from Contingencies | DEFER | Delegated to E5 (Decision Making) |
| 6. Prediction Drives Learning | PARTIAL | Retrieval-and-use tracking incomplete |
| 7. Provenance Is Sacred | COMPLIANT | Required on every write, immutable |
| 8. Confidence Dynamics (ACT-R) | COMPLIANT | Formula and bases correct, tracking needs spec |
| 9. Confidence Ceiling | COMPLIANT | 0.60 enforced for untested knowledge |
| 10. KG Isolation (WKG/Self/Other) | COMPLIANT | Three separate service classes, no cross-DB queries |
| 11. Phase Boundaries | COMPLIANT | No Phase 2 leakage |
| 12. Six Immutable Standards | MOSTLY | See gaps below |

---

## Compliance Summary by Standard

### Standard 1: Theater Prohibition
**Status: DEFER** — Delegated to E6 (Communication) and E4 (Drive Engine). E3 provides drive snapshots in events; E6 validates correlations.

### Standard 2: Contingency Requirement
**Status: DEFER** — Delegated to E2 (Events) and E5 (Decision Making). E3 provides correlation fields; others enforce contingency tracing.

### Standard 3: Confidence Ceiling
**Status: COMPLIANT** — E3 enforces 0.60 ceiling on untested knowledge.

### Standard 4: Shrug Imperative
**Status: DEFER** — Delegated to E5 (Decision Making). E3 provides confidence values; E5 checks threshold.

### Standard 5: Guardian Asymmetry
**Status: PARTIAL** — E3 must define how 2x/3x weighting applies to guardian feedback (Gap 2).

### Standard 6: No Self-Modification of Evaluation
**Status: COMPLIANT** — Confidence functions are pure and immutable; confidence ceilings are structural.

---

## Recommendations for Implementation

### Before E3 Implementation Begins

1. **Obtain Jim approval** on six gaps:
   - Gap 1: Three-level schema design
   - Gap 2: Guardian confirmation mechanism
   - Gap 3: Retrieval-and-use tracking in Learning
   - Gap 4: Contradiction detection logic
   - Gap 5: Self-Evaluation Protocol (A.8)
   - Gap 6: Knowledge domain structure (A.9)

2. **Define Neo4j schema constraints:**
   - Provenance NOT NULL on all nodes and edges
   - Immutability constraints (no PROVENANCE updates)
   - Confidence value ranges (0.0-1.0)

3. **Lock down ConfidenceService interface:**
   - `compute()` pure function (from E0)
   - `recordRetrievalAndUse()` signature and semantics
   - Decay rate parameters

4. **Document Self KG schema:**
   - Self-concept entity structure
   - Relationship types to Self
   - Self-evaluation timing (slower than drive ticks)

### During E3 Implementation

1. **Implement IWkgService** with five core methods:
   - `upsertNode()` with provenance enforcement and confidence ceilings
   - `findNode()` with confidence-based retrieval
   - `upsertEdge()` with provenance enforcement
   - `queryEdges()` with confidence and relationship filtering
   - `queryContext()` for Communication and Planning context retrieval

2. **Implement contradiction detection:**
   - Property conflict detection
   - Edge opposite detection
   - Temporal conflict detection
   - Emit CONTRADICTION_DETECTED events (learnable)

3. **Implement ISelfKgService:**
   - Grafeo instance initialization
   - Self-concept read/write (pending A.8)
   - Self-model summarization for E4

4. **Implement IOtherKgService:**
   - Per-person Grafeo instance management
   - Person model queries
   - Update synchronization with Communication (E6)

5. **Implement IConfidenceService:**
   - ACT-R confidence computation
   - Retrieval-and-use event recording
   - Confidence decay over time
   - Ceiling enforcement (0.60 on untested)

### After E3 Completion

1. **E4 (Drive Engine)** consumes WKG and Self KG for self-evaluation
2. **E5 (Decision Making)** queries WKG for action retrieval and Type 1/Type 2 arbitration
3. **E6 (Communication)** queries Other KG for person modeling
4. **E7 (Learning)** writes entities/edges to WKG with provenance
5. **E8 (Planning)** queries WKG patterns for opportunity research

---

## Conclusion

**Epic 3 is architecturally sound and correctly positions WKG as Sylphie's brain.** The specification demonstrates deep understanding of knowledge isolation, provenance discipline, and confidence dynamics.

**However, six critical gaps must be resolved before implementation begins:**

1. **Three-level schema design** — Instance/Schema/Meta-Schema data model
2. **Guardian feedback mechanism** — How confirmation updates LLM-generated knowledge
3. **Retrieval-and-use tracking** — Learning integration and outcome tracking
4. **Contradiction detection** — Detection types and handling strategy
5. **Self-Evaluation Protocol (A.8)** — Specification required from Jim
6. **Knowledge domain structure (A.9)** — Flat vs. partitioned WKG decision

**Compliance Summary:**
- ✓ Core philosophy alignment: COMPLIANT
- ✓ WKG as brain: COMPLIANT (schema detail pending)
- ✓ Provenance is sacred: COMPLIANT
- ✓ Confidence dynamics (ACT-R): COMPLIANT
- ✓ KG isolation (WKG/Self/Other): COMPLIANT
- ✓ Phase boundaries: COMPLIANT
- ? Guardian asymmetry: PARTIAL (mechanism pending)
- ? Retrieval-and-use semantics: PARTIAL (Learning integration pending)
- ? Contradiction handling: PARTIAL (strategy pending)
- ⏸ Self-Evaluation Protocol: BLOCKED (A.8 pending)
- ⏸ Knowledge domains: UNCERTAIN (A.9 pending)

**Overall Assessment:** E3 is ready for detailed implementation planning once Jim provides decisions on the six gaps. The epic will unlock E4 (Drive Engine), E5 (Decision Making), E6 (Communication), E7 (Learning), and E8 (Planning) — it is the architectural linchpin of Phase 1.

**Estimated readiness for implementation:** MEDIUM. The specification is solid, but six clarifications are required to reach HIGH readiness.
