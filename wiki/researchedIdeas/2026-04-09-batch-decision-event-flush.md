# Research: Batch INSERT for DecisionEventLoggerService.flush()

**Date:** 2026-04-09
**Status:** researched
**Verdict:** yes
**Source:** wiki/ideas/batch-decision-event-flush.md

## Idea

Replace the sequential per-event INSERT loop in `DecisionEventLoggerService.flush()` with a single multi-row INSERT statement, reducing up to 10 individual database round-trips per flush cycle down to one.

## Key Questions

- Is multi-row INSERT with parameterized placeholders well-supported in node-postgres / TimescaleDB?
- What are the tradeoffs of atomic batch failure vs. per-event error isolation for observability data?
- Are there better approaches than raw multi-row INSERT (COPY, UNNEST, driver-level batching)?
- Does the Sylphie codebase already have a reference implementation for this pattern?

## Findings

### Prior Art

Multi-row INSERT is a thoroughly well-established PostgreSQL optimization. Benchmarks consistently show dramatic improvements:

- Inserting 1,000 records via multi-row INSERT shows ~12,000% improvement over single-row loops (Jason Mitchell, Tiger Data benchmarks).
- TimescaleDB specifically benefits because batch INSERT resolves chunk routing for the entire VALUES list in a single planner invocation, vs. per-row for single inserts.
- For small batches (10-50 rows), multi-row INSERT is the consensus best practice. COPY protocol and UNNEST-based approaches offer even higher throughput but are overkill for batches of 10 events.
- The `pg` (node-postgres) library supports parameterized multi-row INSERT natively, though it doesn't auto-generate placeholder numbering — manual `$1, $2, ...` construction or helper libraries (`pg-format`, `pg-parameterize`) are needed.

**Alternative approaches considered:**

| Approach | Throughput | Fit for 10-event batch |
|----------|-----------|----------------------|
| Multi-row INSERT (VALUES) | 5k-20k rows/sec | Best fit — simple, ACID, familiar |
| INSERT...UNNEST | 2-5x faster than VALUES | Overkill for 10 rows, less intuitive |
| COPY protocol | 50-100k+ rows/sec | Massive overkill, bypasses triggers |
| postgres.js tagged templates | Native batch support | Would require driver swap |

### Theoretical Grounding

The optimization is straightforward database theory: amortizing network round-trip latency and query parsing overhead across N rows instead of paying it N times. With a 100ms flush interval and up to 10 events, the current implementation pays for 10 sequential round-trips (each including TCP handshake overhead, query parse, plan, execute, commit). The batched version pays once.

PostgreSQL's multi-row INSERT is atomic by default — all rows succeed or all fail. This is a semantic change from the current per-event try/catch, but for observability events (not critical state), atomic failure is the pragmatic choice, as noted in the original idea.

### Technical Feasibility

**Existing pattern in the codebase:** The Drive Engine's `TimescaleWriter` class (`packages/drive-engine/src/drive-process/timescale-writer.ts`) already implements multi-value INSERT batching with parameterized placeholders. It builds a single INSERT with multiple value clauses (`($1,$2,...), ($9,$10,...), ($17,$18,...)`), includes retry logic with exponential backoff, and is production-ready. This serves as a direct reference implementation.

**Implementation path is clear:**
- The `flush()` method (lines 138-160 in `decision-event-logger.service.ts`) currently iterates over buffered events and calls `this.timescale.query()` per event.
- The `TimescaleService.query()` method accepts any SQL string + parameter array via the `pg` Pool — fully supports multi-value INSERT.
- The events table schema has 9 columns (`id`, `type`, `timestamp`, `subsystem`, `session_id`, `drive_snapshot`, `payload`, `correlation_id`, `schema_version`), all well-defined.
- No caller-facing API changes needed — `flush()` signature stays the same.
- No existing unit tests for `DecisionEventLoggerService`, so no test breakage risk (though tests should be added).

**Parameter limits are not a concern:** The `pg` driver supports up to 65,535 parameters per query. With 9 columns per event and a BATCH_SIZE of 10, that's 90 parameters — well under the limit. Even if BATCH_SIZE grows to 1,000, it would only use 9,000 parameters.

## Assessment

| Dimension    | Rating   |
|-------------|----------|
| Plausibility | high     |
| Complexity   | trivial  |
| Fit          | strong   |
| Risk         | low      |

## Verdict

This is a clear yes. The optimization is well-understood, low-risk, and the codebase already contains a reference implementation in the Drive Engine's `TimescaleWriter`. The change is small (modifying ~20 lines in `flush()`), requires no architectural decisions, and delivers a meaningful reduction in database round-trips during high-activity decision cycles. The atomic failure tradeoff is acceptable for observability data.

## Implementation Path

1. **Reference the existing pattern** in `TimescaleWriter.buildInsertQuery()` for placeholder construction.
2. **Modify `flush()`** to build a single multi-row INSERT with parameterized placeholders for all buffered events, replacing the per-event loop.
3. **Update error handling** to log batch-level failures (include event count and sample of event types in the error message so nothing is silently lost).
4. **Add unit tests** for `flush()` covering: successful batch insert, empty buffer (no-op), and batch failure logging.
5. **Optional enhancement**: Add exponential backoff retry matching the Drive Engine pattern (currently no retry on failure).
6. **Optional enhancement**: If `BATCH_SIZE` is ever increased beyond ~3,000, add defensive chunking to stay under the 65,535 parameter limit.

## Sources

- [Postgres Performance: Multi-Row Insert | Jason Mitchell](https://json.codes/posts/databases/postgres-multi-row-insert/)
- [Boosting Postgres INSERT Performance by 50% | Tiger Data](https://www.tigerdata.com/blog/boosting-postgres-insert-performance)
- [Boosting Postgres INSERT Performance by 2x With UNNEST | Tiger Data](https://www.tigerdata.com/blog/boosting-postgres-insert-performance)
- [Bulk load performance in PostgreSQL | CYBERTEC](https://www.cybertec-postgresql.com/en/bulk-load-performance-in-postgresql/)
- [Optimizing bulk loads: COPY vs INSERT | pganalyze](https://pganalyze.com/blog/5mins-postgres-optimizing-bulk-loads-copy-vs-insert)
- [INSERT | Timescale Docs](https://docs-dev.timescale.com/docs-tutorial-lambda-cd/timescaledb/tutorial-lambda-cd/how-to-guides/distributed-hypertables/insert/)
- [node-postgres multi-row insert discussion | GitHub #957](https://github.com/brianc/node-postgres/issues/957)
- [Testing Postgres Ingest: INSERT vs Batch vs COPY | Tiger Data](https://www.tigerdata.com/learn/testing-postgres-ingest-insert-vs-batch-insert-vs-copy)
- Internal reference: `packages/drive-engine/src/drive-process/timescale-writer.ts` (existing batch INSERT pattern)
