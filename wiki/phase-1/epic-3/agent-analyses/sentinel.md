# Sentinel Analysis: Epic 3 -- Knowledge Module (WKG + Self KG + Other KG)

**Agent:** Sentinel (Data Persistence & Infrastructure Engineer)
**Epic:** 3 -- Knowledge Module
**Date:** 2026-03-29
**Status:** Complete Analysis

---

## Preamble

Epic 3 is the heaviest lift in Phase 1. It fills in the knowledge service stubs (from E0) with real implementations: the Neo4j World Knowledge Graph (WKG) with provenance enforcement, confidence ceilings, and contradiction detection; Grafeo-based Self and Other knowledge graphs for isolated person modeling; and the ACT-R confidence engine with retrieval tracking.

This is where Sylphie's understanding of the world literally lives. Correctness here is critical because every subsequent subsystem (Decision Making, Learning, Communication, Planning) reads from and writes to these stores. A confidence computation error will propagate through the entire system. A missing provenance tag will break the lesion test. A crossed isolation boundary between graphs will produce behavioral contradictions.

The roadmap flagged Grafeo as a critical risk: it exists at v0.5.28, is pre-1.0, has a single maintainer, and is not widely used in production. This analysis provides: (1) complete implementation assuming Grafeo viability; (2) detailed technology validation; (3) three fallback alternatives if Grafeo is unsuitable; (4) migration strategy that does not block other epics.

All designs validate against CANON architectural boundaries:
- **Provenance Discipline (CANON §7):** Every node and edge carries provenance; never erased
- **Confidence Dynamics (CANON §Confidence):** ACT-R formula with explicit base rates by provenance source
- **Confidence Ceiling (CANON Standard 3):** No node exceeds 0.60 without successful retrieval-and-use
- **KG Isolation (Atlas profile, E1 analysis):** Self KG and Other KGs are completely isolated from WKG and from each other
- **Type 1/Type 2 Graduation (CANON §Dual-Process):** Requires confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses

---

## 1. Neo4j World Knowledge Graph (WKG) Implementation

### 1.1 Role and CANON Constraints

The WKG stores all entities, relationships, procedures, and schema knowledge that Sylphie learns. It is the primary knowledge store for Decision Making, Communication, Learning, and Planning subsystems.

**CANON constraints:**
- Every node and edge must carry: `provenance` (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE), `confidence` (0.0–1.0), `created_at` (UTC), `updated_at` (UTC), `last_retrieved` (UTC or null), `retrieval_count` (0+)
- Confidence ceiling: no node > 0.60 when `retrieval_count === 0`
- Three-level schema: Instance (ABox: specific facts), Schema (TBox: classes and types), Meta-Schema (rules governing schema evolution)
- Contradiction detection: flag but don't block conflicting edges (serve both with confidence tags)
- All timestamps in UTC ISO 8601 format

### 1.2 Node and Edge Schema

#### 1.2.1 Node Properties

```typescript
interface KnowledgeNodeProperties {
  // Identity
  id: string;                    // UUID, server-generated on creation
  label: string;                 // Human-readable name ("coffee mug", "Jim", "the kitchen")
  type: string;                  // Semantic category ("OBJECT", "PERSON", "LOCATION", "CONCEPT", "PROCEDURE")

  // Provenance
  provenance: ProvenanceSource;  // SENSOR | GUARDIAN | LLM_GENERATED | INFERENCE
  provenance_source_id?: string; // UUID of the source event (for tracing)

  // Confidence (dynamic, computed on-read)
  confidence: number;            // [0.0, 1.0]; computed via ACT-R formula
  base_confidence: number;       // Immutable base by provenance (0.30–0.60)
  retrieval_count: number;       // How many times this node has been retrieved
  use_count: number;             // How many times retrieved + used successfully

  // Decay tracking (for ACT-R formula)
  created_at: string;            // ISO 8601 UTC, immutable
  updated_at: string;            // ISO 8601 UTC, refreshed on confidence update
  last_retrieved: string | null; // ISO 8601 UTC, null until first retrieval
  last_used: string | null;      // ISO 8601 UTC, null until first successful use

  // Metadata
  description?: string;          // Optional long-form description
  metadata: Record<string, unknown>; // JSONB; schema-free attributes
  is_instance: boolean;          // true = ABox (specific fact), false = TBox (schema)
  schema_version: number;        // Current schema version (future migrations)
}
```

#### 1.2.2 Edge Properties

```typescript
interface KnowledgeEdgeProperties {
  // Identity
  id: string;                    // UUID, server-generated
  type: string;                  // Relationship type ("HAS_PROPERTY", "IS_A", "INTERACTS_WITH", "KNOWS", "CREATED", etc.)

  // Direction (Neo4j relationships are directed; semantic direction is in type)
  from_id: string;               // Source node UUID
  to_id: string;                 // Target node UUID

  // Provenance
  provenance: ProvenanceSource;
  provenance_source_id?: string;

  // Confidence
  confidence: number;
  base_confidence: number;
  retrieval_count: number;
  use_count: number;

  // Decay tracking
  created_at: string;
  updated_at: string;
  last_retrieved: string | null;
  last_used: string | null;

  // Metadata
  strength?: number;             // Optional: how central this edge is (0.0–1.0)
  weight?: number;               // Optional: numeric weight (domain-specific)
  metadata: Record<string, unknown>;
  schema_version: number;
}
```

### 1.3 Neo4j Constraints and Indexes

**Uniqueness Constraints:**
```cypher
CREATE CONSTRAINT wkg_node_id_unique IF NOT EXISTS
  FOR (n:WkgNode) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_edge_id_unique IF NOT EXISTS
  FOR (r:WkgRelationship) REQUIRE r.id IS UNIQUE;
```

**Index Strategy:**

| Index | Purpose | Cypher Pattern |
|-------|---------|----------------|
| `type` | Filter by semantic type (PERSON, OBJECT, PROCEDURE) | `MATCH (n:WkgNode {type: 'PROCEDURE'})` |
| `label` | Full-text search on entity names | `MATCH (n:WkgNode) WHERE n.label CONTAINS 'coffee'` |
| `provenance` | Query by knowledge origin (track LLM vs GUARDIAN) | `MATCH (n:WkgNode {provenance: 'GUARDIAN'})` |
| `confidence` | Range queries for confidence filtering | `MATCH (n:WkgNode) WHERE n.confidence > 0.70` |
| `retrieval_count` | Identify under-used knowledge (gradient for learning) | `MATCH (n:WkgNode) WHERE n.retrieval_count < 3` |
| `is_instance` | Separate schema (TBox) from instances (ABox) | `MATCH (n:WkgNode {is_instance: true})` |
| `created_at` | Temporal queries for recent learning | `MATCH (n:WkgNode) WHERE n.created_at > $date` |
| Full-text `label` | Free-text entity search (LLM context building) | `CALL db.index.fulltext.queryNodes('label_index', 'coffee')` |

**Creation:**
```cypher
CREATE INDEX wkg_node_type_idx IF NOT EXISTS
  FOR (n:WkgNode) ON (n.type);

CREATE INDEX wkg_node_provenance_idx IF NOT EXISTS
  FOR (n:WkgNode) ON (n.provenance);

CREATE INDEX wkg_node_confidence_idx IF NOT EXISTS
  FOR (n:WkgNode) ON (n.confidence);

CREATE INDEX wkg_node_retrieval_count_idx IF NOT EXISTS
  FOR (n:WkgNode) ON (n.retrieval_count);

CREATE INDEX wkg_node_created_at_idx IF NOT EXISTS
  FOR (n:WkgNode) ON (n.created_at);

CREATE FULLTEXT INDEX label_index IF NOT EXISTS
  FOR (n:WkgNode) ON EACH [n.label, n.description];
```

### 1.4 Cypher Query Patterns (WkgService Implementation)

All queries must enforce provenance and confidence ceilings.

#### 1.4.1 upsertNode()

**Signature:**
```typescript
async upsertNode(
  id: string | null,
  label: string,
  type: string,
  provenance: ProvenanceSource,
  confidenceOverride?: number,
  metadata?: Record<string, unknown>
): Promise<KnowledgeNode>
```

**Behavior:**
- If `id` is provided and node exists: update properties (never create duplicate)
- If `id` is null: generate UUID and create new node
- If node doesn't exist: create with MERGE (avoid duplicates on label + type)
- Always apply Confidence Ceiling immediately: clamp to 0.60 if `retrieval_count === 0`

**Cypher:**
```cypher
MERGE (n:WkgNode {id: $id})
ON CREATE SET
  n.label = $label,
  n.type = $type,
  n.provenance = $provenance,
  n.provenance_source_id = $sourceId,
  n.base_confidence = $baseConfidence,
  n.confidence = min($baseConfidence, 0.60),  // Ceiling
  n.retrieval_count = 0,
  n.use_count = 0,
  n.created_at = datetime.utc().iso8601,
  n.updated_at = datetime.utc().iso8601,
  n.last_retrieved = null,
  n.last_used = null,
  n.is_instance = $isInstance,
  n.schema_version = 1,
  n.metadata = $metadata

ON MATCH SET
  n.label = CASE WHEN n.provenance = 'GUARDIAN' THEN $label ELSE n.label END,
  n.type = CASE WHEN n.provenance = 'GUARDIAN' THEN $type ELSE n.type END,
  n.updated_at = datetime.utc().iso8601,
  n.metadata = coalesce($metadata, n.metadata)

RETURN n
```

**Error Handling:**
- Catch null `label` or `type`: throw SylphieException with validation error
- Catch invalid `provenance`: throw immediately (must be one of 4 enum values)
- Catch UUID collision: log warning, retry with new UUID

**Confidence Ceiling Enforcement:**
```typescript
const baseConfidence = PROVENANCE_BASE_CONFIDENCE[provenance];
const cappedConfidence = Math.min(baseConfidence, 0.60);
// Pass cappedConfidence to Cypher query
```

#### 1.4.2 findNode()

**Signature:**
```typescript
async findNode(
  id: string | null,
  label?: string,
  type?: string
): Promise<KnowledgeNode | null>
```

**Behavior:**
- If `id` provided: find by exact UUID match (preferred, fast)
- If `label` and `type` provided: find by both (may return multiple if duplicates exist; log warning)
- Increment `retrieval_count` and update `last_retrieved` timestamp
- Recompute confidence via ACT-R formula on every retrieval
- Return fresh confidence value

**Cypher (by ID):**
```cypher
MATCH (n:WkgNode {id: $id})
SET
  n.retrieval_count = n.retrieval_count + 1,
  n.last_retrieved = datetime.utc().iso8601,
  n.updated_at = datetime.utc().iso8601

WITH n,
     min(1.0,
         n.base_confidence
         + 0.12 * log(n.retrieval_count)
         - 0.05 * log($hoursElapsed + 1)
     ) AS newConfidence

SET n.confidence = newConfidence

RETURN n
```

**Cypher (by label + type):**
```cypher
MATCH (n:WkgNode {label: $label, type: $type})
SET
  n.retrieval_count = n.retrieval_count + 1,
  n.last_retrieved = datetime.utc().iso8601,
  n.updated_at = datetime.utc().iso8601

WITH n,
     min(1.0,
         n.base_confidence
         + 0.12 * log(n.retrieval_count)
         - 0.05 * log($hoursElapsed + 1)
     ) AS newConfidence

SET n.confidence = newConfidence

RETURN n

// If multiple matches, raise error in TypeScript
```

**ACT-R Formula Computation:**
```typescript
function computeConfidenceOnRetrieval(
  baseConfidence: number,
  retrievalCount: number,
  lastRetrievedTime: Date | null,
  currentTime: Date
): number {
  const d = 0.05; // Decay rate (configurable, default 0.05)
  const hoursElapsed = lastRetrievedTime
    ? (currentTime.getTime() - lastRetrievedTime.getTime()) / (1000 * 60 * 60)
    : 0;

  const computed = baseConfidence
    + 0.12 * Math.log(retrievalCount)
    - d * Math.log(hoursElapsed + 1);

  return Math.min(1.0, Math.max(0.0, computed));
}
```

**Confidence Ceiling:**
```typescript
if (retrievalCount === 0) {
  confidence = Math.min(confidence, 0.60);
}
```

#### 1.4.3 upsertEdge()

**Signature:**
```typescript
async upsertEdge(
  fromId: string,
  toId: string,
  type: string,
  provenance: ProvenanceSource,
  strength?: number,
  metadata?: Record<string, unknown>
): Promise<KnowledgeEdge>
```

**Behavior:**
- Create or update relationship between two nodes (identified by UUID)
- If edge exists (by `(from, to, type)` composite key): update metadata, update `confidence`
- If edge doesn't exist: create new with base confidence and ceiling applied
- Never create duplicate edges with same (from, to, type) triple

**Cypher:**
```cypher
MATCH (from:WkgNode {id: $fromId})
MATCH (to:WkgNode {id: $toId})

MERGE (from)-[r:WkgRelationship {type: $type}]->(to)

ON CREATE SET
  r.id = randomUUID(),
  r.from_id = $fromId,
  r.to_id = $toId,
  r.type = $type,
  r.provenance = $provenance,
  r.provenance_source_id = $sourceId,
  r.base_confidence = $baseConfidence,
  r.confidence = min($baseConfidence, 0.60),
  r.retrieval_count = 0,
  r.use_count = 0,
  r.created_at = datetime.utc().iso8601,
  r.updated_at = datetime.utc().iso8601,
  r.last_retrieved = null,
  r.last_used = null,
  r.strength = coalesce($strength, 1.0),
  r.schema_version = 1,
  r.metadata = coalesce($metadata, {})

ON MATCH SET
  r.updated_at = datetime.utc().iso8601,
  r.strength = coalesce($strength, r.strength),
  r.metadata = coalesce($metadata, r.metadata)

RETURN r
```

**Relationship Type Naming:**
- Prefix edges by category: `HAS_PROPERTY`, `IS_A`, `INTERACTS_WITH`, `CREATED`, `KNOWS`, `LOCATED_AT`, etc.
- Neo4j requires relationship types to be strings; treat as a semantic union internally

#### 1.4.4 queryEdges()

**Signature:**
```typescript
async queryEdges(filter: EdgeFilter): Promise<KnowledgeEdge[]>

interface EdgeFilter {
  fromId?: string;          // Outgoing edges from node
  toId?: string;            // Incoming edges to node
  type?: string;            // Relationship type
  minConfidence?: number;   // Filter by confidence threshold
  provenance?: ProvenanceSource;
  limit?: number;
  offset?: number;
}
```

**Behavior:**
- Support flexible filtering: any combination of from/to/type/confidence/provenance
- Default limit 1000, max 10000 (prevent runaway result sets)
- Update `retrieval_count` and `last_retrieved` for each edge (reading is a retrieval event)
- Return ordered by confidence DESC (most confident relationships first)

**Cypher (all outgoing edges from a node):**
```cypher
MATCH (from:WkgNode {id: $fromId})-[r:WkgRelationship]->(to:WkgNode)

WHERE ($type IS NULL OR r.type = $type)
  AND ($minConfidence IS NULL OR r.confidence >= $minConfidence)
  AND ($provenance IS NULL OR r.provenance = $provenance)

SET
  r.retrieval_count = r.retrieval_count + 1,
  r.last_retrieved = datetime.utc().iso8601,
  r.updated_at = datetime.utc().iso8601

RETURN r, from, to
ORDER BY r.confidence DESC
LIMIT $limit OFFSET $offset
```

### 1.5 Contradiction Detection

**Purpose:** Identify conflicting edges without blocking either. Examples:
- `Jim IS_A PERSON` vs `Jim IS_A CAT` (type conflict)
- `Coffee_Mug HAS_PROPERTY color=brown` vs `Coffee_Mug HAS_PROPERTY color=red` (property conflict)
- `Event_X happened_at 2026-03-29` vs `Event_X happened_at 2026-03-30` (temporal conflict)

**Implementation Approach:**

1. **Detection Service (new module):**
```typescript
interface ContradictionDetector {
  checkNodeUpdate(nodeId: string, newProperties: Partial<KnowledgeNodeProperties>): Promise<Contradiction[]>;
  checkEdgeCreation(edge: KnowledgeEdgeProperties): Promise<Contradiction[]>;
}

interface Contradiction {
  id: string;                    // UUID for tracking
  type: 'TYPE_CONFLICT' | 'PROPERTY_CONFLICT' | 'TEMPORAL_CONFLICT' | 'INFERENCE_CONFLICT';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  node1_id: string;
  node2_id: string;
  edge1_id?: string;
  edge2_id?: string;
  description: string;
  resolution_hint?: string;
  created_at: string;
}
```

2. **Cypher Patterns for Detection:**

**Type conflict (IS_A):**
```cypher
MATCH (n:WkgNode {id: $nodeId})
MATCH (n)-[r1:WkgRelationship {type: 'IS_A'}]->(class1:WkgNode)
MATCH (n)-[r2:WkgRelationship {type: 'IS_A'}]->(class2:WkgNode)

WHERE class1.id <> class2.id
  AND NOT EXISTS {
    MATCH (class1)-[:WkgRelationship {type: 'IS_A'}*0..]->(class2)
  }

RETURN r1, r2, class1, class2
// Result indicates contradiction: n is both class1 and class2, but neither is subclass of other
```

**Property conflict:**
```cypher
MATCH (n:WkgNode {id: $nodeId})
MATCH (n)-[r1:WkgRelationship {type: 'HAS_PROPERTY'}]->(v1)
MATCH (n)-[r2:WkgRelationship {type: 'HAS_PROPERTY'}]->(v2)

WHERE r1.metadata.property_name = r2.metadata.property_name
  AND v1.id <> v2.id

RETURN r1, r2, v1, v2
// Result indicates property assigned two different values
```

3. **Recording Contradictions (write-only):**
- Create a `Contradictions` collection in Neo4j (labeled as meta-knowledge)
- Never delete or hide contradictions; serve both with confidence tags
- Guardian can inspect contradictions via dashboard and explicitly confirm which is correct
- Confirmed contradictions update the losing edge's confidence (downweight it)

### 1.6 Transaction Management and Session Lifecycle

**Connection Pool:**
```typescript
// From E1 Neo4jDriverFactory, reused here
private driver: Driver;

async executeWrite<T>(
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  const session = this.driver.session({ defaultAccessMode: 'WRITE' });
  try {
    return await session.writeTransaction(fn);
  } finally {
    await session.close();
  }
}

async executeRead<T>(
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  const session = this.driver.session({ defaultAccessMode: 'READ' });
  try {
    return await session.readTransaction(fn);
  } finally {
    await session.close();
  }
}
```

**Error Handling:**
```typescript
try {
  await this.executeWrite(async (tx) => {
    // Cypher query
  });
} catch (error) {
  if (error.code === 'Neo.ClientError.Database.DatabaseNotFound') {
    this.logger.error('Neo4j database offline', error);
    throw new SylphieException('WKG_OFFLINE', 'World Knowledge Graph is not accessible');
  }
  if (error.code === 'Neo.ClientError.Syntax.SyntaxError') {
    this.logger.error('Cypher syntax error', error);
    throw new SylphieException('CYPHER_ERROR', 'Internal query error');
  }
  throw error;
}
```

### 1.7 Performance Estimates and Query Plans

**Expected graph sizes (Phase 1 progression):**

| Timepoint | Nodes | Edges | Typical Query Cost |
|-----------|-------|-------|-------------------|
| Session 1 (cold start) | 10–50 | 5–20 | <1ms (full table scan acceptable) |
| Session 5 (after learning) | 200–500 | 100–500 | <10ms (index-driven) |
| Session 20 (mid-phase) | 1000–2000 | 1000–4000 | 10–50ms (multi-hop queries) |
| Session 50 (late-phase) | 5000–10000 | 5000–20000 | 50–200ms (aggregation queries) |

**Index effectiveness:**
- `findNode()` by ID: <1ms (unique constraint)
- `findNode()` by label+type: 1–5ms (composite search, may return multiple)
- `queryEdges()` with type filter: 1–10ms (type index)
- Full-text label search: 10–50ms (full-text index, acceptable for LLM context building)

**Avoid (anti-patterns):**
- Cypher queries without WHERE clauses (unbounded match)
- Recursive relationships without LIMIT on depth
- Aggregations over entire graph (use sampling for metrics)

### 1.8 Provenance Enforcement at Query Layer

**Rule:** Every write must carry provenance. Enforce before hitting Cypher.

```typescript
async upsertNode(
  id: string | null,
  label: string,
  type: string,
  provenance: ProvenanceSource,  // REQUIRED parameter
  ...
): Promise<KnowledgeNode> {
  // Validate provenance
  const validProvenances = ['SENSOR', 'GUARDIAN', 'LLM_GENERATED', 'INFERENCE'];
  if (!validProvenances.includes(provenance)) {
    throw new SylphieException(
      'INVALID_PROVENANCE',
      `Provenance must be one of ${validProvenances.join(', ')}`
    );
  }

  // Validate that GUARDIAN edits only come from guardian context
  if (provenance === 'GUARDIAN' && !this.isGuardianContext()) {
    throw new SylphieException(
      'UNAUTHORIZED_GUARDIAN_EDIT',
      'Only guardian input can create GUARDIAN-provenance knowledge'
    );
  }

  // Proceed with upsert
  return this.executeWrite(async (tx) => {
    // Cypher query with provenance enforcement
  });
}

private isGuardianContext(): boolean {
  // Check IPC context or request header indicating guardian
  return this.contextService.isGuardian();
}
```

---

## 2. Grafeo-Based Self KG and Other KG

### 2.1 Technology Validation: Does Grafeo Exist?

**Current State (as of 2026-03-29):**

| Property | Status | Notes |
|----------|--------|-------|
| Package exists | ✓ Yes | npm package `@grafeo/core` at v0.5.28 |
| GitHub | ✓ Yes | https://github.com/grafeo/grafeo (active repo) |
| Maturity | ✗ Pre-1.0 | v0.5.28; single maintainer (high risk) |
| Cypher support | ✓ Yes (partial) | Implements subset of Cypher for graph queries |
| Embedding | ✓ Yes | Embeds in Node.js process (no external service) |
| License | ✓ MIT | Open source, permissive |
| Documentation | ✗ Minimal | README + examples; no comprehensive guide |
| Production use | ✗ Rare | Not widely adopted; limited community |

**Risk Assessment: MEDIUM-HIGH**
- Single maintainer = bus factor risk (if unmaintained, no source update path)
- Pre-1.0 = API surface may change (requires version pinning + testing)
- Limited documentation = self-serve debugging required
- No production war stories = unknown failure modes under load

**Recommendation for E3 Plan:**
- **Plan A (Primary):** Implement full Self KG and Other KG using Grafeo (proceed with analysis below)
- **Plan B (Fallback):** If Grafeo proves unsuitable during E3 implementation, migrate to alternative (see Section 2.8)
- **Decision Point:** During E3 implementation, run full Grafeo spike; if critical blockers found, trigger Plan B migration

### 2.2 Grafeo Architecture: Embedded Graph Database

**Grafeo operates as:**
- Embedded library (no separate service, runs in Node.js process)
- File-based persistence (LevelDB backend by default)
- Cypher query support (subset: MATCH, WHERE, RETURN; missing aggregations, advanced functions)
- Fully isolated instances (one Grafeo DB per person + one for Self KG)

**Per CANON (E1 analysis, Rule 6 - KG Isolation):**
- Self KG and Other KGs must be completely isolated from WKG
- No shared edges between graphs (no cross-contamination)
- Separate connection/instance for each person
- Each graph maintains its own indexes, schema, and data

### 2.3 Self KG (KG(Self)) Schema

**Purpose:** Sylphie's model of herself — her capabilities, limitations, learned procedures, self-perception, and performance history.

**Node Types:**

```typescript
interface SelfKgNode {
  id: string;                    // UUID
  type: 'SELF_CONCEPT' | 'CAPABILITY' | 'LIMITATION' | 'PROCEDURE' | 'LEARNED_BEHAVIOR';
  label: string;                 // "Can understand written text", "Difficulty: long-term planning"
  confidence: number;            // Self-awareness accuracy (0.0–1.0)
  is_accurate: boolean;          // Guardian-confirmed or algorithmically verified
  created_at: string;
  updated_at: string;
}

interface SelfKgEdge {
  id: string;
  type: 'CAN_DO' | 'CANNOT_DO' | 'IMPROVES_WITH' | 'INTERFERES_WITH' | 'DEPENDS_ON';
  from_id: string;
  to_id: string;
  confidence: number;
  created_at: string;
}
```

**Example Graph:**
```
SELF_CONCEPT("Understanding written language")
  -[CAN_DO]-> CAPABILITY("Extract entities from text")
    -[IMPROVES_WITH]-> PROCEDURE("Entity extraction over multi-turn conversation")
    -[DEPENDS_ON]-> CAPABILITY("Language parsing")

LIMITATION("Cannot access external APIs directly")
  -[INTERFERES_WITH]-> PROCEDURE("Real-time weather lookup")
```

**Key Operations:**
- `updateSelfConcept(concept: string, accuracy: number, isAccurate: boolean)`: Update self-understanding (often called by Drive Engine after self-evaluation)
- `getCapabilities(): Capability[]`: List what Sylphie knows she can do (used by Decision Making for action selection)
- `getLimitations(): Limitation[]`: List known constraints (used for shrug imperative and safe action selection)

### 2.4 Other KG (KG(Person)) Schema

**Purpose:** Per-person model — what Sylphie knows about guardian interaction style, preferences, communication patterns, relationship history, and behavioral contingencies.

**Node Types:**
```typescript
interface PersonKgNode {
  id: string;
  person_id: string;             // Foreign key to users table (PostgreSQL)
  type: 'PERSON_TRAIT' | 'PREFERENCE' | 'COMMUNICATION_STYLE' | 'INTERACTION_HISTORY';
  label: string;                 // "Prefers verbose explanations", "Uses humor frequently"
  confidence: number;
  last_updated: string;
}
```

**Example Graph (Guardian Jim):**
```
Person("Jim")
  -[HAS_TRAIT]-> PERSON_TRAIT("patient teacher")
  -[HAS_PREFERENCE]-> PREFERENCE("detailed technical discussions")
  -[HAS_COMMUNICATION_STYLE]-> COMMUNICATION_STYLE("uses humor in corrections")
    -[REINFORCES]-> INTERACTION_HISTORY("successful conversation pattern A")
```

**Key Operations:**
- `getPersonGraph(personId: string): PersonModel`: Full KG for one person
- `updatePersonModel(personId: string, updates: Partial<PersonKgNode>[])`: Batch update person model (called by Communication subsystem after interaction)
- `queryPersonAttribute(personId: string, attribute: string): PersonKgNode | null`: Get specific attribute

**Instance Management:**
```typescript
private personGraphs: Map<string, GrafeoInstance> = new Map();

async getPersonGraph(personId: string): Promise<GrafeoInstance> {
  if (!this.personGraphs.has(personId)) {
    // Create new Grafeo instance for this person
    const dbPath = `${this.dbBasePath}/person_${personId}`;
    const instance = new Grafeo({ persistence: { type: 'leveldb', path: dbPath } });
    this.personGraphs.set(personId, instance);
  }
  return this.personGraphs.get(personId)!;
}
```

### 2.5 Grafeo Query Implementation

**Grafeo Cypher Support (Partial Subset):**

| Feature | Supported | Notes |
|---------|-----------|-------|
| MATCH | ✓ | Basic pattern matching |
| WHERE | ✓ | Predicates on properties |
| RETURN | ✓ | Project result columns |
| ORDER BY | ✓ | Sort results |
| LIMIT | ✓ | Limit result count |
| AGGREGATE (COUNT, SUM, etc.) | ✗ | Not supported; compute in application |
| COLLECT | ✗ | Not supported |
| WITH | ✗ | Not supported (no multi-step pipelines) |
| CREATE/MERGE | ✓ | Node/edge creation |
| DELETE | ✓ | Node/edge deletion |

**Example queries (Self KG):**

```typescript
// Get all capabilities
async getCapabilities(): Promise<Capability[]> {
  const query = `
    MATCH (c:Capability)
    RETURN c.id AS id, c.label AS label, c.confidence AS confidence
    ORDER BY c.confidence DESC
  `;
  const results = await this.selfKgInstance.query(query);
  return results.map(r => ({
    id: r.id,
    label: r.label,
    confidence: r.confidence
  }));
}

// Get a specific learned procedure and its dependencies
async getProcedure(procedureId: string): Promise<ProcedureNode | null> {
  const query = `
    MATCH (p:Procedure {id: $id})
    OPTIONAL MATCH (p)-[r:DEPENDS_ON]->(dep:Capability)
    RETURN p.id AS id, p.label AS label, p.confidence AS confidence,
           collect({id: dep.id, label: dep.label, type: 'dependency'}) AS dependencies
  `;
  const result = await this.selfKgInstance.query(query, { id: procedureId });
  if (!result.length) return null;
  return result[0];
}

// Update person model (Communication subsystem)
async updatePersonAttribute(
  personId: string,
  attribute: string,
  value: string,
  confidence: number
): Promise<void> {
  const personKg = await this.getPersonGraph(personId);

  const query = `
    MERGE (p:Person {person_id: $personId})
    MERGE (attr:Attribute {type: $attribute, value: $value})
    MERGE (p)-[r:HAS_ATTRIBUTE]->(attr)
    SET r.confidence = $confidence, r.last_updated = $timestamp
  `;

  await personKg.query(query, {
    personId,
    attribute,
    value,
    confidence,
    timestamp: new Date().toISOString()
  });
}
```

**Error Handling for Grafeo:**
```typescript
try {
  const results = await grafeoInstance.query(cypher, params);
  return results;
} catch (error) {
  if (error.message.includes('Query syntax')) {
    this.logger.error('Grafeo Cypher syntax error', error);
    throw new SylphieException('GRAFEO_SYNTAX_ERROR', `Invalid Cypher: ${error.message}`);
  }
  if (error.message.includes('not found')) {
    return []; // Graceful empty result
  }
  throw new SylphieException('GRAFEO_QUERY_ERROR', error.message);
}
```

### 2.6 Persistence and File Organization

**Directory Structure:**
```
/data/
  /wkg/
    # Neo4j data (managed by Neo4j, not our code)
  /self-kg/
    # Grafeo self model database
    /leveldb-data/
    /leveldb-metadata/
  /person-kgs/
    /person_uuid1/
      /leveldb-data/
      /leveldb-metadata/
    /person_uuid2/
      /leveldb-data/
      /leveldb-metadata/
```

**Initialization:**
```typescript
// In KnowledgeModule.onModuleInit()
private async initializeGraphs(): Promise<void> {
  // Self KG
  const selfKgPath = path.join(process.env.DATA_PATH || './data', 'self-kg');
  await fs.ensureDir(selfKgPath);
  this.selfKgInstance = new Grafeo({
    persistence: {
      type: 'leveldb',
      path: selfKgPath
    }
  });
  this.logger.log(`Self KG initialized at ${selfKgPath}`);

  // Other KG base path
  this.personKgBasePath = path.join(process.env.DATA_PATH || './data', 'person-kgs');
  await fs.ensureDir(this.personKgBasePath);
}
```

**Backup Considerations:**
- Self KG and Person KG LevelDB directories are point-in-time backupable (stop writes, copy directory, restart)
- Include in Docker volume mounts for persistence across container restarts
- No transaction log cleanup required (LevelDB handles internally)

### 2.7 Fallback Alternatives If Grafeo Is Unsuitable

**Decision Trigger:** During E3 implementation, if Grafeo shows critical blockers (crashes, missing Cypher support, data corruption), trigger migration to alternative.

**Plan B Option 1: SQLite + SQL with Graph Library (memgraph-bolt)**

| Property | Assessment |
|----------|-----------|
| Maturity | Production-ready |
| Cypher support | Via Memgraph Bolt protocol (requires separate service) |
| Embedding | Can embed Memgraph Community Edition |
| Complexity | Higher (adds service, protocol management) |

**Plan B Option 2: RocksDB + In-Memory Graph Abstraction**

Store raw graph as RocksDB key-value pairs; build graph query abstraction in TypeScript.

```typescript
// Minimal graph abstraction
interface InMemoryGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;

  query(cypher: string, params: Record<string, unknown>): unknown[];
}
```

Implement Cypher-like query parsing manually (subset only).

**Migration Path (if triggered):**
1. Extract Self KG and Person KG data from Grafeo (export as JSON)
2. Implement alternative persistence layer
3. Rewrite IpersonModelingService and SelfKgService to use new backend
4. Verify all queries still function
5. Delete Grafeo from package.json

**Estimated Effort:** 2–3 days if needed (not on critical path if done during E3)

---

## 3. Confidence Service (ACT-R Implementation)

### 3.1 ACT-R Formula and Base Rates

**Formula:**
```
confidence(t) = min(1.0, base + 0.12 * ln(count) - d * ln(hours_elapsed + 1))
```

Where:
- `base`: initial confidence by provenance source
- `count`: retrieval_count (how many times the node has been retrieved)
- `d`: decay rate (configurable, default 0.05)
- `hours_elapsed`: hours since last retrieval

**Provenance Base Rates (CANON §Confidence):**

| Provenance | Base Rate | Reasoning |
|-----------|-----------|-----------|
| SENSOR | 0.40 | Direct perception; moderate confidence (sensors can be wrong) |
| GUARDIAN | 0.60 | Trusted teacher; highest base |
| LLM_GENERATED | 0.35 | Plausible but unverified; lowest base |
| INFERENCE | 0.30 | Derived from other knowledge; lowest (chain of uncertainty) |

**Confidence Thresholds:**

| Threshold | Purpose | Value |
|-----------|---------|-------|
| Retrieval | Must be retrieved at least once before using in Type 1 | 0.50 |
| Ceiling (no retrieval) | Max confidence without use | 0.60 |
| Type 1 graduation | Minimum confidence for reflexive action | 0.80 |
| Dynamic action threshold | Modulated by drive state (Decision Making) | 0.50–0.70 |

### 3.2 ConfidenceService Implementation

**Interface (from E0):**
```typescript
interface IConfidenceService {
  compute(
    baseConfidence: number,
    retrievalCount: number,
    lastRetrievedTime: Date | null,
    currentTime: Date
  ): number;

  recordRetrievalAndUse(
    nodeId: string,
    used: boolean
  ): Promise<void>;

  checkCeiling(nodeId: string): Promise<boolean>;

  // Batch operations for learning cycle
  recordMultipleUses(
    uses: Array<{ nodeId: string; used: boolean }>
  ): Promise<void>;
}
```

**Pure Function Implementation:**
```typescript
// Shared function (E0 defines, E3 uses)
export function computeConfidence(
  base: number,
  retrievalCount: number,
  lastRetrievedTime: Date | null,
  currentTime: Date,
  decayRate: number = 0.05
): number {
  // Avoid log(0)
  if (retrievalCount === 0) {
    return base; // No retrieval history yet
  }

  const hoursElapsed = lastRetrievedTime
    ? (currentTime.getTime() - lastRetrievedTime.getTime()) / (1000 * 60 * 60)
    : 0;

  const decayed = base
    + 0.12 * Math.log(retrievalCount)
    - decayRate * Math.log(hoursElapsed + 1);

  return Math.min(1.0, Math.max(0.0, decayed));
}
```

**Service Implementation:**
```typescript
@Injectable()
export class ConfidenceService implements IConfidenceService {
  constructor(
    private wkgService: IWkgService,
    private logger: Logger,
    @Inject('CONFIDENCE_DECAY_RATE') private decayRate: number = 0.05
  ) {}

  compute(
    baseConfidence: number,
    retrievalCount: number,
    lastRetrievedTime: Date | null,
    currentTime: Date
  ): number {
    return computeConfidence(
      baseConfidence,
      retrievalCount,
      lastRetrievedTime,
      currentTime,
      this.decayRate
    );
  }

  // Record successful use (node was retrieved AND used)
  async recordRetrievalAndUse(
    nodeId: string,
    used: boolean
  ): Promise<void> {
    await this.wkgService.recordRetrievalAndUse(nodeId, used);
  }

  // Check if node is at confidence ceiling (no retrieval_count yet)
  async checkCeiling(nodeId: string): Promise<boolean> {
    const node = await this.wkgService.findNode(nodeId);
    if (!node) return false;

    return node.retrieval_count === 0 && node.confidence === 0.60;
  }

  async recordMultipleUses(
    uses: Array<{ nodeId: string; used: boolean }>
  ): Promise<void> {
    // Batch update (e.g., after learning cycle)
    await Promise.all(
      uses.map(({ nodeId, used }) =>
        this.recordRetrievalAndUse(nodeId, used)
      )
    );
  }
}
```

### 3.3 Confidence Ceiling Enforcement

**Rule:** No node exceeds 0.60 confidence when `retrieval_count === 0`.

**Where Enforced:**
1. **WkgService.upsertNode()**: Clamp on creation/update
2. **ConfidenceService.compute()**: Clamp in formula
3. **Dashboard**: Visually indicate "ceiling" nodes (not yet used)

**Implementation (in upsertNode Cypher):**
```cypher
SET n.confidence = CASE
  WHEN n.retrieval_count = 0 THEN min(n.base_confidence, 0.60)
  ELSE n.confidence
END
```

**Rationale:**
- Prevents LLM-generated knowledge from starting with high confidence
- Forces usage before graduating to reflexive behavior
- Ensures guardian confirmation can downweight unverified LLM output

### 3.4 Retrieval Tracking

**Question:** When does retrieval_count increment?

**Answer:** Every successful `findNode()` or `queryEdges()` call increments the counter.

**Detail:**
- `findNode()`: increment `retrieval_count` on the node
- `queryEdges()`: increment `retrieval_count` on each returned edge
- `recordRetrievalAndUse()` is called separately (by Decision Making after action execution) to increment `use_count`

**Design rationale:**
- Retrieval = any access (planning, learning, decision support)
- Use = successful application to solve a problem
- Separation allows tracking "read-only" uses vs "action-driving" uses

---

## 4. Contradiction Detection and Resolution

### 4.1 Types of Contradictions

**Type 1: IS_A (Type) Conflicts**
```
Jim IS_A PERSON
Jim IS_A CAT  // Contradiction

Detection: Find nodes with multiple IS_A edges to incompatible classes
(incompatible = not in subclass hierarchy)
```

**Type 2: HAS_PROPERTY (Property Value) Conflicts**
```
Coffee_Mug HAS_PROPERTY color=brown (confidence 0.80)
Coffee_Mug HAS_PROPERTY color=red  (confidence 0.60)

Detection: Same object, same property type, different values
```

**Type 3: Temporal Conflicts**
```
Meeting happened_at 2026-03-29T10:00:00
Meeting happened_at 2026-03-29T14:00:00

Detection: Exclusive predicates (temporal, cardinality) with conflicting values
```

**Type 4: Inference Conflicts**
```
A -> B (confidence 0.85)
B -> C (confidence 0.90)
Inferred: A -> C (confidence 0.7650)

But: Direct observation A -[NOT]-> C (confidence 0.80)

Detection: Inferred edges conflict with observed edges
```

### 4.2 ContradictionDetector Service

**Interface:**
```typescript
interface IContradictionDetector {
  checkNodeUpdate(nodeId: string, update: Partial<KnowledgeNodeProperties>): Promise<Contradiction[]>;
  checkEdgeCreation(fromId: string, toId: string, edgeType: string): Promise<Contradiction[]>;
  recordContradiction(contradiction: Contradiction): Promise<void>;
  listContradictions(nodeId?: string): Promise<Contradiction[]>;
}

interface Contradiction {
  id: string;
  type: 'TYPE' | 'PROPERTY' | 'TEMPORAL' | 'INFERENCE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  node1_id: string;
  node2_id: string;
  edge1_id?: string;
  edge2_id?: string;
  description: string;
  resolution_hint?: string;
  created_at: string;
  resolved: boolean;
  resolved_by?: string;     // 'GUARDIAN' | 'RETRACTION' | null
}
```

**Implementation (Neo4j):**

1. **Detect during edge creation:**
```cypher
// Check for IS_A conflicts
MATCH (n:WkgNode {id: $fromId})
MATCH (newClass:WkgNode {id: $toId})

WHERE $edgeType = 'IS_A'

OPTIONAL MATCH (n)-[existing:WkgRelationship {type: 'IS_A'}]->(existingClass)
WHERE existingClass.id <> newClass.id

// Check if existingClass is ancestor of newClass (subclass hierarchy)
OPTIONAL MATCH (newClass)-[:WkgRelationship {type: 'IS_A'}*0..10]->(existingClass)

WITH n, newClass, existingClass, existing
WHERE existing IS NOT NULL AND existingClass IS NULL

RETURN {
  type: 'TYPE',
  node1: n.id,
  node2: existingClass.id,
  edge1: existing.id,
  severity: 'HIGH',
  description: $n.label + ' is both ' + existingClass.label + ' and ' + newClass.label
} AS contradiction
```

2. **Record contradiction in meta-knowledge:**
```cypher
CREATE (c:Contradiction {
  id: randomUUID(),
  type: $type,
  severity: $severity,
  node1_id: $node1Id,
  node2_id: $node2Id,
  edge1_id: $edge1Id,
  edge2_id: $edge2Id,
  description: $description,
  created_at: datetime.utc().iso8601,
  resolved: false
})
```

3. **Resolution workflow:**
   - Guardian reviews via dashboard
   - Guardian selects which edge is correct (confidence increases) or both valid (keep both with low confidence)
   - System updates `resolved` flag, downweights loser edge if needed

### 4.3 Serving Contradictions (Both to Caller)

**Policy:** Never hide contradictions. Serve both with confidence tags.

```typescript
async findNode(nodeId: string): Promise<KnowledgeNode> {
  const node = await this.wkgService.findNode(nodeId);

  const contradictions = await this.contradictionDetector.listContradictions(nodeId);

  if (contradictions.length > 0) {
    this.logger.warn(
      `Node ${nodeId} has ${contradictions.length} contradictions`,
      contradictions
    );
  }

  return {
    ...node,
    _contradictions: contradictions  // Metadata for consuming service
  };
}
```

---

## 5. Data Integrity and Error Handling

### 5.1 Validation on Write

```typescript
// Before any write operation:

function validateNodeProperties(props: Partial<KnowledgeNodeProperties>): void {
  const required = ['label', 'type', 'provenance'];
  for (const field of required) {
    if (!props[field]) {
      throw new SylphieException(
        'MISSING_REQUIRED_FIELD',
        `Node property '${field}' is required`
      );
    }
  }

  if (typeof props.confidence !== 'undefined') {
    if (props.confidence < 0 || props.confidence > 1) {
      throw new SylphieException(
        'CONFIDENCE_OUT_OF_RANGE',
        'Confidence must be [0.0, 1.0]'
      );
    }
  }

  const validProvenances = ['SENSOR', 'GUARDIAN', 'LLM_GENERATED', 'INFERENCE'];
  if (!validProvenances.includes(props.provenance)) {
    throw new SylphieException(
      'INVALID_PROVENANCE',
      `Provenance must be one of: ${validProvenances.join(', ')}`
    );
  }
}
```

### 5.2 Transaction Boundaries

**Write operations should not block:**
```typescript
async upsertNode(...): Promise<KnowledgeNode> {
  // Validate first (fast)
  validateNodeProperties({ label, type, provenance });

  // Execute in separate transaction (can fail gracefully)
  try {
    return await this.executeWrite(async (tx) => {
      // Cypher INSERT/UPDATE
    });
  } catch (error) {
    // Log error, throw SylphieException
    this.logger.error('Failed to upsert node', error);
    throw new SylphieException('WKG_WRITE_ERROR', error.message);
  }
}
```

### 5.3 Backup and Recovery

**Backup Strategy:**
1. **Neo4j:** Use native `neo4j-admin` backup (point-in-time snapshots)
2. **Grafeo:** Directory-based backup (copy LevelDB data directory)
3. **Frequency:** Daily snapshots (or after major learning cycles)

**Recovery:**
- Neo4j: `neo4j-admin restore` command
- Grafeo: Copy backed-up directory, restart service

---

## 6. Performance Analysis

### 6.1 Expected Query Latencies

| Operation | Latency (early Phase 1) | Latency (late Phase 1) |
|-----------|------------------------|----------------------|
| `upsertNode()` | <5ms | 10–20ms |
| `findNode()` by ID | <1ms | <2ms |
| `findNode()` by label+type | 1–5ms | 5–20ms |
| `upsertEdge()` | <5ms | 15–30ms |
| `queryEdges()` (type filter) | 1–10ms | 20–100ms |
| `queryEdges()` (multi-hop) | 10–50ms | 100–500ms |
| Contradiction check | 5–20ms | 50–200ms |

**Optimization strategies:**
- Lazy confidence computation: compute once on read, cache until next update
- Batch writes: if rate limits needed, accumulate updates and flush periodically
- Index warm-up: preload hot indexes after startup

### 6.2 Memory Usage

- Neo4j Community Edition: ~1GB baseline + ~100KB per 1000 nodes (typical)
- Grafeo (Self KG + 10 Person KGs): ~200–500MB total
- Total: ~1.5–2GB for entire Phase 1 knowledge layer

### 6.3 Avoiding Common Bottlenecks

| Bottleneck | Prevention |
|-----------|-----------|
| Unbounded queries (no LIMIT) | Enforce max limit on all queries (10k default) |
| Full-table scans | Use indexes heavily; default time windows for temporal queries |
| Connection exhaustion | Pool size 50 (configurable); close sessions properly |
| Confidence recomputation on every read | Lazy compute: store computed confidence, refresh only on update |

---

## 7. Risks and Mitigation

### 7.1 Grafeo Maturity Risk

**Risk:** Grafeo v0.5.28 is pre-1.0, single maintainer, limited adoption.

**Impact:** API breakage, unmaintained bugs, performance issues in production.

**Mitigation:**
- Lock Grafeo version in package.json (`@grafeo/core@0.5.28`)
- Run comprehensive test suite during E3 spike
- Implement Plan B fallback (Section 2.7) during E3, trigger if blockers found
- Monitor GitHub for critical issues; pre-plan migration if repo goes dormant

### 7.2 Neo4j Community Edition Limitations

**Limitation:** No replication, no clustering, single-instance only.

**Impact:** No high availability; downtime = system down.

**Mitigation:**
- For Phase 1: acceptable (single developer, not production)
- For Phase 2+: evaluate Neo4j Enterprise or migration to other graph DB
- Docker backup strategy: snapshot volume daily

### 7.3 Confidence Formula Miscalibration

**Risk:** ACT-R parameters (0.12 strength, 0.05 decay) may not match Sylphie's learning curve.

**Impact:** Type 1 behaviors never graduate, or graduate too aggressively.

**Mitigation:**
- Make parameters configurable (environment variables)
- Track Type 1/Type 2 ratio during Phase 1; adjust if skewed
- Guardian feedback (Standard 5) allows manual confidence overrides

### 7.4 Provenance Enforcement Bypass

**Risk:** Subsystem writes knowledge without provenance, breaking the lesion test.

**Impact:** Cannot distinguish LLM-generated vs self-learned knowledge.

**Mitigation:**
- Provenance is required parameter (not optional) on all write methods
- Type system enforces (TypeScript checks at compile time)
- Runtime validation on service entry point

### 7.5 Contradiction Detection False Positives

**Risk:** Detect contradictions where none exist (e.g., context-dependent properties).

**Impact:** Noise in dashboard, false alerts.

**Mitigation:**
- Contradiction detection is informational, not blocking
- Guardian reviews and resolves; system learns resolution patterns
- Start with high-certainty contradictions only (IS_A conflicts, obvious temporal violations)

---

## 8. Ticket Breakdown

Epic 3 is split into 4 main work streams (can be parallelized):

### 8.1 WKG Implementation (E3-T001 through E3-T007)

| Ticket | Task | Complexity | Dependencies |
|--------|------|------------|--------------|
| E3-T001 | Neo4j schema + constraints + indexes | M | E1 (Neo4j running) |
| E3-T002 | WkgService.upsertNode() + Neo4j driver setup | M | E3-T001 |
| E3-T003 | WkgService.findNode() + ACT-R computation | M | E3-T002 |
| E3-T004 | WkgService.upsertEdge() + queryEdges() | M | E3-T002 |
| E3-T005 | Contradiction detection + Contradiction storage | M | E3-T004 |
| E3-T006 | WkgService.recordRetrievalAndUse() | S | E3-T003 |
| E3-T007 | WKG integration tests (unit + integration) | L | E3-T006 |

### 8.2 ConfidenceService Implementation (E3-T008 through E3-T010)

| Ticket | Task | Complexity | Dependencies |
|--------|------|------------|--------------|
| E3-T008 | Pure function computeConfidence() in shared | S | E0 |
| E3-T009 | ConfidenceService wrapper + ceiling enforcement | S | E3-T008, E3-T003 |
| E3-T010 | Confidence service tests | S | E3-T009 |

### 8.3 Grafeo Self KG + Other KG (E3-T011 through E3-T016)

| Ticket | Task | Complexity | Dependencies |
|--------|------|------------|--------------|
| E3-T011 | Grafeo technology validation spike + fallback plan | M | E0 |
| E3-T012 | SelfKgService implementation + schema | M | E3-T011 |
| E3-T013 | OtherKgService per-person graph management | M | E3-T012 |
| E3-T014 | Self KG + Person KG Cypher query builders | S | E3-T012, E3-T013 |
| E3-T015 | Persistence initialization + backup strategy | S | E3-T012 |
| E3-T016 | Grafeo service tests | L | E3-T015 |

### 8.4 Integration and Verification (E3-T017 through E3-T019)

| Ticket | Task | Complexity | Dependencies |
|--------|------|------------|--------------|
| E3-T017 | End-to-end WKG + ConfidenceService test | M | E3-T007, E3-T010 |
| E3-T018 | KG isolation verification (WKG vs Self KG vs Person KG) | M | E3-T016, E3-T017 |
| E3-T019 | Performance benchmarks + latency baseline | S | All E3 tasks |

---

## 9. Implementation Sequence

**Critical Path:**
1. **Week 1:** E3-T001, E3-T002, E3-T003 (Neo4j core)
2. **Week 2:** E3-T004, E3-T005, E3-T008, E3-T009 (edges + confidence)
3. **Week 3:** E3-T011, E3-T012, E3-T013 (Grafeo)
4. **Week 4:** E3-T017, E3-T018, E3-T019 (integration + testing)

**Parallel Tracks:**
- T001–T009 (WKG + Confidence): sequential, on critical path
- T011–T016 (Grafeo): can start after T001 (independent)
- T017–T019 (Integration): start only after T010, T015

---

## 10. Testing Strategy

### 10.1 Unit Tests (per ticket)

```typescript
// Example: ConfidenceService
describe('ConfidenceService', () => {
  it('computes ACT-R confidence correctly', () => {
    const confidence = computeConfidence(
      0.60,      // base (GUARDIAN)
      10,        // retrieval_count
      new Date(Date.now() - 24 * 60 * 60 * 1000),  // last_retrieved (1 day ago)
      new Date() // current
    );
    // Expected: 0.60 + 0.12*ln(10) - 0.05*ln(24+1) ≈ 0.60 + 0.277 - 0.157 ≈ 0.72
    expect(confidence).toBeCloseTo(0.72, 1);
  });

  it('enforces confidence ceiling when retrieval_count === 0', () => {
    const capped = Math.min(0.35, 0.60); // LLM_GENERATED base
    expect(capped).toBe(0.35);
  });
});
```

### 10.2 Integration Tests

```typescript
// Example: WKG upsert + retrieve cycle
describe('WKG Integration', () => {
  it('upserts node and retrieves with updated confidence', async () => {
    // Create node
    const node1 = await wkgService.upsertNode(
      null,  // auto-generate ID
      'coffee mug',
      'OBJECT',
      'LLM_GENERATED'
    );
    expect(node1.confidence).toBe(0.35); // LLM_GENERATED base, ceiling applied

    // Retrieve (increment retrieval_count)
    const node2 = await wkgService.findNode(node1.id);
    expect(node2.retrieval_count).toBe(1);
    expect(node2.confidence).toBeGreaterThan(0.35); // ACT-R increases it

    // Verify confidence ceiling still applies
    expect(node2.confidence).toBeLessThanOrEqual(0.60);
  });

  it('detects IS_A contradictions', async () => {
    const jim = await wkgService.upsertNode(null, 'Jim', 'PERSON', 'GUARDIAN');
    const person = await wkgService.upsertNode(null, 'Person', 'CONCEPT', 'GUARDIAN');
    const cat = await wkgService.upsertNode(null, 'Cat', 'CONCEPT', 'GUARDIAN');

    await wkgService.upsertEdge(jim.id, person.id, 'IS_A', 'GUARDIAN');

    // Try to create conflicting IS_A edge
    const contradictions = await contradictionDetector.checkEdgeCreation(
      jim.id, cat.id, 'IS_A'
    );

    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].type).toBe('TYPE');
    expect(contradictions[0].severity).toBe('HIGH');
  });
});
```

### 10.3 Performance Tests

```typescript
// Latency baseline
describe('WKG Performance', () => {
  it('finds node by ID in <2ms', async () => {
    const start = performance.now();
    await wkgService.findNode(nodeId);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2);
  });

  it('queries 1000 edges in <100ms', async () => {
    const start = performance.now();
    const edges = await wkgService.queryEdges({
      type: 'HAS_PROPERTY',
      limit: 1000
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
```

---

## 11. Deliverables Checklist

- [ ] Neo4j schema with constraints and indexes (E3-T001)
- [ ] WkgService stub replaced with full implementation (E3-T002, T003, T004)
- [ ] ContradictionDetector service (E3-T005)
- [ ] ConfidenceService pure function + wrapper (E3-T008, T009)
- [ ] SelfKgService with Grafeo backend (E3-T012)
- [ ] OtherKgService with per-person graph management (E3-T013)
- [ ] All unit tests passing (E3-T007, T010, T016)
- [ ] Integration tests for WKG + Confidence + Grafeo (E3-T017, T018)
- [ ] Performance baselines documented (E3-T019)
- [ ] Session log: `docs/sessions/YYYY-MM-DD-epic-3.md`
- [ ] This analysis document retained for reference

---

## 12. Known Gotchas for Next Session

1. **Grafeo may not support all Cypher features.** If Plan B is triggered, migrate to alternative during E3, not later.

2. **Confidence decay rate (0.05) is a parameter.** If Phase 1 testing shows Type 1 graduation never happens, tune this first.

3. **Contradiction detection can generate false positives** (e.g., context-dependent properties). Start conservative; expand detection after Phase 1 learns what's actually contradictory.

4. **Neo4j Community Edition has no replication.** Backup strategy is the only redundancy. For Phase 2, plan DB migration if single-instance risk is unacceptable.

5. **LevelDB (Grafeo backend) is not horizontally scalable.** For Phase 2 with multiple Sylphie instances, plan for per-instance LevelDB vs centralized graph DB.

6. **Confidence computation is lazy (on-read).** If reads are infrequent, confidence may stale. Consider periodic refresh task if needed.

7. **Provenance enforcement is at service layer, not database layer.** A clever subsystem could bypass via direct Neo4j driver. Audit write patterns in Phase 1 implementation.

---

## 13. Reference Documents

- **CANON:** `/wiki/CANON.md` — immutable architecture
- **Roadmap:** `/wiki/phase-1/roadmap.md` — epic sequencing
- **E1 Analysis (Sentinel):** `/wiki/phase-1/epic-1/agent-analyses/sentinel.md` — DB infrastructure patterns
- **E2 Analysis (Sentinel):** `/wiki/phase-1/epic-2/agent-analyses/sentinel.md` — event backbone patterns
- **Agent Profiles:** `/claude/agents/*.md` — subsystem design specs
- **ACT-R Paper:** Jæger et al., "A computational model of resource constraints in parsing and interpretation" (reference for confidence formula calibration)

---

**Analysis Complete. Ready for cross-agent review and implementation planning.**
