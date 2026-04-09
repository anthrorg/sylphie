# Research: Batch Neo4j Edge MERGEs in ExtractEdgesService

**Date:** 2026-04-09
**Status:** researched
**Verdict:** yes
**Source:** wiki/ideas/batch-neo4j-edge-merges-in-extract-edges.md

## Idea

Replace the sequential per-pair Neo4j session+MERGE calls in `ExtractEdgesService.extractEdges()` with a single UNWIND-based batched Cypher query, reducing up to 10 round-trips and 10 session lifecycles per event down to exactly one of each.

## Key Questions

- Is UNWIND+MERGE a well-established Neo4j batching pattern with known best practices?
- What are the trade-offs of all-or-nothing transaction semantics vs. the current partial-failure-tolerant loop?
- Does the Sylphie codebase already have patterns or infrastructure that support this refactor cleanly?
- Are there sibling services (`UpsertEntitiesService`, `CanProduceEdgesService`) that should receive the same treatment?

## Findings

### Prior Art

UNWIND+MERGE is the officially endorsed Neo4j pattern for batch writes. Neo4j's own developer relations team (Michael Hunger) has published guidance recommending this exact approach ("5 Tips & Tricks for Fast Batched Updates of Graph Structures"). The Neo4j Cypher Manual, all driver manuals (Java, Python, JavaScript, Go, .NET), and community resources consistently recommend batching via UNWIND for bulk MERGE/CREATE operations.

Real-world benchmarks show dramatic improvements: one study measured 7 million items loaded in ~107 seconds with UNWIND vs. 900+ seconds for sequential writes (roughly 9x faster). For small batches (~10 items), the absolute time savings are modest (milliseconds) but the relative improvement is significant due to elimination of per-query session setup/teardown and transaction commit overhead. The recommended batch size is 10k–50k rows per UNWIND statement, so batches of 10 are well within safe territory.

The pattern is also well-represented in the NestJS/TypeScript Neo4j ecosystem, with examples in `nestjs-neo4j-realworld-example` and the `@nhogs/nestjs-neo4j` package.

### Theoretical Grounding

The optimization is straightforward database engineering: amortize fixed per-operation overhead (TCP round-trip, session lifecycle, transaction commit) across N operations instead of paying it N times. With MAX_PAIRS=10 and up to 5 events per decision cycle, a full cycle currently pays up to 50 sequential round-trips. Batching reduces this to at most 5.

Transaction atomicity is the key design decision. Standard UNWIND executes within a single implicit transaction (all-or-nothing). The current sequential loop allows partial success (9 of 10 pairs can succeed even if 1 fails). Neo4j 5+ offers `CALL { } IN TRANSACTIONS OF N ROWS` with `ON ERROR CONTINUE` for partial-failure semantics, but this adds complexity. Given that the current code already silently drops individual failures (logs and continues), all-or-nothing semantics are likely acceptable — a single failed MERGE in a batch of 10 independent entity pairs is unlikely, and if it occurs, retrying the entire batch on the next cycle is a reasonable recovery strategy.

### Technical Feasibility

**Current architecture:** `extractEdges()` iterates over entity pairs and awaits `mergeRelatedToEdge()` for each one. Each call opens a fresh Neo4j write session via `getSession()`, runs a single MERGE query, closes the session, and returns a boolean. Errors are caught, logged, and the loop continues.

**Existing codebase patterns:** The codebase already uses UNWIND for batch reads in `WkgContextService`, and transaction-based multi-statement patterns exist in `sylphie-pkg/src/ingestion/initial-seed.ts` (with proper `beginTransaction()` → `run()` → `commit()` and rollback error handling). These demonstrate that the infrastructure supports batched Neo4j operations.

**Sibling services with the same pattern:**
- `UpsertEntitiesService`: Sequential loop over entity labels with individual `mergeEntityNode()` calls (up to 20 entities per event). Same session-per-query pattern.
- `CanProduceEdgesService`: Sequential loops for Word nodes and CAN_PRODUCE edges. Creates 2 sessions per phrase.

Both are candidates for the same optimization.

**Implementation path:** The proposed UNWIND query from the idea file is well-formed and matches established patterns. The refactor is localized to `extractEdges()` and the `mergeRelatedToEdge()` private method — no interface or return-type changes are needed.

## Assessment

| Dimension    | Rating   |
|-------------|----------|
| Plausibility | high     |
| Complexity   | trivial  |
| Fit          | strong   |
| Risk         | low      |

## Verdict

This is a straightforward, well-established optimization with clear prior art and official Neo4j endorsement. The codebase already has the infrastructure to support it, and the refactor is localized to a single service method. The only design decision is whether to accept all-or-nothing transaction semantics (recommended) or add complexity for partial-failure handling (unnecessary given current error-handling behavior). This should be implemented.

## Implementation Path

1. Add an `extractEdgesBatched()` method to `ExtractEdgesService` that accepts all pairs and a confidence value, constructs a single UNWIND+MERGE Cypher query, and executes it in one session.
2. Ensure `UNIQUE CONSTRAINT` or `INDEX` exists on `Entity.node_id` — this is critical for MERGE performance. Verify this exists; if not, add it.
3. Replace the sequential loop in `extractEdges()` with a call to `extractEdgesBatched()`. Compare returned record count against expected pair count for summary logging.
4. Update error handling: wrap the single query in try/catch, log the batch failure, and return an empty result set on error. If partial-failure semantics are later desired, introduce `CALL { } IN TRANSACTIONS OF 1 ROW` (Neo4j 5+).
5. Apply the same UNWIND batching pattern to `UpsertEntitiesService.upsertEntities()` and `CanProduceEdgesService.createEdges()` as follow-up tickets.
6. Benchmark before/after to quantify the improvement (expect meaningful gains especially under load with multiple events per cycle).

## Sources

- [UNWIND - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/clauses/unwind/)
- [5 Tips & Tricks for Fast Batched Updates - Neo4j Medium](https://medium.com/neo4j/5-tips-tricks-for-fast-batched-updates-of-graph-structures-with-neo4j-and-cypher-73c7f693c8cc)
- [Loading 7M items to Neo4j with and without UNWIND](https://achantavy.github.io/cartography/performance/cypher/neo4j/2020/07/19/loading-7m-items-to-neo4j-with-and-without-unwind.html)
- [CALL subqueries in transactions - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/subqueries/subqueries-in-transactions/)
- [Neo4j Performance Recommendations - Driver Manual](https://neo4j.com/docs/python-manual/current/performance/)
- [Concurrent data access / Locks & Deadlocks - Operations Manual](https://neo4j.com/docs/operations-manual/current/database-internals/locks-deadlocks/)
- [nestjs-neo4j-realworld-example - GitHub](https://github.com/neo4j-examples/nestjs-neo4j-realworld-example)
