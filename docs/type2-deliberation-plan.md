# Type 2 Deliberation — Implementation Plan

**Date:** 2026-04-06
**Prereq:** Decision Making executor engine (done), Communication subsystem (done), OllamaLlmService (done)
**Design doc:** `docs/type2-deliberation-design.md`

---

## Phase 1: Latent Space + WKG Foundation

The latent space is fast pattern matching ("I've seen this before"). The WKG is understanding ("I know what these things are and how they relate"). Both are needed. A latent space hit without WKG context is a parrot. WKG context without latent space is slow. Together they give fast AND grounded responses.

### 1.1 — `learned_patterns` pgvector table

**Create schema in** a new `LatentSpaceService`

```sql
CREATE TABLE IF NOT EXISTS learned_patterns (
  id                  UUID PRIMARY KEY,
  stimulus_embedding  vector(768),     -- fused sensory embedding that triggered this
  response_text       TEXT NOT NULL,    -- what Sylphie decided to say/do
  procedure_id        TEXT,            -- WKG ActionProcedure node ID
  confidence          FLOAT NOT NULL,  -- arbiter confidence at commit time
  use_count           INTEGER DEFAULT 0,
  recent_mae          FLOAT DEFAULT 0,
  deliberation_summary TEXT,           -- compressed reasoning trace
  entity_ids          TEXT[],          -- WKG entity node IDs involved in this pattern
  created_at          TIMESTAMPTZ NOT NULL,
  last_used_at        TIMESTAMPTZ,
  session_id          TEXT
);

CREATE INDEX ON learned_patterns
  USING ivfflat (stimulus_embedding vector_cosine_ops) WITH (lists = 100);
```

Key addition: `entity_ids` links patterns to WKG nodes. When Type 1 matches a pattern, it can pull the associated entities from the WKG for context enrichment without a full graph traversal.

### 1.2 — LatentSpaceService

**Create** `packages/decision-making/src/latent-space/latent-space.service.ts`

- `onModuleInit()`: hydrate hot layer from pgvector (frequency-weighted)
- `search(embedding, threshold)`: cosine similarity against hot layer, return match with WKG entity IDs
- `write(pattern)`: persist to pgvector + hot layer + create WKG links
- `recordUse(patternId)`: increment use_count, update last_used_at
- `getPattern(id)`: retrieve full pattern with WKG entity context

### 1.3 — WKG Context Service

**Create** `packages/decision-making/src/wkg/wkg-context.service.ts`

This is the read interface to the WKG for the entire deliberation pipeline. Every LLM call in the pipeline gets WKG context injected.

```typescript
interface WkgContextService {
  // Get context relevant to the current sensory frame
  getContextForFrame(frame: SensoryFrame): Promise<WkgContext>;
  
  // Get entities related to a specific query/topic
  queryEntities(query: string): Promise<WkgEntity[]>;
  
  // Get the full subgraph around a set of entity IDs
  getSubgraph(entityIds: string[], depth?: number): Promise<WkgSubgraph>;
  
  // Get what Sylphie knows about a specific entity
  getEntityFacts(entityId: string): Promise<WkgFact[]>;
  
  // Write new knowledge from deliberation outcomes
  writeEntity(entity: NewEntity): Promise<string>;  // returns node ID
  writeRelationship(rel: NewRelationship): Promise<void>;
  writeActionProcedure(procedure: NewProcedure): Promise<string>;
}
```

WkgContext is assembled by:
1. Extract entities from the frame's raw text (NER)
2. Fuzzy match entity names against WKG nodes
3. Pull 1-hop neighbors for matched entities
4. Pull any ActionProcedure nodes linked to similar contexts
5. Return structured context: `{ entities, relationships, procedures, facts }`

This context is injected into EVERY LLM system prompt during deliberation. The LLM never operates in a vacuum — it always knows what Sylphie knows.

### 1.4 — Wire Type 1 to check latent space + WKG

**Modify** `packages/decision-making/src/decision-making.service.ts`

Before arbitration (RETRIEVING state):
1. Get the fused embedding from the current SensoryFrame
2. Call `latentSpace.search(embedding, 0.80)` — fast vector match
3. If hit:
   a. Pull associated WKG entities via `entity_ids`
   b. Get current context from WKG for those entities
   c. Construct an `ActionCandidate` with full WKG grounding
   d. Inject as a high-confidence Type 1 candidate
4. If miss: proceed to Type 2

Type 1 is fast BECAUSE the latent space stores entity_ids — it doesn't have to search the WKG from scratch, it already knows which nodes are relevant.

---

## Phase 2: WKG-Grounded Deliberation Pipeline

Every step in the deliberation pipeline is grounded in WKG knowledge. The LLM is never guessing from scratch — it's reasoning over Sylphie's actual accumulated knowledge.

### 2.1 — DeliberationService

**Create** `packages/decision-making/src/deliberation/deliberation.service.ts`

Injects: `OllamaLlmService`, `WkgContextService`, `IEpisodicMemoryService`, `PersonModelService`, `LatentSpaceService`, `IDriveStateReader`

```
deliberate(frame, cognitiveContext) → DeliberationResult
```

First action before any LLM call: assemble WKG context for this frame.

```typescript
const wkgContext = await this.wkgContext.getContextForFrame(frame);
```

This `wkgContext` is passed to every subsequent step.

### 2.2 — Inner Monologue Step (WKG-grounded)

```
innerMonologue(frame, context, wkgContext) → string
```

System prompt includes:
```
You are Sylphie's inner voice.

What I know about this situation:
- Entities: [WKG entities related to the input]
- Known facts: [WKG facts about those entities]  
- Known relationships: [WKG edges between entities]
- Person I'm talking to: [person model facts]

My current internal state: [drive pressures]
Recent experiences: [last 5 episodes]

Describe what is happening and what I need to decide.
```

The inner monologue is now reasoning over real knowledge, not hallucinating context.

### 2.3 — Candidate Generation Step (WKG-grounded)

```
generateCandidates(monologue, context, wkgContext, count=3) → Candidate[]
```

System prompt includes:
```
Based on what I know:
[WKG context summary]

And my inner monologue:
[monologue text]

Generate {count} possible responses. For each, explain which known facts support it.
```

Candidates are grounded in WKG facts. The LLM can cite specific entities and relationships in its reasoning. Ungrounded candidates (ones that reference things not in the WKG) get flagged.

### 2.4 — For/Against Debate Step (WKG as evidence)

```
debate(selectedCandidate, context, wkgContext) → { forArgument, againstArgument }
```

FOR agent system prompt:
```
Argue why this response is appropriate. Cite specific facts from Sylphie's knowledge:
[WKG facts]
[Episodic memory evidence]
```

AGAINST agent system prompt:
```
Argue why this response might be wrong. Check for:
- Contradictions with known facts: [WKG facts]
- Gaps in knowledge (things we DON'T know)
- Potential Theater Prohibition violations (response vs drive state)
```

The debate is evidence-based because both sides have access to the same WKG ground truth.

### 2.5 — Arbiter Step (WKG + external verification)

```
arbitrate(forArg, againstArg, wkgContext, externalData?, context) → DeliberationResult
```

The arbiter has:
1. For argument (citing WKG evidence)
2. Against argument (citing WKG gaps/contradictions)
3. External verification (Google consensus signal, if triggered)
4. WKG context directly (can verify claims from both sides)
5. Drive state (for Theater Prohibition alignment)

Returns: `{ response, confidence, rationale, newEntities, newRelationships }`

The arbiter also identifies NEW knowledge discovered during deliberation — entities or relationships that should be added to the WKG.

### 2.6 — Trigger conditions for debate

Same as before:
- **Skip debate if:** Top candidate confidence > 0.7 AND WKG has relevant facts
- **Trigger debate if:** WKG has no relevant entities (truly novel), OR candidates contradict WKG facts, OR drive pressure high
- **Trigger external verification if:** For/against cite conflicting WKG facts, OR key claims aren't in the WKG at all

---

## Phase 3: MCP Tool Integration

### 3.1 — Ollama tool calling support

**Modify** `packages/decision-making/src/llm/ollama-llm.service.ts`

Add `completeWithTools(request, tools, toolExecutor)` method. Tool call loop: LLM returns tool_calls → execute tools → feed results back → LLM continues.

### 3.2 — Tool definitions

**Create** `packages/decision-making/src/deliberation/tools/`

**wkg_query** (PRIMARY tool — most important):
```json
{
  "name": "wkg_query",
  "description": "Query Sylphie's World Knowledge Graph for entities, facts, and relationships. This is my primary knowledge source — what I actually know.",
  "parameters": {
    "query_type": "entity_lookup | relationship_query | fact_check | subgraph",
    "entity": "string (entity name or ID)",
    "relationship": "string? (relationship type to filter by)",
    "depth": "number? (how many hops from the entity, default 1)"
  }
}
```
Handler: calls `WkgContextService` methods based on query_type.

**wkg_write** (used during write-back):
```json
{
  "name": "wkg_write",
  "description": "Record new knowledge I've learned from this deliberation",
  "parameters": {
    "write_type": "entity | relationship | fact",
    "data": "object with entity/relationship details"
  }
}
```
Handler: calls `WkgContextService.writeEntity()` / `writeRelationship()`. Tagged with provenance.

**episodic_memory_search:**
```json
{
  "name": "episodic_memory_search",
  "description": "Search my recent experiences for similar situations",
  "parameters": { "query": "string" }
}
```
Handler: calls `IEpisodicMemoryService.queryByContext()`

**person_model_query:**
```json
{
  "name": "person_model_query",
  "description": "Look up what I know about a specific person",
  "parameters": { "person_id": "string" }
}
```
Handler: calls `PersonModelService.getPersonModel()`

**drive_state_read:**
```json
{
  "name": "drive_state_read",
  "description": "Check my current internal motivational state",
  "parameters": {}
}
```
Handler: calls `IDriveStateReader.getCurrentState()`

**google_search** (external verification):
```json
{
  "name": "google_search",
  "description": "Search the web for consensus on a factual claim. NOT ground truth — this is what the world thinks, which may be wrong. Use for calibration only.",
  "parameters": { "query": "string" }
}
```
Handler: browser-based or API-based search.

**Important provenance rules:**
- WKG facts: `provenance: 'SENSOR'` or `'GUARDIAN'` (high trust)
- Episodic memory: `provenance: 'SENSOR'` (experienced directly)
- Google search: `provenance: 'INFERENCE'` (consensus signal, not truth)
- LLM-generated claims: `provenance: 'LLM_GENERATED'` (lowest trust)

---

## Phase 4: WKG-Integrated Write-Back

After Type 2 commits, write back to BOTH the latent space AND the WKG. The latent space is for fast matching. The WKG is for understanding.

### 4.1 — Dual write-back in DecisionMakingService

**Modify** `packages/decision-making/src/decision-making.service.ts`

After successful Type 2 deliberation:

**Latent space write:**
1. Get stimulus embedding from frame
2. Get entity IDs from WKG context used during deliberation
3. Write pattern: `{ embedding, response, confidence, entity_ids, deliberation_summary }`

**WKG write (the knowledge part):**
1. Create/update entity nodes for any NEW entities discovered during deliberation
2. Create relationship edges between entities mentioned in the response
3. Create an `ActionProcedure` node:
   - Linked to the entities involved (`:INVOLVES` edges)
   - Linked to the drives that motivated it (`:RELIEVES` edges)
   - Linked to the context pattern (`:TRIGGERED_BY` edge to a Context node)
   - Carries the response text, confidence, provenance
4. If the arbiter identified new knowledge, write that too

**Example — "Hello, my name is Jim":**

After deliberation, the WKG gets:
```
(Jim:Person {name: "Jim", role: "guardian"})
(greeting:Context {pattern: "social greeting with name introduction"})
(proc:ActionProcedure {response: "Hello Jim! Nice to meet you!", confidence: 0.85})

(Jim)-[:MENTIONED_IN]->(greeting)
(proc)-[:TRIGGERED_BY]->(greeting)
(proc)-[:INVOLVES]->(Jim)
(proc)-[:RELIEVES]->(Social:Drive)
```

Next time Jim says hello, Type 1 matches the embedding AND can pull "Jim is the guardian" from the WKG to personalize the response.

### 4.2 — Confidence evolution (WKG + latent space synchronized)

When Type 1 matches a pattern and it succeeds:
1. Latent space: `recordUse()` — increment use_count
2. WKG: Update ActionProcedure node confidence via ACT-R
3. Both stay in sync

When a pattern fails:
1. Latent space: confidence decreases
2. WKG: ActionProcedure confidence decreases
3. If MAE > demotion threshold: pattern flagged, Type 2 re-deliberates next time
4. WKG relationships from the failed pattern get lower confidence

### 4.3 — WKG contradiction handling

If the arbiter's decision contradicts existing WKG facts:
1. Don't silently overwrite — create a `CONTRADICTS` edge
2. The contradiction scanner (already built) will catch this on future arbitrations
3. Let the Learning subsystem resolve contradictions over time
4. If guardian provides feedback, use that to break the tie (Standard 5: guardian asymmetry)

---

## Phase 5: Boot Hydration

### 5.1 — LatentSpaceService.onModuleInit()

1. Query `learned_patterns` ordered by `use_count DESC, last_used_at DESC`
2. Load top N (e.g., 1000) into hot layer
3. For each pattern, pre-cache the WKG entity IDs (they're stored in the row)
4. Log: "Loaded N patterns into hot layer (M total, K WKG entities referenced)"

### 5.2 — WKG warm cache

On boot, also cache frequently-referenced WKG entities:
1. Collect all entity_ids from loaded patterns
2. Batch-query Neo4j for those entity nodes + 1-hop neighbors
3. Cache in memory for fast Type 1 context enrichment

This means Type 1 responses have full WKG context without hitting Neo4j on every match.

### 5.3 — Graceful cold start

Empty database: hot layer empty, WKG has only bootstrap nodes. Every input → Type 2 → learns → populates both stores. Each interaction makes the next one faster.

---

## Dependency Order

```
Phase 1.3 (WKG Context Service) ← build first, everything depends on this
    ↓
Phase 1.1-1.2 (Latent Space) + Phase 2 (Deliberation Pipeline)
    ↓                              ↓
Phase 1.4 (Wire Type 1)      Phase 3 (MCP Tools)
    ↓                              ↓
         Phase 4 (Write-Back) ← needs all of above
              ↓
         Phase 5 (Boot Hydration)
```

The WKG Context Service is the keystone. Build it first because every other phase injects it.

## Estimated Scope

| Phase | Files to create/modify | Relative size |
|---|---|---|
| Phase 1.3: WKG Context Service | 1 new, 1 modified (module) | Medium |
| Phase 1.1-1.2: Latent Space | 2 new, 1 modified (module) | Medium |
| Phase 1.4: Wire Type 1 | 1 modified | Small |
| Phase 2: Deliberation Pipeline | 1 new (large) | Large |
| Phase 3: MCP Tools | 6-7 new, 1 modified (OllamaLlmService) | Medium-Large |
| Phase 4: Write-Back | 2 modified | Medium |
| Phase 5: Boot Hydration | 1 modified | Small |

## What This Changes

**Before:** WKG is a passive store with bootstrap nodes. LLM calls are context-free. Type 2 is a single LLM call. No learning persists.

**After:** WKG is the knowledge center. Every LLM call is grounded in what Sylphie actually knows. Type 2 deliberation creates new knowledge in the WKG. Type 1 matches are enriched with WKG context. The system gets smarter with every interaction because both the latent space (fast matching) and the WKG (deep understanding) grow together.
