---
name: audit-duplication
description: Whole-codebase scan for code duplication — copy-paste blocks, parallel reimplementations of the same helper across packages, and redundant type definitions. Uses codebase-pkg (duplicate function names, near-identical CodeBlock bodies, structurally-identical types) to find clusters, reads each member in full to confirm, then recommends a single canonical home. Writes a report under docs/audits/ and annotates duplication clusters in the graph.
---

# Audit: Code Duplication

Find logic that exists in more than one place and should exist in one: copy-pasted
blocks, the same helper reimplemented per package, and redundant type/interface
definitions. The goal is a **DRY, single-source-of-truth** codebase — every concept
owned by exactly one module.

Read + annotate only. It proposes consolidations; it does not perform them.

## When to use

- Periodically, as the codebase grows across 11 packages.
- When you notice the same idea (cosine similarity, token estimation, UTC coercion,
  vector parsing) showing up in multiple subsystems.
- Before extracting a shared library — to find what belongs in it.

## Scope

**Default: the whole first-party codebase** (all 11 `.mcp.json` packages). Cross-package
duplication is the highest-value target, so prefer the full sweep. `--package <name>`
restricts to intra-package duplication.

> **This can take time.** Run as a **Workflow**: a graph pass produces candidate
> clusters (cheap), then fan out one agent per cluster to read all members and judge.
> The orchestrator writes the report + annotations.

## Prerequisites

1. Graph synced — `/sync-pkg` (this skill leans on `CodeBlock.bodyText`, `Function`,
   `Type`, and `Module.packageName`).
2. Neo4j reachable:
   ```bash
   docker exec codebase-pkg-neo4j cypher-shell -u neo4j -p "$CODEBASE_PKG_NEO4J_PASSWORD" "<query>"
   ```
   Password is in the `codebase-pkg` env block of `.mcp.json`.

## Discovery protocol (mandatory)

Locate clusters via `codebase-pkg`, then **`Read` every member file in full** before
calling anything a duplicate. Two functions sharing a name or a similar body are a
*candidate* — only a full read confirms they're the same logic (vs. a coincidental
name or a legitimately specialized variant).

---

## Workflow

### Phase 1 — Candidate clusters from the graph (leads)

Run all three detectors; each yields candidate clusters to confirm.

**A. Same-name functions across files** (the classic reimplemented helper):
```cypher
MATCH (f:Function)
WITH split(f.name,'.')[-1] AS base, collect(DISTINCT f.filePath) AS files, collect(f.name) AS names
WHERE size(files) >= 2 AND size(base) > 3
RETURN base, size(files) AS sites, files
ORDER BY sites DESC LIMIT 100
```
Look especially for normalized variants: `cosineSimilarity`/`_cosine_similarity`,
`to_utc`/`_to_utc`, `asNumber`/`toNumber`, `parseEmbedding`/`parseVectorLiteral`.

**B. Near-identical bodies** (copy-paste). Group `CodeBlock`s by a normalized body
signature — collapse whitespace and length-bucket so trivially-different copies still
cluster:
```cypher
MATCH (cb:CodeBlock)
WHERE cb.bodyText IS NOT NULL AND size(cb.bodyText) > 200
WITH cb, size(cb.bodyText) AS len,
     left(replace(replace(cb.bodyText,' ',''),'\n',''), 80) AS head
WITH head, len/50 AS lenBucket, collect(DISTINCT cb.filePath) AS files, collect(cb.functionName) AS fns
WHERE size(files) >= 2
RETURN head, lenBucket, size(files) AS copies, fns, files
ORDER BY copies DESC LIMIT 100
```
(`head`+`lenBucket` is a cheap shingle; treat matches as candidates, confirm by reading.)

**C. Redundant types** (identical-shape interfaces/DTOs defined more than once):
```cypher
MATCH (t:Type)
WITH t.name AS name, collect(DISTINCT t.filePath) AS files, collect(t.kind) AS kinds
WHERE size(files) >= 2
RETURN name, size(files) AS defs, kinds, files
ORDER BY defs DESC LIMIT 100
```

### Phase 2 — Confirm by reading (verdict)

For each candidate cluster, **`Read` every member in full** and classify:

- `true-duplicate` — same logic; should be one implementation.
- `near-duplicate` — same intent, minor drift (a refactor target; note the diffs).
- `coincidental` — same name, different logic (e.g., two `reset()` methods). Dismiss.
- `legitimate-specialization` — intentional per-context variant (e.g., a domain-specific
  override). Dismiss, but note if a shared base would still help.

For each confirmed cluster pick the **canonical home**: usually `packages/shared` for
cross-package utilities; otherwise the package that owns the concept. Note any CANON
constraint (e.g., drive-isolation forbids `drive-engine` importing from app code — the
canonical home must respect boundaries).

### Phase 3 — Annotate the graph

Give every member of a confirmed cluster a shared cluster id (use a stable, content-derived
label — e.g. the canonical base name — since `Math.random`/timestamps aren't available
in scripts):

```cypher
UNWIND $members AS m
MATCH (f:Function {filePath: m.filePath, name: m.name})
SET f.dupCluster = $clusterId,          // e.g. 'cosine-similarity'
    f.dupKind = $kind,                   // 'true-duplicate'|'near-duplicate'
    f.dupCanonicalHome = $home,          // suggested owning package/file
    f.auditedDupAt = timestamp()
```
Optionally connect members: `MERGE (a)-[:DUPLICATES {cluster:$clusterId}]->(b)`.

### Phase 4 — Report

Write `docs/audits/duplication.md` (overwrite each run):

```
# Duplication Audit — <commit short sha>

## Summary
Confirmed clusters: N   |  true-duplicate: N  near-duplicate: N
Estimated sites collapsible: N

## Clusters (ranked by sites × body size)
### <clusterId>  — <kind>  — <sites> sites
  Members:
    - `pkg/file.ts:line` `FnName`
  Canonical home: `packages/shared/...`   (respects CANON: <yes/constraint>)
  Consolidation: <one-line how>

## Redundant types
- `TypeName` defined in N places → unify in `...`

## Dismissed candidates (coincidental / specialization + why)
```

Rank clusters by **impact** (number of sites × body size), not just count — a 3-site
80-line copy beats a 6-site one-liner.

---

## Key rules

- **Read every member before declaring a duplicate.** Name/shingle matches are leads.
- Default to `coincidental`/`legitimate-specialization` when unsure — false DRY-ing
  couples things that should stay separate.
- The canonical home must respect CANON boundaries (drive isolation, package layering).
  When the right home is non-obvious or crosses a boundary, escalate to `architect`.
- Suggest consolidations; never perform them in this skill — that's a planned ticket.
- Reset annotations:
  `MATCH (f:Function) REMOVE f.dupCluster, f.dupKind, f.dupCanonicalHome, f.auditedDupAt`
  and `MATCH ()-[r:DUPLICATES]->() DELETE r`.
