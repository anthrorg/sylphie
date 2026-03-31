# Atlas Analysis: Epic 1 Database Infrastructure & KG Architecture

**Agent:** Atlas (Knowledge Graph Architect)
**Epic:** 1 -- Database Infrastructure
**Date:** 2026-03-29
**Status:** Analysis (pre-implementation)

---

## Preamble

Epic 1 wires all five database connections and creates the schemas that will persist Sylphie's brain (World Knowledge Graph), her self-model (Self KG), and her models of others (Other KGs). This analysis focuses on the knowledge graph infrastructure specifically: Neo4j WKG schema design, Grafeo technology validation, isolation enforcement, provenance architecture, and the confidence dynamics substrate.

This analysis addresses the three critical risks identified in the Epic 1 charter:
1. **Neo4j WKG schema and constraints** -- the instance, schema, and meta-schema levels
2. **Grafeo technology validation** -- does it exist, can it support the requirements?
3. **KG isolation enforcement** -- how to structurally guarantee WKG, Self KG, and Other KG never share data

The other Epic 1 concerns (TimescaleDB, PostgreSQL, Docker Compose) are out of scope for this analysis but depend on knowledge module decisions.

---

## 1. Grafeo Technology Validation (CRITICAL BLOCKER)

### 1.1 The Requirement

From CANON and roadmap:
- **Self KG**: Embedded graph database, Cypher support, one isolated instance
- **Other KG**: Embedded graph database, Cypher support, one instance per person (indexed in a Map keyed by `personId`)
- **Isolation**: Complete data separation -- no shared edges, no cross-contamination, no query-time visibility across graphs

The CANON explicitly calls for Grafeo (`@grafeo-db/js`) for Self KG and Other KG. However, Grafeo v0.5.28 is pre-1.0, and there are real risks here.

### 1.2 Investigation Required (BLOCKING E1)

**Before implementation, **Jim or an agent must validate**:

1. **Does Grafeo exist as usable library?**
   - NPM package: `@grafeo-db/js`
   - Minimum viable version: v0.5.28
   - Can be installed in a NestJS project without major peer dependency conflicts

2. **Cypher query support?**
   - Yes/No: Does Grafeo support standard Cypher queries?
   - If partial: which Cypher features are unsupported?
   - Workaround cost: if Cypher is missing, does Grafeo expose a GQL API or only proprietary graph navigation?

3. **Complete isolation?**
   - Can you create N completely independent Grafeo instances in memory?
   - Is each instance isolated from the others (no shared vertex/edge space)?
   - What's the memory overhead per instance? (Self KG will be small, Other KG per-person will be small, but many users = many instances)

4. **Storage backends?**
   - In-memory only, or persistent?
   - If persistent: does it use file I/O, SQLite, or something else?
   - Can one instance be configured as in-memory and another as file-backed?

5. **Performance characteristics?**
   - Query latency for small graphs (Self KG estimated 50-200 nodes, Other KG per-person 20-100 nodes)?
   - Update latency (upsert operations during consolidation)?
   - Does performance degrade with number of instances?

### 1.3 Fallback Options (If Grafeo Fails)

If Grafeo is unavailable, non-compliant, or unsuitable, here are the ranked alternatives:

**Option A (Preferred): In-Memory LPG with Cypher Support**
- Technology: **TinkerPop-based embedded graph** (Apache Gremlin) or **neo4j-js** (community implementation)
- Pros: Full Cypher support, proven in production, complete isolation per instance
- Cons: JVM dependency (Gremlin) OR incomplete Cypher coverage (neo4j-js)
- Recommendation: Investigate `neo4j-driver` with in-memory adapter or TypeScript Gremlin bindings

**Option B: SQLite + Custom Graph Abstraction**
- Technology: SQLite with vertex/edge tables, custom traversal layer
- Pros: Zero dependencies, persistence built-in, complete isolation (one file per KG)
- Cons: No Cypher support (custom traversal DSL required), manual graph algorithms
- Query cost: Higher latency for complex traversals, but acceptable for small graphs
- Recommendation: Fallback only if Cypher is non-negotiable and LPG unavailable

**Option C: Multiple Neo4j Databases**
- Technology: Neo4j Community Edition with separate databases (Neo4j 4.0+ supports multiple DBs)
- Pros: Native Cypher, proven, mature
- Cons: Each database needs separate Neo4j driver connection; overhead per-instance; architectural break from "embedded" design
- Recommendation: Not preferred (loses embedded simplicity), but viable if LPG doesn't exist

**Option D: Redis with Cypher Wrapper (Experimental)**
- Technology: Redis as vertex/edge store, Cypher query compiler to Redis commands
- Pros: Fast, in-memory, distributed
- Cons: Highly experimental, no proven Cypher implementation, schema evolution painful
- Recommendation: Not recommended unless you want to implement Cypher compiler yourself

### 1.4 Recommendation for Epic 1 Planning

**Before starting implementation:**

1. **Spend 1-2 hours validating Grafeo** against the five questions above
2. **If Grafeo passes all five: proceed with Grafeo as planned**
3. **If Grafeo fails on Cypher or isolation: switch to Option A** (TinkerPop or neo4j-js)
4. **If all LPG options fail: switch to Option C** (multiple Neo4j databases) as architectural compromise
5. **Document the decision in `wiki/phase-1/decisions/grafeo-technology.md`** with rationale

This decision gates E1, E3, and E4. Do not implement without knowing which technology you're targeting.

---

## 2. Neo4j WKG Schema and Constraints

### 2.1 Three-Level Schema System

The WKG operates on three levels (from CANON §3):

1. **Instance Level (ABox)**: Individual nodes and edges
   - Example: `:Entity { id: "mug_kitchen", name: "kitchen mug" }`
   - Example: `(mug_kitchen)-[:ON]->(desk_1)`

2. **Schema Level (TBox)**: Type definitions and relationship categories
   - Example: `:SchemaType { name: "mug", subClassOf: "container" }`
   - Example: `:SchemaRelType { name: "ON", domain: "Entity", range: "Place" }`

3. **Meta-Schema Level**: Rules governing how TBox evolves
   - Example: "only GUARDIAN provenance can modify SchemaType definitions"
   - Example: "new SchemaRelType requires GUARDIAN approval"

**Neo4j Implementation:**

At init time, the WKG gets:
- One root `:MetaSchema` node
- One `:Schema` node (all TBox lives under this)
- Instance nodes labeled `:Entity`, `:Concept`, `:Procedure`, `:Utterance`, `:SchemaType`, `:SchemaRelType`, `:MetaRule`

**Constraint enforcement:**
- Uniqueness constraints on (label, id)
- Existence constraints on provenance properties
- Custom application-layer constraints on TBox modification (enforced in NestJS service, not DB)

### 2.2 Neo4j Constraint Strategy

**Applied on module init** (in `NestJS onModuleInit()` for KnowledgeModule):

```typescript
// All constraints are idempotent -- safe to re-run
// Use `CREATE CONSTRAINT ... IF NOT EXISTS` (Neo4j 4.1+)

// Node uniqueness constraints (instance level)
CREATE CONSTRAINT wkg_entity_id IF NOT EXISTS
  FOR (n:Entity) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_concept_id IF NOT EXISTS
  FOR (n:Concept) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_procedure_id IF NOT EXISTS
  FOR (n:Procedure) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_utterance_id IF NOT EXISTS
  FOR (n:Utterance) REQUIRE n.id IS UNIQUE;

// Schema level constraints
CREATE CONSTRAINT wkg_schema_type_name IF NOT EXISTS
  FOR (n:SchemaType) REQUIRE n.name IS UNIQUE;

CREATE CONSTRAINT wkg_schema_rel_type_name IF NOT EXISTS
  FOR (n:SchemaRelType) REQUIRE n.name IS UNIQUE;

// Provenance existence constraints (CRITICAL -- every node and edge must have provenance)
CREATE CONSTRAINT wkg_node_provenance_required IF NOT EXISTS
  FOR (n) WHERE n.provenance IS NOT NULL
  REQUIRE n.provenance IS NOT NULL;  // Note: syntax varies by Neo4j version

CREATE CONSTRAINT wkg_node_confidence_required IF NOT EXISTS
  FOR (n) WHERE n.confidence IS NOT NULL
  REQUIRE n.confidence IS NOT NULL;
```

**Note on property existence constraints:** Neo4j Community Edition (4.1-4.4) has limited property constraint support. If existence constraints are not available, enforce at application layer in `IWkgService.upsertNode()` before any Cypher execute.

### 2.3 Index Strategy for Query Performance

Indexes are created on **common query patterns** identified from the five subsystems:

```typescript
// Confidence-based retrieval (Decision Making, Planning)
CREATE INDEX wkg_node_confidence IF NOT EXISTS FOR (n) ON (n.confidence);

// Provenance filtering (Learning, Communication, Theater Prohibition)
CREATE INDEX wkg_node_provenance IF NOT EXISTS FOR (n) ON (n.provenance);

// Label-based queries (all subsystems)
CREATE INDEX wkg_node_label IF NOT EXISTS FOR (n:Entity) ON (n);
CREATE INDEX wkg_node_label IF NOT EXISTS FOR (n:Concept) ON (n);
CREATE INDEX wkg_node_label IF NOT EXISTS FOR (n:Procedure) ON (n);

// Type lookups (schema level)
CREATE INDEX wkg_schema_type_by_name IF NOT EXISTS FOR (n:SchemaType) ON (n.name);

// Temporal queries (Learning consolidation)
CREATE INDEX wkg_node_created_at IF NOT EXISTS FOR (n) ON (n.created_at);
CREATE INDEX wkg_node_retrieved_at IF NOT EXISTS FOR (n) ON (n.retrieved_at);

// ACT-R confidence updates
CREATE INDEX wkg_node_retrieval_count IF NOT EXISTS FOR (n) ON (n.retrieval_count);

// Person-scoped queries (Communication, Other KG integration)
CREATE INDEX wkg_node_person_id IF NOT EXISTS FOR (n) ON (n.person_id);  // for cross-referencing
```

**Index maintenance:** These indexes should be built once during `onModuleInit()`. Monitor query plans via Neo4j's `EXPLAIN` and `PROFILE` during development to identify missing indexes.

### 2.4 Provenance Schema (On Every Node and Edge)

Every node and edge in the WKG carries six provenance properties:

```typescript
interface ProvenanceData {
  provenance: 'SENSOR' | 'GUARDIAN' | 'LLM_GENERATED' | 'INFERENCE';
  created_at: number;           // Unix timestamp (ms)
  source_id?: string;           // Which sensor, guardian, or inference rule
  confidence: number;           // ACT-R confidence [0.0, 1.0]
  retrieval_count: number;      // Successful retrieval-and-use events
  last_retrieved: number;       // Unix timestamp (ms), or -1 if never retrieved
}
```

**Storage in Neo4j:**

Node properties:
```cypher
CREATE (n:Entity {
  id: "mug_kitchen",
  name: "kitchen mug",
  created_at: 1711699200000,
  provenance: "GUARDIAN",
  source_id: "jim",
  confidence: 0.60,
  retrieval_count: 0,
  last_retrieved: -1
})
```

Edge properties (via `neo4j-driver`'s relationship abstraction):
```cypher
CREATE (mug_kitchen)-[r:ON {
  created_at: 1711699200000,
  provenance: "GUARDIAN",
  source_id: "jim",
  confidence: 0.60,
  retrieval_count: 0,
  last_retrieved: -1
}]->(desk_1)
```

**Application-Layer Enforcement:**
Every call to `IWkgService.upsertNode()` or `upsertEdge()` MUST include provenance as a required parameter. If omitted, throw `ProvenanceRequiredException`.

### 2.5 Node Type Schema (WkgNodeCategory)

From Epic 0 Atlas analysis:

```typescript
type WkgNodeCategory =
  | 'Entity'        // physical objects, persons, places
  | 'Concept'       // abstract knowledge
  | 'Procedure'     // compiled behavioral sequences
  | 'Utterance'     // speech acts eligible for CAN_PRODUCE edges
  | 'SchemaType'    // schema-level type node (TBox)
  | 'SchemaRelType' // schema-level relationship type definition (TBox)
  | 'MetaRule'      // meta-schema rules governing TBox evolution
```

Each category has Neo4j label + properties:

| Category | Labels | Key Properties | Decay Rate |
|----------|--------|-----------------|------------|
| Entity | `:Entity` | `id`, `name`, `category` (physical/abstract) | 0.03 |
| Concept | `:Concept` | `id`, `name`, `definition` | 0.04 |
| Procedure | `:Procedure` | `id`, `name`, `signature`, `precondition` | 0.07 |
| Utterance | `:Utterance` | `id`, `text`, `speaker`, `context` | 0.05 |
| SchemaType | `:SchemaType` | `name`, `parent_type`, `constraints` | 0.02 |
| SchemaRelType | `:SchemaRelType` | `name`, `domain`, `range` | 0.02 |
| MetaRule | `:MetaRule` | `name`, `rule_text`, `applies_to_level` | 0.01 |

**Decay rate mapping:** The `DEFAULT_DECAY_RATES` from `src/shared/types/confidence.types.ts` should be indexed by category. When computing confidence for a node, fetch its decay rate via its category.

### 2.6 Relationship Type Schema

Key relationships in the WKG:

| Relationship | Source | Target | Semantics | Confidence Inheritance |
|--------------|--------|--------|-----------|------------------------|
| `IS_A` | Entity/Concept | SchemaType | categorization | child < parent |
| `SUBCLASS_OF` | SchemaType | SchemaType | taxonomy | (schema-level, not instance) |
| `INSTANCE_OF` | Entity | SchemaType | instance relation | child <= parent |
| `HAS_PROPERTY` | Entity | Concept | property/attribute | entity-scoped |
| `RELATED_TO` | Entity | Entity | semantic relation | min(source, target) |
| `ON` | Entity | Entity | spatial relation (on/at/in/under) | min(source, target) |
| `CAN_PRODUCE` | Procedure | Utterance | utterance generation | procedure-scoped |
| `REQUIRES` | Procedure | Procedure | prerequisite | min(source, target) |
| `DEFINED_BY` | SchemaRelType | SchemaType | domain/range definition | (schema-level) |
| `AFFECTED_BY` | Procedure | (Drive) | behavioral link | procedure-scoped |
| `NEXT` | Procedure | Procedure | sequential ordering | (procedure-level) |

**Confidence propagation rule:**
When upserting an edge, confidence is NOT inherited from nodes. Each edge has independent confidence based on its provenance. However, some query algorithms may compute "path confidence" as the minimum confidence along a path.

### 2.7 Initial Neo4j Schema Setup (onModuleInit)

```typescript
// In KnowledgeModule.onModuleInit():

async onModuleInit() {
  const session = this.neoDriver.session();

  try {
    // 1. Create root schema nodes if they don't exist
    await session.run(`
      CREATE (root:MetaSchema {
        id: "root_metaschema",
        name: "Root Meta-Schema",
        created_at: $now,
        provenance: "SENSOR",
        confidence: 1.0,
        retrieval_count: 1,
        last_retrieved: $now
      })
    `, { now: Date.now() });

    await session.run(`
      CREATE (schema:Schema {
        id: "root_schema",
        name: "Root Schema (TBox)",
        created_at: $now,
        provenance: "SENSOR",
        confidence: 1.0,
        retrieval_count: 1,
        last_retrieved: $now
      })
    `, { now: Date.now() });

    // 2. Apply all constraints
    await Promise.all([
      session.run('CREATE CONSTRAINT wkg_entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE'),
      session.run('CREATE CONSTRAINT wkg_concept_id IF NOT EXISTS FOR (n:Concept) REQUIRE n.id IS UNIQUE'),
      session.run('CREATE CONSTRAINT wkg_procedure_id IF NOT EXISTS FOR (n:Procedure) REQUIRE n.id IS UNIQUE'),
      session.run('CREATE CONSTRAINT wkg_utterance_id IF NOT EXISTS FOR (n:Utterance) REQUIRE n.id IS UNIQUE'),
      session.run('CREATE CONSTRAINT wkg_schema_type_name IF NOT EXISTS FOR (n:SchemaType) REQUIRE n.name IS UNIQUE'),
      session.run('CREATE CONSTRAINT wkg_schema_rel_type_name IF NOT EXISTS FOR (n:SchemaRelType) REQUIRE n.name IS UNIQUE'),
    ]);

    // 3. Apply all indexes
    await Promise.all([
      session.run('CREATE INDEX wkg_node_confidence IF NOT EXISTS FOR (n) ON (n.confidence)'),
      session.run('CREATE INDEX wkg_node_provenance IF NOT EXISTS FOR (n) ON (n.provenance)'),
      session.run('CREATE INDEX wkg_schema_type_by_name IF NOT EXISTS FOR (n:SchemaType) ON (n.name)'),
      session.run('CREATE INDEX wkg_node_created_at IF NOT EXISTS FOR (n) ON (n.created_at)'),
      // ... more indexes
    ]);

    console.log('[KnowledgeModule] Neo4j schema initialized');
  } finally {
    await session.close();
  }
}
```

---

## 3. Self KG and Other KG Isolation Enforcement

### 3.1 The Isolation Requirement

From CANON:
> **Self KG and Other KG are completely isolated from each other and from the WKG. No shared edges, no cross-contamination.**

This is not just a logical separation; it is a **structural guarantee**. Sylphie's self-model must never bleed into her model of Jim, and neither must leak into the world knowledge. This prevents:
- Attribution errors (learning something about Jim and accidentally generalizing to herself)
- Self-contamination (incorrect self-beliefs influencing world perception)
- Guardian privacy (Jim's personal model stays separate)

### 3.2 Implementation Pattern (Grafeo or Fallback)

**Option 1: Grafeo (if validation passes)**

```typescript
// One instance per graph
class SelfKgService implements ISelfKgService {
  private grafeo: GrafeoInstance;

  constructor(grafeoFactory: GrafeoFactory) {
    // Create single instance for Self KG
    this.grafeo = grafeoFactory.create('self_kg');
  }

  // All operations go through this.grafeo -- structurally isolated
  async getCurrentModel(): Promise<SelfModel> {
    return this.grafeo.query(cypherQuery);
  }
}

class OtherKgService implements IOtherKgService {
  private otherKgs: Map<string, GrafeoInstance> = new Map();

  constructor(grafeoFactory: GrafeoFactory) {
    // Constructor doesn't pre-allocate; instances created on-demand
  }

  private getOrCreatePersonGraph(personId: string): GrafeoInstance {
    if (!this.otherKgs.has(personId)) {
      this.otherKgs.set(personId, grafeoFactory.create(`other_kg_${personId}`));
    }
    return this.otherKgs.get(personId)!;
  }

  async getPersonGraph(personId: string): Promise<PersonModel> {
    const kg = this.getOrCreatePersonGraph(personId);
    return kg.query(cypherQuery);
  }
}
```

**Isolation guarantee:** Each Grafeo instance is completely separate. Even if one is compromised, others remain safe.

**Option 2: SQLite (if Grafeo fails)**

Each KG gets its own file:

```typescript
class SelfKgService implements ISelfKgService {
  private db: Database;

  constructor() {
    // :memory: for in-memory, or file path for persistence
    this.db = new Database(':memory:');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vertices (id TEXT PRIMARY KEY, data JSON);
      CREATE TABLE IF NOT EXISTS edges (from_id TEXT, to_id TEXT, rel_type TEXT, data JSON);
    `);
  }

  // All operations go through this.db -- structurally isolated
}

class OtherKgService implements IOtherKgService {
  private otherKgs: Map<string, Database> = new Map();

  private getOrCreatePersonGraph(personId: string): Database {
    if (!this.otherKgs.has(personId)) {
      const db = new Database(`/tmp/other_kg_${personId}.db`);
      db.exec(`CREATE TABLE IF NOT EXISTS vertices (...); ...`);
      this.otherKgs.set(personId, db);
    }
    return this.otherKgs.get(personId)!;
  }
}
```

**Isolation guarantee:** Each SQLite database is a separate file with separate connection. No query can cross databases.

### 3.3 Query-Time Isolation Verification

In tests, verify that isolation is maintained:

```typescript
// Test: Self KG and Other KG cannot query each other's data
describe('KG Isolation', () => {
  it('Self KG cannot access Other KG data', async () => {
    // Add a node to Other KG (Jim)
    const otherKg = await otherKgService.getPersonGraph('jim');
    await otherKg.upsertNode({ id: 'secret_jim', name: 'secret data' });

    // Try to query from Self KG
    const result = await selfKgService.queryByName('secret_jim');

    // Result must be empty
    expect(result).toBeNull();
  });

  it('Other KG per-person instances are isolated', async () => {
    // Add node to Jim's Other KG
    await otherKgService.upsertNode('jim', { id: 'jim_fact', name: 'Jim likes coffee' });

    // Try to query from Sarah's Other KG
    const result = await otherKgService.queryNode('sarah', 'jim_fact');

    // Result must be empty
    expect(result).toBeNull();
  });
});
```

---

## 4. Provenance Discipline at Scale

### 4.1 Provenance in Upsert Operations

Every graph write must carry provenance. This is enforced at the interface level:

```typescript
interface IWkgService {
  // WRONG: no provenance parameter
  // upsertNode(node: KnowledgeNode): Promise<void>;

  // CORRECT: provenance is required
  upsertNode(
    node: KnowledgeNode,
    provenance: ProvenanceSource,
    sourceId?: string
  ): Promise<void>;
}
```

**Implementation constraint:** If provenance is missing, throw immediately:

```typescript
async upsertNode(node, provenance, sourceId) {
  if (!provenance) {
    throw new ProvenanceRequiredException(
      `upsertNode called without provenance. Node: ${node.id}`
    );
  }

  // Now safe to proceed
  const nodeWithProvenance = {
    ...node,
    created_at: Date.now(),
    provenance,
    source_id: sourceId,
    confidence: PROVENANCE_BASE_CONFIDENCE[provenance],
    retrieval_count: 0,
    last_retrieved: -1,
  };

  // Write to Neo4j
}
```

### 4.2 Provenance Tracking in Learning

When the Learning subsystem consolidates events into the WKG (Epic 7), provenance tells us where knowledge came from:

| Source | Provenance | Confidence | Example |
|--------|-----------|-----------|---------|
| Visual sensor | SENSOR | 0.40 | "I saw Jim at the desk" |
| Guardian correction | GUARDIAN | 0.60 | Jim says "That's wrong, I'm actually left-handed" |
| LLM generation | LLM_GENERATED | 0.35 | LLM infers "Jim is probably left-handed" |
| Graph inference | INFERENCE | 0.30 | "Jim likes coffee AND coffee requires a cup, therefore Jim relates_to cups" |

**Experiential provenance ratio** (a key health metric from CANON):
```
experiential_ratio = (SENSOR + GUARDIAN + INFERENCE) / (SENSOR + GUARDIAN + INFERENCE + LLM_GENERATED)
```

If experiential_ratio < 0.5 over time, Sylphie is being populated, not learning.

### 4.3 Confidence Ceiling Enforcement (Immutable Standard 3)

From CANON: "No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event."

**Implementation:**

```typescript
async upsertNode(node, provenance, sourceId) {
  const baseConfidence = PROVENANCE_BASE_CONFIDENCE[provenance];

  // Compute ACT-R confidence
  const confidence = computeConfidence({
    base: baseConfidence,
    retrievalCount: node.retrieval_count ?? 0,
    hoursSinceRetrieval: node.last_retrieved < 0
      ? 999  // never retrieved
      : (Date.now() - node.last_retrieved) / (1000 * 3600),
    decayRate: DEFAULT_DECAY_RATES[node.category],
  });

  // ENFORCE CEILING: if count===0, clamp to 0.60
  const finalConfidence = (node.retrieval_count ?? 0) === 0
    ? Math.min(0.60, confidence)
    : Math.min(1.0, confidence);

  // Write with clamped confidence
  await neo4j.run(cypherUpsert, { ...node, confidence: finalConfidence });
}
```

This ensures that even GUARDIAN provenance (base 0.60) cannot exceed 0.60 on first write. It must be retrieved and used successfully before confidence can grow.

---

## 5. Confidence Dynamics Substrate

### 5.1 ACT-R Implementation in Knowledge Module

The confidence computation formula lives in shared types (E0) as a pure function:

```typescript
// src/shared/types/confidence.types.ts
export function computeConfidence(params: ACTRParams): number {
  const { base, retrievalCount, hoursSinceRetrieval, decayRate } = params;
  const decay = decayRate * Math.log(hoursSinceRetrieval + 1);
  if (retrievalCount === 0) {
    return Math.min(CONFIDENCE_THRESHOLDS.CEILING_UNTESTED, base - decay);
  }
  return Math.min(1.0, base + 0.12 * Math.log(retrievalCount) - decay);
}
```

The Knowledge Module wraps this in service methods that handle retrieval tracking:

```typescript
interface IConfidenceService {
  compute(nodeId: string): Promise<number>;
  recordUse(nodeId: string): Promise<void>;
  checkCeiling(nodeId: string): Promise<boolean>;
}

class ConfidenceService implements IConfidenceService {
  async compute(nodeId: string): Promise<number> {
    const node = await this.wkg.findNode(nodeId);
    if (!node) return 0;

    return computeConfidence({
      base: PROVENANCE_BASE_CONFIDENCE[node.provenance],
      retrievalCount: node.retrieval_count,
      hoursSinceRetrieval: (Date.now() - node.last_retrieved) / (1000 * 3600),
      decayRate: DEFAULT_DECAY_RATES[node.category],
    });
  }

  async recordUse(nodeId: string): Promise<void> {
    const node = await this.wkg.findNode(nodeId);
    if (!node) return;

    // Increment retrieval count and update last_retrieved timestamp
    await this.wkg.updateProperties(nodeId, {
      retrieval_count: (node.retrieval_count ?? 0) + 1,
      last_retrieved: Date.now(),
    });
  }

  async checkCeiling(nodeId: string): Promise<boolean> {
    const confidence = await this.compute(nodeId);
    const node = await this.wkg.findNode(nodeId);

    // Below ceiling if: untested AND confidence < 0.60
    return (node.retrieval_count ?? 0) === 0 && confidence < 0.60;
  }
}
```

### 5.2 Retrieval vs. Mere Existence

The CANON distinguishes retrieval from existence:
- **Existence:** Node is in the graph
- **Retrieval:** Node was queried and returned in a result set
- **Retrieval-and-use:** Node was retrieved AND used to influence a decision or action

Only retrieval-and-use increments `retrieval_count`. Mere existence in the graph does not.

**Consequence:** A node can sit in the WKG for weeks at base confidence and never develop confidence if it's never actually used.

**Implementation pattern:**

```typescript
// Decision Making queries the WKG and gets action candidates
const candidates = await wkg.queryActionsByCategory('communicate');

// For each candidate actually used:
for (const used of candidates.filter(c => selectedAction === c.id)) {
  await confidence.recordUse(used.id);  // Increment retrieval_count
}
```

---

## 6. Known Risks and Mitigations

### 6.1 Hallucinated Knowledge (MEDIUM RISK)

**Risk:** LLM generates plausible but false edges during Learning. Positive feedback amplifies them.

**Mitigation:**
- LLM_GENERATED provenance starts at 0.35 (lower than GUARDIAN at 0.60)
- Ceiling enforcement: cannot exceed 0.60 without retrieval-and-use
- Contradiction detection in Learning subsystem (Epic 7) flags conflicts
- Guardian correction has 3x weight multiplier

**E1 enabler:** Provenance tagging is structural; LLM_GENERATED nodes are flagged for review.

### 6.2 KG Isolation Breach (HIGH RISK)

**Risk:** Grafeo doesn't exist or doesn't support complete isolation. Self KG data leaks into Other KG.

**Mitigation:**
- **Validation phase (pre-E1):** Confirm Grafeo meets five requirements
- **Fallback option:** SQLite with separate files per KG
- **Test coverage:** E1 must include query-time isolation tests
- **Monitoring:** Track any cross-KG edge creation and fail loudly

**E1 requirement:** Cannot proceed without resolving this risk.

### 6.3 Provenance Loss (MEDIUM RISK)

**Risk:** Developer forgets provenance parameter. Node gets written without provenance metadata.

**Mitigation:**
- Interface requires provenance (not optional)
- Upsert throws if provenance is missing
- Neo4j constraint on existence of `provenance` property (if supported)
- Code review: every `upsertNode()` call includes provenance parameter
- Test: attempt to upsert without provenance, expect exception

**E1 requirement:** Enforce at interface and implementation layer.

### 6.4 Index Thrashing (LOW RISK)

**Risk:** Too many indexes on high-cardinality properties (e.g., confidence, created_at) causes write slowdown.

**Mitigation:**
- Start with minimal indexes (confidence, provenance, label)
- Profile queries in dev; add indexes based on query plans
- Monitor index size relative to database size
- Set index rebuild schedules (Neo4j default: background jobs)

**E1 decision:** Which 5-10 indexes are built on init.

### 6.5 Schema Evolution (MEDIUM RISK)

**Risk:** As the system learns, new node types or properties emerge. Current schema becomes outdated.

**Mitigation:**
- **Meta-schema layer:** Rules for TBox evolution are explicitly modeled
- **Additive schema:** New properties and edge types can be added without constraint changes
- **Constraint hygiene:** Constraints are only on high-confidence identifiers (label + id)
- **Versioning:** Each node carries `schema_version` for tracking which schema version created it

**E1 decision:** How to handle schema migrations across sessions/phases.

---

## 7. Integration with Other E1 Components

### 7.1 Neo4j + TimescaleDB

**Data flow:**
- Decision Making → TimescaleDB (prediction events, drive snapshots)
- Learning → TimescaleDB (learnable events marked as processed)
- Learning → Neo4j WKG (consolidate events into graph)
- All subsystems → Neo4j (read WKG for context)

**E1 coordination:** Neo4j schema init must complete before Events Module connects to TimescaleDB.

### 7.2 Neo4j + PostgreSQL

**Data flow:**
- Drive Engine → PostgreSQL (rule lookups, read-only)
- Drive Engine → PostgreSQL (proposed rules, write to queue only)
- Neo4j → PostgreSQL (some schema definitions could reference Postgres rules, but avoid this if possible)

**E1 coordination:** PostgreSQL schema (drive_rules table) must exist before Drive Engine spins up. Neo4j is independent.

### 7.3 Grafeo + TimescaleDB

**Data flow:**
- Learning → Grafeo (consolidate self-concepts into Self KG)
- Communication → Grafeo (update person models in Other KG)
- All subsystems → Grafeo (read for context, infrequent vs. WKG)

**E1 coordination:** Grafeo initialization must handle connection pooling and instance creation.

---

## 8. Verification Checklist for E1

Before moving to E2, verify:

- [ ] Grafeo technology decision made and documented
- [ ] Neo4j constraints applied on init (`CREATE CONSTRAINT ... IF NOT EXISTS`)
- [ ] Neo4j indexes applied on init (`CREATE INDEX ... IF NOT EXISTS`)
- [ ] All provenance properties (provenance, created_at, confidence, retrieval_count, last_retrieved) present on all node/edge writes
- [ ] Confidence ceiling enforcement tested (untested node cannot exceed 0.60)
- [ ] Self KG and Other KG isolation tests pass (cross-KG queries return empty)
- [ ] ACT-R confidence computation matches formula from CANON
- [ ] ProvenanceRequiredException thrown when provenance is missing
- [ ] Neo4j health check responds via driver
- [ ] Neo4j schema graph queryable via Cypher (spot-check: `MATCH (n) RETURN count(n)`)
- [ ] All three-level schema nodes exist (MetaSchema, Schema root nodes)
- [ ] Docker Compose integrates Neo4j with proper volumes and health checks
- [ ] `npx tsc --noEmit` passes (types compile)
- [ ] No circular dependencies between Knowledge Module and other modules

---

## 9. Session Log (This Analysis)

**What:** Knowledge graph architecture analysis for Epic 1 database infrastructure.

**Key Decisions:**
1. **Grafeo validation blocked E1 start** -- cannot implement without knowing which embedded graph DB to use
2. **Three-level schema enforced at Neo4j constraints and application layer** -- metadata is structural, not optional
3. **Provenance required at interface level** -- missing provenance throws immediately
4. **KG isolation is structural guarantee** -- separate Grafeo instances or SQLite files, not logical separation
5. **Confidence ceiling enforced in upsert** -- prevents hallucinated knowledge from bootstrapping

**Gotchas for Next Session:**
- Neo4j Community Edition may not support property existence constraints; enforce at application layer
- Grafeo technology decision is **critical blocker** -- cannot proceed without resolution
- Schema migrations are not covered here; expect E3+ to revisit
- Index performance is TBD; profile queries in dev environment
- ACT-R confidence decay rates are defaults; may need tuning based on observation

---

## References

- CANON: `wiki/CANON.md`
- Roadmap: `wiki/phase-1/roadmap.md`
- Epic 0 Atlas: `wiki/phase-1/epic-0/agent-analyses/atlas.md`
- Confidence types: `src/shared/types/confidence.types.ts` (from E0)
- Provenance types: `src/shared/types/provenance.types.ts` (from E0)
