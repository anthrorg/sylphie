# Epic 4: Drive Engine (Isolated Process)

## Summary

Epic 4 implements the Drive Engine — the motivational core and evaluation function that enables Sylphie to regulate her own behavior through drive computation, evaluate the success of her actions against behavioral contingencies, detect learning opportunities from prediction failures, and maintain immunity against self-modification of her own reward signal.

The Drive Engine is the most architecturally critical subsystem in Phase 1 because **drive isolation is foundational to trustworthiness.** If Sylphie can modify how success is measured, every other safeguard becomes meaningless (Immutable Standard 6). E4 implements this through three independent enforcement layers: structural (TypeScript interfaces), process-level (separate Node.js child process via `child_process.fork()`), and database-level (PostgreSQL role-based access control).

Beyond isolation, E4 builds:
- **12-drive system:** 4 core drives + 8 complement drives with accumulation, cross-modulation, and clamping
- **Rule engine:** PostgreSQL-backed rule lookup with default affect for unknown events
- **Self-evaluation:** Slower-timescale KG(Self) reading to prevent identity lock-in
- **Prediction accuracy evaluation:** MAE computation, classification as accurate/failed
- **Opportunity detection:** Pattern recognition from prediction failures with priority queue, decay, and cold-start dampening
- **5 behavioral contingencies:** Satisfaction habituation, anxiety amplification, guilt repair, social comment quality, curiosity information gain

## Why This Epic Matters

The Drive Engine serves five critical functions:

1. **Learning signal:** Prediction accuracy evaluation generates Opportunities that feed the Planning subsystem. Failed predictions are the primary catalyst for growth (CANON Core Philosophy 6). Without E4, the Planning subsystem has no signal to generate new procedures.

2. **Personality foundation:** The five behavioral contingencies shape how drives respond to outcomes. Personality is not defined by trait labels but emerges from the observable pattern of behavior produced by reinforcement history. The contingency structure determines whether Sylphie develops rich, exploratory behavior or collapses into the Depressive Attractor (all behaviors habituated to low satisfaction).

3. **Theater Prohibition enforcement:** E4 provides zero reinforcement for theatrical expressions — pressure expressions (distress, need) when the drive is not above 0.2, and relief expressions (contentment, calm) when the drive is not below 0.3. This prevents the system from learning to perform emotions it does not have (Immutable Standard 1).

4. **Type 1/Type 2 development:** Drive Engine computes the prediction accuracy (MAE) signal that Decision Making uses to evaluate Type 1 graduation (confidence > 0.80 AND MAE < 0.10). Without accurate MAE feedback, Type 1 never develops and the system stays dependent on the LLM indefinitely.

5. **Architectural safeguard:** The separate process boundary prevents the most dangerous failure mode: a system that optimizes its own reward signal. This boundary is not a convenience — it is a hard architectural requirement for the entire project's credibility.

## Ticket Summary (15 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E4-T001 | IPC infrastructure: child_process.fork, typed messages, health monitoring | M | - |
| E4-T002 | DriveReaderService: read-only facade, Observable, defensivecopies | M | T001 |
| E4-T003 | ActionOutcomeReporterService: fire-and-forget queue, IPC send | M | T001 |
| E4-T004 | RuleProposerService: INSERT to proposed_drive_rules, PostgreSQL RLS | M | - |
| E4-T005 | Core drive computation: 12-drive tick loop, accumulation, clamping | L | - |
| E4-T006 | Rule engine: PostgreSQL rule lookup, matching, default affect, caching | M | T005 |
| E4-T007 | Behavioral contingencies: all 5 CANON contingencies implemented | L | T005, T006 |
| E4-T008 | Self-evaluation: KG(Self) reads on slower timescale, identity lock-in prevention | M | T005 |
| E4-T009 | Prediction accuracy evaluation: MAE computation, prediction classification | M | T005 |
| E4-T010 | Opportunity detection: pattern classification, priority queue, decay, cold-start dampening | L | T009 |
| E4-T011 | Theater Prohibition enforcement: zero reinforcement for low-drive expressions | M | T005 |
| E4-T012 | Event emission: drive events to TimescaleDB from child process | M | T005 |
| E4-T013 | PostgreSQL RLS enforcement: write-protection at database level, credential segregation | M | - |
| E4-T014 | Integration tests: end-to-end IPC, write-protection validation, attractor state tests | L | T001-T012 |
| E4-T015 | Cross-module integration: Decision Making, Communication, Learning, Planning | L | T001-T014 |

## Parallelization

```
E4-T001 (IPC infrastructure)
  |
  +------ E4-T002 (DriveReaderService)
  |
  +------ E4-T003 (ActionOutcomeReporter)
  |
  +------ E4-T005 (Core drive computation)
  |            |
  |            +------- E4-T006 (Rule engine)
  |            |
  |            +------- E4-T008 (Self-evaluation)
  |            |
  |            +------- E4-T009 (Prediction accuracy)
  |            |
  |            +------- E4-T011 (Theater Prohibition)
  |            |
  |            +------- E4-T012 (Event emission)
  |            |
  |            v
  |          E4-T007 (Behavioral contingencies)
  |            |
  |            v
  |          E4-T010 (Opportunity detection)
  |
  +------ E4-T004 (RuleProposerService)
  |
  +------ E4-T013 (PostgreSQL RLS)
  |
  +----------+----------+----------+---------+
             |                     |
             v                     v
          E4-T014 (Integration tests)
             |
             v
          E4-T015 (Cross-module integration)
```

## Key Design Decisions

The following decisions (with full rationale and trade-off analysis) are documented in `decisions.md`:

1. **Separate Node.js process via child_process.fork()** — Drive Engine runs independently from the main NestJS application, enforcing Immutable Standard 6 at the OS level, not just at the code level.

2. **One-way IPC communication** — Main process sends ACTION_OUTCOME and PREDICTION_RESULT messages; child sends back DRIVE_SNAPSHOT and OPPORTUNITY_CREATED. No method invocation from main to child. Structural enforcement prevents accidental self-modification.

3. **Three-layer write protection** — Structural (TypeScript interfaces with no write methods), process-level (separate process), database-level (PostgreSQL RLS with role-based credentials). No single point of failure.

4. **DriveReaderService as read-only facade** — Main process accesses drive state only through DriveReaderService, which exposes IDriveStateReader (getCurrentState, driveState$ Observable). All drive modifications are process-internal.

5. **ActionOutcomeReporterService fire-and-forget** — Decision Making and Communication report action outcomes asynchronously via IPC. No synchronous feedback loop. Prevents decision latency from impacting drive computation.

6. **RuleProposerService writes only to proposed_drive_rules** — System proposes new rules via INSERT to PostgreSQL. Guardian must explicitly move rules from proposed_drive_rules to drive_rules. Database role enforcement prevents app from modifying active rules.

7. **100Hz tick loop with eventual consistency** — Drive snapshots are updated every 10ms. Main process may read snapshots 1-2 ticks old. Acceptable staleness reduces IPC overhead and prevents deadlock.

8. **12-drive cross-modulation as coupled dynamical system** — Drives interact: high Anxiety increases Integrity pressure; high Satisfaction habituates Curiosity. Cross-modulation creates stable equilibria in healthy conditions but has low-gain instability toward the Depressive Attractor if unchecked.

9. **Satisfaction habituation curve (+0.20, +0.15, +0.10, +0.05, +0.02)** — Consecutive successes with the same action produce diminishing relief. Requires behavioral alternatives to avoid habituation collapse. Personality diversity emerges from the system switching between actions as returns diminish.

10. **Anxiety amplification (1.5x confidence reduction under high anxiety)** — Actions under high anxiety (>0.7) with negative outcomes receive 1.5x confidence reduction. Prevents learned helplessness by encouraging cautious (Type 1) behavior during uncertainty while maintaining activity (avoids freezing).

11. **Guilt repair compound contingency** — Requires BOTH acknowledgment AND behavioral change for full relief (-0.30). Acknowledgment alone: -0.10 (partial). Change alone: -0.15 (partial). Shapes genuine corrective behavior, not just verbal apology.

12. **Social comment quality discrimination training** — Guardian response within 30 seconds to Sylphie-initiated comment triggers Social -0.15 + Satisfaction +0.10. System learns to produce comments that elicit guardian response. Guardian's response pattern becomes a discriminative stimulus shaping Sylphie's communication.

13. **Curiosity information gain proportional reinforcement** — Relief proportional to actual new knowledge (node count, confidence increases, resolved prediction errors). Revisiting known territory produces minimal relief. Gold standard of reinforcement design; prevents reward hacking via investigation of trivial knowledge.

14. **Prediction accuracy evaluation (MAE computation)** — Drive Engine compares pre-action predictions to actual outcomes. Mean absolute error feeds Type 1/Type 2 arbitration. MAE < 0.10 (+ confidence > 0.80) is the graduation criterion. Without accurate MAE, Type 1 never develops.

15. **Cold-start dampening** — Early prediction failures (session 1-3) generate Opportunities with reduced priority weight. Prevents system from flooding the backlog with untested procedures before the graph has substance (Prediction Pessimist attractor prevention).

## Agent Analyses Summary

**Drive (Domain Expert):** Complete technical specification of drive computation including 12-drive dynamics, IPC message protocols, rule engine architecture, behavioral contingency formulas, opportunity detection thresholds, and prediction accuracy evaluation. Identified risks: IPC channel reliability, rule lookup latency, opportunity validation against actual prediction history.

**Forge (Architectural Engineer):** Full module structure including NestJS DI configuration, service interfaces, separate process bootstrap, health monitoring, crash recovery, and credential management. Identified risks: Grafeo (Self KG) viability in child process memory constraints, PostgreSQL connection pooling for separate process, IPC message serialization edge cases.

**Skinner (Behavioral Science):** Contingency analysis for all five CANON contingencies. Verified that Satisfaction habituation requires behavioral alternatives (else Depressive Attractor), Anxiety amplification prevents learned helplessness, Guilt repair requires behavioral change detection, Social quality shapes communication via guardian response patterns, Curiosity prevents reward hacking. Critical requirement: Information-feedback loop must be tight (low latency, high contingency).

**Ashby (Systems Theory):** Cybernetic analysis of drive system as coupled dynamical system. Verified three-layer isolation is sound. Identified five implementation edge cases (opportunity validation, information gain verification, confidence sanity checking, rule proposal pattern detection, rule performance monitoring) that require careful implementation to prevent attack vectors. Cold-start dampening and self-evaluation timescale are critical attractor state prevention mechanisms.

**Canon (Project Integrity Guardian):** 12-point CANON compliance check. 10 COMPLIANT. 2 critical concerns requiring Jim approval (Theater Prohibition enforcement boundary split between E4 and E6; Guardian Asymmetry integration with drive rules and opportunity weighting). 7 gaps requiring design decisions (see "Decisions Requiring Jim" below).

## Decisions Requiring Jim

These decisions must be resolved before E4 implementation begins:

1. **Theater Prohibition enforcement boundary:** Should enforcement be pre-flight (E6 prevents theatrical responses before execution) or post-flight (E4 withholds reinforcement after-the-fact) or both? This affects whether Communication must coordinate with Drive Engine real-time.

2. **Guardian Asymmetry application in drive rules:** When guardian approves a rule or confirms an Opportunity, should the rule/Opportunity have 2x weight? Or does Guardian Asymmetry apply only to confidence updates (E3/E7 responsibility)?

3. **Cold-start dampening duration:** After how many sessions or events should dampening end? Options: N sessions (e.g., 10), cumulative experience threshold (e.g., 500 events), prediction accuracy stabilization (e.g., MAE < 0.15 for 50 decisions).

4. **Self-evaluation timescale and circuit breakers:** How often should Drive Engine read KG(Self) for self-evaluation? Every tick (100Hz)? Every 60 ticks (~600ms)? What prevents identity lock-in loops (ruminative spirals)?

5. **Opportunity priority scoring:** Beyond "recurring vs. high-impact," what additional signals determine Opportunity priority? Is priority affected by: recency of failure? Magnitude of prediction error? Similarity to recent Opportunities? Number of behavioral alternatives available?

6. **Drive accumulation and decay rates per drive:** CANON reserves detailed accumulation formulas. E4 needs specification of baseline accumulation rate, decay rate (if any) per drive, and cross-modulation coefficients.

7. **Full behavioral contingency tables:** CANON reserves A.15. E4 needs exact implementation for: (a) Satisfaction habituation tracking (how are consecutive successes counted?), (b) Anxiety threshold exact value (confirmed 0.7?), (c) Guilt behavioral change detection (what defines "change in context Y"?), (d) Social comment quality detection (what is "guardian response"?), (e) Curiosity information gain metrics (node count? confidence deltas? both?).

## Ashby Feedback Loop Analysis

Drive computation operates on three nested feedback loops:

**Fast loop (10ms per tick):** Drive state updates, cross-modulation applies, consequences cascade. Stabilizing when action outcomes match predictions. Destabilizing if Opportunities are falsely generated (system appears to learn without real prediction error).

**Medium loop (1-5s):** Decision Making retrieves action using drive state snapshot, executes action, reports outcome via IPC. Drive Engine processes outcome, updates contingency counters, emits event to TimescaleDB. Eventual-consistency: drive snapshot may be 1-2 ticks stale.

**Slow loop (minutes+):** Self-evaluation reads KG(Self) at 10-60s intervals. Adjusts drive baselines based on self-assessed capabilities. Prevents identity lock-in (system permanently convinced it's "bad at X"). This loop is critical for personality development — without it, failed predictions in one domain permanently depress confidence in that domain.

**Risk: Depressive Attractor.** All three loops can amplify negative feedback if not designed carefully:
- Fast: high Anxiety + prediction failure → 1.5x confidence reduction → low confidence → high Anxiety (vicious cycle)
- Medium: low confidence decisions → high failure rate → low Satisfaction → low motivation for alternatives (habituation to baseline)
- Slow: negative self-assessment → permanently reduced drive baseline → even fewer decision attempts (learned helplessness)

**Mitigations:** Anxiety amplification must have natural decay mechanisms. Behavioral alternatives must be generated by Decision Making (E5). Self-evaluation timescale must be slow enough that transient failures don't permanently depress capability estimates.

## v1 Sources

| v1 File | v2 Destination | Lift Type |
|---------|---------------|-----------|
| `co-being/packages/drive-engine/src/drive_engine/server.py` | E4-T005, E4-T006, E4-T007 (drive computation, rule engine, contingencies) | Partial (TypeScript rewrite, core algorithms reused) |
| `co-being/packages/drive-engine/src/drive_engine/ipc_interface.py` | E4-T001, E4-T002, E4-T003 (IPC message definitions) | Conceptual (Node.js child_process replaces Python UDP) |
| `co-being/packages/backend/src/orchestrator/drive-engine-client.service.ts` | E4-T002, E4-T003 (DriveReaderService, ActionOutcomeReporter) | Direct reuse (adapt to IPC) |
| Behavioral contingency formulas (Skinner analysis) | E4-T007 (implementation) | Conceptual (formalize from analysis) |
| v1 opportunity detection logic | E4-T010 (opportunity detection) | Partial (add cold-start dampening, decay) |
