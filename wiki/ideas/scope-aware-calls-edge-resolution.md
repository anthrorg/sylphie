# Idea: Scope-Aware CALLS Edge Resolution in PKG Sync

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `buildCallsEdges` function in `mutation-builder.ts` resolves callee targets by matching on `name` alone (or a `.name` suffix), without constraining to the correct file, module, or import scope. This can produce false CALLS edges when multiple functions across different packages share the same name, polluting the graph with phantom cross-service dependencies.

## Motivation

Today's Cypher for CALLS edges does:

```cypher
MATCH (callee:Function)
WHERE callee.name = $calleeName
   OR callee.name ENDS WITH $calleeSuffix
WITH caller, callee LIMIT 1
MERGE (caller)-[:CALLS]->(callee)
```

This means if `perception-service` and `drive-engine` both export a function called `normalize`, a caller that imports from `perception-service` might get linked to the `drive-engine` version (or vice-versa) depending on which node Neo4j returns first. The `LIMIT 1` makes it non-deterministic.

A scope-aware resolver would use the import graph that's already being synced — the caller's IMPORTS edges tell us exactly which module each callee comes from. By joining through the IMPORTS edges (or using the AST-parsed import map directly when building the Cypher), we can constrain callee matches to the correct source module. This would make the CALLS subgraph significantly more trustworthy for tasks like impact analysis, dead-code detection, and cross-service dependency mapping.

## Subsystems Affected

- `sylphie-pkg` — `mutation-builder.ts` (buildCallsEdges)
- `sylphie-pkg` — `ast-parser.ts` (may need to emit qualified callee references, e.g. `{ name, importedFrom }`)
- `sylphie-pkg` — `graph-differ.ts` (changeset may need richer callee metadata)

## Open Questions

- Should the AST parser resolve callees to their imported module at parse time, or should the Cypher query join through IMPORTS edges at mutation time?
- How should we handle callees that are local (same-file) vs. imported vs. globally available (e.g., built-in Node APIs)?
- Would a two-pass approach work — first sync all Function nodes, then resolve CALLS edges in a second pass using the completed import graph?
- What's the current false-positive rate? Could run a diagnostic query to find CALLS edges that cross service boundaries where no IMPORTS path exists.
