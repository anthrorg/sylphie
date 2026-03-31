# Epic 5: Decision Making (Core Cognitive Loop)

## Summary

Epic 5 implements the central cognitive loop — the moment-by-moment subsystem where sensory inputs, drive state, and world knowledge combine to produce goal-directed action. This is the computational center of gravity for the entire system. Every input Sylphie receives, every action she takes, every prediction she makes flows through this pipeline. It is the heaviest epic (~20% of total effort) and the richest source of v1 code reuse opportunity.

The architecture is built on dual-process cognition: Type 1 (fast, graph-based reflexes with high confidence) competing with Type 2 (slow, LLM-mediated deliberation). Everything starts as Type 2. Through successful repetition, behaviors graduate to Type 1 through the prediction-evaluation loop. The ratio of Type 1 to Type 2 decisions is the primary measure of Sylphie's development.

E5 builds: Executor Engine (8-state machine controlling the decision cycle), Episodic Memory (first-class temporal component with encoding gating and graceful degradation), Inner Monologue (multi-candidate prediction generation), Type 1/Type 2 Arbitration (dynamic threshold modulated by drives), Prediction Pipeline (generate before action, evaluate after outcome), Confidence Updater (ACT-R dynamics with MAE-based graduation), and Action Handler Registry (reflex execution infrastructure).

## Why This Epic Matters

1. **Central cognitive loop** — ALL inputs are processed here, ALL actions are selected here. If E5 breaks, nothing happens.

2. **Type 1 development** — E5 is where Type 1 behaviors graduate from successful Type 2 solutions. Without accurate prediction feedback and confidence tracking, Type 1 never develops and the system stays LLM-dependent indefinitely.

3. **Prediction-evaluation loop** — The primary learning mechanism. E5 generates predictions before action; Drive Engine evaluates predictions after. Failed predictions create Opportunities that feed Planning. This closed loop is how the system learns to anticipate rather than just react.

4. **Episodic memory** — First-class temporal experience that degrades gracefully. Recent episodes are detail-rich; older episodes contribute to semantic knowledge through consolidation. Enables the Learning subsystem (E7) to extract durable knowledge from raw experience.

5. **Autonomy measurement** — Type 1/Type 2 ratio is THE primary development metric. A mature Sylphie handles most situations through her own graph; the LLM is reserved for genuinely novel challenges.

## Ticket Summary (approximately 17 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E5-T001 | Executor Engine: 8-state machine (IDLE → CATEGORIZING → PREDICTING → ARBITRATING → RETRIEVING → EXECUTING → OBSERVING → LEARNING) | L | - |
| E5-T002 | Episodic Memory: in-memory ring buffer (50 episodes) with TimescaleDB backing, encoding gating via attention/arousal | L | - |
| E5-T003 | Episode Consolidation: 4-tier degradation (fresh <1h, recent 1-24h, consolidated >24h, archived >7d) | M | T002 |
| E5-T004 | Inner Monologue: multi-candidate prediction generation (max 5 candidates, Cowan's working memory limit) | M | T002, Knowledge, Communication |
| E5-T005 | Prediction Service: candidate selection via LLM, prediction recording to TimescaleDB with correlation IDs | M | T004, Events |
| E5-T006 | Type 1/Type 2 Arbitration: dynamic threshold (base 0.50, clamped [0.30, 0.70], modulated by 5 drives) | M | Drive Engine, T005 |
| E5-T007 | Dynamic Threshold Computation: drive modulation formula, confidence floor/ceiling enforcement | M | Drive Engine, T006 |
| E5-T008 | Action Retriever: WKG query by context fingerprint, O(1) lookup via hashing | M | Knowledge |
| E5-T009 | Confidence Updater: three-path outcome logic (reinforced/decayed/counter-indicated) with ACT-R dynamics | M | Knowledge |
| E5-T010 | Type 1 Graduation Tracker: state machine on action nodes, confidence > 0.80 AND MAE < 0.10 graduation | M | T009 |
| E5-T011 | Prediction Evaluator: MAE computation over last 10 uses, Type 1 demotion when MAE > 0.15 | M | T005, T010, Drive Engine |
| E5-T012 | Shrug Imperative: explicit action type for "signal incomprehension" when nothing above threshold | M | T006 |
| E5-T013 | Action Handler Registry: distributed handlers for action execution (move, say, attend, emit) | M | T001 |
| E5-T014 | Cold-start Detection: dampened expectations during first 3 sessions, prevent Prediction Pessimist | M | T011 |
| E5-T015 | Anxiety Amplification: 1.5x confidence reduction when anxiety > 0.7 and outcome negative | M | T009, Drive Engine |
| E5-T016 | Guardian Asymmetry Integration: 2x/3x weights propagated through confidence updates | M | T009, T010 |
| E5-T017 | Integration tests: end-to-end decision cycle, prediction-evaluation closure, attractor state tests | L | T001-T016 |

## Parallelization

```
E5-T002 (Episodic Memory)
  |
  +------ E5-T003 (Episode Consolidation)
  |
  +------ E5-T004 (Inner Monologue) ────┐
                                        |
  E5-T001 (Executor Engine)            |
  |                                     v
  +------ E5-T005 (Prediction Service)  |
  |            |                        |
  |            +---- E5-T011 (Pred. Evaluator)
  |            |
  |            v
  |       E5-T006 (Type 1/Type 2 Arbitration)
  |            |
  |            +---- E5-T007 (Dynamic Threshold)
  |            |
  |            +---- E5-T012 (Shrug Imperative)
  |            |
  |            v
  +------ E5-T008 (Action Retriever)
  |            |
  |            +---- E5-T009 (Confidence Updater)
  |            |
  |            +---- E5-T010 (Type 1 Graduation Tracker)
  |
  +------ E5-T013 (Action Handler Registry)
  |            |
  |            v
  |       E5-T015 (Anxiety Amplification)
  |       E5-T014 (Cold-start Detection)
  |       E5-T016 (Guardian Asymmetry)
  |            |
  |            v
  |       E5-T017 (Integration tests)
```

## Key Design Decisions

1. **Event-driven decision cycle with 5Hz idle tick fallback** — Decision loop triggers on input arrival or drive opportunity. If nothing arrives for 200ms, tick fires to keep the system from sleeping indefinitely.

2. **8-state executor engine** — IDLE → CATEGORIZING → PREDICTING → ARBITRATING → RETRIEVING → EXECUTING → OBSERVING → LEARNING. Clear state ownership prevents race conditions and makes the loop auditable.

3. **Episodic memory as in-memory ring buffer (50 episodes) with TimescaleDB backing** — Fast access to recent experience, TimescaleDB as authoritative log. Ring buffer prevents unbounded memory growth.

4. **Encoding gating via attention/arousal formula** — Not every tick is an episode. Encoding gate: `exogenous_salience + endogenous_goals + arousal > threshold`. Prevents catastrophic forgetting by not encoding trivial experiences.

5. **4-tier episode degradation** — Fresh (<1h): full detail. Recent (1-24h): queryable. Consolidated (>24h): semantic only. Archived (>7d): stub. Mirrors biological consolidation timescales.

6. **Max 5 Inner Monologue candidates** — Cowan's working memory limit. Prevents combinatorial explosion in arbitration while preserving genuine choice.

7. **Dynamic threshold base 0.50, clamped [0.30, 0.70], modulated by 5 drive dimensions** — High anxiety lowers threshold (act even with uncertainty). High cognitive awareness raises threshold (think before acting). Prevents threshold oscillation.

8. **Type 1 graduation state machine on action nodes** — UNCLASSIFIED → TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED → TYPE_1_DEMOTED. Clear progression prevents spurious state transitions.

9. **3-path confidence updater** — Reinforced path: increase on success. Decayed path: decay on disuse. Counter-indicated path: when action predicts X but Y happens, reduce confidence. Mirrors ACT-R without oversimplifying outcome structure.

10. **Prediction MAE computed over last 10 uses for graduation/demotion** — Rolling window prevents single failure from cascading. MAE < 0.10 for graduation, MAE > 0.15 for demotion. Clear hysteresis prevents jitter.

11. **Shrug as explicit action type with dedicated handler** — When nothing rises above threshold, the system does not select a random low-confidence action. It emits an explicit "I don't know" signal. Prevents superstitious learning.

12. **Anxiety amplification (1.5x confidence reduction when anxiety > 0.7)** — Coupled with outcome negativity. Forces cautious (Type 1) behavior under uncertainty while maintaining activity (prevents freezing). Prevents learned helplessness.

13. **Guardian Asymmetry integration (2x/3x weights propagated through confidence updates)** — When guardian confirms Type 1 candidate, confidence increases faster. When guardian corrects, confidence reduces sharper. The system learns that guardian feedback is ground truth for real-world relevance.

14. **Context fingerprint hashing for O(1) Type 1 lookup** — Current context hashed to fingerprint. Action retriever queries WKG by fingerprint. Enables fast reflex execution without query overhead.

15. **Cold-start detection with dampened expectations** — First 3 sessions: Opportunities generated from prediction failures carry reduced priority weight. Prevents Prediction Pessimist attractor where early failures flood system with low-quality procedures.

## Agent Analyses Summary

**Cortex (Decision Making Engineer):** Complete technical specification of executor engine state transitions, episodic memory lifecycle, inner monologue generation, prediction-outcome pairing, arbitration threshold dynamics, and action retrieval patterns. Identified risks: episodic memory consolidation interface complexity, dynamic threshold oscillation under rapid drive changes, confidence ceiling enforcement during cold start, shrug imperative requires explicit "no action" case.

**Forge (Architectural Engineer):** Full module structure (17 files across 8 subdirectories) with service dependency graph, DI tokens, async patterns, error handling, testing strategy. Identified risks: circular dependency between Decision Making and Communication (solved via lazy injection), drive state staleness from IPC delays (solved via event-driven tick), confidence calculation performance on large histories (solved via rolling window).

**Atlas (Knowledge Graph Architect):** Complete action node schema with Type 1/Type 2 metadata, context fingerprint properties, prediction-outcome linkage, confidence tracking, and provenance preservation. Action retrieval query patterns, Type 1 status state machine, and integration with Learning subsystem. Identified gaps: prediction correlation ID structure for drive engine closure, episodic memory anchoring to WKG nodes.

**Piaget (Developmental Science):** Type 1 graduation mapped to Vygotsky's Zone of Proximal Development and Fitts/Posner's procedural learning stages. Episodic memory encoding gating grounded in cognitive psychology (attention gates encoding). Demotion as Piagetian accommodation and conceptual development. Prediction error as primary learning driver mirrors constructivist learning theory. Cold-start considerations and attractor state prevention from developmental pathology literature.

**Luria (Neuropsychologist):** E5 mapped to Luria's Third Functional Unit (Programming, Regulation, Verification). Strong biological grounding for episodic memory consolidation (hippocampal-cortical systems consolidation theory). Executor engine as dorsolateral prefrontal cortex analog. Prediction-evaluation loop as verification component. Two critical clarifications: encoding gating threshold formula and inner monologue candidate limit rationale.

**Canon (Project Integrity Guardian):** 12-point CANON compliance check against Immutable Standards and Core Philosophies. 10 COMPLIANT. 2 critical concerns: Theater Prohibition enforcement boundary (E5 vs. E6 pre-flight validation), Guardian Asymmetry application in graduated actions. 5 critical gaps requiring Jim approval (see "Decisions Requiring Jim" below).

## Decisions Requiring Jim

These decisions must be resolved before E5 implementation begins:

1. **Encoding gating formula for episodic memory** — Exact formula for attention/arousal threshold. Current: `exogenous_salience + endogenous_goals + arousal > 0.5`. Confirm or refine this threshold. Does it vary by context (e.g., higher during sleep-prep, lower during active exploration)?

2. **Dynamic arbitration threshold modulation coefficients** — How much do the 5 drives modulate the base threshold (0.50)? Options: (a) linear blending (anxiety=-0.1 per 0.1 anxiety above 0.3), (b) sigmoid (smooth s-curve response), (c) table lookup. Which captures the intended behavior?

3. **Theater Prohibition enforcement boundary** — Should E5 participate in pre-flight validation (i.e., refuse to generate predictions for low-drive expressions)? Or is enforcement post-hoc via Drive Engine withholding reinforcement? Or both? This affects whether arbitration checks drive levels before selecting actions.

4. **Guardian Asymmetry in arbitration** — When guardian confirms a Type 2 action, should that action get a confidence boost during the next arbitration with similar context? Or does asymmetry apply only to confidence updates post-outcome? Currently ambiguous.

5. **Inner Monologue candidate limit** — Confirm that 5 is the right cap on candidates. Rationale: Cowan's working memory limit (~4 items), +1 for baseline/default action. Empirically adjustable during v1 validation testing?

6. **Cold-start dampening duration** — After how many sessions or events should dampening end? Options: (a) N sessions (e.g., 10), (b) cumulative experience threshold (e.g., 500 events), (c) prediction accuracy stabilization (e.g., MAE < 0.15 for 50 decisions in a row). Which is developmentally sound?

7. **Prediction correlation ID structure** — How does E5 tag predictions so that Drive Engine can match predictions to outcomes? UUID? Prediction hash? Correlation context (action_id + input_id + timestamp)? This affects closure of the prediction-evaluation loop.

8. **Type 1/Type 2 attractor monitoring** — The system can get stuck in Type 2 Addict (LLM always wins) or Prediction Pessimist (flood with low-quality procedures). Should E5 emit telemetry about Type 1/Type 2 ratio? What ratio triggers a warning? (e.g., <5% Type 1 decisions over last 100 decisions).

## Feedback Loop Analysis

Decision Making operates on three nested feedback loops:

**Fast loop (20-50ms per cycle):** Input arrives → categorization → inner monologue generates predictions → arbitration selects action → action executes → executor records outcome to episodic memory. This loop is tight and fast. Stabilizing when predictions match outcomes. Destabilizing if Inner Monologue generates irrelevant candidates (system appears to learn without real deliberation).

**Medium loop (1-5s):** Decision cycle completes → outcome reported to Drive Engine via IPC → Drive Engine evaluates prediction accuracy, applies behavioral contingencies → drive snapshot sent back to Decision Making. Eventual consistency: drive snapshot may be 1-2 ticks stale from IPC latency. Prevents decision latency from impacting drive computation.

**Slow loop (minutes to hours):** Episodic memory reaches consolidation threshold (>1h old) → Learning subsystem queries TimescaleDB for consolidatable events → entity extraction + edge refinement → WKG upsert. This loop transfers temporary experiences into durable knowledge. Critical for personality development—without it, learned behaviors would disappear after 7 days (archive threshold).

**Risk: Type 2 Addict.** All three loops can collapse toward LLM dependency if not designed carefully:
- Fast: Inner Monologue generates high-confidence predictions consistently → arbitration always favors Type 2 (LLM-based) → WKG retrieval for Type 1 is never attempted
- Medium: Type 2 cost not properly charged to Cognitive Effort drive → Type 2 has no penalty → no evolutionary pressure to develop Type 1
- Slow: Low Type 1 confidence → few successful Type 1 executions → slow WKG growth → few Type 1 candidates available next time (self-reinforcing decline)

**Mitigations:** Type 2 cost must be real and visible (latency reported, cognitive effort pressure applied). Type 1 retrieval must be attempted even at low confidence (with a minimum threshold floor). Behavioral alternatives must be generated at breadth to prevent Type 1 ossification.

**Risk: Prediction Pessimist.** Early failures can create false beliefs:
- Cold start: WKG is sparse → predictions are often wrong → MAE high → confidence low
- Feedback: low confidence → fewer Type 1 retrievals → more Type 2 → many Opportunities created from early prediction failures
- Overflow: opportunity backlog grows faster than Planning can process → system is perpetually in "learning recovery" mode with no time for exploration

**Mitigation:** Cold-start dampening reduces Opportunity priority weight during first 3 sessions. Allows early failures without catastrophic backlog growth.

## v1 Sources

| v1 File | v2 Destination | Lift Type |
|---------|---------------|-----------|
| `executor-engine.service.ts` | E5 executor engine (E5-T001) | Direct (add OBSERVING state, episodic gating) |
| `executor-loop.service.ts` | E5 decision cycle (E5-T001) | Direct (add event-driven tick, idle fallback) |
| `action-retriever.service.ts` | E5 action retriever (E5-T008) | Direct (add context fingerprint indexing) |
| `confidence-updater.service.ts` | E5 confidence updater (E5-T009) | Partial (add MAE, graduation state machine, guardian weights) |
| `prediction.service.ts` | E5 prediction service (E5-T005) | Partial (add multi-candidate generation, outcome pairing) |
| `episodic-memory.ts` (if exists) | E5 episodic memory (E5-T002, E5-T003) | Partial (TypeScript rewrite, add encoding gating + consolidation) |
| `action.types.ts` | E0 shared types | Already in E0 |

---

## Cross-Epic Dependencies

- **E4 (Drive Engine):** E5 reads drive state snapshot, reports action outcomes to E4 via IPC for contingency evaluation
- **E6 (Communication):** E5 receives categorized input from E6's input parser, sends action execution requests to E6 for TTS/chatbox output
- **E3 (Knowledge):** E5 queries WKG for action procedures, reads confidence values, receives from Learning (E7) when WKG is updated
- **E7 (Learning):** E5 writes episodic memory to TimescaleDB; Learning extracts durable knowledge from episodic events
- **E8 (Planning):** E5 receives Opportunities from E4; Planning creates new procedures that become WKG nodes queried by E5's action retriever
