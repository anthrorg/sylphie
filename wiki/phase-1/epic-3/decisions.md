# Epic 3: Decisions

## Decisions Made During Planning

### 1. Lazy confidence computation (on read, not write)

**Decision:** Confidence is computed dynamically via ACT-R formula when nodes are retrieved, never stored as a static property.

**Rationale (Atlas + Sentinel):** Storing confidence statically requires updating every node after each retrieval-and-use event. With high read volumes, this becomes a write bottleneck. Lazy computation eliminates this cost: the formula `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))` is computed on-read using immutable inputs (base, retrieval_count, hours_since_retrieval). The result is always consistent with the formula regardless of when it's accessed.

**Trade-off:** Slightly higher CPU cost per read (logarithmic operations). Mitigated by caching the result in the node object during a single query session. For subsequent queries, the computation is negligible.

**Implementation detail:** retrieval_count and last_retrieved are stored in Neo4j (immutable after creation, updated only on retrieval-and-use). Confidence is computed as a derived field in WkgService.findNode() and queryEdges().

### 2. Single WkgNode label with is_instance flag (vs. separate labels per level)

**Decision:** All nodes carry `:WkgNode` label. The three levels (instance/schema/meta-schema) are distinguished by an `is_instance: boolean` property and `node_level: 'INSTANCE' | 'SCHEMA' | 'META_SCHEMA'` enum field.

**Rationale (Sentinel + Atlas):** Option A (separate labels: `:Instance`, `:Schema`, `:MetaRule`) would require separate Cypher patterns for each level, duplicating query logic. Option B (implicit via properties) is confusing and error-prone. Option C (single label with flag) centralizes all WKG logic: indexes apply to `:WkgNode` universally, query builders can filter by `node_level` property, and type system enforces the distinction.

**Trade-off:** Slightly less semantic clarity in the graph (no visual label distinction), but operationally cleaner and more maintainable.

**CANON alignment:** Canon analysis flagged that the three-level schema must be explicit. This design makes it explicit in code (NodeLevel enum) and queryable in Cypher (WHERE node_level = 'SCHEMA').

### 3. Grafeo technology spike before full implementation

**Decision:** Before committing to Grafeo for Self KG and Other KG, run a 1-week technology spike to validate: (1) Grafeo v0.5.28 operational correctness, (2) Cypher feature completeness, (3) Embedding stability in NestJS, (4) Performance at target scale.

**Rationale (Sentinel + Forge):** Grafeo is pre-1.0, single-maintainer, not widely used in production. Risk is material. A 2-3 day spike (E3-T014) provides: full evaluation, working prototype, three fallback strategies if unsuitable, and zero blocking of other E3 tickets. Self KG and Other KG work (T008-T011) can proceed in parallel if spike is successful.

**Fallback options if Grafeo unsuitable:**
- **Option A (SQLite with custom graph layer):** Use SQLite as embedded store, implement Cypher-like query DSL in TypeScript. Slower but battle-tested.
- **Option B (RocksDB + graph indexing):** Embedded key-value store with custom index layer for graph traversal. Faster, lower memory.
- **Option C (Separate Neo4j instances per person):** Run Neo4j instances for Self KG and Other KG(s). More resource-intensive but proven.

**Implementation:** If spike succeeds: proceed with Grafeo. If spike fails: migration is non-blocking. E3-T014 outputs a detailed report and implementation guide for the chosen fallback.

### 4. Contradiction edges (CONTRADICTS relationship) rather than blocking writes

**Decision:** When upsertEdge() detects a contradiction (e.g., "Jim owns coffee_cup_3" conflicts with existing "coffee_cup_3 owned by Desk_storage"), both edges are stored. A third edge type CONTRADICTS connects them with metadata about the conflict.

**Rationale (Atlas + Science):** Option A (block the write) suppresses knowledge and prevents learning. Option B (overwrite and delete the old edge) loses information. Option C (flag both + emit event) preserves full epistemic history, enables Piagetian accommodation (schema restructuring in response to conflict), and surfaces the contradiction to Drive Engine as integrity disequilibrium.

**Structure:**
```
Node: coffee_cup_3
Edge1: Jim -[:OWNS]-> coffee_cup_3 (confidence: 0.50, provenance: LLM_GENERATED)
Edge2: Desk_storage -[:CONTAINS]-> coffee_cup_3 (confidence: 0.65, provenance: SENSOR)
Edge3 (meta): Edge1 -[:CONTRADICTS]-> Edge2
  { severity: 'HARD', type: 'OWNERSHIP', evidence: ['event_id_123'] }
```

**Implementation:** upsertEdge() queries for existing edges with conflicting semantics. On detection: (1) create CONTRADICTS edge with severity + type, (2) emit KNOWLEDGE_CONTRADICTION event to TimescaleDB, (3) increment Integrity drive signal.

**CANON alignment:** Piaget's assimilation/accommodation framework requires contradictions to trigger learning, not to be suppressed. Science analysis flagged this as critical for genuine development.

### 5. Provenance enforcement at service layer + TypeScript guards

**Decision:** Provenance is required on every write (upsertNode, upsertEdge). Enforcement is at the NestJS service layer (WkgService), not in the Neo4j database constraints. TypeScript types + runtime guards prevent common errors.

**Rationale (Canon + Forge):** Database-level constraints (e.g., Neo4j REQUIRED PROPERTY) are harder to debug and don't provide type safety. Service-layer enforcement allows rich error messages, integration with logging/telemetry, and compile-time type checking in calling code. Guards (provenance.guard.ts, confidence-ceiling.guard.ts) are testable in isolation.

**Implementation:**
```typescript
// In WkgService.upsertNode():
if (!provenance || !PROVENANCE_SOURCES.includes(provenance)) {
  throw new ProvenanceRequiredError(`Invalid provenance: ${provenance}`);
}

// In confidence-ceiling.guard.ts:
if (confidence > 0.60 && retrievalCount === 0) {
  throw new ConfidenceCeilingViolationError(
    `Node ${id} exceeds ceiling (0.60) without retrieval-and-use`
  );
}
```

**Immutability check:**
```typescript
// If node exists, provenance cannot change
const existing = await this.findNode(id);
if (existing && existing.provenance !== provenance) {
  throw new ProvenanceImmutabilityError(
    `Cannot change provenance from ${existing.provenance} to ${provenance}`
  );
}
```

### 6. Events emitted for knowledge mutations via IEventService

**Decision:** Every upsertNode(), upsertEdge(), and contradiction detection emits a typed event to TimescaleDB. Events carry full context: provenance, old/new values, contradiction metadata.

**Rationale (Forge + Ashby):** Events are the stigmergic medium for subsystem coordination. Learning may need to track knowledge mutations for consolidation debt. Drive Engine needs contradiction events to trigger Integrity disequilibrium. Decision Making can observe WKG growth. Without events, subsystems don't see each other's actions.

**Event types:**
- `KNOWLEDGE_NODE_CREATED`: { nodeId, label, type, provenance, confidence }
- `KNOWLEDGE_NODE_UPDATED`: { nodeId, oldConfidence, newConfidence, retrievalCount, cause }
- `KNOWLEDGE_EDGE_CREATED`: { edgeId, fromId, toId, type, provenance, confidence }
- `KNOWLEDGE_EDGE_UPDATED`: { edgeId, oldConfidence, newConfidence, cause }
- `KNOWLEDGE_CONTRADICTION_DETECTED`: { edge1Id, edge2Id, severity, type, conflictType }

**Implementation:** IEventService.record() called at end of upsertNode/upsertEdge. Emitted asynchronously to avoid blocking writes. If event emission fails, log warning but don't fail the write.

### 7. Guardian Asymmetry as retrieval_count multiplier

**Decision:** Guardian confirmation/correction weighting (2x/3x per CANON) is implemented as metadata flag + multiplier in the confidence formula, not as separate nodes or edges.

**Rationale (Canon):** When guardian confirms knowledge ("That's right, Jim likes coffee"), we add guardianConfirmed: true metadata to the edge. In the confidence formula, if guardianConfirmed: true, multiply the retrieval_count contribution by 2x. For corrections (guardian says "No, that's wrong"), apply 3x negative weight.

**Formula variant:**
```
base_confidence = PROVENANCE_BASE[provenance]
retrieval_contribution = 0.12 * ln(count) * guardianMultiplier(guardianConfirmed, isCorrected)

function guardianMultiplier(confirmed: boolean, corrected: boolean): number {
  if (corrected) return 3.0;  // Correction = 3x weight
  if (confirmed) return 2.0;  // Confirmation = 2x weight
  return 1.0;                 // Normal retrieval
}

confidence = min(1.0, base + retrieval_contribution - decay)
```

**Trade-off:** Doesn't change provenance (preserves immutability), doesn't create duplicate edges. The multiplier is baked into the confidence formula, not stored separately.

**Provenance preservation:** The original provenance (LLM_GENERATED) is never changed. Guardian confirmation adds metadata, not a new provenance tag. This preserves the lesion test: filtering by `provenance != LLM_GENERATED` still works even for confirmed LLM-generated knowledge.

### 8. Bounded subgraph traversal for queryContext()

**Decision:** queryContext() (used by Decision Making and Communication for building context) limits traversal depth to 2 hops and max 100 nodes per query. Limits are configurable per subsystem.

**Rationale (Sentinel + Atlas):** Unbounded traversal in a densely connected graph leads to O(n²) or worse query complexity. Quadratic explosion on retrieval kills Decision Making latency. With bounds: a 2-hop neighborhood with 50 nodes per hop = ~5,000 node pairs maximum, easily computable in <100ms. Bounds are high enough for meaningful context without being dangerously expensive.

**Cypher pattern:**
```cypher
MATCH (source:WkgNode {id: $sourceId})
  -[:*1..2]- (neighbor:WkgNode)
WHERE neighbor.id <> $sourceId
  AND neighbor.confidence > 0.50
WITH source, neighbor
LIMIT 100
RETURN collect(neighbor) AS contextNodes
```

**Per-subsystem configuration:**
```typescript
// In communication subsystem
const contextQuery = queryContext(entityId, { maxDepth: 2, maxNodes: 200 });

// In decision making (tighter budget)
const contextQuery = queryContext(actionId, { maxDepth: 1, maxNodes: 50 });
```

### 9. Self KG schema: capabilities, drive_patterns, prediction_accuracy

**Decision:** Sylphie's Self Knowledge Graph (KG(Self)) tracks three core categories: (1) what she can do (capabilities), (2) how her drives respond to stimuli (drive_patterns), (3) how accurate her predictions are (prediction_accuracy).

**Rationale (Science + Atlas):** These three are the minimal sufficient set for self-aware behavior. Capabilities enable Action evaluation ("Can I actually do this?"). Drive patterns enable self-interpretation ("Why did I choose that?"). Prediction accuracy enables self-correction ("My model of Jim was wrong"). All three are Piagetian accommodations—learned through experience, updated when contradicted.

**Schema example:**
```
// Capability node
:Capability {
  id: "speak_to_person",
  name: "Speak to person",
  preconditions: ["person_reachable", "speaker_functional"],
  success_rate: 0.75,  // from prediction_accuracy edges
  last_executed: timestamp,
  confidence: 0.70
}

// Drive pattern edge
:DrivePattern {
  drive: "CURIOSITY",
  stimulus: "new_entity_encountered",
  response_strength: 0.60,
  examples: 5,
  last_observed: timestamp
}

// Prediction accuracy node
:PredictionAccuracy {
  domain: "person_preference",  // e.g., "Jim likes coffee"
  mae: 0.15,  // mean absolute error
  sample_count: 12,
  confidence: 0.65,  // confidence in the accuracy metric itself
}
```

**Isolation:** Self KG is completely separate from WKG. No edges cross between them. Self-knowledge is never used to constrain world-knowledge and vice versa.

### 10. KG isolation through separate service classes and Grafeo instances

**Decision:** WKG, Self KG, and Other KG(s) are implemented as separate service classes with zero shared code or data store. Self KG and Other KGs use Grafeo (embedded, isolated). WKG uses Neo4j (shared, centralized).

**Rationale (Forge + Canon):** The CANON explicitly mandates complete isolation: "Self KG and Other KG (Grafeo) are completely isolated from each other and from the WKG. No shared edges, no cross-contamination." Separate services enforce this at the architecture level—impossible to accidentally share an edge. Separate Grafeo instances per person prevent cross-contamination between person models.

**Service separation:**
```typescript
// WkgService: Neo4j, shared
export class WkgService implements IWkgService {
  constructor(private neo4jDriver: Neo4jDriver) {}
}

// SelfKgService: Grafeo, isolated from WKG
export class SelfKgService implements ISelfKgService {
  constructor(private grafeo: GrafeoInstance) {}
}

// OtherKgService: Grafeo per person
export class OtherKgService implements IOtherKgService {
  private grafeoInstances: Map<PersonId, GrafeoInstance>;

  async getOtherKg(personId: PersonId): Promise<OtherKgInstance> {
    if (!this.grafeoInstances.has(personId)) {
      // Create new Grafeo instance for this person
      const instance = new Grafeo(...)
      this.grafeoInstances.set(personId, instance);
    }
    return this.grafeoInstances.get(personId);
  }
}
```

**Type system enforcement:**
```typescript
// Impossible to accidentally write to WKG from Self KG
const selfKgService: ISelfKgService;  // Only has Grafeo methods
selfKgService.upsertNode(...);        // ✓ OK, uses Grafeo
selfKgService.recordPredictionAccuracy(...);  // ✓ OK, Self KG specific

// Impossible to cross-reference between KGs
const selfNode = await selfKgService.findNode('capability_speak');
const wkgEdge = await wkgService.upsertEdge(
  selfNode.id,  // ✗ Type error: wrong KG type
  'JIM',
  'CREATED_BY'
);
```

---

## Decisions Requiring Jim

These six gaps from Canon's CANON analysis must be resolved before E3 implementation begins:

### 1. Three-level WKG schema design

**Issue:** CANON specifies three levels (instance/schema/meta-schema), but E3 roadmap doesn't specify how to distinguish them in Neo4j.

**Options:**
- **Option A (Separate labels):** `:Instance`, `:SchemaType`, `:MetaRule` labels, separate Cypher patterns per level
- **Option B (Type property):** Single `:WkgNode` label with `type_level: 'INSTANCE' | 'SCHEMA' | 'META'` property
- **Option C (Implicit):** Different properties determine level (e.g., nodes with `supertype` are schemas)

**Recommendation:** Option B (single label + property). Centralizes Neo4j operations, reduces query duplication, type system enforces the distinction. But this is a design choice that affects all WKG queries.

**Decision needed:** Which option? (Planning assumes Option B for E3 work.)

**Status:** APPROVED (2026-03-29) — Option B (single label + property)

### 2. Guardian feedback mechanism

**Issue:** When guardian confirms or corrects LLM-generated knowledge, how should confidence be updated while preserving provenance immutability?

**Options:**
- **Option A (Metadata + multiplier):** Preserve LLM_GENERATED provenance, add `guardianConfirmed: true` or `guardianCorrected: true` metadata, apply 2x/3x multiplier in confidence formula
- **Option B (Separate edges):** Create a new GUARDIAN-provenance edge alongside the LLM_GENERATED edge. Requires merger logic to unify them.
- **Option C (Replace with fusion):** Create a new edge with fused provenance (e.g., "LLM_GENERATED+GUARDIAN_CONFIRMED"). Violates immutability if the original disappears.

**Recommendation:** Option A (Decisions.md 7 specifies this). Preserves provenance immutability, implements 2x/3x weighting in the formula, and preserves the lesion test.

**Decision needed:** Confirmed? Or shall we explore Option B further?

**Status:** APPROVED (2026-03-29) — Option A (metadata + multiplier, preserves provenance immutability)

### 3. Retrieval-and-use definition

**Issue:** What defines a "successful retrieval-and-use event" for confidence increment?

**Scenarios requiring clarification:**
- Decision Making retrieves action "speak to Jim", executes it, guardian responds positively. Does count++?
- Learning queries WKG for context, retrieves edge with confidence 0.50, uses it to extract new edges. Does count++?
- Planning queries patterns, retrieves edge, proposes a plan. If plan succeeds later, does the edge's count++?
- Drive Engine reads Self KG to check prediction accuracy. Does that retrieval count?

**Required specification:** E3 must define success criteria per subsystem (Decision Making actions, Learning edge extraction, Planning pattern research, Drive Engine self-evaluation).

**Decision needed:** What are the three criteria (retrieved + used + succeeded) in each context?

**Status:** APPROVED (2026-03-29) — Define success criteria per subsystem during implementation

### 4. Contradiction detection strategy

**Issue:** What types of contradictions should be detected and how should they be handled?

**Unresolved questions:**
- Logical contradictions only (A and NOT A)? Or domain-specific (OWNERSHIP conflicts)? Or temporal (was true then, false now)?
- Should contradictions block writes or flag-and-proceed?
- How is contradiction severity computed (hard vs. soft)?
- Should contradiction detection happen on all upsertEdge() calls or only during Learning consolidation?

**Current design (Decisions.md 4):** Detects semantic contradictions (conflicting relationship types), flags with CONTRADICTS edge, emits event, proceeds.

**Decision needed:** Is the contradiction strategy (semantic only, flag-and-proceed, always detect) acceptable? Or do we need temporal + domain-specific detection?

**Status:** APPROVED (2026-03-29) — Start with logical contradictions, flag-and-proceed (contradictions are developmental catalysts)

### 5. Self-Evaluation Protocol (CANON A.8)

**Issue:** SelfKgService tracks prediction_accuracy, but E3 doesn't specify the protocol for how Drive Engine uses this for self-evaluation.

**Required specification:**
- When does Drive Engine query Self KG? (Every decision cycle? On demand?)
- How does self-evaluation outcome (success/failure) feed back to Self KG?
- What drives (Integrity, Cognitive Awareness, System Health) change based on Self KG data?
- How does System Health drive detect if Self KG is becoming inaccurate?

**Current design:** SelfKgService stores prediction_accuracy nodes; no protocol specified for integration with Drive Engine.

**Decision needed:** Define the Self-Evaluation Protocol so E3 and E4 (Drive Engine) can coordinate.

### 6. Knowledge Domain Structure (CANON A.9)

**Issue:** Should WKG be flat (single namespace) or domain-partitioned (medical, spatial, social, etc.)?

**Trade-offs:**
- **Flat:** Simpler query logic, easier to reason about global contradictions, one set of indexes
- **Partitioned:** Better isolation between domains, specialized MERGE logic per domain, potential for domain-specific schema evolution

**Impact:** Affects Learning consolidation targets (where does the extracted edge go?), MERGE logic (uniqueness constraints per domain), and query routing in Communication.

**Current design:** Planning assumes flat WKG. Atlas analysis doesn't specify partition strategy.

**Decision needed:** Flat or partitioned? (This affects E3-T004 upsertEdge implementation and E7 Learning consolidation routing.)

---

## Summary of Approved Decisions

**Approved by planning (no Jim input needed):**
1. Lazy confidence computation
2. Single WkgNode label + is_instance flag
3. Grafeo technology spike
4. Contradiction edges (CONTRADICTS) + event emission
5. Service-layer provenance enforcement + TypeScript guards
6. Event emission for knowledge mutations
7. Guardian Asymmetry as multiplier
8. Bounded subgraph traversal for queryContext
9. Self KG schema design (capabilities, drive_patterns, prediction_accuracy)
10. KG isolation through separate services

**Approved by Jim (2026-03-29):**
1. Three-level schema design — Option B (single label + property)
2. Guardian feedback mechanism — Option A (metadata + multiplier)
3. Retrieval-and-use success criteria — define per subsystem during implementation
4. Contradiction detection scope — logical contradictions, flag-and-proceed

**Pending Jim approval:**
5. Self-Evaluation Protocol (integration with Drive Engine)
6. WKG domain structure (flat vs. partitioned)
