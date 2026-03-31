# Epic 8 Analysis Summary: PIAGET Developmental Perspective

**Location:** `/wiki/phase-1/epic-8/agent-analyses/piaget-analysis.md` (861 lines)

**Analyst Role:** PIAGET (Cognitive Development Specialist) -- grounds Epic 8 in Piagetian schema theory, developmental readiness, and learning science.

---

## Key Findings

### 1. Planning as Accommodation (Schema Restructuring)
Planning IS NOT just code generation. It is the accommodation mechanism -- the architecture that allows Sylphie to create new behavioral schemas when existing knowledge repeatedly fails. This is Piagetian accommodation at the procedural level.

### 2. Three Developmental Risks Identified

| Risk | Prevention |
|------|-----------|
| **Prediction Pessimist** | Cold-start dampening (decisions 0-100) reduces Opportunity weight when graph is sparse |
| **Planning Runaway** | Rate limiting + priority queue with decay bounds resource consumption |
| **Premature Rote Learning** | Schema grounding validation: procedures depend on confident schemas, not speculation |

### 3. Critical Design Tension: The Confidence Ceiling Trap

**Problem:** Procedures created at 0.35 confidence (below retrieval threshold 0.50) will never be tried.

**Current Design Gap:** No mechanism for Decision Making to trial new procedures.

**Recommendation:** Implement "try new procedure" action -- occasional deliberate selection of new procedures for first trial. This is essential for any procedure to graduate from 0.35 to Type 1.

### 4. Developmental Readiness Gates (Pre-Activation)

Planning should only be fully activated when:
- WKG has >= 100 nodes with > 0.3 provenance ratio (not LLM-generated only)
- Type 1 predictions exist and outperform Type 2 (learning is working)
- Multiple Type 1 graduations achieved (system can graduate, not stuck at Type 2)
- Drive state is stable (informative signal)

**Metric:** Run health check before Planning initializes. Gate on all four conditions.

### 5. Procedure Confidence Lifecycle (0.35 → Graduation)

Procedures follow ACT-R confidence dynamics:
```
After 5 successes:   confidence = 0.54  (approaching retrieval threshold 0.50)
After 10 successes:  confidence = 0.63  (above threshold, now retrieved naturally)
After 50 successes:  confidence = 0.75
After 148 successes: confidence = 0.85  (approaching graduation at 0.80)

Graduation also requires: MAE < 0.10 over last 10 uses
Expected timeline: 100-300 decisions from creation to Type 1 graduation
```

### 6. Guardian Feedback Asymmetry in Planning

Guardian confirmation/correction on plan outcomes should be 2x/3x weighted. **Design gap:** How does guardian feedback actually modify procedures?

**Recommendation:** Implement annotation-based integration:
- Guardian feedback stored on PLAN_FAILURE events in TimescaleDB
- Next planning cycle for same context includes feedback annotations
- Proposal stage generates revised plans that address the feedback

### 7. Failed Plans as Developmental Catalysts

Failed plan execution is not failure. It is **disequilibrium** (Piaget's term). The feedback loop is:
```
Plan fails → confidence decreases → PLAN_FAILURE event → new Opportunity created
→ Planning cycles again with better understanding → adaptive improvement
```

This is healthy development IF the system does not get stuck in superstitious learning loops or hallucinate patterns. Cold-start dampening + rate limiting + evidence thresholds prevent these.

### 8. Schema Grounding Validation (New Constraint)

**Recommended constraint for validation engine:**
```
For each precondition in a proposed plan:
  Calculate: what % are already confident (> 0.60) in WKG?

If grounding < 50%:
  Reject or rate-limit the plan
  (Plan depends on unconfident foundations)
```

This prevents rote learning by ensuring procedures rest on solid schemas.

### 9. Per-Domain Cold-Start Dampening (Future Enhancement)

Current design: global dampening (decisions 0-100). Recommend making tunable per context:
- Frequent contexts (conversation): graduate from dampening faster (threshold = 50)
- Rare contexts (novel tasks): retain dampening longer (threshold = 200)

---

## Specific Recommendations for Implementation

### Immediate (Epic 8 Scope)

1. **Implement readiness gates** before Planning service initializes
2. **Implement "try new procedure" action** in Decision Making (solves confidence ceiling trap)
3. **Implement schema grounding validation** in constraint engine
4. **Implement annotation-based guardian feedback integration** (TimescaleDB event annotations)
5. **Monitor procedure-to-schema ratio** as health metric (rote learning early warning)

### Observable Metrics (Add to Telemetry)

```
procedure.confidence.timeline:
  - time_to_first_trial
  - time_to_graduation
  - graduation_success_rate (% that graduate vs. decay)
  - demotion_rate (% of Type 1 procedures demoted)
  - decay_rate (% that drop below threshold from disuse)

schema_grounding:
  - % of procedures with grounding >= 0.50
  - mean_grounding_score (should increase over time)

rote_learning_early_warning:
  - procedure_to_schema_ratio (should stay < 0.5 in healthy development)
  - mean_procedure_confidence (should increase over time, not stay flat at 0.35)

planning_health:
  - plans_created_per_hour (should stay within rate limits)
  - opportunity_queue_size (should decay and not accumulate)
  - cold_start_dampening_active (should transition from 1.0 to 0.0 by decision 100)
```

### Testing Strategy

1. **Unit test:** Confidence formula against known values
2. **Integration test:** Procedure creation → trial selection → evaluation → confidence update
3. **Scenario test:** Create a simple opportunity, run full pipeline, verify procedure graduates
4. **Stress test:** Flood system with opportunities, verify rate limiting and queue decay work
5. **Lesion test:** Run without Planning, then with Planning, verify behavioral difference

---

## Developmental Theory Grounding

This analysis is grounded in:

- **Piaget's schema theory:** Procedures are new schemas constructed through accommodation
- **Piaget's equilibration theory:** Failed plans create disequilibrium that drives adaptation
- **Vygotsky's ZPD:** Guardian feedback is the "more knowledgeable other" guiding development
- **ACT-R confidence dynamics:** Procedures follow documented learning curves (log-linear growth)
- **Rescorla-Wagner learning:** Prediction error is the learning signal (failed plans drive accommodation)

All recommendations trace back to established cognitive science principles, not speculation.

---

## Integration Points

- **Decision Making (Epic 5):** Must implement "try new procedure" action
- **Learning (Epic 7):** Schema grounding validation depends on schema confidence in WKG
- **Communication (Epic 6):** Guardian feedback on plans flows through Communication module
- **Drive Engine (Epic 4):** Opportunity detection triggers Planning; plan failures feed back as prediction errors
- **Knowledge (Epic 3):** Procedure nodes written to WKG through Knowledge module interfaces

---

## Next Steps

1. Review this analysis with Planner agent for implementation compatibility
2. Review readiness gates with Drive Engine and Decision Making
3. Implement confidence ceiling trial mechanism in Decision Making
4. Add schema grounding validation to constraint engine
5. Build telemetry dashboard showing procedure lifecycle metrics
6. Document the annotation-based guardian feedback integration
