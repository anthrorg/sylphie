# 2026-03-29 -- Implement ProvenanceHealthService (E7-T013)

## Changes
- NEW: `src/learning/metrics/provenance-health.service.ts` -- Full implementation of ProvenanceHealthService with three core methods

## Wiring Changes
- Service is @Injectable() and uses DI for WKG_SERVICE and EVENTS_SERVICE
- Implements IProvenanceHealthService interface for internal use in Learning subsystem
- No module exports yet (pending integration into learning module)

## Methods Implemented

### assessHealth()
- Queries WKG via `queryGraphStats()` to get provenance distribution
- Aggregates core sources (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE)
- Considers extended sources (GUARDIAN_APPROVED_INFERENCE, TAUGHT_PROCEDURE, BEHAVIORAL_INFERENCE, SYSTEM_BOOTSTRAP)
- Computes experiential ratio: (experiential_count / total_nodes)
- Computes LLM dependency ratio: (llm_count / total_nodes)
- Classifies health status:
  - HEALTHY: experiential > 0.6 AND llm_dependency < 0.5 AND guardian >= 0.15
  - UNHEALTHY: experiential < 0.3 OR llm_dependency > 0.7 OR guardian < 0.05
  - DEVELOPING: intermediate values
- Maintains rolling history (max 10 snapshots) for trend analysis
- Returns ProvenanceHealth with ratios and classification

### executeLesionTest()
- Non-destructive read-only test per CANON requirements
- Measures KG resilience by excluding LLM_GENERATED edges
- Queries full graph via `queryGraphStats()` for baseline edge count
- Queries subgraph with high limits to capture all edges
- Filters edges in-memory (provenance != 'LLM_GENERATED')
- Returns resilience ratio: lesioned_edges / full_edges
- Target: >= 0.4 indicates healthy knowledge base
- Handles empty graph case (trivial resilience = 1.0)

### emitHealthMetrics()
- Cycle counter tracks calls; emits every 10 cycles
- Calls assessHealth() and executeLesionTest() on emission threshold
- Logs comprehensive metrics (resilience, status, experiential ratio)
- Returns boolean: true if emitted, false if threshold not met
- Non-throwing: health check failures log but don't propagate
- Note: Full event emission deferred pending PROVENANCE_HEALTH event type addition

## Known Issues
- Event emission deferred: emitHealthMetrics() computes metrics and logs them but cannot emit PROVENANCE_HEALTH events yet because that event type is not in the EventType union (src/shared/types/event.types.ts). Needs a follow-up PR to add PROVENANCE_HEALTH to EventType and EVENT_BOUNDARY_MAP.
- Lesion Test implementation uses in-memory filtering rather than Neo4j filtering for pragmatism. In production, could optimize by pushing filter to Cypher query.

## Gotchas for Next Session
- Remember to add PROVENANCE_HEALTH event type to EventType union and EVENT_BOUNDARY_MAP for full event emission
- Lesion Test with high maxNodes limit (10000) could be slow on very large graphs; may need paginated implementation later
- Health history is in-memory only; persists only during service lifetime. For permanent trend analysis, either emit events or persist to separate metrics store
- Service depends on both WKG_SERVICE and EVENTS_SERVICE; ensure both are available at injection time
