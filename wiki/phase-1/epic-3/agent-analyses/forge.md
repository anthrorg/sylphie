# Epic 3: Knowledge Module (WKG + Self KG + Other KG) -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** Real Neo4j/Grafeo implementations for World KG, Self KG, Other KGs, and confidence service
**Analysis Date:** 2026-03-29
**Scope:** NestJS module structure, interface refinement, provider patterns, isolation enforcement, cross-subsystem coordination

---

## Executive Summary

Epic 3 fills in the knowledge services with real implementations, replacing E0 stubs. The Knowledge Module is the architectural center of gravity — all five subsystems either read from or write to it. The key challenge is **enforcement without brittleness**: provenance, confidence ceilings, contradiction detection, and KG isolation must be bulletproof without becoming a performance bottleneck or maintenance burden.

This analysis covers:
1. **Module structure**: Directory layout, what's exported, what's internal
2. **Interface refinement**: Full TypeScript signatures with edge cases
3. **NestJS wiring**: Providers, initialization, lifecycle
4. **Cross-module coordination**: Which modules import Knowledge, what signals cross TimescaleDB
5. **Isolation enforcement**: Type and runtime guarantees
6. **Risks & mitigations**: Grafeo availability, Neo4j transaction patterns, performance
7. **Ticket breakdown**: Sequencing with clear dependencies

---

## 1. Module Structure

### 1.1 Directory Layout

```
src/knowledge/
├── knowledge.module.ts           # Main module declaration, provider registration
├── knowledge.providers.ts        # Factory providers for Neo4j and Grafeo
├── index.ts                      # Barrel export (only interfaces and tokens)
│
├── interfaces/
│   ├── wkg.interface.ts          # IWkgService
│   ├── self-kg.interface.ts      # ISelfKgService
│   ├── other-kg.interface.ts     # IOtherKgService
│   ├── confidence.interface.ts   # IConfidenceService
│   └── index.ts                  # Barrel (exported)
│
├── services/
│   ├── wkg/
│   │   ├── wkg.service.ts        # WkgService (Neo4j implementation)
│   │   ├── wkg-queries.ts        # Cypher query builders
│   │   ├── wkg.provider.ts       # Factory registration
│   │   └── index.ts              # Internal barrel
│   │
│   ├── self-kg/
│   │   ├── self-kg.service.ts    # SelfKgService (Grafeo implementation)
│   │   ├── self-kg.schema.ts     # Self KG node/edge schema
│   │   ├── self-kg.provider.ts   # Factory registration
│   │   └── index.ts              # Internal barrel
│   │
│   ├── other-kg/
│   │   ├── other-kg.service.ts   # OtherKgService (Grafeo per-person)
│   │   ├── other-kg.registry.ts  # PersonId -> Grafeo instance map
│   │   ├── other-kg.schema.ts    # Other KG node/edge schema
│   │   ├── other-kg.provider.ts  # Factory registration
│   │   └── index.ts              # Internal barrel
│   │
│   ├── confidence/
│   │   ├── confidence.service.ts # ConfidenceService (ACT-R wrapper)
│   │   ├── confidence.provider.ts # Registration
│   │   └── index.ts              # Internal barrel
│   │
│   └── index.ts                  # Internal barrel (NOT exported)
│
├── types/
│   ├── graph-node.types.ts       # KnowledgeNode, NodeAttributes
│   ├── graph-edge.types.ts       # KnowledgeEdge, EdgeAttributes
│   ├── query.types.ts            # Query filters, result shapes
│   ├── contradiction.types.ts    # ContradictionEvent (to emit via Events)
│   └── index.ts                  # Barrel (exported)
│
├── exceptions/
│   ├── knowledge.exceptions.ts   # KnowledgeException, NodeNotFoundError, etc.
│   └── index.ts                  # Barrel (exported)
│
├── guards/
│   ├── provenance.guard.ts       # Validate provenance on every write
│   ├── confidence-ceiling.guard.ts # Enforce Confidence Ceiling (Immutable Standard 3)
│   └── index.ts                  # Barrel (exported)
│
└── README.md                      # Module documentation, schema examples
```

### 1.2 What's Exported vs. Internal

**Exported via `knowledge/index.ts`:**
- `IWkgService`, `ISelfKgService`, `IOtherKgService`, `IConfidenceService` (interfaces only)
- `WKG_SERVICE`, `SELF_KG_SERVICE`, `OTHER_KG_SERVICE`, `CONFIDENCE_SERVICE` (DI tokens)
- `NEO4J_DRIVER`, `SELF_KG_GRAFEO`, `OTHER_KG_GRAFEO_REGISTRY` (database tokens)
- `KnowledgeNode`, `KnowledgeEdge`, `ProvenanceSource`, `Confidence*` types
- `KnowledgeException`, domain-specific exceptions
- `KnowledgeModule`

**NOT Exported:**
- `WkgService`, `SelfKgService`, `OtherKgService`, `ConfidenceService` (concrete classes)
- Internal Cypher queries, schema definitions, guards
- Registry internals

This forces all access through DI tokens, preventing accidental concrete imports.

### 1.3 DI Token Design

```typescript
// src/knowledge/index.ts
export const WKG_SERVICE = Symbol('WKG_SERVICE');
export const SELF_KG_SERVICE = Symbol('SELF_KG_SERVICE');
export const OTHER_KG_SERVICE = Symbol('OTHER_KG_SERVICE');
export const CONFIDENCE_SERVICE = Symbol('CONFIDENCE_SERVICE');

// Database tokens (internal)
export const NEO4J_DRIVER = Symbol('NEO4J_DRIVER');
export const SELF_KG_GRAFEO = Symbol('SELF_KG_GRAFEO');
export const OTHER_KG_GRAFEO_REGISTRY = Symbol('OTHER_KG_GRAFEO_REGISTRY');
```

Use symbols (not strings) to prevent accidental duplication and ensure type safety when injecting.

---

## 2. Interface Refinement

### 2.1 IWkgService

```typescript
/**
 * World Knowledge Graph interface.
 *
 * CRITICAL CONSTRAINTS:
 * - Provenance is required on every write operation (enforced at method entry)
 * - Confidence ceiling enforced: no node exceeds 0.60 until first retrieval-and-use
 * - All methods are transactional when modifying graph state
 * - Read operations may return cached results (eventual consistency acceptable)
 */
export interface IWkgService {
  /**
   * Insert or update a node in the WKG.
   *
   * @param nodeId - Unique identifier for the node
   * @param attributes - Node properties (label, properties dict)
   * @param provenance - Required. Where did this knowledge come from?
   * @param baseConfidence - Optional, defaults based on provenance type
   *
   * @throws KnowledgeException if provenance missing
   * @throws ConfidenceCeilingViolation if attempting to exceed 0.60 without retrieval count
   *
   * @emits KNOWLEDGE_NODE_UPSERTED event to TimescaleDB
   *
   * @remarks
   * If node exists, properties are merged. Provenance history is maintained.
   * Returns the final state of the node (with computed confidence).
   */
  upsertNode(
    nodeId: string,
    attributes: NodeAttributes,
    provenance: ProvenanceSource,
    baseConfidence?: number,
  ): Promise<KnowledgeNode>;

  /**
   * Find a node by ID. Single source of truth for node state.
   *
   * @param nodeId - The node to retrieve
   *
   * @throws NodeNotFoundError if node doesn't exist
   *
   * @remarks
   * This retrieval increments retrieval count and starts decay timer.
   * Confidence is computed fresh on every read.
   */
  findNode(nodeId: string): Promise<KnowledgeNode>;

  /**
   * Upsert an edge between two nodes.
   *
   * @param fromNodeId - Source node
   * @param toNodeId - Target node
   * @param relationshipType - The semantic relationship (e.g., "IS_A", "CONTAINS", "CAN_PRODUCE")
   * @param attributes - Edge metadata (optional)
   * @param provenance - Required
   * @param baseConfidence - Optional, defaults based on provenance
   *
   * @throws KnowledgeException if provenance missing or nodes don't exist
   * @throws ConfidenceCeilingViolation
   *
   * @emits KNOWLEDGE_EDGE_UPSERTED event to TimescaleDB
   *
   * @remarks
   * Edges are directed. Multiple edges with same type are merged by updating attributes.
   * Returns the final edge state.
   */
  upsertEdge(
    fromNodeId: string,
    toNodeId: string,
    relationshipType: string,
    attributes?: Record<string, any>,
    provenance?: ProvenanceSource,
    baseConfidence?: number,
  ): Promise<KnowledgeEdge>;

  /**
   * Query edges by type and source/target filters.
   *
   * @param filter - Query parameters
   *
   * @returns Array of matching edges (may be empty)
   *
   * @remarks
   * Does NOT increment retrieval counts (read-only query).
   * Results are ordered by edge confidence (descending).
   */
  queryEdges(filter: EdgeQueryFilter): Promise<KnowledgeEdge[]>;

  /**
   * Get context subgraph around a node.
   *
   * @param nodeId - Center node
   * @param depth - How many hops to include (1-3 typically)
   * @param relationshipFilter - Optional: only include these edge types
   *
   * @returns Object with nodeId, related nodes, and edges connecting them
   *
   * @remarks
   * Used by Communication subsystem for response generation context.
   * Does NOT increment retrieval counts on the subgraph nodes.
   */
  queryContext(
    nodeId: string,
    depth: number,
    relationshipFilter?: string[],
  ): Promise<ContextSubgraph>;

  /**
   * Record that a node was retrieved AND used in a decision/action.
   *
   * Increments retrieval count and resets decay timer. This is the ONLY way confidence grows.
   *
   * @param nodeId - Which node was used
   * @param context - Where was it used? (subsystem, action type, timestamp)
   *
   * @emits KNOWLEDGE_RETRIEVAL_AND_USE event to TimescaleDB (for provenance audit trail)
   *
   * @remarks
   * Confidence Ceiling (Immutable Standard 3) enforces that knowledge can't exceed
   * 0.60 until this method is called at least once.
   *
   * Call this from Decision Making immediately after retrieving a Type 1 reflex,
   * from Communication after using retrieved knowledge for response generation,
   * from Learning after using retrieved knowledge in edge refinement.
   */
  recordRetrievalAndUse(
    nodeId: string,
    context: RetrievalContext,
  ): Promise<void>;

  /**
   * Check if a contradiction exists between new and existing knowledge.
   *
   * @param nodeId - Which node is being modified
   * @param newAttributes - What are we trying to set?
   *
   * @returns Contradiction info or null
   *
   * @emits CONTRADICTION_DETECTED event to TimescaleDB (for Learning subsystem analysis)
   *
   * @remarks
   * Contradictions are NOT errors — they're developmental catalysts.
   * Learning subsystem will flag and investigate.
   *
   * Examples:
   * - Node "person_jim" with property "species: human" contradicts new data "species: robot"
   * - Edge "person_jim HAS hobby_painting" contradicts learning new fact "person_jim HAS hobby_music"
   *   (both can coexist; this returns null)
   */
  checkContradiction(
    nodeId: string,
    newAttributes: Partial<NodeAttributes>,
  ): Promise<Contradiction | null>;
}
```

### 2.2 ISelfKgService

```typescript
/**
 * Self Knowledge Graph — Sylphie's self-model.
 *
 * COMPLETELY ISOLATED from WKG and Other KGs.
 * Used by Drive Engine (Self Evaluation) and Learning (self-reflection).
 *
 * SCHEMA (examples, not exhaustive):
 * - Node: BELIEF (what I believe about myself)
 * - Node: CAPABILITY (what I can do)
 * - Node: LIMITATION (what I cannot do)
 * - Node: PREFERENCE (what I like/dislike)
 * - Edge: CONFLICTS_WITH (two beliefs in tension)
 * - Edge: SUPPORTS (one belief supports another)
 */
export interface ISelfKgService {
  /**
   * Get current self-model (entire KG(Self) as a snapshot).
   *
   * @returns All nodes and edges in Self KG, organized by type
   *
   * @remarks
   * Used at the start of Self Evaluation tick in Drive Engine.
   * Caches aggressively (updates every N seconds at most).
   */
  getCurrentModel(): Promise<SelfKgSnapshot>;

  /**
   * Update a self-concept node.
   *
   * @param conceptId - BELIEF_*, CAPABILITY_*, etc.
   * @param updates - Properties to merge
   *
   * @emits SELF_CONCEPT_UPDATED event to TimescaleDB
   *
   * @remarks
   * Called by Learning subsystem when processing corrections or self-observations.
   * Also called by Drive Engine when updating self-evaluation baseline.
   */
  updateSelfConcept(
    conceptId: string,
    updates: Record<string, any>,
  ): Promise<void>;

  /**
   * Create a new conflict edge between two self-concepts.
   *
   * @param fromConceptId - First belief/capability
   * @param toConceptId - Second belief/capability
   * @param conflictType - "DIRECT_CONFLICT", "TENSION", "SUPPORTS"
   * @param strength - How strong (0-1)
   *
   * @remarks
   * Triggers Drive Engine re-evaluation on high-strength conflicts.
   */
  recordConflict(
    fromConceptId: string,
    toConceptId: string,
    conflictType: string,
    strength: number,
  ): Promise<void>;

  /**
   * Query self-concepts by type or pattern.
   *
   * @param filter - Type, keyword, etc.
   *
   * @returns Matching concepts
   *
   * @remarks
   * Used by Communication to generate authentic responses.
   * Drive Engine uses this to detect depressive attractor patterns (all nodes < 0.5 valence).
   */
  queryConcepts(filter: SelfKgFilter): Promise<SelfConcept[]>;
}
```

### 2.3 IOtherKgService

```typescript
/**
 * Other Knowledge Graphs — models of people (Person_Jim, etc.).
 *
 * ONE INSTANCE PER PERSON. Completely isolated from each other and from WKG/Self KG.
 *
 * SCHEMA (examples):
 * - Node: BELIEF (what I think this person believes)
 * - Node: PREFERENCE (what I think they like/dislike)
 * - Node: CAPABILITY (what I think they can do)
 * - Edge: TAUGHT_ME (this person taught me X)
 * - Edge: CORRECTED_ME (this person corrected my understanding of X)
 */
export interface IOtherKgService {
  /**
   * Get or create the knowledge graph for a specific person.
   *
   * @param personId - "Person_Jim", "Person_Alice", etc.
   *
   * @returns The person's KG snapshot (may be empty on first call)
   *
   * @remarks
   * Creates a new Grafeo instance if person doesn't exist yet.
   * Subsequent calls return the same instance.
   */
  getPersonGraph(personId: string): Promise<PersonKgSnapshot>;

  /**
   * Query a person's model by concept type or pattern.
   *
   * @param personId - Who are we modeling?
   * @param filter - Type, keyword, etc.
   *
   * @returns Matching concepts from their model
   *
   * @remarks
   * Used by Communication to understand person state before response generation.
   * Used by Learning to track what we've learned about this person.
   */
  queryPersonModel(
    personId: string,
    filter: OtherKgFilter,
  ): Promise<PersonConcept[]>;

  /**
   * Update the model of a person based on observation or guardian input.
   *
   * @param personId - Who are we learning about?
   * @param conceptId - What concept are we updating?
   * @param updates - Properties to merge
   *
   * @emits PERSON_CONCEPT_UPDATED event to TimescaleDB
   *
   * @remarks
   * Called by Learning subsystem after parsing guardian input.
   * Example: guardian says "I like coffee" -> update Person_Jim concept PREFERENCE_coffee
   */
  updatePersonModel(
    personId: string,
    conceptId: string,
    updates: Record<string, any>,
  ): Promise<void>;

  /**
   * Record that a person taught or corrected us on something.
   *
   * @param personId - Who taught us?
   * @param contentNodeId - What did they teach? (reference to WKG node if applicable)
   * @param relationshipType - "TAUGHT_ME" or "CORRECTED_ME"
   *
   * @remarks
   * Updates BOTH the Other KG (record they taught us)
   * AND increments a weighted GUARDIAN_FEEDBACK signal in their model.
   *
   * Used by Drive Engine to apply Guardian Asymmetry (2x/3x weight).
   */
  recordGuardianFeedback(
    personId: string,
    contentNodeId: string | null,
    relationshipType: 'TAUGHT_ME' | 'CORRECTED_ME',
  ): Promise<void>;
}
```

### 2.4 IConfidenceService

```typescript
/**
 * ACT-R confidence wrapping service.
 *
 * Pure function: confidence computation happens in shared/types/confidence.types.ts
 * This service wraps it with retrieval tracking and caching.
 */
export interface IConfidenceService {
  /**
   * Compute current confidence for a knowledge node.
   *
   * @param nodeId - Which node?
   * @param baseConfidence - From node.baseConfidence (SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, etc.)
   * @param retrievalCount - Number of successful retrieval-and-use events
   * @param lastRetrievalHoursAgo - Time decay factor
   *
   * @returns Current confidence (0-1), clamped to ceiling if needed
   *
   * @remarks
   * Formula: min(1.0, base + 0.12*ln(count) - d*ln(hours+1))
   *
   * Ceiling enforcement: if retrievalCount === 0, return min(0.60, computed)
   *
   * This is a pure function; use it in queries, in WkgService.findNode(),
   * in Decision Making's retrieval flow.
   */
  compute(
    nodeId: string,
    baseConfidence: number,
    retrievalCount: number,
    lastRetrievalHoursAgo: number,
  ): Promise<number>;

  /**
   * Record that a node was used. Increments retrieval count, resets decay timer.
   *
   * Delegates to WkgService.recordRetrievalAndUse() so the WKG is source of truth.
   *
   * @param nodeId - Which node
   * @param context - Where/how was it used
   */
  recordUse(nodeId: string, context: RetrievalContext): Promise<void>;

  /**
   * Check if a node violates the Confidence Ceiling (Immutable Standard 3).
   *
   * @param nodeId - Which node to check
   *
   * @returns { violates: boolean, current: number, ceiling: number }
   *
   * @remarks
   * Violation = retrievalCount === 0 AND computed confidence > 0.60
   * This should never happen if upsertNode() enforces it, but serves as a safety check.
   */
  checkCeiling(nodeId: string): Promise<ConfidenceCeilingCheckResult>;

  /**
   * Get decay rate for a provenance type.
   *
   * @param provenance - The knowledge source
   *
   * @returns Decay rate (0-1, tunable per source)
   *
   * @remarks
   * SENSOR might decay slower than LLM_GENERATED.
   * Values stored in shared/config/PROVENANCE_DECAY_RATES.
   */
  getDecayRate(provenance: ProvenanceSource): number;
}
```

---

## 3. NestJS Wiring

### 3.1 KnowledgeModule Declaration

```typescript
// src/knowledge/knowledge.module.ts
import { Module } from '@nestjs/common';
import { KnowledgeModule as KnowledgeModuleExports } from './index';

@Module({
  imports: [
    // Only imports ConfigModule (for database config)
    // Does NOT import EventsModule (avoid circular dependencies)
    // Emits events via injected EventsService if needed
  ],
  providers: [
    neo4jDriverProvider,
    selfKgGrafeoProvider,
    otherKgGrafeoRegistryProvider,
    wkgServiceProvider,
    selfKgServiceProvider,
    otherKgServiceProvider,
    confidenceServiceProvider,
    provenanceGuardProvider,
    confidenceCeilingGuardProvider,
  ],
  exports: [
    WKG_SERVICE,
    SELF_KG_SERVICE,
    OTHER_KG_SERVICE,
    CONFIDENCE_SERVICE,
    // Do NOT export concrete classes or internal services
    // Do NOT export NEO4J_DRIVER or GRAFEO instances directly
  ],
})
export class KnowledgeModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(NEO4J_DRIVER) private neo4jDriver: Driver,
    @Inject(SELF_KG_GRAFEO) private selfKg: Grafeo,
    @Inject(OTHER_KG_GRAFEO_REGISTRY)
    private otherKgRegistry: Map<string, Grafeo>,
    private logger: Logger,
  ) {}

  /**
   * Initialize: verify connectivity, set up constraints, schema.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('KnowledgeModule initializing...');

    // Verify Neo4j connectivity and set up constraints
    await this.setupNeo4jConstraints();

    // Verify Grafeo (Self KG) and set up schema
    await this.setupSelfKgSchema();

    this.logger.log('KnowledgeModule ready');
  }

  /**
   * Cleanup: close Neo4j driver.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('KnowledgeModule destroying...');
    await this.neo4jDriver.close();
    // Grafeo instances clean up their own resources
    this.logger.log('KnowledgeModule destroyed');
  }

  private async setupNeo4jConstraints(): Promise<void> {
    const session = this.neo4jDriver.session();
    try {
      // Ensure node ID uniqueness
      await session.run(
        `CREATE CONSTRAINT IF NOT EXISTS FOR (n:WKGNode)
         REQUIRE n.nodeId IS UNIQUE`,
      );
      // Ensure edge uniqueness (from, to, type)
      await session.run(
        `CREATE CONSTRAINT IF NOT EXISTS FOR ()-[r:RELATES_TO]-()
         REQUIRE r.edgeId IS UNIQUE`,
      );
      this.logger.log('Neo4j constraints verified');
    } finally {
      await session.close();
    }
  }

  private async setupSelfKgSchema(): Promise<void> {
    // Grafeo doesn't enforce schema upfront, but we document the structure
    // for Self KG (separate from WKG schema)
    this.logger.log('Self KG schema documented in self-kg.schema.ts');
  }
}
```

### 3.2 Provider Patterns

#### Neo4j Driver Factory

```typescript
// src/knowledge/knowledge.providers.ts
import neo4j, { Driver } from 'neo4j-driver';

export const NEO4J_DRIVER = Symbol('NEO4J_DRIVER');

export const neo4jDriverProvider: FactoryProvider<Driver> = {
  provide: NEO4J_DRIVER,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Driver> => {
    const neo4jConfig = configService.get('neo4j', { infer: true });
    const driver = neo4j.driver(
      neo4jConfig.uri,
      neo4j.auth.basic(neo4jConfig.username, neo4jConfig.password),
      {
        maxConnectionPoolSize: neo4jConfig.maxConnectionPoolSize || 50,
        logging: {
          level: 'debug',
          log: (level, msg) => logger.debug(`[Neo4j ${level}] ${msg}`),
        },
      },
    );
    try {
      await driver.verifyConnectivity();
      logger.log(`Neo4j driver connected to ${neo4jConfig.uri}`);
    } catch (error) {
      logger.error('Neo4j connectivity failed', error);
      throw new DatabaseConnectionError(
        'Neo4j',
        error instanceof Error ? error.message : String(error),
      );
    }
    return driver;
  },
  inject: [ConfigService, Logger],
};
```

#### Grafeo Self KG Instance

```typescript
export const SELF_KG_GRAFEO = Symbol('SELF_KG_GRAFEO');

export const selfKgGrafeoProvider: FactoryProvider<Grafeo> = {
  provide: SELF_KG_GRAFEO,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Grafeo> => {
    const grafeoConfig = configService.get('grafeo', { infer: true });

    // Grafeo is embedded; instantiate directly
    const selfKg = new Grafeo({
      dataDir: grafeoConfig.dataDirSelfKg, // e.g., /data/grafeo/self-kg
      memoryLimit: grafeoConfig.memoryLimit || 512, // MB
    });

    try {
      await selfKg.initialize();
      logger.log('Self KG (Grafeo) initialized');
    } catch (error) {
      logger.error('Self KG initialization failed', error);
      throw new DatabaseConnectionError(
        'Grafeo (Self KG)',
        error instanceof Error ? error.message : String(error),
      );
    }
    return selfKg;
  },
  inject: [ConfigService, Logger],
};
```

#### Grafeo Other KG Registry

```typescript
export const OTHER_KG_GRAFEO_REGISTRY = Symbol('OTHER_KG_GRAFEO_REGISTRY');

export const otherKgGrafeoRegistryProvider: FactoryProvider<
  Map<string, Grafeo>
> = {
  provide: OTHER_KG_GRAFEO_REGISTRY,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Map<string, Grafeo>> => {
    const grafeoConfig = configService.get('grafeo', { infer: true });
    const registry = new Map<string, Grafeo>();

    // Attempt to load any existing person graphs from disk
    // If none found, map is empty and graphs are created on-demand
    try {
      // List subdirectories in dataDirOtherKgs
      const fs = await import('fs/promises');
      const entries = await fs.readdir(grafeoConfig.dataDirOtherKgs, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const personId = entry.name;
          const personGrafeo = new Grafeo({
            dataDir: `${grafeoConfig.dataDirOtherKgs}/${personId}`,
            memoryLimit: grafeoConfig.memoryLimit || 256,
          });
          await personGrafeo.initialize();
          registry.set(personId, personGrafeo);
          logger.log(`Loaded Other KG for ${personId}`);
        }
      }
    } catch (error) {
      // Directory may not exist yet; that's fine
      logger.log('No pre-existing Other KGs found (will be created on-demand)');
    }

    return registry;
  },
  inject: [ConfigService, Logger],
};
```

#### Service Providers

```typescript
export const WKG_SERVICE = Symbol('WKG_SERVICE');

export const wkgServiceProvider: Provider = {
  provide: WKG_SERVICE,
  useClass: WkgService,
  inject: [NEO4J_DRIVER, EVENTS_SERVICE, CONFIDENCE_SERVICE],
};

export const SELF_KG_SERVICE = Symbol('SELF_KG_SERVICE');

export const selfKgServiceProvider: Provider = {
  provide: SELF_KG_SERVICE,
  useClass: SelfKgService,
  inject: [SELF_KG_GRAFEO, EVENTS_SERVICE],
};

export const OTHER_KG_SERVICE = Symbol('OTHER_KG_SERVICE');

export const otherKgServiceProvider: Provider = {
  provide: OTHER_KG_SERVICE,
  useClass: OtherKgService,
  inject: [OTHER_KG_GRAFEO_REGISTRY, EVENTS_SERVICE],
};

export const CONFIDENCE_SERVICE = Symbol('CONFIDENCE_SERVICE');

export const confidenceServiceProvider: Provider = {
  provide: CONFIDENCE_SERVICE,
  useClass: ConfidenceService,
  inject: [WKG_SERVICE],
};
```

### 3.3 Grafeo Lifecycle Management

**Key challenge:** Grafeo is embedded (not a network service), so each instance must be explicitly managed.

**Solution:**
- One instance per Self KG (shared)
- One instance per Other KG (created on-demand, cached in registry)
- Instances clean up in module destroy or when module reference is garbage collected

```typescript
// src/knowledge/services/other-kg/other-kg.service.ts
export class OtherKgService implements IOtherKgService {
  constructor(
    @Inject(OTHER_KG_GRAFEO_REGISTRY)
    private registry: Map<string, Grafeo>,
  ) {}

  async getPersonGraph(personId: string): Promise<PersonKgSnapshot> {
    let personGrafeo = this.registry.get(personId);
    if (!personGrafeo) {
      // Create on-demand
      personGrafeo = await this.createPersonGrafeo(personId);
      this.registry.set(personId, personGrafeo);
    }
    return this.snapshotGraph(personGrafeo);
  }

  private async createPersonGrafeo(personId: string): Promise<Grafeo> {
    const grafeoConfig = configService.get('grafeo');
    const personGrafeo = new Grafeo({
      dataDir: `${grafeoConfig.dataDirOtherKgs}/${personId}`,
      memoryLimit: grafeoConfig.memoryLimit || 256,
    });
    await personGrafeo.initialize();
    return personGrafeo;
  }
}
```

---

## 4. Cross-Module Coordination

### 4.1 Which Modules Import KnowledgeModule

| Module | Imports | Access | Reason |
|--------|---------|--------|--------|
| DecisionMakingModule | Yes | WKG_SERVICE, CONFIDENCE_SERVICE | Retrieve Type 1 reflexes, record retrieval-and-use |
| CommunicationModule | Yes | WKG_SERVICE, CONFIDENCE_SERVICE, OTHER_KG_SERVICE | Get context for response generation, understand person model |
| LearningModule | Yes | WKG_SERVICE, CONFIDENCE_SERVICE, SELF_KG_SERVICE, OTHER_KG_SERVICE | Upsert entities, refine edges, update self/other models |
| DriveEngineModule | Yes | SELF_KG_SERVICE, CONFIDENCE_SERVICE | Self-evaluation, check confidence levels |
| PlanningModule | Yes | WKG_SERVICE, CONFIDENCE_SERVICE | Query patterns, propose procedures |
| EventsModule | No | (exports IEventService, doesn't import Knowledge) | Avoid circular dependency |

### 4.2 Event Emission (TimescaleDB Coordination)

KnowledgeModule emits events to EventsModule via dependency injection, but does NOT import EventsModule (prevents circular dependency):

```typescript
// src/knowledge/services/wkg/wkg.service.ts
export class WkgService implements IWkgService {
  constructor(
    @Inject(NEO4J_DRIVER) private driver: Driver,
    @Inject(EVENTS_SERVICE) private eventsService: IEventService,
    @Inject(CONFIDENCE_SERVICE) private confidenceService: IConfidenceService,
  ) {}

  async upsertNode(
    nodeId: string,
    attributes: NodeAttributes,
    provenance: ProvenanceSource,
    baseConfidence?: number,
  ): Promise<KnowledgeNode> {
    // Validate provenance (guard)
    if (!provenance) {
      throw new ProvenanceRequiredError('upsertNode requires provenance');
    }

    // Compute initial confidence
    const confidence = baseConfidence ?? PROVENANCE_BASE_CONFIDENCE[provenance];

    // Neo4j transaction
    const session = this.driver.session();
    try {
      const node = await session.run(
        `MERGE (n:WKGNode {nodeId: $nodeId})
         SET n.label = $label,
             n.properties = $properties,
             n.provenance = $provenance,
             n.baseConfidence = $baseConfidence,
             n.confidence = $confidence,
             n.createdAt = CASE WHEN n.createdAt IS NULL THEN datetime() ELSE n.createdAt END,
             n.lastUpdated = datetime()
         RETURN n`,
        {
          nodeId,
          label: attributes.label,
          properties: JSON.stringify(attributes.properties || {}),
          provenance,
          baseConfidence: confidence,
          confidence: Math.min(0.60, confidence), // Ceiling enforcement
        },
      );

      // Emit event (fire-and-forget to prevent blocking)
      this.eventsService.record({
        eventType: 'KNOWLEDGE_NODE_UPSERTED',
        subsystem: 'knowledge',
        timestamp: new Date(),
        data: {
          nodeId,
          provenance,
          confidence: Math.min(0.60, confidence),
        },
      }).catch((err) => {
        // Log but don't throw
        console.error('Failed to emit KNOWLEDGE_NODE_UPSERTED event', err);
      });

      return this.resultToKnowledgeNode(node.records[0]);
    } finally {
      await session.close();
    }
  }
}
```

**Event types emitted from Knowledge:**
- `KNOWLEDGE_NODE_UPSERTED` — Node created/updated
- `KNOWLEDGE_EDGE_UPSERTED` — Edge created/updated
- `KNOWLEDGE_RETRIEVAL_AND_USE` — Node was used in decision
- `CONTRADICTION_DETECTED` — Node conflicts with existing knowledge
- `SELF_CONCEPT_UPDATED` — Self KG concept changed
- `PERSON_CONCEPT_UPDATED` — Other KG concept changed

---

## 5. Isolation Enforcement

### 5.1 Type-Level Guarantees

**Self KG schema is completely separate from WKG schema:**

```typescript
// src/knowledge/services/self-kg/self-kg.schema.ts
export enum SelfConcept {
  BELIEF = 'BELIEF',
  CAPABILITY = 'CAPABILITY',
  LIMITATION = 'LIMITATION',
  PREFERENCE = 'PREFERENCE',
}

export enum SelfEdgeType {
  CONFLICTS_WITH = 'CONFLICTS_WITH',
  SUPPORTS = 'SUPPORTS',
  LEARNED_VIA = 'LEARNED_VIA',
}

// src/knowledge/services/wkg/wkg.schema.ts (implied)
export enum WkgNodeType {
  ENTITY = 'ENTITY',
  ACTION = 'ACTION',
  PROCEDURE = 'PROCEDURE',
  // ... domain-specific types
}

export enum WkgEdgeType {
  IS_A = 'IS_A',
  CONTAINS = 'CONTAINS',
  CAN_PRODUCE = 'CAN_PRODUCE',
  // ... domain-specific types
}
```

Self KG services accept **only** SelfConcept node types. WKG services accept WkgNodeType. No cross-contamination at the type level.

### 5.2 Runtime Isolation

**Grafeo instances are isolated by the registry:**

```typescript
// Each person gets their own Grafeo instance
const selfKgGrafeo = registry.get('SELF_KG'); // Shared, read by Drive/Learning
const jimKgGrafeo = registry.get('Person_Jim'); // Jim's model, isolated
const aliceKgGrafeo = registry.get('Person_Alice'); // Alice's model, isolated

// No shared edges between them
// No leaking of one person's model into another's
// Data at rest is separate (separate Grafeo dataDir on disk)
```

### 5.3 Neo4j Constraints

```cypher
-- Ensure every WKG node has provenance
CREATE CONSTRAINT IF NOT EXISTS FOR (n:WKGNode)
REQUIRE n.provenance IS NOT NULL;

-- Ensure every edge has provenance
CREATE CONSTRAINT IF NOT EXISTS FOR ()-[r:RELATES_TO]-()
REQUIRE r.provenance IS NOT NULL;

-- Node ID uniqueness
CREATE CONSTRAINT IF NOT EXISTS FOR (n:WKGNode)
REQUIRE n.nodeId IS UNIQUE;
```

---

## 6. Error Handling

Domain-specific exceptions:

```typescript
// src/knowledge/exceptions/knowledge.exceptions.ts
export class KnowledgeException extends SylphieException {
  constructor(message: string) {
    super(message, 'KNOWLEDGE');
  }
}

export class NodeNotFoundError extends KnowledgeException {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
  }
}

export class ProvenanceRequiredError extends KnowledgeException {
  constructor(operation: string) {
    super(`Provenance required for ${operation}`);
  }
}

export class ConfidenceCeilingViolation extends KnowledgeException {
  constructor(nodeId: string, computed: number) {
    super(
      `Confidence ceiling violated: ${nodeId} exceeds 0.60 without retrieval (computed: ${computed})`,
    );
  }
}

export class GrafeoUnavailableError extends KnowledgeException {
  constructor(instance: string, error: Error) {
    super(`Grafeo (${instance}) unavailable: ${error.message}`);
  }
}

export class ContradictionDetectedError extends KnowledgeException {
  constructor(nodeId: string, conflictingSide: string) {
    super(`Contradiction at ${nodeId}: ${conflictingSide}`);
  }
}
```

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Grafeo unavailable or unstable** | Self/Other KGs can't initialize | Validate Grafeo exists as a mature library in E1. If not, have fallback: SQLite + custom graph abstraction (lower performance, still isolated) |
| **Neo4j transaction conflicts** | Multiple writes to same node stomp each other | Use Neo4j's MERGE + atomic SET operations. Document transaction isolation level. Test concurrent writes in E3 ticket 3.3 |
| **Confidence computation bugs** | Mispredicts when knowledge is reliable | Pure function in shared (E0), testable independently. Guards in upsertNode catch ceiling violations. Check tests in E3 |
| **Provenance enforcement bypass** | Knowledge without provenance enters graph | Guards run at every write boundary. Type-check enforces required parameter. No alternative code paths |
| **Circular dependency (EventsModule import)** | Can't compile | KnowledgeModule injects IEventService, doesn't import EventsModule. EventsModule exports interface only |
| **Grafeo memory leak** | Other KG instances grow indefinitely | Monitor registry size. Implement person graph cleanup (LRU cache or explicit eviction). Document in README |
| **Neo4j session leaks** | Connection pool exhausted | Every WkgService method uses try/finally to close sessions. NestJS Logger will warn on unclosed resources |
| **Confidence cache staleness** | Uses outdated confidence in decisions | Don't cache; compute fresh on every read (confidence is derived from 3 inputs: base, count, hours). Cost is acceptable |

---

## 8. Ticket Breakdown

### Epic 3.0: Foundation & Types
**Depends on:** E0 (interfaces are stubs), E1 (Neo4j + Grafeo connections ready), E2 (TimescaleDB ready)
**Delivers:** All knowledge types, guards, exceptions
**Effort:** 1-2 days

**Deliverables:**
- `src/knowledge/types/graph-node.types.ts` — KnowledgeNode, NodeAttributes, NodeFilter
- `src/knowledge/types/graph-edge.types.ts` — KnowledgeEdge, EdgeAttributes, EdgeQueryFilter, ContextSubgraph
- `src/knowledge/types/contradiction.types.ts` — Contradiction, ContradictionEvent
- `src/knowledge/types/confidence.types.ts` — RetrievalContext, ConfidenceSnapshot
- `src/knowledge/guards/provenance.guard.ts` — Validate every write
- `src/knowledge/guards/confidence-ceiling.guard.ts` — Enforce 0.60 ceiling
- `src/knowledge/exceptions/knowledge.exceptions.ts` — All domain exceptions
- `src/knowledge/knowledge.module.ts` — Module declaration (with lifecycle)
- `src/knowledge/knowledge.providers.ts` — All 4 factory providers
- `src/knowledge/index.ts` — Barrel export

**Verification:**
- `npx tsc --noEmit` passes
- Guards instantiate without error
- Exceptions have correct message formatting

---

### Epic 3.1: World Knowledge Graph (WkgService)
**Depends on:** E3.0
**Delivers:** Real WkgService implementation backed by Neo4j
**Effort:** 3-4 days

**Deliverables:**
- `src/knowledge/services/wkg/wkg.service.ts` — Full IWkgService implementation
  - `upsertNode()` with provenance + ceiling enforcement
  - `findNode()` with confidence computation
  - `upsertEdge()` with conflict detection
  - `queryEdges()` with filtering
  - `queryContext()` with subgraph retrieval
  - `recordRetrievalAndUse()` with TimescaleDB emission
  - `checkContradiction()` with Learning coordination
- `src/knowledge/services/wkg/wkg-queries.ts` — Cypher query builders (separate file for clarity)
- Neo4j constraint setup in KnowledgeModule.onModuleInit()
- Error handling: NodeNotFoundError, ConfidenceCeilingViolation, ContradictionDetected
- Integration tests: CRUD on nodes/edges, confidence mechanics, contradiction detection

**Verification:**
- Boot app, verify Neo4j constraints created
- Call upsertNode() -> node appears in Neo4j
- Call findNode() -> node is fetched, confidence computed
- Call recordRetrievalAndUse() -> event emitted to TimescaleDB
- Call checkContradiction() on conflict -> event emitted, no crash
- Attempt write without provenance -> ProvenanceRequiredError

---

### Epic 3.2: Self Knowledge Graph (SelfKgService)
**Depends on:** E3.0
**Delivers:** Real SelfKgService implementation backed by Grafeo
**Effort:** 2-3 days

**Deliverables:**
- `src/knowledge/services/self-kg/self-kg.service.ts` — Full ISelfKgService implementation
  - `getCurrentModel()` with caching
  - `updateSelfConcept()` with TimescaleDB emission
  - `recordConflict()` with drive re-evaluation trigger
  - `queryConcepts()` with filtering
- `src/knowledge/services/self-kg/self-kg.schema.ts` — Schema docs + enum definitions
- Grafeo instance initialization in KnowledgeModule
- Integration tests: concept CRUD, conflict detection, Drive Engine integration

**Verification:**
- Boot app, verify Grafeo Self KG initialized
- updateSelfConcept() -> concept updated in Grafeo
- recordConflict() -> event emitted, no crash
- getCurrentModel() -> returns snapshot with all concepts
- Attempt to update non-existent concept -> auto-creates (Grafeo behavior)

---

### Epic 3.3: Other Knowledge Graphs (OtherKgService)
**Depends on:** E3.0
**Delivers:** Real OtherKgService implementation with per-person Grafeo registry
**Effort:** 2-3 days

**Deliverables:**
- `src/knowledge/services/other-kg/other-kg.service.ts` — Full IOtherKgService implementation
  - `getPersonGraph()` with on-demand instance creation
  - `queryPersonModel()` with filtering
  - `updatePersonModel()` with TimescaleDB emission
  - `recordGuardianFeedback()` with weight tracking
- `src/knowledge/services/other-kg/other-kg.registry.ts` — Registry management (Map + Grafeo lifecycle)
- `src/knowledge/services/other-kg/other-kg.schema.ts` — Schema docs
- Registry initialization and cleanup in KnowledgeModule
- Integration tests: multi-person models, isolation guarantee, feedback tracking

**Verification:**
- Boot app, verify registry ready (empty or pre-loaded)
- Call getPersonGraph('Person_Jim') -> instance created or loaded
- Call getPersonGraph('Person_Alice') -> separate instance, no data leakage
- recordGuardianFeedback() -> TAUGHT_ME or CORRECTED_ME edge created
- Verify Jim's graph doesn't contain Alice's concepts

---

### Epic 3.4: Confidence Service & ACT-R Integration
**Depends on:** E3.0, E3.1
**Delivers:** Real ConfidenceService wrapping ACT-R formula
**Effort:** 1-2 days

**Deliverables:**
- `src/knowledge/services/confidence/confidence.service.ts` — Full IConfidenceService implementation
  - `compute()` delegates to shared pure function
  - `recordUse()` delegates to WkgService
  - `checkCeiling()` validates Immutable Standard 3
  - `getDecayRate()` returns per-provenance rates
- Integration with WkgService.findNode() -> confidence computed on every retrieval
- Integration with upsertNode() -> ceiling enforced at write time
- Unit tests: confidence formula (shared, not here), ceiling violations, decay rates

**Verification:**
- Confidence computation matches expected values (test against shared formula)
- Node with count=0 capped at 0.60
- Node with count=5 exceeds 0.60 (confidence grows)
- Decay applied correctly (older nodes lose confidence)

---

### Epic 3.5: Integration & Cross-Module Wiring
**Depends on:** E3.1-3.4
**Delivers:** Full KnowledgeModule functioning with all subsystem imports
**Effort:** 1-2 days

**Deliverables:**
- Update DecisionMakingModule to import WKG_SERVICE, record retrieval-and-use
- Update CommunicationModule to import WKG_SERVICE, OTHER_KG_SERVICE for context
- Update LearningModule to import all knowledge services
- Update DriveEngineModule to import SELF_KG_SERVICE
- Update PlanningModule to import WKG_SERVICE
- Verify no circular dependencies (npx tsc --noEmit)
- End-to-end tests: parse input -> query WKG -> generate response -> record use -> Learning consolidates

**Verification:**
- `npx tsc --noEmit` zero errors
- App boots with all 8 modules initialized
- Decision Making can retrieve and record use
- Learning can upsert nodes without circular import
- No TypeScript errors in imports

---

### Epic 3.6: Testing & Documentation
**Depends on:** E3.5
**Delivers:** Comprehensive tests, README, examples
**Effort:** 1-2 days

**Deliverables:**
- Unit tests: each service isolated (mock dependencies)
- Integration tests: full flow (Neo4j + Grafeo + TimescaleDB + EventsModule)
- `src/knowledge/README.md` — Usage guide, schema examples, common queries
- Example: "How do I upsert a node with provenance?"
- Example: "How do I query context for response generation?"
- Example: "How do I update my self-model?"
- Error handling guide: what to do on each exception type

**Verification:**
- Test coverage >80% for services
- README examples run without modification
- Team can understand module at a glance

---

## 9. Known Limitations & Future Considerations

### 9.1 Grafeo Risk

Grafeo is critical to Epic 3 but may not exist as a mature library. If unavailable:

**Fallback Plan (E1 decision, blocks E3):**
1. Use SQLite with custom graph abstraction layer (simpler than Grafeo but still isolated)
2. Store Self KG: `self_kg.db` with tables `nodes` (id, concept_type, properties) and `edges`
3. Store Other KGs: `other_kg_{personId}.db` with same schema
4. Implement minimal Grafeo-like interface (query(), upsert(), etc.)
5. Performance hit acceptable for Phase 1 (volume is low)
6. Migration path to real Grafeo in Phase 2 if library stabilizes

### 9.2 Neo4j Session Management

Currently opens a session per operation. For high-frequency operations (Decision Making), consider:
- Session pooling in WkgService (lazy instantiation, reuse)
- Batch operations (upsert 5 nodes in one transaction)
- But for now, simple one-session-per-call is safer

### 9.3 Confidence Caching

Confidence is derived from 3 inputs (base, count, hours). Don't cache; compute fresh every read.
- Cost: small Neo4j query per findNode()
- Benefit: always current, no stale data bugs
- If profiling shows bottleneck, add caching in E3.4

### 9.4 Contradiction Detection

Currently returns contradiction or null. Could be enhanced:
- Severity levels (DIRECT_CONFLICT vs. TENSION)
- Resolution suggestions (merge nodes? separate concepts?)
- For Phase 1, simple binary detection sufficient

---

## 10. Summary

Epic 3 is the Knowledge Module, the brain of Sylphie. Key points:

1. **Module structure** enforces isolation: concrete classes not exported, all access via DI tokens
2. **Interface refinement** specifies every method with edge cases, provenance requirements, event emissions
3. **NestJS wiring** uses factory providers for async initialization, OnModuleInit/Destroy for setup/cleanup
4. **Cross-module coordination** via TimescaleDB events (never circular imports)
5. **Isolation enforcement** at type level (separate schemas) and runtime (Grafeo instances)
6. **Error handling** with domain-specific exceptions, guards on every write
7. **Ticket sequencing** foundation → WKG → Self KG → Other KGs → Confidence → Integration → Testing
8. **Risks** center on Grafeo maturity, Neo4j transaction patterns, and cache invalidation (all mitigable)

This module is the first subsystem to have a real implementation after E0/E1/E2. Its success determines whether the rest of the system can function.

