# Infer PKG Connections

Analyze the Codebase PKG graph to discover cross-cutting patterns, architectural layers, hubs, pipelines, dead code, and circular dependencies. Writes discovered relationships and annotations back to the graph.

## Usage

```
/infer-pkg-connections                     # Run all analyses
/infer-pkg-connections --analysis hubs     # Only run hub detection
/infer-pkg-connections --analysis pipelines
/infer-pkg-connections --analysis bridges
/infer-pkg-connections --analysis cycles
/infer-pkg-connections --analysis dead-code
/infer-pkg-connections --analysis layers
/infer-pkg-connections --dry-run           # Report only, no graph writes
```

## Prerequisites

1. Codebase PKG Neo4j running on `bolt://localhost:7691`
2. PKG has been seeded (`npm run seed-pkg` from packages/sylphie-pkg)
3. Domain classification has been run (`/classify-pkg-domains`)

## Connection Details

- **Neo4j**: `bolt://localhost:7691`, user `neo4j`, password `sylphie-pkg-local`
- **Container**: `sylphie-neo4j-pkg`
- Run Cypher via: `docker exec sylphie-neo4j-pkg cypher-shell -u neo4j -p sylphie-pkg-local "<query>"`
- Or use the neo4j-driver npm package directly

---

## Analyses

### 1. Hub Detection (`hubs`)

Find functions and types with unusually high connectivity — these are architectural load-bearing nodes.

**Query strategy:**
```cypher
// Functions with most incoming CALLS
MATCH (f:Function)<-[:CALLS]-(caller:Function)
WITH f, count(caller) AS inDegree
WHERE inDegree >= 3
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain, inDegree
ORDER BY inDegree DESC
LIMIT 30

// Types with most USES_TYPE references
MATCH (t:Type)<-[:USES_TYPE]-(f:Function)
WITH t, count(f) AS usageCount
WHERE usageCount >= 3
RETURN t.name AS name, t.filePath AS filePath, t.kind AS kind, usageCount
ORDER BY usageCount DESC
LIMIT 30
```

**Write back:**
```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.hubScore = $score, f.hubKind = 'function-hub'
```

Classify hubs:
- **Utility hub**: called by many packages, usually in `shared` — healthy
- **God function**: called by many AND calls many — may need decomposition
- **Contract type**: interface/type used across 3+ packages — critical to keep stable

### 2. Pipeline Detection (`pipelines`)

Find chains of CALLS edges that form processing pipelines (A→B→C→D).

**Query strategy:**
```cypher
// Find chains of length 3+
MATCH path = (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function)-[:CALLS]->(d:Function)
WHERE a.filePath <> b.filePath OR b.filePath <> c.filePath
RETURN [n IN nodes(path) | n.name] AS chain,
       [n IN nodes(path) | n.filePath] AS files,
       length(path) AS depth
ORDER BY depth DESC
LIMIT 20
```

**Write back:** Create `DATA_FLOWS_TO` edges along discovered pipelines:
```cypher
MATCH (a:Function {filePath: $aFile, name: $aName})
MATCH (b:Function {filePath: $bFile, name: $bName})
MERGE (a)-[r:DATA_FLOWS_TO]->(b)
SET r.pipelineName = $pipelineName, r.discoveredAt = timestamp()
```

Name pipelines by their domain context (e.g., "tick-processing-pipeline", "learning-consolidation-pipeline").

### 3. Cross-Package Bridge Detection (`bridges`)

Find functions that create dependencies between packages.

**Query strategy:**
```cypher
// Functions in one package that call functions in another
MATCH (caller:Function)-[:CALLS]->(callee:Function)
MATCH (cm:Module)-[:CONTAINS]->(caller)
MATCH (tm:Module)-[:CONTAINS]->(callee)
WHERE cm.packageName <> tm.packageName
RETURN cm.packageName AS fromPkg, tm.packageName AS toPkg,
       caller.name AS callerName, callee.name AS calleeName,
       caller.filePath AS callerFile, callee.filePath AS calleeFile
ORDER BY fromPkg, toPkg

// Types that bridge packages (used by functions in different packages than where they're defined)
MATCH (f:Function)-[:USES_TYPE]->(t:Type)
MATCH (fm:Module)-[:CONTAINS]->(f)
MATCH (tm:Module)-[:CONTAINS]->(t)
WHERE fm.packageName <> tm.packageName
RETURN fm.packageName AS consumerPkg, tm.packageName AS providerPkg,
       t.name AS typeName, count(f) AS usageCount
ORDER BY usageCount DESC
```

**Write back:**
```cypher
MATCH (a:Function {filePath: $callerFile, name: $callerName})
MATCH (b:Function {filePath: $calleeFile, name: $calleeName})
MERGE (a)-[r:BRIDGES]->(b)
SET r.fromPackage = $fromPkg, r.toPackage = $toPkg, r.discoveredAt = timestamp()
```

### 4. Circular Dependency Detection (`cycles`)

Find cycles in the CALLS and IMPORTS graphs.

**Query strategy:**
```cypher
// Module-level circular imports (A imports B imports A)
MATCH (a:Module)-[:IMPORTS]->(b:Module)-[:IMPORTS]->(a)
WHERE id(a) < id(b)
RETURN a.filePath AS moduleA, b.filePath AS moduleB

// Function-level call cycles (A calls B calls A)
MATCH (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(a)
WHERE id(a) < id(b)
RETURN a.name AS funcA, a.filePath AS fileA,
       b.name AS funcB, b.filePath AS fileB

// Longer cycles (3-hop)
MATCH path = (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function)-[:CALLS]->(a)
WHERE id(a) < id(b) AND id(b) < id(c)
RETURN [n IN nodes(path) | n.name] AS cycle,
       [n IN nodes(path) | n.filePath] AS files
```

**Write back:** No graph writes — report only. Cycles are a smell, not a relationship to persist.

**Output format:**
```
CIRCULAR DEPENDENCIES DETECTED
===============================
[MODULE CYCLE] drive-engine/services ↔ drive-engine/evaluators
[FUNCTION CYCLE] DriveService.evaluate → SelfEvalService.run → DriveService.evaluate
```

### 5. Dead Code Detection (`dead-code`)

Find functions with no incoming CALLS edges (excluding known entry points).

**Query strategy:**
```cypher
// Functions never called by other functions
MATCH (f:Function)
WHERE NOT EXISTS { MATCH ()-[:CALLS]->(f) }
  AND NOT f.name STARTS WITH 'main'
  AND NOT f.name CONTAINS '.onModuleInit'
  AND NOT f.name CONTAINS '.onModuleDestroy'
  AND NOT f.httpMethod IS NOT NULL  // HTTP endpoints are entry points
  AND NOT f.decorators CONTAINS 'Cron'
  AND NOT f.decorators CONTAINS 'OnEvent'
  AND f.isExported = true  // Only flag exported functions (private ones may be used internally)
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain
ORDER BY f.filePath
```

**Write back:**
```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.possiblyDead = true, f.deadCodeDetectedAt = timestamp()
```

**Important caveats in report:**
- Decorator-driven functions (@Cron, @OnEvent, @Subscribe) are entry points
- Constructor-injected services are entry points
- Test helpers may appear dead but are used in test files
- Flag as "possibly dead" — human review needed

### 6. Architectural Layer Inference (`layers`)

Infer which architectural layer each module belongs to based on call direction patterns.

**Layer heuristic:**
- **Presentation**: Modules with HTTP endpoints (controllers, gateways)
- **Application**: Modules that orchestrate (call into domain but are called by presentation)
- **Domain**: Core business logic modules (called by application, call into infrastructure)
- **Infrastructure**: Modules that interact with storage (Neo4j, Postgres, TimescaleDB clients)

**Query strategy:**
```cypher
// Find modules with HTTP endpoints → presentation layer
MATCH (m:Module)-[:CONTAINS]->(f:Function)
WHERE f.httpMethod IS NOT NULL
RETURN DISTINCT m.filePath AS modulePath, 'presentation' AS layer

// Find modules that directly use storage clients → infrastructure layer
MATCH (m:Module)-[:CONTAINS]->(f:Function)
WHERE f.filePath CONTAINS '/storage/' OR f.filePath CONTAINS '/database/'
   OR f.filePath CONTAINS '/clients/'
RETURN DISTINCT m.filePath AS modulePath, 'infrastructure' AS layer
```

**Write back:**
```cypher
MATCH (m:Module {filePath: $modulePath})
SET m.architecturalLayer = $layer
```

---

## Output Format

After running all analyses, print a summary:

```
PKG INFERENCE REPORT
============================================================
Hub Functions:    N (M god-functions flagged)
Hub Types:        N (M cross-package contract types)
Pipelines:        N discovered
Bridges:          N cross-package connections
Circular Deps:    N cycles detected
Dead Code:        N possibly-dead exported functions
Layer Assignment: N modules classified

New graph elements written:
  hubScore properties:    N
  DATA_FLOWS_TO edges:    N
  BRIDGES edges:          N
  possiblyDead flags:     N
  architecturalLayer:     N
============================================================
```

---

## Key Rules

- **No LLM API calls** — YOU are the analyzer. Use Cypher queries and your judgment.
- Always use parameterized Cypher (never interpolate strings into queries)
- For `--dry-run`, print what WOULD be written but skip all SET/MERGE writes
- Run analyses in order: hubs → pipelines → bridges → cycles → dead-code → layers
- If an analysis produces 0 results, say so and move on (don't treat it as an error)
- Pipeline naming should reflect the domain context, not just "pipeline-1"
- Dead code detection has high false-positive rate — always caveat the results
