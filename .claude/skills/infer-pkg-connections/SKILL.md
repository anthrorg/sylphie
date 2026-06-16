# Infer PKG Connections

Analyze the codebase knowledge graph to discover cross-cutting patterns — hubs, pipelines, cross-package bridges, dead code, circular dependencies, and architectural layers. Writes discovered relationships and annotations back to the graph. No external LLM API call — the active Claude Code session runs Cypher and applies judgment.

## Usage

```
/infer-pkg-connections                       # Run all analyses
/infer-pkg-connections --analysis hubs       # Just hubs
/infer-pkg-connections --analysis pipelines
/infer-pkg-connections --analysis bridges
/infer-pkg-connections --analysis cycles
/infer-pkg-connections --analysis di-calls       # DI-resolved CALLS (run before dead-code)
/infer-pkg-connections --analysis dead-code
/infer-pkg-connections --analysis layers
/infer-pkg-connections --analysis cross-language # Cross-tier REST edges (TS<->Python, frontend->API)
/infer-pkg-connections --analysis ws-events      # WebSocket event-name contracts
/infer-pkg-connections --dry-run             # Report only, no graph writes
```

## Prerequisites

1. Neo4j reachable at `CODEBASE_PKG_NEO4J_URI` (default `bolt://localhost:7687`, user `neo4j`).
2. Graph seeded (`npx codebase-pkg seed`).
3. Domains classified (`/classify-pkg-domains`).

Run Cypher via `cypher-shell` (`docker exec codebase-pkg-neo4j cypher-shell -u neo4j -p codebase-pkg-local "<query>"`) or via the `neo4j-driver` npm package.

---

## Analyses

### 1. Hub Detection (`hubs`)

Find functions and types with unusually high connectivity — architectural load-bearing nodes.

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

Write back:
```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.hubScore = $score, f.hubKind = 'function-hub'
```

Classify hubs in your summary:
- **Utility hub**: called by many packages, usually in shared/utility code — healthy.
- **God function**: called by many AND calls many — may need decomposition.
- **Contract type**: interface/type used across 3+ packages — critical to keep stable.

### 2. Pipeline Detection (`pipelines`)

Find chains of CALLS forming processing pipelines (A→B→C→D).

```cypher
MATCH path = (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function)-[:CALLS]->(d:Function)
WHERE a.filePath <> b.filePath OR b.filePath <> c.filePath
RETURN [n IN nodes(path) | n.name] AS chain,
       [n IN nodes(path) | n.filePath] AS files,
       length(path) AS depth
ORDER BY depth DESC
LIMIT 20
```

Write back as `DATA_FLOWS_TO` edges with a pipeline name derived from the domain context (e.g. "request-handling-pipeline", "auth-validation-pipeline"):

```cypher
MATCH (a:Function {filePath: $aFile, name: $aName})
MATCH (b:Function {filePath: $bFile, name: $bName})
MERGE (a)-[r:DATA_FLOWS_TO]->(b)
SET r.pipelineName = $pipelineName, r.discoveredAt = timestamp()
```

### 3. Cross-Package Bridge Detection (`bridges`)

Find functions and types that create dependencies between packages.

```cypher
MATCH (caller:Function)-[:CALLS]->(callee:Function)
MATCH (cm:Module)-[:CONTAINS]->(caller)
MATCH (tm:Module)-[:CONTAINS]->(callee)
WHERE cm.packageName <> tm.packageName
RETURN cm.packageName AS fromPkg, tm.packageName AS toPkg,
       caller.name AS callerName, callee.name AS calleeName

MATCH (f:Function)-[:USES_TYPE]->(t:Type)
MATCH (fm:Module)-[:CONTAINS]->(f)
MATCH (tm:Module)-[:CONTAINS]->(t)
WHERE fm.packageName <> tm.packageName
RETURN fm.packageName AS consumerPkg, tm.packageName AS providerPkg,
       t.name AS typeName, count(f) AS usageCount
ORDER BY usageCount DESC
```

Write back:
```cypher
MATCH (a:Function {filePath: $callerFile, name: $callerName})
MATCH (b:Function {filePath: $calleeFile, name: $calleeName})
MERGE (a)-[r:BRIDGES]->(b)
SET r.fromPackage = $fromPkg, r.toPackage = $toPkg, r.discoveredAt = timestamp()
```

### 4. Circular Dependency Detection (`cycles`)

Find cycles in the CALLS and IMPORTS graphs.

```cypher
// Module-level circular imports (A imports B imports A)
MATCH (a:Module)-[:IMPORTS]->(b:Module)-[:IMPORTS]->(a)
WHERE id(a) < id(b)
RETURN a.filePath AS moduleA, b.filePath AS moduleB

// Function-level 2-cycle
MATCH (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(a)
WHERE id(a) < id(b)
RETURN a.name AS funcA, a.filePath AS fileA,
       b.name AS funcB, b.filePath AS fileB

// 3-hop cycle
MATCH path = (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function)-[:CALLS]->(a)
WHERE id(a) < id(b) AND id(b) < id(c)
RETURN [n IN nodes(path) | n.name] AS cycle,
       [n IN nodes(path) | n.filePath] AS files
```

Report only — do not persist cycles as edges. Cycles are a smell to surface, not a relationship to track.

### 5. Dead Code Detection (`dead-code`)

Find exported functions with no incoming call edges. **Run `di-calls` first** — the seeded
`CALLS` graph is sparse (it doesn't resolve DI/dynamic dispatch), so without the synthetic
`RESOLVED_CALL` and `CALLS_ENDPOINT` edges this analysis has a very high false-positive rate.
Treat all three edge types as "is reached":

```cypher
MATCH (f:Function)
WHERE NOT EXISTS { MATCH ()-[:CALLS]->(f) }
  AND NOT EXISTS { MATCH ()-[:RESOLVED_CALL]->(f) }   // DI-resolved (analysis 9)
  AND NOT EXISTS { MATCH ()-[:CALLS_ENDPOINT]->(f) }  // cross-tier HTTP (analysis 7)
  AND NOT f.name STARTS WITH 'main'
  AND NOT toLower(f.name) CONTAINS 'onmoduleinit'
  AND NOT toLower(f.name) CONTAINS 'onmoduledestroy'
  AND f.httpMethod IS NULL
  AND (f.decorators IS NULL OR (NOT f.decorators CONTAINS 'Cron'
       AND NOT f.decorators CONTAINS 'OnEvent'
       AND NOT f.decorators CONTAINS 'SubscribeMessage'
       AND NOT f.decorators CONTAINS 'WebSocketGateway'))
  AND f.isExported = true
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain
ORDER BY f.filePath
```

Write back, with a **confidence tier** so the irreducible noise is separable. `medium` = an
exported *free* function (not a class method, where DI/protocol dispatch is invisible) outside
the frontend (React components are JSX-rendered, never `CALLS`-ed):

```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.possiblyDead = true,
    f.deadCodeDetectedAt = timestamp(),
    f.deadConfidence = CASE
      WHEN (NOT f.name CONTAINS '.') AND f.domain <> 'frontend'
           AND (f.decorators IS NULL OR f.decorators = '[]' OR f.decorators = '')
      THEN 'medium' ELSE 'low' END
```

**Caveats — always include in the report:**
- This is a *graph-completeness* signal, not a deletion list. Even `medium` candidates include
  factories (`getOrCreate*`) and bootstrap entry-points the call graph never resolved.
- Decorator-driven functions (`@Cron`, `@OnEvent`, `@SubscribeMessage`, framework hooks) are entry points.
- Constructor-injected services are entry points — run `di-calls` to resolve them.
- Test helpers may appear dead but are used in test files (excluded from the watched paths).
- Always confirm against source before acting on any flag.

### 6. Architectural Layer Inference (`layers`)

Infer which architectural layer each module belongs to based on call patterns.

Heuristics:
- **Presentation**: modules containing HTTP endpoint functions.
- **Application**: modules orchestrating (called by presentation, calling into domain).
- **Domain**: core business logic (called by application, calling into infrastructure).
- **Infrastructure**: modules that interact with storage clients, queues, external services.

```cypher
// Presentation layer
MATCH (m:Module)-[:CONTAINS]->(f:Function)
WHERE f.httpMethod IS NOT NULL
RETURN DISTINCT m.filePath AS modulePath, 'presentation' AS layer

// Infrastructure layer (path-based heuristic)
MATCH (m:Module)-[:CONTAINS]->(f:Function)
WHERE f.filePath CONTAINS '/storage/' OR f.filePath CONTAINS '/database/'
   OR f.filePath CONTAINS '/clients/'
RETURN DISTINCT m.filePath AS modulePath, 'infrastructure' AS layer
```

Write back:
```cypher
MATCH (m:Module {filePath: $modulePath})
SET m.architecturalLayer = $layer
```

### 7. Cross-Tier REST Edges (`cross-language`)

The seeded `CALLS` graph is **single-language AST resolution** — it never links a caller to an
HTTP endpoint in another service/language. But both NestJS controllers and Python FastAPI routes
are stored as `Function` nodes carrying `httpMethod` + `routePath`, and `CodeBlock.bodyText` holds
each function's source. Join them: a function whose body contains an endpoint's `routePath` (in an
HTTP-call context) is calling that endpoint. This reconstructs the TS→Python sidecar graph and the
frontend→API graph that are otherwise invisible.

```cypher
MATCH (ep:Function) WHERE ep.routePath IS NOT NULL
// normalize route params (/x/:id, /x/{id}) down to the static prefix
WITH ep, CASE WHEN ep.routePath CONTAINS ':' THEN split(ep.routePath,':')[0]
              WHEN ep.routePath CONTAINS '{' THEN split(ep.routePath,'{')[0]
              ELSE ep.routePath END AS pathKey
WHERE size(pathKey) > 4                                  // drop trivially short keys
MATCH (cb:CodeBlock)
WHERE cb.filePath <> ep.filePath
  AND NOT cb.filePath ENDS WITH '.types.ts'              // skip type/DTO/comment-only matches
  AND cb.bodyText CONTAINS pathKey
  AND (toLower(cb.bodyText) CONTAINS 'fetch' OR toLower(cb.bodyText) CONTAINS 'axios'
       OR toLower(cb.bodyText) CONTAINS 'http' OR toLower(cb.bodyText) CONTAINS 'request(')
MATCH (caller:Function {filePath: cb.filePath, name: cb.functionName})
WHERE caller <> ep
MERGE (caller)-[r:CALLS_ENDPOINT]->(ep)
SET r.protocol = 'http', r.method = ep.httpMethod,
    r.routePath = ep.routePath, r.discoveredAt = timestamp()
RETURN count(r) AS edges
```

Guardrails (already encoded above; keep them):
- Match on the **static path prefix** so parameterized routes (`/graph/:instance/count`) still join.
- Require an HTTP-verb / client token (`fetch`/`axios`/`http`/`request(`) near the path so prose
  and comments don't match.
- Exclude `*.types.ts`; a class-summary `CodeBlock` may still yield a redundant edge to the class
  node — `MERGE` collapses duplicates, but note it in the report.

Report the edges grouped by `caller.domain → ep` package so the cross-tier flows are legible
(e.g. `sylphie → perception-service`, `frontend → web-api`).

### 8. WebSocket Event Contracts (`ws-events`)

WS emitter and handler are coupled by an **event-name string**, not a call. NestJS handlers carry
the name in their decorator (`@SubscribeMessage('x')` → `decorators` JSON `args:["x"]`); emitters
carry it as an `emit('x')` literal. Extract both and join into `EMITS_EVENT` edges (inbound
client/peer → handler direction):

```cypher
MATCH (h:Function) WHERE h.decorators CONTAINS 'SubscribeMessage'
WITH h, split(split(h.decorators,'"args":["')[1],'"')[0] AS event
MATCH (cb:CodeBlock)
WHERE (cb.bodyText CONTAINS ("emit('"+event+"'") OR cb.bodyText CONTAINS ('emit("'+event+'"'))
  AND cb.functionName <> h.name
MATCH (emitter:Function {filePath: cb.filePath, name: cb.functionName})
MERGE (emitter)-[r:EMITS_EVENT]->(h)
SET r.event = event, r.discoveredAt = timestamp()
RETURN count(r) AS edges
```

⚠️ **Known limitation on current data.** This join depends on emit-sites being stored as literal
`emit('event')` text in `bodyText`. In this repo the seeder currently captures **zero** `.emit(`
bodies (broadcasts go through typed wrappers / `socket.send`, and event-name constants aren't
inlined), so the analysis legitimately returns ~0 edges today. The logic is correct and will light
up once emit/`.on(` event-name literals are captured — see the codebase-pkg handoff note. Report
`0 edges (emit-literals not captured upstream)` rather than treating it as an error.

### 9. DI-Resolved Calls (`di-calls`)

The single biggest lever on dead-code false positives. `INJECTS` is populated as `Type→Type`
(consumer class → injected service), but method invocations on injected services
(`this.someSvc.doThing()`) are never resolved into `CALLS`. Synthesize them as a **separate**
`RESOLVED_CALL` edge type (don't mutate the seeder's `CALLS`): for a class `C` that injects service
`S`, any method of `C` whose body calls `.<m>(` where `m` is a method of `S` is calling `S.<m>`.

```cypher
MATCH (c:Type)-[:INJECTS]->(s:Type)
MATCH (caller:Function) WHERE caller.name STARTS WITH c.name + '.'
MATCH (cb:CodeBlock {filePath: caller.filePath, functionName: caller.name})
MATCH (callee:Function) WHERE callee.name STARTS WITH s.name + '.'
WITH caller, callee, split(callee.name,'.')[-1] AS m, cb
WHERE size(m) > 3                                        // avoid generic short names
  AND cb.bodyText CONTAINS ('.'+m+'(')
MERGE (caller)-[r:RESOLVED_CALL]->(callee)
SET r.via = 'di', r.discoveredAt = timestamp()
RETURN count(r) AS edges, count(DISTINCT callee.name) AS calleesReached
```

- This **over-approximates** (any `.m(` whose name coincides with a method of an injected service),
  so it's deliberately a separate edge type — useful for reachability/dead-code, not a precise call
  graph. Keep `CALLS` (seeded, precise) and `RESOLVED_CALL` (heuristic) distinct.
- The `> 3` length guard drops `.get(`/`.set(` style collisions; raise it or add a stop-list if a
  spot-check shows noise.
- After running this, re-run `dead-code` (it already treats `RESOLVED_CALL` as incoming).

---

## Output

After all analyses run, print a summary:

```
PKG INFERENCE REPORT
============================================================
Hub Functions:      N (M god-functions flagged)
Hub Types:          N (M cross-package contract types)
Pipelines:          N discovered
Bridges:            N cross-package connections
Circular Deps:      N cycles detected
DI-Resolved Calls:  N (M dead-flags rescued)
Dead Code:          N possibly-dead (M medium / K low confidence)
Layer Assignment:   N modules classified
Cross-Tier REST:    N CALLS_ENDPOINT edges
WS Event Contracts: N EMITS_EVENT edges

New graph elements written:
  hubScore properties:    N
  DATA_FLOWS_TO edges:    N
  BRIDGES edges:          N
  RESOLVED_CALL edges:    N
  CALLS_ENDPOINT edges:   N
  EMITS_EVENT edges:      N
  possiblyDead flags:     N (with deadConfidence tier)
  architecturalLayer:     N
============================================================
```

---

## Key Rules

- **No external LLM API calls** — the active Claude Code session is the analyzer. Use Cypher and judgment.
- Always use parameterized Cypher — never interpolate strings into queries.
- For `--dry-run`, print what would be written but skip all `SET`/`MERGE` writes.
- Run analyses in order: hubs → pipelines → bridges → cycles → **di-calls → dead-code** → layers
  → cross-language → ws-events. `di-calls` MUST run before `dead-code` (dead-code consumes its
  `RESOLVED_CALL` edges); `cross-language` writes `CALLS_ENDPOINT` edges that dead-code also honors,
  so prefer running it before dead-code too when doing a full pass.
- If an analysis returns 0 results, say so and move on — not an error (e.g. `ws-events` is expected
  to return 0 until emit-literals are captured upstream).
- Pipeline naming should reflect domain context, not just "pipeline-1".
- Dead code detection has high false-positive rate — always caveat results and report the
  `medium`/`low` split, not just the total.
- The synthesized edge types are heuristic and reversible. To reset them:
  `MATCH ()-[r:CALLS_ENDPOINT|RESOLVED_CALL|EMITS_EVENT]->() DELETE r`.
