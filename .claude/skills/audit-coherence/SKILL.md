---
name: audit-coherence
description: Whole-codebase structural-quality review aimed at staff-level coherence — module boundaries, layering, naming/pattern consistency, error-handling and logging uniformity, god-objects, abstraction leaks, and CANON alignment (drive isolation, provenance, confidence ceiling, theater, guardian asymmetry). Uses codebase-pkg (layers, bridges, hubs, cycles) plus full-file reads to produce prioritized, concrete recommendations. Writes a report under docs/audits/ and annotates the graph. Escalates the big architectural calls to architect.
---

# Audit: Coherence & Staff-Level Quality

Step back from individual lines and ask: **does this codebase read like one system
designed by one strong mind?** This audit finds the structural incoherence that
accumulates across 11 packages — inconsistent patterns, leaky boundaries, god-objects,
divergent conventions, CANON drift — and proposes concrete moves toward staff-level
quality.

This is **not** a line-bug review (that's `code-reviewer`) and **not** a dead-code or
duplication pass (those are `/audit-dead-code` and `/audit-duplication`). It's the
architecture-coherence layer above them. Read + annotate + recommend only.

## When to use

- Periodically, as a health check on the whole system.
- Before a major build phase, to clear structural debt first.
- When the codebase "feels" inconsistent and you want it named and ranked.

## Scope

**Default: the whole first-party codebase** (all 11 `.mcp.json` packages). Coherence is
inherently cross-package, so the full sweep is the point. `--package <name>` narrows to
one package's internal coherence.

> **This can take time and is judgment-heavy.** Run as a **Workflow**: a graph pass
> surfaces structural signals (cheap), then fan out one agent per *dimension* (below),
> each reading the relevant files in full and returning ranked findings; a final
> synthesis agent de-dupes and prioritizes. Escalate genuinely hard architectural calls
> to the `architect` agent rather than deciding them here.

## Prerequisites

1. Graph synced + analyzed — `/sync-pkg` then `/infer-pkg-connections` (this skill
   consumes `architecturalLayer`, `hubKind`, `BRIDGES`, cycles, `RESOLVED_CALL`).
2. Neo4j reachable:
   ```bash
   docker exec codebase-pkg-neo4j cypher-shell -u neo4j -p "$CODEBASE_PKG_NEO4J_PASSWORD" "<query>"
   ```
   Password is in the `codebase-pkg` env block of `.mcp.json`.
3. Have `CANON` / the Six Immutable Standards and `sylphie-tech-spec.md` in view — a
   coherence call must respect them.

## Discovery protocol (mandatory)

Use `codebase-pkg` to find the signal, then **`Read` the implicated files in full**
before recommending anything. A staff-level recommendation names a real file, a real
pattern, and a concrete change — never a vague "improve consistency."

---

## Workflow — review by dimension

Run each dimension; each produces ranked findings. Graph query gives the lead, full-file
read gives the recommendation.

### 1. Layering & boundary integrity
Find calls that skip or invert layers, and boundary violations:
```cypher
// presentation reaching past application straight into infrastructure
MATCH (a:Module)-[:CONTAINS]->(f:Function)-[:CALLS|RESOLVED_CALL]->(g:Function)<-[:CONTAINS]-(b:Module)
WHERE a.architecturalLayer='presentation' AND b.architecturalLayer='infrastructure'
RETURN DISTINCT a.filePath, b.filePath LIMIT 50
```
**CANON drive-isolation is the sharpest boundary:** `drive-engine` must be a separate
process with **one-way** communication (push events in; no pull/RPC read path in or
out). Flag any `BRIDGES`/`CALLS` edge that crosses the drive boundary as a read/pull:
```cypher
MATCH (a:Function)-[r:BRIDGES]->(b:Function)
WHERE r.fromPackage='drive-engine' OR r.toPackage='drive-engine'
RETURN r.fromPackage, r.toPackage, a.name, b.name
```

### 2. God-objects & cohesion
```cypher
MATCH (f:Function) WHERE f.hubKind='god-function' RETURN f.name, f.filePath, f.hubScore
```
Plus modules with too many responsibilities (high function count spanning multiple
domains). Recommend extractions / responsibility splits.

### 3. Naming & pattern consistency
Across packages, check: service suffixes, file naming (`*.service.ts` vs ad-hoc), DI
patterns (constructor injection vs manual wiring), event naming, the **drive-event
standard** (push-to-judge, never pull). Surface where one package does it differently
from the rest — coherence means the majority pattern wins or the divergence is justified.

### 4. Error handling & logging uniformity
Sweep (via `searchContent`/`Grep`) for mixed idioms: `throw` vs `Result`-returns vs
silent `catch {}`; inconsistent logger usage; swallowed errors. Recommend one idiom per
concern.

### 5. CANON alignment (read against the Six Immutable Standards)
For each, find code patterns that risk drift and flag them:
- **Provenance-required** — writes to KGs without a provenance/source field.
- **Confidence ceiling 0.60** — confidence values hardcoded above 0.60 outside a
  guardian-confirmed path.
- **Theater prohibition** — cross-reference `f.theaterRisk` from `/audit-dead-code`.
- **Guardian asymmetry (×2/×3)** & **no self-modification of evaluation** — evaluation
  paths that write their own criteria.
Surface conflicts; never code around CANON.

### 6. Cross-tier contract coherence
Using `CALLS_ENDPOINT` (TS↔Python, frontend↔API), check that both sides of each
contract agree on shape and that route/DTO drift isn't accumulating.

### Synthesis — prioritize
Merge findings, de-dupe, and rank **P0 / P1 / P2**:
- **P0** — CANON violation or correctness-threatening incoherence.
- **P1** — boundary/layering or god-object debt that will compound.
- **P2** — naming/consistency polish.
Each finding: *what*, *evidence (files)*, *why it matters*, *concrete suggested change*,
*rough effort*. For any P0/P1 whose fix is a real design decision, recommend routing to
`architect` (and, for the owning subsystem, the work-trio expert).

### Annotate the graph
```cypher
MATCH (m:Module {filePath: $filePath})
SET m.coherenceFlag = $flag,        // 'boundary'|'god-object'|'naming'|'canon'|'error-handling'
    m.coherenceSeverity = $sev,      // 'P0'|'P1'|'P2'
    m.coherenceNote = $note,
    m.auditedCoherenceAt = timestamp()
```

### Report
Write `docs/audits/coherence.md` (overwrite each run):

```
# Coherence & Staff-Level Quality Audit — <commit short sha>

## Summary
P0: N (M CANON)   P1: N   P2: N
Headline: <the one structural theme to fix first>

## P0 — must fix
- [<dimension>] `pkg/file` — <finding>
  Evidence: <files>   Why: <impact>   Fix: <concrete change>   Effort: S/M/L
  Route: architect | <subsystem expert> | self

## P1 — compounding debt
...

## P2 — polish
...

## CANON alignment
- Std-<n> <name>: <status / flags>

## What's already coherent   // call out the strengths, not just the gaps
```

---

## Key rules

- **Read the implicated files before recommending.** Graph signals are leads; a
  staff-level recommendation is specific and evidenced.
- This skill **recommends, annotates, and reports — it does not refactor.** Each
  accepted recommendation becomes a planned ticket.
- **Never propose coding around CANON.** A CANON conflict is surfaced, not engineered
  away; material CANON questions go to the `canon` agent / `architect`.
- Escalate hard architectural trade-offs to `architect` rather than deciding them in the
  report — this skill frames the decision, the architect makes it.
- Call out what's *already* coherent — an honest audit isn't only a defect list.
- Reset annotations:
  `MATCH (m:Module) REMOVE m.coherenceFlag, m.coherenceSeverity, m.coherenceNote, m.auditedCoherenceAt`.
