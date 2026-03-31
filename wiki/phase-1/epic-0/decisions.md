# Epic 0 Decisions

## Decisions Made During Planning

### D1: ILlmService location
**Decision:** Move ILlmService interface to `src/shared/types/llm.interfaces.ts`
**Reason:** Planning and Learning both need LLM access. If the interface lives in Communication, they'd need cross-subsystem imports (CANON violation). Communication still provides the implementation.
**Source:** Canon agent analysis

### D2: ArbitrationResult as discriminated union
**Decision:** `ArbitrationResult = { type: 'TYPE_1' } | { type: 'TYPE_2' } | { type: 'SHRUG' }`
**Reason:** Returning `ActionCandidate | null` would let callers substitute fallback actions without compiler objection, violating the Shrug Imperative.
**Source:** Canon agent analysis (Standard 4)

### D3: DriveSnapshot enrichment
**Decision:** DriveSnapshot includes timestamp, tickNumber, driveDeltas, ruleMatchResult beyond raw PressureVector
**Reason:** Without derivative information, 4 of 6 known attractor states cannot be detected early. Position without velocity is insufficient for control theory.
**Source:** Ashby agent analysis (Sections 4.1, 3)

### D4: UpsertResult as discriminated union
**Decision:** `IWkgService.upsertNode()` returns `UpsertResult = { type: 'success' } | { type: 'contradiction' }`
**Reason:** Contradiction detection should return data, not throw. Contradictions are developmental catalysts (Piagetian disequilibrium), not errors.
**Source:** Atlas agent analysis (Risk 7)

### D5: Two PostgreSQL pools
**Decision:** Admin pool (`POSTGRES_ADMIN_POOL`) + runtime pool (`POSTGRES_RUNTIME_POOL`). Admin pool NOT exported from DatabaseModule.
**Reason:** Runtime pool enforces RLS (SELECT drive_rules, INSERT proposed_drive_rules only). Admin pool for guardian-approved operations only. Not exporting admin pool = NestJS DI error if any subsystem tries to inject it.
**Source:** Sentinel agent analysis

### D6: Grafeo stub only in E0
**Decision:** Define GrafeoInstance interface without installing `@grafeo-db/js`. Defer real integration to E1.
**Reason:** Package exists (v0.5.28, 2026-03-27) but is pre-1.0 with single maintainer and possible NAPI build issues on Windows. Interface-first design means E0 is not blocked.
**Source:** Sentinel agent analysis

### D7: Centralized EventType enum
**Decision:** All event type strings defined in a single `EventType` union in `event.types.ts`. No string literals elsewhere.
**Reason:** Without centralization, naming mismatches between writer and reader break the stigmergic channel silently. The system appears healthy while coordination fails.
**Source:** Ashby agent analysis (Section 7.1)

### D8: First-class health metric types
**Decision:** All 7 CANON health metrics get TypeScript types in `metrics.types.ts`.
**Reason:** 3 of 7 metrics had no interface representation. If not defined in E0, implementers skip them or compute them inconsistently.
**Source:** Ashby agent analysis (Section 5.3)

---

## Decisions Requiring Jim (Proposed CANON Updates)

### P1: CANON A.2 -- Episode Schema
**Proposed default:** Episodes in TimescaleDB: episodeId, timestamp, driveSnapshot, inputSummary, actionTaken, predictionIds, ageWeight. Consolidation by Learning when ageWeight < threshold.
**Status:** APPROVED (2026-03-28)

### P2: CANON A.3 -- Arbitration Threshold Formula
**Proposed default:** Dynamic threshold = base (0.50) modulated by drive state. Anxiety lowers (more Type 2 under stress), Curiosity raises (tolerate exploration), Boredom lowers (try something), CognitiveAwareness raises (prefer Type 1 under load). Clamped [0.30, 0.70].
**Status:** APPROVED (2026-03-28)

### P3: CANON A.6 -- LLM Context Assembly
**Proposed default:** Drive snapshot + recent episodes + WKG context subgraph + person model.
**Status:** APPROVED (2026-03-28)
