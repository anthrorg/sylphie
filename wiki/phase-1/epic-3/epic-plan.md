# Epic 3: Knowledge Module (WKG + Self KG + Other KG)

## Summary

Transform the knowledge module from stubs (E0) into a fully functional brain for Sylphie: real Neo4j World Knowledge Graph (WKG) with provenance enforcement, confidence ceilings, and contradiction detection; Grafeo-based Self Knowledge Graph and per-person Other Knowledge Graphs with complete isolation; ACT-R confidence dynamics with retrieval-and-use tracking; and query interfaces that serve Decision Making, Learning, Communication, and Planning subsystems.

The WKG is the architectural center of gravity. Everything else either reads from it or writes to it. This epic is the single most complex in Phase 1.

## Why This Epic Matters

The World Knowledge Graph is not a database feature—it IS Sylphie's brain. Without a working WKG, all five subsystems are isolated silos that cannot observe each other's behavior or learn from experience. After E3:

- **Decision Making** retrieves actions and procedures from WKG with confidence thresholds
- **Learning** writes extracted entities and edges to WKG with provenance tagging
- **Communication** queries WKG for context when building responses
- **Planning** researches patterns in WKG to detect opportunities
- **Drive Engine** reads confidence-weighted knowledge for self-evaluation

The Confidence Ceiling (Immutable Standard 3) ensures that knowledge cannot exceed 0.60 confidence without proven retrieval-and-use. This prevents LLM-generated plausibility from being mistaken for genuine understanding.

Contradiction detection (Piaget's assimilation/accommodation framework) ensures that the WKG develops through real learning, not just data accumulation. When contradictions are detected, they surface to the Drive Engine as integrity disequilibrium, triggering learning episodes.

The isolation of Self KG and Other KGs from WKG prevents the system from contaminating its self-model with world knowledge, which would corrupt drive-based self-evaluation and person modeling.

## Ticket Summary (17 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E3-T001 | Knowledge types system: node/edge/confidence/provenance types | M | - |
| E3-T002 | WkgService skeleton + Neo4j DI wiring + exceptions | M | T001 |
| E3-T003 | upsertNode() with provenance enforcement + ceiling validation | M | T002 |
| E3-T004 | upsertEdge() with confidence dynamics + contradiction detection | M | T003 |
| E3-T005 | findNode() and queryEdges() with filtering + retrieval tracking | M | T003 |
| E3-T006 | queryContext() for Decision/Communication subsystems (bounded traversal) | M | T005 |
| E3-T007 | ConfidenceService: ACT-R formula wrapping + retrieval-and-use tracking | M | T001 |
| E3-T008 | Self KG schema design + SelfKgService skeleton (Grafeo) | M | T001 |
| E3-T009 | SelfKgService implementation: capability/drive_pattern/prediction_accuracy nodes | L | T008 |
| E3-T010 | Other KG registry + per-person OtherKgService instances (Grafeo) | M | T008 |
| E3-T011 | Other KG schema implementation: person_model/interaction_history/prediction nodes | L | T010 |
| E3-T012 | Event emission for knowledge mutations via IEventService (contradiction events) | M | T004 |
| E3-T013 | Guard + validation layer: provenance.guard.ts, confidence-ceiling.guard.ts | M | T003 |
| E3-T014 | Grafeo technology spike: feasibility + fallback alternatives if unsuitable | L | T001 |
| E3-T015 | WKG query utilities + builder patterns (Cypher generation, filter DSL) | M | T005 |
| E3-T016 | Neo4j schema bootstrap: constraints, indexes, metadata initialization | M | T002 |
| E3-T017 | Integration test suite + confidence dynamics verification + query performance benchmarks | L | T003-T016 |

## Parallelization

```
E3-T001 (Knowledge types)
  |
  +------ E3-T014 (Grafeo spike) ------+
  |                                    |
  v                                    v
E3-T002 (WkgService skeleton)    E3-T008 (Self KG schema)
  |                                    |
  +------ E3-T016 (Neo4j bootstrap)   +------- E3-T010 (Other KG registry)
  |                                    |          |
  v                                    v          v
E3-T003 (upsertNode)          E3-T009 (SelfKg impl)  E3-T011 (OtherKg impl)
  |
  +------- E3-T013 (Guards)
  |
  v
E3-T004 (upsertEdge) --------- E3-T012 (Event emission)
  |
  v
E3-T005 (find/query)
  |
  +------- E3-T015 (Query utilities)
  |
  v
E3-T006 (queryContext) -------- E3-T007 (ConfidenceService)
  |                               |
  +----------+----------+----------+
             |
             v
          E3-T017 (Integration tests)
```

## Key Design Decisions

The following decisions (with full rationale) are documented in `decisions.md`:

1. **Lazy confidence computation (on read, not write)** — Confidence is computed dynamically via ACT-R when nodes are retrieved, not stored. Reduces update cost, ensures freshness.

2. **Single WkgNode label with is_instance flag** — All nodes carry :WkgNode label; is_instance boolean distinguishes ABox (instance) from TBox (schema). Simpler than separate labels per level.

3. **Grafeo technology spike before full implementation** — Self KG and Other KG implementations depend on Grafeo viability. Spike validates feasibility; fallbacks to RocksDB or Neo4j if unsuitable.

4. **Contradiction edges (CONTRADICTS relationship) rather than blocking writes** — Conflicting edges coexist; CONTRADICTS edges flag the conflict with evidence. Preserves both views, surfaces to Drive Engine.

5. **Provenance enforcement at service layer + TypeScript guards** — Provenance required on every write; validated in code before Neo4j call. Guards prevent common errors.

6. **Events emitted for knowledge mutations via IEventService** — Every upsertNode/upsertEdge emits KNOWLEDGE_CREATED or KNOWLEDGE_UPDATED event with provenance. Contradiction events trigger immediately.

7. **Guardian Asymmetry as retrieval_count multiplier** — Guardian confirmation 2x weights retrieval-and-use; Guardian correction 3x weights. Implemented as metadata flag + multiplier in confidence formula.

8. **Bounded subgraph traversal for queryContext()** — Prevents quadratic explosion. Limits to 2-hop neighborhood with max 100 nodes per query. Configurable per subsystem.

9. **Self KG schema: capabilities, drive_patterns, prediction_accuracy** — Sylphie's self-model tracks: what she can do (capabilities), how her drives respond to stimuli (drive_patterns), how accurate her predictions are (prediction_accuracy).

10. **KG isolation through separate service classes and Grafeo instances** — WKG, Self KG, Other KG(s) implemented as separate services. Self KG and Other KGs use Grafeo (embedded), never Neo4j. Zero shared edges.

## Agent Analyses

**Atlas (Knowledge Graph Architect):** WKG schema realization (three-level architecture: instance, schema, meta-schema), node/edge properties, Neo4j constraints, Cypher query patterns for all major operations. Risk assessment: confidence computation correctness, contradiction suppression, assimilation-only attractor.

**Forge (Architectural Engineer):** NestJS module structure (exports, DI tokens), interface refinement (full method signatures), provider patterns, cross-module coordination, isolation enforcement via type and runtime guarantees. Risk assessment: Grafeo lifecycle, Neo4j transaction semantics, performance under high write load.

**Sentinel (Infrastructure Engineer):** Complete Neo4j implementation (node/edge schema, constraints, indexes), Grafeo technology validation + fallback alternatives (RocksDB, embedded SQLite), migration strategy if Grafeo unsuitable. Performance estimates: query latencies, index efficiency, scaling limits.

**Canon (Project Integrity Guardian):** CANON compliance analysis across all 11 checks. 8 COMPLIANT. 6 critical gaps requiring Jim approval (listed below). Provenance immutability, confidence ceiling enforcement, three-level schema distinction, guardian feedback mechanism, retrieval-and-use definition, contradiction detection strategy.

**Science (Piaget + Ashby):** Knowledge construction as developmental process. Assimilation vs. accommodation balance. Contradiction as developmental catalyst (Piaget's disequilibrium). Confidence ceiling as Zone of Proximal Development boundary. Risk: premature suppression of contradictions, pathological assimilation, rule drift in meta-schema.

## Decisions Requiring Jim

These six gaps from Canon's CANON analysis must be resolved before E3 implementation begins:

1. **Three-level WKG schema design**: How are instance/schema/meta-schema nodes distinguished in Neo4j? Option A: Separate labels (Instance, Schema, MetaRule). Option B: Single WkgNode label with type_level property. Option C: Implicit (different node properties determine level).

2. **Guardian feedback mechanism**: When guardian confirms LLM-generated knowledge, how does confidence update? Option A: Preserve provenance, add guardianConfirmed metadata, apply 2x multiplier in retrieval formula. Option B: Create separate GUARDIAN-provenance edge alongside LLM_GENERATED edge (merger logic needed). Option C: Replace LLM_GENERATED edge with GUARDIAN (violates provenance immutability).

3. **Retrieval-and-use definition**: What constitutes successful retrieval-and-use for confidence increment? Must specify success criteria for Decision Making (action selected → action succeeds), Learning (edge extracted → no contradiction), Planning (pattern researched → plan proposed).

4. **Contradiction detection strategy**: What types of contradictions should be detected (logical, domain-specific, temporal)? Should contradictions block writes or flag-and-proceed? Should contradiction severity be computed (soft vs hard)?

5. **Self-Evaluation Protocol (CANON A.8)**: SelfKgService needs explicit protocol for how Sylphie evaluates her own accuracy. Currently undefined. Does it read from prediction outcomes in Events? How does the Drive Engine use Self KG for self-evaluation?

6. **Knowledge Domain Structure (CANON A.9)**: Should WKG be flat (single namespace) or domain-partitioned (medical, spatial, social domains as separate sub-graphs)? Affects MERGE logic, query routing, Learning consolidation targets.

## Ashby Feedback Loop Analysis

Knowledge construction runs on three nested feedback loops:

**Fast loop (<500ms):** Decision Making retrieves action → executes → outcome recorded → next decision. Negative/stabilizing when retrieval confidence is accurate.

**Medium loop (5-60s):** Learning consolidates events → extracts entities → WKG grows → Decision Making retrieves new nodes. Positive/amplifying — limited by consolidation debt backlog.

**Slow loop (5+ min):** Retrieval-and-use events accumulate → confidence increases → Type 1 candidates emerge. Positive/amplifying — limited by Confidence Ceiling and graduation threshold (confidence > 0.80 AND MAE < 0.10).

**Risk: Knowledge Overconfidence.** If retrieval success tracking is inaccurate, confidence grows faster than competence. Mitigation: Type 1 graduation requires TWO criteria (confidence AND prediction accuracy), not just one. The MAE check catches overconfident knowledge.

**Risk: Contradiction Suppression.** If contradictions are detected but not emitted as events, they don't surface to Drive Engine. The system assimilates everything, never accommodates. Mitigation: E3-T012 mandates immediate event emission on contradiction detection.

## v1 Sources

| v1 File | v2 Destination | Lift Type |
|---------|---------------|-----------|
| `co-being/packages/knowledge-graph/src/wkg/wkg.service.ts` | E3-T003-T006 (WkgService methods) | Conceptual (clean-room rewrite with E1/E2 constraints) |
| `co-being/packages/knowledge-graph/src/confidence/confidence.service.ts` | E3-T007 (ConfidenceService) | Partial (ACT-R formula reused, Lesion Test tracking) |
| `co-being/packages/knowledge-graph/src/self-kg/self-kg.service.ts` | E3-T009 (SelfKgService) | Conceptual (Grafeo-based vs. Neo4j) |
| `co-being/packages/knowledge-graph/src/other-kg/other-kg.service.ts` | E3-T011 (OtherKgService) | Conceptual (multi-instance per person) |
| v1 ConflictDetection logic | E3-T004 (contradiction detection) | Refactored (Piagetian framework instead of error suppression) |
| v1 Neo4j schema migration | E3-T016 (bootstrap) | Partial (constraints and indexes reused) |
