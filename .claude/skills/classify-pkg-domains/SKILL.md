# Classify PKG Domains

Classify unclassified Function nodes in the Codebase PKG into domain buckets. Runs locally — reads functions from Neo4j, classifies them using your own judgment, and writes labels back.

## Usage

```
/classify-pkg-domains
/classify-pkg-domains --limit 50          # Classify up to 50 functions (default: all unclassified)
/classify-pkg-domains --package planning  # Only classify functions in a specific subsystem
```

## Prerequisites

1. Codebase PKG Neo4j container running on `bolt://localhost:7691`
2. PKG has been seeded (`cd packages/sylphie-pkg && npm run seed-pkg`)

---

## Domain Labels

Assign each function exactly ONE of these domains based on Sylphie's five-subsystem architecture:

| Domain | Description |
|--------|-------------|
| `decision-making` | Cognitive loop, Type 1/Type 2 arbitration, episodic memory, predictions, action selection |
| `communication` | Input parsing, LLM voice, person modeling (Other KG), TTS/chatbox output |
| `learning` | Consolidation, entity extraction, edge refinement, maintenance cycles |
| `drive-engine` | 12 drives, self-evaluation (Self KG), opportunity detection, isolated process |
| `planning` | Opportunity research, simulations, plan creation, procedure validation |
| `knowledge-graph` | WKG interface, Neo4j queries, Grafeo KGs, confidence dynamics, ACT-R |
| `event-backbone` | TimescaleDB event store, event types, subscriptions |
| `database` | PostgreSQL system DB, drive rules, settings, migrations |
| `web-api` | HTTP routes, WebSocket handlers, REST endpoints, controllers |
| `metrics` | Observability, monitoring, health checks |
| `orchestration` | Main loop, app module, startup, module wiring, event bus |
| `shared-utilities` | Generic helpers, type definitions, config, logging |
| `testing` | Test utilities, fixtures, test infrastructure |

---

## Workflow

### Step 1: Query unclassified functions

Run this Cypher against the Codebase PKG Neo4j (`bolt://localhost:7691`, user `neo4j`, password `sylphie-pkg-local`):

```cypher
MATCH (f:Function)
WHERE f.domain = 'unclassified' OR f.domain IS NULL
RETURN f.name AS name, f.filePath AS filePath,
       f.jsDoc AS jsDoc, f.returnType AS returnType,
       f.isAsync AS isAsync, f.args AS args
ORDER BY f.filePath
LIMIT $limit
```

Use `$limit` from the `--limit` flag (default: no limit — classify all).

If `--package` is specified, add `AND f.filePath CONTAINS $package` to the WHERE clause.

### Step 2: Classify in batches

Process functions in batches of ~20. For each batch:

1. Read the function name, file path, JSDoc, return type, and arguments
2. Use the file path to infer subsystem context (e.g., `src/drive-engine/` → `drive-engine`)
3. Assign a domain label based on:
   - **Directory location** (strongest signal — the `src/` subdirectory maps directly to subsystems)
   - **Function name and JSDoc** (clarifying signal)
   - **Return type and arguments** (supporting signal)
4. When ambiguous, prefer the more specific domain over `shared-utilities`

### Step 3: Write labels back

For each classified function, run:

```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.domain = $domain
```

Run these in a single transaction per batch for efficiency.

### Step 4: Report results

Print a summary:
```
Classified X functions:
  decision-making: N
  communication: N
  drive-engine: N
  ...
  Still unclassified: N
```

---

## Key Rules

- **No LLM API calls** — YOU are the classifier. Use your understanding of the codebase.
- Classify based on the function's PRIMARY purpose, not secondary effects
- If a function is genuinely general-purpose (logging, config, type guards), use `shared-utilities`
- NestJS controllers and route handlers → `web-api`
- NestJS services that DO domain work → classify by what they do, not that they're services
- Functions in `src/decision-making/` → `decision-making`, etc. — directory is the strongest signal
- Run Cypher via: `docker exec sylphie-pkg-neo4j cypher-shell -u neo4j -p sylphie-pkg-local "<query>"`
