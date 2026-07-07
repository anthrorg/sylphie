# Migration plan — 20260702-010

## Verdict: N/A — no DB surface touched

Per `pipeline/policies/db-change-safety.md` §"The gate", a change "touches a DB" if it hits
Postgres/TimescaleDB/Neo4j, any `*.sql`/`*.cypher`, a pgvector dimension, or an embedding
dim/version constant. This change hits none of those.

## Why, specifically (verified by reading the code, not assumed)

The fix reuses the **existing** read-only Cypher in `loadFacts`
(`apps/sylphie/src/services/person-model.service.ts:301-307`):

```cypher
MATCH (p:Person {node_id: $userId})-[:HAS_FACT]->(a:Attribute)
RETURN a.key AS key, a.value AS value, a.confidence AS confidence,
       a.source AS source, a.learned_at AS learnedAt
ORDER BY a.confidence DESC
```

verbatim, unmodified. Both tickets in `plan.md`:

- **20260702-010-a** adds two new methods (`hydrateOnConnect`, `awaitHydration`) to
  `PersonModelService` that wrap this existing call with a `Map<string, Promise<void>>` for
  in-flight tracking — pure in-memory TypeScript bookkeeping, no new query, no new
  Cypher, no schema object (label, constraint, index) added or changed.
- **20260702-010-b** only changes *call sites and ordering* in
  `apps/sylphie/src/gateways/conversation.gateway.ts` (when `hydrateOnConnect` fires, when
  `awaitHydration` is awaited relative to `intakeTurn`) — no database code at all.

No new tables/labels/constraints/indexes. No mutation of existing Attribute/Person nodes or
rows (this is a **read** path, same as the "Who am I?" trigger that already calls the
identical query today). No pgvector/embedding dimension involved. No `infra/**` change.

## dbcheck disposition

`pipeline.py dbcheck 20260702-010` should record: **no DB surface** — confirmed by source
read (loadFacts query unchanged), not by keyword heuristic. (Per the pipeline's own known
gotcha, prose mentions of "cache"/"OKG"/"Neo4j" can false-positive the keyword scan; this
note is the deliberate override with evidence, matching the house convention already used
by other items, e.g. item 003's corrected dbcheck.)

No migration script, no dry-run, no `--confirm`, no backup/REVERSE needed — there is nothing
to migrate.
