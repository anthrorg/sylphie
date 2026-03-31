# Epic 8: Planning (Opportunity-to-Procedure Pipeline) — Implementation Plan

**Epic:** 8
**Phase:** 1
**Created:** 2026-03-29
**Status:** Planned
**Complexity:** L
**Dependencies:** E2 (Events), E3 (Knowledge), E4 (Drive Engine), E5 (Decision Making)

---

## Overview

Epic 8 implements Sylphie's Planning subsystem — the fifth and final cognitive subsystem. Planning turns detected Opportunities (from the Drive Engine) into new behavioral procedures stored in the WKG. This is the mechanism that gives Sylphie the ability to develop new responses to recurring problems, closing the loop between prediction failure and behavioral adaptation.

The subsystem is entirely new — no v1 equivalent exists. It operates as a 6-stage pipeline: INTAKE → RESEARCH → SIMULATE → PROPOSE → VALIDATE → CREATE. Each stage can succeed, fail, or be rate-limited. The pipeline is gated by rate limiting (preventing Planning Runaway), cold-start dampening (preventing Prediction Pessimist), and evidence sufficiency requirements.

**Core principle:** Plans are hypotheses, not solutions. They start at 0.35 confidence (LLM_GENERATED provenance), must be tested through execution, and follow the same ACT-R confidence dynamics as all other knowledge. Plans that work graduate to Type 1. Plans that don't work fade away.

---

## Architecture

### Module Placement

```
src/planning/
├── planning.module.ts
├── planning.service.ts              # Public facade (IPlanningService)
├── planning.tokens.ts               # All DI tokens
├── interfaces/
│   ├── planning.interfaces.ts       # All service interfaces
│   ├── planning.types.ts            # All planning types
│   └── index.ts
├── pipeline/
│   ├── planning-pipeline.service.ts # 6-stage pipeline orchestrator
│   └── index.ts
├── intake/
│   ├── opportunity-queue.service.ts # Priority queue with decay
│   ├── cold-start-dampening.ts      # Dampening function (pure)
│   └── index.ts
├── research/
│   ├── opportunity-research.service.ts  # TimescaleDB pattern queries
│   ├── event-pattern-analyzer.ts        # Pattern extraction helpers
│   └── index.ts
├── simulation/
│   ├── outcome-simulator.service.ts     # Historical pattern matching
│   ├── candidate-generator.ts           # Generate candidate actions
│   ├── drive-effect-predictor.ts        # Predict drive effects from WKG
│   └── index.ts
├── proposal/
│   ├── plan-proposal.service.ts         # Generate plan proposals
│   └── index.ts
├── validation/
│   ├── constraint-validation.service.ts # Orchestrate all checks
│   ├── checkers/
│   │   ├── safety-checker.ts
│   │   ├── feasibility-checker.ts
│   │   ├── coherence-checker.ts         # LLM-assisted
│   │   └── immutable-standards-checker.ts
│   └── index.ts
├── procedure-creation/
│   ├── procedure-creation.service.ts    # Write procedures to WKG
│   └── index.ts
├── evaluation/
│   ├── plan-evaluation.service.ts       # Post-execution evaluation
│   └── index.ts
├── rate-limiting/
│   ├── planning-rate-limiter.service.ts # Rate limits + active plan tracking
│   └── index.ts
├── exceptions/
│   ├── planning.exceptions.ts           # Exception hierarchy
│   └── index.ts
└── index.ts                             # Barrel export
```

### Cross-Module Dependencies

```
PlanningModule imports:
  - EventsModule (queryLearnableEvents, queryEventFrequency, record)
  - KnowledgeModule (upsertNode, findNode, upsertEdge, queryContext)
  - ConfigModule (rate limits, cold-start threshold, queue size)

PlanningModule injects (read-only):
  - DRIVE_STATE_READER from DriveEngineModule (current drive state for simulation)
  - LLM_SERVICE from CommunicationModule (constraint validation, coherence checking)

PlanningModule exports:
  - PLANNING_SERVICE (for Decision Making to query planning state)
```

### Event Communication

Planning emits the following events to TimescaleDB:

| Event Type | When | Purpose |
|------------|------|---------|
| OPPORTUNITY_RECEIVED | Intake | Opportunity enters the queue |
| OPPORTUNITY_DROPPED | Intake | Queue full, lowest priority evicted |
| PLANNING_RATE_LIMITED | Pipeline | Rate limit prevented processing |
| RESEARCH_COMPLETED | Research | Pattern analysis complete |
| RESEARCH_INSUFFICIENT | Research | Not enough evidence |
| SIMULATION_COMPLETED | Simulate | Outcomes simulated |
| SIMULATION_NO_VIABLE | Simulate | No viable outcome found |
| PROPOSAL_GENERATED | Propose | Plan proposals created |
| VALIDATION_PASSED | Validate | Proposal passed all constraints |
| VALIDATION_FAILED | Validate | Proposal failed constraints |
| PLAN_CREATED | Create | Procedure written to WKG |
| PLAN_EVALUATION | Evaluate | Post-execution outcome assessed |
| PLAN_FAILURE | Evaluate | Plan produced poor outcome (MAE > 0.15) |

---

## Pipeline Stages

### Stage 1: INTAKE
- Receive Opportunity from Drive Engine (via TimescaleDB event)
- Apply cold-start dampening to priority weight
- Enqueue with priority; evict lowest if queue full
- Gate: Rate limiter must allow processing

### Stage 2: RESEARCH
- Query TimescaleDB for event patterns around the Opportunity's context
- Identify specific prediction failures (MAE > 0.15)
- Query WKG for relevant knowledge about the context
- Check for prior plan attempts on same context
- Gate: Evidence sufficiency (2+ failures required)

### Stage 3: SIMULATE
- Generate 3-5 candidate actions from research results
- Predict drive effects from similar past actions in WKG
- Estimate success probability from event frequency
- Estimate information gain from WKG gaps
- Compute expected value for each candidate
- Gate: At least one candidate with expected value > 0.3

### Stage 4: PROPOSE
- Generate concrete plan proposals from best simulation candidates
- Each proposal specifies: trigger context, action sequence, expected outcome, abort conditions
- If validation fails, revise proposal (max 2 revisions)

### Stage 5: VALIDATE
- Check against all constraints:
  - Safety constraints (no harmful actions)
  - Feasibility constraints (action dependencies satisfiable)
  - Coherence constraints (LLM-assisted logical consistency check)
  - Immutable Standards (all 6 checked programmatically)
- Gate: All constraint checks must pass

### Stage 6: CREATE
- Write procedure node to WKG with:
  - provenance: LLM_GENERATED
  - confidence: 0.35
  - retrievalCount: 0
  - Full procedure properties (trigger, actions, expected outcome, abort conditions)
- Create TRIGGERED_BY and CAN_ACHIEVE edges
- Emit PLAN_CREATED event

### Post-Pipeline: EVALUATE
- Triggered when Decision Making reports procedure execution outcome
- Compare expected vs actual drive effects (MAE)
- Update procedure confidence via ACT-R formula
- Emit PLAN_EVALUATION event
- If MAE > 0.15: emit PLAN_FAILURE event (Drive Engine may create new Opportunity)

---

## Attractor State Prevention

### Planning Runaway (LOW-MEDIUM RISK)
**Mechanism:** Rate limiting (3 plans/hour, 10 active max), priority queue with decay (10%/hour), max queue size (50), evidence sufficiency gate.
**Monitor:** Queue depth, plans created per hour, active plan count.

### Prediction Pessimist (LOW-MEDIUM RISK)
**Mechanism:** Cold-start dampening (80% reduction at decision 0, linear decay to 0% at decision 100), evidence sufficiency gate (2+ failures required), constraint validation filtering.
**Monitor:** Procedure count vs decision count in early operation.

---

## Key Design Decisions

See `decisions.md` for full rationale. Summary:

1. **D1:** Sequential 6-stage pipeline with async queue
2. **D2:** Historical pattern matching for simulation (Phase 1)
3. **D3:** Linear cold-start dampening (0.8 → 0.0 over 100 decisions)
4. **D4:** Rate limits: 3/hr, 10 active, 50 queue, 10%/hr decay
5. **D5:** Standard ACT-R for procedures, no special treatment
6. **D6:** LLM validates (structured), does not decide
7. **D7:** Post-execution evaluation mandatory
8. **D8:** Configurable developmental readiness gates
9. **D9:** Communication via events and WKG only
10. **D10:** Exponential priority decay at 10%/hour

---

## Dependencies

| Dependency | Module | What Planning Needs |
|------------|--------|-------------------|
| E0 | Shared Types | All planning types defined in shared |
| E2 | EventsModule | record(), query(), queryEventFrequency() |
| E3 | KnowledgeModule | upsertNode(), findNode(), upsertEdge(), queryContext() |
| E4 | DriveEngineModule | IDriveStateReader (read-only), Opportunity events |
| E5 | DecisionMakingModule | Trial mechanism for new procedures (dependency ON E5) |
| E6 | CommunicationModule | ILlmService for constraint validation |

---

## Critical Dependency: E5 Trial Mechanism

New procedures are created at 0.35 confidence, below the 0.50 retrieval threshold. Without an explicit trial mechanism in Decision Making (E5), new procedures will never be selected, never executed, and never gain confidence. This is a coordination dependency — Planning creates procedures; Decision Making must trial them.

**Options for E5:**
- (A) "Try new procedure" reflex action (5% of decisions query 0.30-0.50 range)
- (B) Temporary confidence boost for untested procedures
- (C) Dedicated experimental selection alongside standard selection

This must be resolved before E8 integration testing.

---

## Verification

1. `npx tsc --noEmit` passes with zero errors
2. Unit tests for each service: queue, rate limiter, research, simulation, proposal, validation, creation, evaluation
3. Integration test: Opportunity → full pipeline → Procedure in WKG
4. Attractor state tests: Planning Runaway prevention (rate limits work), Prediction Pessimist prevention (cold-start works)
5. All planning events emitted to TimescaleDB
6. All procedures carry LLM_GENERATED provenance at 0.35 confidence
7. Post-execution evaluation updates confidence correctly via ACT-R
8. All 6 Immutable Standards enforced in constraint validation

---

## Agent Analyses

| Agent | Role | Key Contribution |
|-------|------|-----------------|
| Planner | Domain owner | Pipeline architecture, interface design, 20-ticket breakdown |
| Forge | NestJS architect | Module structure, DI wiring, error handling, config schema |
| Canon | CANON enforcement | Compliance review: COMPLIANT WITH CONCERNS (4 concerns) |
| Piaget | Developmental theory | Plans as schema construction, developmental readiness, confidence lifecycle |
| Ashby | Systems theory | Feedback loop mapping, attractor analysis, rate limiter sufficiency, queue stability |

### Key Consensus Points
1. Plans are hypotheses tested through execution, not permanent solutions
2. Rate limiting parameters are conservative and adequate for Phase 1
3. Cold-start dampening prevents premature procedure creation
4. LLM validates (structured), does not decide
5. Post-execution evaluation is mandatory, not optional
6. The 0.35 < 0.50 retrieval threshold tension is an E5 dependency

### Key Concerns from Canon Review
1. LLM constraint validation must be deterministic where possible (HIGH)
2. Contingency verification must be deep, not surface-level (HIGH)
3. New procedure retrieval threshold requires E5 coordination (MEDIUM)
4. Simulation methodology (A.5) is reserved — historical matching acceptable for Phase 1 (LOW)
