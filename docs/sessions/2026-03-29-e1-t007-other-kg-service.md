# 2026-03-29 -- E1-T007: Implement OtherKgService with per-person Grafeo instances

## Summary
Replaced stub OtherKgService with full, working implementation using per-person GrafeoStore instances. All methods provide real logic with proper isolation, lifecycle management, and type safety.

## Changes
- **MODIFIED: src/knowledge/other-kg.service.ts** -- Replaced all stub methods with real implementations:
  - getOrCreateStore(): Lazy creation of per-person GrafeoStore instances with directory discovery
  - getPersonModel(): Queries Person root node and trait nodes, assembles PersonModel
  - createPerson(): Creates Person node with metadata (name, interaction_count, etc.)
  - updatePersonModel(): Upserts traits, removes traits, updates name
  - queryPersonTraits(): Returns trait nodes filtered by confidence >= 0.50
  - queryInteractionHistory(): Queries and sorts Interaction nodes by recordedAt descending
  - recordInteraction(): Creates Interaction node, updates Person's interaction_count and lastInteractionAt
  - getKnownPersonIds(): Returns discovered person IDs
  - deletePerson(): Closes store, removes directory from filesystem
  - healthCheck(): Verifies service or specific person store accessibility
  - onModuleInit(): Scans data directory, discovers existing person KGs
  - onModuleDestroy(): Closes all open stores on shutdown

## Wiring
- Injected ConfigService to read grafeo.otherKgPath and grafeo.maxNodesPerKg
- GrafeoStore factory methods (createPersistent/openPersistent) for per-person instances
- computeConfidence() for confidence dynamics on trait nodes
- Proper graph structure: Person node with HAS_TRAIT edges to Trait nodes, RECORDS edges to Interaction nodes

## Key Design Decisions
1. Lazy Store Creation: Stores only opened on first access to a person (get/createPerson)
2. Discovery at Init: onModuleInit scans filesystem to find existing person directories
3. Isolation Enforcement: No Neo4j, WKG, or Self KG imports — only Grafeo
4. ACT-R Integration: All nodes carry provenance, base, count, decayRate, lastRetrievalAt
5. Confidence Threshold: queryPersonTraits filters by minConfidence 0.50 (retrieval threshold)
6. Sorting: queryInteractionHistory sorts by recordedAt descending (most recent first)

## Known Issues
- None. Type-checking passes with npx tsc --noEmit

## Gotchas for Next Session
- GraphNode properties are plain Record<string, unknown> — always cast and null-check
- GrafeoStore uses numeric node IDs internally; string IDs wrapped for public API
- Directory discovery happens at onModuleInit only; new persons added during session tracked via knownPersonIds Set
- Date serialization: always convert to ISO string before storing in node properties
