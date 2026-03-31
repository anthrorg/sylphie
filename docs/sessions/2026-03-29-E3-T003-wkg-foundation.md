# 2026-03-29 -- E3-T003: Neo4j WKG Foundation

## Summary
Implemented ticket E3-T003: Neo4j World Knowledge Graph (WKG) foundation. Created full WkgService implementation with core persistence and read methods.

## Changes
- **MODIFIED: src/knowledge/wkg.service.ts** -- Replaced stub with full implementation
  - OnModuleInit: Verifies Neo4j connection health
  - OnModuleDestroy: Graceful shutdown hook
  - `upsertNode()`: Core persistence with Confidence Ceiling enforcement and ACT-R initialization
  - `findNode()`: Direct node lookup by elementId
  - `healthCheck()`: Neo4j connectivity verification
  - All other methods: Typed errors referencing E3-T004 through E3-T007 tickets

## Key Design
- **Confidence Ceiling (Standard 3)**: Enforced at upsert time; confidence clamped to 0.60 for count === 0
- **Provenance discipline (CANON §7)**: Validation of required provenance field on every request
- **ACT-R initialization**: Default decay rates resolved from provenance source mapping
- **Typed errors**: KnowledgeException with structured context for failed operations

## Wiring
- NEO4J_DRIVER injected via knowledge.tokens symbol
- EVENTS_SERVICE placeholder (future events subsystem integration, E3-T004)
- Neo4jInitService runs before WkgService; constraints + indexes idempotent

## Known Issues
- queryEdges, queryActionCandidates, querySubgraph, etc. return typed NOT_IMPLEMENTED errors (correct per ticket spec)
- upsertEdge stub created (full edge semantics E3-T004)
- No events emitted yet (EVENTS_SERVICE integration pending)

## Gotchas for Next Session
- **MERGE vs CREATE semantics**: Current upsertNode uses MERGE; revisit if idempotency needs adjustment
- **Node ID generation**: Using `${label}_${timestamp}_${random}` — may need UUID strategy if duplicates appear
- **Session lifecycle**: Each operation opens/closes session; consider pooling if performance degrades
- **recordRetrievalAndUse stub**: Will require ACT-R state mutation in Neo4j (complex confidence formula)
