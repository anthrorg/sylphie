# Idea: PKG Read-Side Name Resolution — Fuzzy Suggestions and Fallback Transparency

**Created:** 2026-04-27
**Status:** proposed

## Summary

The PKG MCP tools (`getFunctionDetail`, `getDataFlow`) treat name lookups as exact-or-nothing: an exact match on `Function.name` fails over to a silent `ENDS WITH ".$name"` fallback, and if both miss, the agent gets a flat "not found" with a generic "try `getModuleContext`" hint. Add a "did you mean?" suggestion path (using the names already in the graph) and make the unqualified-method fallback explicit in the response so callers know whether they got a strict or fuzzy hit.

## Motivation

Two concrete pain points sit in `packages/sylphie-pkg/src/mcp-server/tools/getFunctionDetail.ts` (and mirrored in `getDataFlow.ts`):

1. **Silent fuzzy fallback.** If exact match returns 0 rows and the requested name has no `.`, the tool quietly retries with `f.name ENDS WITH ".$name"`. A query for `tick` will then return *every* `Service.tick` in the codebase. The disambiguation message lists file paths and line numbers but never says "you asked for `tick`, I matched on `.tick` suffix across N classes." An agent reading the response can't tell whether the matches are authoritative or coincidental, and a human auditing tool calls can't either.

2. **Dead-end on miss.** When both passes return 0 rows, the response is `Function "X" not found in the codebase PKG. Try getModuleContext to discover function names.` That forces the agent into an extra discovery loop for what is almost always a typo, casing slip, or near-miss (`evalute` vs `evaluate`, `dispatchEvent` vs `dispatch`, `Tick` vs `tick`). The graph already holds every `Function.name` — a single follow-up query using `apoc.text.levenshteinSimilarity` (APOC ships with Neo4j 5) or even a cheap substring scan would surface the top 3–5 candidates with their file paths.

Both fixes are local to the read tools and require no schema changes. They directly improve the most common failure mode for agents driving the PKG: "I typed the name slightly wrong, now I have to fan out to other tools to recover."

A complementary win: when the fuzzy fallback DOES fire and returns multiple hits, the disambiguation listing should distinguish methods (`ClassName.method`) from standalone functions and, where possible, show the parent service/module. The current listing is just `filePath:lineNumber`, which the agent has to parse mentally.

## Subsystems Affected

- `sylphie-pkg` — `mcp-server/tools/getFunctionDetail.ts` (primary site)
- `sylphie-pkg` — `mcp-server/tools/getDataFlow.ts` (same pattern, same fix)
- `sylphie-pkg` — `mcp-server/tools/getModuleContext.ts` (consistency — could share a name-suggestion helper)
- `sylphie-pkg` — `mcp-server/neo4j-client.ts` (may need a small helper for similarity queries / APOC availability check)

## Open Questions

- Is APOC enabled on the Neo4j instance the PKG runs against? If not, would a pure-Cypher approach (e.g., `STARTS WITH` + `CONTAINS` + token overlap) be acceptable, or should the suggestion logic happen in TypeScript after fetching all Function names?
- How many suggestions to return? 3 feels right for chat-token economy, but 5 might be safer for cases where the top match is wrong.
- Should the "fuzzy fallback fired" notice be a structured field (e.g., a leading `MATCH MODE: suffix-fallback` line) or prose? Structured is friendlier for downstream parsing by other agents.
- Should the suggestion list be ranked by edit distance only, or also weighted by node connectivity (more-called functions ranked higher) so popular names float up?
- Is the same fix worth applying to `searchContent` (which has its own ranking model) or is that out of scope here?
- What's the current rate of "not found" responses from these tools? Worth a one-shot log query before/after to size the win.
