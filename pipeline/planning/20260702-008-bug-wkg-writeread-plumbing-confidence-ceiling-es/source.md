# Bug: WKG write/read plumbing — confidence-ceiling escape, no-op contradiction gate, phantom node_ids, property-name drift

**Severity:** high  ·  **Priority:** P1
**Area / component:** decision-making / WKG (packages/decision-making/src/wkg + arbitration)

## What's broken (required)
The newest KG paths (candidate staging, guardian promotion, reinforcement) are careful and CANON-compliant, but older write/read plumbing has drifted and now contains genuine theater — silent-empty Cypher presented as success — plus a confidence-ceiling escape:
- **Dedup boost bypasses the 0.60 ceiling (CANON Std-3/Std-6).** On a Jaccard match (>0.70), `wkg-context.service.ts:823` does `Math.min(1.0, existingConf + 0.05)` — bespoke math, no guardian confirmation, no `computeConfidence()`, capped at 1.0 instead of 0.60. Repeated similar inputs can drive an unconfirmed INFERENCE procedure to conf 1.0; with `W_CONFIDENCE=0.50` it then out-ranks everything (the documented runaway class, TK-104). Contrast `reinforceFactNode()` :740 which correctly clamps to 0.60.
- **Pre-commit contradiction scanner is a structural no-op.** `contradiction-scanner.service.ts:108` matches `(:ActionProcedure {id:$id})-[:CONTRADICTS]-(c)` and reads `c.claim/c.existingFact/c.confidence`, but the only CONTRADICTS writer (`detect-contradictions.service.ts:151-169`) (a) only creates CONTRADICTS between entity/candidate nodes, never ActionProcedures; (b) procedures carry `node_id`, not `id`; (c) stores those props on the **edge**, not the neighbour node. The coherence gate ArbitrationService relies on can never fire — every scan returns "clean."
- **`writeEntity()` returns a phantom `node_id` on MERGE match.** `wkg-context.service.ts:370-401` generates `entity-${uuid}`, MERGEs on `{label}` (node_id set only ON CREATE), and returns the local id — ignoring the query's `RETURN node.node_id`. On a pre-existing entity the caller gets an id that exists on no node; RESEARCH_ENTITY edges (`action-handler-registry.service.ts:512-538`) then MATCH nothing, MERGE never runs, zero rows, no error — and the handler logs `edgesCreated` success. (Learning's `upsert-entities.service.ts:257-259` fixed this exact bug.)
- **RELIEVES drive-links are guaranteed no-ops.** `wkg-context.service.ts:899-903` MATCHes `(d:Drive {drive_name})`, but no `:Drive` nodes are created anywhere in the repo; every call returns zero rows yet logs success (:915-918).
- **`matchProcedures()` reads only `p.triggerContext`.** `wkg-context.service.ts:1155`; planning writes `trigger_context` (snake_case) → all planned/guardian-taught procedures are filtered out of `getContextForFrame()`. Other readers coalesce both spellings; this one was missed.
- Lower: `reinforceFactNode()` read-modify-write is non-transactional (can stomp a concurrent guardian promotion); bootstrap seeds minted at 0.60 vs documented 0.40 base; `getSubgraph()` discards neighborhood rels + string-interpolates `depth`; `writeEntity` APOC-fallback drops all properties + no ceiling on ON MATCH confidence lift; `writeRelationship()` ignores its `properties` param and logs success on zero-row no-ops; `promoteCandidate()` reports infra failure as `not_found`; `getBaseContext()` defaults missing confidence to 1.0; promoted candidates keep `node_type:'Candidate'`.

## Expected (required)
No write path can lift a node/procedure above 0.60 without guardian confirmation and without going through `computeConfidence()`; the contradiction gate matches the actual CONTRADICTS shape and can fire; `writeEntity` returns the real persisted `node_id` so downstream edges land; RELIEVES either links to real drive representations or is removed; `matchProcedures` sees procedures under both trigger-context spellings; and no write helper logs success on a zero-row no-op.

## Steps to reproduce (required)
1. Feed two near-identical Type-2 opportunities so the second Jaccard-matches the first (>0.70). Observe the stored procedure confidence climb +0.05 per repeat toward 1.0 (query the node), exceeding the 0.60 ceiling.
2. Run a RESEARCH_ENTITY action for an entity whose label already exists. Observe the handler logs `edgesCreated: N` while the graph gains zero new relationships.
3. Teach a procedure via planning (writes `trigger_context`), then request frame context — the procedure is absent from `matchProcedures` results.

**Reproducibility:** always (source-trace; confirm live)

## Evidence
- Boost: `wkg-context.service.ts:823` (vs clamp at :740).
- Contradiction: `contradiction-scanner.service.ts:108` vs `packages/learning/src/pipeline/detect-contradictions.service.ts:151-169`.
- Phantom id: `wkg-context.service.ts:370-401`; dropped edges `action-handler-registry.service.ts:512-538`.
- RELIEVES: `wkg-context.service.ts:899-903,915-918`; no `:Drive` writers (grep; only index at `apps/sylphie/src/services/wkg-query.service.ts:96`).
- matchProcedures: `wkg-context.service.ts:1155`; planning writes `procedure-creation.service.ts:92`.
- Lower: `wkg-context.service.ts:700-752,405-426,441-471,291-314,615-626,1032`; seeds `action-retriever.service.ts:519`.
- Verified clean (do not re-file): session hygiene, Jaccard math, Lucene escaping, `sanitizeRelType` injection guard, server-side Std-5 guardian gate, `:Candidate` exclusion on all four grounding read-paths.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §2.

## Where it lives (scope hints)
`packages/decision-making/src/wkg/wkg-context.service.ts` (boost, writeEntity, RELIEVES, matchProcedures, reinforce, getSubgraph, getBaseContext), `packages/decision-making/src/arbitration/contradiction-scanner.service.ts`, cross-ref the writer `packages/learning/src/pipeline/detect-contradictions.service.ts` and `packages/decision-making/src/action-handlers/action-handler-registry.service.ts`. Owned by `atlas` (WKG code) per CLAUDE.md work-trio.

## Database impact (required)
**Touches a database / schema / migration?** yes — Neo4j (WORLD/OTHER), but **no schema migration**: these are Cypher query corrections (property names, returned ids, match shapes) and confidence-value logic, operating on the existing graph model. No destructive change; no init-file edit. Worth a data note: existing procedures already boosted past 0.60 by the dedup bug may need a one-time re-clamp (flag for the migration/backfill decision, not a schema change).

## Acceptance — how we'll know it's fixed (required)
- Given repeated Jaccard-matching opportunities, when dedup boosts an unconfirmed procedure, then its confidence never exceeds 0.60 and is computed via `computeConfidence()` (unit test on the dedup path).
- Given a CONTRADICTS edge in its real written shape, when the scanner runs, then it detects the contradiction (fixture-backed test against `detect-contradictions` output).
- Given a `writeEntity` call on a pre-existing label, when it returns, then the id resolves to a real node and a subsequent `writeRelationship` creates the edge (integration test) — and zero-row writes no longer log success.
- Given a planning-created procedure (`trigger_context`), when `getContextForFrame` runs, then the procedure appears in `matchProcedures` results.

## Environment
Local dev + any deploy with a populated graph. Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The dedup boost interacts with TK-104's rank-time seed-domination patch; fixing the write-time ceiling is the durable fix — coordinate so they don't double-correct.
- Non-goal: semantic/fuzzy dedup at write time (needs the embedding service; out of scope per the existing §1.3 KNOWN LIMITATION).
- Non-goal: introducing real `:Drive` nodes as a modeling change — decide whether RELIEVES should link to an existing representation or be removed (architect call).
