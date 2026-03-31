# Epic 7: Learning (Consolidation Pipeline) — Executive Summary

**Status:** Planning Complete
**Scope:** 15 tickets, 7 learning jobs ported from v1, 5 core services new
**Lead:** Learning (Learning subsystem engineer)
**Risk Level:** Medium (LLM-assisted extraction quality and contradiction handling are the tight points)
**CANON Verdict:** COMPLIANT WITH CONCERNS (all concerns resolved in decisions.md)

---

## What This Epic Delivers

Epic 7 builds the complete Learning subsystem: how Sylphie converts raw experience into durable knowledge in the World Knowledge Graph. Without this subsystem, Sylphie has experiences but never learns from them — the graph stays empty, Type 1 never develops, and the LLM remains the only competence.

**Five Core Components:**
1. Maintenance Cycle Orchestrator — Pressure-driven consolidation triggered by Cognitive Awareness drive
2. Event Consolidation — Salience-ranked processing of learnable events (max 5 per cycle)
3. Entity Extraction — LLM-assisted identification of entities with provenance discipline
4. Edge Refinement — LLM-assisted relationship identification between entities
5. Contradiction Detection — Flag conflicts as developmental catalysts (Piagetian disequilibrium)

**Seven Learning Jobs (ported from v1):**
1. Temporal Pattern Detection — RESPONSE_TO edges from phrase timing
2. Procedure Formation — Cluster patterns into ActionProcedures
3. Correction Processing — Handle guardian corrections with 3x weight
4. Sentence Splitting — Split multi-sentence phrases into atomic units
5. Sentence Structure — Build template slots and pattern edges
6. Symbolic Decomposition — Word-level meaning extraction
7. Pattern Generalization — Sibling phrase clustering into ConceptPrimitives

---

## Critical Constraints

### Max 5 Events Per Cycle (Catastrophic Interference Prevention)
**What:** Never process more than 5 learnable events in a single maintenance cycle.
**Why:** Processing too many events at once degrades existing knowledge. This is a cognitive constraint, not a performance optimization.

### Provenance Discipline (CANON Philosophy 7)
**What:** Every entity and edge carries provenance: SENSOR, GUARDIAN, LLM_GENERATED, or INFERENCE. Never erased.
**How:** LLM_GENERATED base confidence 0.35, GUARDIAN 0.60. Provenance chains track refinement lineage without erasing origin.

### Confidence Ceiling (Immutable Standard 3)
**What:** No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event.
**How:** Enforced at upsert time. LLM-generated knowledge must earn its way up through actual use.

### Guardian Asymmetry (Immutable Standard 5)
**What:** Guardian confirmations = 2x weight. Corrections = 3x weight. Guardian edges never overwritten by lower-provenance sources.

### Type 2 Cost (CANON Philosophy 2)
**What:** Every LLM call during consolidation carries explicit cost (tokens + latency).
**How:** Cost events emitted to TimescaleDB. Drive Engine reads them to apply Cognitive Effort pressure.

---

## Dependencies

| Depends On | What It Needs |
|-----------|--------------|
| E2 (Events) | IEventService: queryLearnableEvents(), markProcessed(), record() |
| E3 (Knowledge) | IWkgService: upsertNode(), findNode(), upsertEdge(), queryEdges(). IConfidenceService |
| E4 (Drive Engine) | IDriveStateReader: getCurrentState() for Cognitive Awareness trigger |
| E6 (Communication) | ILlmService: complete() for entity extraction and edge refinement |

---

## Key Design Decisions

7 decisions documented in `decisions.md`:
1. **Provenance chains** (not replacement) when edges are refined
2. **Contradiction resolution priority**: GUARDIAN > SENSOR > LLM_GENERATED > INFERENCE
3. **Maintenance timing**: Reactive (Cognitive Awareness > 0.6), 5min fallback, 30s rate limit
4. **All 7 jobs in scope** with defined execution order
5. **LLM cost tracking** on every extraction/refinement call
6. **Adaptive batch sizing**: Reduce from 5→3 events when contradictions ≥ 2
7. **Contradiction drive relief**: Information Integrity relief proportional to confidence gap

---

## Participating Agents

| Agent | Role | Model |
|-------|------|-------|
| Learning | Domain owner, implementation lead | sonnet |
| Piaget | Developmental psychology guidance (schema evolution, contradiction as catalyst) | opus |
| Skinner | Behavioral contingency analysis (drive relief for contradictions, measurement) | opus |
| Forge | NestJS architecture, DI wiring, async patterns | sonnet |
| Canon | CANON compliance verification | sonnet |

---

## Implementation Order

```
E7-T001 (Types) → E7-T002 (Module Skeleton)
    ├── E7-T003 (Maintenance Orchestrator)
    ├── E7-T004 (Event Consolidation) → E7-T008 (Temporal Patterns) → E7-T009 (Procedure Formation)
    │                                 → E7-T010 (Correction Processing)
    │                                 → E7-T011 (Sentence Processing) → E7-T012 (Generalization)
    ├── E7-T005 (Entity Extraction) → E7-T006 (Edge Refinement) → E7-T007 (Contradiction Detection)
    └── E7-T013 (Provenance Health)
E7-T014 (Job Registry) → E7-T015 (Integration Testing)
```

**Critical path:** T001 → T002 → T005 → T006 → T007 → T014 → T015
