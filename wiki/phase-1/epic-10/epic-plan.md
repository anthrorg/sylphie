# Epic 10: Integration and End-to-End Verification — Implementation Plan

**Epic:** 10
**Phase:** 1
**Created:** 2026-03-29
**Status:** Planned
**Complexity:** L
**Dependencies:** E0 (Scaffold), E1 (DBs), E2 (Events), E3 (Knowledge), E4 (Drive Engine), E5 (Decision Making), E6 (Communication), E7 (Learning), E8 (Planning), E9 (Dashboard API)

---

## Overview

Epic 10 is the final verification epic for Phase 1. It does not add new features — it proves that the existing five subsystems, five databases, and behavioral architecture produce the emergent properties the CANON claims: genuine learning, Type 1 graduation, personality emergence from contingencies, and drive-mediated behavioral patterns.

The critical principle: **Epic 10 transforms Phase 1 from architectural theory to empirical proof.**

This epic creates two new NestJS modules (Testing, Metrics) that are infrastructure, not new subsystems. The five-subsystem architecture is preserved.

---

## Architecture

### New Module Placement

```
src/testing/
├── testing.module.ts                    # Conditional registration (dev/test only)
├── test-environment.service.ts          # Bootstrap/teardown orchestrator
├── database-fixtures.service.ts         # Snapshot/restore for all 5 databases
├── lesion-modes/
│   ├── lesion-mode.interface.ts         # Common lesion interface
│   ├── lesion-no-llm.service.ts         # LLM mock (errors immediately)
│   ├── lesion-no-wkg.service.ts         # WKG fallback (empty graph)
│   └── lesion-no-drives.service.ts      # Drive mock (flat state)
├── interfaces/
│   ├── testing.interfaces.ts            # Types and interfaces
│   └── testing.tokens.ts               # DI tokens
└── index.ts

src/metrics/
├── metrics.module.ts                    # Available in production
├── metrics-computation.service.ts       # 7 CANON health metrics
├── drift-detection.service.ts           # 5-metric drift protocol
├── attractor-detection.service.ts       # 6 attractor state monitors
├── interfaces/
│   ├── metrics.interfaces.ts            # Types and interfaces
│   └── metrics.tokens.ts               # DI tokens
└── index.ts
```

### Module Dependencies

```
TestingModule
  imports:
    - ConfigModule
    - EventsModule        (event injection, query)
    - KnowledgeModule     (WKG snapshot/restore)
    - DriveEngineModule   (drive state setup)
    - DecisionMakingModule (full-loop triggering)
    - CommunicationModule  (input injection)
    - LearningModule       (maintenance cycle verification)
    - PlanningModule       (opportunity/procedure verification)
  exports:
    - (none — TestingModule is test infrastructure)

MetricsModule
  imports:
    - ConfigModule
    - EventsModule        (TimescaleDB queries for metrics)
    - KnowledgeModule     (WKG queries for provenance, confidence)
    - DriveEngineModule   (drive state for interoceptive accuracy)
  exports:
    - METRICS_COMPUTATION
    - DRIFT_DETECTION
    - ATTRACTOR_DETECTION
```

### Data Flow

```
                    ┌──────────────┐
                    │  Dashboard   │
                    │  (E9 API)    │
                    └──────┬───────┘
                           │ reads metrics
                    ┌──────▼───────┐
                    │  Metrics     │  ◄── Read-only computation
                    │  Module      │
                    └──────┬───────┘
           ┌───────┬───────┼───────┬────────┐
           ▼       ▼       ▼       ▼        ▼
        Events  Knowledge  Drive   Comm   Planning
        Module  Module     Engine  Module  Module
           │       │       │       │        │
           ▼       ▼       ▼       ▼        ▼
        Timescale  Neo4j  IPC     Claude   WKG
        DB                Process  API
```

### CANON Compliance

**Philosophy alignment:**
- Epic 10 is verification, not feature addition — preserves five-subsystem architecture
- Testing and Metrics are infrastructure modules, not 6th/7th subsystems
- All verification reads from existing shared stores (TimescaleDB, WKG)
- No Phase 2 content (no hardware, sensors, motor control)

**Six Immutable Standards — all verified with explicit test cases:**
1. Theater Prohibition — drive-output correlation check
2. Contingency Requirement — reinforcement-to-action tracing
3. Confidence Ceiling — 0.60 cap enforcement
4. Shrug Imperative — incomprehension when nothing above threshold
5. Guardian Asymmetry — 2x/3x multiplier verification
6. No Self-Modification — RLS enforcement, process isolation

---

## Ticket Dependency Graph

```
E10-T001 (Types & Interfaces)
  ├── E10-T002 (Module Skeleton)
  │     ├── E10-T003 (TestEnvironment & Fixtures)
  │     │     ├── E10-T004 (Full-Loop Integration)
  │     │     │     ├── E10-T011 (Type 1 Graduation)
  │     │     │     ├── E10-T012 (Six Standards)
  │     │     │     ├── E10-T013 (Contingencies)
  │     │     │     ├── E10-T014 (Provenance Integrity)
  │     │     │     ├── E10-T015 (Behavioral Personality)
  │     │     │     └── E10-T017 (Planning Verification)
  │     │     ├── E10-T008 (LLM Lesion)
  │     │     ├── E10-T009 (WKG Lesion)
  │     │     └── E10-T010 (Drive Engine Lesion)
  │     ├── E10-T005 (Health Metrics)
  │     │     ├── E10-T006 (Drift Detection)
  │     │     │     └── E10-T016 (Drift Baseline)
  │     │     └── E10-T007 (Attractor Detection)
  │     └── (all above)
  │           └── E10-T018 (Final Report & Docs)
```

---

## Implementation Sequence

```
Phase 10a (Foundation):  T001, T002 (types, module skeleton)
Phase 10b (Infra):       T003 (test environment, fixtures)
Phase 10c (Core):        T004, T005 (full-loop test, health metrics) — parallel
Phase 10d (Detection):   T006, T007 (drift, attractor detection) — parallel
Phase 10e (Lesions):     T008, T009, T010 (3 lesion tests) — parallel
Phase 10f (Standards):   T011, T012, T013 (graduation, standards, contingencies) — parallel
Phase 10g (Validation):  T014, T015, T017 (provenance, personality, planning) — parallel
Phase 10h (Baseline):    T016 (drift baseline capture)
Phase 10i (Final):       T018 (integration report, session log)
```

---

## Risks

1. **"Genuine Learning" definition** — CANON does not specify acceptance criteria. Jim must define before implementation. BLOCKER.
2. **E0-E9 readiness** — Epic 10 depends on all previous epics being complete and functional. Any upstream bugs will surface here.
3. **Database state management** — Multiple lesion modes need isolated snapshots. Test isolation is critical.
4. **Drive Engine IPC** — Separate process complicates test setup. Mock must faithfully simulate one-way communication.
5. **LLM API cost** — Full-loop tests that invoke Claude API incur real cost. Budget for test runs.
6. **Timing sensitivity** — Social comment quality (30s window), drive tick cycles, and Learning cycle triggers are timing-dependent. Tests must handle timing correctly.
7. **False positives** — Attractor detection thresholds need calibration. Too sensitive = noise. Too insensitive = missed warnings.

---

## CANON Verification Summary

**Verdict: COMPLIANT WITH CONCERNS**

All tickets validated against:
- ✅ Philosophy: five-subsystem architecture preserved, verification-only modules
- ✅ Standard 1 (Theater): explicit test case
- ✅ Standard 2 (Contingency): reinforcement-to-action tracing
- ✅ Standard 3 (Confidence Ceiling): 0.60 cap verified
- ✅ Standard 4 (Shrug): incomprehension signal tested
- ✅ Standard 5 (Guardian Asymmetry): 2x/3x multipliers verified
- ✅ Standard 6 (No Self-Modification): RLS + process isolation tested
- ✅ Phase boundary: no Phase 2 content
- ✅ Drive isolation: read-only via IDriveStateReader (lesion test verifies)
- ✅ KG isolation: provenance audit confirms separation

**Concerns requiring Jim's attention:**
1. "Genuine learning" acceptance criteria need definition
2. LLM-disabled mode cost pressure semantics need confirmation
3. Behavioral personality validation scope needs confirmation
