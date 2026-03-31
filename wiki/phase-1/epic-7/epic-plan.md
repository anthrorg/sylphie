# Epic 7: Learning (Consolidation Pipeline) — Implementation Plan

**Epic:** 7
**Phase:** 1
**Created:** 2026-03-29
**Status:** Planned
**Complexity:** L
**Dependencies:** E2 (Events), E3 (Knowledge), E4 (Drive Engine), E6 (Communication)

---

## Overview

Epic 7 implements Sylphie's Learning subsystem — the consolidation pipeline that converts raw experience into durable knowledge in the World Knowledge Graph. This is the mechanism by which Sylphie transitions from LLM-dependent communication to graph-based understanding. Without Learning, the WKG stays empty, Type 1 never develops, and Sylphie remains a chatbot wrapper.

The subsystem follows a pressure-driven maintenance cycle model: when the Cognitive Awareness drive exceeds threshold (Sylphie "notices" she needs to process what she's learned), a consolidation cycle fires. Events from TimescaleDB are ranked by salience, entities and relationships are extracted with LLM assistance (carrying LLM_GENERATED provenance at 0.35 base confidence), contradictions are detected and flagged as developmental catalysts, and the WKG grows.

Seven learning jobs, ported from v1's maintenance-engine, run during maintenance cycles to detect temporal patterns, form procedures, generalize patterns, process corrections, and decompose linguistic structure.

---

## Architecture

### Module Placement

```
src/learning/
├── learning.module.ts
├── learning.service.ts (MaintenanceCycleService — main orchestrator)
├── learning.tokens.ts
├── interfaces/
│   ├── learning.interfaces.ts
│   ├── learning-job.interface.ts
│   └── index.ts
├── consolidation/
│   ├── consolidation.service.ts
│   ├── event-ranker.service.ts
│   ├── consolidation.types.ts
│   └── index.ts
├── extraction/
│   ├── entity-extraction.service.ts
│   ├── edge-refinement.service.ts
│   ├── extraction.types.ts
│   ├── llm-extraction-prompts.ts
│   └── index.ts
├── contradiction/
│   ├── contradiction-detector.service.ts
│   ├── contradiction.types.ts
│   └── index.ts
├── jobs/
│   ├── learning-job.registry.ts
│   ├── temporal-pattern.job.ts
│   ├── procedure-formation.job.ts
│   ├── pattern-generalization.job.ts
│   ├── correction-processing.job.ts
│   ├── sentence-splitting.job.ts
│   ├── sentence-structure.job.ts
│   ├── symbolic-decomposition.job.ts
│   └── index.ts
├── metrics/
│   ├── provenance-health.service.ts
│   ├── learning-metrics.types.ts
│   └── index.ts
└── index.ts
```

### Cross-Module Dependencies

```
LearningModule imports:
  - EventsModule (queryLearnableEvents, markProcessed, record)
  - KnowledgeModule (upsertNode, findNode, upsertEdge, queryEdges, confidence)
  - ConfigModule (cycle timing, thresholds)

LearningModule injects (read-only):
  - DRIVE_STATE_READER from DriveEngineModule (Cognitive Awareness value)
  - LLM_SERVICE from CommunicationModule (entity extraction, edge refinement)

LearningModule exports:
  - LEARNING_SERVICE (for Decision Making to trigger consolidation awareness)
```

### Data Flow

```
TimescaleDB (learnable events)
    → Event Consolidation (query + salience rank)
    → Entity Extraction (LLM-assisted)
    → Entity Resolution (match against WKG)
    → Edge Refinement (LLM-assisted)
    → Contradiction Detection
    → WKG Upsert (with provenance + confidence)
    → TimescaleDB (consolidation events, contradiction events, cost events)
```

---

## Implementation Phases

### Phase A: Foundation (T001, T002)
- Define all types and refine E0 interfaces
- Wire LearningModule with DI tokens and imports
- **Verification:** `npx tsc --noEmit` passes

### Phase B: Core Pipeline (T003, T004, T005, T006, T007)
- Maintenance cycle orchestrator with pressure-driven trigger
- Event consolidation with salience ranking
- Entity extraction and edge refinement with LLM
- Contradiction detection with provenance-aware resolution
- **Verification:** Single maintenance cycle processes a learnable event and upserts to WKG

### Phase C: Learning Jobs (T008, T009, T010, T011, T012)
- Port all 7 v1 maintenance jobs to v2 ILearningJob interface
- Execute in dependency order during maintenance cycles
- **Verification:** Each job runs its shouldRun()/run() cycle and produces measurable graph changes

### Phase D: Observability (T013, T014)
- Provenance health metrics and Lesion Test
- Job registry with priority-based orchestration
- **Verification:** Metrics endpoint returns provenance composition

### Phase E: Integration (T015)
- End-to-end: learnable event → consolidation → WKG growth → provenance tracking
- Verify all CANON constraints (max 5, provenance, confidence ceiling, guardian asymmetry)
- **Verification:** Full integration test suite passes

---

## v1 Code Lift Strategy

| v1 Component | v2 Target | Adaptation Required |
|-------------|----------|-------------------|
| MaintenancePressureLoopService | MaintenanceCycleService (T003) | Rewrite: IPC → DI injection of DriveStateReader |
| TemporalPatternJob | temporal-pattern.job.ts (T008) | Moderate: add provenance, ILearningJob interface |
| ProcedureFormationJob | procedure-formation.job.ts (T009) | Moderate: add provenance, LLM_GENERATED at 0.35 |
| PatternGeneralizationJob | pattern-generalization.job.ts (T012) | Moderate: add provenance validation |
| CorrectionProcessingJob | correction-processing.job.ts (T010) | Low: add guardian 3x weight, provenance |
| SentenceSplittingJob | sentence-splitting.job.ts (T011) | Low: adapt to v2 graph interface |
| SentenceStructureJob | sentence-structure.job.ts (T011) | Moderate: add template validation |
| SymbolicDecompositionJob | symbolic-decomposition.job.ts (T012) | Low: adapter pattern for v2 |

---

## Risk Register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| LLM extraction quality (hallucinated entities) | High | Provenance at 0.35, confidence ceiling, Lesion Test monitoring |
| Contradiction handling complexity | Medium | Start with simple provenance-priority resolution; complex cases flagged for guardian |
| Catastrophic interference from rapid cycles | Medium | Hard 5-event limit, adaptive batch sizing, 30s rate limit |
| v1 job port difficulty (API changes) | Low | ILearningJob interface adapter pattern; gradual port |
| LLM cost accumulation | Low | Cost tracking events, Drive Engine cognitive effort pressure |
| Stale events accumulating in TimescaleDB | Low | markProcessed() on every processed event; periodic cleanup |

---

## Success Criteria

1. Maintenance cycles fire when Cognitive Awareness > 0.6 threshold
2. Max 5 events processed per cycle (hard constraint, never violated)
3. All extracted entities carry correct provenance tags
4. Confidence ceiling enforced: no knowledge > 0.60 without retrieval-and-use
5. Contradictions detected and emitted as CONTRADICTION_DETECTED events
6. Guardian-sourced knowledge starts at 0.60, never overwritten by lower-provenance
7. LLM cost tracked and emitted per consolidation cycle
8. All 7 learning jobs execute in correct dependency order
9. Provenance health metrics show experiential ratio trending upward over time
10. Lesion Test produces meaningful result (experiential vs LLM knowledge count)
11. `npx tsc --noEmit` passes with zero errors
