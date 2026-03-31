# Atlas Analysis: Epic 3 Knowledge Module (WKG + Self KG + Other KG)

**Agent:** Atlas (Knowledge Graph Architect)
**Epic:** 3 -- Knowledge Module Implementation
**Date:** 2026-03-29
**Status:** Analysis (pre-implementation)
**Scope:** WKG schema realization, Self KG design, Other KG architecture, confidence dynamics, contradiction detection, query interfaces, risk assessment

---

## Executive Summary

Epic 3 transforms the knowledge module from stubs into a fully functional brain for Sylphie: real Neo4j WKG operations with provenance enforcement and confidence ceilings, Grafeo-based Self KG and Other KG implementations, ACT-R confidence dynamics, contradiction detection as a learning catalyst, and query interfaces for subsystems.

This is the single most complex epic in Phase 1. The WKG is the architectural center of gravity — everything reads from it or writes to it. Self KG and Other KG are the foundation for Sylphie's self-awareness and person modeling. The confidence dynamics implement Immutable Standard 3 (the Confidence Ceiling) at the service layer. Contradictions must be developmental catalysts, not errors to suppress.

**Key constraints from CANON:**
- Provenance on every node and edge: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE
- Confidence ceiling: no node > 0.60 without retrieval-and-use (Immutable Standard 3)
- Guardian Asymmetry: confirmations 2x weight, corrections 3x weight
- WKG is three-level: instance, schema, meta-schema
- Three KGs are completely isolated (no shared edges, no cross-contamination)
- Contradictions are Piagetian disequilibrium — flag them, don't hide them
- No self-modification of confidence rules (Immutable Standard 6)

---

## 1. WKG Neo4j Schema Design

### 1.1 Three-Level Architecture in Neo4j

The WKG operates on three levels that must be explicitly represented in the Neo4j schema:

#### Instance Level (ABox)
Individual entities, relationships, and observations:
```
:Entity { id, name, description, confidence, provenance, createdAt, lastRetrievedAt, retrievalCount }
:Concept { id, name, definition, confidence, provenance, createdAt, lastRetrievedAt }
:Procedure { id, name, description, preconditions, effects, confidence, provenance }
:Utterance { id, text, speaker, context, confidence, provenance, timestamp }
:Place { id, name, description, coordinates }
:Temporal { id, type, timestamp, description }
```

Edges at instance level:
```
-[:ON]-> { confidence, provenance, timestamp }
-[:IS_A]-> (to schema node)
-[:HAS_PROPERTY]-> { value, confidence, provenance }
-[:CAN_PRODUCE]-> (Procedure to Utterance)
-[:PREDICTS]-> (Procedure to Outcome)
-[:CONTRADICTS]-> { severity, type, evidence }
```

#### Schema Level (TBox)
Type definitions and relationship categories:
```
:SchemaType {
  id,                    // e.g., "container", "mug"
  name,
  supertype,             // e.g., mug -> container -> object
  properties: [string],  // list of property names
  domain_constraints,
  confidence,            // Schema types have confidence too (learned patterns)
  provenance,            // only GUARDIAN can modify schemas
  createdAt
}

:SchemaRelType {
  id,                    // e.g., "ON", "MADE_OF"
  name,
  domain: string,        // origin node type
  range: string,         // target node type
  properties: [string],
  cardinality,           // one-to-one, one-to-many, many-to-many
  confidence,
  provenance,
  createdAt
}
```

Edges at schema level:
```
-[:SUBCLASS_OF]->       (SchemaType to SchemaType)
-[:HAS_PROPERTY]->      (SchemaType to property definitions)
-[:APPLIES_TO]->        (SchemaRelType to SchemaType pairs)
-[:REFINED_BY]->        (Instance edge to SchemaRelType — tracks evidence)
```

#### Meta-Schema Level
Rules governing TBox evolution:
```
:MetaRule {
  id,
  rule_type,             // "schema_modification", "provenance_requirement", "contradiction_threshold"
  description,
  condition,             // logical condition
  action,                // what happens if true
  enforced_at: "database" | "application", // where enforcement occurs
  confidence,
  provenance: "CANON",   // meta-rules are design-level constraints
  createdAt
}

:MetaSchema {           // root node anchoring all meta rules
  id: "root",
  initialized: boolean,
  lastValidatedAt: timestamp
}
```

Edges at meta-schema level:
```
-[:HAS_RULE]->         (MetaSchema to MetaRule)
-[:GOVERNS]->          (MetaRule to TBox or Instance elements)
```

### 1.2 Node Labels and Property Schema

**Core Node Types:**

```typescript
// Labels applied to nodes
type NodeLabel =
  | 'Entity'           // Physical objects, locations
  | 'Concept'          // Abstract ideas, categories
  | 'Procedure'        // Actions, behaviors, plans
  | 'Utterance'        // Spoken/written content
  | 'Place'            // Locations
  | 'Temporal'         // Time points, durations
  | 'Agent'            // People (Person_Jim, Sylphie)
  | 'SchemaType'       // TBox type definitions
  | 'SchemaRelType'    // TBox relationship definitions
  | 'MetaRule'         // Meta-schema rules
  | 'MetaSchema'       // Root meta node

// Universal properties on all nodes
interface WkgNode {
  id: string;                    // Unique identifier within label
  name?: string;                 // Human-readable name
  description?: string;          // Definition or extended description
  confidence: number;            // [0, 1] ACT-R confidence
  provenance: ProvenanceSource;  // SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE
  createdAt: number;             // Timestamp (milliseconds)
  createdBy: string;             // Who/what created this (subsystem name)
  lastRetrievedAt?: number;      // Last successful retrieval-and-use
  retrievalCount: number;        // Number of retrieval-and-use events
  lastModifiedAt?: number;       // Last update time
  modificationCount: number;     // Total number of updates
  contradictionCount: number;    // Number of contradicting edges
  schemaVersion: number;         // TBox version this instance conforms to
}

// Entity (instance level) specific properties
interface EntityNode extends WkgNode {
  label: 'Entity';
  properties: Record<string, unknown>;  // Dynamic properties
  location?: string;                     // Reference to Place
  temporalContext?: string;              // Reference to Temporal
}

// Procedure (action/behavior) specific properties
interface ProcedureNode extends WkgNode {
  label: 'Procedure';
  preconditions: string[];               // Conditions that must hold
  effects: string[];                     // Expected outcomes
  successRate?: number;                  // Empirically measured success
  executionCount: number;                // Number of times executed
  averageExecutionTime?: number;         // In milliseconds
  expectedCost?: number;                 // Drive cost or latency cost
  tags: string[];                        // Category tags (action_type, drive_relevant, etc.)
}

// Utterance (communication) specific properties
interface UtteranceNode extends WkgNode {
  label: 'Utterance';
  text: string;                          // The actual utterance
  speaker: string;                       // Person_Jim or sylphie
  language: string;                      // ISO 639-1 code
  context: string;                       // Conversational context
  timestamp: number;                     // When it was said
  sentiment?: number;                    // [-1, 1] if available
}

// SchemaType (TBox) specific properties
interface SchemaTypeNode extends WkgNode {
  label: 'SchemaType';
  supertype?: string;                    // ID of parent type
  constraints: Record<string, unknown>;  // Domain constraints
  definitionSource: ProvenanceSource;    // Who defined this type
  isCore: boolean;                       // Part of foundational ontology
}
```

### 1.3 Edge Schema and Provenance

Every edge carries the same provenance metadata as nodes:

```typescript
interface WkgEdge {
  // Neo4j representation
  fromId: string;                    // Source node ID
  toId: string;                      // Target node ID
  type: string;                      // Relationship type

  // Edge properties
  confidence: number;                // [0, 1] confidence in this relationship
  provenance: ProvenanceSource;      // Who/what asserted this
  createdAt: number;
  createdBy: string;
  lastRetrievedAt?: number;
  retrievalCount: number;

  // Semantic properties (type-specific)
  weight?: number;                   // For weighted relationships
  strength?: number;                 // For strength of association
  temporalValidity?: [number, number];  // Valid from/until timestamps
  context?: string;                  // Contextual qualifier

  // Contradiction tracking
  contradictedBy?: string[];         // IDs of contradicting edges
  contradictionSeverity?: number;    // [0, 1] severity of contradiction
}

// Edge types in WKG
type EdgeType =
  // Semantic relationships (instance level)
  | 'IS_A'              // (Entity)-[:IS_A]->(SchemaType)
  | 'HAS_PROPERTY'      // (Entity)-[:HAS_PROPERTY]->(value or Entity)
  | 'ON'                // (Entity)-[:ON]->(Place)
  | 'AT'                // (Entity)-[:AT]->(Temporal)
  | 'RELATES_TO'        // (Entity)-[:RELATES_TO]->(Entity)
  | 'CAUSES'            // (Event)-[:CAUSES]->(Event)
  | 'PART_OF'           // (Entity)-[:PART_OF]->(Entity)
  | 'MADE_OF'           // (Entity)-[:MADE_OF]->(Entity)
  | 'PRODUCED_BY'       // (Entity)-[:PRODUCED_BY]->(Agent)

  // Procedure relationships
  | 'PRECONDITION'      // (Procedure)-[:PRECONDITION]->(Condition)
  | 'EFFECT'            // (Procedure)-[:EFFECT]->(Outcome)
  | 'CAN_PRODUCE'       // (Procedure)-[:CAN_PRODUCE]->(Utterance or Entity)
  | 'PREDICTS'          // (Procedure)-[:PREDICTS]->(Outcome)
  | 'DEPENDS_ON'        // (Procedure)-[:DEPENDS_ON]->(Procedure)

  // Type system
  | 'SUBCLASS_OF'       // (SchemaType)-[:SUBCLASS_OF]->(SchemaType)
  | 'HAS_PROPERTY'      // (SchemaType)-[:HAS_PROPERTY]->(PropertyDef)
  | 'APPLIES_TO'        // (SchemaRelType)-[:APPLIES_TO]->(SchemaType)

  // Contradiction tracking
  | 'CONTRADICTS'       // (Edge)-[:CONTRADICTS]->(Edge)
  | 'REFINES'           // (Instance)-[:REFINES]->(SchemaRelType) — evidence accumulation

  // Meta-schema
  | 'HAS_RULE'          // (MetaSchema)-[:HAS_RULE]->(MetaRule)
  | 'GOVERNS'           // (MetaRule)-[:GOVERNS]->(Node or Edge pattern)
```

### 1.4 Indexes and Constraints

Applied on `onModuleInit()` in KnowledgeModule:

```typescript
// Node uniqueness constraints (prevent duplicate instances)
CREATE CONSTRAINT wkg_entity_id IF NOT EXISTS
  FOR (n:Entity) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_concept_id IF NOT EXISTS
  FOR (n:Concept) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_procedure_id IF NOT EXISTS
  FOR (n:Procedure) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_utterance_id IF NOT EXISTS
  FOR (n:Utterance) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_place_id IF NOT EXISTS
  FOR (n:Place) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_agent_id IF NOT EXISTS
  FOR (n:Agent) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_schema_type_id IF NOT EXISTS
  FOR (n:SchemaType) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT wkg_schema_rel_id IF NOT EXISTS
  FOR (n:SchemaRelType) REQUIRE n.id IS UNIQUE;

// Provenance existence constraint (every node must have provenance)
// Note: Neo4j doesn't support "NOT NULL" on properties directly,
// so this is enforced at application layer in upsertNode()

// Confidence value constraint (must be in [0, 1])
// Application-layer validation in ConfidenceService

// Indexes for common queries
CREATE INDEX wkg_entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name);
CREATE INDEX wkg_entity_confidence IF NOT EXISTS FOR (n:Entity) ON (n.confidence);
CREATE INDEX wkg_procedure_tags IF NOT EXISTS FOR (n:Procedure) ON (n.tags);
CREATE INDEX wkg_utterance_speaker IF NOT EXISTS FOR (n:Utterance) ON (n.speaker);
CREATE INDEX wkg_utterance_timestamp IF NOT EXISTS FOR (n:Utterance) ON (n.timestamp);
CREATE INDEX wkg_node_provenance IF NOT EXISTS FOR (n:WkgNode) ON (n.provenance);
CREATE INDEX wkg_node_created IF NOT EXISTS FOR (n:WkgNode) ON (n.createdAt);
CREATE INDEX wkg_edge_confidence IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON (r.confidence);

// Full-text search index on names and descriptions (for graph queries)
CREATE FULLTEXT INDEX wkg_entity_search IF NOT EXISTS
  FOR (n:Entity) ON EACH [n.name, n.description];

CREATE FULLTEXT INDEX wkg_concept_search IF NOT EXISTS
  FOR (n:Concept) ON EACH [n.name, n.description];
```

### 1.5 Provenance Enforcement Strategy

Provenance is enforced at the service layer (WkgService), not at the database layer. This allows flexible provenance assignment while maintaining audit trail integrity.

**Enforcement points in upsertNode():**

```typescript
// 1. Validate provenance source exists in enum
if (!Object.values(ProvenanceSource).includes(provenance)) {
  throw new InvalidProvenanceError(provenance);
}

// 2. Validate base confidence ceiling for untested knowledge
const baseConfidence = PROVENANCE_BASE_CONFIDENCE[provenance];
if (confidence > baseConfidence && retrievalCount === 0) {
  throw new ConfidenceCeilingViolationError(
    `Confidence ${confidence} exceeds base ${baseConfidence} for untested knowledge`
  );
}

// 3. Enforce GUARDIAN-only schema modifications
if (isSchemaModification && provenance !== ProvenanceSource.GUARDIAN) {
  throw new UnauthorizedSchemaModificationError(
    `Schema modifications require GUARDIAN provenance, got ${provenance}`
  );
}

// 4. Guardian Asymmetry enforcement
// If provenance is GUARDIAN (correction), boost weight by 3x
if (provenance === ProvenanceSource.GUARDIAN && isCorrection) {
  const confidenceDelta = computeGuardianCorrectionWeight(existingConfidence, newConfidence);
  // Apply 3x multiplier to delta
}

// 5. Record in audit trail
recordProvenanceEvent({
  nodeId: id,
  provenance,
  createdBy,
  timestamp,
  previousConfidence: node?.confidence,
  newConfidence: confidence,
  action: 'upsert'
});
```

**Lesion Test Support:**

Provenance tags enable the lesion test: queries can filter by provenance source to determine what Sylphie knows on her own (SENSOR + GUARDIAN + INFERENCE) vs. what the LLM is saying (LLM_GENERATED).

```typescript
// Query for LLM-independent knowledge
const independentKnowledge = await wkgService.queryEdges({
  provenanceFilter: [ProvenanceSource.SENSOR, ProvenanceSource.GUARDIAN, ProvenanceSource.INFERENCE],
  minConfidence: 0.50
});
```

---

## 2. Self KG and Other KG Grafeo Implementation

### 2.1 Self KG Schema (KG(Self))

Sylphie's self-model: what she knows about herself, her capabilities, her limitations, and her history.

**Self KG Node Types:**

```typescript
interface SelfKgSchema {
  // Identity and meta
  SelfNode: {
    id: 'self',
    name: 'Sylphie',
    createdAt: number,
    sessionCount: number,
    totalInteractionTime: number
  },

  // Capabilities and limitations
  Capability: {
    id: string,                    // e.g., 'can_remember', 'can_predict'
    name: string,
    description: string,
    confidenceLevel: number,       // [0, 1] how confident is Sylphie she has this?
    successRate: number,           // Empirical success rate
    usageCount: number,
    lastTestedAt: number,
    provenance: ProvenanceSource
  },

  Limitation: {
    id: string,                    // e.g., 'cannot_see_in_dark', 'cannot_remember_sessions_5_plus'
    name: string,
    description: string,
    discoveredAt: number,
    severity: 'minor' | 'moderate' | 'critical',
    provenance: ProvenanceSource
  },

  // Behavioral patterns
  BeliefAboutSelf: {
    id: string,                    // e.g., 'belief_im_helpful', 'belief_im_forgetful'
    statement: string,
    confidence: number,
    source: 'guardian_feedback' | 'self_observation' | 'prediction_accuracy',
    evidence: string[],            // IDs of supporting observations
    contradiction: boolean,        // Does contradictory evidence exist?
  },

  // Drive state history
  DrivePattern: {
    id: string,
    drive_name: string,            // E.g., 'curiosity', 'guilt'
    pattern_type: string,          // 'baseline', 'trigger', 'resolution'
    description: string,
    frequency: number,             // How often does this occur?
    averageIntensity: number,      // [0, 1]
    observedAt: number[]           // Timestamps of observations
  },

  // Prediction history
  PredictionAccuracy: {
    id: string,
    domain: string,                // What does Sylphie predict about? (spatial, social, temporal)
    successRate: number,           // MAE or accuracy metric
    sampleSize: number,            // Number of predictions
    lastUpdatedAt: number,
    trend: 'improving' | 'stable' | 'declining'
  },

  // Personality/social preferences
  SocialPreference: {
    id: string,
    personId: string,              // Reference to specific person
    preference_type: string,       // 'likes_to', 'avoids', 'neutral_toward'
    description: string,
    confidence: number,
    evidence: string[]
  }
}

// Self KG edge types
type SelfKgEdgeType =
  | 'HAS_CAPABILITY'              // Self -> Capability
  | 'HAS_LIMITATION'              // Self -> Limitation
  | 'BELIEVES'                    // Self -> BeliefAboutSelf
  | 'HAS_DRIVE_PATTERN'           // Self -> DrivePattern
  | 'HAS_PREDICTION_ACCURACY'     // Self -> PredictionAccuracy
  | 'HAS_SOCIAL_PREFERENCE'       // Self -> SocialPreference
  | 'DISCOVERED_BY'               // Limitation -> Capability (discovered through failure of capability)
  | 'CONFLICTS_WITH'              // BeliefAboutSelf -> BeliefAboutSelf
  | 'EVIDENCE_FOR'                // (Any node) -> BeliefAboutSelf
  | 'IMPROVED_SINCE'              // (New version) -> (Old version of capability/pattern)
```

**Self KG Characteristics:**
- Single instance per Sylphie (not per person)
- Initialized with minimal bootstrap nodes (self, empty capabilities list)
- Updated by Drive Engine (self-evaluation), Learning (from consolidation), and Decision Making (from outcomes)
- Small graph: 50-200 nodes typical, < 1MB memory footprint
- Read-heavy: accessed by Drive Engine every tick for self-evaluation
- Confidentiality: Self KG is private, not exposed in communication or logging

### 2.2 Other KG Schema (KG(Other))

Models of other people. One isolated Grafeo instance per personId.

**Other KG Node Types (per person):**

```typescript
interface OtherKgSchema {
  // Identity
  PersonNode: {
    id: string,                    // e.g., 'Person_Jim'
    name: string,
    knownSince: number,            // When did Sylphie first meet this person?
    interactionCount: number,
    lastInteractionAt: number,
    confidenceInModel: number      // How accurate is this model?
  },

  // Observed behaviors
  ObservedPreference: {
    id: string,
    preference_type: string,       // 'likes', 'dislikes', 'neutral'
    subject: string,               // What is the preference about?
    evidence: string[],            // IDs of observations
    confidence: number,
    lastObservedAt: number
  },

  // Inferred mental states
  InferredBeliefAboutPerson: {
    id: string,
    statement: string,             // E.g., 'Jim values honesty'
    confidence: number,
    derivedFrom: string[],         // IDs of observations
    lastUpdatedAt: number
  },

  // Prediction about person
  PredictionAboutPerson: {
    id: string,
    prediction_type: string,       // 'behavioral', 'emotional', 'preference'
    statement: string,
    confidence: number,
    successRate: number,           // Has this prediction been accurate?
    sampleSize: number,
    context: string                // What triggers this prediction?
  },

  // Communication style
  CommunicationPattern: {
    id: string,
    pattern_type: string,          // 'topic_preference', 'response_style', 'interaction_timing'
    description: string,
    examples: string[],            // IDs of utterances exemplifying this
    confidence: number
  },

  // Emotional/drive reactions
  ReactionsToActions: {
    id: string,
    action_description: string,
    typical_reaction: string,
    reactionType: 'positive' | 'negative' | 'neutral',
    confidence: number,
    evidenceCount: number
  }
}

// Other KG edge types
type OtherKgEdgeType =
  | 'HAS_PREFERENCE'               // Person -> ObservedPreference
  | 'BELIEVED_TO'                  // Person -> InferredBeliefAboutPerson
  | 'PREDICTED_BEHAVIOR'           // Person -> PredictionAboutPerson
  | 'COMMUNICATION_PATTERN'        // Person -> CommunicationPattern
  | 'REACTS_TO'                    // Person -> ReactionsToActions
  | 'SIMILAR_TO'                   // Person -> Person (in OtherKG index)
  | 'CONTRASTS_WITH'               // Person -> Person
  | 'EVIDENCE_FOR'                 // (Utterance or observation) -> (InferredBelief or Preference)
```

**Other KG Storage:**

```typescript
// In OtherKgService
private otherKGs: Map<string, GrafeoInstance> = new Map();

getPersonGraph(personId: string): GrafeoInstance {
  if (!this.otherKGs.has(personId)) {
    // Create new isolated Grafeo instance
    const newKg = new Grafeo.Graph();
    this.otherKGs.set(personId, newKg);
  }
  return this.otherKGs.get(personId);
}

// Each person gets completely isolated graph instance
// No edges or vertices can be shared between person graphs
// Querying Person_Jim's graph cannot see Person_Alice's data
```

### 2.3 Isolation Enforcement

**Absolute Isolation Guarantee:**

The three KGs (WKG, Self KG, Other KG) are completely separated:

```typescript
// WkgService (Neo4j)
class WkgService {
  // Never exposes individual Grafeo instances
  // All queries return plain objects, not Grafeo nodes
  async findNode(id: string): Promise<WkgNode> { ... }
}

// SelfKgService (Grafeo)
class SelfKgService {
  private selfKg: Grafeo.Graph;  // Private instance

  // Other modules cannot import or access this instance
  // Only methods exposed in ISelfKgService interface
  async getCurrentModel(): Promise<SelfKgSnapshot> { ... }
}

// OtherKgService (Grafeo)
class OtherKgService {
  private otherKGs: Map<string, Grafeo.Graph>;  // Private collection

  // Cannot pass raw Grafeo instances
  // Returns serialized snapshots only
  async queryPersonModel(personId: string): Promise<PersonModelSnapshot> { ... }
}

// NestJS DI prevents accidental mixing
@Module({
  providers: [
    WkgService,       // Has WKG_SERVICE token
    SelfKgService,    // Has SELF_KG_SERVICE token
    OtherKgService,   // Has OTHER_KG_SERVICE token
  ],
  exports: [WKG_SERVICE, SELF_KG_SERVICE, OTHER_KG_SERVICE]
})
export class KnowledgeModule {}

// Subsystems must ask for specific service
@Injectable()
class DecisionMakingService {
  constructor(
    @Inject(WKG_SERVICE) wkg: IWkgService,
    @Inject(SELF_KG_SERVICE) selfKg: ISelfKgService,
    @Inject(OTHER_KG_SERVICE) otherKg: IOtherKgService
  ) {}
}

// Cross-graph queries are forbidden by type system
// wkg.findNode() returns WkgNode, not Grafeo node
// selfKg.getCurrentModel() returns immutable snapshot
// otherKg.queryPersonModel() returns immutable snapshot
```

**Serialization Barrier:**

Data flows between KGs only through immutable snapshots:

```typescript
// Self KG → WKG (Learning consolidation)
const selfSnapshot = await selfKg.getCurrentModel();
// selfSnapshot is { beliefs: [...], capabilities: [...] } (plain object)
// NOT a Grafeo graph instance

// Write consolidated self-knowledge to WKG
await wkg.upsertNode({
  label: 'Concept',
  id: 'self_capability_memory',
  name: 'Can remember conversations',
  confidence: selfSnapshot.capabilities['memory'].confidenceLevel,
  provenance: ProvenanceSource.INFERENCE
});

// Other KG → Communication (Person modeling)
const jimSnapshot = await otherKg.queryPersonModel('Person_Jim');
// jimSnapshot is { preferences: [...], beliefs: [...] }
// NOT a Grafeo graph instance

// Use person model in response generation
const response = await llm.generateResponse({
  userInput: message,
  personModel: jimSnapshot,  // Immutable snapshot only
  driveState
});
```

### 2.4 Grafeo Risk Assessment

**Grafeo Status Verification (from E1 Atlas analysis):**

Assuming Grafeo passed validation in E1 (Cypher support, isolation guarantee, performance), the implementation plan for E3 is:

**If Grafeo is confirmed working:**
- Proceed with `@grafeo-db/js v0.5.28+` as planned
- Self KG: single in-memory Grafeo instance
- Other KG: Map of isolated instances per personId

**If Grafeo is unavailable or non-compliant:**

Alternative 1: In-Memory TypeScript Graph Library
- Technology: `graphql-core` with custom Cypher subset
- Pros: Pure TypeScript, Cypher-like query language, lightweight
- Cons: Not full Cypher, manual graph algorithms
- Implementation cost: Medium (3-4 days)

Alternative 2: SQLite + Custom Traversal
- Technology: SQLite with vertex/edge tables + recursive queries
- Pros: Persistent option, zero dependencies, complete isolation
- Cons: No Cypher, manual graph operations
- Implementation cost: High (5-7 days)

Alternative 3: Multiple Neo4j Databases
- Technology: Separate Neo4j databases for Self KG and each Other KG
- Pros: Full Cypher, mature, proven
- Cons: Requires per-database connections, architectural shift from "embedded"
- Implementation cost: Low (Neo4j driver already used for WKG)
- Note: Loses semantic of "embedded" but gains simplicity

**Recommendation for Epic 3 Planning:**
1. Verify Grafeo is available and working (from E1 decision)
2. If Grafeo works: implement as designed with Grafeo
3. If Grafeo fails: **switch to Alternative 3** (separate Neo4j databases for simplicity)
4. Document decision in `wiki/phase-1/decisions/self-other-kg-technology.md`

---

## 3. Confidence Dynamics Implementation

### 3.1 ACT-R Confidence Formula and Service Layer

The core confidence formula lives in `ConfidenceService` as a pure function wrapper:

```typescript
// src/shared/types/confidence.types.ts
export interface ACTRParams {
  base: number;           // Initial confidence by provenance
  count: number;          // Successful retrieval-and-use events
  d: number;              // Decay rate (per-provenance)
  hours: number;          // Hours since last retrieval
}

// Pure function (from shared types)
export function computeConfidence(params: ACTRParams): number {
  const { base, count, d, hours } = params;
  const decayTerm = d * Math.log(hours + 1);
  const retrievalBonus = 0.12 * Math.log(count + 1);  // +1 to handle count=0
  const confidence = base + retrievalBonus - decayTerm;
  return Math.min(1.0, Math.max(0.0, confidence));  // Clamp to [0, 1]
}

// Base confidences by provenance
export const PROVENANCE_BASE_CONFIDENCE: Record<ProvenanceSource, number> = {
  [ProvenanceSource.SENSOR]: 0.40,
  [ProvenanceSource.GUARDIAN]: 0.60,
  [ProvenanceSource.LLM_GENERATED]: 0.35,
  [ProvenanceSource.INFERENCE]: 0.30
};

// Decay rates (per provenance)
export const DEFAULT_DECAY_RATES: Record<ProvenanceSource, number> = {
  [ProvenanceSource.SENSOR]: 0.05,
  [ProvenanceSource.GUARDIAN]: 0.03,    // GUARDIAN knowledge decays slower
  [ProvenanceSource.LLM_GENERATED]: 0.08,  // LLM-generated decays faster
  [ProvenanceSource.INFERENCE]: 0.06
};

// Confidence thresholds (Immutable)
export const CONFIDENCE_THRESHOLDS = {
  RETRIEVAL: 0.50,                      // Min to be retrievable
  TYPE1_GRADUATION: 0.80,               // Min for Type 1 reflex
  TYPE1_DEMOTION: 0.15,                 // Below this = demote from Type 1
  GUARDIAN_CEILING_WITHOUT_USE: 0.60,   // Max without retrieval-and-use
  LLM_GENERATED_CEILING: 0.35,          // LLM can never exceed this base
  SHRUG_THRESHOLD: 0.50                 // Below this with no confidence leader = shrug
};
```

### 3.2 ConfidenceService Implementation

Wraps the pure function and manages retrieval tracking:

```typescript
@Injectable()
export class ConfidenceService {
  private readonly logger = new Logger('ConfidenceService');

  constructor(
    @Inject(EVENTS_SERVICE) private events: IEventService,
    @Inject(WKG_SERVICE) private wkg: IWkgService
  ) {}

  /**
   * Compute confidence for a node based on ACT-R formula.
   * Used when loading nodes from WKG.
   */
  async computeNodeConfidence(
    node: WkgNode,
    currentTime: number = Date.now()
  ): Promise<number> {
    const hoursSinceLastRetrieval =
      (currentTime - (node.lastRetrievedAt || node.createdAt)) / (1000 * 60 * 60);

    const decayRate = DEFAULT_DECAY_RATES[node.provenance];

    const params: ACTRParams = {
      base: PROVENANCE_BASE_CONFIDENCE[node.provenance],
      count: node.retrievalCount || 0,
      d: decayRate,
      hours: hoursSinceLastRetrieval
    };

    return computeConfidence(params);
  }

  /**
   * Record a successful retrieval-and-use event.
   * Increments retrievalCount and updates lastRetrievedAt.
   * Called after a node is used in decision-making or action.
   */
  async recordRetrievalAndUse(
    nodeId: string,
    nodeLabel: string,
    context: string  // What was this node used for?
  ): Promise<void> {
    await this.wkg.recordRetrievalAndUse(nodeId, nodeLabel);

    // Record event for analytics
    await this.events.record({
      type: EventType.RETRIEVAL_AND_USE,
      subsystem: 'decision_making',
      timestamp: Date.now(),
      data: {
        nodeId,
        nodeLabel,
        context
      }
    });
  }

  /**
   * Enforce confidence ceiling (Immutable Standard 3).
   * No node > ceiling unless it has been successfully retrieved and used.
   */
  async checkConfidenceCeiling(
    nodeId: string,
    proposedConfidence: number,
    provenance: ProvenanceSource,
    retrievalCount: number
  ): Promise<void> {
    const base = PROVENANCE_BASE_CONFIDENCE[provenance];

    if (retrievalCount === 0 && proposedConfidence > base) {
      throw new ConfidenceCeilingViolationError(
        `Node ${nodeId}: confidence ${proposedConfidence} exceeds base ${base} ` +
        `without retrieval-and-use. retrievalCount=${retrievalCount}`
      );
    }

    // Special case: LLM_GENERATED can never exceed 0.35 base, even with retrieval
    // (This ensures earned trust, not given trust)
    if (provenance === ProvenanceSource.LLM_GENERATED && proposedConfidence > 0.35) {
      // LLM-generated can grow through retrieval, but never exceeds 0.60 (guardian base)
      // Formula still applies: min(1.0, 0.35 + 0.12*ln(count) - d*ln(hours+1))
      const recomputedConfidence = await this.computeNodeConfidence({
        ...node,
        retrievalCount,
        lastRetrievedAt: Date.now()
      });

      if (proposedConfidence > recomputedConfidence) {
        throw new ConfidenceCeilingViolationError(
          `LLM_GENERATED node ${nodeId}: proposed ${proposedConfidence} ` +
          `exceeds ACT-R computed ${recomputedConfidence}`
        );
      }
    }
  }

  /**
   * Guardian Asymmetry enforcement (Immutable Standard 5).
   * GUARDIAN confirmations and corrections carry multiplied weight.
   */
  async applyGuardianAsymmetry(
    nodeId: string,
    existingConfidence: number,
    guardianFeedback: 'confirmation' | 'correction',
    newConfidence: number
  ): Promise<number> {
    const multiplier = guardianFeedback === 'correction' ? 3 : 2;

    // Compute effective delta with asymmetry applied
    const delta = newConfidence - existingConfidence;
    const asymmetricDelta = delta * multiplier;
    const finalConfidence = existingConfidence + asymmetricDelta;

    return Math.min(1.0, Math.max(0.0, finalConfidence));
  }

  /**
   * Get all nodes below retrieval threshold.
   * Used for diagnostics and "untested knowledge" analysis.
   */
  async getUntestedNodes(
    minConfidenceDelta: number = 0.05  // >base by at least this
  ): Promise<WkgNode[]> {
    const allNodes = await this.wkg.queryEdges({ /* all nodes */ });

    return allNodes.filter(node => {
      const base = PROVENANCE_BASE_CONFIDENCE[node.provenance];
      return node.confidence < CONFIDENCE_THRESHOLDS.RETRIEVAL &&
             node.confidence > base &&
             node.retrievalCount === 0;
    });
  }
}
```

### 3.3 Confidence Update Rules

Integration with outcome evaluation (from Decision Making):

```typescript
/**
 * Apply three-path confidence update logic (from v1 confidence-updater).
 * Used when an action outcome is observed.
 */
async updateNodeConfidenceAfterOutcome(
  node: WkgNode,
  outcome: 'success' | 'failure' | 'counter_indicated',
  predictionError?: number  // MAE if this was a prediction
): Promise<number> {
  const currentConfidence = await this.computeNodeConfidence(node);

  switch (outcome) {
    case 'success':
      // Successful retrieval-and-use: increment count
      await this.recordRetrievalAndUse(node.id, node.label);
      const newConfidence = await this.computeNodeConfidence({
        ...node,
        retrievalCount: node.retrievalCount + 1,
        lastRetrievedAt: Date.now()
      });
      return newConfidence;

    case 'failure':
      // Failed prediction or action: reduce confidence
      // Rate depends on provenance and prediction error severity
      const decayRate = DEFAULT_DECAY_RATES[node.provenance];
      const reduction = 0.1 * (predictionError || 1.0);  // Proportional to error
      const failureConfidence = currentConfidence - reduction;
      return Math.max(0, failureConfidence);

    case 'counter_indicated':
      // Contradictory evidence: significant reduction, but don't zero out
      // (Contradictions are learning opportunities, not refutations)
      const contradictionPenalty = 0.2;
      return currentConfidence - contradictionPenalty;
  }
}
```

---

## 4. Contradiction Detection and Developmental Learning

### 4.1 Contradiction Types and Detection

Contradictions are **developmental catalysts** (Piagetian disequilibrium), not errors. They trigger learning opportunities.

**Contradiction Types:**

```typescript
enum ContradictionType {
  // Factual contradictions
  DIRECT_CONFLICT = 'direct_conflict',              // A says X, B says NOT X
  PROPERTY_CONFLICT = 'property_conflict',          // X.color=red vs. X.color=blue

  // Logical contradictions
  IMPLICATION_CONFLICT = 'implication_conflict',    // A→B, B→¬C, but C observed
  CARDINALITY_CONFLICT = 'cardinality_conflict',    // one-to-one violated

  // Temporal contradictions
  TEMPORAL_CONFLICT = 'temporal_conflict',          // X at time T1, then NOT X at T2 unexpectedly
  CAUSALITY_CONFLICT = 'causality_conflict',        // Cause happens after effect

  // Epistemic contradictions
  PROVENANCE_CONFLICT = 'provenance_conflict',      // GUARDIAN says A, multiple SENSOR say ¬A
  CONFIDENCE_CONFLICT = 'confidence_conflict'       // High-confidence A contradicts high-confidence B
}

interface DetectedContradiction {
  id: string;                                      // Unique contradiction ID
  type: ContradictionType;
  node1Id: string;                                 // First node/edge involved
  node1Label: string;
  node2Id: string;                                 // Second node/edge involved
  node2Label: string;

  severity: number;                                // [0, 1] how serious
  confidence: number;                              // [0, 1] confidence in contradiction claim

  evidence: {
    supportingNode1: string;                       // What supports node1?
    supportingNode2: string;                       // What supports node2?
  };

  possibleResolutions: string[];                   // Hypothetical resolutions
  detectedAt: number;
  detectedBy: string;                              // Which subsystem detected this?
}
```

### 4.2 Detection Strategy

Contradictions are detected at three points:

1. **At upsert time** (WkgService.upsertEdge)
2. **During query** (contradiction analysis queries)
3. **During consolidation** (Learning module compares new facts with existing)

```typescript
// In WkgService.upsertEdge()
async upsertEdge(edge: WkgEdgeInput): Promise<void> {
  // 1. Upsert the edge
  await this.neo4j.write(
    `MATCH (a {id: $fromId}), (b {id: $toId})
     MERGE (a)-[r:${edge.type}]->(b)
     SET r.confidence = $confidence, r.provenance = $provenance, ...`
  );

  // 2. Check for contradictions
  const contradictions = await this.detectLocalContradictions(
    edge.fromId,
    edge.type,
    edge.toId
  );

  for (const contradiction of contradictions) {
    // 3. Record contradiction as new node/edge in WKG
    await this.recordContradiction(contradiction);

    // 4. Fire event for Drive Engine to create Opportunity
    await this.events.record({
      type: EventType.CONTRADICTION_DETECTED,
      subsystem: 'learning',
      timestamp: Date.now(),
      data: {
        contradictionId: contradiction.id,
        severity: contradiction.severity,
        nodes: [edge.fromId, edge.toId]
      }
    });
  }
}

// Detect local contradictions involving a specific edge
private async detectLocalContradictions(
  fromId: string,
  relType: string,
  toId: string
): Promise<DetectedContradiction[]> {
  const contradictions: DetectedContradiction[] = [];

  // Query 1: Direct conflict (same relationship with opposite truth value)
  const oppositeRels = await this.neo4j.read(
    `MATCH (a {id: $fromId})-[r:${OPPOSITE_OF[relType]}]->(b {id: $toId})
     RETURN r, r.confidence`
  );

  if (oppositeRels.length > 0) {
    contradictions.push({
      type: ContradictionType.DIRECT_CONFLICT,
      node1Id: fromId,
      node2Id: toId,
      severity: await this.computeContradictionSeverity(fromId, toId),
      ...
    });
  }

  // Query 2: Property conflicts
  // If (X)-[:HAS_PROPERTY { value: red }] but also (X)-[:HAS_PROPERTY { value: blue }]
  // for same property and overlapping temporal validity
  const propertyConflicts = await this.neo4j.read(
    `MATCH (x {id: $fromId})-[r1:HAS_PROPERTY {property: $prop, value: $val1}]->(v1)
     MATCH (x)-[r2:HAS_PROPERTY {property: $prop, value: $val2}]->(v2)
     WHERE $val1 <> $val2 AND NOT ($temporalOverlap is null)
     RETURN r1, r2, x`
  );

  if (propertyConflicts.length > 0) {
    contradictions.push({
      type: ContradictionType.PROPERTY_CONFLICT,
      ...
    });
  }

  // Query 3: Provenance conflict (GUARDIAN says A, but multiple SENSOR observations say ¬A)
  const provenanceConflicts = await this.detectProvenanceConflicts(fromId, relType, toId);
  contradictions.push(...provenanceConflicts);

  return contradictions;
}

// Compute contradiction severity (for drive pressure)
private async computeContradictionSeverity(node1Id: string, node2Id: string): number {
  const node1 = await this.findNode(node1Id);
  const node2 = await this.findNode(node2Id);

  // Higher severity if both nodes are high-confidence
  const confidenceProduct = (node1.confidence || 0.5) * (node2.confidence || 0.5);

  // Higher severity if both are GUARDIAN provenance
  const isGuardianConflict =
    node1.provenance === ProvenanceSource.GUARDIAN &&
    node2.provenance === ProvenanceSource.GUARDIAN;

  let severity = confidenceProduct * 0.5;  // Base from confidence
  if (isGuardianConflict) severity *= 1.5;  // GUARDIAN conflicts are serious

  return Math.min(1.0, severity);
}
```

### 4.3 Contradiction-Driven Learning

When a contradiction is detected:

1. **Flag the contradiction** in WKG as a node with edges to both conflicting nodes
2. **Fire event** for Drive Engine (Information Integrity drive pressure increases)
3. **Create Opportunity** for Planning subsystem
4. **Do NOT suppress the contradiction** — both contradictory edges remain in graph
5. **Update confidence** on contradicted edges downward, but don't zero them out

```typescript
// Record contradiction in WKG
private async recordContradiction(contradiction: DetectedContradiction): Promise<void> {
  // Create :Contradiction node
  await this.upsertNode({
    label: 'Concept',  // Or new label?
    id: contradiction.id,
    name: `Contradiction: ${contradiction.type}`,
    description: contradiction.evidence,
    confidence: contradiction.confidence,
    provenance: ProvenanceSource.INFERENCE,
    properties: {
      type: contradiction.type,
      severity: contradiction.severity,
      possibleResolutions: contradiction.possibleResolutions
    }
  });

  // Create edges from contradiction to involved nodes
  await this.upsertEdge({
    fromId: contradiction.id,
    toId: contradiction.node1Id,
    type: 'INVOLVES',
    confidence: contradiction.confidence,
    provenance: ProvenanceSource.INFERENCE
  });

  await this.upsertEdge({
    fromId: contradiction.id,
    toId: contradiction.node2Id,
    type: 'INVOLVES',
    confidence: contradiction.confidence,
    provenance: ProvenanceSource.INFERENCE
  });

  // Mark both nodes as "contradicted"
  // (Don't delete or hide them — they remain in graph)
  const node1 = await this.findNode(contradiction.node1Id);
  const node2 = await this.findNode(contradiction.node2Id);

  node1.contradictionCount = (node1.contradictionCount || 0) + 1;
  node2.contradictionCount = (node2.contradictionCount || 0) + 1;

  await this.upsertNode(node1);
  await this.upsertNode(node2);
}

// Drive Engine will see contradiction event and apply pressure
// Information Integrity drive: pressure += contradiction.severity
// This creates motivation to resolve the contradiction
```

---

## 5. Query Interface Design

### 5.1 Query Methods in IWkgService

```typescript
export interface IWkgService {
  // Upsert operations (write)
  upsertNode(node: WkgNodeInput): Promise<WkgNode>;
  upsertEdge(edge: WkgEdgeInput): Promise<WkgEdge>;

  // Retrieve operations (read)
  findNode(id: string, label?: string): Promise<WkgNode | null>;
  findNodeByName(name: string, label?: string): Promise<WkgNode[]>;

  // Query operations
  queryEdges(filter: EdgeQueryFilter): Promise<WkgEdge[]>;
  queryContext(nodeId: string, depth: number, filter?: EdgeQueryFilter): Promise<SubgraphContext>;
  queryNodes(filter: NodeQueryFilter): Promise<WkgNode[]>;

  // Contradiction queries
  queryContradictions(severity?: number): Promise<DetectedContradiction[]>;
  queryContradictionsByNode(nodeId: string): Promise<DetectedContradiction[]>;

  // Confidence/provenance queries
  queryNodesByConfidence(minConfidence: number, maxConfidence?: number): Promise<WkgNode[]>;
  queryNodesByProvenance(provenance: ProvenanceSource[]): Promise<WkgNode[]>;
  queryUntestedNodes(): Promise<WkgNode[]>;

  // Retrieval tracking
  recordRetrievalAndUse(nodeId: string, label: string): Promise<void>;

  // Lesion test support
  queryLesionedGraph(excludeProvenance: ProvenanceSource[]): Promise<SubgraphContext>;

  // Schema operations
  upsertSchemaType(schema: SchemaTypeInput): Promise<SchemaType>;
  upsertSchemaRelType(schema: SchemaRelTypeInput): Promise<SchemaRelType>;
  querySchemaTypes(): Promise<SchemaType[]>;
}

interface EdgeQueryFilter {
  fromId?: string;
  toId?: string;
  type?: string;
  minConfidence?: number;
  maxConfidence?: number;
  provenanceFilter?: ProvenanceSource[];
  excludeProvenanceFilter?: ProvenanceSource[];
  temporalRange?: [number, number];  // [from, to] timestamps
  limit?: number;
  offset?: number;
}

interface NodeQueryFilter {
  label?: string;
  namePattern?: string;  // Regex or substring
  minConfidence?: number;
  maxConfidence?: number;
  provenanceFilter?: ProvenanceSource[];
  hasContradictions?: boolean;
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
  offset?: number;
}

interface SubgraphContext {
  nodes: WkgNode[];
  edges: WkgEdge[];
  rootNodeId: string;
  depth: number;
  metadata: {
    totalConfidence: number;
    averageConfidence: number;
    contradictionCount: number;
    schemaReferences: string[];
  };
}
```

### 5.2 queryContext() Implementation

`queryContext()` assembles a subgraph for LLM context assembly (Type 2 deliberation):

```typescript
async queryContext(
  nodeId: string,
  depth: number = 2,
  filter?: EdgeQueryFilter
): Promise<SubgraphContext> {
  const rootNode = await this.findNode(nodeId);
  if (!rootNode) throw new NodeNotFoundError(nodeId);

  const nodes: Set<WkgNode> = new Set([rootNode]);
  const edges: Set<WkgEdge> = new Set();

  // Breadth-first search to specified depth
  let currentLevel = [rootNode.id];
  for (let d = 0; d < depth; d++) {
    const nextLevel: string[] = [];

    for (const currentId of currentLevel) {
      // Find all edges from this node
      const outgoing = await this.neo4j.read(
        `MATCH (a {id: $id})-[r]->(b)
         WHERE r.confidence >= $minConf
         RETURN b, r`,
        {
          id: currentId,
          minConf: filter?.minConfidence || 0.3
        }
      );

      for (const row of outgoing) {
        const neighbor = row.b;
        const edge = row.r;

        // Add neighbor node and edge
        nodes.add(neighbor);
        edges.add(edge);

        if (!nodes.has(neighbor)) {
          nextLevel.push(neighbor.id);
        }
      }
    }

    currentLevel = nextLevel;
  }

  // Assemble metadata
  const metadata = {
    totalConfidence: Array.from(nodes).reduce((sum, n) => sum + n.confidence, 0),
    averageConfidence: Array.from(nodes).reduce((sum, n) => sum + n.confidence, 0) / nodes.size,
    contradictionCount: Array.from(nodes).reduce((sum, n) => sum + (n.contradictionCount || 0), 0),
    schemaReferences: Array.from(nodes)
      .filter(n => n.label === 'SchemaType')
      .map(n => n.id)
  };

  return {
    nodes: Array.from(nodes),
    edges: Array.from(edges),
    rootNodeId: nodeId,
    depth,
    metadata
  };
}
```

### 5.3 Lesion Test Queries

Support for `queryLesionedGraph()` — what Sylphie knows without LLM:

```typescript
async queryLesionedGraph(
  excludeProvenance: ProvenanceSource[] = [ProvenanceSource.LLM_GENERATED]
): Promise<SubgraphContext> {
  // Query all nodes except LLM_GENERATED
  const nodes = await this.neo4j.read(
    `MATCH (n)
     WHERE NOT n.provenance IN $exclude
     RETURN n`,
    { exclude: excludeProvenance }
  );

  // Query all edges with non-excluded provenance
  const edges = await this.neo4j.read(
    `MATCH (a)-[r]->(b)
     WHERE NOT r.provenance IN $exclude
     RETURN r, a, b`,
    { exclude: excludeProvenance }
  );

  return {
    nodes,
    edges,
    rootNodeId: null,  // No single root for lesioned graph
    depth: null,
    metadata: {
      totalConfidence: nodes.reduce((sum, n) => sum + n.confidence, 0),
      averageConfidence: nodes.reduce((sum, n) => sum + n.confidence, 0) / nodes.length,
      contradictionCount: nodes.reduce((sum, n) => sum + (n.contradictionCount || 0), 0),
      schemaReferences: nodes
        .filter(n => n.label === 'SchemaType')
        .map(n => n.id)
    }
  };
}
```

---

## 6. Risk Assessment and Mitigation

### 6.1 Technical Risks

| Risk | Severity | Mitigation | Owner |
|------|----------|-----------|-------|
| Grafeo doesn't exist or is non-compliant | HIGH | Validated in E1; fallback to Neo4j multiple databases | Atlas (E1) |
| Neo4j query performance as graph grows | MEDIUM | Indexes on commonly-queried properties; profile early; consider read replicas for WKG queries | Implementation (E3) |
| Provenance enforcement is incomplete | CRITICAL | All upsert operations validated in service layer; audit trail in events table; regular lesion tests | Atlas (review layer) |
| Confidence ceiling enforcement broken | CRITICAL | Unit tests for ConfidenceService covering all base cases and guardian asymmetry; property-based testing | Implementation (E3) |
| Contradiction detection creates feedback loop | MEDIUM | Limit contradiction severity multiplier; circuit breaker on ruminative loops in Drive Engine; information integrity cap | Drive Engine (E4) |
| Self KG grows unbounded | LOW | Self KG is small by design (< 200 nodes); periodic consolidation of old beliefs | Learning (E7) |
| Other KG memory explosion (many users) | MEDIUM | Persist inactive per-person KGs to SQLite; lazy load on query; implement eviction policy | Implementation (E3) |
| Schema evolution is painful | MEDIUM | Versioning on schema nodes; migration queries for schema changes; test on copy first | Atlas (design) |

### 6.2 Architectural Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| WKG becomes hallucination sink | MEDIUM | LLM_GENERATED base confidence 0.35; ceiling without retrieval-and-use; guardian override on major assertions |
| Self KG models are distorted by recency bias | MEDIUM | Self evaluation on slower timescale; weighted averaging of old patterns; circuit breaker on persistent negative self-model |
| Other KG person models are inaccurate | MEDIUM | Prediction accuracy tracking per person; confidence decay on model predictions that fail; refresh on contradictions |
| Three KGs become accidentally entangled | HIGH | Type system enforcement; serialization barriers; no shared references in code; integration tests |
| Contradiction handling becomes infinite loop | MEDIUM | Contradiction severity cap; Planning subsystem rate limiting; Opportunity priority queue with decay |

### 6.3 Performance Risks

| Risk | Scenario | Mitigation |
|------|----------|-----------|
| queryContext() is slow | LLM requests context during deliberation; decision latency critical | Cache recent contexts; limit depth to 2-3; query optimization with indexes |
| upsertNode() blocks on contradiction detection | Every write checks for contradictions; writing to WKG becomes slow | Async contradiction checking; queue for lower-priority contradictions; batch detection during consolidation |
| Other KG queries slow as personId map grows | Many users; per-person KG map has 1000+ entries | Lazy initialization; unload inactive graphs; switch to SQLite-backed storage |
| Confidence recomputation is expensive | On every retrieval-and-use, recompute via formula | Cache confidence value; only recompute on decay windows or explicit requests |

### 6.4 Integration Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Decision Making cannot retrieve nodes quickly enough | Type 1 reflexes require fast retrieval | WKG queries cached; confidence pre-computed; consider local cache in Decision Making |
| Learning consolidation conflicts with Decision Making reads | Concurrent access to WKG during maintenance cycle | Read-your-writes guarantee; write locks only during consolidation |
| Drive Engine needs to query Self KG every tick | Performance bottleneck | Self KG in-memory; minimal serialization; no network I/O |
| Person modeling conflicts with Other KG isolation | Multiple subsystems updating same person graph | Serialization via snapshot; consolidated writes from Communication module; no concurrent mutations |

---

## 7. Detailed Implementation Recommendations

### 7.1 Ticket Breakdown Recommendation

**Epic 3 should be decomposed into these tickets (with dependencies):**

#### E3.1 WKG Schema & Initialization (Foundation)
**Complexity:** M | **Dependencies:** E0, E1 (Neo4j driver ready)
- Define all Neo4j labels, properties, constraints
- Implement constraint creation in `onModuleInit()`
- Create index strategy document
- Deliverable: `WkgService.onModuleInit()` creates consistent schema

#### E3.2 Core WkgService Implementation (Critical Path)
**Complexity:** L | **Dependencies:** E3.1
- Implement `upsertNode()` with provenance validation
- Implement `findNode()` and `findNodeByName()`
- Implement `upsertEdge()` (without contradiction detection yet)
- Unit tests for basic CRUD operations
- Deliverable: Basic read/write functionality compiles and passes unit tests

#### E3.3 Confidence Service (Enable Type 1/Type 2)
**Complexity:** M | **Dependencies:** E3.2, Events module ready
- Implement ACT-R formula wrapping
- Implement `recordRetrievalAndUse()` and event integration
- Implement confidence ceiling checks
- Implement Guardian Asymmetry multiplier
- Unit tests with property-based testing (vary base, count, hours)
- Deliverable: ConfidenceService passes all confidence dynamics tests

#### E3.4 Contradiction Detection (Learning Catalyst)
**Complexity:** L | **Dependencies:** E3.2
- Implement `detectLocalContradictions()` for direct conflicts and property conflicts
- Implement `recordContradiction()` as WKG node + edges
- Implement provenance conflict detection
- Implement severity computation
- Integration test: upsert contradictory edges, verify graph state
- Deliverable: Contradictions are detected and recorded in WKG

#### E3.5 Query Interfaces (LLM Context Assembly)
**Complexity:** M | **Dependencies:** E3.2
- Implement `queryEdges()` with filter support
- Implement `queryContext()` for subgraph retrieval
- Implement `queryNodesByConfidence()` and other diagnostic queries
- Implement `queryLesionedGraph()` for lesion test
- Unit tests with various filter combinations
- Deliverable: All query methods pass type checking; basic integration tests

#### E3.6 Self KG (Grafeo) Implementation
**Complexity:** M | **Dependencies:** E1 (Grafeo decision made), E3.3
- Validate Grafeo is working (or use fallback decision from E1)
- Implement single in-memory Grafeo instance
- Implement `ISelfKgService.getCurrentModel()` returning immutable snapshot
- Implement `updateSelfConcept()` from Learning module
- Unit tests for isolation and serialization
- Deliverable: Self KG can be created, updated, queried as pure interface

#### E3.7 Other KG (Grafeo) Implementation
**Complexity:** M | **Dependencies:** E3.6
- Implement Map<personId, GrafeoInstance>
- Implement lazy initialization on first query
- Implement `IOtherKgService.getPersonGraph()` and `queryPersonModel()`
- Implement `updatePersonModel()` from Communication module
- Unit tests for isolation between person graphs
- Deliverable: Per-person models are isolated; no data leakage between instances

#### E3.8 Integration & End-to-End Tests
**Complexity:** M | **Dependencies:** E3.1-E3.7, Events module, all subsystem modules
- Create end-to-end test: upsert node → record retrieval → verify confidence increase
- Create end-to-end test: contradiction detection → event firing → WKG state
- Create lesion test scenario: query graph with/without LLM_GENERATED
- Create person modeling test: update Other KG → verify Communication can use model
- Performance profiling: queryContext() latency, upsertNode() throughput
- Deliverable: All integration tests pass; performance baseline established

#### E3.9 Documentation & Session Log
**Complexity:** S | **Dependencies:** E3.1-E3.8
- Document Neo4j schema with entity-relationship diagram
- Document Grafeo setup and isolation strategy
- Document ACT-R confidence formula with examples
- Write session log summarizing changes, wiring, known issues
- Deliverable: `docs/sessions/YYYY-MM-DD-knowledge-module.md`

### 7.2 Implementation Order

1. **Parallel Track A: WKG Setup**
   - E3.1 (Schema) → E3.2 (upsertNode/findNode) → E3.4 (Contradiction detection)

2. **Parallel Track B: Confidence Dynamics**
   - E3.3 (ConfidenceService) → integrated into E3.2 updates

3. **Parallel Track C: Query Interfaces**
   - E3.5 (queryContext, queryEdges) → depends on E3.2 being stable

4. **Parallel Track D: Self/Other KG**
   - E3.6 (Self KG) → E3.7 (Other KG) → depends on E1 Grafeo decision

5. **Sequential:**
   - E3.8 (Integration tests) → E3.9 (Documentation)

**Critical Path:** E3.1 → E3.2 → E3.3 → E3.5 → E3.8

### 7.3 Key Implementation Patterns

**Pattern 1: Provenance-First Upserts**
Every node/edge write validates provenance before DB write:
```typescript
// Before INSERT/UPDATE
if (!provenanceIsValid) throw InvalidProvenanceError;
if (confidence > ceiling) throw ConfidenceCeilingError;
await checkGuardianAsymmetry(node);
// Then INSERT/UPDATE
```

**Pattern 2: Immutable Snapshots from Grafeo**
Self KG and Other KG never expose raw Grafeo instances:
```typescript
// Bad: return this.selfKg.getNodes()
// Good:
const snapshot = {
  beliefs: this.selfKg.query('...').map(n => ({ id, confidence })),
  capabilities: [...]
};
return Object.freeze(snapshot);  // Immutable
```

**Pattern 3: Contradiction Edge Recording**
Every contradiction is a persistent edge, not an external flag:
```typescript
// Contradiction is a Concept node
await upsertNode({ label: 'Concept', id: 'contradiction_X', ... });
// With edges to both conflicting nodes
await upsertEdge({ fromId: 'contradiction_X', toId: nodeId1, type: 'INVOLVES' });
await upsertEdge({ fromId: 'contradiction_X', toId: nodeId2, type: 'INVOLVES' });
```

**Pattern 4: Lesion Test Support**
Provenance tags enable filtering at query time:
```typescript
const independentKnowledge = await wkg.queryNodesByProvenance([
  ProvenanceSource.SENSOR,
  ProvenanceSource.GUARDIAN,
  ProvenanceSource.INFERENCE
  // Exclude LLM_GENERATED
]);
```

---

## 8. Known Unknowns and Future Refinements

### Open Questions for CANON Refinement

1. **Self-Evaluation Timescale**: How often should Drive Engine query Self KG? Every tick (100Hz) or slower cycle (every 10 ticks)? Trade-off between accuracy and latency.

2. **Contradiction Resolution Strategies**: When a contradiction is detected, what are the possible resolutions? Should Planning propose hypotheses (e.g., "maybe my memory is wrong"), or just defer to guardian correction?

3. **Person Model Generalization**: If Sylphie interacts with multiple people, can she infer general rules? ("All humans prefer X") Or are person models completely isolated?

4. **Schema Stability**: How do schema types evolve? When does a new concept get elevated from instance to schema? Guardian-approved only, or learned patterns?

5. **Contradiction Severity Semantics**: Is severity based on confidence product, provenance weight, or domain importance? Need precise formula.

### Future Enhancements

- **Ontology bootstrapping**: Load foundational schema (e.g., Wikidata subset) at startup to accelerate learning
- **Graph compression**: Consolidate aged nodes into summary nodes to prevent unbounded growth
- **Multi-hop prediction**: Extend Inner Monologue to predict chains of effects (A→B→C)
- **Schema inference**: Automatically infer schema types from instance patterns (if 10 entities have same properties, propose schema type)
- **Query optimization**: Cost-based query planning for large queryContext() calls
- **Grafeo persistence**: Move from in-memory to SQLite-backed Self/Other KG for durability across sessions

---

## 9. Conclusion

Epic 3 realizes Sylphie's brain: a Neo4j WKG with provenance enforcement, confidence ceilings, and contradiction-driven learning; two Grafeo-based per-person models (Self KG and Other KG) completely isolated from the WKG; and ACT-R confidence dynamics that implement the Confidence Ceiling (Immutable Standard 3).

The implementation is complex but well-constrained by CANON. Key risks (Grafeo availability, provenance enforcement completeness, contradiction feedback loops) are mitigated by clear fallback strategies and integration testing.

Success in E3 is measured by:
- All nodes and edges carry provenance without exception
- Confidence ceiling is enforced: no untested knowledge > base
- Contradictions are detected and recorded without suppression
- Self KG and Other KG are completely isolated (verified by integration tests)
- Query interfaces support both LLM context assembly (queryContext) and lesion testing (queryLesionedGraph)

**Estimated effort:** 15-20 days implementation + testing + integration
**Critical path:** E3.1 → E3.2 → E3.3 → E3.5 → E3.8

---

## References

- **CANON:** `/wiki/CANON.md` -- Immutable project philosophy and constraints
- **Roadmap:** `/wiki/phase-1/roadmap.md` -- Epic 3 scope and E1/E2 dependencies
- **E1 Atlas Analysis:** `/wiki/phase-1/epic-1/agent-analyses/atlas.md` -- Database infrastructure and Grafeo decision
- **CLAUDE.md:** `/CLAUDE.md` -- Agent instructions and system context
